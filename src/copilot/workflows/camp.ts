import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { WorkflowResult } from '../execution-types.js';
import { inventoryTarget } from "../identity.js";
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_HOME, SDLK_RETURN, SDLK_RIGHT, keyAccepted } from '../workflow-support.js';
import { inspectUntil } from './inspection.js';

export async function chooseCampMeal(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "choose_camp_meal" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  const home = await context.executeStep("camp_meal_first", current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } }, keyAccepted(SDLK_HOME));
  steps.push(home.record);
  if (home.record.outcome !== "success") return resultFromStep(home, "Focused the first meal option.");
  current = home.snapshot;
  for (let i = 0; i < action.optionIndex; i += 1) {
    const right = await context.executeStep(`camp_meal_next_${i + 1}`, current,
      { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } }, keyAccepted(SDLK_RIGHT));
    steps.push(right.record);
    if (right.record.outcome !== "success") return resultFromStep(right, "Selected a camping meal.");
    current = right.snapshot;
  }
  const choose = await context.executeStep(
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
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(choose.record);
  if (choose.record.outcome !== "success") {
    return resultFromStep(choose, `Chose camping meal option ${action.optionIndex}.`);
  }
  const previousCompletedTick = choose.snapshot.state.inspection?.completedTick;
  const inspection = await context.executeStep(
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
    context.inspectionTimeoutMilliseconds * 2,
  );
  steps.push(inspection.record);
  return resultFromStep(
    inspection,
    `Chose camping meal option ${action.optionIndex} and verified the respite state.`,
  );
}

export async function useCampSkill(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "use_camp_skill" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const pointsBefore = before.state.camp?.points;
  const skill = before.state.combatActions.find(
    (candidate) => candidate.kind === "skill" && candidate.skillSlot === action.skillSlot,
  )!;
  let current = before;
  const select = await context.executeStep(
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
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(select.record);
  if (select.record.outcome !== "success" || select.snapshot.state.currentContext !== "camptarget") {
    if (select.record.outcome !== "success") return resultFromStep(select, "Selected camping skill.");
    return inspectUntil(context, "inspect_after_camp_skill", select.snapshot, steps,
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
  const confirm = await context.executeStep(
    "confirm_camp_skill",
    current,
    { kind: "commit_camp_target", args: { targetGuid: target.actorGuid, actorGuid: actor.actorGuid, skillElementId: skill.elementId } },
    (snapshot, observations) => observations.some((record) => (record.message ?? "").startsWith(`camp target: agent selected guid=${target.actorGuid} `)) &&
      (observations.some((record) => /^camp: respite points \d+ -> \d+/u.test(record.message ?? "")) ||
        (pointsBefore !== undefined && snapshot.state.camp?.points !== undefined && snapshot.state.camp.points < pointsBefore))
      ? { outcome: "success", reason: "The camping skill spent respite points." }
      : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(confirm.record);
  if (confirm.record.outcome !== "success") return resultFromStep(confirm, "Committed camping skill.");
  return inspectUntil(context, "inspect_after_camp_skill", confirm.snapshot, steps,
    (state) => pointsBefore !== undefined && (state.camp?.points ?? pointsBefore) < pointsBefore,
    `Used camping skill slot ${action.skillSlot}.`);
}

export async function finishCamp(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const rest = before.state.combatActions.find((candidate) => candidate.kind === "rest")!;
  const step = await context.executeStep(
    "finish_camp",
    before,
    { kind: "click_element", args: { elementId: rest.elementId } },
    (snapshot, observations) => snapshot.state.camp?.phase !== 6 ||
      observations.some((record) => /^camp: phase 6 -> /u.test(record.message ?? ""))
      ? { outcome: "success", reason: "The respite phase ended." }
      : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(step.record);
  return resultFromStep(step, "Finished camping.");
}
