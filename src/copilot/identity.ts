import type { GameState } from "../state/game-state.js";
import type { CopilotAction } from "./types.js";

export type TargetSelector = { targetGuid?: number; side?: "party" | "enemy"; slot?: number };

// Every supplied selector must agree. Never silently pick the first duplicate ID.
export function resolveRequestedTarget(state: GameState, target: TargetSelector) {
  if (target.targetGuid === undefined && (target.side === undefined || target.slot === undefined)) return undefined;
  const matches = state.combatants.filter((candidate) =>
    (target.targetGuid === undefined || candidate.actorGuid === target.targetGuid) &&
    (target.side === undefined || candidate.side === target.side) &&
    (target.slot === undefined || candidate.slot === target.slot));
  return matches.length === 1 ? matches[0] : undefined;
}

export function currentCombatant(state: GameState) {
  const matches = state.combatants.filter((candidate) => candidate.side === "party" &&
    (state.currentActor?.address !== undefined
      ? candidate.actorAddress === state.currentActor.address : candidate.active));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveSkill(state: GameState, action: Extract<CopilotAction, { kind: "use_skill" }>) {
  if (action.skillSlot === undefined && action.skillElementId === undefined) return undefined;
  const matches = state.combatActions.filter((candidate) => candidate.kind === "skill" &&
    (action.skillSlot === undefined || candidate.skillSlot === action.skillSlot) &&
    (action.skillElementId === undefined || candidate.elementId === action.skillElementId));
  return matches.length === 1 ? matches[0] : undefined;
}

export function inventoryTarget(state: GameState, action: { targetHeroGuid?: number; targetIndex?: number }) {
  const party = state.combatants.filter((actor) => actor.side === "party").sort((a, b) => a.slot - b.slot);
  const indexed = party[action.targetIndex ?? 0];
  const matches = action.targetHeroGuid === undefined ? (indexed ? [indexed] : [])
    : party.filter((actor) => actor.heroGuid === action.targetHeroGuid);
  const target = matches.length === 1 ? matches[0] : undefined;
  if (action.targetIndex !== undefined && target !== indexed) return undefined;
  return target?.actorGuid ? target : undefined;
}

export function roomPropHero(
  state: GameState,
  action: { heroGuid: number; heroIndex?: number },
) {
  const matches = state.combatants.filter(
    (actor) =>
      actor.side === "party" &&
      actor.heroGuid === action.heroGuid &&
      (action.heroIndex === undefined || actor.sideIndex === action.heroIndex),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function currentActorView(state: GameState) {
  if (state.currentActor === undefined) return undefined;
  const fresh = currentCombatant(state);
  return {
    ...state.currentActor, actorGuid: fresh?.actorGuid,
    currentHp: fresh?.currentHp ?? state.currentActor.currentHp,
    maxHp: fresh?.maxHp ?? state.currentActor.maxHp,
    stress: fresh?.stress ?? state.currentActor.stress
  };
}

export function provisionAmount(state: GameState, itemKey: string, section = 1) {
  return (state.provisioning?.items ?? []).filter((item) => item.section === section && item.itemKey === itemKey)
    .reduce((total, item) => total + item.amount, 0);
}
