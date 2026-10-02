import type { BlindestLogRecord } from '../../live/combat-log-source.js';
import type { ActionRecord } from '../types.js';
import { filterCopilotRecords } from '../filter.js';

function selectEvidence(records: BlindestLogRecord[]) {
  const filtered = filterCopilotRecords(records, { unclassifiedSampleLimit: 8 });
  const correlation = records.filter(row => /^agent-command: (?:begin|end)\b/u.test(row.message ?? ''))
    .map(({raw: _raw, event: _event, ...row}) => row);
  const merged = new Map<number, unknown>();
  for (const row of [...filtered.records, ...filtered.unclassified.samples, ...correlation]) merged.set(row.revision, row);
  const evidence = [...merged.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row);
  const byReason={...filtered.suppressed.byReason};
  byReason.command_correlation=(byReason.command_correlation ?? 0)-correlation.length;
  if (!byReason.command_correlation) delete byReason.command_correlation;
  return { observations: evidence.slice(-128), evidenceSummary: {
    sourceRecords: records.length, suppressed: {count:filtered.suppressed.count-correlation.length,byReason},
    unclassified: filtered.unclassified.count, omitted: Math.max(0, evidence.length-128),
  } };
}

/** Store semantic evidence and counters; high-volume raw telemetry remains temporary. */
export function durableActionRecord(action: ActionRecord) {
  return {
    ...action,
    ...selectEvidence(action.observations),
    steps: action.steps.map(step => ({...step, ...selectEvidence(step.observations)})),
  };
}
