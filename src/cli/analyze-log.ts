import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseBlindestLine } from "../blindest/parse-line.js";
import { initialGameState, reduceGameState } from "../state/game-state.js";

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: npm run analyze:log -- <ddaccess-debug.log>");
}

const path = resolve(input);
const text = await readFile(path, "utf8");
const events = text.split(/\r?\n/u).flatMap((line) => {
  const event = parseBlindestLine(line);
  return event ? [event] : [];
});
const state = events.reduce(reduceGameState, initialGameState());
const counts = Object.fromEntries(
  [...new Set(events.map((event) => event.kind))]
    .sort()
    .map((kind) => [kind, events.filter((event) => event.kind === kind).length]),
);

console.log(JSON.stringify({ path, counts, state }, null, 2));
