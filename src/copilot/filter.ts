import type { BlindestEvent } from "../blindest/events.js";
import type { BlindestLogRecord } from "../live/combat-log-source.js";

type CompactEvent<T> = T extends unknown ? Omit<T, "raw"> : never;

export type CopilotRecordCategory =
  | "state"
  | "action"
  | "gameplay"
  | "guidance";

export interface CopilotRecord {
  revision: number;
  observedAt: string;
  tick?: number;
  category: CopilotRecordCategory;
  importance: "critical" | "normal";
  message?: string;
  event?: CompactEvent<BlindestEvent>;
}

export interface CopilotFilterResult {
  records: CopilotRecord[];
  unclassified: {
    count: number;
    samples: Array<{
      revision: number;
      observedAt: string;
      tick?: number;
      message?: string;
    }>;
  };
  suppressed: {
    count: number;
    byReason: Record<string, number>;
  };
}

const diagnosticRules: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "command_correlation", pattern: /^agent-command:/u },
  { reason: "speech_backend", pattern: /^speech(?:->prism|\b)/u },
  { reason: "cursor_probe", pattern: /^(?:ctrlprobe|cursor)\b/u },
  { reason: "synthetic_input_trace", pattern: /^(?:synth emit|fe-(?:move|land)|fe\[)/u },
  { reason: "memory_probe", pattern: /(?:\bprobe(?:\(|:)|^actorx:|^rv-rank:|^scoutdiag:)/u },
  { reason: "combat_internal", pattern: /^(?:armed-watch|targeting|targetinfo):/u },
  { reason: "ambient_bark", pattern: /^townbark:/u },
  {
    reason: "raw_memory_dump",
    pattern:
      /^(?:curiores \+0x[0-9a-f]+:|scroll block:|\(model:|display=0x|disp\+0x)/iu,
  },
  {
    reason: "startup_instrumentation",
    pattern:
      /^(?:text-input hooks|(?:menu|tut|townevent|journal|light|banner|popup)hook:|axlang:|subtitles:|layout:|keymap:)/u,
  },
  { reason: "input_binding_probe", pattern: /^townjump:/u },
  { reason: "repeated_quest_completion_probe", pattern: /^quest: complete\?/u },
  {
    reason: "town_internal",
    pattern:
      /^(?:townmap: (?:bare-map gate|stood down|re-announcing|town layer)|townmap rows: layer vector|building: re-announcing)/u,
  },
  {
    reason: "transient_room_probe",
    pattern: /^roomview: party vector empty or bad$/u,
  },
  {
    reason: "map_auto_pan",
    pattern: /^map pan: the panel(?: is panning|'s pan arrived)/u,
  },
  { reason: "separator", pattern: /^(?:=+|preamble(?:\b|:))/u },
];

const gameplayPatterns: RegExp[] = [
  /^actionbar (?:hero|label)/u,
  /^status:/u,
  /^party:/u,
  /^curiores RESOLVE: (?:title|content)/u,
  /^(?:quest|results|loot|map|roomview):/u,
  /^townlog: opened/u,
  /^(?:festate|frontend|saveslot|loadingscreen|infestation)\b/u,
  /^tutorial closed\b/u,
  /^townmap rows: (?:(?:"[^"]+" is hidden)|(?:\[ddis\]))/u,
];

const actionPatterns: RegExp[] = [
  /^agent-item:/u,
  /^agent-ipc:/u,
  /^townmap: (?:open|".*" opened)/u,
  /^fe-click /u,
];

function compactUnknown(record: BlindestLogRecord) {
  return {
    revision: record.revision,
    observedAt: record.observedAt,
    ...(record.tick === undefined ? {} : { tick: record.tick }),
    ...(record.message === undefined ? {} : { message: record.message }),
  };
}

function parsedRecord(record: BlindestLogRecord): CopilotRecord {
  const kind = record.event?.kind;
  const critical =
    kind === "context_changed" ||
    kind === 'confirmation_dialog_observed' ||
    kind === "building_opened" ||
    kind === "embark_ready" ||
    kind === "embark_quest_selected" ||
    kind === "embark_forward_outcome" ||
    kind === "party_lineup_ready" ||
    kind === "party_lineup_closed" ||
    kind === "party_hero_added" ||
    kind === "provision_ready" ||
    kind === "provision_transaction_observed" ||
    kind === "recruit_pending" ||
    kind === "hero_recruited" ||
    kind === "recruit_cancelled" ||
    kind === "combat_started" ||
    kind === "combat_ended" ||
    kind === "actor_changed" ||
    kind === "enemy_count_changed" ||
    kind === "loot_opened" ||
    kind === "loot_closed" ||
    kind === "trap_interaction_started" ||
    kind === "trap_result" ||
    kind === "dungeon_announcement" ||
    kind === "quirk_loot_withheld";
  const { raw: _raw, ...event } = record.event as BlindestEvent;
  return {
    revision: record.revision,
    observedAt: record.observedAt,
    ...(record.tick === undefined ? {} : { tick: record.tick }),
    category: "state",
    importance: critical ? "critical" : "normal",
    ...(record.message === undefined ? {} : { message: record.message }),
    event: event as CompactEvent<BlindestEvent>,
  };
}

function messageRecord(
  record: BlindestLogRecord,
  category: CopilotRecordCategory,
  importance: "critical" | "normal",
): CopilotRecord {
  return {
    revision: record.revision,
    observedAt: record.observedAt,
    ...(record.tick === undefined ? {} : { tick: record.tick }),
    category,
    importance,
    ...(record.message === undefined ? {} : { message: record.message }),
  };
}

export function filterCopilotRecords(
  input: BlindestLogRecord[],
  options: { unclassifiedSampleLimit?: number } = {},
): CopilotFilterResult {
  const records: CopilotRecord[] = [];
  const unclassified: BlindestLogRecord[] = [];
  const byReason: Record<string, number> = {};

  for (const record of input) {
    if (record.event !== undefined) {
      if (
        record.event.kind === "agent_state_started" ||
        record.event.kind === "hero_observed" ||
        record.event.kind === "hero_rank_observed" ||
        record.event.kind === "embark_state_observed" ||
        record.event.kind === "embark_location_observed" ||
        record.event.kind === "embark_quest_observed" ||
        // The current quest details are already present in decision.options,
        // including changed descriptions; do not repeat the entire text in delta.
        record.event.kind === "embark_quest_detail_observed" ||
        record.event.kind === "inventory_snapshot_started" ||
        record.event.kind === "inventory_item_observed" ||
        record.event.kind === "inventory_snapshot_completed" ||
        record.event.kind === "actor_detail_observed" ||
        record.event.kind === "skill_detail_observed" ||
        record.event.kind === "skill_observed" ||
        record.event.kind === "light_observed" ||
        record.event.kind === "camp_observed" ||
        record.event.kind === "camp_meal_observed" ||
        record.event.kind === "quest_observed" ||
        record.event.kind === "quest_row_observed" ||
        record.event.kind === "results_observed" ||
        record.event.kind === "combatant_observed" ||
        record.event.kind === "combat_action_observed" ||
        record.event.kind === "agent_state_completed"
      ) {
        byReason.agent_state_snapshot =
          (byReason.agent_state_snapshot ?? 0) + 1;
        continue;
      }
      records.push(parsedRecord(record));
      continue;
    }
    const message = record.message ?? "";
    if (/^tutorialpopup\b/u.test(message)) {
      records.push(messageRecord(record, "guidance", "normal"));
      continue;
    }
    const diagnostic = diagnosticRules.find(({ pattern }) => pattern.test(message));
    if (diagnostic !== undefined) {
      byReason[diagnostic.reason] = (byReason[diagnostic.reason] ?? 0) + 1;
      continue;
    }
    if (actionPatterns.some((pattern) => pattern.test(message))) {
      records.push(messageRecord(record, "action", "critical"));
      continue;
    }
    if (gameplayPatterns.some((pattern) => pattern.test(message))) {
      records.push(messageRecord(record, "gameplay", "normal"));
      continue;
    }
    unclassified.push(record);
  }

  const sampleLimit = Math.max(0, options.unclassifiedSampleLimit ?? 20);
  return {
    records,
    unclassified: {
      count: unclassified.length,
      samples: unclassified.slice(-sampleLimit).map(compactUnknown),
    },
    suppressed: {
      count: Object.values(byReason).reduce((sum, count) => sum + count, 0),
      byReason,
    },
  };
}
