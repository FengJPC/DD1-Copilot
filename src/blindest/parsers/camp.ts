import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseCamp(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^agent-state: camp phase=(\d+) points=(-?\d+) meal_options=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "camp_observed",
      phase: Number(match[1]),
      points: Number(match[2]),
      mealOptionCount: Number(match[3]),
    };
  }

  match = /^agent-state: camp_meal option=(\d+) food=(-?\d+) available=(-?\d+) text="([^"]*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "camp_meal_observed",
      optionIndex: Number(match[1]),
      foodRequired: Number(match[2]),
      foodAvailable: Number(match[3]),
      text: match[4] ?? "",
    };
  }
  return undefined;
}
