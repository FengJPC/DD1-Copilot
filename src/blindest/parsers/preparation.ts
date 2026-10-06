import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parsePreparation(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  if (line.message.startsWith('agent-equipment: unavailable ')) return { ...base, kind: 'equipment_unavailable' };
  match = /^agent-equipment: begin native_control=([01])$/u.exec(line.message);
  if (match) return { ...base, kind: 'equipment_snapshot_started', nativeControl: match[1] === '1' };
  match = /^agent-equipment: end items=(\d+)$/u.exec(line.message);
  if (match) return { ...base, kind: 'equipment_snapshot_completed', itemCount: Number(match[1]) };
  match = /^agent-equipment: item slot=(\d+) amount=(\d+) id="([^"]*)" name="([^"]*)" effects="([^"]*)" class="([^"]*)"$/u.exec(line.message);
  if (match) return { ...base, kind: 'equipment_item_observed', inventorySlot: Number(match[1]), amount: Number(match[2]),
    itemId: match[3] ?? '', name: match[4] ?? '', effects: match[5] ?? '', classRequirement: match[6] ?? '' };
  match = /^agent-prep: trinket guid=(\d+) slot=([01]) status=(empty|equipped|unknown) id="([^"]*)" name="([^"]*)" effects="([^"]*)"$/u.exec(line.message);
  if (match) return {
    ...base, kind: 'roster_trinket_observed', heroGuid: Number(match[1]), slot: Number(match[2]),
    status: match[3] as 'empty' | 'equipped' | 'unknown', itemId: match[4] ?? '', name: match[5] ?? '', effects: match[6] ?? '',
  };
  match = /^embark: active, (\d+) quests in (\d+) locations, cursor (\d+)\/(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "embark_ready",
      questCount: Number(match[1]),
      locationCount: Number(match[2]),
      cursorColumn: Number(match[3]),
      cursorRow: Number(match[4]),
    };
  }

  match = /^embark probe: qsState=(\d+) sel=(-?\d+) special=(-?\d+) camp=/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "embark_state_observed",
      questScreenState: Number(match[1]),
      selectedQuestIndex: Number(match[2]),
      specialQuestIndex: Number(match[3]),
    };
  }

  match = /^embark probe: column (\d+) dungeon="([^"]*)" (\d+) quests /u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "embark_location_observed",
      column: Number(match[1]),
      dungeonId: match[2] ?? "",
      questCount: Number(match[3]),
    };
  }

  match = /^embark probe: row (\d+) qIdx=(-?\d+) id="([^"]*)" dungeon="([^"]*)" len=(\d+) diff=(\d+) elem\((0x[0-9a-f]+)\)=(onscreen|ABSENT)$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "embark_quest_observed",
      row: Number(match[1]),
      questIndex: Number(match[2]),
      questId: match[3] ?? "",
      dungeonId: match[4] ?? "",
      length: Number(match[5]),
      difficulty: Number(match[6]),
      elementId: match[7] ?? "",
      onScreen: match[8] === "onscreen",
    };
  }

  match = /^agent-prep: quest_detail qidx=(-?\d+) line=(\d+) text="([^"]*)"$/u.exec(line.message);
  if (match) return {
    ...base, kind: "embark_quest_detail_observed", questIndex: Number(match[1]),
    line: Number(match[2]), text: match[3] ?? "",
  };

  match = /^embark nav location (\d+) -> (\d+) \(of (\d+)\), (\d+) quests$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "embark_cursor_location_changed",
      previousColumn: Number(match[1]),
      column: Number(match[2]),
      locationCount: Number(match[3]),
      questCount: Number(match[4]),
    };
  }

  match = /^embark: selection observed -> (-?\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "embark_quest_selected",
      questIndex: Number(match[1]),
    };
  }

  match = /^embark: forward outcome observed \(qs (\d+)->(\d+) prov (\d+)->(\d+) layer (-?\d+)->(-?\d+)\)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "embark_forward_outcome",
      previousQuestScreen: match[1] === "1",
      questScreen: match[2] === "1",
      previousProvision: match[3] === "1",
      provision: match[4] === "1",
      previousLayer: Number(match[5]),
      layer: Number(match[6]),
    };
  }

  match = /^agent-prep: (party|provision)_begin$/u.exec(line.message);
  if (match) return { ...base, kind: "preparation_snapshot_started", section: match[1] as "party" | "provision" };

  match = /^agent-prep: wallet gold=(-?\d+) shards=(-?\d+) bag=(\d+)$/u.exec(line.message);
  if (match) return { ...base, kind: "provision_wallet_observed", gold: Number(match[1]), shards: Number(match[2]), bagTotal: Number(match[3]) };

  match = /^agent-prep: party_end slots=(\d+) filled=(\d+)$/u.exec(line.message);
  if (match) return { ...base, kind: "party_lineup_ready", slotCount: Number(match[1]), filledCount: Number(match[2]) };

  match = /^party probe: slot (\d+) = position (\d+) iface=[0-9A-F]+ hero=([0-9A-F]+) entry=([0-9A-F]+) "([^"]*)" barred=(\d+) elem=(0x[0-9a-f]+) /iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "party_slot_observed",
      ...(Number(/hero_guid=(\d+)/u.exec(line.message)?.[1]) > 0 ? { heroGuid: Number(/hero_guid=(\d+)/u.exec(line.message)?.[1]) } : {}),
      slot: Number(match[1]),
      position: Number(match[2]),
      heroAddress: match[3] ?? "0",
      entryAddress: match[4] ?? "0",
      name: match[5] === "(empty)" ? "" : (match[5] ?? ""),
      barred: match[6] === "1",
      elementId: match[7] ?? "",
    };
  }

  match = /^party: lineup active, (\d+) slots, (\d+) filled$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "party_lineup_ready",
      slotCount: Number(match[1]),
      filledCount: Number(match[2]),
    };
  }

  match = /^party: (.+) -> stood down to the surface underneath$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "party_lineup_closed",
      reason: match[1] ?? "unknown",
    };
  }

  match = /^agent-prep: roster_profile guid=(\d+) name="([^"]*)" class="([^"]*)" level=(-?\d+) health="([^"]*)" stress="([^"]*)" weapon=(\d+) armour=(\d+)$/u.exec(line.message);
  if (match) return {
    ...base, kind: "roster_profile_observed", heroGuid: Number(match[1]), name: match[2] ?? "",
    heroClass: match[3] ?? "", level: Number(match[4]), healthText: match[5] ?? "",
    stressText: match[6] ?? "", weaponLevel: Number(match[7]), armourLevel: Number(match[8]),
  };

  match = /^agent-prep: roster_detail guid=(\d+) category=(quirk|disease) line=(\d+) text="([^"]*)"$/u.exec(line.message);
  if (match) return {
    ...base, kind: "roster_profile_detail_observed", heroGuid: Number(match[1]),
    category: match[2] as "quirk" | "disease", line: Number(match[3]), text: match[4] ?? "",
  };

  match = /^roster: pick adds (.+) call=(\d+) state (\d+) -> (\d+) \(slot (\d+) = position (\d+)\)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "party_hero_added",
      name: match[1] ?? "",
      callSucceeded: match[2] === "1",
      previousState: Number(match[3]),
      state: Number(match[4]),
      slot: Number(match[5]),
      position: Number(match[6]),
    };
  }

  if (line.message === "provision: active") {
    return { ...base, kind: "provision_ready" };
  }

  match = /^prov probe:\s+slot (\d+) amount=(-?\d+) type="([^"]*)" id="([^"]*)" price=(MISS )?gold (\d+) shard (\d+) free=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "provision_item_observed",
      slot: Number(match[1]),
      amount: Number(match[2]),
      itemType: match[3] ?? "",
      itemId: match[4] ?? "",
      priceKnown: match[5] === undefined,
      goldPrice: Number(match[6]),
      shardPrice: Number(match[7]),
      freeCount: Number(match[8]),
    };
  }

  match = /^prov probe: section (\d+) \([^)]+\):/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "provision_section_observed",
      section: Number(match[1]),
    };
  }

  match = /^provision: tx observed \(gold (-?\d+)->(-?\d+) shard (-?\d+)->(-?\d+) bag (-?\d+)->(-?\d+)\)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "provision_transaction_observed",
      previousGold: Number(match[1]),
      gold: Number(match[2]),
      previousShards: Number(match[3]),
      shards: Number(match[4]),
      previousBagTotal: Number(match[5]),
      bagTotal: Number(match[6]),
    };
  }
  return undefined;
}
