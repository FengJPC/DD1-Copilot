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
const engine = new CopilotEngine(new LocalGameGateway(log, command));
const memory = CampaignMemoryStore.fromEnvironment();

serveStdio(() => createDd1CopilotServer(engine, memory), {
  onerror(error) {
    console.error(error);
  },
});
