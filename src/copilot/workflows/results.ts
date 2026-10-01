import type {
  BlindestLogRecord,
  CombatLogSnapshot,
} from "../../live/combat-log-source.js";
import type { WorkflowResult } from '../execution-types.js';
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_END, SDLK_LEFT, SDLK_RETURN, SDLK_RIGHT, SDLK_g, delay, keyAccepted } from '../workflow-support.js';


export async function useQuestControl(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "retreat_combat" | "abandon_expedition" | "finish_quest" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  if (current.state.currentContext !== "quest") {
    const open = await context.executeStep("open_quest_zone", current,
      { kind: "key_press", args: { sym: SDLK_g, mod: 0 } },
      (snapshot) => snapshot.state.currentContext === "quest"
        ? { outcome: "success", reason: "The quest zone opened." }
        : undefined);
    steps.push(open.record);
    if (open.record.outcome !== "success") return resultFromStep(open, "Opened the quest zone.");
    current = open.snapshot;
  }
  const end = await context.executeStep("focus_quest_control", current,
    { kind: "key_press", args: { sym: SDLK_END, mod: 0 } }, keyAccepted(SDLK_END));
  steps.push(end.record);
  if (end.record.outcome !== "success") return resultFromStep(end, "Focused the quest control.");
  current = end.snapshot;
  const activate = await context.executeStep(
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
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(activate.record);
  if (activate.record.outcome !== "success" || activate.snapshot.state.currentContext !== "dialog") {
    return resultFromStep(activate, `Activated ${action.kind}.`);
  }
  const confirm = await context.executeStep(
    "confirm_quest_control",
    activate.snapshot,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (snapshot) => snapshot.state.currentContext !== "dialog"
      ? { outcome: "success", reason: "The confirmation dialog closed and the raid state advanced." }
      : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(confirm.record);
  return resultFromStep(confirm, `Confirmed ${action.kind}.`);
}

export async function chooseQuestCompletion(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "choose_quest_completion" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  const direction = action.destination === "hamlet" ? SDLK_LEFT : SDLK_RIGHT;
  const focus = await context.executeStep("focus_quest_completion", current,
    { kind: "key_press", args: { sym: direction, mod: 0 } }, keyAccepted(direction));
  steps.push(focus.record);
  if (focus.record.outcome !== "success") return resultFromStep(focus, "Focused a quest-complete choice.");
  current = focus.snapshot;
  const choose = await context.executeStep(
    "choose_quest_completion",
    current,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (snapshot, observations) => snapshot.state.currentContext !== "questdone" ||
      observations.some((record) => /qcwatch: .* took/u.test(record.message ?? ""))
      ? { outcome: "success", reason: `The ${action.destination} choice took effect.` }
      : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(choose.record);
  return resultFromStep(choose, `Chose ${action.destination} after quest completion.`);
}

export async function continueResults(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
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
  const step = await context.executeStep(
    "continue_results",
    before,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    settled,
    Math.min(context.settlementTimeoutMilliseconds * 2, 1_500),
  );
  steps.push(step.record);
  const revealStarted = step.record.observations.some((record) =>
    /^results: reveal observed\b/u.test(record.message ?? ""),
  );
  if (revealStarted || step.record.outcome !== "uncertain" ||
    step.snapshot.state.currentContext !== "results" ||
    step.snapshot.state.results?.state !== previousState) {
    return resultFromStep(step, "Advanced the expedition results.");
  }

  // A click made while the page is still animating may be accepted by the
  // game thread without changing the page. Retry once after a short bounded
  // wait instead of consuming the general settlement timeout.
  await delay(250);
  const retry = await context.executeStep(
    "continue_results_after_settle",
    step.snapshot,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    settled,
    Math.min(context.settlementTimeoutMilliseconds * 2, 1_500),
  );
  steps.push(retry.record);
  return resultFromStep(retry, "Advanced the expedition results after its reveal animation settled.");
}
