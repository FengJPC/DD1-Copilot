import type { BlindestLogRecord } from '../live/combat-log-source.js';

// Keep the raw log cursor monotonic. Only these observed, unparsed diagnostics
// are safe to cross without asking the model to repeat its decision.
export function passiveRevisionAdvance(expected: number, current: number,
  recordsAfter: (revision: number, limit: number) => BlindestLogRecord[]): boolean {
  if (expected >= current || current - expected > 2_000) return false;
  const records = recordsAfter(expected, 2_000);
  return records.length === current - expected && records.every((record, index) =>
    record.revision === expected + index + 1 && record.event === undefined &&
    /^(?:townbark:|ctrlprobe: cursor fight\b|speech->prism\b)/u.test(record.message ?? ''));
}
