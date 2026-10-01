#!/usr/bin/env node

import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  NamedPipeCommandTransport,
  UnavailableCommandTransport,
} from "../command/transport.js";
import { CombatLogSource } from "../live/combat-log-source.js";
import { CampaignMemoryStore } from "./campaign-memory.js";
import { createDd1CopilotServer } from "./create-server.js";
import { CopilotEngine } from "./engine.js";
import { LocalGameGateway } from "./local-game-gateway.js";
import { registerProcessShutdown } from './process-lifecycle.js';
import { acquireRuntimeLease } from './runtime-lease.js';
import { CopilotSession } from './session.js';

const configuredPath = process.env.DD1_BLINDEST_LOG?.trim();
if (!configuredPath) {
  throw new Error(
    "DD1_BLINDEST_LOG must point to the active ddaccess-debug.log file.",
  );
}

const commandPipe = process.env.DD1_COMMAND_PIPE?.trim();
const log = new CombatLogSource(resolve(configuredPath));
const command = commandPipe
  ? new NamedPipeCommandTransport(commandPipe)
  : new UnavailableCommandTransport();
const release = commandPipe ? await acquireRuntimeLease(commandPipe) : async () => { };
try {
  const engine = new CopilotEngine(new LocalGameGateway(log, command));
  const memory = CampaignMemoryStore.fromEnvironment();
  const session = new CopilotSession(engine, memory);
  const handle = serveStdio(() => createDd1CopilotServer(engine, memory, session), {
    onerror(error) { console.error(error); },
  });
  let stopTask: Promise<void> | undefined;
  const shutdown = () => {
    if (stopTask) return;
    session.close();
    stopTask = (async () => {
      try { await handle.close(); } finally {
        await release();
        process.stdin.pause();
        removeListeners();
      }
    })();
    void stopTask.catch((error) => { console.error(error); process.exitCode = 1; });
  };
  const removeListeners = registerProcessShutdown(shutdown);
} catch (error) {
  await release();
  throw error;
}
