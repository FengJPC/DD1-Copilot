import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseCombat(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^actionbar hero=([0-9A-F]+) class=([0-9A-F]+) name="([^"]+)" class="([^"]+)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "hero_observed",
      heroAddress: match[1] ?? "",
      classAddress: match[2] ?? "",
      name: match[3] ?? "",
      heroClass: match[4] ?? "",
    };
  }

  match = /^charsheet rank: xp=(\d+) thresholds=\d+ -> level (\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "hero_rank_observed",
      xp: Number(match[1]),
      level: Number(match[2]),
    };
  }

  match = /^roster probe: row (\d+) entry=([0-9A-F]+) "([^"]*)" state=(\d+) building="([^"]*)" missing=(\d+)(?: hero_guid=(\d+))?$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "roster_hero_observed",
      ...(Number(match[7]) > 0 ? { heroGuid: Number(match[7]) } : {}),
      row: Number(match[1]),
      entryAddress: match[2] ?? "",
      name: match[3] ?? "",
      state: Number(match[4]),
      building: match[5] ?? "",
      missing: match[6] === "1",
    };
  }

  match = /^roster: active, (\d+) heroes, row (\d+), pickSlot=(-?\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "roster_picker_ready",
      heroCount: Number(match[1]),
      selectedRow: Number(match[2]),
      pickSlot: Number(match[3]),
    };
  }

  match = /^loadingscreen continue \(polite\): "(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "loading_continue_ready",
      text: match[1] ?? "",
    };
  }

  match = /^tilestep: arrived tile=(-?\d+) newArea=(\d+) -> "(.*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "tile_step_arrived",
      tile: Number(match[1]),
      newArea: match[2] === "1",
      description: match[3] ?? "",
    };
  }

  if (/^resting point: combat started\b/u.test(line.message)) {
    return { ...base, kind: "combat_started" };
  }

  if (/^resting point: combat ended\b/u.test(line.message)) {
    return { ...base, kind: "combat_ended" };
  }

  match = /^heroswap: .* -> ([0-9A-F]+) is the TURN .* -> "([^",]+), ([^".]+)\. (\d+)\/(\d+).*? (\d+)\/(\d+)/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "actor_changed",
      actorAddress: match[1] ?? "",
      name: match[2] ?? "",
      heroClass: match[3] ?? "",
      currentHp: Number(match[4]),
      maxHp: Number(match[5]),
      stress: Number(match[6]),
      maxStress: Number(match[7]),
    };
  }

  match = /^actionbar skill id="([^"]+)" .* -> (.+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "skill_observed",
      skillId: match[1] ?? "",
      name: match[2] ?? "",
    };
  }

  match = /^armed-watch: the GAME armed "([^"]+)" -- opening the target list \(bar item (\d+), elem (0x[0-9a-f]+)\)$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "skill_armed",
      name: match[1] ?? "",
      skillSlot: Number(match[2]),
      elementId: match[3] ?? "",
    };
  }

  match = /^target row (\d+)\/(\d+) \((enemy|party) idx=(\d+) slot=(\d+)\) area=(\d+) -> "(.*)"$/u.exec(
    line.message,
  );
  if (match) {
    const details = match[7] ?? "";
    const attack = /^([^,]+), (\d+)% to hit, (\d+)-(\d+) damage, ([\d.]+)% crit, (\d+)\/(\d+) /u.exec(
      details,
    );
    return {
      ...base,
      kind: "target_preview",
      targetIndex: Number(match[1]),
      targetCount: Number(match[2]),
      side: match[3] === "party" ? "party" : "enemy",
      sideIndex: Number(match[4]),
      slot: Number(match[5]),
      area: match[6] === "1",
      name: attack?.[1] ?? details.split(",", 1)[0] ?? "",
      details,
      ...(attack === null
        ? {}
        : {
          hitPercent: Number(attack[2]),
          damageMin: Number(attack[3]),
          damageMax: Number(attack[4]),
          critPercent: Number(attack[5]),
          currentHp: Number(attack[6]),
          maxHp: Number(attack[7]),
        }),
    };
  }

  match = /^combattext: actor=([0-9A-F]+).* type=\d+\(([^)]+)\).* -> "(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "combat_result",
      actorAddress: match[1] ?? "",
      resultType: match[2] ?? "unknown",
      text: match[3] ?? "",
    };
  }

  match = /^combatbuff: actor=([0-9A-F]+) gained stat=(\d+) sub="([^"]*)" amount=([-\d.]+) rounds=(-?\d+) pol=(-?\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "combat_buff",
      actorAddress: match[1] ?? "",
      stat: Number(match[2]),
      subtype: match[3] ?? "",
      amount: Number(match[4]),
      rounds: Number(match[5]),
      polarity: Number(match[6]),
    };
  }

  match = /^agent-state: actor side=(party|enemy) idx=(\d+) slot=(\d+)-(\d+) address=([0-9A-F]+)(?: guid=(\d+))? active=(\d+) name="([^"]*)" health="([^"]*)" stress="([^"]*)" conditions="([^"]*)"(?: runtime_guid=(\d+))?$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "combatant_observed",
      side: match[1] === "enemy" ? "enemy" : "party",
      sideIndex: Number(match[2]),
      slot: Number(match[3]),
      slotEnd: Number(match[4]),
      actorAddress: match[5] ?? "",
      ...(Number(match[12]) > 0 ? { actorGuid: Number(match[12]) } : {}),
      ...(match[1] === "party" && Number(match[6]) > 0
        ? { heroGuid: Number(match[6]) }
        : {}),
      active: match[7] === "1",
      name: match[8] ?? "",
      healthText: match[9] ?? "",
      stressText: match[10] ?? "",
      conditions: match[11] ?? "",
    };
  }

  match = /^agent-state: actor_detail address=([0-9A-F]+) category=(summary|resist|quirk|disease) line=(\d+) text="([^"]*)"$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "actor_detail_observed",
      actorAddress: match[1] ?? "",
      category: (match[2] ?? "summary").toLowerCase() as
        | "summary"
        | "resist"
        | "quirk"
        | "disease",
      line: Number(match[3]),
      text: match[4] ?? "",
    };
  }

  match = /^agent-state: action kind=(skill|pass|reorder|rest|portrait) index=(\d+)(?: skill_slot=(\d+))? element=(0x[0-9a-f]+) name="([^"]*)"$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "combat_action_observed",
      actionKind: match[1] as
        | "skill"
        | "pass"
        | "reorder"
        | "rest"
        | "portrait",
      actionIndex: Number(match[2]),
      ...(match[3] === undefined ? {} : { skillSlot: Number(match[3]) }),
      elementId: match[4] ?? "",
      name: match[5] ?? "",
    };
  }

  match = /^agent-state: skill_detail skill_slot=(\d+) line=(\d+) text="([^"]*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "skill_detail_observed",
      skillSlot: Number(match[1]),
      line: Number(match[2]),
      text: match[3] ?? "",
    };
  }

  match = /^movewatch: enemy membership changed \((\d+) -> (\d+)\)/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "enemy_count_changed",
      previous: Number(match[1]),
      current: Number(match[2]),
    };
  }
  return undefined;
}
