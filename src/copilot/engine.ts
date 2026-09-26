import { actionRequestSchema } from "./action-schema.js";
import { currentActorView, provisionAmount, currentCombatant, inventoryTarget, resolveRequestedTarget, resolveSkill, roomPropHero } from "./identity.js";
import type {
  BlindestLogRecord,
  CombatLogSnapshot,
} from "../live/combat-log-source.js";
import type { CombatState } from "../state/combat-state.js";
import type { GameCommand } from "../command/transport.js";
import { filterCopilotRecords } from "./filter.js";
import type {
  ActionOutcome,
  ActionRecord,
  ActionRequest,
  ActionStepRecord,
  CopilotAction,
  GameGateway,
} from "./types.js";

export interface CopilotEngineOptions {
  settlementTimeoutMilliseconds?: number;
  pollIntervalMilliseconds?: number;
  inspectionTimeoutMilliseconds?: number;
  combatDecisionTimeoutMilliseconds?: number;
  combatActorStabilityMilliseconds?: number;
  actionHistoryLimit?: number;
}

export interface CombatDecisionWaitResult {
  status: "ready" | "combat_ended" | "timeout" | "not_applicable";
  reason: string;
  sourceRevision: number;
  finalRevision: number;
  elapsedMs: number;
  observations: BlindestLogRecord[];
}

interface StepEvaluation {
  outcome: "success" | "failure";
  reason: string;
}

interface StepResult {
  record: ActionStepRecord;
  snapshot: CombatLogSnapshot;
}

interface WorkflowResult {
  outcome: ActionOutcome;
  reason: string;
  snapshot: CombatLogSnapshot;
}

interface PendingCombatTransition {
  actorAddress: string;
  turnTick: number;
  actionRevision: number;
  startedAt: string;
}

const SDLK_ESCAPE = 27;
const BLD_ELEM_BACK = "0x6261636e";
const SDLK_TAB = 9;
const SDLK_RETURN = 13;
const SDLK_SPACE = 32;
const SDLK_DELETE = 127;
const SDLK_a = 97;
const SDLK_d = 100;
const SDLK_e = 101;
const SDLK_i = 105;
const SDLK_m = 109;
const SDLK_r = 114;

// Base raid stack limits from Darkest Dungeon's inventory definitions.  These
// are deliberately conservative: campaign bonuses can raise some limits, but
// using the base value never claims that an item fits when the unmodified game
// would require a new slot.
const RAID_STACK_LIMITS = new Map<string, number>([
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

function lootFitsExistingStack(
  state: CombatState,
  loot: NonNullable<CombatState["loot"]>["items"][number],
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
const SDLK_t = 116;
const SDLK_g = 103;
const SDLK_w = 119;
const KMOD_LSHIFT = 0x0001;
const SDLK_HOME = 0x4000004a;
const SDLK_END = 0x4000004d;
const SDLK_UP = 0x40000052;
const SDLK_RIGHT = 0x4000004f;
const SDLK_DOWN = 0x40000051;
const SDLK_LEFT = 0x40000050;

const MAP_EVENT_KINDS = new Set([
  "map_snapshot_started",
  "map_area_observed",
  "map_tile_observed",
  "map_edge_observed",
  "map_position_observed",
  "map_snapshot_completed",
]);

const MAP_DIRECTIONS = [
  { direction: 0, name: "up", sym: SDLK_UP },
  { direction: 1, name: "down", sym: SDLK_DOWN },
  { direction: 2, name: "left", sym: SDLK_LEFT },
  { direction: 3, name: "right", sym: SDLK_RIGHT },
] as const;

const CURIO_ONLY_INVENTORY_ITEMS = new Set([
  "skeleton_key",
  "shovel",
  "medicinal_herbs",
]);

const COMBAT_TURN_ACTIONS = new Set<CopilotAction["kind"]>([
  "use_skill",
  "pass_turn",
  "move_hero",
]);

const ROOM_PROP_DISPLAY_NAMES = new Map<string, string>([
  ["Sconce", "墙上火把"],
]);

function roomPropDisplayName(name: string): string {
  return ROOM_PROP_DISPLAY_NAMES.get(name) ?? name;
}

function actionableRoomProps(state: CombatState) {
  return (state.room?.props ?? [])
    .filter(
      (prop) =>
        prop.active &&
        !state.ignoredPropKeys.includes(`${prop.address}\u0000${prop.name}`),
    )
    .map((prop) => ({ ...prop, name: roomPropDisplayName(prop.name) }));
}

function roomPropDecisionOptions(
  state: CombatState,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function keyAccepted(sym: number, mod = 0) {
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

function compactRecord(record: BlindestLogRecord): BlindestLogRecord {
  const { raw: _raw, event, ...rest } = record;
  if (event === undefined) return rest as BlindestLogRecord;
  const { raw: _eventRaw, ...compactEvent } = event;
  return { ...rest, event: compactEvent } as BlindestLogRecord;
}

function actionSignature(request: ActionRequest): string {
  return JSON.stringify({
    expectedRevision: request.expectedRevision,
    action: request.action,
  });
}

function targetMatches(
  state: CombatState,
  target: { side: "party" | "enemy"; slot: number },
): boolean {
  return (
    state.currentTarget?.side === target.side &&
    state.currentTarget.slot === target.slot
  );
}



function usableRanks(details: string[]): number[] | undefined {
  const text = details.join(" ");
  const match =
    /从第\s*([1-4](?:\s*[,，、或]\s*[1-4])*)\s*位使用/u.exec(text) ??
    /usable from ranks?\s*:?\s*([1-4](?:\s*[,/]\s*[1-4])*)/iu.exec(text);
  if (match?.[1] === undefined) return undefined;
  return [...match[1].matchAll(/[1-4]/gu)].map((entry) => Number(entry[0]));
}

function skillIsUsableByCurrentActor(
  state: CombatState,
  skill: CombatState["combatActions"][number],
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

function skillNeedsNoTarget(
  skill: CombatState["combatActions"][number],
): boolean {
  const text = skill.details.join(" ");
  return /(?:目标\s*(?:无|所有位置)|无需目标|target\s*:?\s*(?:none|all positions)|no\s+target)/iu.test(text);
}

function stateAdvisories(state: CombatState) {
  const advisories: Array<Record<string, unknown>> = [];
  const light = state.light?.value;
  if (light !== undefined && light < 50) {
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

function currentDecisionRoomId(state: CombatState): string | undefined {
  const map = state.dungeonMap;
  if (map === undefined) return undefined;
  const physicalArea = map.areas.find(
    (area) => area.areaId === map.currentAreaId,
  );
  return physicalArea?.areaKind === 0 ? physicalArea.areaId : undefined;
}

function currentPhysicalArea(state: CombatState) {
  const map = state.dungeonMap;
  return map?.areas.find((area) => area.areaId === map.currentAreaId);
}

function currentPhysicalTile(state: CombatState): number | undefined {
  return currentPhysicalArea(state)?.tiles.find((tile) => tile.current)
    ?.tileIndex;
}

function secretExitRoutes(state: CombatState, secretRoomId: string) {
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

export class CopilotEngine {
  private readonly settlementTimeoutMilliseconds: number;
  private readonly pollIntervalMilliseconds: number;
  private readonly inspectionTimeoutMilliseconds: number;
  private readonly combatDecisionTimeoutMilliseconds: number;
  private readonly combatActorStabilityMilliseconds: number;
  private readonly actionHistoryLimit: number;
  private readonly actions: ActionRecord[] = [];
  private readonly requests = new Map<
    string,
    { signature: string; record: ActionRecord }
  >();
  private readonly inspectionAttempts = new Set<string>();
  private readonly mapInspectionAttempts = new Set<string>();
  private readonly arrivalInspectionAttempts = new Set<string>();
  private readonly contextInspectionAttempts = new Set<string>();
  private pendingCombatTransition?: PendingCombatTransition;
  private observationWork?: Promise<CombatLogSnapshot>;
  private inFlight?: { requestId: string; signature: string; promise: Promise<ActionRecord> };

  constructor(
    private readonly game: GameGateway,
    options: CopilotEngineOptions = {},
  ) {
    this.settlementTimeoutMilliseconds =
      options.settlementTimeoutMilliseconds ?? 6_000;
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 100;
    this.inspectionTimeoutMilliseconds =
      options.inspectionTimeoutMilliseconds ?? 750;
    this.combatDecisionTimeoutMilliseconds =
      options.combatDecisionTimeoutMilliseconds ?? 30_000;
    // DD1 can expose a fully populated action bar for an actor that is still
    // being skipped during round settlement.  A short debounce prevents that
    // transient actor from becoming a model-facing decision.
    this.combatActorStabilityMilliseconds =
      options.combatActorStabilityMilliseconds ?? 450;
    this.actionHistoryLimit = options.actionHistoryLimit ?? 100;
  }

  async getState(
    mode: "compact" | "delta" | "full" = "compact",
    afterRevision = 0,
  ) {
    const snapshot = await this.refreshWithInspection();
    this.reconcilePendingCombatTransition(snapshot.state);
    const decision = this.decision(snapshot.state);
    const advisories = stateAdvisories(snapshot.state);
    const earliestBufferedRevision =
      snapshot.source.earliestBufferedRevision ?? snapshot.revision;
    const requestedRecords = this.game.recordsAfter(
      mode === "compact"
        ? Math.max(0, snapshot.revision - 120)
        : afterRevision,
      // Read the whole retained window before filtering. A noisy loading screen
      // can emit more than 500 raw lines while containing only one meaningful
      // state transition; limiting first would silently drop that transition.
      mode === "full" || mode === "delta" ? 2_000 : 120,
    );
    const filtered = filterCopilotRecords(requestedRecords, {
      // Unknown-line samples are useful while developing parsers, but they are
      // expensive and distracting in the model's normal play loop. Full mode
      // remains the explicit diagnostics escape hatch.
      unclassifiedSampleLimit: mode === "full" ? 20 : 0,
    });

    const compactRecords = filtered.records.map((record) => {
      if (record.event === undefined) return record;
      const { message: _message, ...withoutDuplicateMessage } = record;
      return withoutDuplicateMessage;
    });
    const mapChanged = requestedRecords.some(
      (record) =>
        record.event !== undefined && MAP_EVENT_KINDS.has(record.event.kind),
    );
    const modelRecords = compactRecords.filter(
      (record) =>
        record.event === undefined || !MAP_EVENT_KINDS.has(record.event.kind),
    );
    const mapUpdate =
      mapChanged && snapshot.state.dungeonMap !== undefined
        ? {
            currentAreaId: snapshot.state.dungeonMap.currentAreaId,
            currentRoomId: currentDecisionRoomId(snapshot.state),
            visitedAreaIds: snapshot.state.dungeonMap.areas
              .filter((area) => area.visited)
              .map((area) => area.areaId),
          }
        : undefined;

    if (mode === "full") {
      return {
        revision: snapshot.revision,
        observedAt: snapshot.observedAt,
        afterRevision,
        earliestBufferedRevision,
        truncated: afterRevision + 1 < earliestBufferedRevision,
        state: snapshot.state,
        source: snapshot.source,
        records: requestedRecords,
        filterPreview: filtered,
        advisories,
        decision,
      };
    }
    if (mode === "delta") {
      const truncated = afterRevision + 1 < earliestBufferedRevision;
      return {
        revision: snapshot.revision,
        observedAt: snapshot.observedAt,
        afterRevision,
        earliestBufferedRevision,
        truncated,
        resyncRequired: truncated,
        phase: snapshot.state.phase,
        context: snapshot.state.currentContext,
        changes: modelRecords,
        mapUpdate,
        diagnostics: {
          unclassifiedCount: filtered.unclassified.count,
          suppressedCount: filtered.suppressed.count,
        },
        advisories,
        decision,
      };
    }
    const buildingRelevant =
      snapshot.state.phase === "building" ||
      (snapshot.state.phase === "modal" &&
        snapshot.state.currentBuilding !== undefined);
    const townRelevant = snapshot.state.phase === "town" || buildingRelevant;
    const combatRelevant =
      snapshot.state.phase === "combat" ||
      snapshot.state.phase === "targeting" ||
      snapshot.state.phase === "loot" ||
      snapshot.state.phase === "post_combat";
    return {
      revision: snapshot.revision,
      observedAt: snapshot.observedAt,
      phase: snapshot.state.phase,
      context: snapshot.state.currentContext,
      building: buildingRelevant ? snapshot.state.currentBuilding : undefined,
      decision,
      advisories,
      town: townRelevant
        ? {
            map: snapshot.state.townMap,
            wallet: snapshot.state.townWallet,
            locations: snapshot.state.townLocations,
          }
        : undefined,
      buildingDetails: buildingRelevant ? snapshot.state.buildingDetails : undefined,
      buildingHeroes: buildingRelevant
        ? snapshot.state.buildingHeroes
        : undefined,
      recruitment: buildingRelevant
        ? snapshot.state.recruitment
        : undefined,
      focusedHero: buildingRelevant ? snapshot.state.focusedHero : undefined,
      activeTutorial: snapshot.state.activeTutorial,
      circus: snapshot.state.phase === "circus" ? snapshot.state.circus : undefined,
      circusCombat: snapshot.state.circusCombat?.active === true ? snapshot.state.circusCombat : undefined,
      expedition:
        snapshot.state.phase === "embark" ||
        snapshot.state.phase === "provision" ||
        (snapshot.state.phase === "modal" && snapshot.state.expedition !== undefined)
          ? snapshot.state.expedition
          : undefined,
      partyPlanning:
        snapshot.state.phase === "embark" ||
        snapshot.state.phase === "provision" ||
        (snapshot.state.phase === "modal" && snapshot.state.expedition !== undefined)
          ? snapshot.state.partyPlanning
          : undefined,
      provisioning:
        snapshot.state.phase === "provision" ||
        (snapshot.state.phase === "modal" && snapshot.state.provisioning !== undefined)
          ? {
              gold: snapshot.state.provisioning?.gold,
              shards: snapshot.state.provisioning?.shards,
              bagTotal: snapshot.state.provisioning?.bagTotal,
              bag: (snapshot.state.provisioning?.items ?? []).filter(
                (item) => item.section === 1 && item.amount > 0,
              ),
            }
          : undefined,
      room:
        snapshot.state.phase === "room" ||
        snapshot.state.phase === "traveling" ||
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "loot" ||
        snapshot.state.phase === "post_combat"
          ? snapshot.state.room === undefined
            ? undefined
            : {
                ...snapshot.state.room,
                props: snapshot.state.room.props?.map((prop) => ({
                  ...prop,
                  name: roomPropDisplayName(prop.name),
                })),
              }
          : undefined,
      party:
        snapshot.state.phase === "room" ||
        snapshot.state.phase === "traveling" ||
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "loot" ||
        snapshot.state.phase === "post_combat"
          ? snapshot.state.combatants.filter((combatant) => combatant.side === "party")
          : undefined,
      inventory:
        snapshot.state.phase === "room" ||
        snapshot.state.phase === "traveling" ||
        snapshot.state.phase === "event" ||
        snapshot.state.phase === "loot" ||
        snapshot.state.phase === "post_combat"
          ? {
              capacity: snapshot.state.inventoryInfo,
              items: snapshot.state.inventory,
            }
          : undefined,
      light: snapshot.state.light,
      camp: snapshot.state.camp?.phase ? snapshot.state.camp : undefined,
      quest: snapshot.state.quest,
      results: snapshot.state.results,
      event:
        snapshot.state.eventOverlay?.active === true
          ? snapshot.state.eventOverlay
          : undefined,
      loot:
        snapshot.state.loot?.active === true ? snapshot.state.loot : undefined,
      map:
        snapshot.state.phase === "room" || snapshot.state.phase === "traveling"
          ? snapshot.state.dungeonMap === undefined
            ? undefined
            : {
                ...snapshot.state.dungeonMap,
                currentRoomId: currentDecisionRoomId(snapshot.state),
              }
          : undefined,
      navigation:
        snapshot.state.phase === "traveling"
          ? snapshot.state.navigation
          : undefined,
      combat: combatRelevant
        ? {
            active: snapshot.state.combatActive,
            actor: snapshot.state.combatActive
              ? currentActorView(snapshot.state)
              : undefined,
            party: snapshot.state.combatants.filter(
              (combatant) => combatant.side === "party",
            ),
            enemies: snapshot.state.combatants.filter(
              (combatant) => combatant.side === "enemy",
            ),
            skills: snapshot.state.combatActive
              ? snapshot.state.combatActions.filter(
                  (action) => action.kind === "skill",
                )
              : [],
            selectedSkill: snapshot.state.combatActive
              ? snapshot.state.selectedSkill
              : undefined,
            currentTarget:
              !snapshot.state.combatActive || snapshot.state.currentTarget === undefined
                ? undefined
                : (({ raw: _raw, ...target }) => target)(
                    snapshot.state.currentTarget,
                  ),
            recentResults: snapshot.state.recentResults
              .slice(-8)
              .map(({ raw: _raw, ...result }) => result),
            recentBuffs: snapshot.state.recentBuffs
              .slice(-8)
              .map(({ raw: _raw, ...buff }) => buff),
            inspection: snapshot.state.inspection,
          }
        : undefined,
      recentEvents: modelRecords
        .filter((record) => record.importance === "critical")
        .slice(-6),
      diagnostics: {
        unclassifiedCount: filtered.unclassified.count,
        suppressedCount: filtered.suppressed.count,
      },
    };
  }

  async forceRefresh(
    mode: "compact" | "delta" | "full" = "compact",
    afterRevision = 0,
    includeMap = false,
  ) {
    if (this.observationWork) await this.observationWork;
    if (this.inFlight !== undefined) return this.getState(mode, afterRevision);
    const pending = this.inspectFresh(includeMap);
    this.observationWork = pending;
    try { await pending; } finally { this.observationWork = undefined; }
    return this.getState(mode, afterRevision);
  }

  private async inspectFresh(includeMap: boolean): Promise<CombatLogSnapshot> {
    let snapshot = await this.game.refresh();
    const previousCompletedTick = snapshot.state.inspection?.completedTick;
    const acknowledgement = await this.game.send({ kind: "inspect_state", args: {} });
    if (acknowledgement.status === "queued" || acknowledgement.status === "accepted") {
      const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
      while (Date.now() <= deadline) {
        snapshot = await this.game.refresh();
        if (
          snapshot.state.inspection?.completedTick !== undefined &&
          snapshot.state.inspection.completedTick !== previousCompletedTick
        ) break;
        await delay(this.pollIntervalMilliseconds);
      }
    }
    if (includeMap) {
      const previousMapTick = snapshot.state.dungeonMap?.completedTick;
      const mapAcknowledgement = await this.game.send({ kind: "inspect_map", args: {} });
      if (mapAcknowledgement.status === "queued" || mapAcknowledgement.status === "accepted") {
        const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
        while (Date.now() <= deadline) {
          snapshot = await this.game.refresh();
          if (
            snapshot.state.dungeonMap?.completedTick !== undefined &&
            snapshot.state.dungeonMap.completedTick !== previousMapTick
          ) break;
          await delay(this.pollIntervalMilliseconds);
        }
      }
    }
    return snapshot;
  }

  async act(request: ActionRequest): Promise<ActionRecord> {
    const parsed = actionRequestSchema.safeParse(request);
    if (!parsed.success) return this.validationFailure(request, await this.game.refresh(),
      `Invalid action request: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    request = parsed.data;
    const signature = actionSignature(request);
    const running = this.inFlight;
    if (running !== undefined) {
      if (running.requestId === request.requestId && running.signature === signature) {
        return { ...await running.promise, deduplicated: true };
      }
      return this.validationFailure(request, await this.game.refresh(),
        "Another action is in flight; refresh after it settles. No input was sent.");
    }
    const promise = this.actOnce(request);
    this.inFlight = { requestId: request.requestId, signature, promise };
    try { return await promise; }
    finally { this.inFlight = undefined; }
  }

  private async actOnce(request: ActionRequest): Promise<ActionRecord> {
    if (this.observationWork) await this.observationWork;
    const previous = this.requests.get(request.requestId);
    const signature = actionSignature(request);
    if (previous !== undefined) {
      if (previous.signature === signature) {
        return { ...previous.record, deduplicated: true };
      }
      return this.validationFailure(
        request,
        await this.game.refresh(),
        "requestId was already used for a different action.",
      );
    }

    const before = await this.game.refresh();
    if (!before.source.available) return this.remember(signature,
      this.validationFailure(request, before, "The primary observation source is unavailable; no action was sent."));
    this.reconcilePendingCombatTransition(before.state);
    if (request.expectedRevision !== before.revision) {
      return this.remember(
        signature,
        this.validationFailure(
          request,
          before,
          `Stale action: expected revision ${request.expectedRevision}, current revision is ${before.revision}.`,
        ),
      );
    }

    if (
      this.combatTransitionIsPending(before.state) &&
      COMBAT_TURN_ACTIONS.has(request.action.kind)
    ) {
      return this.remember(
        signature,
        this.validationFailure(
          request,
          before,
          "The previous combat action is still resolving; wait for the actor or turn tick to change.",
        ),
      );
    }

    const invalidReason = this.validateAction(request.action, before.state);
    if (invalidReason !== undefined) {
      return this.remember(
        signature,
        this.validationFailure(request, before, invalidReason),
      );
    }

    const startedAt = new Date().toISOString();
    const steps: ActionStepRecord[] = [];
    let result: {
      outcome: ActionOutcome;
      reason: string;
      snapshot: CombatLogSnapshot;
    };

    try {
    switch (request.action.kind) {
      case "open_town_location":
        result = await this.openTownLocation(request.action, before, steps);
        break;
      case "open_embark":
        result = await this.openEmbark(before, steps);
        break;
      case "select_embark_quest":
        result = await this.selectEmbarkQuest(request.action, before, steps);
        break;
      case "form_embark_party":
        result = await this.formEmbarkParty(request.action, before, steps);
        break;
      case "proceed_to_provision":
        result = await this.proceedToProvision(before, steps);
        break;
      case "buy_provision":
        result = await this.buyProvision(request.action, before, steps);
        break;
      case "start_expedition":
        result = await this.startExpedition(before, steps);
        break;
      case "continue_loading":
        result = await this.continueLoading(before, steps);
        break;
      case "travel_to_room":
        result = await this.travelToRoom(request.action, before, steps);
        break;
      case "advance_corridor":
        result = await this.advanceCorridor(before, steps);
        break;
      case "enter_room":
        result = await this.enterRoom(before, steps);
        break;
      case "return_to_previous_room":
        result = await this.returnToPreviousRoom(before, steps);
        break;
      case "approach_room_prop":
        result = await this.approachRoomProp(request.action, before, steps);
        break;
      case "interact_room_prop":
        result = await this.interactRoomProp(request.action, before, steps);
        break;
      case "choose_event_option":
        result = await this.chooseEventOption(request.action, before, steps);
        break;
      case "use_item_on_event":
        result = await this.useItemOnEvent(request.action, before, steps);
        break;
      case "take_all_loot":
        result = await this.takeAllLoot(before, steps);
        break;
      case "return_to_loot":
        result = await this.returnToLoot(before, steps);
        break;
      case "take_loot_item":
        result = await this.takeLootItem(request.action, before, steps);
        break;
      case "replace_inventory_with_loot":
        result = await this.replaceInventoryWithLoot(request.action, before, steps);
        break;
      case "close_loot":
        result = await this.closeLoot(before, steps);
        break;
      case "move_hero":
        result = await this.moveHero(request.action, before, steps);
        break;
      case "use_inventory_item":
        result = await this.useInventoryItem(request.action, before, steps);
        break;
      case "discard_inventory_item":
        result = await this.discardInventoryItem(request.action, before, steps);
        break;
      case "use_torch":
        result = await this.useTorch(before, steps);
        break;
      case "choose_camp_meal":
        result = await this.chooseCampMeal(request.action, before, steps);
        break;
      case "use_camp_skill":
        result = await this.useCampSkill(request.action, before, steps);
        break;
      case "finish_camp":
        result = await this.finishCamp(before, steps);
        break;
      case "retreat_combat":
      case "abandon_expedition":
      case "finish_quest":
        result = await this.useQuestControl(request.action, before, steps);
        break;
      case "choose_quest_completion":
        result = await this.chooseQuestCompletion(request.action, before, steps);
        break;
      case "continue_results":
        result = await this.continueResults(before, steps);
        break;
      case "recruit_stage_coach_hero":
        result = await this.recruitStageCoachHero(request.action, before, steps);
        break;
      case "select_building_hero":
        result = await this.selectBuildingHero(request.action, before, steps);
        break;
      case "buy_hero_upgrade":
        result = await this.buyHeroUpgrade(request.action, before, steps);
        break;
      case "buy_town_item":
        result = await this.buyTownItem(request.action, before, steps);
        break;
      case "assign_town_activity":
        result = await this.assignTownActivity(request.action, before, steps);
        break;
      case "cancel_town_activity":
        result = await this.cancelTownActivity(request.action, before, steps);
        break;
      case "open_building_upgrades":
        result = await this.openBuildingUpgrades(before, steps);
        break;
      case "buy_building_upgrade":
        result = await this.buyBuildingUpgrade(request.action, before, steps);
        break;
      case "close_building":
        result = await this.closeBuilding(before, steps);
        break;
      case "assign_circus_contestant":
        result = await this.assignCircusContestant(request.action, before, steps);
        break;
      case "activate_circus_hero":
        result = await this.activateCircusHero(request.action, before, steps);
        break;
      case "dismiss_modal":
        result = await this.dismissModal(before, steps);
        break;
      case "cancel_targeting":
        result = await this.cancelTargeting(before, steps);
        break;
      case "pass_turn":
        result = await this.passTurn(before, steps);
        break;
      case "use_skill":
        result = await this.useSkill(request.action, before, steps);
        break;
    }

    } catch (error) {
      // A transport/read error may happen AFTER the game applied input. Cache the
      // uncertain outcome so retrying this request ID cannot execute it twice.
      result = { outcome: "uncertain", snapshot: before,
        reason: `Action interrupted: ${error instanceof Error ? error.message : String(error)}. Reconcile state; do not resend.` };
    }

    const record: ActionRecord = {
      requestId: request.requestId,
      action: request.action,
      ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
      expectedRevision: request.expectedRevision,
      sourceRevision: before.revision,
      finalRevision: result.snapshot.revision,
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: result.outcome,
      stage: result.outcome === "success" ? "settlement" : "workflow",
      reason: result.reason,
      recovery:
        result.outcome === "success"
          ? "Continue from the returned final revision."
          : result.outcome === "failure"
            ? "Refresh state before choosing another action."
            : "Refresh state and reconcile the current screen. Do not resend this request.",
      ...(steps[0] === undefined
        ? {}
        : {
            primitiveCommand: steps[0].primitiveCommand,
            acknowledgement: steps[0].acknowledgement,
          }),
      steps,
      observations: steps.flatMap((step) => step.observations),
    };
    if (
      record.outcome === "success" &&
      (request.action.kind === "use_skill" ||
        request.action.kind === "pass_turn" ||
        request.action.kind === "move_hero") &&
      before.state.currentActor !== undefined
    ) {
      this.pendingCombatTransition = {
        actorAddress: before.state.currentActor.address,
        turnTick: before.state.currentActor.turnTick,
        actionRevision: record.finalRevision,
        startedAt: record.completedAt,
      };
    }
    return this.remember(signature, record);
  }

  private reconcilePendingCombatTransition(state: CombatState): void {
    const pending = this.pendingCombatTransition;
    if (pending === undefined) return;
    const actor = state.currentActor;
    if (
      !state.combatActive ||
      (state.phase !== "combat" && state.phase !== "targeting") ||
      actor === undefined ||
      actor.address !== pending.actorAddress ||
      actor.turnTick !== pending.turnTick
    ) {
      this.pendingCombatTransition = undefined;
    }
  }

  private combatTransitionIsPending(state: CombatState): boolean {
    this.reconcilePendingCombatTransition(state);
    return this.pendingCombatTransition !== undefined;
  }

  async getBriefing(scope: "recent" | "session" = "recent") {
    const snapshot = await this.game.refresh();
    const selected = scope === "session" ? this.actions : this.actions.slice(-10);
    return {
      scope,
      generatedAt: new Date().toISOString(),
      currentRevision: snapshot.revision,
      currentPhase: snapshot.state.phase,
      currentContext: snapshot.state.currentContext,
      currentBuilding: snapshot.state.currentBuilding,
      outcomes: {
        success: selected.filter((record) => record.outcome === "success").length,
        failure: selected.filter((record) => record.outcome === "failure").length,
        uncertain: selected.filter((record) => record.outcome === "uncertain").length,
      },
      actions: selected,
    };
  }

  async waitForNextCombatDecision(
    timeoutMilliseconds = this.combatDecisionTimeoutMilliseconds,
  ): Promise<CombatDecisionWaitResult> {
    const pending = this.pendingCombatTransition;
    const startedAt = Date.now();
    if (pending === undefined) {
      const snapshot = await this.game.refresh();
      return {
        status: "not_applicable",
        reason: "No verified combat action is awaiting a turn transition.",
        sourceRevision: snapshot.revision,
        finalRevision: snapshot.revision,
        elapsedMs: Date.now() - startedAt,
        observations: [],
      };
    }

    const deadline = startedAt + Math.max(0, timeoutMilliseconds);
    let snapshot = await this.game.refresh();
    let readyCandidate:
      | { address: string; turnTick: number; firstSeenAt: number }
      | undefined;
    let nextInspectionAt = startedAt + Math.max(100, this.pollIntervalMilliseconds);
    while (Date.now() <= deadline) {
      snapshot = await this.game.refresh();
      const state = snapshot.state;
      const observations = this.game.recordsAfter(pending.actionRevision, 2_000);
      if (
        !state.combatActive ||
        (state.phase !== "combat" && state.phase !== "targeting")
      ) {
        this.pendingCombatTransition = undefined;
        return {
          status: "combat_ended",
          reason: `Combat left the actionable loop in phase ${state.phase}.`,
          sourceRevision: pending.actionRevision,
          finalRevision: snapshot.revision,
          elapsedMs: Date.now() - startedAt,
          observations,
        };
      }

      const actor = state.currentActor;
      const actorAdvanced =
        state.phase === "combat" &&
        actor !== undefined &&
        actor.turnTick > pending.turnTick;
      if (actorAdvanced && actor !== undefined) {
        if (
          readyCandidate?.address !== actor.address ||
          readyCandidate.turnTick !== actor.turnTick
        ) {
          readyCandidate = {
            address: actor.address,
            turnTick: actor.turnTick,
            firstSeenAt: Date.now(),
          };
        }
        const inspectedActorReady =
          state.inspection?.actorAddress === actor.address &&
          state.combatActions.length > 0;
        if (
          !inspectedActorReady ||
          Date.now() - readyCandidate.firstSeenAt <
            Math.max(
              this.combatActorStabilityMilliseconds,
              this.pollIntervalMilliseconds * 2,
            )
        ) {
          // Actor handoffs can briefly expose a previous action bar. Require a
          // matching structured inspection and a short stable window before
          // returning a model-facing decision.
        } else {
        this.pendingCombatTransition = undefined;
        return {
          status: "ready",
          reason: `The next controllable hero is ${actor.name}.`,
          sourceRevision: pending.actionRevision,
          finalRevision: snapshot.revision,
          elapsedMs: Date.now() - startedAt,
          observations,
        };
        }
      } else {
        readyCandidate = undefined;
      }

      const now = Date.now();
      if (now >= nextInspectionAt && this.inFlight === undefined) {
        await this.game.send({ kind: "inspect_state", args: {} });
        nextInspectionAt = now + Math.max(750, this.inspectionTimeoutMilliseconds);
      }
      await delay(this.pollIntervalMilliseconds);
    }

    return {
      status: "timeout",
      reason:
        "Timed out while waiting for the next controllable hero. The action will not be resent.",
      sourceRevision: pending.actionRevision,
      finalRevision: snapshot.revision,
      elapsedMs: Date.now() - startedAt,
      observations: this.game.recordsAfter(pending.actionRevision, 2_000),
    };
  }

  private async refreshWithInspection(): Promise<CombatLogSnapshot> {
    if (this.inFlight) return this.game.refresh();
    if (this.observationWork) return this.observationWork;
    const pending = this.refreshWithInspectionOnce();
    this.observationWork = pending;
    try { return await pending; } finally { this.observationWork = undefined; }
  }

  private async refreshWithInspectionOnce(): Promise<CombatLogSnapshot> {
    let snapshot = await this.game.refresh();
    if (this.inFlight !== undefined) return snapshot;
    const actor = snapshot.state.currentActor;
    if (
      snapshot.state.combatActive &&
      snapshot.state.phase === "combat" &&
      actor !== undefined &&
      snapshot.state.inspection?.actorAddress !== actor.address
    ) {
      const attemptKey = `${actor.address}:${actor.turnTick}`;
      if (!this.inspectionAttempts.has(attemptKey)) {
        this.inspectionAttempts.add(attemptKey);
        const beforeRevision = snapshot.revision;
        const acknowledgement = await this.game.send({
          kind: "inspect_state",
          args: {},
        });
        if (
          acknowledgement.status === "queued" ||
          acknowledgement.status === "accepted"
        ) {
          const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
          while (Date.now() <= deadline) {
            snapshot = await this.game.refresh();
            if (
              snapshot.revision > beforeRevision &&
              snapshot.state.inspection?.completedTick !== undefined &&
              snapshot.state.inspection.actorAddress === actor.address
            ) {
              break;
            }
            await delay(this.pollIntervalMilliseconds);
          }
        }
      }
    }

    const inspectionTrigger =
      snapshot.state.phase === "embark" && !snapshot.state.partyPlanning?.rosterCandidates.some((hero) => hero.heroGuid !== undefined)
        ? { key: `preparation:${snapshot.state.expedition?.selectedQuestIndex ?? -1}`, tick: snapshot.state.lastTick }
        : snapshot.state.eventOverlay?.active === true
        ? {
            key: `event:${snapshot.state.eventOverlay.openedTick}`,
            tick: snapshot.state.eventOverlay.openedTick,
          }
        : snapshot.state.loot?.active === true
          ? {
              key: `loot:${snapshot.state.loot.openedTick}`,
              tick: snapshot.state.loot.openedTick,
            }
          : !snapshot.state.combatActive &&
              currentPhysicalArea(snapshot.state)?.areaKind === 1
            ? {
                key: `corridor-state:${currentPhysicalArea(snapshot.state)?.areaId}:${currentPhysicalTile(snapshot.state) ?? -1}`,
                tick:
                  snapshot.state.dungeonMap?.positionTick ??
                  snapshot.state.lastTick,
              }
          : snapshot.state.phase === "room" &&
              !snapshot.state.combatActive &&
              (snapshot.state.room?.propCount ?? 0) > 0
            ? {
                key: `room-state:${snapshot.state.room?.observedTick ?? snapshot.revision}`,
                tick: snapshot.state.room?.observedTick ?? snapshot.state.lastTick,
              }
            : snapshot.state.currentContext === "meal" ||
                snapshot.state.currentContext === "camptarget"
              ? {
                  key: `camp:${snapshot.state.currentContext}:${snapshot.state.camp?.phase ?? -1}:${snapshot.state.camp?.points ?? -1}`,
                  tick: snapshot.state.lastTick,
                }
              : snapshot.state.currentContext === "quest" ||
                  snapshot.state.currentContext === "questdone" ||
                  snapshot.state.currentContext === "raidfinish"
                ? {
                    key: `quest:${snapshot.state.currentContext}:${snapshot.state.quest?.button ?? "unknown"}`,
                    tick: snapshot.state.lastTick,
                  }
                : snapshot.state.currentContext === "results"
                  ? {
                      key: `results:${snapshot.state.results?.state ?? -1}`,
                      tick: snapshot.state.lastTick,
                    }
            : undefined;
    if (
      inspectionTrigger !== undefined &&
      (snapshot.state.inspection?.completedTick ?? -1) < inspectionTrigger.tick &&
      !this.contextInspectionAttempts.has(inspectionTrigger.key)
    ) {
      this.contextInspectionAttempts.add(inspectionTrigger.key);
      const beforeRevision = snapshot.revision;
      const previousCompletedTick = snapshot.state.inspection?.completedTick;
      const acknowledgement = await this.game.send({
        kind: "inspect_state",
        args: {},
      });
      if (
        acknowledgement.status === "queued" ||
        acknowledgement.status === "accepted"
      ) {
        const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
        while (Date.now() <= deadline) {
          snapshot = await this.game.refresh();
          if (
            snapshot.revision > beforeRevision &&
            snapshot.state.inspection?.completedTick !== undefined &&
            snapshot.state.inspection.completedTick !== previousCompletedTick
          ) {
            break;
          }
          await delay(this.pollIntervalMilliseconds);
        }
      }
    }

    const roomObservationTick = snapshot.state.room?.observedTick;
    const mapCompletedTick = snapshot.state.dungeonMap?.completedTick;
    const mapNeedsRefresh =
      snapshot.state.phase === "room" &&
      !snapshot.state.combatActive &&
      (mapCompletedTick === undefined ||
        (roomObservationTick !== undefined && mapCompletedTick < roomObservationTick));
    if (mapNeedsRefresh) {
      const attemptKey = `room:${roomObservationTick ?? snapshot.revision}`;
      if (!this.mapInspectionAttempts.has(attemptKey)) {
        this.mapInspectionAttempts.add(attemptKey);
        const beforeRevision = snapshot.revision;
        const previousCompletedTick = snapshot.state.dungeonMap?.completedTick;
        const acknowledgement = await this.game.send({ kind: "inspect_map", args: {} });
        if (
          acknowledgement.status === "queued" ||
          acknowledgement.status === "accepted"
        ) {
          const deadline = Date.now() + this.inspectionTimeoutMilliseconds;
          while (Date.now() <= deadline) {
            snapshot = await this.game.refresh();
            if (
              snapshot.revision > beforeRevision &&
              snapshot.state.dungeonMap?.completedTick !== undefined &&
              snapshot.state.dungeonMap.completedTick !== previousCompletedTick
            ) {
              break;
            }
            await delay(this.pollIntervalMilliseconds);
          }
        }
      }
    }

    const navigation = snapshot.state.navigation;
    const map = snapshot.state.dungeonMap;
    if (
      !snapshot.state.combatActive &&
      navigation !== undefined &&
      map?.currentAreaId === navigation.toArea &&
      map.positionTick !== undefined &&
      (snapshot.state.room?.observedTick ?? -1) < map.positionTick
    ) {
      const attemptKey = `${navigation.toArea}:${map.positionTick}`;
      if (!this.arrivalInspectionAttempts.has(attemptKey)) {
        this.arrivalInspectionAttempts.add(attemptKey);
        const beforeRevision = snapshot.revision;
        const previousRoomTick = snapshot.state.room?.observedTick;
        const acknowledgement = await this.game.send({
          kind: "key_press",
          args: { sym: SDLK_d, mod: KMOD_LSHIFT },
        });
        if (
          acknowledgement.status === "queued" ||
          acknowledgement.status === "accepted"
        ) {
          const deadline = Date.now() + this.settlementTimeoutMilliseconds;
          while (Date.now() <= deadline) {
            snapshot = await this.game.refresh();
            if (
              snapshot.state.combatActive ||
              snapshot.state.phase === "event" ||
              snapshot.state.phase === "modal" ||
              snapshot.state.phase === "loot" ||
              (snapshot.revision > beforeRevision &&
                snapshot.state.room?.observedTick !== undefined &&
                snapshot.state.room.observedTick !== previousRoomTick) ||
              this.game.recordsAfter(beforeRevision, 2_000).some((record) =>
                /^(?:resting point: landing in the dungeon view|roomview enter:|tilestep: stop - prop\b|tilestep: no further movement .*\bmoved=1\b)/u.test(
                  record.message ?? "",
                ),
              )
            ) {
              break;
            }
            await delay(this.pollIntervalMilliseconds);
          }
        }
        if (
          !snapshot.state.combatActive &&
          snapshot.state.phase !== "event" &&
          snapshot.state.phase !== "modal" &&
          snapshot.state.phase !== "loot" &&
          snapshot.state.room?.observedTick === previousRoomTick
        ) {
          const observeRevision = snapshot.revision;
          const observe = await this.game.send({
            kind: "key_press",
            args: { sym: SDLK_r, mod: 0 },
          });
          if (observe.status === "queued" || observe.status === "accepted") {
            const deadline = Date.now() + this.settlementTimeoutMilliseconds;
            while (Date.now() <= deadline) {
              snapshot = await this.game.refresh();
              if (
                snapshot.revision > observeRevision &&
                snapshot.state.room?.observedTick !== undefined &&
                snapshot.state.room.observedTick !== previousRoomTick
              ) {
                break;
              }
              await delay(this.pollIntervalMilliseconds);
            }
          }
        }
      }
    }
    return snapshot;
  }

  private decision(state: CombatState) {
    if (
      state.phase === "modal" ||
      state.currentContext === "tutorial" ||
      state.activeTutorial !== undefined
    ) {
      return {
        kind: "modal",
        prompt: state.activeTutorial?.text ?? "A modal is blocking input.",
        options: [{ kind: "dismiss_modal" as const }],
      };
    }
    if (
      state.combatActive &&
      (state.phase === "combat" || state.phase === "targeting") &&
      this.combatTransitionIsPending(state)
    ) {
      return {
        kind: "combat_resolving",
        prompt:
          "The previous combat action has produced semantic evidence, but the turn has not advanced yet. Wait for the actor or turn tick to change before issuing another action.",
        actor: currentActorView(state),
        pending: this.pendingCombatTransition,
        options: [],
      };
    }
    if (state.phase === "targeting" || state.currentContext === "itemuse") {
      const inventoryItemTargeting = state.currentContext === "itemuse";
      return {
        kind: "targeting_recovery",
        prompt: inventoryItemTargeting
          ? "An inventory item target selector is already open. Cancel it before issuing another action."
          : "A target selector is already open. Reconcile it before issuing a new combat action.",
        selectedSkill: state.selectedSkill,
        currentTarget:
          state.currentTarget === undefined
            ? undefined
            : (({ raw: _raw, ...target }) => target)(state.currentTarget),
        options: [{ kind: "cancel_targeting" as const }],
      };
    }
    if (state.phase === "loading") {
      return {
        kind: "loading",
        prompt: "The expedition loading screen is ready to continue.",
        options: [{ kind: "continue_loading" as const }],
      };
    }
    if (state.currentContext === "results" || state.phase === "results") {
      return {
        kind: "results",
        prompt: "Advance the expedition results one page at a time.",
        results: state.results,
        options: [{ kind: "continue_results" as const }],
      };
    }
    if (state.currentContext === "questdone") {
      return {
        kind: "quest_completion",
        prompt: "Choose whether to return to the Hamlet or continue exploring.",
        options: [
          { kind: "choose_quest_completion" as const, destination: "hamlet" as const },
          { kind: "choose_quest_completion" as const, destination: "continue" as const },
        ],
      };
    }
    if (state.currentContext === "meal") {
      return {
        kind: "camp_meal",
        prompt: "Choose the camping meal after comparing food cost and effects.",
        camp: state.camp,
        options: (state.camp?.meals ?? []).map((meal) => ({
          kind: "choose_camp_meal" as const,
          ...meal,
        })),
      };
    }
    if (state.phase === "camp") {
      return {
        kind: "camp",
        prompt: "Choose a camping skill and optional target, or finish the respite.",
        camp: state.camp,
        skills: state.combatActions.filter((action) => action.kind === "skill"),
        party: state.combatants.filter((actor) => actor.side === "party"),
        options: [
          ...state.combatActions
            .filter((action) => action.kind === "skill")
            .map((action) => ({
              kind: "use_camp_skill" as const,
              skillSlot: action.skillSlot,
              name: action.name,
              details: action.details,
              targetHeroGuid: "omit for self or party skills; choose a party hero GUID for individual skills",
            })),
          ...(state.combatActions.some((action) => action.kind === "rest")
            ? [{ kind: "finish_camp" as const }]
            : []),
        ],
      };
    }
    if (state.loot?.active === true) {
      if (state.currentContext === "inventory") {
        return {
          kind: "loot",
          prompt: "The inventory is covering an open loot window. Return to loot before choosing an item.",
          token: state.loot.token,
          itemCount: state.loot.itemCount,
          items: state.loot.items,
          options: [{ kind: "return_to_loot" as const }],
        };
      }
      return {
        kind: "loot",
        prompt: "Choose whether to take all loot, take one item, or close the loot window.",
        token: state.loot.token,
        itemCount: state.loot.itemCount,
        items: state.loot.items,
        options: [
          { kind: "take_all_loot" as const },
          ...state.loot.items.map((item) => ({
            kind: "take_loot_item" as const,
            itemIndex: item.itemIndex,
            name: item.name,
            amount: item.amount,
          })),
          ...(state.inventoryInfo?.occupiedCount === state.inventoryInfo?.slotCount
            ? state.loot.items
              .filter((item) => !lootFitsExistingStack(state, item))
              .map((item) => ({
                kind: "replace_inventory_with_loot" as const,
                itemIndex: item.itemIndex,
                name: item.name,
                inventorySlot: "choose one occupied inventory slot to discard",
              }))
            : []),
          { kind: "close_loot" as const },
        ],
      };
    }
    if (state.eventOverlay?.active === true) {
      const compatibleItems = state.inventory.filter((item) =>
        state.eventOverlay?.compatibleInventorySlots.includes(item.slot),
      );
      const eventOptions: Array<
        | {
            kind: "choose_event_option";
            optionIndex: number;
            name: string;
            description: string;
          }
        | {
            kind: "use_item_on_event";
            optionIndex: number;
            inventorySlot: number;
            optionName: string;
            itemName: string;
            amount: number;
          }
      > = [];
      for (const option of state.eventOverlay.options) {
        if (!option.enabled) continue;
        if (!option.itemSlot) {
          eventOptions.push({
            kind: "choose_event_option",
            optionIndex: option.optionIndex,
            name: option.name,
            description: option.description,
          });
          continue;
        }
        for (const item of compatibleItems) {
          eventOptions.push({
            kind: "use_item_on_event",
            optionIndex: option.optionIndex,
            inventorySlot: item.slot,
            optionName: option.name,
            itemName: item.name,
            amount: item.amount,
          });
        }
      }
      return {
        kind: "event",
        prompt: "Choose one event option. Item use is only offered for supplies verified by the game as compatible.",
        title: state.eventOverlay.title,
        flavour: state.eventOverlay.flavour,
        pickingItem: state.eventOverlay.pickingItem,
        options: eventOptions,
      };
    }
    const physicalArea = currentPhysicalArea(state);
    if (!state.combatActive && physicalArea?.areaKind === 1) {
      const currentTile = currentPhysicalTile(state);
      const endpointRoomIds = [
        ...new Set(
          (state.dungeonMap?.edges ?? [])
            .filter((edge) => edge.corridorAreaId === physicalArea.areaId)
            .flatMap((edge) => [edge.fromAreaId, edge.toAreaId]),
        ),
      ];
      const observedDoorIds = state.room?.doorDestinations ?? [];
      const destinationRoomId =
        state.navigation?.viaArea === physicalArea.areaId
          ? state.navigation.toArea
          : endpointRoomIds.find((roomId) => !observedDoorIds.includes(roomId));
      const atForwardDoor =
        currentTile !== undefined && currentTile >= physicalArea.tileCount - 1;
      const atSecretDoor = physicalArea.tiles.some(
        (tile) => tile.current && tile.content === 13,
      );
      const canEnterSecretRoom =
        atSecretDoor && !state.navigation?.fromArea.startsWith("sec");
      const activeProps = actionableRoomProps(state);
      return {
        kind: "corridor",
        prompt:
          activeProps.length > 0
            ? activeProps.some((prop) => prop.trap)
              ? "A scouted trap is ahead. Choose its interact action to attempt disarming it before moving."
              : "Resolve the detected corridor interactable before continuing."
            : canEnterSecretRoom
              ? "A discovered secret door is at the party's position. Enter the secret room."
            : atForwardDoor
              ? "The party has reached the forward door. Enter the destination room."
              : "Advance through the corridor until combat, an event, an interactable, a trap, or the forward door interrupts movement.",
        currentAreaId: physicalArea.areaId,
        currentTile,
        tileCount: physicalArea.tileCount,
        destinationRoomId,
        navigation: state.navigation,
        props: activeProps,
        options:
          activeProps.length > 0
            ? roomPropDecisionOptions(state, activeProps)
            : [
                ...(currentTile === 0 && state.navigation !== undefined
                  ? [{ kind: "return_to_previous_room" as const }]
                  : []),
                atForwardDoor || canEnterSecretRoom
                  ? ({ kind: "enter_room" as const })
                  : ({ kind: "advance_corridor" as const }),
              ],
      };
    }
    if (state.phase === "traveling") {
      return {
        kind: "traveling",
        prompt: "The party is moving to the selected room; wait for room reconciliation.",
        navigation: state.navigation,
        options: [],
      };
    }
    if (state.phase === "room" && !state.combatActive) {
      const map = state.dungeonMap;
      const currentAreaId = map?.currentAreaId;
      const currentRoomId = currentDecisionRoomId(state);
      const routeOptions =
        map === undefined || currentRoomId === undefined
          ? []
          : currentRoomId.startsWith("sec")
            ? secretExitRoutes(state, currentRoomId).map((route) => {
                const destination = map.areas.find(
                  (area) => area.areaId === route.roomId,
                );
                return {
                  kind: "travel_to_room" as const,
                  roomId: route.roomId,
                  direction:
                    MAP_DIRECTIONS.find(
                      (candidate) => candidate.direction === route.endpointDirection,
                    )?.name ?? `direction_${route.endpointDirection}`,
                  corridorAreaId: route.corridorAreaId,
                  corridorTiles: route.corridorTiles,
                  visited: destination?.visited ?? false,
                  knownContents: (destination?.tiles ?? [])
                    .filter((tile) => tile.visible)
                    .map((tile) => tile.content),
                };
              })
          : map.edges
              .filter((edge) => edge.fromAreaId === currentRoomId)
              .map((edge) => {
                const destination = map.areas.find(
                  (area) => area.areaId === edge.toAreaId,
                );
                return {
                  kind: "travel_to_room" as const,
                  roomId: edge.toAreaId,
                  direction:
                    MAP_DIRECTIONS.find(
                      (candidate) => candidate.direction === edge.direction,
                    )?.name ?? `direction_${edge.direction}`,
                  corridorAreaId: edge.corridorAreaId,
                  corridorTiles: edge.corridorTiles,
                  visited: destination?.visited ?? false,
                  knownContents: (destination?.tiles ?? [])
                    .filter((tile) => tile.visible)
                    .map((tile) => tile.content),
                };
              });
      const activeProps = actionableRoomProps(state);
      return {
        kind: "room",
        prompt:
          activeProps.length > 0
            ? "Resolve the room interactable before choosing another route."
            : map === undefined
            ? "The room is clear, but a map snapshot is not available yet."
            : currentRoomId === undefined
              ? "The physical map position is between rooms and the current decision room could not be resolved. Reconcile before moving."
              : "Choose an adjacent destination room. Route choice belongs to the model.",
        room: state.room,
        currentAreaId,
        currentRoomId,
        props: activeProps,
        options:
          activeProps.length > 0
            ? roomPropDecisionOptions(state, activeProps)
            : routeOptions,
      };
    }
    if (state.combatActive && state.phase === "combat") {
      const usableSkills = state.combatActions.filter(
        (action) =>
          action.kind === "skill" &&
          skillIsUsableByCurrentActor(state, action),
      );
      const targets = state.combatants.map((combatant) => ({
        targetGuid: combatant.actorGuid,
        side: combatant.side,
        slot: combatant.slot,
        slotEnd: combatant.slotEnd,
        name: combatant.name,
        currentHp: combatant.currentHp,
        maxHp: combatant.maxHp,
        stress: combatant.stress,
        conditions: combatant.conditions,
        details: combatant.details,
        resists: combatant.resists,
      }));
      return {
        kind: "combat_turn",
        prompt:
          state.circusCombat?.active === true
            ? "Choose an arena skill and, when required, its intended target; health and stress are both tactical win conditions."
            : "Choose a skill and, when it requires one, its intended target; the Copilot will complete targeting and confirmation.",
        actor: currentActorView(state),
        skills: usableSkills
          .map((action) => ({
            skillSlot: action.skillSlot,
            skillElementId: action.elementId,
            name: action.name,
            details: action.details,
          })),
        targets,
        options: [
          ...usableSkills
            .map((action) => ({
              kind: "use_skill" as const,
              actorGuid: currentCombatant(state)?.actorGuid,
              skillElementId: action.elementId,
              skillSlot: action.skillSlot,
              name: action.name,
              target: skillNeedsNoTarget(action)
                ? "omit; this skill reports no target"
                : "choose one entry from decision.targets",
            })),
          ...state.combatActions
            .filter((action) => action.kind === "pass")
            .map(() => ({ kind: "pass_turn" as const })),
          ...state.combatActions
            .filter((action) => action.kind === "reorder")
            .map(() => ({ kind: "move_hero" as const, toSlot: "choose rank 1 through 4" })),
          ...(state.circusCombat?.active === true ? [] : [{ kind: "retreat_combat" as const }]),
        ],
      };
    }
    if (state.phase === "town") {
      return {
        kind: "town",
        prompt: "Choose an unlocked town location.",
        wallet: state.townWallet,
        locations: state.townLocations.map(({ id, name, unlocked, screen, district, offSave, isNew }) =>
          ({ id, name, unlocked, screen, district, offSave, isNew })),
        options: [
          ...state.townLocations
            .filter((location) => location.unlocked && location.screen)
            .map((location) => ({
              kind: "open_town_location" as const,
              locationId: location.id,
              name: location.name,
            })),
          { kind: "open_embark" as const, name: "远征" },
        ],
      };
    }
    if (state.phase === "embark") {
      return {
        kind: "embark_planning",
        prompt: "Choose a quest before forming the expedition party.",
        selectedQuestIndex: state.expedition?.selectedQuestIndex,
        roster: state.partyPlanning?.rosterCandidates.map(({ heroGuid, name, state, missing, building, heroClass, level,
          healthText, stressText, weaponLevel, armourLevel, quirks, diseases }) =>
          ({ heroGuid, name, state, missing, building, heroClass, level, healthText, stressText,
            weaponLevel, armourLevel, quirks, diseases })),
        party: state.partyPlanning?.slots.map(({ position, heroGuid, name }) => ({ position, heroGuid, name })),
        locations: state.expedition?.locations ?? [],
        options: [
          ...(state.expedition?.quests ?? [])
            .filter((quest) => quest.onScreen)
            .map((quest) => ({
              kind: "select_embark_quest" as const,
              questIndex: quest.questIndex,
              questId: quest.questId,
              dungeonId: quest.dungeonId,
              length: quest.length,
              difficulty: quest.difficulty,
              details: quest.details,
              selected:
                quest.questIndex === state.expedition?.selectedQuestIndex,
            })),
          ...((state.expedition?.selectedQuestIndex ?? -1) < 0
            ? []
            : [
                {
                  kind: "form_embark_party" as const,
                  frontToBack: [
                    "choose rank 1 heroGuid",
                    "choose rank 2 heroGuid",
                    "choose rank 3 heroGuid",
                    "choose rank 4 heroGuid",
                  ],
                },
              ]),
          ...(state.partyPlanning?.filledCount === 4
            ? [{ kind: "proceed_to_provision" as const }]
            : []),
        ],
      };
    }
    if (state.phase === "provision") {
      return {
        kind: "provision",
        prompt: "Choose supplies for the selected expedition.",
        wallet: {
          gold: state.provisioning?.gold,
          shards: state.provisioning?.shards,
        },
        bagTotal: state.provisioning?.bagTotal,
        bag: (state.provisioning?.items ?? []).filter(
          (item) => item.section === 1 && item.amount > 0,
        ),
        options: [
          ...(state.provisioning?.items ?? [])
            .filter((item) => item.section === 0 && item.amount > 0)
            .map((item) => ({
              kind: "buy_provision" as const,
              itemKey: item.itemKey,
              available: item.amount,
              goldPrice: item.goldPrice,
              shardPrice: item.shardPrice,
              quantity: "choose an integer quantity",
            })),
          { kind: "start_expedition" as const },
        ],
      };
    }
    if (state.phase === "circus") {
      const circus = state.circus;
      return {
        kind: "circus_lineup",
        prompt: "Choose an arena contestant by stable hero address and destination rank.",
        contestants: circus?.contestants ?? [],
        slots: circus?.slots ?? [],
        options: (circus?.contestants ?? [])
          .filter((contestant) => !contestant.dlcLocked)
          .flatMap((contestant) => Array.from({ length: circus?.slotCount ?? 4 }, (_, slot) => ({
            kind: "assign_circus_contestant" as const,
            heroAddress: contestant.heroAddress,
            name: contestant.name,
            heroClass: contestant.heroClass,
            rank: (circus?.slotCount ?? 4) - slot,
          }))),
      };
    }
    if (state.circusCombat?.active === true && state.circusCombat.pickOpen) {
      return {
        kind: "circus_actor_selection",
        prompt: "Choose which eligible arena hero acts next. The Copilot will activate that hero through the game's internal battle interface.",
        battleState: state.circusCombat.battleState,
        party: state.combatants.filter((actor) => actor.side === "party"),
        enemies: state.combatants.filter((actor) => actor.side === "enemy"),
        options: state.circusCombat.heroes
          .filter((hero) => hero.canActivate && hero.actorGuid > 0)
          .map((hero) => ({ kind: "activate_circus_hero" as const, actorGuid: hero.actorGuid, name: hero.name })),
      };
    }
    if (
      state.phase === "building" &&
      state.currentBuilding === "stage_coach"
    ) {
      return {
        kind: "stage_coach",
        prompt: "Choose one available hero to recruit.",
        roster: state.recruitment,
        options: [
          ...state.buildingHeroes.map((hero) => ({
            kind: "recruit_stage_coach_hero" as const,
            heroAddress: hero.heroAddress,
            name: hero.name,
          })),
          { kind: "close_building" as const },
        ],
      };
    }
    if (state.phase === "building") {
      const details = state.buildingDetails;
      const buildingRoster = (details?.heroes.length ?? 0) > 0
        ? details!.heroes
        : (state.partyPlanning?.rosterCandidates ?? [])
            .filter((hero) => !hero.missing && [0, 1].includes(hero.state) && !hero.building)
            .map((hero, row) => ({ row, heroGuid: hero.heroGuid, name: hero.name }));
      return {
        kind: "building",
        prompt: "Choose a verified building action by stable hero, option, item, or activity identity.",
        building: state.currentBuilding,
        wallet: state.townWallet,
        details,
        options: [
          ...(details?.heroes ?? []).map((hero) => ({
            kind: "select_building_hero" as const, heroGuid: hero.heroGuid, name: hero.name,
          })),
          ...(details?.heroOptions ?? []).flatMap((option) =>
            option.stepDetails
              .filter((step, index) => !step.purchased && index === option.next)
              .map((step) => ({
                kind: "buy_hero_upgrade" as const,
                heroGuid: details?.selectedHeroGuid,
                optionId: option.optionId,
                stepCode: step.code,
                name: option.name,
                cost: step.cost,
                currency: step.currency,
              }))),
          ...(details?.shopItems ?? []).map((item) => ({
            kind: "buy_town_item" as const, itemId: item.itemId, name: item.name,
            price: item.priceKnown ? item.price : undefined,
          })),
          ...(details?.activities ?? []).flatMap<Record<string, unknown>>((activity) => {
            if (activity.committedHeroGuid !== undefined || activity.pendingHeroGuid !== undefined) {
              return [{ kind: "cancel_town_activity" as const,
                activityId: activity.activityId, slot: activity.slot }];
            }
            if (activity.occupant >= 0 || activity.locked || activity.eventLocked) return [];
            return buildingRoster.map((hero) => ({
              kind: "assign_town_activity" as const, activityId: activity.activityId,
              slot: activity.slot, heroGuid: hero.heroGuid, heroName: hero.name,
            }));
          }),
          ...(details?.mode === 0 ? [{ kind: "open_building_upgrades" as const }] : []),
          ...(details?.upgrades ?? []).flatMap((upgrade) =>
            upgrade.next >= 0 ? [{
              kind: "buy_building_upgrade" as const,
              trackId: upgrade.trackId,
              stepCode: String.fromCharCode(97 + upgrade.next),
              name: upgrade.name,
            }] : []),
          { kind: "close_building" as const },
        ],
      };
    }
    return {
      kind: "observe",
      prompt: "No verified semantic action is exposed for the current screen yet.",
      options: [],
    };
  }

  private validateAction(
    action: CopilotAction,
    state: CombatState,
  ): string | undefined {
    if (["use_inventory_item", "use_torch", "discard_inventory_item"].includes(action.kind) &&
        (state.loot?.active === true || state.currentContext === "itemuse" ||
         !["room", "traveling", "camp", "combat", "post_combat"].includes(state.phase))) {
      return "Resolve the current overlay/targeting before operating the raid inventory.";
    }
    switch (action.kind) {
      case "open_town_location": {
        if (state.phase !== "town") {
          return "A town location can only be opened from the town map.";
        }
        const location = state.townLocations.find(
          (candidate) => candidate.id === action.locationId,
        );
        if (location === undefined) {
          return `Unknown town location: ${action.locationId}.`;
        }
        if (!location.unlocked || !location.screen) {
          return `Town location ${action.locationId} is not currently selectable.`;
        }
        return undefined;
      }
      case "open_embark":
        return state.phase === "town"
          ? undefined
          : "Embark can only be opened from the town map.";
      case "select_embark_quest": {
        if (state.phase !== "embark") {
          return "A quest can only be selected from expedition planning.";
        }
        const quests = state.expedition?.quests.filter((candidate) =>
          action.questIndex !== undefined
            ? candidate.questIndex === action.questIndex
            : candidate.questId === action.questId) ?? [];
        if (quests.length !== 1) {
          return quests.length === 0
            ? `Unknown embark quest: ${action.questIndex ?? action.questId ?? "missing selector"}.`
            : `Embark quest ID ${action.questId} is ambiguous; use questIndex.`;
        }
        const quest = quests[0]!;
        return quest.onScreen
          ? undefined
          : `Embark quest ${quest.questIndex} is not currently selectable.`;
      }
      case "form_embark_party":
        if (state.phase !== "embark") {
          return "A party can only be formed from expedition planning.";
        }
        if ((state.expedition?.selectedQuestIndex ?? -1) < 0) {
          return "Select an embark quest before forming the party.";
        }
        if (
          action.frontToBack.length !== 4 ||
          new Set(action.frontToBack).size !== 4
        ) {
          return "frontToBack must contain four distinct roster hero GUIDs.";
        }
        for (const guid of action.frontToBack) {
          const heroes = state.partyPlanning?.rosterCandidates.filter((hero) => hero.heroGuid === guid) ?? [];
          if (heroes.length !== 1 || heroes[0]!.missing || ![0, 1].includes(heroes[0]!.state)) {
            return `Roster GUID ${guid} is missing, ambiguous, or unavailable. Refresh the preparation roster.`;
          }
        }
        return undefined;
      case "proceed_to_provision":
        if (state.phase !== "embark") {
          return "Provisioning can only be opened from expedition planning.";
        }
        return state.partyPlanning?.filledCount === 4
          ? undefined
          : "A full four-hero party is required before provisioning.";
      case "buy_provision": {
        if (state.phase !== "provision") {
          return "Supplies can only be bought from provisioning.";
        }
        const item = state.provisioning?.items.find(
          (candidate) =>
            candidate.section === 0 && candidate.itemKey === action.itemKey,
        );
        if (item === undefined || item.amount < 1) {
          return `Provision ${action.itemKey} is not currently available.`;
        }
        return Number.isInteger(action.quantity) &&
          action.quantity >= 1 &&
          action.quantity <= Math.min(32, item.amount)
          ? undefined
          : `Quantity for ${action.itemKey} must be between 1 and ${Math.min(32, item.amount)}.`;
      }
      case "start_expedition":
        return state.phase === "provision"
          ? undefined
          : "An expedition can only start from provisioning.";
      case "continue_loading":
        return state.phase === "loading"
          ? undefined
          : "No loading screen is waiting for input.";
      case "travel_to_room": {
        if (state.phase !== "room" || state.combatActive) {
          return "Travel can only start from a dungeon room outside combat.";
        }
        const map = state.dungeonMap;
        const currentRoomId = currentDecisionRoomId(state);
        if (map?.completedTick === undefined || currentRoomId === undefined) {
          return "A completed map snapshot is required before choosing a route.";
        }
        if (actionableRoomProps(state).length > 0) {
          return "Resolve the active room interactable before choosing a route.";
        }
        const destination = map.areas.find(
          (area) => area.areaId === action.roomId && area.areaKind === 0,
        );
        if (destination === undefined) {
          return `Room ${action.roomId} is not present in the current map snapshot.`;
        }
        const routeExists = currentRoomId.startsWith("sec")
          ? secretExitRoutes(state, currentRoomId).some(
              (route) => route.roomId === action.roomId,
            )
          : map.edges.some(
              (edge) =>
                edge.fromAreaId === currentRoomId && edge.toAreaId === action.roomId,
            );
        return routeExists
          ? undefined
          : `Room ${action.roomId} is not adjacent to ${currentRoomId}.`;
      }
      case "advance_corridor": {
        if (state.combatActive) {
          return "Corridor movement is unavailable during combat.";
        }
        const area = currentPhysicalArea(state);
        const tile = currentPhysicalTile(state);
        if (area?.areaKind !== 1 || tile === undefined) {
          return "A verified corridor position is required before advancing.";
        }
        if (actionableRoomProps(state).length > 0) {
          return "Resolve the active corridor interactable before advancing.";
        }
        return tile < area.tileCount - 1
          ? undefined
          : "The party is already at the forward door.";
      }
      case "enter_room": {
        if (state.combatActive) {
          return "A room cannot be entered during combat.";
        }
        const area = currentPhysicalArea(state);
        const tile = currentPhysicalTile(state);
        if (area?.areaKind !== 1 || tile === undefined) {
          return "A verified corridor position is required before entering a room.";
        }
        if (actionableRoomProps(state).length > 0) {
          return "Resolve the active corridor interactable before entering a room.";
        }
        const atSecretDoor = area.tiles.some(
          (candidate) => candidate.current && candidate.content === 13,
        );
        return tile >= area.tileCount - 1 || atSecretDoor
          ? undefined
          : "The party has not reached the forward door yet.";
      }
      case "return_to_previous_room": {
        if (state.combatActive) {
          return "A previous room cannot be entered during combat.";
        }
        const area = currentPhysicalArea(state);
        const tile = currentPhysicalTile(state);
        if (area?.areaKind !== 1 || tile !== 0) {
          return "Returning requires a verified corridor position at tile 0.";
        }
        if (actionableRoomProps(state).length > 0) {
          return "Resolve the active corridor interactable before returning.";
        }
        return undefined;
      }
      case "approach_room_prop": {
        if (state.combatActive) return "An interactable cannot be approached during combat.";
        const prop = state.room?.props?.find(
          (candidate) =>
            candidate.propIndex === action.propIndex &&
            candidate.active &&
            !state.ignoredPropKeys.includes(
              `${candidate.address}\u0000${candidate.name}`,
            ),
        );
        if (prop === undefined) return `Room prop ${action.propIndex} is not active.`;
        if (prop.reachable) return `Room prop ${action.propIndex} is already reachable.`;
        return prop.direction === -1 || prop.direction === 1
          ? undefined
          : `Room prop ${action.propIndex} has no safe approach direction.`;
      }
      case "interact_room_prop": {
        if (state.combatActive) return "An interactable cannot be used during combat.";
        const prop = state.room?.props?.find(
          (candidate) =>
            candidate.propIndex === action.propIndex &&
            candidate.active &&
            !state.ignoredPropKeys.includes(
              `${candidate.address}\u0000${candidate.name}`,
            ),
        );
        if (prop === undefined) return `Room prop ${action.propIndex} is not active.`;
        if (!prop.reachable) return `Room prop ${action.propIndex} is not yet reachable.`;
        const hero = roomPropHero(state, action);
        if (hero === undefined) {
          return action.heroIndex === undefined
            ? `Party hero GUID ${action.heroGuid} is unavailable or ambiguous.`
            : `Hero GUID ${action.heroGuid} and party index ${action.heroIndex} do not identify the same hero.`;
        }
        return undefined;
      }
      case "choose_event_option": {
        const event = state.eventOverlay;
        if (event?.active !== true) return "No event choice is currently active.";
        const option = event.options.find(
          (candidate) => candidate.optionIndex === action.optionIndex,
        );
        if (option === undefined) return `Event option ${action.optionIndex} is unavailable.`;
        if (!option.enabled) return `Event option ${action.optionIndex} is disabled.`;
        return option.itemSlot
          ? "Use use_item_on_event for an event item slot."
          : undefined;
      }
      case "use_item_on_event": {
        const event = state.eventOverlay;
        if (event?.active !== true) return "No event choice is currently active.";
        const option = event.options.find(
          (candidate) => candidate.optionIndex === action.optionIndex,
        );
        if (option === undefined || !option.enabled || !option.itemSlot) {
          return `Event option ${action.optionIndex} is not an enabled item slot.`;
        }
        if (!state.inventory.some((item) => item.slot === action.inventorySlot)) {
          return `Inventory slot ${action.inventorySlot} is empty.`;
        }
        return event.compatibleInventorySlots.includes(action.inventorySlot)
          ? undefined
          : `Inventory slot ${action.inventorySlot} is not compatible with this event.`;
      }
      case "take_all_loot":
      case "close_loot":
        return state.loot?.active === true
          ? undefined
          : "No loot window is currently active.";
      case "return_to_loot":
        return state.loot?.active === true && state.currentContext === "inventory"
          ? undefined
          : "An open loot window must be covered by the raid inventory.";
      case "take_loot_item": {
        if (state.loot?.active !== true) return "No loot window is currently active.";
        return state.loot.items.some((item) => item.itemIndex === action.itemIndex)
          ? undefined
          : `Loot item ${action.itemIndex} is unavailable.`;
      }
      case "replace_inventory_with_loot": {
        if (state.loot?.active !== true) return "No loot window is currently active.";
        if (!state.loot.items.some((item) => item.itemIndex === action.itemIndex)) {
          return `Loot item ${action.itemIndex} is unavailable.`;
        }
        return state.inventory.some((item) => item.slot === action.inventorySlot)
          ? undefined
          : `Inventory slot ${action.inventorySlot} is empty.`;
      }
      case "move_hero":
        if (!state.combatActive || state.phase !== "combat") {
          return "A hero can only move during a verified combat turn.";
        }
        if (!Number.isInteger(action.toSlot) || action.toSlot < 1 || action.toSlot > 4) {
          return "toSlot must be an integer from 1 through 4.";
        }
        return state.combatActions.some((candidate) => candidate.kind === "reorder")
          ? undefined
          : "Move is absent from the latest inspected action bar.";
      case "use_inventory_item": {
        const item = state.inventory.find((candidate) => candidate.slot === action.inventorySlot);
        if (item === undefined) return `Inventory slot ${action.inventorySlot} is empty.`;
        if (item.itemType === "trinket") return "Trinket equipment requires a dedicated verified equipment action.";
        if (CURIO_ONLY_INVENTORY_ITEMS.has(item.itemId)) {
          return `${item.name} can only be used through a verified event item option.`;
        }
        if (inventoryTarget(state, action) === undefined) {
          return "Item target is missing, ambiguous, lacks a runtime GUID, or conflicts with targetIndex. Refresh the party first.";
        }
        return state.loot?.active === true
          ? "Close or resolve the loot window before using the raid inventory."
          : undefined;
      }
      case "discard_inventory_item": {
        const item = state.inventory.find((candidate) => candidate.slot === action.inventorySlot);
        if (item === undefined) return `Inventory slot ${action.inventorySlot} is empty.`;
        return state.loot?.active === true
          ? "Close or resolve the loot window before using the raid inventory."
          : undefined;
      }
      case "use_torch":
        if (!state.inventory.some((item) => item.itemId === "torch" && item.amount > 0)) {
          return "No torch is present in the latest inventory snapshot.";
        }
        return inventoryTarget(state, {}) === undefined
          ? "No party member has a verified runtime GUID. Refresh the party before using a torch."
          : undefined;
      case "choose_camp_meal": {
        if (state.currentContext !== "meal") return "No camping meal choice is active.";
        const meal = state.camp?.meals.find((candidate) => candidate.optionIndex === action.optionIndex);
        if (meal === undefined) return `Camping meal option ${action.optionIndex} is unavailable.`;
        return meal.foodRequired >= 0 && meal.foodAvailable >= 0 && meal.foodRequired > meal.foodAvailable
          ? "The party does not have enough food for that meal."
          : undefined;
      }
      case "use_camp_skill":
        if (state.camp?.phase !== 6) return "Camping skills are only available during respite.";
        if ((action.targetHeroGuid !== undefined || action.targetIndex !== undefined) && inventoryTarget(state, action) === undefined) {
          return "Camping target identity is missing or conflicting.";
        }
        if (!Number.isInteger(action.skillSlot) || action.skillSlot < 1 || action.skillSlot > 4) {
          return "skillSlot must be an integer from 1 through 4.";
        }
        return state.combatActions.some(
          (candidate) => candidate.kind === "skill" && candidate.skillSlot === action.skillSlot,
        ) ? undefined : `Camping skill slot ${action.skillSlot} is unavailable.`;
      case "finish_camp":
        return state.camp?.phase === 6 && state.combatActions.some((candidate) => candidate.kind === "rest")
          ? undefined
          : "The finish-camp action is not available in the current respite state.";
      case "retreat_combat":
        return state.combatActive && state.quest?.button === "flee"
          ? undefined
          : "Combat retreat is not currently available.";
      case "abandon_expedition":
        return !state.combatActive && state.quest?.button === "abandon"
          ? undefined
          : "Expedition abandon is not currently available.";
      case "finish_quest":
        return state.quest?.button === "finish" || state.quest?.button === "regroup"
          ? undefined
          : "Quest completion is not currently available.";
      case "choose_quest_completion":
        return state.currentContext === "questdone"
          ? undefined
          : "No quest-complete choice is currently active.";
      case "continue_results":
        return state.currentContext === "results" && state.activeTutorial === undefined
          ? undefined
          : "No expedition results screen is currently active.";
      case "recruit_stage_coach_hero": {
        if (
          state.phase !== "building" ||
          state.currentBuilding !== "stage_coach"
        ) {
          return "A Stagecoach hero can only be recruited from the open Stagecoach screen.";
        }
        if (
          state.recruitment !== undefined &&
          state.recruitment.rosterCount >= state.recruitment.rosterCapacity
        ) {
          return "The hero roster is full.";
        }
        return state.buildingHeroes.some(
          (hero) => hero.heroAddress === action.heroAddress,
        )
          ? undefined
          : `Stagecoach hero ${action.heroAddress} is not currently available.`;
      }
      case "select_building_hero":
        return state.phase === "building" && state.buildingDetails?.heroes.some(
          (hero) => hero.heroGuid === action.heroGuid)
          ? undefined : `Building hero GUID ${action.heroGuid} is unavailable.`;
      case "buy_hero_upgrade": {
        if (state.phase !== "building") return "A building must be open to buy a hero upgrade.";
        if (state.buildingDetails?.selectedHeroGuid !== action.heroGuid)
          return `Select hero GUID ${action.heroGuid} before buying an upgrade.`;
        const option = state.buildingDetails.heroOptions.find((candidate) => candidate.optionId === action.optionId);
        const step = option?.stepDetails.find((candidate) => candidate.code === action.stepCode);
        if (!option || !step || step.purchased) return `Hero upgrade ${action.optionId}/${action.stepCode} is unavailable.`;
        return option.stepDetails.findIndex((candidate) => candidate.code === action.stepCode) === option.next
          ? undefined : `Hero upgrade ${action.optionId}/${action.stepCode} is not the next purchasable step.`;
      }
      case "buy_town_item":
        return state.phase === "building" && state.buildingDetails?.shopItems.some(
          (item) => item.itemId === action.itemId)
          ? undefined : `Town item ${action.itemId} is unavailable.`;
      case "assign_town_activity": {
        if (state.phase !== "building") return "A town activity building must be open.";
        const row = state.buildingDetails?.activities.find((candidate) =>
          candidate.activityId === action.activityId && candidate.slot === action.slot);
        if (!row || row.committedHeroGuid !== undefined || row.pendingHeroGuid !== undefined ||
            row.occupant >= 0 || row.locked || row.eventLocked)
          return `Town activity ${action.activityId} slot ${action.slot} is unavailable.`;
        const knownHero = state.buildingDetails?.heroes.some((hero) => hero.heroGuid === action.heroGuid) ||
          state.partyPlanning?.rosterCandidates.some((hero) =>
            hero.heroGuid === action.heroGuid && !hero.missing && [0, 1].includes(hero.state) && !hero.building);
        return knownHero
          ? undefined : `Town hero GUID ${action.heroGuid} is unavailable.`;
      }
      case "cancel_town_activity": {
        const row = state.buildingDetails?.activities.find((candidate) =>
          candidate.activityId === action.activityId && candidate.slot === action.slot);
        return state.phase === "building" && row !== undefined &&
          (row.committedHeroGuid !== undefined || row.pendingHeroGuid !== undefined)
          ? undefined : `Town activity ${action.activityId} slot ${action.slot} has no hero to cancel.`;
      }
      case "open_building_upgrades":
        return state.phase === "building" && state.buildingDetails?.mode === 0
          ? undefined : "The open building is not on its main screen.";
      case "buy_building_upgrade": {
        if (state.phase !== "building" || state.buildingDetails?.mode !== 1)
          return "Open the building upgrade screen before buying an upgrade.";
        const track = state.buildingDetails.upgrades.find((candidate) => candidate.trackId === action.trackId);
        return track !== undefined && track.next >= 0 && action.stepCode === String.fromCharCode(97 + track.next)
          ? undefined : `Building upgrade ${action.trackId}/${action.stepCode} is unavailable.`;
      }
      case "close_building":
        return state.phase === "building"
          ? undefined
          : "No building screen is currently open.";
      case "assign_circus_contestant": {
        if (state.phase !== "circus" || state.circus?.complete !== true)
          return "The arena lineup snapshot is not ready.";
        const contestant = state.circus.contestants.find(
          (row) => row.heroAddress.toLowerCase() === action.heroAddress.toLowerCase(),
        );
        if (contestant === undefined || contestant.dlcLocked)
          return `Arena contestant ${action.heroAddress} is unavailable.`;
        return action.rank <= state.circus.slotCount
          ? undefined
          : `Arena rank ${action.rank} is unavailable.`;
      }
      case "activate_circus_hero": {
        if (state.circusCombat?.active !== true || state.circusCombat.complete !== true || !state.circusCombat.pickOpen)
          return "The arena hero-selection window is not open or its snapshot is incomplete.";
        return state.circusCombat.heroes.some(
          (hero) => hero.actorGuid === action.actorGuid && hero.canActivate,
        ) ? undefined : `Arena actor GUID ${action.actorGuid} cannot act now.`;
      }
      case "dismiss_modal":
        return state.phase === "modal" || state.currentContext === "tutorial" || state.activeTutorial !== undefined
          ? undefined
          : "No modal is currently active.";
      case "cancel_targeting":
        return state.phase === "targeting" || state.currentContext === "itemuse"
          ? undefined
          : "No target selector is currently active.";
      case "pass_turn":
        if (state.circusCombat?.active === true && state.circusCombat.pickOpen) {
          return "Choose an arena hero before issuing an action-bar command.";
        }
        if (!state.combatActive || state.phase !== "combat") {
          return "A turn can only be passed during a verified combat turn.";
        }
        return state.combatActions.some((candidate) => candidate.kind === "pass")
          ? undefined
          : "Pass is absent from the latest inspected action bar.";
      case "use_skill": {
        if (state.circusCombat?.active === true && state.circusCombat.pickOpen) {
          return "Choose an arena hero before issuing a skill command.";
        }
        if (!state.combatActive || state.phase !== "combat") {
          return "A combat skill can only be used during a verified combat turn.";
        }
        const actor = currentCombatant(state);
        if (action.actorGuid !== undefined && actor?.actorGuid !== action.actorGuid) {
          return "The requested actor GUID is not the current combat performer.";
        }
        const skill = resolveSkill(state, action);
        if (skill === undefined) return "Skill ID/slot is missing, ambiguous, or inconsistent with the inspected action bar.";
        if (!skillIsUsableByCurrentActor(state, skill)) {
          return `Skill slot ${action.skillSlot} cannot be used from the active hero's current rank.`;
        }
        if (skillNeedsNoTarget(skill)) {
          return action.target === undefined
            ? undefined
            : "This skill reports no target; omit target and let the Copilot execute it directly.";
        }
        if (action.target === undefined) {
          return `Skill slot ${action.skillSlot} requires a target.`;
        }
        const requestedTarget = action.target;
        if (requestedTarget.targetGuid === undefined &&
            (requestedTarget.side === undefined || requestedTarget.slot === undefined)) {
          return "A combat target requires targetGuid or both side and slot.";
        }
        const target = resolveRequestedTarget(state, requestedTarget);
        if (target === undefined) {
          return requestedTarget.targetGuid === undefined
            ? `Target ${requestedTarget.side} slot ${requestedTarget.slot} is absent from the latest inspected room state.`
            : `Target GUID ${requestedTarget.targetGuid} is absent from the latest inspected room state.`;
        }
        return undefined;
      }
    }
  }

  private async openTownLocation(
    action: Extract<CopilotAction, { kind: "open_town_location" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const location = before.state.townLocations.find(
      (candidate) => candidate.id === action.locationId,
    )!;
    const step = await this.executeStep(
      "open_town_location",
      before,
      { kind: "activate_element", args: { elementId: location.elementId } },
      (snapshot, observations) => {
        if (
          observations.some(
            (record) =>
              record.event?.kind === "building_opened" &&
              record.event.buildingId === action.locationId,
          )
        ) {
          return {
            outcome: "success",
            reason: `${action.locationId} became active.`,
          };
        }
        if (
          snapshot.state.phase !== "town" &&
          snapshot.state.currentContext !== "townmap"
        ) {
          return {
            outcome: "success",
            reason: `The game left the town map after selecting ${action.locationId}.`,
          };
        }
        return undefined;
      },
    );
    steps.push(step.record);
    if (step.record.outcome !== "success") {
      return this.resultFromStep(step, `Opened town location ${action.locationId}.`);
    }
    const inspected = await this.executeStep(
      "inspect_open_building",
      step.snapshot,
      { kind: "inspect_state", args: {} },
      (_snapshot, observations) =>
        observations.some((record) => record.event?.kind === "agent_state_completed")
          ? { outcome: "success", reason: "Fresh building state received." }
          : undefined,
      this.inspectionTimeoutMilliseconds,
    );
    steps.push(inspected.record);
    return this.resultFromStep(inspected, `Opened town location ${action.locationId}.`);
  }

  private async openEmbark(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const step = await this.executeStep(
      "open_embark",
      before,
      { kind: "key_press", args: { sym: SDLK_e, mod: 0 } },
      (snapshot) =>
        snapshot.state.phase === "embark" ||
        snapshot.state.currentContext === "embark"
          ? { outcome: "success", reason: "The expedition planner became active." }
          : undefined,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Opened expedition planning.");
  }

  private async selectEmbarkQuest(
    action: Extract<CopilotAction, { kind: "select_embark_quest" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const quest = before.state.expedition!.quests.find((candidate) =>
      action.questIndex !== undefined
        ? candidate.questIndex === action.questIndex
        : candidate.questId === action.questId)!;
    if (
      before.state.expedition?.selectedQuestIndex === quest.questIndex
    ) {
      return {
        outcome: "success" as const,
        reason: `Quest instance ${quest.questIndex} (${quest.questId}) is already selected.`,
        snapshot: before,
      };
    }
    const step = await this.executeStep("select_embark_quest", before,
      { kind: "select_embark_quest", args: { questIndex: quest.questIndex } },
      (snapshot) => snapshot.state.expedition?.selectedQuestIndex === quest.questIndex
        ? { outcome: "success", reason: `The game selected quest instance ${quest.questIndex} (${quest.questId}).` } : undefined);
    steps.push(step.record);
    if (step.record.outcome !== "success") return this.resultFromStep(step, `Selected quest instance ${quest.questIndex}.`);
    const refreshed = await this.inspectUntil("inspect_preparation_roster", step.snapshot, steps,
      (state) => (state.partyPlanning?.rosterCandidates.length ?? 0) > 0,
      "The preparation roster was refreshed.");
    return refreshed.outcome === "success"
      ? { ...refreshed, reason: `Selected quest instance ${quest.questIndex} (${quest.questId}) and refreshed the preparation roster.` }
      : refreshed;
  }

  private async formEmbarkParty(
    action: Extract<CopilotAction, { kind: "form_embark_party" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    // Fill back-to-front so rank is explicit and list order never becomes identity.
    for (let index = 3; index >= 0; index -= 1) {
      const heroGuid = action.frontToBack[index]!;
      const position = index + 1;
      if (current.state.partyPlanning?.slots.some((slot) => slot.position === position && slot.heroGuid === heroGuid)) continue;
      const commit = await this.executeStep(`assign_party_${heroGuid}_rank_${position}`, current,
        { kind: "assign_party_hero", args: { heroGuid, position } },
        (_snapshot, observations) => observations.some((record) => /^agent-command: end id=\S+ accepted=1$/u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The party assignment was accepted; checking the actual lineup." } : undefined);
      steps.push(commit.record);
      if (commit.record.outcome !== "success") return this.resultFromStep(commit, "Assigned party hero.");
      const observed = await this.inspectUntil(`verify_party_${heroGuid}`, commit.snapshot, steps,
        (state) => state.partyPlanning?.slots.some((slot) => slot.position === position && slot.heroGuid === heroGuid) === true,
        `Verified hero GUID ${heroGuid} at rank ${position}.`);
      if (observed.outcome !== "success") return observed;
      current = observed.snapshot;
    }
    const matches = action.frontToBack.every((guid, index) => current.state.partyPlanning?.slots.some(
      (slot) => slot.position === index + 1 && slot.heroGuid === guid));
    return { outcome: matches ? "success" as const : "failure" as const, snapshot: current,
      reason: matches ? "All four party positions match the requested hero GUIDs." : "The final lineup differs from the requested GUID order." };
  }

  private async inspectUntil(name: string, before: CombatLogSnapshot, steps: ActionStepRecord[],
    matches: (state: CombatState) => boolean, reason: string) {
    let current = before;
    const deadline = Date.now() + this.settlementTimeoutMilliseconds;
    do {
      const inspect = await this.executeStep(name, current, { kind: "inspect_state", args: {} },
        (_snapshot, observations) => observations.some((record) => record.event?.kind === "agent_state_completed")
          ? { outcome: "success", reason: "Fresh state received." } : undefined, this.inspectionTimeoutMilliseconds);
      steps.push(inspect.record);
      if (inspect.record.outcome !== "success") return this.resultFromStep(inspect, reason);
      current = inspect.snapshot;
      if (matches(current.state)) return { outcome: "success" as const, reason, snapshot: current };
      await delay(Math.max(100, this.pollIntervalMilliseconds));
    } while (Date.now() < deadline);
    return { outcome: "uncertain" as const, reason: "Fresh state did not confirm the requested result; no action was resent.", snapshot: current };
  }

  private async proceedToProvision(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    if (current.state.currentContext === "party") {
      const close = await this.executeStep(
        "close_party_lineup",
        current,
        { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
        (snapshot, observations) =>
          observations.some(
            (record) => record.event?.kind === "party_lineup_closed",
          ) || snapshot.state.currentContext === "embark"
            ? {
                outcome: "success",
                reason: "The party lineup returned to expedition planning.",
              }
            : undefined,
      );
      steps.push(close.record);
      if (close.record.outcome !== "success") {
        return this.resultFromStep(close, "Closed the party lineup.");
      }
      current = close.snapshot;
    }

    const advance = await this.executeStep(
      "open_provision",
      current,
      { kind: "key_press", args: { sym: SDLK_e, mod: 0 } },
      (snapshot, observations) =>
        observations.some(
          (record) =>
            record.event?.kind === "embark_forward_outcome" &&
            record.event.provision,
        ) ||
        snapshot.state.phase === "provision" ||
        snapshot.state.currentContext === "provision"
          ? { outcome: "success", reason: "Provisioning became active." }
          : undefined,
    );
    steps.push(advance.record);
    return this.resultFromStep(advance, "Opened provisioning.");
  }

  private async buyProvision(
    action: Extract<CopilotAction, { kind: "buy_provision" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const item = before.state.provisioning!.items.find(
      (candidate) =>
        candidate.section === 0 && candidate.itemKey === action.itemKey,
    )!;
    const initialBagAmount = provisionAmount(before.state, action.itemKey);
    const initialBagTotal = before.state.provisioning!.bagTotal;
    const initialGold = before.state.provisioning!.gold;
    const expectedGold =
      initialGold === undefined || !item.priceKnown
        ? undefined
        : initialGold - Math.max(0, action.quantity - item.freeCount) * item.goldPrice;
    let current = before;
    for (let count = 0; count < action.quantity; count += 1) {
      const purchase = await this.executeStep(
        `buy_${action.itemKey}_${count + 1}`,
        current,
        { kind: "buy_provision", args: { itemKey: action.itemKey } },
        (_snapshot, observations) => {
          const transaction = observations.find(
            (record) =>
              record.event?.kind === "provision_transaction_observed",
          )?.event;
          if (transaction?.kind !== "provision_transaction_observed") {
            return undefined;
          }
          return transaction.bagTotal > transaction.previousBagTotal
            ? {
                outcome: "success",
                reason: `${action.itemKey} purchase increased bag total ${transaction.previousBagTotal} -> ${transaction.bagTotal}.`,
              }
            : {
                outcome: "failure",
                reason: `${action.itemKey} purchase did not increase the bag total.`,
              };
        },
      );
      steps.push(purchase.record);
      if (purchase.record.outcome !== "success") {
        const previousInspectionTick = purchase.snapshot.state.inspection?.completedTick;
        const reconcile = await this.executeStep(
          `inspect_after_${action.itemKey}_purchase_gap_${count + 1}`,
          purchase.snapshot,
          { kind: "inspect_state", args: {} },
          (snapshot) => {
            if (
              snapshot.state.inspection?.completedTick === undefined ||
              snapshot.state.inspection.completedTick === previousInspectionTick
            ) {
              return undefined;
            }
            const observedAmount = provisionAmount(snapshot.state, action.itemKey);
            return observedAmount === initialBagAmount + count + 1
              ? {
                  outcome: "success",
                  reason: `${action.itemKey} was present in the inspected bag despite the missing transaction event.`,
                }
              : {
                  outcome: "failure",
                  reason: `${action.itemKey} was not added; the input was not retried automatically.`,
                };
          },
          this.inspectionTimeoutMilliseconds,
        );
        steps.push(reconcile.record);
        if (reconcile.record.outcome !== "success") {
          return this.resultFromStep(reconcile, `Reconciled ${action.itemKey} after a transaction-state gap.`);
        }
        current = reconcile.snapshot;
        continue;
      }
      current = purchase.snapshot;
    }

    const previousInspectionTick = current.state.inspection?.completedTick;
    const verify = await this.executeStep(
      `inspect_after_buying_${action.itemKey}`,
      current,
      { kind: "inspect_state", args: {} },
      (snapshot) => {
        if (
          snapshot.state.inspection?.completedTick === undefined ||
          snapshot.state.inspection.completedTick === previousInspectionTick
        ) {
          return undefined;
        }
        const provisioning = snapshot.state.provisioning;
        const observedAmount = provisionAmount(snapshot.state, action.itemKey);
        const amountMatches = observedAmount === initialBagAmount + action.quantity;
        const totalMatches =
          initialBagTotal === undefined ||
          provisioning?.bagTotal === undefined ||
          provisioning.bagTotal === initialBagTotal + action.quantity;
        const walletMatches =
          expectedGold === undefined ||
          provisioning?.gold === undefined ||
          provisioning.gold === expectedGold;
        return amountMatches && totalMatches && walletMatches
          ? {
              outcome: "success",
              reason: `Verified ${action.itemKey} quantity and available wallet totals after purchase.`,
            }
          : {
              outcome: "failure",
              reason: `Provision reconciliation failed for ${action.itemKey}: bag=${observedAmount}, total=${provisioning?.bagTotal ?? "unknown"}, gold=${provisioning?.gold ?? "unknown"}.`,
            };
      },
      this.inspectionTimeoutMilliseconds,
    );
    steps.push(verify.record);
    if (verify.record.outcome !== "success") {
      return this.resultFromStep(verify, `Verified the ${action.itemKey} purchase.`);
    }
    current = verify.snapshot;

    return {
      outcome: "success" as const,
      reason: `Bought ${action.quantity} ${action.itemKey}.`,
      snapshot: current,
    };
  }

  private async startExpedition(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const start = await this.executeStep(
      "start_expedition",
      before,
      { kind: "key_press", args: { sym: SDLK_e, mod: 0 } },
      (snapshot, observations) =>
        observations.some(
          (record) =>
            record.event?.kind === "embark_forward_outcome" &&
            record.event.previousProvision &&
            !record.event.provision,
        ) ||
        snapshot.state.currentContext === "room"
          ? {
              outcome: "success",
              reason: "The game left provisioning and started the expedition.",
            }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(start.record);
    return this.resultFromStep(start, "Started the expedition.");
  }

  private async continueLoading(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const step = await this.executeStep(
      "continue_loading",
      before,
      { kind: "key_press", args: { sym: SDLK_SPACE, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.phase !== "loading" ||
        observations.some(
          (record) =>
            record.event?.kind === "context_changed" &&
            record.event.context !== "loading",
        )
          ? {
              outcome: "success",
              reason: "The loading screen advanced to the expedition.",
            }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Continued past the loading screen.");
  }

  private async travelToRoom(
    action: Extract<CopilotAction, { kind: "travel_to_room" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const map = before.state.dungeonMap!;
    const currentRoomId = currentDecisionRoomId(before.state)!;
    const secretRoute = secretExitRoutes(before.state, currentRoomId).find(
      (route) => route.roomId === action.roomId,
    );
    const edge = secretRoute === undefined
      ? map.edges.find(
          (candidate) =>
            candidate.fromAreaId === currentRoomId &&
            candidate.toAreaId === action.roomId,
        )!
      : map.edges.find(
          (candidate) =>
            candidate.fromAreaId === currentRoomId &&
            candidate.corridorAreaId === secretRoute.corridorAreaId,
        )!;
    const destination = map.areas.find(
      (area) => area.areaId === action.roomId,
    )!;
    const direction = MAP_DIRECTIONS.find(
      (candidate) =>
        candidate.direction ===
        (secretRoute?.secretDirection ?? edge.direction),
    );
    if (direction === undefined) {
      return {
        outcome: "failure" as const,
        reason: `The map reported unsupported direction ${edge.direction}.`,
        snapshot: before,
      };
    }

    let current = before;
    if (current.state.currentContext !== "map") {
      const open = await this.executeStep(
        "open_raid_map",
        current,
        { kind: "key_press", args: { sym: SDLK_m, mod: 0 } },
        (snapshot, observations) =>
          snapshot.state.currentContext === "map" ||
          observations.some((record) =>
            /^mapreview open \(focus\)/u.test(record.message ?? ""),
          )
            ? { outcome: "success", reason: "The raid map became active." }
            : undefined,
      );
      steps.push(open.record);
      if (open.record.outcome !== "success") {
        return this.resultFromStep(open, "Opened the raid map.");
      }
      current = open.snapshot;
    }

    const home = await this.executeStep(
      "focus_current_room",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          /^mapnav home -> area=\d+ tile=\d+$/u.test(record.message ?? ""),
        )
          ? {
              outcome: "success",
              reason: "The map cursor returned to the party's current room.",
            }
          : undefined,
      1_500,
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") {
      return this.resultFromStep(home, "Focused the current room on the raid map.");
    }
    current = home.snapshot;

    const firstSelectionArea = secretRoute === undefined
      ? destination
      : map.areas.find(
          (area) => area.areaId === secretRoute.corridorAreaId,
        )!;
    const select = await this.executeStep(
      secretRoute === undefined
        ? `select_room_${action.roomId}`
        : `select_secret_door_${secretRoute.corridorAreaId}`,
      current,
      { kind: "key_press", args: { sym: direction.sym, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(
            `^mapnav room-step dir=${direction.direction} -> area=${firstSelectionArea.areaIndex} tile=\\d+$`,
            "u",
          ).test(record.message ?? ""),
        )
          ? {
              outcome: "success",
              reason:
                secretRoute === undefined
                  ? `The map cursor selected room ${action.roomId} (${direction.name}).`
                  : `The map cursor selected the secret door in ${secretRoute.corridorAreaId}.`,
            }
          : undefined,
      1_500,
    );
    steps.push(select.record);
    if (select.record.outcome !== "success") {
      return this.resultFromStep(select, `Selected room ${action.roomId}.`);
    }
    current = select.snapshot;

    if (secretRoute !== undefined) {
      const endpointDirection = MAP_DIRECTIONS.find(
        (candidate) => candidate.direction === secretRoute.endpointDirection,
      )!;
      const endpoint = await this.executeStep(
        `select_secret_exit_room_${action.roomId}`,
        current,
        { kind: "key_press", args: { sym: endpointDirection.sym, mod: 0 } },
        (_snapshot, observations) =>
          observations.some((record) =>
            new RegExp(
              `^mapnav room-step dir=${endpointDirection.direction} -> area=${destination.areaIndex} tile=\\d+$`,
              "u",
            ).test(record.message ?? ""),
          )
            ? {
                outcome: "success",
                reason: `The map cursor selected secret-room exit ${action.roomId}.`,
              }
            : undefined,
        1_500,
      );
      steps.push(endpoint.record);
      if (endpoint.record.outcome !== "success") {
        return this.resultFromStep(endpoint, `Selected secret-room exit ${action.roomId}.`);
      }
      current = endpoint.snapshot;
    }

    const move = await this.executeStep(
      "confirm_map_move",
      current,
      {
        kind: "key_press",
        args: { sym: SDLK_RETURN, mod: 0 },
      },
      (snapshot, observations) => {
        if (
          observations.some(
            (record) =>
              (record.event?.kind === "map_move_started" &&
                record.event.toArea === action.roomId) ||
              /^map-move: party started moving ->/u.test(record.message ?? ""),
          )
        ) {
          return {
            outcome: "success",
            reason: `The party started travelling ${direction.name} to room ${action.roomId}.`,
          };
        }
        if (
          observations.some((record) =>
            /^map-move: (?:move call faulted|no movement within window|gate refused|no door)/u.test(
              record.message ?? "",
            ),
          )
        ) {
          return { outcome: "failure", reason: "The game refused the map move." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(move.record);
    return this.resultFromStep(
      move,
      `Started automatic travel to the chosen room ${action.roomId}.`,
    );
  }

  private async advanceCorridor(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    if (current.state.currentContext === "map") {
      const closeMap = await this.executeStep(
        "close_raid_map",
        current,
        { kind: "key_press", args: { sym: SDLK_i, mod: 0 } },
        (snapshot, observations) =>
          snapshot.state.currentContext !== "map" ||
          observations.some((record) =>
            /^mapreview auto-closed\b/u.test(record.message ?? ""),
          )
            ? { outcome: "success", reason: "The raid map closed." }
            : undefined,
      );
      steps.push(closeMap.record);
      if (closeMap.record.outcome !== "success") {
        return this.resultFromStep(closeMap, "Closed the raid map.");
      }
      current = closeMap.snapshot;
    }

    let stagnantAttempts = 0;
    for (let index = 0; index < 16; index += 1) {
      const area = currentPhysicalArea(current.state);
      const tile = currentPhysicalTile(current.state);
      if (area?.areaKind !== 1 || tile === undefined) {
        return {
          outcome: "success" as const,
          reason: "Corridor travel ended because the party entered another area.",
          snapshot: current,
        };
      }
      if (tile >= area.tileCount - 1) {
        return {
          outcome: "success" as const,
          reason: "The party reached the forward door.",
          snapshot: current,
        };
      }

      const step = await this.executeStep(
        `advance_corridor_from_tile_${tile}`,
        current,
        { kind: "key_press", args: { sym: SDLK_d, mod: KMOD_LSHIFT } },
        (snapshot, observations) => {
          if (snapshot.state.combatActive || snapshot.state.phase === "combat") {
            return { outcome: "success", reason: "Combat interrupted corridor travel." };
          }
          if (
            observations.some(
              (record) => record.event?.kind === "tile_step_arrived",
            )
          ) {
            return { outcome: "success", reason: "The party advanced one corridor tile." };
          }
          if (
            observations.some((record) =>
              /^tilestep: refused .*trap|^tilestep: stop - prop\b|^tilestep: released .*parked short of the trap boundary\b/u.test(
                record.message ?? "",
              ),
            )
          ) {
            return { outcome: "success", reason: "A corridor hazard or object stopped travel." };
          }
          if (
            snapshot.state.phase === "event" ||
            snapshot.state.phase === "modal" ||
            snapshot.state.phase === "loot" ||
            snapshot.state.currentContext === "event" ||
            snapshot.state.currentContext === "itemuse"
          ) {
            return { outcome: "success", reason: "A game event interrupted corridor travel." };
          }
          if (
            observations.some((record) =>
              /^tilestep: (?:no movement|refused .*past the door)|the party never moved/u.test(
                record.message ?? "",
              ),
            )
          ) {
            return { outcome: "failure", reason: "The party could not advance." };
          }
          return undefined;
        },
        this.settlementTimeoutMilliseconds * 2,
      );
      steps.push(step.record);
      if (step.record.outcome !== "success") {
        return this.resultFromStep(step, "Advanced through the corridor.");
      }
      current = step.snapshot;

      const stoppedAtHazard = step.record.observations.some((record) =>
        /^tilestep: refused .*trap|^tilestep: stop - prop\b|^tilestep: released .*parked short of the trap boundary\b/u.test(
          record.message ?? "",
        ),
      );
      if (stoppedAtHazard) {
        return this.inspectAfterDungeonInteraction(
          current,
          steps,
          "Corridor travel stopped at an object or revealed trap and refreshed the available choices.",
        );
      }

      if (current.state.combatActive || current.state.phase === "combat") {
        return {
          outcome: "success" as const,
          reason: "Corridor travel stopped when combat began.",
          snapshot: current,
        };
      }
      if (
        current.state.phase === "event" ||
        current.state.phase === "modal" ||
        current.state.phase === "loot" ||
        current.state.currentContext === "event" ||
        current.state.currentContext === "itemuse" ||
        stoppedAtHazard
      ) {
        return {
          outcome: "success" as const,
          reason: "Corridor travel stopped for an event, object, or hazard.",
          snapshot: current,
        };
      }

      const arrival = step.record.observations.find(
        (record) => record.event?.kind === "tile_step_arrived",
      )?.event;
      if (arrival?.kind === "tile_step_arrived") {
        const plainTile = /^(?:第\d+格，共\d+格|Tile \d+ of \d+)[.。]?$/u;
        if (!plainTile.test(arrival.description.trim())) {
          return {
            outcome: "success" as const,
            reason: `Corridor travel stopped at: ${arrival.description}`,
            snapshot: current,
          };
        }
        if (!arrival.newArea && arrival.tile === tile) {
          stagnantAttempts += 1;
          if (stagnantAttempts >= 3) {
            return {
              outcome: "uncertain" as const,
              reason: "Three corridor steps ended on the same tile; movement needs reconciliation.",
              snapshot: current,
            };
          }
        } else {
          stagnantAttempts = 0;
        }
      }
      // The DLL verifies and, if needed, force-releases the held movement key
      // 250 ms after each tile step. Starting the next step immediately can
      // make that release cancel the new keydown; 300 ms keeps a small margin.
      await delay(300);
    }

    return {
      outcome: "uncertain" as const,
      reason: "Corridor travel exceeded the bounded 16-tile workflow.",
      snapshot: current,
    };
  }

  private async enterRoom(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const raidFinishedDuringEntry = (snapshot: CombatLogSnapshot) =>
      snapshot.state.currentContext === "questdone" ||
      snapshot.state.currentContext === "raidfinish" ||
      snapshot.state.currentContext === "results";
    const previousAreaId = before.state.dungeonMap?.currentAreaId;
    const previousRoomTick = before.state.room?.observedTick;
    const step = await this.executeStep(
      "enter_forward_room",
      before,
      { kind: "key_press", args: { sym: SDLK_w, mod: 0 } },
      (snapshot, observations) => {
        if (raidFinishedDuringEntry(snapshot)) {
          return { outcome: "success", reason: "Entering the room completed the quest." };
        }
        const area = currentPhysicalArea(snapshot.state);
        if (
          area !== undefined &&
          snapshot.state.dungeonMap?.currentAreaId !== previousAreaId
        ) {
          return {
            outcome: "success",
            reason:
              area.areaKind === 0
                ? `The party entered room ${area.areaId}.`
                : `The party left the secret room for corridor ${area.areaId}.`,
          };
        }
        if (snapshot.state.combatActive || snapshot.state.phase === "combat") {
          return { outcome: "success", reason: "Entering the room started combat." };
        }
        if (
          snapshot.state.room?.observedTick !== undefined &&
          snapshot.state.room.observedTick !== previousRoomTick
        ) {
          return { outcome: "success", reason: "The destination room was observed." };
        }
        if (
          observations.some((record) =>
            /^(?:roomview enter|agent-map: position area='roo)/u.test(
              record.message ?? "",
            ),
          )
        ) {
          return { outcome: "success", reason: "The party crossed the forward door." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    if (step.record.outcome !== "success") {
      return this.resultFromStep(step, "Entered the forward room.");
    }
    if (raidFinishedDuringEntry(step.snapshot)) {
      return this.resultFromStep(step, "Entered the forward room and completed the quest.");
    }
    if (step.snapshot.state.combatActive || step.snapshot.state.phase === "combat") {
      return this.resultFromStep(step, "Entered the forward room and combat began.");
    }

    const enteredRoomTick = step.snapshot.state.room?.observedTick;
    const advance = await this.executeStep(
      "advance_into_room",
      step.snapshot,
      { kind: "key_press", args: { sym: SDLK_d, mod: KMOD_LSHIFT } },
      (snapshot, observations) => {
        if (raidFinishedDuringEntry(snapshot)) {
          return { outcome: "success", reason: "Advancing into the room completed the quest." };
        }
        if (snapshot.state.combatActive || snapshot.state.phase === "combat") {
          return { outcome: "success", reason: "Advancing into the room started combat." };
        }
        if (
          snapshot.state.room?.observedTick !== undefined &&
          snapshot.state.room.observedTick !== enteredRoomTick
        ) {
          return { outcome: "success", reason: "The party reached the room decision point." };
        }
        if (
          snapshot.state.phase === "event" ||
          snapshot.state.phase === "modal" ||
          snapshot.state.phase === "loot"
        ) {
          return { outcome: "success", reason: "A room event interrupted entry movement." };
        }
        if (
          observations.some((record) =>
            /^(?:resting point: landing in the dungeon view|roomview enter:|tilestep: stop - prop\b|tilestep: no further movement .*\bmoved=1\b)/u.test(
              record.message ?? "",
            ),
          )
        ) {
          return { outcome: "success", reason: "The party advanced to the room decision point." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(advance.record);
    if (advance.record.outcome !== "success") {
      return this.resultFromStep(
        advance,
        "Crossed the door but could not verify arrival at the room decision point.",
      );
    }
    if (raidFinishedDuringEntry(advance.snapshot)) {
      return this.resultFromStep(advance, "Entered the forward room and completed the quest.");
    }
    if (advance.snapshot.state.combatActive || advance.snapshot.state.phase === "combat") {
      return this.resultFromStep(advance, "Entered the forward room and combat began.");
    }

    let current = advance.snapshot;
    if (
      current.state.phase !== "event" &&
      current.state.phase !== "modal" &&
      current.state.phase !== "loot" &&
      current.state.room?.observedTick === enteredRoomTick
    ) {
      const observe = await this.executeStep(
        "observe_entered_room",
        current,
        { kind: "key_press", args: { sym: SDLK_r, mod: 0 } },
        (snapshot, observations) => {
          if (raidFinishedDuringEntry(snapshot)) {
            return { outcome: "success", reason: "The entered room completed the quest." };
          }
          return (snapshot.state.room?.observedTick !== undefined &&
            snapshot.state.room.observedTick !== enteredRoomTick) ||
          observations.some((record) => /^roomview enter:/u.test(record.message ?? ""))
            ? { outcome: "success", reason: "The entered room was observed." }
            : undefined;
        },
      );
      steps.push(observe.record);
      if (observe.record.outcome !== "success") {
        return this.resultFromStep(observe, "Entered the room but could not observe its contents.");
      }
      current = observe.snapshot;
      if (raidFinishedDuringEntry(current)) {
        return this.resultFromStep(observe, "Entered the forward room and completed the quest.");
      }
    }
    return this.inspectAfterDungeonInteraction(
      current,
      steps,
      "Entered the forward room and refreshed its interactables, inventory, and light.",
    );
  }

  private async returnToPreviousRoom(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const previousAreaId = before.state.dungeonMap?.currentAreaId;
    const expectedRoomId = before.state.navigation?.fromArea;
    const step = await this.executeStep(
      "enter_previous_room",
      before,
      { kind: "key_press", args: { sym: SDLK_w, mod: 0 } },
      (snapshot, observations) => {
        const area = currentPhysicalArea(snapshot.state);
        if (
          area?.areaKind === 0 &&
          snapshot.state.dungeonMap?.currentAreaId !== previousAreaId
        ) {
          return {
            outcome: "success",
            reason:
              expectedRoomId === undefined || area.areaId === expectedRoomId
                ? `The party returned to room ${area.areaId}.`
                : `The party crossed the rear door into room ${area.areaId}.`,
          };
        }
        if (
          observations.some((record) =>
            /^agent-map: position area='roo/u.test(record.message ?? ""),
          )
        ) {
          return { outcome: "success", reason: "The party crossed the rear door." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Returned to the previous room.");
  }

  private async approachRoomProp(
    action: Extract<CopilotAction, { kind: "approach_room_prop" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const original = before.state.room?.props?.find(
      (candidate) => candidate.propIndex === action.propIndex,
    )!;
    const movementCommand = {
      kind: "key_press",
      args: { sym: original.direction > 0 ? SDLK_d : SDLK_a, mod: 0 },
    };
    const acknowledgement = await this.game.send(movementCommand);
    if (
      acknowledgement.status === "rejected" ||
      acknowledgement.status === "unavailable" ||
      acknowledgement.status === "timeout"
    ) {
      const outcome =
        acknowledgement.status === "timeout"
          ? ("uncertain" as const)
          : ("failure" as const);
      steps.push({
        name: "approach_room_prop",
        sourceRevision: before.revision,
        finalRevision: before.revision,
        outcome,
        reason: acknowledgement.reason ?? `Movement was ${acknowledgement.status}.`,
        primitiveCommand: movementCommand,
        acknowledgement,
        observations: [],
      });
      return {
        outcome,
        reason: steps.at(-1)!.reason,
        snapshot: before,
      };
    }

    // A normal A/D tap has no reliable movement log. Let the game settle, then
    // inspect memory and use the changed prop distance as semantic evidence.
    await delay(350);
    const inspection = await this.executeStep(
      "inspect_after_prop_approach",
      before,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) => {
        if (
          !observations.some(
            (record) => record.event?.kind === "agent_state_completed",
          )
        ) {
          return undefined;
        }
        const current = snapshot.state.room?.props?.find(
          (candidate) => candidate.propIndex === action.propIndex,
        );
        if (current === undefined || !current.active) {
          return { outcome: "success", reason: "The interactable is no longer active." };
        }
        if (current.reachable || current.distance < original.distance) {
          return {
            outcome: "success",
            reason: current.reachable
              ? "The interactable is now reachable."
              : `The interactable distance decreased ${original.distance} -> ${current.distance}.`,
          };
        }
        return {
          outcome: "failure",
          reason: "The verified interactable distance did not decrease.",
        };
      },
      this.inspectionTimeoutMilliseconds * 2,
    );
    steps.push({
      name: "approach_room_prop",
      sourceRevision: before.revision,
      finalRevision: inspection.snapshot.revision,
      outcome: inspection.record.outcome,
      reason: inspection.record.reason,
      primitiveCommand: movementCommand,
      acknowledgement,
      observations: inspection.record.observations,
    });
    steps.push(inspection.record);
    return this.resultFromStep(inspection, "Approached the room interactable.");
  }

  private async interactRoomProp(
    action: Extract<CopilotAction, { kind: "interact_room_prop" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const prop = before.state.room?.props?.find(
      (candidate) => candidate.propIndex === action.propIndex,
    )!;
    const hero = roomPropHero(before.state, action)!;
    if (prop.trap) {
      const disarm = await this.executeStep(
        "disarm_trap",
        before,
        {
          kind: "disarm_trap",
          args: { propIndex: action.propIndex, heroIndex: hero.sideIndex },
        },
        (_snapshot, observations) => {
          const result = observations.find(
            (record) => record.event?.kind === "trap_result",
          )?.event;
          if (result?.kind !== "trap_result") return undefined;
          if (result.outcome === "disarmed") {
            return {
              outcome: "success",
              reason: `${hero.name} disarmed ${prop.name} (${hero.trapDisarmChance ?? "unknown"}% chance).`,
            };
          }
          if (result.outcome === "triggered") {
            return {
              outcome: "success",
              reason: `${hero.name} triggered ${prop.name}: HP ${result.hpDelta}, stress ${result.stressDelta}.`,
            };
          }
          return {
            outcome: "failure",
            reason: `The game returned an unknown result for ${prop.name}.`,
          };
        },
        Math.max(this.settlementTimeoutMilliseconds * 6, 10_000),
      );
      steps.push(disarm.record);
      if (disarm.record.outcome !== "success") {
        return this.resultFromStep(disarm, `Resolved ${prop.name}.`);
      }
      return this.inspectAfterDungeonInteraction(
        disarm.snapshot,
        steps,
        disarm.record.reason,
      );
    }
    let current = before;
    const selectHero = await this.executeStep(
      "select_room_prop_hero_by_guid",
      current,
      { kind: "select_raid_hero", args: { heroGuid: action.heroGuid } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(`^agent-raid: selected hero_guid=${action.heroGuid}\\b`, "u").test(
            record.message ?? "",
          ),
        )
          ? { outcome: "success", reason: `${hero.name} was selected for the interaction.` }
          : undefined,
      1_500,
    );
    steps.push(selectHero.record);
    if (selectHero.record.outcome !== "success") {
      return this.resultFromStep(selectHero, `Selected ${hero.name} for ${prop.name}.`);
    }
    current = selectHero.snapshot;
    if (current.state.currentContext !== "room") {
      const open = await this.executeStep(
        "open_room_view",
        current,
        { kind: "key_press", args: { sym: SDLK_r, mod: 0 } },
        (snapshot, observations) =>
          snapshot.state.currentContext === "room" ||
          observations.some((record) => /^roomview enter:/u.test(record.message ?? ""))
            ? { outcome: "success", reason: "The dungeon room view opened." }
            : undefined,
      );
      steps.push(open.record);
      if (open.record.outcome !== "success") return this.resultFromStep(open, "Opened room view.");
      current = open.snapshot;
    }

    const targetRow =
      (current.state.room?.partyCount ?? 0) +
      (current.state.room?.enemyCount ?? 0) +
      action.propIndex;
    const home = await this.executeStep(
      "focus_first_room_row",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) => /^roomview row 0\//u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The first room row is focused." }
          : undefined,
      1_500,
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") return this.resultFromStep(home, "Focused room rows.");
    current = home.snapshot;

    for (let row = 1; row <= targetRow; row += 1) {
      const move = await this.executeStep(
        `focus_room_row_${row}`,
        current,
        { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
        (_snapshot, observations) =>
          observations.some((record) =>
            new RegExp(`^roomview row ${row}\\/`, "u").test(record.message ?? ""),
          )
            ? { outcome: "success", reason: `Room row ${row} is focused.` }
            : undefined,
        1_500,
      );
      steps.push(move.record);
      if (move.record.outcome !== "success") return this.resultFromStep(move, "Focused the interactable.");
      current = move.snapshot;
    }

    const activate = await this.executeStep(
      "activate_room_prop",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot, observations) => {
        const interaction = observations
          .map((record) =>
            /^curio: InteractWithProp returned \d+ .* state (\d+) -> (\d+),/u.exec(
              record.message ?? "",
            ),
          )
          .find((match) => match !== null);
        if (
          snapshot.state.eventOverlay?.active === true ||
          snapshot.state.loot?.active === true ||
          (interaction !== undefined && interaction[1] !== interaction[2]) ||
          observations.some((record) => /^trap:/u.test(record.message ?? ""))
        ) {
          return { outcome: "success", reason: `Interaction with ${prop.name} started.` };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(activate.record);
    return this.resultFromStep(activate, `Interacted with ${prop.name}.`);
  }

  private async chooseEventOption(
    action: Extract<CopilotAction, { kind: "choose_event_option" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const choose = await this.executeStep(
      "choose_event_option",
      before,
      { kind: "activate_event_option", args: { optionIndex: action.optionIndex } },
      (snapshot, observations) =>
        snapshot.state.eventOverlay?.active !== true ||
        observations.some((record) =>
          /^(?:event: ".*" taken|event: agent option \d+ )/u.test(record.message ?? ""),
        )
          ? { outcome: "success", reason: "The event choice was accepted by the game." }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(choose.record);
    if (choose.record.outcome !== "success") {
      return this.resultFromStep(choose, `Chose event option ${action.optionIndex}.`);
    }
    return this.inspectAfterDungeonInteraction(
      choose.snapshot,
      steps,
      `Chose event option ${action.optionIndex} and refreshed dungeon state.`,
    );
  }

  private async useItemOnEvent(
    action: Extract<CopilotAction, { kind: "use_item_on_event" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    const focus = await this.focusEventItemOption(action.optionIndex, current, steps);
    if (focus.record.outcome !== "success") return this.resultFromStep(focus, "Focused the event item slot.");
    current = focus.snapshot;

    const openInventory = await this.executeStep(
      "open_event_item_picker",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          /^event: handing over to the inventory to pick an item/u.test(record.message ?? ""),
        )
          ? { outcome: "success", reason: "The event inventory picker opened." }
          : undefined,
    );
    steps.push(openInventory.record);
    if (openInventory.record.outcome !== "success") return this.resultFromStep(openInventory, "Opened event inventory.");
    current = openInventory.snapshot;

    const home = await this.executeStep(
      "focus_inventory_slot_0",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) => /^invnav jump slot \d+ -> 0 /u.test(record.message ?? ""))
          ? { outcome: "success", reason: "Inventory slot 0 is focused." }
          : undefined,
      1_500,
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") return this.resultFromStep(home, "Focused the inventory.");
    current = home.snapshot;

    const downCount = Math.floor(action.inventorySlot / 8);
    const rightCount = action.inventorySlot % 8;
    let slot = 0;
    for (let index = 0; index < downCount; index += 1) {
      slot += 8;
      const move = await this.navigateInventory(current, SDLK_DOWN, slot, steps);
      if (move.record.outcome !== "success") return this.resultFromStep(move, "Moved in the inventory.");
      current = move.snapshot;
    }
    for (let index = 0; index < rightCount; index += 1) {
      slot += 1;
      const move = await this.navigateInventory(current, SDLK_RIGHT, slot, steps);
      if (move.record.outcome !== "success") return this.resultFromStep(move, "Moved in the inventory.");
      current = move.snapshot;
    }

    const use = await this.executeStep(
      "use_item_on_event",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot, observations) => {
        if (
          observations.some((record) =>
            new RegExp(`^event: dropped slot ${action.inventorySlot} .*accepted=1`, "u").test(
              record.message ?? "",
            ),
          ) ||
          observations.some((record) =>
            new RegExp(
              `^event: obstacle item slot ${action.inventorySlot} accepted=1$`,
              "u",
            ).test(record.message ?? ""),
          )
        ) {
          return { outcome: "success", reason: "The compatible item was applied to the event." };
        }
        if (
          observations.some((record) =>
            new RegExp(`^event: dropped slot ${action.inventorySlot} .*accepted=0`, "u").test(
              record.message ?? "",
            ),
          ) ||
          observations.some((record) =>
            new RegExp(
              `^event: obstacle item slot ${action.inventorySlot} accepted=0$`,
              "u",
            ).test(record.message ?? ""),
          )
        ) {
          return { outcome: "failure", reason: "The game rejected the item for this event." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(use.record);
    if (use.record.outcome !== "success") {
      return this.resultFromStep(use, `Used inventory slot ${action.inventorySlot} on the event.`);
    }
    return this.inspectAfterDungeonInteraction(
      use.snapshot,
      steps,
      `Used inventory slot ${action.inventorySlot} on the event and refreshed dungeon state.`,
    );
  }

  private async inspectAfterDungeonInteraction(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
    successReason: string,
  ) {
    const previousCompletedTick = before.state.inspection?.completedTick;
    const inspection = await this.executeStep(
      "inspect_after_dungeon_interaction",
      before,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) =>
        observations.some(
          (record) => record.event?.kind === "agent_state_completed",
        ) && snapshot.state.inspection?.completedTick !== previousCompletedTick
          ? {
              outcome: "success",
              reason: "Fresh room, inventory, event, and loot state was observed.",
            }
          : undefined,
      this.inspectionTimeoutMilliseconds * 2,
    );
    steps.push(inspection.record);
    return this.resultFromStep(inspection, successReason);
  }

  private async focusEventItemOption(
    optionIndex: number,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ): Promise<StepResult> {
    let current = before;
    const home = await this.executeStep(
      "focus_first_event_option",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) => /^eventnav jump row \d+ -> 0 /u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The first event option is focused." }
          : undefined,
      1_500,
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") return home;
    current = home.snapshot;
    for (let row = 1; row <= optionIndex; row += 1) {
      const move = await this.executeStep(
        `focus_event_option_${row}`,
        current,
        { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
        (_snapshot, observations) =>
          observations.some((record) =>
            new RegExp(`^eventnav dir=\\+1 row \\d+ -> ${row} `, "u").test(record.message ?? ""),
          )
            ? { outcome: "success", reason: `Event option ${row} is focused.` }
            : undefined,
        1_500,
      );
      steps.push(move.record);
      if (move.record.outcome !== "success") return move;
      current = move.snapshot;
    }
    return {
      snapshot: current,
      record: steps.at(-1)!,
    };
  }

  private async navigateInventory(
    before: CombatLogSnapshot,
    sym: number,
    targetSlot: number,
    steps: ActionStepRecord[],
  ): Promise<StepResult> {
    const move = await this.executeStep(
      `focus_inventory_slot_${targetSlot}`,
      before,
      { kind: "key_press", args: { sym, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(`^invnav dir=\\d slot \\d+ -> ${targetSlot} `, "u").test(
            record.message ?? "",
          ),
        )
          ? { outcome: "success", reason: `Inventory slot ${targetSlot} is focused.` }
          : undefined,
      1_500,
    );
    steps.push(move.record);
    return move;
  }

  private async consolidateBeforeLoot(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ): Promise<StepResult> {
    const consolidate = await this.executeStep(
      "consolidate_inventory_before_loot",
      before,
      { kind: "consolidate_inventory", args: {} },
      (_snapshot, observations) => {
        const event = observations.find(
          (record) => record.event?.kind === "inventory_consolidated",
        )?.event;
        if (event?.kind !== "inventory_consolidated") return undefined;
        return event.accepted
          ? {
              outcome: "success",
              reason: `Inventory consolidation completed (${event.merges} merges, ${event.freed} slots freed).`,
            }
          : {
              outcome: "failure",
              reason: "The game rejected inventory consolidation.",
            };
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(consolidate.record);
    if (consolidate.record.outcome !== "success") return consolidate;

    const event = consolidate.record.observations.find(
      (record) => record.event?.kind === "inventory_consolidated",
    )?.event;
    if (event?.kind !== "inventory_consolidated" || event.merges === 0) {
      return consolidate;
    }

    const previousCompletedTick = consolidate.snapshot.state.inspection?.completedTick;
    const inspection = await this.executeStep(
      "inspect_after_inventory_consolidation",
      consolidate.snapshot,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) =>
        observations.some((record) => record.event?.kind === "agent_state_completed") &&
        snapshot.state.inspection?.completedTick !== previousCompletedTick
          ? {
              outcome: "success",
              reason: "The consolidated inventory and remaining loot were refreshed.",
            }
          : undefined,
      this.inspectionTimeoutMilliseconds * 2,
    );
    steps.push(inspection.record);
    return inspection;
  }

  private async takeAllLoot(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ): Promise<WorkflowResult> {
    const consolidation = await this.consolidateBeforeLoot(before, steps);
    if (consolidation.record.outcome !== "success") {
      return this.resultFromStep(consolidation, "Consolidated inventory before taking loot.");
    }
    const journal = consolidation.snapshot.state.loot?.items.find(
      (item) => item.itemType === "journal_page",
    );
    if (journal !== undefined) {
      const beforeCount = consolidation.snapshot.state.loot?.items.length ?? 0;
      const journalResult = await this.takeLootItem(
        { kind: "take_loot_item", itemIndex: journal.itemIndex },
        consolidation.snapshot,
        steps,
        false,
      );
      if (journalResult.outcome !== "success") return journalResult;
      const remaining = journalResult.snapshot.state.loot?.items ?? [];
      if (
        remaining.length >= beforeCount ||
        remaining.some((item) => item.itemType === "journal_page")
      ) {
        return {
          outcome: "uncertain" as const,
          reason: "The journal page was accepted but remained in the refreshed loot state.",
          snapshot: journalResult.snapshot,
        };
      }
      if (remaining.length === 0) {
        return {
          outcome: "success" as const,
          reason: "Took the journal page through the verified single-item path.",
          snapshot: journalResult.snapshot,
        };
      }
      return this.takeAllLoot(journalResult.snapshot, steps);
    }
    const step = await this.executeStep(
      "take_all_loot",
      consolidation.snapshot,
      { kind: "key_press", args: { sym: SDLK_SPACE, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.loot?.active !== true ||
        observations.some((record) => record.event?.kind === "loot_closed")
          ? { outcome: "success", reason: "The loot window closed after taking all." }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Took all available loot.");
  }

  private async takeLootItem(
    action: Extract<CopilotAction, { kind: "take_loot_item" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
    consolidate = true,
  ) {
    let current = before;
    if (consolidate) {
      const consolidation = await this.consolidateBeforeLoot(current, steps);
      if (consolidation.record.outcome !== "success") {
        return this.resultFromStep(consolidation, "Consolidated inventory before taking loot.");
      }
      current = consolidation.snapshot;
    }
    const home = await this.executeStep(
      "focus_first_loot_item",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) => /^lootnav jump item \d+ -> 0 /u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The first loot item is focused." }
          : undefined,
      1_500,
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") return this.resultFromStep(home, "Focused loot.");
    current = home.snapshot;
    for (let item = 1; item <= action.itemIndex; item += 1) {
      const move = await this.executeStep(
        `focus_loot_item_${item}`,
        current,
        { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
        (_snapshot, observations) =>
          observations.some((record) =>
            new RegExp(`^lootnav dir=\\+1 item \\d+ -> ${item} `, "u").test(
              record.message ?? "",
            ),
          )
            ? { outcome: "success", reason: `Loot item ${item} is focused.` }
            : undefined,
        1_500,
      );
      steps.push(move.record);
      if (move.record.outcome !== "success") return this.resultFromStep(move, "Focused the loot item.");
      current = move.snapshot;
    }
    const take = await this.executeStep(
      "take_loot_item",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) => {
        if (observations.some((record) => /^loot: took item /u.test(record.message ?? ""))) {
          return { outcome: "success", reason: "The selected loot item left the loot list." };
        }
        if (
          observations.some((record) =>
            /^loot: take item .* (?:could not be attempted|nothing moved)/u.test(
              record.message ?? "",
            ),
          )
        ) {
          return { outcome: "failure", reason: "The selected loot item could not be taken." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(take.record);
    if (take.record.outcome !== "success") {
      return this.resultFromStep(take, `Took loot item ${action.itemIndex}.`);
    }
    return this.inspectAfterLootChange(
      take.snapshot,
      steps,
      `Took loot item ${action.itemIndex} and refreshed the inventory and remaining loot.`,
    );
  }

  private async inspectAfterLootChange(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
    successReason: string,
  ) {
    const previousCompletedTick = before.state.inspection?.completedTick;
    const inspection = await this.executeStep(
      "inspect_after_loot_change",
      before,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) =>
        observations.some((record) => record.event?.kind === "agent_state_completed") &&
        snapshot.state.inspection?.completedTick !== previousCompletedTick
          ? {
              outcome: "success",
              reason: "Fresh inventory and remaining loot state was observed.",
            }
          : undefined,
      this.inspectionTimeoutMilliseconds * 2,
    );
    steps.push(inspection.record);
    return this.resultFromStep(inspection, successReason);
  }

  private async replaceInventoryWithLoot(
    action: Extract<CopilotAction, { kind: "replace_inventory_with_loot" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const consolidation = await this.consolidateBeforeLoot(before, steps);
    if (consolidation.record.outcome !== "success") {
      return this.resultFromStep(consolidation, "Consolidated inventory before replacing loot.");
    }
    const current = consolidation.snapshot;
    const discarded = current.state.inventory.find(
      (item) => item.slot === action.inventorySlot,
    );
    const wanted = current.state.loot!.items.find(
      (item) => item.itemIndex === action.itemIndex,
    )!;

    if (
      current.state.inventoryInfo !== undefined &&
      current.state.inventoryInfo.occupiedCount < current.state.inventoryInfo.slotCount
    ) {
      const take = await this.takeLootItem(
        { kind: "take_loot_item", itemIndex: action.itemIndex },
        current,
        steps,
        false,
      );
      if (take.outcome !== "success") return take;
      return {
        outcome: "success" as const,
        reason: `Consolidated inventory and took ${wanted.name} without discarding an item.`,
        snapshot: take.snapshot,
      };
    }

    if (discarded === undefined) {
      return {
        outcome: "failure" as const,
        reason: `Inventory slot ${action.inventorySlot} became empty but no free slot was reported after consolidation.`,
        snapshot: current,
      };
    }

    const discard = await this.discardInventoryItem(
      { kind: "discard_inventory_item", inventorySlot: action.inventorySlot },
      current,
      steps,
    );
    if (discard.outcome !== "success") {
      return discard;
    }

    const returnToLoot = await this.returnToLoot(discard.snapshot, steps);
    if (returnToLoot.outcome !== "success") return returnToLoot;

    const take = await this.takeLootItem(
      { kind: "take_loot_item", itemIndex: action.itemIndex },
      returnToLoot.snapshot,
      steps,
      false,
    );
    if (take.outcome !== "success") return take;

    return {
      outcome: "success" as const,
      reason: `Discarded ${discarded.name} from inventory slot ${action.inventorySlot} and took ${wanted.name}.`,
      snapshot: take.snapshot,
    };
  }

  private async returnToLoot(before: CombatLogSnapshot, steps: ActionStepRecord[]) {
    const returned = await this.executeStep(
      "return_to_loot",
      before,
      { kind: "key_press", args: { sym: SDLK_r, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.currentContext === "loot" ||
        observations.some((record) => /^loot: back to the window/u.test(record.message ?? ""))
          ? { outcome: "success", reason: "Returned to the open loot window." }
          : undefined,
    );
    steps.push(returned.record);
    return this.resultFromStep(returned, "Returned to the open loot window.");
  }

  private async closeLoot(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const step = await this.executeStep(
      "close_loot",
      before,
      { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
      (snapshot, observations) =>
        snapshot.state.loot?.active !== true ||
        observations.some((record) => record.event?.kind === "loot_closed")
          ? { outcome: "success", reason: "The loot window closed." }
          : undefined,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Closed the loot window.");
  }

  private async moveHero(
    action: Extract<CopilotAction, { kind: "move_hero" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const move = before.state.combatActions.find((candidate) => candidate.kind === "reorder")!;
    let current = before;
    const select = await this.executeStep(
      "select_move",
      current,
      { kind: "click_element", args: { elementId: move.elementId } },
      (snapshot) => snapshot.state.phase === "targeting"
        ? { outcome: "success", reason: "Move targeting opened." }
        : undefined,
    );
    steps.push(select.record);
    if (select.record.outcome !== "success") return this.resultFromStep(select, "Selected Move.");
    current = select.snapshot;
    for (let i = 0; current.state.currentTarget?.slot !== action.toSlot && i < 6; i += 1) {
      const step = await this.executeStep(
        `move_target_next_${i + 1}`,
        current,
        { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
        (_snapshot, observations) => observations.some((record) => record.event?.kind === "target_preview")
          ? { outcome: "success", reason: "The move destination cursor advanced." }
          : undefined,
      );
      steps.push(step.record);
      current = step.snapshot;
      if (step.record.outcome !== "success") return this.resultFromStep(step, "Moved the destination cursor.");
    }
    if (current.state.currentTarget?.slot !== action.toSlot) {
      const cancel = await this.executeStep(
        "cancel_unavailable_move",
        current,
        { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
        (snapshot) => snapshot.state.phase !== "targeting"
          ? { outcome: "success", reason: "Unavailable move was cancelled." }
          : undefined,
      );
      steps.push(cancel.record);
      return { outcome: "failure" as const, reason: `Position ${action.toSlot} is not a legal move target.`, snapshot: cancel.snapshot };
    }
    const confirm = await this.executeStep(
      "confirm_move",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) => {
        if (observations.some((record) => /^move-watch: party order changed/u.test(record.message ?? ""))) {
          return { outcome: "success", reason: "The party order changed." };
        }
        if (observations.some((record) => /^move-watch: no reposition/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The game reported that no reposition occurred." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(confirm.record);
    return this.resultFromStep(confirm, `Moved the active hero toward position ${action.toSlot}.`);
  }

  private async focusInventorySlot(
    slot: number,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    const combatInterrupted = (snapshot: CombatLogSnapshot) =>
      snapshot.state.combatActive ||
      snapshot.state.phase === "combat" ||
      snapshot.state.phase === "targeting";
    const interruptedResult = (snapshot: CombatLogSnapshot) => ({
      outcome: "failure" as const,
      reason: "Combat began while focusing the inventory; no item input was sent.",
      snapshot,
    });
    if (combatInterrupted(current)) return interruptedResult(current);
    if (current.state.currentContext !== "inventory") {
      const open = await this.executeStep(
        "open_inventory",
        current,
        { kind: "key_press", args: { sym: SDLK_i, mod: 0 } },
        (snapshot) => snapshot.state.currentContext === "inventory"
          ? { outcome: "success", reason: "The raid inventory opened." }
          : undefined,
      );
      steps.push(open.record);
      if (open.record.outcome !== "success") return this.resultFromStep(open, "Opened the raid inventory.");
      current = open.snapshot;
      if (combatInterrupted(current)) return interruptedResult(current);
    }
    const home = await this.executeStep(
      "inventory_focus_first",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      keyAccepted(SDLK_HOME),
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") return this.resultFromStep(home, "Focused inventory slot 0.");
    current = home.snapshot;
    if (combatInterrupted(current)) return interruptedResult(current);
    const rows = Math.floor(slot / 8);
    const columns = slot % 8;
    for (let i = 0; i < rows; i += 1) {
      const down = await this.executeStep(
        `inventory_row_${i + 1}`,
        current,
        { kind: "key_press", args: { sym: SDLK_DOWN, mod: 0 } },
        keyAccepted(SDLK_DOWN),
      );
      steps.push(down.record);
      if (down.record.outcome !== "success") return this.resultFromStep(down, `Focused inventory slot ${slot}.`);
      current = down.snapshot;
      if (combatInterrupted(current)) return interruptedResult(current);
    }
    for (let i = 0; i < columns; i += 1) {
      const right = await this.executeStep(
        `inventory_column_${i + 1}`,
        current,
        { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
        keyAccepted(SDLK_RIGHT),
      );
      steps.push(right.record);
      if (right.record.outcome !== "success") return this.resultFromStep(right, `Focused inventory slot ${slot}.`);
      current = right.snapshot;
      if (combatInterrupted(current)) return interruptedResult(current);
    }
    return { outcome: "success" as const, reason: `Focused inventory slot ${slot}.`, snapshot: current };
  }

  private async useInventoryItem(
    action: Extract<CopilotAction, { kind: "use_inventory_item" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    return this.consumeInventoryItem(action.inventorySlot, inventoryTarget(before.state, action)?.actorGuid, before, steps);
  }

  // One transaction for food, torch, and other targeted consumables. ID selection
  // happens in the game thread; no localization or cursor-count dependency.
  private async consumeInventoryItem(
    slot: number, targetGuid: number | undefined, before: CombatLogSnapshot,
    steps: ActionStepRecord[], torch = false,
  ) {
    const item = before.state.inventory.find((entry) => entry.slot === slot)!;
    const focused = await this.focusInventorySlot(slot, before, steps);
    if (focused.outcome !== "success") return focused;
    const arm = await this.executeStep(
      torch ? `use_torch_from_slot_${slot}` : "arm_inventory_item",
      focused.snapshot, { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot, observations) => {
        if (observations.some((record) => /^itemuse: (?:no legal target|blocked|.* refused)/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The game refused this item use." };
        }
        if (observations.some((record) => new RegExp(`^itemuse: begin .* slot ${slot} targets=`).test(record.message ?? ""))) {
          return { outcome: "success", reason: "The requested inventory slot opened targeting." };
        }
        const reportedLight = observations.map((record) => /^light: ([-\d.]+) level=/u.exec(record.message ?? ""))
          .filter((match) => match !== null).at(-1);
        if (torch && before.state.light !== undefined &&
            Math.max(snapshot.state.light?.value ?? -1, Number(reportedLight?.[1] ?? -1)) > before.state.light.value) {
          return { outcome: "success", reason: "Light increased; checking the consumed stack." };
        }
        return undefined;
      }, this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(arm.record);
    if (arm.record.outcome !== "success") return this.resultFromStep(arm, "Armed the inventory item.");
    let current = arm.snapshot;
    const targeting = arm.record.observations.some((record) => /^itemuse: begin /u.test(record.message ?? ""));
    if (targeting) {
      if (targetGuid === undefined) {
        const cancel = await this.executeStep(
          "cancel_unresolved_inventory_target",
          current,
          { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
          (snapshot, observations) =>
            snapshot.state.currentContext !== "itemuse" ||
            observations.some((record) => /^itemuse: abandoned \(cancelled\)$/u.test(record.message ?? ""))
              ? { outcome: "success", reason: "The unresolved item target selector closed." }
              : undefined,
        );
        steps.push(cancel.record);
        return {
          outcome: "failure" as const,
          snapshot: cancel.snapshot,
          reason: cancel.record.outcome === "success"
            ? "No verified target GUID was available, so targeting was cancelled before item use."
            : "No verified target GUID was available and automatic cancellation was not verified. Refresh before further input.",
        };
      }
      const commit = await this.executeStep(
        "commit_inventory_target_by_guid", current,
        { kind: "commit_item_target", args: { targetGuid, inventorySlot: slot, expectedAmount: item.amount, itemKey: item.itemKey } },
        (_snapshot, observations) => {
          for (const record of observations) {
            const result = /^agent-item: result slot=(\d+) target_guid=(\d+) called=(\d+) ok=(\d+) before=(\d+) after=(\d+)$/u.exec(record.message ?? "");
            if (result === null) continue;
            if (Number(result[1]) !== slot || Number(result[2]) !== targetGuid) {
              return { outcome: "failure", reason: "Item result identified a different slot or recipient. Reconcile before further input." };
            }
            return result[3] === "1" && result[4] === "1" && Number(result[5]) === item.amount && Number(result[6]) === item.amount - 1
              ? { outcome: "success", reason: "The game consumed exactly one item for the requested GUID." }
              : { outcome: "failure", reason: "The game did not confirm the expected item consumption." };
          }
          return undefined;
        }, this.settlementTimeoutMilliseconds * 2,
      );
      steps.push(commit.record);
      if (commit.record.outcome !== "success") return this.resultFromStep(commit, "Committed inventory item.");
      current = commit.snapshot;
    }
    const inspection = await this.executeStep(
      torch ? "inspect_after_torch" : "inspect_after_inventory_item", current,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) => {
        if (!observations.some((record) => record.event?.kind === "agent_state_completed")) return undefined;
        const remaining = snapshot.state.inventory.find((entry) => entry.slot === slot);
        const amount = remaining === undefined ? 0 : remaining.itemKey === item.itemKey ? remaining.amount : -1;
        if (amount !== item.amount - 1) return { outcome: "failure", reason: "Fresh inventory does not confirm exactly one consumed item." };
        if (torch && before.state.light !== undefined && before.state.light.value < 100 &&
            (snapshot.state.light?.value ?? -1) <= before.state.light.value) {
          return { outcome: "failure", reason: "Torch consumption was reported, but fresh light did not increase." };
        }
        return { outcome: "success", reason: "Fresh party, inventory and light state confirm item use." };
      }, this.inspectionTimeoutMilliseconds * 2,
    );
    steps.push(inspection.record);
    return this.resultFromStep(inspection, `Used one ${item.itemId} from slot ${slot}.`);
  }

  private async discardInventoryItem(
    action: Extract<CopilotAction, { kind: "discard_inventory_item" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const focused = await this.focusInventorySlot(action.inventorySlot, before, steps);
    if (focused.outcome !== "success") return focused;
    const begin = await this.executeStep(
      "begin_discard",
      focused.snapshot,
      { kind: "key_press", args: { sym: SDLK_DELETE, mod: 0 } },
      (snapshot, observations) => {
        if (observations.some((record) => /^discard: .* gone /u.test(record.message ?? ""))) {
          return { outcome: "success", reason: "The item was discarded without a confirmation dialog." };
        }
        if (snapshot.state.currentContext === "dialog") {
          return { outcome: "success", reason: "The discard confirmation dialog opened." };
        }
        if (observations.some((record) => /^discard: .*FAULTED|^discard: no panel/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The game could not start the discard." };
        }
        return undefined;
      },
    );
    steps.push(begin.record);
    if (begin.record.outcome !== "success" || begin.snapshot.state.currentContext !== "dialog") {
      return this.resultFromStep(begin, `Discarded inventory slot ${action.inventorySlot}.`);
    }
    const confirm = await this.executeStep(
      "confirm_discard",
      begin.snapshot,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) => {
        if (observations.some((record) => /^discard: .* gone /u.test(record.message ?? ""))) {
          return { outcome: "success", reason: "The item amount decreased after confirmation." };
        }
        if (observations.some((record) => /^discard: dialog closed, .* kept/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The discard dialog closed without removing the item." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(confirm.record);
    return this.resultFromStep(confirm, `Discarded inventory slot ${action.inventorySlot}.`);
  }

  private async useTorch(before: CombatLogSnapshot, steps: ActionStepRecord[]) {
    const torch = before.state.inventory
      .filter((item) => item.itemId === "torch" && item.amount > 0)
      .sort((left, right) => left.amount - right.amount || left.slot - right.slot)[0]!;
    return this.consumeInventoryItem(torch.slot, inventoryTarget(before.state, {})?.actorGuid, before, steps, true);
  }

  private async chooseCampMeal(
    action: Extract<CopilotAction, { kind: "choose_camp_meal" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    const home = await this.executeStep("camp_meal_first", current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } }, keyAccepted(SDLK_HOME));
    steps.push(home.record);
    if (home.record.outcome !== "success") return this.resultFromStep(home, "Focused the first meal option.");
    current = home.snapshot;
    for (let i = 0; i < action.optionIndex; i += 1) {
      const right = await this.executeStep(`camp_meal_next_${i + 1}`, current,
        { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } }, keyAccepted(SDLK_RIGHT));
      steps.push(right.record);
      if (right.record.outcome !== "success") return this.resultFromStep(right, "Selected a camping meal.");
      current = right.snapshot;
    }
    const choose = await this.executeStep(
      "choose_camp_meal",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot, observations) => {
        if (observations.some((record) => /camp meal: option \d+ refused/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The selected meal was refused." };
        }
        return snapshot.state.camp?.phase === 6 ||
          observations.some((record) => /^camp: phase 3 -> 6 /u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The meal advanced into the respite phase." }
          : undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(choose.record);
    if (choose.record.outcome !== "success") {
      return this.resultFromStep(choose, `Chose camping meal option ${action.optionIndex}.`);
    }
    const previousCompletedTick = choose.snapshot.state.inspection?.completedTick;
    const inspection = await this.executeStep(
      "inspect_after_camp_meal",
      choose.snapshot,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) =>
        observations.some((record) => record.event?.kind === "agent_state_completed") &&
        snapshot.state.inspection?.completedTick !== previousCompletedTick &&
        snapshot.state.camp?.phase === 6 &&
        snapshot.state.camp.points !== undefined
          ? {
              outcome: "success",
              reason: `Verified respite phase with ${snapshot.state.camp.points} points after the meal.`,
            }
          : undefined,
      this.inspectionTimeoutMilliseconds * 2,
    );
    steps.push(inspection.record);
    return this.resultFromStep(
      inspection,
      `Chose camping meal option ${action.optionIndex} and verified the respite state.`,
    );
  }

  private async useCampSkill(
    action: Extract<CopilotAction, { kind: "use_camp_skill" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const pointsBefore = before.state.camp?.points;
    const skill = before.state.combatActions.find(
      (candidate) => candidate.kind === "skill" && candidate.skillSlot === action.skillSlot,
    )!;
    let current = before;
    const select = await this.executeStep(
      "select_camp_skill",
      current,
      { kind: "click_element", args: { elementId: skill.elementId } },
      (snapshot, observations) => {
        if (snapshot.state.currentContext === "camptarget") {
          return { outcome: "success", reason: "The camping target selector opened." };
        }
        if (observations.some((record) => /^camp: respite points \d+ -> \d+/u.test(record.message ?? ""))) {
          return { outcome: "success", reason: "The camping skill spent respite points." };
        }
        if (observations.some((record) => /Already used|Not enough time|perform call faulted/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The camping skill was refused." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(select.record);
    if (select.record.outcome !== "success" || select.snapshot.state.currentContext !== "camptarget") {
      if (select.record.outcome !== "success") return this.resultFromStep(select, "Selected camping skill.");
      return this.inspectUntil("inspect_after_camp_skill", select.snapshot, steps,
        (state) => pointsBefore !== undefined && (state.camp?.points ?? pointsBefore) < pointsBefore,
        `Used camping skill slot ${action.skillSlot}.`);
    }
    current = select.snapshot;
    const target = action.targetHeroGuid === undefined && action.targetIndex === undefined
      ? undefined : inventoryTarget(before.state, action);
    const actor = before.state.combatants.find((candidate) => candidate.side === "party" && candidate.active);
    if (target === undefined || actor?.actorGuid === undefined) return {
      outcome: "failure" as const, snapshot: current,
      reason: "Camping target/performer GUID is unavailable. Cancel and refresh; no target was committed.",
    };
    const confirm = await this.executeStep(
      "confirm_camp_skill",
      current,
      { kind: "commit_camp_target", args: { targetGuid: target.actorGuid, actorGuid: actor.actorGuid, skillElementId: skill.elementId } },
      (snapshot, observations) => observations.some((record) => (record.message ?? "").startsWith(`camp target: agent selected guid=${target.actorGuid} `)) &&
        (observations.some((record) => /^camp: respite points \d+ -> \d+/u.test(record.message ?? "")) ||
        (pointsBefore !== undefined && snapshot.state.camp?.points !== undefined && snapshot.state.camp.points < pointsBefore))
          ? { outcome: "success", reason: "The camping skill spent respite points." }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(confirm.record);
    if (confirm.record.outcome !== "success") return this.resultFromStep(confirm, "Committed camping skill.");
    return this.inspectUntil("inspect_after_camp_skill", confirm.snapshot, steps,
      (state) => pointsBefore !== undefined && (state.camp?.points ?? pointsBefore) < pointsBefore,
      `Used camping skill slot ${action.skillSlot}.`);
  }

  private async finishCamp(before: CombatLogSnapshot, steps: ActionStepRecord[]) {
    const rest = before.state.combatActions.find((candidate) => candidate.kind === "rest")!;
    const step = await this.executeStep(
      "finish_camp",
      before,
      { kind: "click_element", args: { elementId: rest.elementId } },
      (snapshot, observations) => snapshot.state.camp?.phase !== 6 ||
        observations.some((record) => /^camp: phase 6 -> /u.test(record.message ?? ""))
          ? { outcome: "success", reason: "The respite phase ended." }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Finished camping.");
  }

  private async useQuestControl(
    action: Extract<CopilotAction, { kind: "retreat_combat" | "abandon_expedition" | "finish_quest" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    if (current.state.currentContext !== "quest") {
      const open = await this.executeStep("open_quest_zone", current,
        { kind: "key_press", args: { sym: SDLK_g, mod: 0 } },
        (snapshot) => snapshot.state.currentContext === "quest"
          ? { outcome: "success", reason: "The quest zone opened." }
          : undefined);
      steps.push(open.record);
      if (open.record.outcome !== "success") return this.resultFromStep(open, "Opened the quest zone.");
      current = open.snapshot;
    }
    const end = await this.executeStep("focus_quest_control", current,
      { kind: "key_press", args: { sym: SDLK_END, mod: 0 } }, keyAccepted(SDLK_END));
    steps.push(end.record);
    if (end.record.outcome !== "success") return this.resultFromStep(end, "Focused the quest control.");
    current = end.snapshot;
    const activate = await this.executeStep(
      "activate_quest_control",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot, observations) => {
        if (snapshot.state.currentContext === "dialog") return { outcome: "success", reason: "The confirmation dialog opened." };
        if (snapshot.state.currentContext === "questdone" || snapshot.state.currentContext === "raidfinish" ||
            (action.kind === "retreat_combat" && !snapshot.state.combatActive)) {
          return { outcome: "success", reason: "The quest control changed the raid state." };
        }
        if (observations.some((record) => /click refused|call FAULTED|no confirm dialog/u.test(record.message ?? ""))) {
          return { outcome: "failure", reason: "The game refused the quest control." };
        }
        return undefined;
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(activate.record);
    if (activate.record.outcome !== "success" || activate.snapshot.state.currentContext !== "dialog") {
      return this.resultFromStep(activate, `Activated ${action.kind}.`);
    }
    const confirm = await this.executeStep(
      "confirm_quest_control",
      activate.snapshot,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot) => snapshot.state.currentContext !== "dialog"
        ? { outcome: "success", reason: "The confirmation dialog closed and the raid state advanced." }
        : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(confirm.record);
    return this.resultFromStep(confirm, `Confirmed ${action.kind}.`);
  }

  private async chooseQuestCompletion(
    action: Extract<CopilotAction, { kind: "choose_quest_completion" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    let current = before;
    const direction = action.destination === "hamlet" ? SDLK_LEFT : SDLK_RIGHT;
    const focus = await this.executeStep("focus_quest_completion", current,
      { kind: "key_press", args: { sym: direction, mod: 0 } }, keyAccepted(direction));
    steps.push(focus.record);
    if (focus.record.outcome !== "success") return this.resultFromStep(focus, "Focused a quest-complete choice.");
    current = focus.snapshot;
    const choose = await this.executeStep(
      "choose_quest_completion",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (snapshot, observations) => snapshot.state.currentContext !== "questdone" ||
        observations.some((record) => /qcwatch: .* took/u.test(record.message ?? ""))
          ? { outcome: "success", reason: `The ${action.destination} choice took effect.` }
          : undefined,
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(choose.record);
    return this.resultFromStep(choose, `Chose ${action.destination} after quest completion.`);
  }

  private async continueResults(before: CombatLogSnapshot, steps: ActionStepRecord[]) {
    const previousState = before.state.results?.state;
    const settled = (snapshot: CombatLogSnapshot, observations: BlindestLogRecord[]) => {
      if (snapshot.state.currentContext !== "results") {
        return { outcome: "success" as const, reason: "The results screen closed." };
      }
      if (observations.some((record) => /^results: page ->/u.test(record.message ?? "")) ||
          snapshot.state.results?.state !== previousState) {
        return { outcome: "success" as const, reason: "The results screen advanced." };
      }
      if (observations.some((record) => /^results: reveal observed\b/u.test(record.message ?? ""))) {
        return { outcome: "success" as const, reason: "The hero-result reveal started." };
      }
      return undefined;
    };
    const step = await this.executeStep(
      "continue_results",
      before,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      settled,
      Math.min(this.settlementTimeoutMilliseconds * 2, 1_500),
    );
    steps.push(step.record);
    const revealStarted = step.record.observations.some((record) =>
      /^results: reveal observed\b/u.test(record.message ?? ""),
    );
    if (revealStarted || step.record.outcome !== "uncertain" ||
        step.snapshot.state.currentContext !== "results" ||
        step.snapshot.state.results?.state !== previousState) {
      return this.resultFromStep(step, "Advanced the expedition results.");
    }

    // A click made while the page is still animating may be accepted by the
    // game thread without changing the page. Retry once after a short bounded
    // wait instead of consuming the general settlement timeout.
    await delay(250);
    const retry = await this.executeStep(
      "continue_results_after_settle",
      step.snapshot,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      settled,
      Math.min(this.settlementTimeoutMilliseconds * 2, 1_500),
    );
    steps.push(retry.record);
    return this.resultFromStep(retry, "Advanced the expedition results after its reveal animation settled.");
  }

  private async recruitStageCoachHero(
    action: Extract<CopilotAction, { kind: "recruit_stage_coach_hero" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const available = before.state.buildingHeroes;
    const targetIndex = available.findIndex(
      (hero) => hero.heroAddress === action.heroAddress,
    );
    const target = available[targetIndex]!;
    let current = before;

    const acceptedKey = (sym: number) =>
      (_snapshot: CombatLogSnapshot, observations: BlindestLogRecord[]) =>
        observations.some((record) =>
          new RegExp(
            `^agent-ipc: serviced key sym=0x${sym.toString(16)} mod=0x0 accepted=1$`,
            "u",
          ).test(record.message ?? ""),
        )
          ? {
              outcome: "success" as const,
              reason: "The game thread accepted the navigation input.",
            }
          : undefined;

    const home = await this.executeStep(
      "recruit_focus_first",
      current,
      { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
      acceptedKey(SDLK_HOME),
    );
    steps.push(home.record);
    if (home.record.outcome !== "success") {
      return this.resultFromStep(home, "Focused the first Stagecoach hero.");
    }
    current = home.snapshot;

    for (let index = 0; index < targetIndex; index += 1) {
      const down = await this.executeStep(
        `recruit_focus_next_${index + 1}`,
        current,
        { kind: "key_press", args: { sym: SDLK_DOWN, mod: 0 } },
        acceptedKey(SDLK_DOWN),
      );
      steps.push(down.record);
      if (down.record.outcome !== "success") {
        return this.resultFromStep(down, "Moved the Stagecoach selection.");
      }
      current = down.snapshot;
    }

    const arm = await this.executeStep(
      "arm_recruit",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) => {
        const pending = observations.find(
          (record) => record.event?.kind === "recruit_pending",
        )?.event;
        if (pending?.kind !== "recruit_pending") return undefined;
        if (pending.heroAddress !== target.heroAddress) {
          return {
            outcome: "failure",
            reason: `Stagecoach focus resolved to ${pending.name}, not ${target.name}.`,
          };
        }
        if (pending.rosterCount >= pending.rosterCapacity) {
          return { outcome: "failure", reason: "The hero roster is full." };
        }
        return {
          outcome: "success",
          reason: `Recruitment of ${target.name} is armed for confirmation.`,
        };
      },
    );
    steps.push(arm.record);
    if (arm.record.outcome !== "success") {
      const pending = arm.snapshot.state.recruitment?.pending;
      if (pending !== undefined) {
        const cancel = await this.executeStep(
          "cancel_recruit",
          arm.snapshot,
          { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
          (_snapshot, observations) =>
            observations.some(
              (record) => record.event?.kind === "recruit_cancelled",
            )
              ? { outcome: "success", reason: "Recruitment was cancelled safely." }
              : undefined,
        );
        steps.push(cancel.record);
      }
      return this.resultFromStep(arm, `Selected ${target.name} for recruitment.`);
    }

    const confirm = await this.executeStep(
      "confirm_recruit",
      arm.snapshot,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) => {
        const recruited = observations.find(
          (record) => record.event?.kind === "hero_recruited",
        )?.event;
        return recruited?.kind === "hero_recruited"
          ? {
              outcome: "success",
              reason: `Roster count changed ${recruited.previousRosterCount} -> ${recruited.rosterCount}.`,
            }
          : undefined;
      },
    );
    steps.push(confirm.record);
    return this.resultFromStep(confirm, `Recruited ${target.name}.`);
  }

  private async runTownIdentityCommand(
    name: string,
    before: CombatLogSnapshot,
    command: GameCommand,
    verify: (snapshot: CombatLogSnapshot) => { outcome: "success" | "failure"; reason: string } | undefined,
    steps: ActionStepRecord[],
    summary: string,
  ) {
    const sent = await this.executeStep(
      name,
      before,
      command,
      (snapshot, observations) => {
        const line = observations.find((record) =>
          (record.message ?? "").startsWith(`agent-ipc: serviced ${command.kind}`));
        if ((line?.message ?? "").endsWith("accepted=1"))
          return { outcome: "success" as const, reason: "The game-thread identity command was accepted." };
        if ((line?.message ?? "").endsWith("accepted=0"))
          return { outcome: "failure" as const, reason: "The game rejected the requested identity operation." };
        return undefined;
      },
    );
    steps.push(sent.record);
    if (sent.record.outcome !== "success") return this.resultFromStep(sent, summary);
    const inspected = await this.executeStep(
      `${name}_inspect`,
      sent.snapshot,
      { kind: "inspect_state", args: {} },
      (snapshot, observations) =>
        observations.some((record) => record.event?.kind === "agent_state_completed")
          ? verify(snapshot)
          : undefined,
      this.inspectionTimeoutMilliseconds,
    );
    steps.push(inspected.record);
    return this.resultFromStep(inspected, summary);
  }

  private async selectBuildingHero(
    action: Extract<CopilotAction, { kind: "select_building_hero" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    return this.runTownIdentityCommand(
      "select_building_hero", before,
      { kind: "select_building_hero", args: { heroGuid: action.heroGuid } },
      (snapshot) => snapshot.state.buildingDetails?.selectedHeroGuid === action.heroGuid
        ? { outcome: "success", reason: `Hero GUID ${action.heroGuid} is selected.` } : undefined,
      steps, `Selected building hero ${action.heroGuid}.`,
    );
  }

  private async buyHeroUpgrade(
    action: Extract<CopilotAction, { kind: "buy_hero_upgrade" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    return this.runTownIdentityCommand(
      "buy_hero_upgrade", before,
      { kind: "buy_hero_upgrade", args: {
        heroGuid: action.heroGuid, optionId: action.optionId, stepCode: action.stepCode,
      } },
      (snapshot) => snapshot.state.buildingDetails?.heroOptions
        .find((option) => option.optionId === action.optionId)?.stepDetails
        .find((step) => step.code === action.stepCode)?.purchased
        ? { outcome: "success", reason: `${action.optionId}/${action.stepCode} is now purchased.` }
        : undefined,
      steps, `Bought ${action.optionId}/${action.stepCode} for hero ${action.heroGuid}.`,
    );
  }

  private async buyTownItem(
    action: Extract<CopilotAction, { kind: "buy_town_item" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const beforeCount = before.state.buildingDetails?.shopItems.filter(
      (item) => item.itemId === action.itemId).length ?? 0;
    return this.runTownIdentityCommand(
      "buy_town_item", before,
      { kind: "buy_town_item", args: { itemId: action.itemId } },
      (snapshot) => (snapshot.state.buildingDetails?.shopItems.filter(
        (item) => item.itemId === action.itemId).length ?? 0) < beforeCount
        ? { outcome: "success", reason: `${action.itemId} left the shop inventory.` } : undefined,
      steps, `Bought town item ${action.itemId}.`,
    );
  }

  private async assignTownActivity(
    action: Extract<CopilotAction, { kind: "assign_town_activity" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    return this.runTownIdentityCommand(
      "assign_town_activity", before,
      { kind: "assign_town_activity", args: {
        activityId: action.activityId, slot: action.slot, heroGuid: action.heroGuid,
      } },
      (snapshot) => snapshot.state.buildingDetails?.activities.some((row) =>
        row.activityId === action.activityId && row.slot === action.slot &&
        row.committedHeroGuid === action.heroGuid)
        ? { outcome: "success", reason: `Hero ${action.heroGuid} is committed to ${action.activityId} slot ${action.slot}.` }
        : undefined,
      steps, `Assigned hero ${action.heroGuid} to ${action.activityId} slot ${action.slot}.`,
    );
  }

  private async cancelTownActivity(
    action: Extract<CopilotAction, { kind: "cancel_town_activity" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    return this.runTownIdentityCommand(
      "cancel_town_activity", before,
      { kind: "cancel_town_activity", args: { activityId: action.activityId, slot: action.slot } },
      (snapshot) => {
        const row = snapshot.state.buildingDetails?.activities.find((candidate) =>
          candidate.activityId === action.activityId && candidate.slot === action.slot);
        return row !== undefined && row.committedHeroGuid === undefined && row.pendingHeroGuid === undefined
          ? { outcome: "success", reason: `${action.activityId} slot ${action.slot} is empty.` }
          : undefined;
      },
      steps, `Cancelled ${action.activityId} slot ${action.slot}.`,
    );
  }

  private async openBuildingUpgrades(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    return this.runTownIdentityCommand(
      "open_building_upgrades", before,
      { kind: "open_building_upgrades", args: {} },
      (snapshot) => snapshot.state.buildingDetails?.mode === 1
        ? { outcome: "success", reason: "The building upgrade screen is active." } : undefined,
      steps, "Opened the building upgrade screen.",
    );
  }

  private async buyBuildingUpgrade(
    action: Extract<CopilotAction, { kind: "buy_building_upgrade" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const oldBought = before.state.buildingDetails?.upgrades.find(
      (track) => track.trackId === action.trackId)?.bought ?? -1;
    return this.runTownIdentityCommand(
      "buy_building_upgrade", before,
      { kind: "buy_building_upgrade", args: { trackId: action.trackId, stepCode: action.stepCode } },
      (snapshot) => (snapshot.state.buildingDetails?.upgrades.find(
        (track) => track.trackId === action.trackId)?.bought ?? -1) > oldBought
        ? { outcome: "success", reason: `${action.trackId}/${action.stepCode} is now purchased.` }
        : undefined,
      steps, `Bought building upgrade ${action.trackId}/${action.stepCode}.`,
    );
  }

  private async closeBuilding(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const step = await this.executeStep(
      "close_building",
      before,
      { kind: "activate_element", args: { elementId: BLD_ELEM_BACK } },
      (snapshot) =>
        snapshot.state.phase === "town" &&
        snapshot.state.currentContext === "townmap"
          ? { outcome: "success", reason: "The town map became active." }
          : undefined,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Closed the building and returned to town.");
  }

  private async assignCircusContestant(
    action: Extract<CopilotAction, { kind: "assign_circus_contestant" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const normalizedAddress = action.heroAddress.replace(/^0x/iu, "");
    const contestant = before.state.circus?.contestants.find(
      (row) => row.heroAddress.toLowerCase() === normalizedAddress.toLowerCase(),
    );
    const wantedSlot = (before.state.circus?.slotCount ?? 4) - action.rank;
    const step = await this.executeStep(
      "assign_circus_contestant",
      before,
      { kind: "assign_circus_contestant", args: { heroAddress: `0x${normalizedAddress}`, rank: action.rank } },
      (snapshot, observations) => {
        const result = observations.find(
          (record) => record.event?.kind === "circus_assignment_observed" &&
            record.event.heroAddress.toLowerCase() === normalizedAddress.toLowerCase(),
        )?.event;
        if (result?.kind !== "circus_assignment_observed") return undefined;
        if (!result.observed || result.slot !== wantedSlot) {
          return { outcome: "failure", reason: "The game did not place the contestant in the requested rank." };
        }
        return { outcome: "success", reason: `${contestant?.name ?? normalizedAddress} occupies arena rank ${action.rank}.` };
      },
    );
    steps.push(step.record);
    return this.resultFromStep(step, `Assigned ${contestant?.name ?? normalizedAddress} to arena rank ${action.rank}.`);
  }

  private async activateCircusHero(
    action: Extract<CopilotAction, { kind: "activate_circus_hero" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const hero = before.state.circusCombat?.heroes.find(
      (candidate) => candidate.actorGuid === action.actorGuid,
    );
    const step = await this.executeStep(
      "activate_circus_hero",
      before,
      { kind: "activate_circus_hero", args: { actorGuid: action.actorGuid } },
      (snapshot, observations) => {
        const result = observations.find(
          (record) => record.event?.kind === "circus_hero_activation_observed" &&
            record.event.actorGuid === action.actorGuid,
        )?.event;
        if (result?.kind !== "circus_hero_activation_observed") return undefined;
        if (!result.observed) {
          return { outcome: "failure", reason: "The arena did not hand the turn to the requested hero." };
        }
        const actor = snapshot.state.combatants.find(
          (candidate) => candidate.side === "party" && candidate.actorGuid === action.actorGuid && candidate.active,
        );
        return actor !== undefined || snapshot.state.circusCombat?.heroes.some(
          (candidate) => candidate.actorGuid === action.actorGuid && candidate.active,
        )
          ? { outcome: "success", reason: `${hero?.name ?? action.actorGuid} now owns the arena action bar.` }
          : undefined;
      },
    );
    steps.push(step.record);
    if (step.record.outcome !== "success") {
      return this.resultFromStep(step, `Activated arena hero ${hero?.name ?? action.actorGuid}.`);
    }
    const inspected = await this.executeStep(
      "inspect_circus_action_bar",
      step.snapshot,
      { kind: "inspect_state", args: {} },
      (snapshot) => snapshot.state.combatActions.some((item) => item.kind === "skill")
        ? { outcome: "success", reason: "The activated hero's arena skills are available." }
        : undefined,
    );
    steps.push(inspected.record);
    return this.resultFromStep(inspected, `Activated ${hero?.name ?? action.actorGuid} and inspected the arena action bar.`);
  }

  private async dismissModal(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const townEvent = before.state.currentContext === "townevent";
    const tutorial = before.state.currentContext === "tutorial" || before.state.activeTutorial !== undefined;
    const step = await this.executeStep(
      townEvent ? "dismiss_town_event" : "dismiss_modal",
      before,
      { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
      (snapshot, observations) => {
        if (townEvent) {
          const leftTownEvent =
            snapshot.state.currentContext !== "townevent" ||
            observations.some(
              (record) =>
                record.event?.kind === "context_changed" &&
                record.event.context !== "townevent",
            );
          return leftTownEvent
            ? { outcome: "success", reason: "The town-event notice closed." }
            : undefined;
        }
        if (tutorial) {
          return snapshot.state.currentContext !== "tutorial" && snapshot.state.activeTutorial === undefined
            ? { outcome: "success", reason: "The tutorial closed." }
            : undefined;
        }
        return snapshot.state.phase !== "modal"
          ? { outcome: "success", reason: "The modal closed." }
          : undefined;
      },
    );
    steps.push(step.record);
    if (step.record.outcome !== "success") {
      return this.resultFromStep(step, "Dismissed the modal.");
    }

    // DD1 opens the pause menu after Escape dismisses some town-event notices.
    // Treat that as a deterministic follow-up instead of leaving a new modal
    // behind for the caller to discover and close in another round trip.
    if (townEvent && step.snapshot.state.currentContext === "pause") {
      const pause = await this.executeStep(
        "dismiss_pause_after_town_event",
        step.snapshot,
        { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
        (snapshot) =>
          snapshot.state.currentContext !== "pause"
            ? { outcome: "success", reason: "The pause menu closed." }
            : undefined,
      );
      steps.push(pause.record);
      return this.resultFromStep(pause, "Dismissed the town event and its follow-up pause menu.");
    }

    return this.resultFromStep(step, "Dismissed the modal.");
  }

  private async cancelTargeting(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const inventoryItemTargeting = before.state.currentContext === "itemuse";
    const step = await this.executeStep(
      "cancel_targeting",
      before,
      { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
      (snapshot) =>
        snapshot.state.phase !== "targeting" &&
        snapshot.state.currentContext !== "itemuse"
          ? { outcome: "success", reason: "The target selector closed." }
          : undefined,
    );
    steps.push(step.record);
    return this.resultFromStep(
      step,
      inventoryItemTargeting
        ? "Cancelled inventory item target selection."
        : "Cancelled target selection.",
    );
  }

  private async passTurn(
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const pass = before.state.combatActions.find(
      (candidate) => candidate.kind === "pass",
    )!;
    const step = await this.executeStep(
      "pass_turn",
      before,
      {
        kind: "click_element",
        args: { elementId: pass.elementId },
      },
      (_snapshot, observations) => {
        const evidence = observations.find((record) => {
          const kind = record.event?.kind;
          return (
            kind === "actor_changed" ||
            kind === "combat_result" ||
            kind === "combat_buff" ||
            kind === "combat_ended"
          );
        });
        return evidence === undefined
          ? undefined
          : {
              outcome: "success",
              reason: `The passed turn settled (${evidence.event?.kind}).`,
            };
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(step.record);
    return this.resultFromStep(step, "Passed the current hero's turn.");
  }

  private async useSkill(
    action: Extract<CopilotAction, { kind: "use_skill" }>,
    before: CombatLogSnapshot,
    steps: ActionStepRecord[],
  ) {
    const skill = resolveSkill(before.state, action)!;
    const skillSlot = skill.skillSlot!;
    const noTarget = skillNeedsNoTarget(skill);
    const actorCombatant = before.state.combatants.find(
      (candidate) =>
        candidate.actorAddress === before.state.currentActor?.address ||
        (before.state.currentActor?.address === undefined && candidate.active),
    );
    const requestedCombatant = action.target === undefined
      ? noTarget ? actorCombatant : undefined
      : resolveRequestedTarget(before.state, action.target);
    const effectiveTarget = requestedCombatant === undefined
      ? undefined
      : {
          side: requestedCombatant.side,
          slot: requestedCombatant.slot,
          targetGuid: requestedCombatant.actorGuid,
        };
    let current = before;
    let select = await this.executeStep(
      "select_skill",
      current,
      actorCombatant?.actorGuid === undefined
        ? { kind: "click_element", args: { elementId: skill.elementId } }
        : { kind: "activate_combat_skill", args: { actorGuid: actorCombatant.actorGuid, skillElementId: skill.elementId } },
      (snapshot, observations) => {
        const armed = observations.find(
          (record) =>
            record.event?.kind === "skill_armed" &&
            record.event.skillSlot === skillSlot,
        );
        const initialTarget = observations.find(
          (record) => record.event?.kind === "target_preview",
        );
        const settlement = observations.find((record) =>
          ["combat_result", "combat_buff", "actor_changed", "enemy_count_changed", "combat_ended", "loot_opened"].includes(
            record.event?.kind ?? "",
          ),
        );
        return settlement !== undefined && noTarget
          ? {
              outcome: "success",
              reason: `The no-target skill settled immediately (${settlement.event?.kind}).`,
            }
          : (armed !== undefined && initialTarget !== undefined) ||
              (before.state.phase !== "targeting" &&
                snapshot.state.phase === "targeting" &&
                snapshot.state.currentTarget !== undefined)
            ? {
              outcome: "success",
              reason: `Skill slot ${skillSlot} opened targeting and the target cursor is ready.`,
              }
            : undefined;
      },
      Math.min(this.settlementTimeoutMilliseconds, 1_500),
    );
    steps.push(select.record);
    if (select.record.outcome !== "success") {
      return this.resultFromStep(select, "Selected the skill.");
    }
    current = select.snapshot;
    if (
      noTarget &&
      select.record.observations.some((record) =>
        ["combat_result", "combat_buff", "actor_changed", "enemy_count_changed", "combat_ended", "loot_opened"].includes(
          record.event?.kind ?? "",
        ),
      )
    ) {
      return this.resultFromStep(select, `Used no-target skill slot ${skillSlot}.`);
    }
    if (effectiveTarget === undefined) {
      return {
        outcome: "failure" as const,
        reason: `Skill slot ${skillSlot} requires a target, but none was supplied.`,
        snapshot: current,
      };
    }

    if (effectiveTarget.targetGuid !== undefined && actorCombatant?.actorGuid !== undefined) {
      const confirm = await this.executeStep(
        "commit_skill_target_by_guid",
        current,
        {
          kind: "commit_combat_target",
          args: { targetGuid: effectiveTarget.targetGuid,
            actorGuid: actorCombatant?.actorGuid,
            skillElementId: skill.elementId },
        },
        (_snapshot, observations) => {
          const selected = observations.findIndex((record) =>
            (record.message ?? "").startsWith(`targeting: agent selected guid=${effectiveTarget.targetGuid} `));
          if (selected < 0) return undefined;
          const refusal = observations.slice(selected + 1).find((record) =>
            /^targeting: refused commit/u.test(record.message ?? ""));
          if (refusal) return { outcome: "failure", reason: "The game refused the GUID skill commit." };
          const evidence = observations.slice(selected + 1).find((record) => {
            const kind = record.event?.kind;
            return (
              kind === "combat_result" ||
              kind === "combat_buff" ||
              kind === "actor_changed" ||
              kind === "enemy_count_changed" ||
              kind === "combat_ended" ||
              kind === "loot_opened"
            );
          });
          return evidence === undefined
            ? undefined
            : {
                outcome: "success",
                reason: `Combat settlement was observed after GUID targeting (${evidence.event?.kind}).`,
              };
        },
        this.settlementTimeoutMilliseconds * 2,
      );
      steps.push(confirm.record);
      return this.resultFromStep(
        confirm,
        `Used skill slot ${skillSlot} on target GUID ${effectiveTarget.targetGuid}.`,
      );
    }

    const firstTarget = current.state.currentTarget;
    const navigationLimit = Math.min(
      8,
      Math.max(
        1,
        firstTarget?.targetCount ?? current.state.combatants.length,
      ),
    );
    for (
      let index = 0;
      !targetMatches(current.state, effectiveTarget) && index < navigationLimit;
      index += 1
    ) {
      const previousTarget = current.state.currentTarget;
      const moveRight =
        previousTarget?.side !== effectiveTarget.side ||
        (effectiveTarget.side === "enemy"
          ? effectiveTarget.slot > (previousTarget?.slot ?? 0)
          : effectiveTarget.slot < (previousTarget?.slot ?? Number.POSITIVE_INFINITY));
      const navigationSym = moveRight ? SDLK_RIGHT : SDLK_LEFT;
      const navigate = await this.executeStep(
        `target_next_${index + 1}`,
        current,
        { kind: "key_press", args: { sym: navigationSym, mod: 0 } },
        (_snapshot, observations) => {
          const preview = observations.find(
            (record) =>
              record.event?.kind === "target_preview" &&
              (record.event.targetIndex !== previousTarget?.targetIndex ||
                record.event.side !== previousTarget?.side ||
                record.event.slot !== previousTarget?.slot),
          );
          return preview === undefined
            ? undefined
            : { outcome: "success", reason: "The target cursor moved." };
        },
      );
      steps.push(navigate.record);
      current = navigate.snapshot;
      if (navigate.record.outcome !== "success") {
        return this.resultFromStep(navigate, "Moved the target cursor.");
      }
    }

    if (!targetMatches(current.state, effectiveTarget)) {
      const cancel = await this.executeStep(
        "cancel_invalid_target",
        current,
        { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
        (snapshot) =>
          snapshot.state.phase !== "targeting"
            ? { outcome: "success", reason: "Targeting was cancelled safely." }
            : undefined,
      );
      steps.push(cancel.record);
      return {
        outcome:
          cancel.record.outcome === "success"
            ? ("failure" as const)
            : ("uncertain" as const),
        reason:
          cancel.record.outcome === "success"
            ? `The chosen skill cannot target ${effectiveTarget.side} slot ${effectiveTarget.slot}.`
            : "The requested target was not found and cancellation could not be verified.",
        snapshot: cancel.snapshot,
      };
    }

    const confirm = await this.executeStep(
      "confirm_skill_target",
      current,
      { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
      (_snapshot, observations) => {
        const evidence = observations.find((record) => {
          const kind = record.event?.kind;
          return (
            kind === "combat_result" ||
            kind === "combat_buff" ||
            kind === "actor_changed" ||
            kind === "enemy_count_changed" ||
            kind === "combat_ended" ||
            kind === "loot_opened"
          );
        });
        return evidence === undefined
          ? undefined
          : {
              outcome: "success",
              reason: `Combat settlement was observed (${evidence.event?.kind}).`,
            };
      },
      this.settlementTimeoutMilliseconds * 2,
    );
    steps.push(confirm.record);
    return this.resultFromStep(
      confirm,
      noTarget
        ? `Used no-target skill slot ${skillSlot}.`
        : `Used skill slot ${skillSlot} on ${effectiveTarget.side} slot ${effectiveTarget.slot}.`,
    );
  }

  private async executeStep(
    name: string,
    before: CombatLogSnapshot,
    command: { kind: string; args: Record<string, unknown> },
    evaluate: (
      snapshot: CombatLogSnapshot,
      observations: BlindestLogRecord[],
    ) => StepEvaluation | undefined,
    timeoutMilliseconds = this.settlementTimeoutMilliseconds,
  ): Promise<StepResult> {
    const acknowledgement = await this.game.send(command).catch((error) => ({
      commandId: "unknown", transport: "unavailable" as const, status: "timeout" as const,
      receivedAt: new Date().toISOString(), reason: `Command submission interrupted: ${error instanceof Error ? error.message : String(error)}. Execution is unknown.`,
    }));
    const transportOutcome =
      acknowledgement.status === "timeout"
        ? ("uncertain" as const)
        : acknowledgement.status === "rejected" ||
            acknowledgement.status === "unavailable"
          ? ("failure" as const)
          : undefined;
    if (transportOutcome !== undefined) {
      return {
        snapshot: before,
        record: {
          name,
          sourceRevision: before.revision,
          finalRevision: before.revision,
          outcome: transportOutcome,
          reason:
            acknowledgement.reason ??
            `Primitive command was ${acknowledgement.status}.`,
          primitiveCommand: command,
          acknowledgement,
          observations: [],
        },
      };
    }

    const deadline = Date.now() + timeoutMilliseconds;
    let snapshot = before;
    let observations: BlindestLogRecord[] = [];
    while (Date.now() <= deadline) {
      snapshot = await this.game.refresh();
      observations = this.game.recordsAfter(before.revision, 2_000);
      const commandStart = observations.findIndex((record) => record.message === `agent-command: begin id=${acknowledgement.commandId}`);
      if (commandStart >= 0) observations = observations.slice(commandStart);
      const rejected = commandStart >= 0
        ? observations.some((record) => record.message === `agent-command: end id=${acknowledgement.commandId} accepted=0`)
        : observations.some((record) => /^agent-ipc: serviced .* accepted=0$/u.test(record.message ?? ""));
      if (rejected) {
        return {
          snapshot,
          record: {
            name,
            sourceRevision: before.revision,
            finalRevision: snapshot.revision,
            outcome: "failure",
            reason: "The game thread explicitly rejected the primitive input.",
            primitiveCommand: command,
            acknowledgement,
            observations: observations.map(compactRecord),
          },
        };
      }
      const evaluation = evaluate(snapshot, observations);
      if (evaluation !== undefined) {
        return {
          snapshot,
          record: {
            name,
            sourceRevision: before.revision,
            finalRevision: snapshot.revision,
            outcome: evaluation.outcome,
            reason: evaluation.reason,
            primitiveCommand: command,
            acknowledgement,
            observations: observations.map(compactRecord),
          },
        };
      }
      await delay(this.pollIntervalMilliseconds);
    }

    return {
      snapshot,
      record: {
        name,
        sourceRevision: before.revision,
        finalRevision: snapshot.revision,
        outcome: "uncertain",
        reason:
          "No semantic completion evidence arrived before the step timeout.",
        primitiveCommand: command,
        acknowledgement,
        observations: observations.map(compactRecord),
      },
    };
  }

  private resultFromStep(step: StepResult, successReason: string) {
    return {
      outcome: step.record.outcome,
      reason:
        step.record.outcome === "success" ? successReason : step.record.reason,
      snapshot: step.snapshot,
    };
  }

  private validationFailure(
    request: ActionRequest,
    snapshot: CombatLogSnapshot,
    reason: string,
  ): ActionRecord {
    const now = new Date().toISOString();
    return {
      requestId: request.requestId,
      action: request.action,
      ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
      expectedRevision: request.expectedRevision,
      sourceRevision: snapshot.revision,
      finalRevision: snapshot.revision,
      startedAt: now,
      completedAt: now,
      outcome: "failure",
      stage: "validation",
      reason,
      recovery:
        "Refresh state and submit a new requestId with the current revision.",
      steps: [],
      observations: [],
    };
  }

  private remember(signature: string, record: ActionRecord): ActionRecord {
    this.actions.push(record);
    this.requests.set(record.requestId, { signature, record });
    if (this.actions.length > this.actionHistoryLimit) {
      const removed = this.actions.splice(
        0,
        this.actions.length - this.actionHistoryLimit,
      );
      for (const action of removed) this.requests.delete(action.requestId);
    }
    return record;
  }
}
