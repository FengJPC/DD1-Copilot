import type {
  BlindestLogRecord,
  CombatLogSnapshot,
} from "../live/combat-log-source.js";
import type { GameState } from "../state/game-state.js";
import { preparationAdvisories } from './preparation-advisories.js';
import type {
  ActionRequest,
  CopilotAction
} from "./types.js";

export const SDLK_ESCAPE = 27;

export const BLD_ELEM_BACK = "0x6261636e";

export const SDLK_TAB = 9;

export const SDLK_RETURN = 13;

export const SDLK_SPACE = 32;

export const SDLK_DELETE = 127;

export const SDLK_a = 97;

export const SDLK_d = 100;

export const SDLK_e = 101;

export const SDLK_i = 105;

export const SDLK_m = 109;

export const SDLK_r = 114;

export const RAID_STACK_LIMITS = new Map<string, number>([
  ["provision\0", 12],
  ["gold\0", 1_750],
  ["gold\0gold", 1_750],
  ["heirloom\0portrait", 3],
  ["heirloom\0bust", 6],
  ["heirloom\0crest", 12],
  ["heirloom\0deed", 6],
  ["heirloom\0urn", 1],
  ["supply\0shovel", 4],
  ["supply\0firewood", 1],
  ["supply\0bandage", 6],
  ["supply\0antivenom", 6],
  ["supply\0skeleton_key", 6],
  ["supply\0medicinal_herbs", 6],
  ["supply\0torch", 8],
  ["supply\0holy_water", 6],
  ["supply\0dog_treats", 2],
  ["supply\0laudanum", 6],
  ["supply\0spice", 6],
  ["gem\0ancient_idol", 1],
  ["gem\0ruby", 5],
  ["gem\0sapphire", 5],
  ["gem\0emerald", 5],
  ["gem\0onyx", 5],
  ["gem\0jade", 5],
  ["gem\0citrine", 5],
  ["gem\0trapezohedron", 1],
  ["gem\0antiqrelicsmall", 20],
  ["gem\0antiqrelic", 5],
  ["gem\0pewrelic", 1],
  ["shard\0", 99],
  ["estate\0the_blood", 6],
  ["estate\0the_cure", 6],
]);

export function lootFitsExistingStack(
  state: GameState,
  loot: NonNullable<GameState["loot"]>["items"][number],
): boolean {
  if (loot.itemType === "trinket") return false;
  const limit = RAID_STACK_LIMITS.get(`${loot.itemType}\0${loot.itemId}`);
  if (limit === undefined) return false;
  const available = state.inventory
    .filter(
      (item) => item.itemType === loot.itemType && item.itemId === loot.itemId,
    )
    .reduce((sum, item) => sum + Math.max(0, limit - item.amount), 0);
  return available >= loot.amount;
}

export const SDLK_t = 116;

export const SDLK_g = 103;

export const SDLK_w = 119;

export const KMOD_LSHIFT = 0x0001;

export const SDLK_HOME = 0x4000004a;

export const SDLK_END = 0x4000004d;

export const SDLK_UP = 0x40000052;

export const SDLK_RIGHT = 0x4000004f;

export const SDLK_DOWN = 0x40000051;

export const SDLK_LEFT = 0x40000050;

export const MAP_EVENT_KINDS = new Set([
  "map_snapshot_started",
  "map_area_observed",
  "map_tile_observed",
  "map_edge_observed",
  "map_position_observed",
  "map_snapshot_completed",
]);

export const MAP_DIRECTIONS = [
  { direction: 0, name: "up", sym: SDLK_UP },
  { direction: 1, name: "down", sym: SDLK_DOWN },
  { direction: 2, name: "left", sym: SDLK_LEFT },
  { direction: 3, name: "right", sym: SDLK_RIGHT },
] as const;

export const CURIO_ONLY_INVENTORY_ITEMS = new Set([
  "skeleton_key",
  "shovel",
  "medicinal_herbs",
]);

export const COMBAT_TURN_ACTIONS = new Set<CopilotAction["kind"]>([
  "use_skill",
  "pass_turn",
  "move_hero",
]);

export const ROOM_PROP_DISPLAY_NAMES = new Map<string, string>([
  ["Sconce", "墙上火把"],
]);

export function roomPropDisplayName(name: string): string {
  return ROOM_PROP_DISPLAY_NAMES.get(name) ?? name;
}

export function actionableRoomProps(state: GameState) {
  return (state.room?.props ?? [])
    .filter(
      (prop) =>
        prop.active &&
        !state.ignoredPropKeys.includes(`${prop.address}\u0000${prop.name}`),
    )
    .map((prop) => ({ ...prop, name: roomPropDisplayName(prop.name) }));
}

export function roomPropDecisionOptions(
  state: GameState,
  props: ReturnType<typeof actionableRoomProps>,
): Array<
  | {
    kind: "approach_room_prop";
    propIndex: number;
    name: string;
    direction: number;
    distance: number;
  }
  | {
    kind: "interact_room_prop";
    propIndex: number;
    name: string;
    heroGuid: number;
    heroIndex?: number;
    heroName?: string;
    disarmChance?: number;
  }
> {
  const party = state.combatants
    .filter((combatant) => combatant.side === "party")
    .sort((left, right) => left.sideIndex - right.sideIndex);
  const options: ReturnType<typeof roomPropDecisionOptions> = [];
  for (const prop of props) {
    if (!prop.reachable) {
      options.push({
        kind: "approach_room_prop" as const,
        propIndex: prop.propIndex,
        name: prop.name,
        direction: prop.direction,
        distance: prop.distance,
      });
      continue;
    }
    if (prop.trap) {
      for (const hero of party) {
        if (hero.heroGuid === undefined) continue;
        options.push({
          kind: "interact_room_prop" as const,
          propIndex: prop.propIndex,
          name: prop.name,
          heroGuid: hero.heroGuid,
          heroName: hero.name,
          disarmChance: hero.trapDisarmChance,
        });
      }
      continue;
    }
    const selectedHero = party.find((hero) => hero.active && hero.heroGuid !== undefined) ??
      party.find((hero) => hero.heroGuid !== undefined);
    if (selectedHero?.heroGuid === undefined) continue;
    options.push({
      kind: "interact_room_prop" as const,
      propIndex: prop.propIndex,
      name: prop.name,
      heroGuid: selectedHero.heroGuid,
      heroName: selectedHero.name,
    });
  }
  return options;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function keyAccepted(sym: number, mod = 0) {
  return (_snapshot: CombatLogSnapshot, observations: BlindestLogRecord[]) =>
    observations.some((record) =>
      new RegExp(
        `^agent-ipc: serviced key sym=0x${sym.toString(16)} mod=0x${mod.toString(16)} accepted=1$`,
        "u",
      ).test(record.message ?? ""),
    )
      ? { outcome: "success" as const, reason: "The game thread accepted the navigation input." }
      : undefined;
}

export function compactRecord(record: BlindestLogRecord): BlindestLogRecord {
  const { raw: _raw, event, ...rest } = record;
  if (event === undefined) return rest as BlindestLogRecord;
  const { raw: _eventRaw, ...compactEvent } = event;
  return { ...rest, event: compactEvent } as BlindestLogRecord;
}

export function actionSignature(request: ActionRequest): string {
  return JSON.stringify({
    expectedRevision: request.expectedRevision,
    action: request.action,
  });
}

export function targetMatches(
  state: GameState,
  target: { side: "party" | "enemy"; slot: number },
): boolean {
  return (
    state.currentTarget?.side === target.side &&
    state.currentTarget.slot === target.slot
  );
}

export function usableRanks(details: string[]): number[] | undefined {
  const text = details.join(" ");
  const match =
    /从第\s*([1-4](?:\s*[,，、或]\s*[1-4])*)\s*位使用/u.exec(text) ??
    /usable from ranks?\s*:?\s*([1-4](?:\s*[,/]\s*[1-4])*)/iu.exec(text);
  if (match?.[1] === undefined) return undefined;
  return [...match[1].matchAll(/[1-4]/gu)].map((entry) => Number(entry[0]));
}

export function skillIsUsableByCurrentActor(
  state: GameState,
  skill: GameState["combatActions"][number],
): boolean {
  const ranks = usableRanks(skill.details);
  if (ranks === undefined) return true;
  const actorAddress = state.currentActor?.address;
  const actor = state.combatants.find(
    (combatant) =>
      combatant.actorAddress === actorAddress ||
      (actorAddress === undefined && combatant.active),
  );
  return actor !== undefined && ranks.includes(actor.slot);
}

export function skillNeedsNoTarget(
  skill: GameState["combatActions"][number],
): boolean {
  const text = skill.details.join(" ");
  return /(?:目标\s*(?:无|所有位置)|无需目标|target\s*:?\s*(?:none|all positions)|no\s+target)/iu.test(text);
}

export function stateAdvisories(state: GameState) {
  const advisories: Array<Record<string, unknown>> = preparationAdvisories(state);
  const light = state.light?.value;
  if (light !== undefined && light < 50 && ['room', 'traveling', 'event', 'loot', 'combat', 'targeting', 'post_combat', 'camp', 'quest'].includes(state.phase)) {
    const torches = state.inventory
      .filter((item) => item.itemId === "torch")
      .reduce((total, item) => total + item.amount, 0);
    advisories.push({
      kind: light < 25 ? "critical_light" : "low_light",
      light,
      torches,
      message:
        light < 25
          ? "Torchlight is critically low; evaluate using a torch before the next risk."
          : "Torchlight is low; account for it before advancing or interacting.",
    });
  }
  return advisories;
}

export function currentDecisionRoomId(state: GameState): string | undefined {
  const map = state.dungeonMap;
  if (map === undefined) return undefined;
  const physicalArea = map.areas.find(
    (area) => area.areaId === map.currentAreaId,
  );
  return physicalArea?.areaKind === 0 ? physicalArea.areaId : undefined;
}

export function currentPhysicalArea(state: GameState) {
  const map = state.dungeonMap;
  return map?.areas.find((area) => area.areaId === map.currentAreaId);
}

export function currentPhysicalTile(state: GameState): number | undefined {
  return currentPhysicalArea(state)?.tiles.find((tile) => tile.current)
    ?.tileIndex;
}

export function secretExitRoutes(state: GameState, secretRoomId: string) {
  const map = state.dungeonMap;
  if (map === undefined || !secretRoomId.startsWith("sec")) return [];
  const corridorIds = new Set(
    map.edges
      .filter((edge) => edge.fromAreaId === secretRoomId)
      .map((edge) => edge.corridorAreaId),
  );
  const routes = map.edges
    .filter(
      (edge) =>
        corridorIds.has(edge.corridorAreaId) &&
        !edge.fromAreaId.startsWith("sec") &&
        !edge.toAreaId.startsWith("sec") &&
        map.areas.some(
          (area) => area.areaId === edge.toAreaId && area.areaKind === 0,
        ),
    )
    .map((edge) => ({
      roomId: edge.toAreaId,
      corridorAreaId: edge.corridorAreaId,
      corridorTiles: edge.corridorTiles,
      endpointDirection: edge.direction,
      secretDirection:
        map.edges.find(
          (candidate) =>
            candidate.fromAreaId === secretRoomId &&
            candidate.corridorAreaId === edge.corridorAreaId,
        )?.direction ?? 0,
    }));
  return routes.filter(
    (route, index) => routes.findIndex((candidate) => candidate.roomId === route.roomId) === index,
  );
}
