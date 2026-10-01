import type { GamePhase, GameState } from './game-state.js';
export function raidSurfacePhase(state: GameState): GamePhase | undefined {
  if (state.combatActive) return "combat";
  const area = state.dungeonMap?.areas.find(
    (candidate) => candidate.areaId === state.dungeonMap?.currentAreaId,
  );
  if (area?.areaKind === 1) return "traveling";
  if (area?.areaKind === 0) return "room";
  return undefined;
}

export function clearSessionObservationState(state: GameState): void {
  state.currentBuilding = undefined;
  state.modalSourcePhase = undefined;
  state.townLocations = [];
  state.townMap = undefined;
  state.townWallet = undefined;
  state.buildingDetails = undefined;
  state.buildingHeroes = [];
  state.recruitment = undefined;
  state.focusedHero = undefined;
  state.activeTutorial = undefined;
  state.activeDialog = undefined;
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

export function parseFraction(text: string):
  | { current: number; maximum: number }
  | undefined {
  const match = /(\d+)\s*\/\s*(\d+)/u.exec(text);
  if (match === null) return undefined;
  return { current: Number(match[1]), maximum: Number(match[2]) };
}
