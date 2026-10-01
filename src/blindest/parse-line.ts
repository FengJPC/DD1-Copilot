import type { BlindestEvent, ParsedLogLine } from './events.js';
import { parseCamp } from './parsers/camp.js';
import { parseCircus } from './parsers/circus.js';
import { parseCombat } from './parsers/combat.js';
import { parseExploration } from './parsers/exploration.js';
import { parseInventory } from './parsers/inventory.js';
import { parsePreparation } from './parsers/preparation.js';
import { parseResults } from './parsers/results.js';
import { parseSession } from './parsers/session.js';
import { parseTown } from './parsers/town.js';

const envelopePattern = /^\[\s*(\d+)\]\s+(.*)$/u;

export function parseLogEnvelope(raw: string): ParsedLogLine | undefined {
  const match = envelopePattern.exec(raw.trimEnd());
  if (!match) return undefined;
  return { tick: Number(match[1]), message: match[2] ?? "", raw };
}

const parsers = [parseSession, parseTown, parseCircus, parseCombat, parsePreparation, parseExploration, parseInventory, parseCamp, parseResults];

/** One envelope parser and a fixed set of scene-specific event parsers. */
export function parseBlindestLine(raw: string): BlindestEvent | undefined {
  const line = parseLogEnvelope(raw);
  if (!line) return undefined;
  for (const parser of parsers) {
    const event = parser(line);
    if (event) return event;
  }
  return undefined;
}
