import type { BlindestEvent } from '../blindest/events.js';
import { reduceCamp } from './reducers/camp.js';
import { reduceCircus } from './reducers/circus.js';
import { reduceCombat } from './reducers/combat.js';
import { reduceExploration } from './reducers/exploration.js';
import { reduceInventory } from './reducers/inventory.js';
import { reducePreparation } from './reducers/preparation.js';
import { reduceResults } from './reducers/results.js';
import { reduceSession } from './reducers/session.js';
import { reduceTown } from './reducers/town.js';

export type GamePhase =
  | "unknown"
  | "town"
  | "building"
  | "embark"
  | "provision"
  | "loading"
  | "modal"
  | "room"
  | "traveling"
  | "combat"
  | "targeting"
  | "event"
  | "loot"
  | "camp"
  | "quest"
  | "results"
  | "circus"
  | "post_combat";

export interface GameState {
  phase: GamePhase;
  currentContext?: string;
  modalSourcePhase?: GamePhase;
  currentBuilding?: string;
  townLocations: Array<{
    row: number;
    id: string;
    elementId: string;
    unlocked: boolean;
    screen: boolean;
    district: boolean;
    offSave: boolean;
    isNew: boolean;
    name: string;
  }>;
  townMap?: {
    layer: number;
    locationCount: number;
    selectedRow: number;
  };
  townWallet?: {
    gold: number; bust: number; portrait: number; deed: number; crest: number; shard: number;
  };
  buildingDetails?: {
    buildingId: string;
    mode: number;
    complete: boolean;
    canUpgrade?: boolean;
    activityCandidates?: Array<{
      activityId: string; slot: number; heroGuid: number; name: string;
      known: boolean; eligible: boolean; affordable: boolean; priceKnown: boolean;
      price: number; currency: string; reason: string;
    }>;
    activities: Array<{
      row: number; activityId: string; activityOrder: number; slot: number; slotCount: number;
      elementId: string; committedHeroGuid?: number; pendingHeroGuid?: number; pendingHeroName: string;
      occupant: number; locked: boolean; eventLocked: boolean; costsMoney: boolean;
      treatment?: boolean;
    }>;
    shopItems: Array<{
      row: number; slot: number; itemId: string; name: string; priceKnown: boolean; price: number;
      elementId: string; currency?: string; effects?: string; rarity?: string; classRequirement?: string;
    }>;
    treatments?: Array<{
      activityId: string; slot: number; quirkId: string; mode: number; name: string;
      chosen: boolean; priceKnown: boolean; price: number; currency: string;
    }>;
    memorialCount?: number;
    memorials: Array<{ row: number; text: string }>;
    selectedHeroGuid?: number;
    heroCount?: number;
    heroes: Array<{ row: number; heroGuid: number; name: string }>;
    heroOptions: Array<{
      column?: number; optionId: string; optionHash?: string; optionKind?: number; skillIndex?: number;
      level?: number; selected?: boolean; steps?: number; bought?: number; next?: number; name?: string;
      effects?: string[][];
      stepDetails: Array<{
        code: string; purchased: boolean; armed?: boolean; cost: number; currency: string;
        resolveRequired: number; elementId: string; live: boolean;
        available?: boolean; costKnown?: boolean; lockReason?: string; costs?: Array<{ currency: string; amount: number }>;
      }>;
    }>;
    upgrades: Array<{
      track: number; trackHash: string; trackId: string; knownDefinition: boolean;
      steps: number; armed: number; bought: number; next: number; name: string;
      stepDetails: Array<{ code: string; armed: number }>;
      available?: boolean; costKnown?: boolean; description?: string;
      costs?: Array<{ currency: string; amount: number }>;
    }>;
  };
  buildingHeroes: Array<{
    row: number;
    slot: number;
    heroAddress: string;
    name: string;
    elementId: string;
    heroClass?: string; level?: number; healthText?: string; stressText?: string;
    quirks?: string[]; diseases?: string[];
  }>;
  recruitment?: {
    pending?: {
      slot: number;
      heroAddress: string;
      name: string;
    };
    rosterCount: number;
    rosterCapacity: number;
  };
  focusedHero?: {
    heroAddress: string;
    classAddress: string;
    name: string;
    heroClass: string;
    xp?: number;
    level?: number;
  };
  activeTutorial?: {
    tutorialId: string;
    text: string;
  };
  activeDialog?: {
    text: string;
    answerCount: number;
    options: Array<{ optionIndex: number; label: string; inputHint: string; elementId: string }>;
  };
  circus?: {
    rowCount: number;
    slotCount: number;
    complete: boolean;
    contestants: Array<{
      row: number; heroAddress: string; name: string; heroClass: string;
      inLineup: boolean; dlcLocked: boolean;
    }>;
    slots: Array<{
      slot: number; rank: number; heroAddress?: string; name: string; heroClass: string;
    }>;
  };
  circusCombat?: {
    active: boolean;
    pickOpen: boolean;
    battleState: number;
    partyCount: number;
    complete: boolean;
    heroes: Array<{
      index: number; actorGuid: number; actorAddress: string; canActivate: boolean; active: boolean; name: string;
    }>;
  };
  expedition?: {
    questCount: number;
    locationCount: number;
    cursorColumn: number;
    cursorRow: number;
    questScreenState?: number;
    selectedQuestIndex?: number;
    specialQuestIndex?: number;
    locations: Array<{
      column: number;
      dungeonId: string;
      questCount: number;
    }>;
    quests: Array<{
      row: number;
      questIndex: number;
      questId: string;
      dungeonId: string;
      length: number;
      difficulty: number;
      elementId: string;
      onScreen: boolean;
      details: string[];
    }>;
  };
  partyPlanning?: {
    slotCount: number;
    filledCount: number;
    slots: Array<{
      heroGuid?: number;
      slot: number;
      position: number;
      heroAddress: string;
      entryAddress: string;
      name: string;
      barred: boolean;
      elementId: string;
    }>;
    rosterCandidates: Array<{
      heroGuid?: number;
      row: number;
      entryAddress: string;
      name: string;
      state: number;
      building: string;
      missing: boolean;
      heroClass?: string;
      level?: number;
      healthText?: string;
      stressText?: string;
      weaponLevel?: number;
      armourLevel?: number;
      quirks?: string[];
      diseases?: string[];
      trinkets?: Array<{
        slot: number; status: 'empty' | 'equipped' | 'unknown'; itemId?: string; name?: string; effects?: string;
      }>;
    }>;
    picker?: {
      heroCount: number;
      selectedRow: number;
      pickSlot: number;
    };
  };
  provisioning?: {
    probeSection?: number;
    items: Array<{
      section: number;
      slot: number;
      amount: number;
      itemType: string;
      itemId: string;
      itemKey: string;
      priceKnown: boolean;
      goldPrice: number;
      shardPrice: number;
      freeCount: number;
    }>;
    gold?: number;
    shards?: number;
    bagTotal?: number;
  };
  room?: {
    partyCount: number;
    enemyCount: number;
    propCount: number;
    doorCount: number;
    wave: boolean;
    wayOn: boolean;
    observedTick: number;
    doorDestinations?: string[];
    props?: Array<{
      propIndex: number;
      address: string;
      active: boolean;
      trap: boolean;
      reachable: boolean;
      direction: number;
      distance: number;
      name: string;
    }>;
  };
  inventory: Array<{
    slot: number;
    amount: number;
    itemType: string;
    itemId: string;
    itemKey: string;
    name: string;
  }>;
  inventoryInfo?: {
    slotCount: number;
    occupiedCount: number;
    completedTick?: number;
  };
  light?: {
    kind: "torch" | "ambient";
    value: number;
    level: number;
    text: string;
  };
  camp?: {
    phase: number;
    points: number;
    mealOptionCount: number;
    meals: Array<{
      optionIndex: number;
      foodRequired: number;
      foodAvailable: number;
      text: string;
    }>;
  };
  quest?: {
    rowCount: number;
    goalCount: number;
    button: "none" | "flee" | "abandon" | "regroup" | "finish";
    complete: boolean;
    rows: Array<{
      row: number;
      kind: "goal" | "button" | "wave";
      text: string;
    }>;
  };
  results?: {
    state: number;
    rowCount: number;
    heroCount: number;
    rows: Array<{ row: number; text: string }>;
    heroes: Array<{
      heroIndex: number;
      rowCount: number;
      rows: Array<{ row: number; text: string }>;
    }>;
  };
  eventOverlay?: {
    active: boolean;
    openedTick: number;
    skin: number;
    rowCount: number;
    pickingItem: boolean;
    title: string;
    flavour: string;
    options: Array<{
      optionIndex: number;
      name: string;
      description: string;
      itemSlot: boolean;
      enabled: boolean;
    }>;
    compatibleInventorySlots: number[];
    completedTick?: number;
  };
  loot?: {
    active: boolean;
    openedTick: number;
    itemCount: number;
    token: string;
    items: Array<{
      itemIndex: number;
      poolSlot: number;
      amount: number;
      itemType: string;
      itemId: string;
      itemKey: string;
      name: string;
    }>;
    completedTick?: number;
  };
  pendingRoomDoorDestinations: string[];
  navigation?: {
    fromArea: string;
    toArea: string;
    viaArea: string;
    doorTile: number;
    currentTile?: number;
    description?: string;
  };
  dungeonMap?: {
    areaCount: number;
    currentAreaId: string;
    areas: Array<{
      areaIndex: number;
      areaId: string;
      areaKind: number;
      current: boolean;
      tileCount: number;
      visited: boolean;
      tiles: Array<{
        tileIndex: number;
        tileType: number;
        content: number;
        knowledge: number;
        visible: boolean;
        visited: boolean;
        current: boolean;
      }>;
    }>;
    edges: Array<{
      fromAreaId: string;
      direction: number;
      toAreaId: string;
      corridorAreaId: string;
      corridorTiles: number;
    }>;
    positionTick?: number;
    completedTick?: number;
  };
  combatActive: boolean;
  combatEndCandidate: boolean;
  currentActor?: {
    address: string;
    name: string;
    heroClass: string;
    currentHp: number;
    maxHp: number;
    stress: number;
    maxStress: number;
    turnTick: number;
  };
  selectedSkill?: {
    id: string;
    name: string;
  };
  lastObservedSkill?: {
    id: string;
    name: string;
  };
  combatants: Array<{
    side: "party" | "enemy";
    sideIndex: number;
    slot: number;
    slotEnd: number;
    actorAddress: string;
    actorGuid?: number;
    heroGuid?: number;
    active: boolean;
    name: string;
    currentHp?: number;
    maxHp?: number;
    stress?: number;
    maxStress?: number;
    conditions: string;
    details: string[];
    resists: string[];
    quirks: string[];
    diseases: string[];
    trapDisarmChance?: number;
  }>;
  combatActions: Array<{
    kind: "skill" | "pass" | "reorder" | "rest" | "portrait";
    actionIndex: number;
    skillSlot?: number;
    elementId: string;
    name: string;
    details: string[];
  }>;
  inspection?: {
    startedTick: number;
    completedTick?: number;
    actorAddress?: string;
  };
  currentTarget?: Extract<BlindestEvent, { kind: "target_preview" }>;
  targets: Array<Extract<BlindestEvent, { kind: "target_preview" }>>;
  recentResults: Array<Extract<BlindestEvent, { kind: "combat_result" }>>;
  recentBuffs: Array<Extract<BlindestEvent, { kind: "combat_buff" }>>;
  ignoredPropKeys: string[];
  lastTick: number;
  eventCount: number;
}

export function initialGameState(): GameState {
  return {
    phase: "unknown",
    combatActive: false,
    combatEndCandidate: false,
    townLocations: [],
    buildingHeroes: [],
    inventory: [],
    combatants: [],
    combatActions: [],
    targets: [],
    recentResults: [],
    recentBuffs: [],
    ignoredPropKeys: [],
    pendingRoomDoorDestinations: [],
    lastTick: 0,
    eventCount: 0,
  };
}

const reducers = [reduceSession, reduceTown, reduceCombat, reduceCircus, reducePreparation, reduceExploration, reduceInventory, reduceCamp, reduceResults];

/** Apply each event exactly once; all domains share one revision and reset boundary. */
export function reduceGameState(state: GameState, event: BlindestEvent): GameState {
  const next: GameState = { ...state, lastTick: event.tick, eventCount: state.eventCount + 1 };
  for (const reduce of reducers) {
    if (reduce(state, next, event)) break;
  }
  return next;
}
