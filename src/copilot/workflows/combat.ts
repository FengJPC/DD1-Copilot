import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { WorkflowResult } from '../execution-types.js';
import { resolveRequestedTarget, resolveSkill } from "../identity.js";
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_ESCAPE, SDLK_LEFT, SDLK_RETURN, SDLK_RIGHT, skillNeedsNoTarget, targetMatches } from '../workflow-support.js';


export async function moveHero(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "move_hero" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const move = before.state.combatActions.find((candidate) => candidate.kind === "reorder")!;
  let current = before;
  const select = await context.executeStep(
    "select_move",
    current,
    { kind: "click_element", args: { elementId: move.elementId } },
    (snapshot) => snapshot.state.phase === "targeting"
      ? { outcome: "success", reason: "Move targeting opened." }
      : undefined,
  );
  steps.push(select.record);
  if (select.record.outcome !== "success") return resultFromStep(select, "Selected Move.");
  current = select.snapshot;
  for (let i = 0; current.state.currentTarget?.slot !== action.toSlot && i < 6; i += 1) {
    const step = await context.executeStep(
      `move_target_next_${i + 1}`,
      current,
      { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
      (_snapshot, observations) => observations.some((record) => record.event?.kind === "target_preview")
        ? { outcome: "success", reason: "The move destination cursor advanced." }
        : undefined,
    );
    steps.push(step.record);
    current = step.snapshot;
    if (step.record.outcome !== "success") return resultFromStep(step, "Moved the destination cursor.");
  }
  if (current.state.currentTarget?.slot !== action.toSlot) {
    const cancel = await context.executeStep(
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
  const confirm = await context.executeStep(
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
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(confirm.record);
  return resultFromStep(confirm, `Moved the active hero toward position ${action.toSlot}.`);
}

export async function activateCircusHero(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "activate_circus_hero" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const hero = before.state.circusCombat?.heroes.find(
    (candidate) => candidate.actorGuid === action.actorGuid,
  );
  const step = await context.executeStep(
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
    return resultFromStep(step, `Activated arena hero ${hero?.name ?? action.actorGuid}.`);
  }
  const inspected = await context.executeStep(
    "inspect_circus_action_bar",
    step.snapshot,
    { kind: "inspect_state", args: {} },
    (snapshot) => snapshot.state.combatActions.some((item) => item.kind === "skill")
      ? { outcome: "success", reason: "The activated hero's arena skills are available." }
      : undefined,
  );
  steps.push(inspected.record);
  return resultFromStep(inspected, `Activated ${hero?.name ?? action.actorGuid} and inspected the arena action bar.`);
}

export async function passTurn(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const pass = before.state.combatActions.find(
    (candidate) => candidate.kind === "pass",
  )!;
  const step = await context.executeStep(
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
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(step.record);
  return resultFromStep(step, "Passed the current hero's turn.");
}

export async function useSkill(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "use_skill" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
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
  let select = await context.executeStep(
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
    Math.min(context.settlementTimeoutMilliseconds, 1_500),
  );
  steps.push(select.record);
  if (select.record.outcome !== "success") {
    return resultFromStep(select, "Selected the skill.");
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
    return resultFromStep(select, `Used no-target skill slot ${skillSlot}.`);
  }
  if (effectiveTarget === undefined) {
    return {
      outcome: "failure" as const,
      reason: `Skill slot ${skillSlot} requires a target, but none was supplied.`,
      snapshot: current,
    };
  }

  if (effectiveTarget.targetGuid !== undefined && actorCombatant?.actorGuid !== undefined) {
    const confirm = await context.executeStep(
      "commit_skill_target_by_guid",
      current,
      {
        kind: "commit_combat_target",
        args: {
          targetGuid: effectiveTarget.targetGuid,
          actorGuid: actorCombatant?.actorGuid,
          skillElementId: skill.elementId
        },
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
      context.settlementTimeoutMilliseconds * 2,
    );
    steps.push(confirm.record);
    return resultFromStep(
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
    const navigate = await context.executeStep(
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
      return resultFromStep(navigate, "Moved the target cursor.");
    }
  }

  if (!targetMatches(current.state, effectiveTarget)) {
    const cancel = await context.executeStep(
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

  const confirm = await context.executeStep(
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
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(confirm.record);
  return resultFromStep(
    confirm,
    noTarget
      ? `Used no-target skill slot ${skillSlot}.`
      : `Used skill slot ${skillSlot} on ${effectiveTarget.side} slot ${effectiveTarget.slot}.`,
  );
}
