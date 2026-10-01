import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { WorkflowResult } from '../execution-types.js';
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_ESCAPE } from '../workflow-support.js';


export async function assignCircusContestant(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "assign_circus_contestant" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const normalizedAddress = action.heroAddress.replace(/^0x/iu, "");
  const contestant = before.state.circus?.contestants.find(
    (row) => row.heroAddress.toLowerCase() === normalizedAddress.toLowerCase(),
  );
  const wantedSlot = (before.state.circus?.slotCount ?? 4) - action.rank;
  const step = await context.executeStep(
    "assign_circus_contestant",
    before,
    { kind: "assign_circus_contestant", args: { heroAddress: `0x${normalizedAddress}`, rank: action.rank } },
    (_snapshot, observations) => {
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
  return resultFromStep(step, `Assigned ${contestant?.name ?? normalizedAddress} to arena rank ${action.rank}.`);
}

export async function chooseDialogOption(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: 'choose_dialog_option' }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const option = before.state.activeDialog!.options.find((candidate) => candidate.optionIndex === action.optionIndex)!;
  const step = await context.executeStep('choose_dialog_option', before,
    { kind: 'activate_element', args: { elementId: option.elementId } },
    (snapshot) => snapshot.state.currentContext !== 'dialog'
      ? { outcome: 'success', reason: 'The confirmation dialog closed after selecting the answer.' } : undefined,
  );
  steps.push(step.record);
  if (step.record.outcome === 'success' && before.state.modalSourcePhase === 'building') {
    const inspected = await context.executeStep('inspect_after_dialog_answer', step.snapshot,
      { kind: 'inspect_state', args: {} },
      (_snapshot, observations) => observations.some((record) => record.event?.kind === 'agent_state_completed')
        ? { outcome: 'success', reason: 'Fresh building state received after answering the confirmation.' } : undefined,
      context.inspectionTimeoutMilliseconds);
    steps.push(inspected.record);
    return resultFromStep(inspected, `Selected dialog answer ${action.optionIndex}: ${option.label}; refreshed the resulting building state.`);
  }
  return resultFromStep(step, `Selected dialog answer ${action.optionIndex}: ${option.label}.`);
}

export async function dismissModal(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const townEvent = before.state.currentContext === "townevent";
  const tutorial = before.state.currentContext === "tutorial" || before.state.activeTutorial !== undefined;
  const step = await context.executeStep(
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
    return resultFromStep(step, "Dismissed the modal.");
  }

  // DD1 opens the pause menu after Escape dismisses some town-event notices.
  // Treat that as a deterministic follow-up instead of leaving a new modal
  // behind for the caller to discover and close in another round trip.
  if (townEvent && step.snapshot.state.currentContext === "pause") {
    const pause = await context.executeStep(
      "dismiss_pause_after_town_event",
      step.snapshot,
      { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
      (snapshot) =>
        snapshot.state.currentContext !== "pause"
          ? { outcome: "success", reason: "The pause menu closed." }
          : undefined,
    );
    steps.push(pause.record);
    return resultFromStep(pause, "Dismissed the town event and its follow-up pause menu.");
  }

  return resultFromStep(step, "Dismissed the modal.");
}

export async function cancelTargeting(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const inventoryItemTargeting = before.state.currentContext === "itemuse";
  const step = await context.executeStep(
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
  return resultFromStep(
    step,
    inventoryItemTargeting
      ? "Cancelled inventory item target selection."
      : "Cancelled target selection.",
  );
}
