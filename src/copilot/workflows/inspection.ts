import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { GameState } from "../../state/game-state.js";
import type { WorkflowResult } from '../execution-types.js';
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { delay } from '../workflow-support.js';


export async function inspectUntil(context: WorkflowContext,
  name: string,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[],
  matches: (state: GameState) => boolean,
  reason: string): Promise<WorkflowResult> {
  let current = before;
  const deadline = Date.now() + context.settlementTimeoutMilliseconds;
  do {
    const inspect = await context.executeStep(name, current, { kind: "inspect_state", args: {} },
      (_snapshot, observations) => observations.some((record) => record.event?.kind === "agent_state_completed")
        ? { outcome: "success", reason: "Fresh state received." } : undefined, context.inspectionTimeoutMilliseconds);
    steps.push(inspect.record);
    if (inspect.record.outcome !== "success") return resultFromStep(inspect, reason);
    current = inspect.snapshot;
    if (matches(current.state)) return { outcome: "success" as const, reason, snapshot: current };
    await delay(Math.max(100, context.pollIntervalMilliseconds));
  } while (Date.now() < deadline);
  return { outcome: "uncertain" as const, reason: "Fresh state did not confirm the requested result; no action was resent.", snapshot: current };
}

export async function inspectAfterDungeonInteraction(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[],
  successReason: string): Promise<WorkflowResult> {
  const previousCompletedTick = before.state.inspection?.completedTick;
  const inspection = await context.executeStep(
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
    context.inspectionTimeoutMilliseconds * 2,
  );
  steps.push(inspection.record);
  return resultFromStep(inspection, successReason);
}
