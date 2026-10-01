import type { BlindestEvent, ParsedLogLine } from '../events.js';
import { parseTownDetails } from './town-details.js';

export function parseTown(line: ParsedLogLine): BlindestEvent | undefined {
  const detail = parseTownDetails(line);
  if (detail) return detail;
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
  match = /^building: active, "([^"]+)" mode=(\d+)$/u.exec(line.message);
  if (match) {
    return {
      ...base,
      kind: "building_opened",
      buildingId: match[1] ?? "unknown",
      mode: Number(match[2]),
    };
  }

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
  return undefined;
}
