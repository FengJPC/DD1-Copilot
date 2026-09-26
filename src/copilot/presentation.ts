import type { ActionRecord } from "./types.js";
import type { CombatDecisionWaitResult } from "./engine.js";

export function summarizeActionRecord(action: ActionRecord) {
  return {
    requestId: action.requestId,
    action: action.action,
    rationale: action.rationale,
    deduplicated: action.deduplicated,
    sourceRevision: action.sourceRevision,
    finalRevision: action.finalRevision,
    outcome: action.outcome,
    stage: action.stage,
    reason: action.reason,
    recovery: action.recovery,
    steps: action.steps?.map((step) => ({
      name: step.name,
      outcome: step.outcome,
      ...(step.outcome === "success" ? {} : { reason: step.reason }),
    })),
  };
}


export function summarizeCombatTransition(wait: CombatDecisionWaitResult) {
  const events: Array<Record<string, unknown>> = [];
  for (const record of wait.observations) {
    const event = record.event;
    if (event?.kind === "combat_result") {
      events.push({ tick: event.tick, kind: event.kind, resultType: event.resultType, text: event.text });
    }
    else if (event?.kind === "combat_buff") {
      events.push({
        tick: event.tick,
        kind: event.kind,
        stat: event.stat,
        subtype: event.subtype,
        amount: event.amount,
        rounds: event.rounds,
        polarity: event.polarity,
      });
    }
    else if (event?.kind === "actor_changed") {
      events.push({ tick: event.tick, kind: event.kind, actor: event.name, class: event.heroClass });
    }
    else if (event?.kind === "enemy_count_changed") {
      events.push({ tick: event.tick, kind: event.kind, previous: event.previous, current: event.current });
    }
    else if (event?.kind === "combat_ended" || event?.kind === "loot_opened") {
      events.push({ tick: event.tick, kind: event.kind });
    }
  }
  return {
    status: wait.status,
    reason: wait.reason,
    sourceRevision: wait.sourceRevision,
    finalRevision: wait.finalRevision,
    elapsedMs: wait.elapsedMs,
    events: events.slice(-16),
  };
}
