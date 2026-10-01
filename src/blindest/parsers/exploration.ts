import type { BlindestEvent, ParsedLogLine } from '../events.js';

export function parseExploration(line: ParsedLogLine): BlindestEvent | undefined {
  const base = { tick: line.tick, raw: line.raw };
  let match: RegExpExecArray | null;
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
