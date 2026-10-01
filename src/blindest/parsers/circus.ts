import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseCircus(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^agent-circus: begin rows=(\d+) slots=(\d+)$/u.exec(line.message);
  if (match) return { ...base, kind: "circus_snapshot_started", rowCount: Number(match[1]), slotCount: Number(match[2]) };

  match = /^agent-circus: contestant row=(\d+) hero=([0-9A-F]+) name="([^"]*)" class="([^"]*)" lineup=(\d+) dlc_locked=(\d+)$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "circus_contestant_observed", row: Number(match[1]), heroAddress: match[2] ?? "",
    name: match[3] ?? "", heroClass: match[4] ?? "", inLineup: match[5] === "1", dlcLocked: match[6] === "1",
  };

  match = /^agent-circus: slot=(\d+) rank=(\d+) hero=([0-9A-F]+) name="([^"]*)" class="([^"]*)"$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "circus_slot_observed", slot: Number(match[1]), rank: Number(match[2]),
    ...(Number.parseInt(match[3] ?? "0", 16) === 0 ? {} : { heroAddress: match[3] }),
    name: match[4] ?? "", heroClass: match[5] ?? "",
  };

  if (line.message === "agent-circus: end") return { ...base, kind: "circus_snapshot_completed" };

  match = /^agent-circus: assignment hero=([0-9A-F]+) slot=(-?\d+) observed=(\d+)$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "circus_assignment_observed", heroAddress: match[1] ?? "", slot: Number(match[2]), observed: match[3] === "1",
  };

  match = /^agent-circus-combat: begin pick_open=(\d+) battle_state=0x([0-9a-f]+) party=(\d+)$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "circus_combat_snapshot_started", pickOpen: match[1] === "1",
    battleState: Number.parseInt(match[2] ?? "0", 16), partyCount: Number(match[3]),
  };

  match = /^agent-circus-combat: hero index=(\d+) actor_guid=(\d+) address=([0-9A-F]+) can_activate=(\d+) active=(\d+) name="([^"]*)"$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "circus_combat_hero_observed", index: Number(match[1]), actorGuid: Number(match[2]),
    actorAddress: match[3] ?? "", canActivate: match[4] === "1", active: match[5] === "1", name: match[6] ?? "",
  };

  if (line.message === "agent-circus-combat: end") return { ...base, kind: "circus_combat_snapshot_completed" };

  match = /^agent-circus-combat: activation actor_guid=(\d+) hero=([0-9A-F]+) observed=(\d+)$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "circus_hero_activation_observed", actorGuid: Number(match[1]),
    actorAddress: match[2] ?? "", observed: match[3] === "1",
  };
  return undefined;
}
