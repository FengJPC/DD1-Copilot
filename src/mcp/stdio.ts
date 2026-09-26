#!/usr/bin/env node

import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { CombatLogSource } from "../live/combat-log-source.js";
import {
  NamedPipeCommandTransport,
  UnavailableCommandTransport,
} from "../command/transport.js";
import { LiveSaveSource } from "../save/live-save-source.js";
import { createDd1GameServer } from "./create-server.js";

const configuredPath = process.env.DD1_BLINDEST_LOG?.trim();
if (!configuredPath) {
  throw new Error(
    "DD1_BLINDEST_LOG must point to the active ddaccess-debug.log file.",
  );
}

const saveDirectory = process.env.DD1_SAVE_DIR?.trim();
const decoderJar = process.env.DD1_SAVE_EDITOR_JAR?.trim();
const commandPipe = process.env.DD1_COMMAND_PIPE?.trim();

const sources = {
  log: new CombatLogSource(resolve(configuredPath)),
  ...(saveDirectory && decoderJar
    ? {
        save: new LiveSaveSource({
          saveDirectory: resolve(saveDirectory),
          decoderJar: resolve(decoderJar),
          ...(process.env.DD1_JAVA_EXECUTABLE?.trim()
            ? { javaExecutable: process.env.DD1_JAVA_EXECUTABLE.trim() }
            : {}),
        }),
      }
    : {}),
  command: commandPipe
    ? new NamedPipeCommandTransport(commandPipe)
    : new UnavailableCommandTransport(),
};

serveStdio(() => createDd1GameServer(sources), {
  onerror(error) {
    console.error(error);
  },
});
