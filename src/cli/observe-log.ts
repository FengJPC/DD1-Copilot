import { resolve } from "node:path";

import { parseBlindestLine } from "../blindest/parse-line.js";
import { tailLogLines } from "../blindest/tail-log.js";
import { initialGameState, reduceGameState } from "../state/game-state.js";

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: npm run observe:log -- <ddaccess-debug.log> [--from-start]");
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

let state = initialGameState();
for await (const line of tailLogLines(resolve(input), {
  fromStart: process.argv.includes("--from-start"),
  signal: controller.signal,
})) {
  const event = parseBlindestLine(line);
  if (!event) continue;
  state = reduceGameState(state, event);
  console.log(JSON.stringify({ event, state }));
}
