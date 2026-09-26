import type { BlindestEvent, ParsedLogLine } from "./events.js";

const envelopePattern = /^\[\s*(\d+)\]\s+(.*)$/u;

export function parseLogEnvelope(raw: string): ParsedLogLine | undefined {
  const match = envelopePattern.exec(raw.trimEnd());
  if (!match) return undefined;
  return { tick: Number(match[1]), message: match[2] ?? "", raw };
}

export function parseBlindestLine(raw: string): BlindestEvent | undefined {
  const line = parseLogEnvelope(raw);
  if (!line) return undefined;
  const base = { tick: line.tick, raw: line.raw };

  let match = /^axcontext -> ([a-z_]+)$/u.exec(line.message);
  if (match) return { ...base, kind: "context_changed", context: match[1] ?? "unknown" };

  match = /^building: active, "([^"]+)" mode=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "building_opened",
      buildingId: match[1] ?? "unknown",
      mode: Number(match[2]),
    };
  }

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

  match = /^agent-town: building_begin id="([^"]+)" mode=(\d+)$/u.exec(line.message);
  if (match) return { ...base, kind: "building_snapshot_started", buildingId: match[1] ?? "unknown", mode: Number(match[2]) };
  match = /^agent-town: building_end id="([^"]+)"$/u.exec(line.message);
  if (match) return { ...base, kind: "building_snapshot_completed", buildingId: match[1] ?? "unknown" };
  match = /^agent-town: wallet gold=(-?\d+) bust=(-?\d+) portrait=(-?\d+) deed=(-?\d+) crest=(-?\d+) shard=(-?\d+)$/u.exec(line.message);
  if (match) return {
    ...base, kind: "town_wallet_observed", gold: Number(match[1]), bust: Number(match[2]),
    portrait: Number(match[3]), deed: Number(match[4]), crest: Number(match[5]), shard: Number(match[6]),
  };

  match = /^bldact probe: row (\d+) act="([^"]+)" \((\d+)\) slot (\d+)\/(\d+) elem=(0x[0-9a-f]+)\([^)]*\) cancel=0x[0-9a-f]+\([^)]*\) committed=(\d+) pending=[0-9A-F]+"([^"]*)" pending_guid=(\d+) occupant=(-?\d+) locked=(\d+) evtlocked=(\d+) costsmoney=(\d+)$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "building_activity_observed", row: Number(match[1]), activityId: match[2] ?? "",
    activityOrder: Number(match[3]), slot: Number(match[4]), slotCount: Number(match[5]), elementId: match[6] ?? "",
    ...(Number(match[7]) > 0 ? { committedHeroGuid: Number(match[7]) } : {}), pendingHeroName: match[8] ?? "",
    ...(Number(match[9]) > 0 ? { pendingHeroGuid: Number(match[9]) } : {}), occupant: Number(match[10]),
    locked: match[11] === "1", eventLocked: match[12] === "1", costsMoney: match[13] === "1",
  };
  match = /^bldrows probe: row (\d+) slot (\d+) id="([^"]*)" name="([^"]*)" price=(MISS )?(-?\d+) elem=(0x[0-9a-f]+)/iu.exec(line.message);
  if (match) return {
    ...base, kind: "building_shop_item_observed", row: Number(match[1]), slot: Number(match[2]), itemId: match[3] ?? "",
    name: match[4] ?? "", priceKnown: match[5] === undefined, price: Number(match[6]), elementId: match[7] ?? "",
  };
  match = /^bldrows probe: row (\d+) effects=\d+ "([^"]*)"$/u.exec(line.message);
  if (match) return { ...base, kind: "building_shop_item_effects_observed", row: Number(match[1]), effects: match[2] ?? "" };
  match = /^bldrows probe: row (\d+) rec=[0-9A-F]+ rarity="([^"]*)" classreq="([^"]*)"$/u.exec(line.message);
  if (match) return { ...base, kind: "building_shop_item_metadata_observed", row: Number(match[1]), rarity: match[2] ?? "", classRequirement: match[3] ?? "" };
  match = /^graveyard probe: .* -> (\d+) memorial rows$/u.exec(line.message);
  if (match) return { ...base, kind: "building_memorial_count_observed", count: Number(match[1]) };
  match = /^graveyard probe: row (\d+) cell=0x[0-9a-f]+ "([^"]*)"$/iu.exec(line.message);
  if (match) return { ...base, kind: "building_memorial_observed", row: Number(match[1]), text: match[2] ?? "" };
  match = /^heroaction probe: "[^"]+" skin=-?\d+ facility=[0-9A-F]+ selected guid=(\d+) heroes=(\d+) spare=\d+$/u.exec(line.message);
  if (match) return { ...base, kind: "building_hero_table_observed", ...(Number(match[1]) > 0 ? { selectedHeroGuid: Number(match[1]) } : {}), heroCount: Number(match[2]) };
  match = /^heroaction probe: hero (\d+) guid=(\d+) "([^"]*)" row=[0-9A-F]+$/u.exec(line.message);
  if (match) return { ...base, kind: "building_roster_hero_observed", row: Number(match[1]), heroGuid: Number(match[2]), name: match[3] ?? "" };
  match = /^heroaction: column (\d+) "([^"]*)" hash=(0x[0-9a-f]+) kind=(-?\d+) idx=(-?\d+) level=(-?\d+) selected=(\d+) steps=(\d+) bought=(\d+) next=(-?\d+) name="([^"]*)"$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "building_hero_option_observed", column: Number(match[1]), optionId: match[2] ?? "", optionHash: match[3] ?? "",
    optionKind: Number(match[4]), skillIndex: Number(match[5]), level: Number(match[6]), selected: match[7] === "1",
    steps: Number(match[8]), bought: Number(match[9]), next: Number(match[10]), name: match[11] ?? "",
  };
  match = /^heroaction: tree "([^"]*)" step '(.)' purchased=(\d+) armed=(unknown|0|1) cost=(-?\d+) ([^ ]*) resolve=(-?\d+) elem=(0x[0-9a-f]+) live=(\d+)$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "building_hero_option_step_observed", optionId: match[1] ?? "", code: match[2] ?? "", purchased: match[3] === "1",
    ...(match[4] === "unknown" ? {} : { armed: match[4] === "1" }), cost: Number(match[5]), currency: match[6] ?? "",
    resolveRequired: Number(match[7]), elementId: match[8] ?? "", live: match[9] === "1",
  };

  match = /^bldup rows: track (\d+) step '(.)' urd=(?:0x)?[0-9a-f]+ stride=0x[0-9a-f]+ armed=(\d+) f80=0x[0-9a-f]+ f84=0x[0-9a-f]+$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "building_upgrade_step_observed", track: Number(match[1]), code: match[2] ?? "", armed: Number(match[3]),
  };
  match = /^bldup rows: track (\d+) hash=(0x[0-9a-f]+) id="([^"]*)" def=(yes|NO) steps=(\d+) armed=(-?\d+) bought=(\d+) next=(-?\d+) "([^"]*)"$/iu.exec(line.message);
  if (match) return {
    ...base, kind: "building_upgrade_track_observed", track: Number(match[1]), trackHash: match[2] ?? "",
    trackId: match[3] ?? "", knownDefinition: match[4] === "yes", steps: Number(match[5]),
    armed: Number(match[6]), bought: Number(match[7]), next: Number(match[8]), name: match[9] ?? "",
  };

  match = /^townmap rows: \[(\d+)\] id="([^"]+)" elem=(0x[0-9a-f]+) unlocked=(\d+) screen=(\d+) district=(\d+) offsave=(\d+) new=(\d+) name="([^"]+)"$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "town_location_observed",
      row: Number(match[1]),
      id: match[2] ?? "unknown",
      elementId: match[3] ?? "",
      unlocked: match[4] === "1",
      screen: match[5] === "1",
      district: match[6] === "1",
      offSave: match[7] === "1",
      isNew: match[8] === "1",
      name: match[9] ?? "",
    };
  }

  match = /^townmap: active, layer (-?\d+), (\d+) locations, row (\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "town_map_ready",
      layer: Number(match[1]),
      locationCount: Number(match[2]),
      selectedRow: Number(match[3]),
    };
  }

  match = /^bldrows probe: row (\d+) slot (\d+) hero=([0-9A-F]+) "([^"]+)" elem=(0x[0-9a-f]+) at /iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "building_hero_observed",
      row: Number(match[1]),
      slot: Number(match[2]),
      heroAddress: match[3] ?? "",
      name: match[4] ?? "",
      elementId: match[5] ?? "",
    };
  }

  match = /^bldrows: recruit pending, slot (\d+) hero=([0-9A-F]+) "([^"]+)" \(roster (\d+) of (\d+)\)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "recruit_pending",
      slot: Number(match[1]),
      heroAddress: match[2] ?? "",
      name: match[3] ?? "",
      rosterCount: Number(match[4]),
      rosterCapacity: Number(match[5]),
    };
  }

  match = /^bldrows: recruit observed \(entries (\d+) -> (\d+)\)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "hero_recruited",
      previousRosterCount: Number(match[1]),
      rosterCount: Number(match[2]),
    };
  }

  match = /^bldrows: recruit cancelled \(slot (\d+)\)$/u.exec(line.message);
  if (match) {
    return { ...base, kind: "recruit_cancelled", slot: Number(match[1]) };
  }

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

  match = /^tutorialpopup id=([^ ]+) text="(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "tutorial_opened",
      tutorialId: match[1] ?? "unknown",
      text: match[2] ?? "",
    };
  }

  match = /^(?:tutorial closed; context "([^"]+)" does not re-announce|tutorial closed -> handing focus back to "([^"]+)")$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "tutorial_closed",
      context: match[1] ?? match[2] ?? "unknown",
    };
  }

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

  match = /^loadingscreen continue \(polite\): "(.*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "loading_continue_ready",
      text: match[1] ?? "",
    };
  }

  match = /^roomview enter: party=(\d+) enemies=(\d+) props=(\d+) doors=(\d+) wave=(\d+) wayon=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "room_view_observed",
      partyCount: Number(match[1]),
      enemyCount: Number(match[2]),
      propCount: Number(match[3]),
      doorCount: Number(match[4]),
      wave: match[5] === "1",
      wayOn: match[6] === "1",
    };
  }

  match = /^roomview DUMP doors=(\d+)/u.exec(line.message);
  if (match) {
    return { ...base, kind: "room_doors_started", doorCount: Number(match[1]) };
  }

  match = /^rv-door\[\d+\].* dest='([^']+)'/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "room_door_observed",
      destinationAreaId: match[1] ?? "",
    };
  }

  match = /^map-move: '([^']+)' -> '([^']+)' via door \{'([^']+)', tile (\d+)\}$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "map_move_started",
      fromArea: match[1] ?? "",
      toArea: match[2] ?? "",
      viaArea: match[3] ?? "",
      doorTile: Number(match[4]),
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

  match = /^agent-map: begin areas=(\d+) current='([^']*)'$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "map_snapshot_started",
      areaCount: Number(match[1]),
      currentAreaId: match[2] ?? "",
    };
  }

  match = /^agent-map: area index=(\d+) id='([^']*)' kind=(-?\d+) current=(\d+) tiles=(\d+) visited=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "map_area_observed",
      areaIndex: Number(match[1]),
      areaId: match[2] ?? "",
      areaKind: Number(match[3]),
      current: match[4] === "1",
      tileCount: Number(match[5]),
      visited: match[6] === "1",
    };
  }

  match = /^agent-map: tile area='([^']*)' index=(\d+) type=(-?\d+) content=(-?\d+) knowledge=(\d+) visible=(\d+) visited=(\d+) current=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "map_tile_observed",
      areaId: match[1] ?? "",
      tileIndex: Number(match[2]),
      tileType: Number(match[3]),
      content: Number(match[4]),
      knowledge: Number(match[5]),
      visible: match[6] === "1",
      visited: match[7] === "1",
      current: match[8] === "1",
    };
  }

  match = /^agent-map: edge from='([^']*)' direction=(\d+) to='([^']*)' corridor='([^']*)' corridorTiles=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "map_edge_observed",
      fromAreaId: match[1] ?? "",
      direction: Number(match[2]),
      toAreaId: match[3] ?? "",
      corridorAreaId: match[4] ?? "",
      corridorTiles: Number(match[5]),
    };
  }

  match = /^agent-map: position area='([^']*)' tile=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "map_position_observed",
      areaId: match[1] ?? "",
      tileIndex: Number(match[2]),
    };
  }

  if (line.message === "agent-map: end") {
    return { ...base, kind: "map_snapshot_completed" };
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

  match = /^event: scroll opened, skin=(\d+) rows=(\d+) title="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "event_opened",
      skin: Number(match[1]),
      rowCount: Number(match[2]),
      title: match[3] ?? "",
    };
  }
  if (line.message === "event: scroll closed") {
    return { ...base, kind: "event_closed" };
  }
  match = /^event: activating "([^"]*)" (?:by CLICKING its element(?: 0x[0-9a-f]+)?|via native action 0x[0-9a-f]+ \(cap=[^)]+\))$/iu.exec(
    line.message,
  );
  if (match) {
    return { ...base, kind: "event_option_activated", name: match[1] ?? "" };
  }

  if (line.message === "agent-state: begin") {
    return { ...base, kind: "agent_state_started" };
  }

  match = /^agent-state: inventory begin slots=(\d+) occupied=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "inventory_snapshot_started",
      slotCount: Number(match[1]),
      occupiedCount: Number(match[2]),
    };
  }

  match = /^agent-state: prop index=(\d+) address=([0-9A-F]+) active=(\d+) trap=(\d+) reachable=(\d+) direction=(-?\d+) dx=([-\d.]+) name="([^"]*)"$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "room_prop_observed",
      propIndex: Number(match[1]),
      address: match[2] ?? "",
      active: match[3] === "1",
      trap: match[4] === "1",
      reachable: match[5] === "1",
      direction: Number(match[6]),
      distance: Number(match[7]),
      name: match[8] ?? "",
    };
  }

  match = /^agent-state: inventory slot=(\d+) amount=(\d+) type="([^"]*)" item_id="([^"]*)" key="([^"]*)" name="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "inventory_item_observed",
      slot: Number(match[1]),
      amount: Number(match[2]),
      itemType: match[3] ?? "",
      itemId: match[4] ?? "",
      itemKey: match[5] ?? "",
      name: match[6] ?? "",
    };
  }
  if (line.message === "agent-state: inventory end") {
    return { ...base, kind: "inventory_snapshot_completed" };
  }

  match = /^agent-state: event begin skin=(\d+) rows=(\d+) pick_item=(\d+) title="([^"]*)" flavour="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "event_snapshot_started",
      skin: Number(match[1]),
      rowCount: Number(match[2]),
      pickingItem: match[3] === "1",
      title: match[4] ?? "",
      flavour: match[5] ?? "",
    };
  }

  match = /^agent-state: event row=(\d+) name="([^"]*)" desc="([^"]*)" item_slot=(\d+) enabled=(\d+)$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "event_option_observed",
      optionIndex: Number(match[1]),
      name: match[2] ?? "",
      description: match[3] ?? "",
      itemSlot: match[4] === "1",
      enabled: match[5] === "1",
    };
  }

  match = /^agent-state: event item slot=(\d+) works=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "event_item_compatibility_observed",
      slot: Number(match[1]),
      works: match[2] === "1",
    };
  }
  if (line.message === "agent-state: event end") {
    return { ...base, kind: "event_snapshot_completed" };
  }

  match = /^agent-state: loot begin count=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "loot_snapshot_started",
      itemCount: Number(match[1]),
    };
  }

  match = /^agent-state: loot item=(\d+) pool_slot=(\d+) amount=(\d+) type="([^"]*)" item_id="([^"]*)" key="([^"]*)" name="([^"]*)"$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "loot_item_observed",
      itemIndex: Number(match[1]),
      poolSlot: Number(match[2]),
      amount: Number(match[3]),
      itemType: match[4] ?? "",
      itemId: match[5] ?? "",
      itemKey: match[6] ?? "",
      name: match[7] ?? "",
    };
  }
  if (line.message === "agent-state: loot end") {
    return { ...base, kind: "loot_snapshot_completed" };
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

  match = /^agent-state: light kind=(torch|ambient) value=([-\d.]+) level=(-?\d+) text="([^"]*)"$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "light_observed",
      lightKind: match[1] === "ambient" ? "ambient" : "torch",
      value: Number(match[2]),
      level: Number(match[3]),
      text: match[4] ?? "",
    };
  }

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

  if (line.message === "agent-state: end") {
    return { ...base, kind: "agent_state_completed" };
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

  match = /^loot: window opened, (\d+) items?, token="([^"]*)"/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "loot_opened",
      itemCount: Number(match[1]),
      token: match[2] ?? "",
    };
  }
  if (/^loot: window closed$/u.test(line.message)) {
    return { ...base, kind: "loot_closed" };
  }

  match = /^agent-event: inventory_consolidated merges=(\d+) freed=(\d+) accepted=(\d+)(?: reason=\S+)?$/u.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "inventory_consolidated",
      merges: Number(match[1]),
      freed: Number(match[2]),
      accepted: match[3] === "1",
    };
  }

  match = /^agent-state: trap_chance address=([0-9A-F]+) hero_index=(\d+) chance=([-\d.]+)$/iu.exec(
    line.message,
  );
  if (match) {
    const rawChance = Number(match[3]);
    return {
      ...base,
      kind: "trap_chance_observed",
      actorAddress: match[1] ?? "",
      heroIndex: Number(match[2]),
      // Blindest builds have emitted both a 0..1 ratio and an already scaled
      // 0..100 percentage. Keep the model-facing state in percentage points.
      chance:
        rawChance >= 0 && rawChance <= 1
          ? rawChance * 100
          : rawChance,
    };
  }

  match = /^announce: slot (\d+)\/(\d+) actor=([0-9A-F]+)(?: \[[^\]]+\])? -> "(.*)"$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "dungeon_announcement",
      slot: Number(match[1]),
      slotCount: Number(match[2]),
      actorAddress: match[3] ?? "",
      text: match[4] ?? "",
    };
  }

  match = /^agent-event: trap_started prop=([0-9A-F]+) actor=([0-9A-F]+) guid=(\d+) hero_index=(-?\d+) deliberate=(\d+)$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "trap_interaction_started",
      propAddress: match[1] ?? "",
      actorAddress: match[2] ?? "",
      ...(Number(match[3]) > 0 ? { heroGuid: Number(match[3]) } : {}),
      heroIndex: Number(match[4]),
      deliberate: match[5] === "1",
    };
  }

  match = /^agent-event: trap_result prop=([0-9A-F]+) actor=([0-9A-F]+) guid=(\d+) outcome=(disarmed|triggered|unknown) hp_delta=([-\d.]+) stress_delta=([-\d.]+) deliberate=(\d+)$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "trap_result",
      propAddress: match[1] ?? "",
      actorAddress: match[2] ?? "",
      ...(Number(match[3]) > 0 ? { heroGuid: Number(match[3]) } : {}),
      outcome: (match[4] ?? "unknown").toLowerCase() as
        | "disarmed"
        | "triggered"
        | "unknown",
      hpDelta: Number(match[5]),
      stressDelta: Number(match[6]),
      deliberate: match[7] === "1",
    };
  }

  match = /^agent-event: quirk_loot_withheld actor=([0-9A-F]+) guid=(\d+) quirk="([^"]+)" text="(.*)"$/iu.exec(
    line.message,
  );
  if (match) {
    return {
      ...base,
      kind: "quirk_loot_withheld",
      actorAddress: match[1] ?? "",
      ...(Number(match[2]) > 0 ? { heroGuid: Number(match[2]) } : {}),
      quirkId: match[3] ?? "",
      text: match[4] ?? "",
    };
  }

  return undefined;
}
