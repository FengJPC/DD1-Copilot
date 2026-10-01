import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseResults(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^agent-state: quest rows=(\d+) goals=(\d+) button=(none|flee|abandon|regroup|finish) complete=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "quest_observed",
      rowCount: Number(match[1]),
      goalCount: Number(match[2]),
      button: match[3] as "none" | "flee" | "abandon" | "regroup" | "finish",
      complete: match[4] === "1",
    };
  }

  match = /^agent-state: quest_row row=(\d+) kind=(goal|button|wave) text="([^"]*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "quest_row_observed",
      row: Number(match[1]),
      rowKind: match[2] as "goal" | "button" | "wave",
      text: match[3] ?? "",
    };
  }

  match = /^agent-state: results state=(-?\d+) rows=(\d+) heroes=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "results_observed",
      state: Number(match[1]),
      rowCount: Number(match[2]),
      heroCount: Number(match[3]),
    };
  }

  match = /^agent-state: results_row row=(\d+) text="(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "results_row_observed",
      row: Number(match[1]),
      text: match[2] ?? "",
    };
  }

  match = /^agent-state: results_hero hero=(\d+) rows=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "results_hero_observed",
      heroIndex: Number(match[1]),
      rowCount: Number(match[2]),
    };
  }

  match = /^agent-state: results_hero_row hero=(\d+) row=(\d+) text="(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "results_hero_row_observed",
      heroIndex: Number(match[1]),
      row: Number(match[2]),
      text: match[3] ?? "",
    };
  }
  return undefined;
}
