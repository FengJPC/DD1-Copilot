import type { BlindestEvent } from "../blindest/events.js";

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

export interface CombatState {
  phase: GamePhase;
  currentContext?: string;
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
    activities: Array<{
      row: number; activityId: string; activityOrder: number; slot: number; slotCount: number;
      elementId: string; committedHeroGuid?: number; pendingHeroGuid?: number; pendingHeroName: string;
      occupant: number; locked: boolean; eventLocked: boolean; costsMoney: boolean;
    }>;
    shopItems: Array<{
      row: number; slot: number; itemId: string; name: string; priceKnown: boolean; price: number;
      elementId: string; effects?: string; rarity?: string; classRequirement?: string;
    }>;
    memorialCount?: number;
    memorials: Array<{ row: number; text: string }>;
    selectedHeroGuid?: number;
    heroCount?: number;
    heroes: Array<{ row: number; heroGuid: number; name: string }>;
    heroOptions: Array<{
      column?: number; optionId: string; optionHash?: string; optionKind?: number; skillIndex?: number;
      level?: number; selected?: boolean; steps?: number; bought?: number; next?: number; name?: string;
      stepDetails: Array<{
        code: string; purchased: boolean; armed?: boolean; cost: number; currency: string;
        resolveRequired: number; elementId: string; live: boolean;
      }>;
    }>;
    upgrades: Array<{
      track: number; trackHash: string; trackId: string; knownDefinition: boolean;
      steps: number; armed: number; bought: number; next: number; name: string;
      stepDetails: Array<{ code: string; armed: number }>;
    }>;
  };
  buildingHeroes: Array<{
    row: number;
    slot: number;
    heroAddress: string;
    name: string;
    elementId: string;
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

export function initialCombatState(): CombatState {
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

function raidSurfacePhase(state: CombatState): GamePhase | undefined {
  if (state.combatActive) return "combat";
  const area = state.dungeonMap?.areas.find(
    (candidate) => candidate.areaId === state.dungeonMap?.currentAreaId,
  );
  if (area?.areaKind === 1) return "traveling";
  if (area?.areaKind === 0) return "room";
  return undefined;
}

function clearSessionObservationState(state: CombatState): void {
  state.currentBuilding = undefined;
  state.townLocations = [];
  state.townMap = undefined;
  state.townWallet = undefined;
  state.buildingDetails = undefined;
  state.buildingHeroes = [];
  state.recruitment = undefined;
  state.focusedHero = undefined;
  state.activeTutorial = undefined;
  state.circus = undefined;
  state.circusCombat = undefined;
  state.expedition = undefined;
  state.partyPlanning = undefined;
  state.provisioning = undefined;
  state.room = undefined;
  state.inventory = [];
  state.inventoryInfo = undefined;
  state.light = undefined;
  state.camp = undefined;
  state.quest = undefined;
  state.results = undefined;
  state.eventOverlay = undefined;
  state.loot = undefined;
  state.navigation = undefined;
  state.dungeonMap = undefined;
  state.combatActive = false;
  state.combatEndCandidate = false;
  state.currentActor = undefined;
  state.selectedSkill = undefined;
  state.lastObservedSkill = undefined;
  state.combatants = [];
  state.combatActions = [];
  state.inspection = undefined;
  state.currentTarget = undefined;
  state.targets = [];
  state.recentResults = [];
  state.recentBuffs = [];
  state.ignoredPropKeys = [];
  state.pendingRoomDoorDestinations = [];
}

export function reduceCombatState(state: CombatState, event: BlindestEvent): CombatState {
  const next: CombatState = {
    ...state,
    lastTick: event.tick,
    eventCount: state.eventCount + 1,
  };

  switch (event.kind) {
    case "context_changed":
      next.currentContext = event.context;
      // The log is append-only across game processes. Replaying it must not
      // carry a previous expedition's overlays or inventory through a title
      // screen / load boundary into the newly loaded save. `none`, however,
      // is also the game's short transition context when leaving embark or a
      // building. Clearing the discovered town roster there makes the next
      // town-map snapshot unusable because the DLL intentionally emits the
      // roster only once per game session.
      if (
        event.context === "title" ||
        event.context === "loading"
      ) {
        clearSessionObservationState(next);
      }
      if (event.context !== "tutorial") next.activeTutorial = undefined;
      if (next.combatEndCandidate && (event.context === "actions" || event.context === "target")) {
        next.phase = "post_combat";
      } else if (event.context === "actions") {
        next.phase = "combat";
        next.selectedSkill = undefined;
        next.currentTarget = undefined;
        next.targets = [];
      }
      else if (event.context === "target") next.phase = "targeting";
      else if (event.context === "event") next.phase = "event";
      else if (event.context === "loot") next.phase = "loot";
      else if (event.context === "meal" || event.context === "camptarget") next.phase = "camp";
      else if (event.context === "quest" || event.context === "questdone" || event.context === "raidfinish") next.phase = "quest";
      else if (event.context === "results") next.phase = "results";
      else if (event.context === "room") next.phase = "room";
      else if (event.context === "building") next.phase = "building";
      else if (event.context === "embark") next.phase = "embark";
      else if (event.context === "provision") next.phase = "provision";
      else if (event.context === "loading") next.phase = "loading";
      else if (event.context === "ring" || event.context === "ringlist") next.phase = "circus";
      else if (event.context === "title" || event.context === "none") next.phase = "unknown";
      else if (
        event.context === "tutorial" ||
        event.context === "dialog" ||
        event.context === "townevent"
      ) next.phase = "modal";
      else if (event.context === "pause") next.phase = "modal";
      else if (event.context === "inventory" || event.context === "map" || event.context === "ingame") {
        next.phase = raidSurfacePhase(next) ?? next.phase;
      }
      else if (event.context === "town" || event.context === "townmap") next.phase = "town";
      break;
    case "building_opened":
      next.currentBuilding = event.buildingId;
      next.buildingHeroes = [];
      next.buildingDetails = undefined;
      next.recruitment = undefined;
      next.focusedHero = undefined;
      next.phase = "building";
      break;
    case "building_snapshot_started":
      next.buildingDetails = {
        buildingId: event.buildingId, mode: event.mode, complete: false,
        activities: [], shopItems: [], memorials: [], heroes: [], heroOptions: [], upgrades: [],
      };
      break;
    case "building_snapshot_completed":
      if (state.buildingDetails?.buildingId === event.buildingId) {
        next.buildingDetails = { ...state.buildingDetails, complete: true };
      }
      break;
    case "town_wallet_observed":
      next.townWallet = {
        gold: event.gold, bust: event.bust, portrait: event.portrait,
        deed: event.deed, crest: event.crest, shard: event.shard,
      };
      break;
    case "building_activity_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = {
        ...details,
        activities: [
          ...details.activities.filter((row) => row.row !== event.row),
          {
            row: event.row, activityId: event.activityId, activityOrder: event.activityOrder,
            slot: event.slot, slotCount: event.slotCount, elementId: event.elementId,
            committedHeroGuid: event.committedHeroGuid, pendingHeroGuid: event.pendingHeroGuid,
            pendingHeroName: event.pendingHeroName, occupant: event.occupant, locked: event.locked,
            eventLocked: event.eventLocked, costsMoney: event.costsMoney,
          },
        ].sort((left, right) => left.row - right.row),
      };
      break;
    }
    case "building_shop_item_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = {
        ...details,
        shopItems: [
          ...details.shopItems.filter((item) => item.row !== event.row),
          { row: event.row, slot: event.slot, itemId: event.itemId, name: event.name,
            priceKnown: event.priceKnown, price: event.price, elementId: event.elementId },
        ].sort((left, right) => left.row - right.row),
      };
      break;
    }
    case "building_shop_item_effects_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = { ...details, shopItems: details.shopItems.map((item) =>
        item.row === event.row ? { ...item, effects: event.effects } : item) };
      break;
    }
    case "building_shop_item_metadata_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = { ...details, shopItems: details.shopItems.map((item) =>
        item.row === event.row ? { ...item, rarity: event.rarity, classRequirement: event.classRequirement } : item) };
      break;
    }
    case "building_memorial_count_observed":
      if (state.buildingDetails) next.buildingDetails = { ...state.buildingDetails, memorialCount: event.count };
      break;
    case "building_memorial_observed":
      if (state.buildingDetails) next.buildingDetails = {
        ...state.buildingDetails,
        memorials: [...state.buildingDetails.memorials.filter((row) => row.row !== event.row),
          { row: event.row, text: event.text }].sort((a, b) => a.row - b.row),
      };
      break;
    case "building_hero_table_observed":
      if (state.buildingDetails) next.buildingDetails = {
        ...state.buildingDetails, selectedHeroGuid: event.selectedHeroGuid, heroCount: event.heroCount,
      };
      break;
    case "building_roster_hero_observed":
      if (state.buildingDetails) next.buildingDetails = {
        ...state.buildingDetails,
        heroes: [...state.buildingDetails.heroes.filter((hero) => hero.heroGuid !== event.heroGuid),
          { row: event.row, heroGuid: event.heroGuid, name: event.name }].sort((a, b) => a.row - b.row),
      };
      break;
    case "building_hero_option_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.heroOptions.find((option) => option.optionId === event.optionId);
        next.buildingDetails = {
          ...details,
          heroOptions: [
            ...details.heroOptions.filter((option) => option.optionId !== event.optionId),
            { column: event.column, optionId: event.optionId, optionHash: event.optionHash,
              optionKind: event.optionKind, skillIndex: event.skillIndex, level: event.level,
              selected: event.selected, steps: event.steps, bought: event.bought, next: event.next,
              name: event.name, stepDetails: previous?.stepDetails ?? [] },
          ].sort((a, b) => (a.column ?? 999) - (b.column ?? 999)),
        };
      }
      break;
    }
    case "building_hero_option_step_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.heroOptions.find((option) => option.optionId === event.optionId);
        const step = { code: event.code, purchased: event.purchased, armed: event.armed,
          cost: event.cost, currency: event.currency, resolveRequired: event.resolveRequired,
          elementId: event.elementId, live: event.live };
        const option = previous ?? { optionId: event.optionId, stepDetails: [] };
        const updated = { ...option, stepDetails: [...option.stepDetails.filter((candidate) => candidate.code !== event.code), step] };
        next.buildingDetails = { ...details,
          heroOptions: [...details.heroOptions.filter((candidate) => candidate.optionId !== event.optionId), updated] };
      }
      break;
    }
    case "building_upgrade_step_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.upgrades.find((upgrade) => upgrade.track === event.track);
        const upgrade = previous ?? {
          track: event.track, trackHash: "", trackId: "", knownDefinition: false,
          steps: 0, armed: -1, bought: 0, next: -1, name: "", stepDetails: [],
        };
        const stepDetails = [
          ...upgrade.stepDetails.filter((step) => step.code !== event.code),
          { code: event.code, armed: event.armed },
        ].sort((a, b) => a.code.localeCompare(b.code));
        next.buildingDetails = {
          ...details,
          upgrades: [...details.upgrades.filter((candidate) => candidate.track !== event.track), { ...upgrade, stepDetails }]
            .sort((a, b) => a.track - b.track),
        };
      }
      break;
    }
    case "building_upgrade_track_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.upgrades.find((upgrade) => upgrade.track === event.track);
        const upgrade = {
          track: event.track, trackHash: event.trackHash, trackId: event.trackId,
          knownDefinition: event.knownDefinition, steps: event.steps, armed: event.armed,
          bought: event.bought, next: event.next, name: event.name,
          stepDetails: previous?.stepDetails ?? [],
        };
        next.buildingDetails = {
          ...details,
          upgrades: [...details.upgrades.filter((candidate) => candidate.track !== event.track), upgrade]
            .sort((a, b) => a.track - b.track),
        };
      }
      break;
    }
    case "town_location_observed":
      next.townLocations = [
        ...state.townLocations.filter((location) => location.id !== event.id),
        {
          row: event.row,
          id: event.id,
          elementId: event.elementId,
          unlocked: event.unlocked,
          screen: event.screen,
          district: event.district,
          offSave: event.offSave,
          isNew: event.isNew,
          name: event.name,
        },
      ].sort((left, right) => left.row - right.row);
      break;
    case "town_map_ready":
      next.phase = "town";
      next.townMap = {
        layer: event.layer,
        locationCount: event.locationCount,
        selectedRow: event.selectedRow,
      };
      break;
    case "building_hero_observed":
      next.buildingHeroes = [
        ...state.buildingHeroes.filter((hero) => hero.slot !== event.slot),
        {
          row: event.row,
          slot: event.slot,
          heroAddress: event.heroAddress,
          name: event.name,
          elementId: event.elementId,
        },
      ].sort((left, right) => left.row - right.row);
      break;
    case "recruit_pending":
      next.recruitment = {
        pending: {
          slot: event.slot,
          heroAddress: event.heroAddress,
          name: event.name,
        },
        rosterCount: event.rosterCount,
        rosterCapacity: event.rosterCapacity,
      };
      break;
    case "hero_recruited": {
      const pending = state.recruitment?.pending;
      next.buildingHeroes = state.buildingHeroes
        .filter(
          (hero) =>
            pending === undefined ||
            (hero.heroAddress !== pending.heroAddress && hero.slot !== pending.slot),
        )
        .map((hero, row) => ({ ...hero, row }));
      next.recruitment = {
        rosterCount: event.rosterCount,
        rosterCapacity:
          state.recruitment?.rosterCapacity ?? event.rosterCount,
      };
      break;
    }
    case "recruit_cancelled":
      if (state.recruitment !== undefined) {
        next.recruitment = {
          rosterCount: state.recruitment.rosterCount,
          rosterCapacity: state.recruitment.rosterCapacity,
        };
      }
      break;
    case "hero_observed":
      next.focusedHero = {
        heroAddress: event.heroAddress,
        classAddress: event.classAddress,
        name: event.name,
        heroClass: event.heroClass,
      };
      break;
    case "hero_rank_observed":
      if (state.focusedHero !== undefined) {
        next.focusedHero = {
          ...state.focusedHero,
          xp: event.xp,
          level: event.level,
        };
      }
      break;
    case "tutorial_opened":
      next.activeTutorial = {
        tutorialId: event.tutorialId,
        text: event.text,
      };
      next.phase = "modal";
      break;
    case "tutorial_closed":
      next.activeTutorial = undefined;
      next.currentContext = event.context;
      if (event.context === "results") next.phase = "results";
      else if (event.context === "townevent" || event.context === "dialog") next.phase = "modal";
      else if (event.context === "town" || event.context === "townmap" || event.context === "townlog") next.phase = "town";
      else if (event.context === "ring" || event.context === "ringlist") next.phase = "circus";
      else next.phase = raidSurfacePhase(next) ?? next.phase;
      break;
    case "circus_snapshot_started":
      next.phase = "circus";
      next.circus = {
        rowCount: event.rowCount, slotCount: event.slotCount, complete: false,
        contestants: [], slots: [],
      };
      break;
    case "circus_contestant_observed": {
      const circus = state.circus ?? { rowCount: 0, slotCount: 4, complete: false, contestants: [], slots: [] };
      next.circus = {
        ...circus,
        contestants: [...circus.contestants.filter((row) => row.row !== event.row), {
          row: event.row, heroAddress: event.heroAddress, name: event.name, heroClass: event.heroClass,
          inLineup: event.inLineup, dlcLocked: event.dlcLocked,
        }].sort((a, b) => a.row - b.row),
      };
      break;
    }
    case "circus_slot_observed": {
      const circus = state.circus ?? { rowCount: 0, slotCount: 4, complete: false, contestants: [], slots: [] };
      next.circus = {
        ...circus,
        slots: [...circus.slots.filter((row) => row.slot !== event.slot), {
          slot: event.slot, rank: event.rank,
          ...(event.heroAddress === undefined ? {} : { heroAddress: event.heroAddress }),
          name: event.name, heroClass: event.heroClass,
        }].sort((a, b) => a.slot - b.slot),
      };
      break;
    }
    case "circus_snapshot_completed":
      if (state.circus !== undefined) next.circus = { ...state.circus, complete: true };
      break;
    case "circus_assignment_observed": {
      if (!event.observed || event.slot < 0 || state.circus === undefined) break;
      const contestant = state.circus.contestants.find((row) => row.heroAddress === event.heroAddress);
      if (contestant === undefined) break;
      const slots = [...state.circus.slots.filter(
        (row) => row.slot !== event.slot && row.heroAddress !== event.heroAddress,
      ), {
        slot: event.slot, rank: state.circus.slotCount - event.slot, heroAddress: event.heroAddress,
        name: contestant.name, heroClass: contestant.heroClass,
      }].sort((a, b) => a.slot - b.slot);
      next.circus = {
        ...state.circus,
        contestants: state.circus.contestants.map((row) => ({
          ...row,
          inLineup: slots.some((slot) => slot.heroAddress === row.heroAddress),
        })),
        slots,
      };
      break;
    }
    case "circus_combat_snapshot_started":
      next.phase = "combat";
      next.combatActive = true;
      next.combatEndCandidate = false;
      next.circusCombat = {
        active: true, pickOpen: event.pickOpen, battleState: event.battleState,
        partyCount: event.partyCount, complete: false, heroes: [],
      };
      break;
    case "circus_combat_hero_observed": {
      const arena = state.circusCombat ?? {
        active: true, pickOpen: false, battleState: 0, partyCount: 0, complete: false, heroes: [],
      };
      next.circusCombat = {
        ...arena,
        heroes: [...arena.heroes.filter((hero) => hero.index !== event.index), {
          index: event.index, actorGuid: event.actorGuid, actorAddress: event.actorAddress,
          canActivate: event.canActivate, active: event.active, name: event.name,
        }].sort((left, right) => left.index - right.index),
      };
      break;
    }
    case "circus_combat_snapshot_completed":
      if (state.circusCombat !== undefined) next.circusCombat = { ...state.circusCombat, complete: true };
      break;
    case "circus_hero_activation_observed":
      if (state.circusCombat !== undefined && event.observed) {
        next.circusCombat = {
          ...state.circusCombat, pickOpen: false,
          heroes: state.circusCombat.heroes.map((hero) => ({
            ...hero, active: hero.actorGuid === event.actorGuid, canActivate: false,
          })),
        };
      }
      break;
    case "embark_ready":
      next.expedition = {
        questCount: event.questCount,
        locationCount: event.locationCount,
        cursorColumn: event.cursorColumn,
        cursorRow: event.cursorRow,
        locations: [],
        quests: [],
      };
      next.phase = "embark";
      break;
    case "embark_state_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          questScreenState: event.questScreenState,
          selectedQuestIndex: event.selectedQuestIndex,
          specialQuestIndex: event.specialQuestIndex,
        };
      }
      break;
    case "embark_location_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          locations: [
            ...state.expedition.locations.filter(
              (location) => location.column !== event.column,
            ),
            {
              column: event.column,
              dungeonId: event.dungeonId,
              questCount: event.questCount,
            },
          ].sort((left, right) => left.column - right.column),
        };
      }
      break;
    case "embark_quest_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          quests: [
            ...state.expedition.quests.filter(
              (quest) => quest.questIndex !== event.questIndex,
            ),
            {
              row: event.row,
              questIndex: event.questIndex,
              questId: event.questId,
              dungeonId: event.dungeonId,
              length: event.length,
              difficulty: event.difficulty,
              elementId: event.elementId,
              onScreen: event.onScreen,
              details: [],
            },
          ].sort((left, right) => left.row - right.row),
        };
      }
      break;
    case "embark_quest_detail_observed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          quests: state.expedition.quests.map((quest) => {
            if (quest.questIndex !== event.questIndex) return quest;
            const details = [...quest.details];
            details[event.line] = event.text;
            return { ...quest, details };
          }),
        };
      }
      break;
    case "embark_cursor_location_changed":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          cursorColumn: event.column,
          cursorRow: 0,
        };
      }
      break;
    case "embark_quest_selected":
      if (state.expedition !== undefined) {
        next.expedition = {
          ...state.expedition,
          selectedQuestIndex: event.questIndex,
        };
      }
      break;
    case "embark_forward_outcome":
      if (event.provision) next.phase = "provision";
      break;
    case "preparation_snapshot_started":
      if (event.section === "party") next.partyPlanning = { slotCount: 4, filledCount: 0, slots: [], rosterCandidates: [] };
      else next.provisioning = { items: [] };
      break;
    case "provision_wallet_observed":
      next.provisioning = { ...(state.provisioning ?? { items: [] }), gold: event.gold, shards: event.shards, bagTotal: event.bagTotal };
      break;
    case "party_slot_observed": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        slots: [
          ...planning.slots.filter((slot) => slot.slot !== event.slot),
          {
            slot: event.slot,
            position: event.position,
            heroAddress: event.heroAddress,
            heroGuid: event.heroGuid,
            entryAddress: event.entryAddress,
            name: event.name,
            barred: event.barred,
            elementId: event.elementId,
          },
        ].sort((left, right) => left.slot - right.slot),
      };
      break;
    }
    case "party_lineup_ready": {
      const planning = state.partyPlanning ?? {
        slotCount: event.slotCount,
        filledCount: event.filledCount,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        slotCount: event.slotCount,
        filledCount: event.filledCount,
        picker: undefined,
      };
      break;
    }
    case "party_lineup_closed":
      if (state.expedition !== undefined) next.phase = "embark";
      break;
    case "roster_hero_observed": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        rosterCandidates: [
          ...planning.rosterCandidates.filter(
            (hero) => hero.entryAddress !== event.entryAddress,
          ),
          {
            row: event.row,
            heroGuid: event.heroGuid,
            entryAddress: event.entryAddress,
            name: event.name,
            state: event.state,
            building: event.building,
            missing: event.missing,
          },
        ].sort((left, right) => left.row - right.row),
      };
      break;
    }
    case "roster_profile_observed": {
      const planning = state.partyPlanning;
      if (planning) next.partyPlanning = {
        ...planning,
        rosterCandidates: planning.rosterCandidates.map((hero) => hero.heroGuid === event.heroGuid
          ? { ...hero, name: event.name || hero.name, heroClass: event.heroClass, level: event.level,
              healthText: event.healthText, stressText: event.stressText,
              weaponLevel: event.weaponLevel, armourLevel: event.armourLevel,
              quirks: hero.quirks ?? [], diseases: hero.diseases ?? [] }
          : hero),
      };
      break;
    }
    case "roster_profile_detail_observed": {
      const planning = state.partyPlanning;
      if (planning) next.partyPlanning = {
        ...planning,
        rosterCandidates: planning.rosterCandidates.map((hero) => {
          if (hero.heroGuid !== event.heroGuid) return hero;
          const key = event.category === "quirk" ? "quirks" : "diseases";
          const rows = [...(hero[key] ?? [])];
          rows[event.line] = event.text;
          return { ...hero, [key]: rows };
        }),
      };
      break;
    }
    case "roster_picker_ready": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      next.partyPlanning = {
        ...planning,
        picker: {
          heroCount: event.heroCount,
          selectedRow: event.selectedRow,
          pickSlot: event.pickSlot,
        },
      };
      break;
    }
    case "party_hero_added": {
      const planning = state.partyPlanning ?? {
        slotCount: 4,
        filledCount: 0,
        slots: [],
        rosterCandidates: [],
      };
      const existing = planning.slots.find((slot) => slot.slot === event.slot);
      next.partyPlanning = {
        ...planning,
        filledCount:
          event.state === 1 && !existing?.name
            ? Math.min(planning.slotCount, planning.filledCount + 1)
            : planning.filledCount,
        slots: [
          ...planning.slots.filter((slot) => slot.slot !== event.slot),
          {
            slot: event.slot,
            position: event.position,
            heroAddress: "",
            entryAddress: "",
            name: event.state === 1 ? event.name : "",
            barred: false,
            elementId: existing?.elementId ?? "",
          },
        ].sort((left, right) => left.slot - right.slot),
        picker: undefined,
        rosterCandidates: planning.rosterCandidates.map((hero) =>
          hero.name === event.name ? { ...hero, state: event.state } : hero,
        ),
      };
      break;
    }
    case "provision_ready":
      next.provisioning = { items: [] };
      next.phase = "provision";
      break;
    case "provision_section_observed": {
      const provisioning = state.provisioning ?? { items: [] };
      next.provisioning = {
        ...provisioning,
        probeSection: event.section,
      };
      break;
    }
    case "provision_item_observed": {
      const provisioning = state.provisioning ?? { items: [] };
      const section = provisioning.probeSection;
      if (section !== undefined) {
        const itemKey =
          event.itemId || (event.itemType === "provision" ? "food" : event.itemType);
        next.provisioning = {
          ...provisioning,
          items: [
            ...provisioning.items.filter(
              (item) => item.section !== section || item.slot !== event.slot,
            ),
            {
              section,
              slot: event.slot,
              amount: event.amount,
              itemType: event.itemType,
              itemId: event.itemId,
              itemKey,
              priceKnown: event.priceKnown,
              goldPrice: event.goldPrice,
              shardPrice: event.shardPrice,
              freeCount: event.freeCount,
            },
          ].sort(
            (left, right) =>
              left.section - right.section || left.slot - right.slot,
          ),
        };
      }
      break;
    }
    case "provision_transaction_observed": {
      const provisioning = state.provisioning ?? { items: [] };
      next.provisioning = {
        ...provisioning,
        gold: event.gold,
        shards: event.shards,
        bagTotal: event.bagTotal,
      };
      break;
    }
    case "loading_continue_ready":
      next.phase = "loading";
      break;
    case "room_view_observed":
      next.phase = "room";
      next.navigation = undefined;
      next.room = {
        partyCount: event.partyCount,
        enemyCount: event.enemyCount,
        propCount: event.propCount,
        doorCount: event.doorCount,
        wave: event.wave,
        wayOn: event.wayOn,
        observedTick: event.tick,
        ...(state.pendingRoomDoorDestinations.length === 0
          ? {}
          : { doorDestinations: state.pendingRoomDoorDestinations }),
        props: [],
      };
      break;
    case "room_doors_started":
      next.pendingRoomDoorDestinations = [];
      break;
    case "room_door_observed":
      next.pendingRoomDoorDestinations = [
        ...state.pendingRoomDoorDestinations.filter(
          (areaId) => areaId !== event.destinationAreaId,
        ),
        event.destinationAreaId,
      ];
      break;
    case "map_move_started":
      next.phase = "traveling";
      next.navigation = {
        fromArea: event.fromArea,
        toArea: event.toArea,
        viaArea: event.viaArea,
        doorTile: event.doorTile,
      };
      break;
    case "tile_step_arrived":
      if (state.navigation !== undefined) {
        next.navigation = {
          ...state.navigation,
          currentTile: event.tile,
          description: event.description,
        };
      }
      if (state.dungeonMap !== undefined) {
        const currentAreaId = state.dungeonMap.currentAreaId;
        next.dungeonMap = {
          ...state.dungeonMap,
          positionTick: event.tick,
          areas: state.dungeonMap.areas.map((area) =>
            area.areaId !== currentAreaId
              ? area
              : {
                  ...area,
                  tiles: area.tiles.map((tile) => ({
                    ...tile,
                    current: tile.tileIndex === event.tile,
                    visited: tile.visited || tile.tileIndex === event.tile,
                  })),
                },
          ),
        };
      }
      break;
    case "map_snapshot_started":
      next.dungeonMap = {
        areaCount: event.areaCount,
        currentAreaId: event.currentAreaId,
        areas: [],
        edges: [],
      };
      break;
    case "map_area_observed": {
      const map = state.dungeonMap ?? {
        areaCount: 0,
        currentAreaId: event.current ? event.areaId : "",
        areas: [],
        edges: [],
      };
      next.dungeonMap = {
        ...map,
        currentAreaId: event.current ? event.areaId : map.currentAreaId,
        areas: [
          ...map.areas.filter((area) => area.areaId !== event.areaId),
          {
            areaIndex: event.areaIndex,
            areaId: event.areaId,
            areaKind: event.areaKind,
            current: event.current,
            tileCount: event.tileCount,
            visited: event.visited,
            tiles: map.areas.find((area) => area.areaId === event.areaId)?.tiles ?? [],
          },
        ].sort((left, right) => left.areaIndex - right.areaIndex),
      };
      break;
    }
    case "map_tile_observed": {
      const map = state.dungeonMap;
      const area = map?.areas.find((candidate) => candidate.areaId === event.areaId);
      if (map !== undefined && area !== undefined) {
        next.dungeonMap = {
          ...map,
          areas: map.areas.map((candidate) =>
            candidate.areaId !== event.areaId
              ? candidate
              : {
                  ...candidate,
                  tiles: [
                    ...candidate.tiles.filter(
                      (tile) => tile.tileIndex !== event.tileIndex,
                    ),
                    {
                      tileIndex: event.tileIndex,
                      tileType: event.tileType,
                      content: event.content,
                      knowledge: event.knowledge,
                      visible: event.visible,
                      visited: event.visited,
                      current: event.current,
                    },
                  ].sort((left, right) => left.tileIndex - right.tileIndex),
                },
          ),
        };
      }
      break;
    }
    case "map_edge_observed": {
      const map = state.dungeonMap;
      if (map !== undefined) {
        next.dungeonMap = {
          ...map,
          edges: [
            ...map.edges.filter(
              (edge) =>
                edge.fromAreaId !== event.fromAreaId ||
                edge.toAreaId !== event.toAreaId,
            ),
            {
              fromAreaId: event.fromAreaId,
              direction: event.direction,
              toAreaId: event.toAreaId,
              corridorAreaId: event.corridorAreaId,
              corridorTiles: event.corridorTiles,
            },
          ],
        };
      }
      break;
    }
    case "map_position_observed": {
      const map = state.dungeonMap ?? {
        areaCount: 0,
        currentAreaId: event.areaId,
        areas: [],
        edges: [],
      };
      next.dungeonMap = {
        ...map,
        currentAreaId: event.areaId,
        positionTick: event.tick,
        areas: map.areas.map((area) => {
          const isCurrent = area.areaId === event.areaId;
          if (!isCurrent) return { ...area, current: false };
          const tiles = area.tiles.map((tile) => ({
            ...tile,
            current: tile.tileIndex === event.tileIndex,
            visited: tile.visited || tile.tileIndex === event.tileIndex,
          }));
          return {
            ...area,
            current: true,
            visited:
              area.areaKind === 0 ||
              (tiles.length === area.tileCount && tiles.every((tile) => tile.visited)),
            tiles,
          };
        }),
      };
      break;
    }
    case "map_snapshot_completed":
      if (state.dungeonMap !== undefined) {
        next.dungeonMap = { ...state.dungeonMap, completedTick: event.tick };
      }
      break;
    case "combat_started":
      next.phase = "combat";
      next.combatActive = true;
      next.combatEndCandidate = false;
      next.selectedSkill = undefined;
      next.lastObservedSkill = undefined;
      next.targets = [];
      next.recentResults = [];
      next.recentBuffs = [];
      next.combatants = [];
      next.combatActions = [];
      next.inspection = undefined;
      break;
    case "combat_ended":
      next.combatActive = false;
      next.combatEndCandidate = true;
      if (state.circusCombat !== undefined) {
        next.circusCombat = { ...state.circusCombat, active: false, pickOpen: false };
      }
      break;
    case "actor_changed":
      next.phase = "combat";
      next.combatActive = true;
      next.combatEndCandidate = false;
      next.currentActor = {
        address: event.actorAddress,
        name: event.name,
        heroClass: event.heroClass,
        currentHp: event.currentHp,
        maxHp: event.maxHp,
        stress: event.stress,
        maxStress: event.maxStress,
        turnTick: event.tick,
      };
      next.selectedSkill = undefined;
      next.lastObservedSkill = undefined;
      next.currentTarget = undefined;
      next.targets = [];
      next.combatActions = [];
      next.inspection = undefined;
      break;
    case "skill_observed":
      next.lastObservedSkill = { id: event.skillId, name: event.name };
      break;
    case "skill_armed":
      next.selectedSkill =
        state.lastObservedSkill?.name === event.name
          ? state.lastObservedSkill
          : { id: "unknown", name: event.name };
      next.phase = "targeting";
      next.currentTarget = undefined;
      next.targets = [];
      break;
    case "target_preview":
      next.phase = "targeting";
      next.currentTarget = event;
      next.targets = [
        ...state.targets.filter(
          (target) => target.side !== event.side || target.slot !== event.slot,
        ),
        event,
      ];
      break;
    case "combat_result":
      next.recentResults = [...state.recentResults, event].slice(-50);
      break;
    case "combat_buff":
      next.recentBuffs = [...state.recentBuffs, event].slice(-50);
      break;
    case "event_opened":
      next.phase = "event";
      next.eventOverlay = {
        active: true,
        openedTick: event.tick,
        skin: event.skin,
        rowCount: event.rowCount,
        pickingItem: false,
        title: event.title,
        flavour: "",
        options: [],
        compatibleInventorySlots: [],
      };
      break;
    case "event_closed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = { ...state.eventOverlay, active: false };
      }
      break;
    case "event_option_activated": {
      if (/^(?:无视|忽略|ignore|leave)$/iu.test(event.name.trim())) {
        const sourceProp = state.room?.props?.find(
          (prop) => prop.active && prop.reachable,
        );
        if (sourceProp !== undefined) {
          next.ignoredPropKeys = [
            ...new Set([
              ...state.ignoredPropKeys,
              `${sourceProp.address}\u0000${sourceProp.name}`,
            ]),
          ];
        }
      }
      break;
    }
    case "agent_state_started":
      next.combatants = [];
      next.combatActions = [];
      next.inventory = [];
      next.inventoryInfo = undefined;
      // A complete inspection describes only overlays that exist now. Clear
      // cached transient windows first; event/loot begin records in the same
      // snapshot will recreate them when they are actually still open.
      next.eventOverlay = undefined;
      next.loot = undefined;
      next.camp = undefined;
      next.quest = undefined;
      next.results = undefined;
      if (state.room !== undefined) next.room = { ...state.room, props: [] };
      next.inspection = { startedTick: event.tick };
      break;
    case "inventory_snapshot_started":
      next.inventoryInfo = {
        slotCount: event.slotCount,
        occupiedCount: event.occupiedCount,
      };
      break;
    case "room_prop_observed":
      next.room = {
        ...(state.room ?? {
          partyCount: state.combatants.filter((actor) => actor.side === "party").length,
          enemyCount: state.combatants.filter((actor) => actor.side === "enemy").length,
          propCount: event.propIndex + 1,
          doorCount: 0,
          wave: false,
          wayOn: false,
          observedTick: event.tick,
          props: [],
        }),
        props: [
          ...(state.room?.props ?? []).filter(
            (prop) => prop.propIndex !== event.propIndex,
          ),
          {
            propIndex: event.propIndex,
            address: event.address,
            active: event.active,
            trap: event.trap,
            reachable: event.reachable,
            direction: event.direction,
            distance: event.distance,
            name: event.name,
          },
        ].sort((left, right) => left.propIndex - right.propIndex),
      };
      break;
    case "inventory_item_observed":
      next.inventory = [
        ...state.inventory.filter((item) => item.slot !== event.slot),
        {
          slot: event.slot,
          amount: event.amount,
          itemType: event.itemType,
          itemId: event.itemId,
          itemKey: event.itemKey,
          name: event.name,
        },
      ].sort((left, right) => left.slot - right.slot);
      break;
    case "inventory_snapshot_completed":
      if (state.inventoryInfo !== undefined) {
        next.inventoryInfo = { ...state.inventoryInfo, completedTick: event.tick };
      }
      break;
    case "event_snapshot_started":
      next.phase = "event";
      next.eventOverlay = {
        active: true,
        openedTick: state.eventOverlay?.openedTick ?? event.tick,
        skin: event.skin,
        rowCount: event.rowCount,
        pickingItem: event.pickingItem,
        title: event.title,
        flavour: event.flavour,
        options: [],
        compatibleInventorySlots: [],
      };
      break;
    case "event_option_observed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = {
          ...state.eventOverlay,
          options: [
            ...state.eventOverlay.options.filter(
              (option) => option.optionIndex !== event.optionIndex,
            ),
            {
              optionIndex: event.optionIndex,
              name: event.name,
              description: event.description,
              itemSlot: event.itemSlot,
              enabled: event.enabled,
            },
          ].sort((left, right) => left.optionIndex - right.optionIndex),
        };
      }
      break;
    case "event_item_compatibility_observed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = {
          ...state.eventOverlay,
          compatibleInventorySlots: event.works
            ? [...new Set([...state.eventOverlay.compatibleInventorySlots, event.slot])].sort(
                (left, right) => left - right,
              )
            : state.eventOverlay.compatibleInventorySlots.filter(
                (slot) => slot !== event.slot,
              ),
        };
      }
      break;
    case "event_snapshot_completed":
      if (state.eventOverlay !== undefined) {
        next.eventOverlay = { ...state.eventOverlay, completedTick: event.tick };
      }
      break;
    case "loot_snapshot_started":
      next.loot = {
        active: true,
        openedTick: state.loot?.openedTick ?? event.tick,
        itemCount: event.itemCount,
        token: state.loot?.token ?? "",
        items: [],
      };
      break;
    case "loot_item_observed":
      if (state.loot !== undefined) {
        next.loot = {
          ...state.loot,
          items: [
            ...state.loot.items.filter(
              (item) => item.itemIndex !== event.itemIndex,
            ),
            {
              itemIndex: event.itemIndex,
              poolSlot: event.poolSlot,
              amount: event.amount,
              itemType: event.itemType,
              itemId: event.itemId,
              itemKey: event.itemKey,
              name: event.name,
            },
          ].sort((left, right) => left.itemIndex - right.itemIndex),
        };
      }
      break;
    case "loot_snapshot_completed":
      if (state.loot !== undefined) {
        next.loot = { ...state.loot, completedTick: event.tick };
      }
      break;
    case "combatant_observed": {
      const health = parseFraction(event.healthText);
      const stress = parseFraction(event.stressText);
      next.combatants = [
        ...state.combatants.filter(
          (combatant) => combatant.actorAddress !== event.actorAddress,
        ),
        {
          side: event.side,
          sideIndex: event.sideIndex,
          slot: event.slot,
          slotEnd: event.slotEnd,
          actorAddress: event.actorAddress,
          ...(event.actorGuid === undefined ? {} : { actorGuid: event.actorGuid }),
          ...(event.heroGuid === undefined ? {} : { heroGuid: event.heroGuid }),
          active: event.active,
          name: event.name,
          ...(health === undefined
            ? {}
            : { currentHp: health.current, maxHp: health.maximum }),
          ...(stress === undefined
            ? {}
            : { stress: stress.current, maxStress: stress.maximum }),
          conditions: event.conditions,
          details: [],
          resists: [],
          quirks: [],
          diseases: [],
        },
      ].sort((left, right) => {
        if (left.side !== right.side) return left.side === "party" ? -1 : 1;
        return left.slot - right.slot;
      });
      // A structured inspection reads the game's active flag directly.  It is
      // stronger evidence than the compact heroswap line, which is also used
      // for ordinary portrait focus changes.  Use it to recover a missed turn
      // handoff without teaching the parser to guess from focus-only logs.
      if (
        state.combatActive &&
        event.side === "party" &&
        event.active &&
        state.currentActor?.address !== event.actorAddress
      ) {
        const separator = event.name.lastIndexOf(", ");
        next.phase = "combat";
        next.combatEndCandidate = false;
        next.currentActor = {
          address: event.actorAddress,
          name: separator < 0 ? event.name : event.name.slice(0, separator),
          heroClass: separator < 0 ? "" : event.name.slice(separator + 2),
          currentHp: health?.current ?? 0,
          maxHp: health?.maximum ?? 0,
          stress: stress?.current ?? 0,
          maxStress: stress?.maximum ?? 200,
          turnTick: event.tick,
        };
        next.selectedSkill = undefined;
        next.lastObservedSkill = undefined;
        next.currentTarget = undefined;
        next.targets = [];
        next.combatActions = [];
        next.inspection = undefined;
      }
      break;
    }
    case "trap_chance_observed":
      next.combatants = state.combatants.map((combatant) =>
        combatant.actorAddress === event.actorAddress
          ? { ...combatant, trapDisarmChance: event.chance }
          : combatant,
      );
      break;
    case "actor_detail_observed":
      next.combatants = state.combatants.map((combatant) => {
        if (combatant.actorAddress !== event.actorAddress) return combatant;
        const field =
          event.category === "resist"
            ? "resists"
            : event.category === "quirk"
              ? "quirks"
              : event.category === "disease"
                ? "diseases"
                : "details";
        const lines = [...combatant[field]];
        lines[event.line] = event.text;
        return { ...combatant, [field]: lines };
      });
      break;
    case "combat_action_observed":
      next.combatActions = [
        ...state.combatActions.filter(
          (action) => action.actionIndex !== event.actionIndex,
        ),
        {
          kind: event.actionKind,
          actionIndex: event.actionIndex,
          ...(event.skillSlot === undefined
            ? {}
            : { skillSlot: event.skillSlot }),
          elementId: event.elementId,
          name: event.name,
          details: [],
        },
      ].sort((left, right) => left.actionIndex - right.actionIndex);
      break;
    case "skill_detail_observed":
      next.combatActions = state.combatActions.map((action) => {
        if (action.skillSlot !== event.skillSlot) return action;
        const details = [...action.details];
        details[event.line] = event.text;
        return { ...action, details };
      });
      break;
    case "light_observed":
      next.light = {
        kind: event.lightKind,
        value: event.value,
        level: event.level,
        text: event.text,
      };
      break;
    case "camp_observed":
      next.camp = {
        phase: event.phase,
        points: event.points,
        mealOptionCount: event.mealOptionCount,
        meals: [],
      };
      if (event.phase > 0) {
        next.phase = "camp";
      } else if (state.phase === "camp") {
        const currentAreaId = state.dungeonMap?.currentAreaId;
        const currentArea = state.dungeonMap?.areas.find(
          (area) => area.areaId === currentAreaId,
        );
        next.phase = currentArea?.areaKind === 0 ? "room" : "unknown";
      }
      break;
    case "camp_meal_observed":
      if (state.camp !== undefined) {
        next.camp = {
          ...state.camp,
          meals: [
            ...state.camp.meals.filter((meal) => meal.optionIndex !== event.optionIndex),
            {
              optionIndex: event.optionIndex,
              foodRequired: event.foodRequired,
              foodAvailable: event.foodAvailable,
              text: event.text,
            },
          ].sort((left, right) => left.optionIndex - right.optionIndex),
        };
      }
      break;
    case "quest_observed":
      next.quest = {
        rowCount: event.rowCount,
        goalCount: event.goalCount,
        button: event.button,
        complete: event.complete,
        rows: [],
      };
      break;
    case "quest_row_observed":
      if (state.quest !== undefined) {
        next.quest = {
          ...state.quest,
          rows: [
            ...state.quest.rows.filter((row) => row.row !== event.row),
            { row: event.row, kind: event.rowKind, text: event.text },
          ].sort((left, right) => left.row - right.row),
        };
      }
      break;
    case "results_observed":
      next.results = {
        state: event.state,
        rowCount: event.rowCount,
        heroCount: event.heroCount,
        rows: state.results?.state === event.state ? state.results.rows : [],
        heroes: state.results?.state === event.state ? state.results.heroes : [],
      };
      if (state.activeTutorial === undefined && state.currentContext !== "tutorial") {
        next.phase = "results";
      }
      break;
    case "results_row_observed":
      if (state.results !== undefined) {
        next.results = {
          ...state.results,
          rows: [
            ...state.results.rows.filter((row) => row.row !== event.row),
            { row: event.row, text: event.text },
          ].sort((left, right) => left.row - right.row),
        };
      }
      break;
    case "results_hero_observed":
      if (state.results !== undefined) {
        const previous = state.results.heroes.find((hero) => hero.heroIndex === event.heroIndex);
        next.results = {
          ...state.results,
          heroes: [
            ...state.results.heroes.filter((hero) => hero.heroIndex !== event.heroIndex),
            {
              heroIndex: event.heroIndex,
              rowCount: event.rowCount,
              rows: previous?.rows ?? [],
            },
          ].sort((left, right) => left.heroIndex - right.heroIndex),
        };
      }
      break;
    case "results_hero_row_observed":
      if (state.results !== undefined) {
        const previous = state.results.heroes.find((hero) => hero.heroIndex === event.heroIndex) ?? {
          heroIndex: event.heroIndex,
          rowCount: 0,
          rows: [],
        };
        const hero = {
          ...previous,
          rows: [
            ...previous.rows.filter((row) => row.row !== event.row),
            { row: event.row, text: event.text },
          ].sort((left, right) => left.row - right.row),
        };
        next.results = {
          ...state.results,
          heroes: [
            ...state.results.heroes.filter((candidate) => candidate.heroIndex !== event.heroIndex),
            hero,
          ].sort((left, right) => left.heroIndex - right.heroIndex),
        };
      }
      break;
    case "agent_state_completed":
      next.inspection = {
        startedTick: state.inspection?.startedTick ?? event.tick,
        completedTick: event.tick,
        ...(state.currentActor === undefined
          ? {}
          : { actorAddress: state.currentActor.address }),
      };
      break;
    case "enemy_count_changed":
      if (event.current === 0) {
        next.combatEndCandidate = true;
        next.phase = "post_combat";
        next.selectedSkill = undefined;
        next.currentTarget = undefined;
        next.targets = [];
      }
      break;
    case "loot_opened":
      if (event.token === "battle") {
        next.combatEndCandidate = true;
      }
      next.phase = "loot";
      next.loot = {
        active: true,
        openedTick: event.tick,
        itemCount: event.itemCount,
        token: event.token,
        items: [],
      };
      break;
    case "loot_closed":
      if (state.loot !== undefined) {
        next.loot = { ...state.loot, active: false, itemCount: 0 };
      }
      if (next.combatEndCandidate) next.phase = "post_combat";
      break;
  }

  return next;
}

function parseFraction(text: string):
  | { current: number; maximum: number }
  | undefined {
  const match = /(\d+)\s*\/\s*(\d+)/u.exec(text);
  if (match === null) return undefined;
  return { current: Number(match[1]), maximum: Number(match[2]) };
}
