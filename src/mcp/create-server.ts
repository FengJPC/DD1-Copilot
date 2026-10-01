import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BlindestEvent } from "../blindest/events.js";
import type { CommandTransport } from "../command/transport.js";
import type {
  BlindestLogRecord,
  CombatLogSnapshot,
  CombatLogSource,
} from "../live/combat-log-source.js";
import type { LiveSaveSource } from "../save/live-save-source.js";
import type { GameState } from "../state/game-state.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const commandAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

export interface Dd1GameServerSources {
  log: CombatLogSource;
  save?: LiveSaveSource;
  command: CommandTransport;
}

function withoutRaw<T extends BlindestEvent>(event: T): Omit<T, "raw"> {
  const { raw: _raw, ...rest } = event;
  return rest;
}

function structuredState(state: GameState) {
  return {
    ...state,
    targets: state.targets.map(withoutRaw),
    recentResults: state.recentResults.map(withoutRaw),
  };
}

function structuredLogSnapshot(snapshot: CombatLogSnapshot) {
  return { ...snapshot, state: structuredState(snapshot.state) };
}

function structuredRecord(record: BlindestLogRecord) {
  const { raw: _raw, event, ...rest } = record;
  return {
    ...rest,
    ...(event === undefined ? {} : { event: withoutRaw(event) }),
  };
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function createDd1GameServer(sources: Dd1GameServerSources): McpServer {
  const server = new McpServer(
    { name: "dd1-game-mcp", version: "0.2.1" },
    {
      capabilities: { tools: {} },
      instructions: [
        "This server exposes factual Darkest Dungeon 1 source data and a primitive command transport.",
        "Use the Blindest log as the normal live source. Decode saves only through get_save_snapshot at low-frequency checkpoints or when explicitly verifying state.",
        "Treat each source revision as an event cursor; state fusion, legal-action inference, decision freshness, and action settlement belong to the copilot layer.",
        "send_command reports only transport acknowledgement and never claims that the requested game action completed.",
      ].join(" "),
    },
  );

  server.registerTool(
    "get_state",
    {
      title: "Get live DD1 log state",
      description:
        "Refresh the primary Blindest log source and return its current structured state. This tool never triggers save decoding. Full mode retains raw Blindest text inside parsed state records.",
      inputSchema: z.object({
        mode: z.enum(["structured", "full"]).default("structured"),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ mode }) => {
      const log = await sources.log.refresh();
      return toolResult({
        observedAt: new Date().toISOString(),
        revision: log.revision,
        source: mode === "full" ? log : structuredLogSnapshot(log),
      });
    },
  );

  server.registerTool(
    "get_save_snapshot",
    {
      title: "Decode a DD1 save checkpoint",
      description:
        "Explicitly snapshot and decode the save directory. Use only at low-frequency checkpoints, for reconciliation, or when the live log is insufficient. This can start DDSaveEditor processes.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      if (sources.save === undefined) {
        return toolResult({
          available: false,
          error:
            "DD1_SAVE_DIR and DD1_SAVE_EDITOR_JAR are required to decode saves.",
        });
      }
      return toolResult({ snapshot: await sources.save.refresh() });
    },
  );

  server.registerTool(
    "get_events",
    {
      title: "Get lossless DD1 log records",
      description:
        "Return every buffered Blindest log record newer than a revision. Recognized records include a parsed event; unrecognized records are retained instead of being discarded.",
      inputSchema: z.object({
        afterRevision: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(2_000).default(200),
        includeRaw: z.boolean().default(true),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ afterRevision, limit, includeRaw }) => {
      const snapshot = await sources.log.refresh();
      const records = sources.log.recordsAfter(afterRevision, limit);
      const earliestBufferedRevision =
        snapshot.source.earliestBufferedRevision ?? snapshot.revision;
      return toolResult({
        source: "blindest_log",
        revision: snapshot.revision,
        earliestBufferedRevision,
        truncated: afterRevision + 1 < earliestBufferedRevision,
        records: includeRaw ? records : records.map(structuredRecord),
      });
    },
  );

  server.registerTool(
    "send_command",
    {
      title: "Send a primitive DD1 command",
      description:
        "Send one primitive command to the configured game-side transport. The result is only a transport acknowledgement; observe subsequent state to determine game effects.",
      inputSchema: z.object({
        kind: z.string().min(1).max(80),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
      annotations: commandAnnotations,
    },
    async ({ kind, args }) =>
      toolResult({ acknowledgement: await sources.command.send({ kind, args }) }),
  );

  server.registerTool(
    "health",
    {
      title: "Check DD1 source and command health",
      description:
        "Report availability for the Blindest log, save directory, and primitive command transport. This tool checks save metadata only and never starts the decoder.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      const [log, save, command] = await Promise.all([
        sources.log.refresh(),
        sources.save?.health(),
        sources.command.health(),
      ]);
      const saveHealth =
        save ?? {
          kind: "save_directory",
          available: false,
          configured: false,
          error:
            "DD1_SAVE_DIR and DD1_SAVE_EDITOR_JAR are not both configured.",
        };
      return toolResult({
        ok: log.source.available,
        observedAt: new Date().toISOString(),
        sources: {
          blindestLog: log.source,
          save: saveHealth,
          command,
        },
      });
    },
  );

  return server;
}
