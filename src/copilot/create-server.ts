import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { copilotActionSchema } from "./action-schema.js";
import { summarizeActionRecord, summarizeCombatTransition } from "./presentation.js";

import { CampaignMemoryStore } from "./campaign-memory.js";
import {
  CopilotEngine,
} from "./engine.js";
import { CopilotSession, DEFAULT_DECISION_TIMEOUT_MS } from "./session.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const actionAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}




export function createDd1CopilotServer(
  engine: CopilotEngine,
  memory: CampaignMemoryStore,
  session = new CopilotSession(engine, memory),
): McpServer {
  const server = new McpServer(
    { name: "dd1-copilot", version: "0.2.1" },
    {
      capabilities: { tools: {} },
      instructions: [
        "This server is the model-facing Darkest Dungeon 1 copilot layer.",
        "The model makes every strategic choice; this server only compacts observations and completes mechanical input workflows.",
        "Start with one compact state, then use delta with the last seen revision during normal play; request full only for parser diagnostics or reconciliation.",
        "Read the latest state before every action and pass its exact revision to act.",
        "Use a unique requestId for each intended action and reuse it only when recovering the same uncertain tool call.",
        "A queued transport acknowledgement is not success; act waits for semantic evidence and can return uncertain.",
        "Never blindly resend an uncertain action. Refresh state and reconcile first.",
      ].join(" "),
    },
  );

  server.registerTool(
    "get_state",
    {
      title: "Get reconciled DD1 Copilot state",
      description:
        "Return a contextual compact snapshot, a token-light delta after a revision cursor, or an explicit diagnostics-only full state.",
      inputSchema: z.object({
        mode: z.enum(["compact", "delta", "full"]).default("compact"),
        afterRevision: z.number().int().nonnegative().default(0),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ mode, afterRevision }) => {
      const state = await session.getState(mode, afterRevision);
      return toolResult(state);
    },
  );

  server.registerTool(
    "get_tactical_state",
    {
      title: "Get token-efficient DD1 combat state",
      description:
        "Return a self-contained combat decision frame with complete active skills and dynamic units, while emitting larger profiles and combat history only when new or changed.",
      inputSchema: z.object({
        resetBaseline: z.boolean().default(false),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ resetBaseline }) => {
      if (resetBaseline) session.tactical.reset();
      const state = await session.getState("compact", 0);
      const packet = session.projectCombat(state);
      return toolResult(packet);
    },
  );

  server.registerTool(
    "refresh_state",
    {
      title: "Force a fresh DD1 observation",
      description:
        "Ask the in-game bridge for a new state snapshot, optionally refresh the map, and return the reconciled result. Use after an uncertain or externally performed action.",
      inputSchema: z.object({
        mode: z.enum(["compact", "delta", "full"]).default("compact"),
        afterRevision: z.number().int().nonnegative().default(0),
        includeMap: z.boolean().default(false),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ mode, afterRevision, includeMap }) => {
      const state = await session.refresh(mode, afterRevision, includeMap);
      return toolResult(state);
    },
  );

  server.registerTool(
    "act",
    {
      title: "Execute and verify a semantic DD1 action",
      description:
        "Validate one semantic action, verify its result, then by default wait through animations and enemy turns until the next controllable hero or combat end.",
      inputSchema: z.object({
        requestId: z.string().min(1).max(128),
        expectedRevision: z.number().int().nonnegative(),
        rationale: z.string().min(1).max(500).optional(),
        waitForNextDecision: z.boolean().default(true),
        includeEvidence: z.boolean().default(false),
        waitTimeoutMilliseconds: z.number().int().min(1_000).max(60_000).default(DEFAULT_DECISION_TIMEOUT_MS),
        action: copilotActionSchema,
      }),
      annotations: actionAnnotations,
    },
    async ({
      requestId,
      expectedRevision,
      action,
      rationale,
      waitForNextDecision,
      includeEvidence,
      waitTimeoutMilliseconds,
    }) => {
      const result = await session.execute({ requestId, expectedRevision, action, rationale },
        { waitForNextDecision, waitTimeoutMilliseconds });
      return toolResult({
        ...result,
        action: includeEvidence ? result.action : summarizeActionRecord(result.action),
        transition: result.transition ? summarizeCombatTransition(result.transition) : undefined,
      });
    },
  );

  server.registerTool(
    "get_campaign_resume",
    {
      title: "Get durable DD1 campaign memory",
      description:
        "Return a token-light cross-session overview: roster index, urgent disease names, recent verified decisions, expedition summaries, and current plans.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => toolResult(memory.getCampaignOverview()),
  );

  server.registerTool(
    "get_hero_memory",
    {
      title: "Get one DD1 hero's durable memory",
      description:
        "Expand one hero's full current profile, profile-change history, and linked reflections only when a town or roster decision needs it.",
      inputSchema: z.object({
        heroGuid: z.number().int().positive(),
        observationLimit: z.number().int().min(1).max(32).default(8),
        reflectionLimit: z.number().int().min(1).max(32).default(8),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ heroGuid, observationLimit, reflectionLimit }) =>
      toolResult(
        memory.getHeroMemory(heroGuid, {
          observations: observationLimit,
          reflections: reflectionLimit,
        }),
      ),
  );

  server.registerTool(
    "record_reflection",
    {
      title: "Record a DD1 strategic reflection",
      description:
        "Persist a model-authored review, lesson, hero plan, or campaign plan with optional evidence revisions.",
      inputSchema: z.object({
        kind: z.enum([
          "expedition_review",
          "hero_plan",
          "lesson",
          "campaign_plan",
        ]),
        title: z.string().min(1).max(160),
        body: z.string().min(1).max(8_000),
        heroGuid: z.number().int().positive().optional(),
        evidenceRevisions: z.array(z.number().int().nonnegative()).max(100).optional(),
        tags: z.array(z.string().min(1).max(80)).max(32).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (reflection) =>
      toolResult({ reflection: memory.addReflection(reflection) }),
  );

  server.registerTool(
    "export_campaign_journal",
    {
      title: "Export DD1 campaign memory as Markdown",
      description:
        "Write human-readable campaign, hero, expedition, decision, and reflection notes from the durable SQLite store.",
      inputSchema: z.object({
        outputDirectory: z.string().min(1).max(1_024),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ outputDirectory }) =>
      toolResult(memory.exportMarkdown(outputDirectory)),
  );

  server.registerTool(
    "get_briefing",
    {
      title: "Get DD1 Copilot action briefing",
      description:
        "Summarize recent or session action outcomes and current state without decoding saves.",
      inputSchema: z.object({
        scope: z.enum(["recent", "session"]).default("recent"),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ scope }) => toolResult(await engine.getBriefing(scope)),
  );

  return server;
}
