import type { GameCommand } from "../../command/transport.js";
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
import { BLD_ELEM_BACK, SDLK_DOWN, SDLK_ESCAPE, SDLK_HOME, SDLK_RETURN } from '../workflow-support.js';


export async function openTownLocation(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "open_town_location" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const location = before.state.townLocations.find(
    (candidate) => candidate.id === action.locationId,
  )!;
  const step = await context.executeStep(
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
    return resultFromStep(step, `Opened town location ${action.locationId}.`);
  }
  const inspected = await context.executeStep(
    "inspect_open_building",
    step.snapshot,
    { kind: "inspect_state", args: {} },
    (_snapshot, observations) =>
      observations.some((record) => record.event?.kind === "agent_state_completed")
        ? { outcome: "success", reason: "Fresh building state received." }
        : undefined,
    context.inspectionTimeoutMilliseconds,
  );
  steps.push(inspected.record);
  return resultFromStep(inspected, `Opened town location ${action.locationId}.`);
}

export async function recruitStageCoachHero(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "recruit_stage_coach_hero" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
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

  const home = await context.executeStep(
    "recruit_focus_first",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    acceptedKey(SDLK_HOME),
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") {
    return resultFromStep(home, "Focused the first Stagecoach hero.");
  }
  current = home.snapshot;

  for (let index = 0; index < targetIndex; index += 1) {
    const down = await context.executeStep(
      `recruit_focus_next_${index + 1}`,
      current,
      { kind: "key_press", args: { sym: SDLK_DOWN, mod: 0 } },
      acceptedKey(SDLK_DOWN),
    );
    steps.push(down.record);
    if (down.record.outcome !== "success") {
      return resultFromStep(down, "Moved the Stagecoach selection.");
    }
    current = down.snapshot;
  }

  const arm = await context.executeStep(
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
      const cancel = await context.executeStep(
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
    return resultFromStep(arm, `Selected ${target.name} for recruitment.`);
  }

  const confirm = await context.executeStep(
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
  return resultFromStep(confirm, `Recruited ${target.name}.`);
}

export async function runTownIdentityCommand(context: WorkflowContext,
  name: string,
  before: CombatLogSnapshot,
  command: GameCommand,
  verify: (snapshot: CombatLogSnapshot) => { outcome: "success" | "failure"; reason: string } | undefined,
  steps: ActionStepRecord[],
  summary: string): Promise<WorkflowResult> {
  const sent = await context.executeStep(
    name,
    before,
    command,
    (_snapshot, observations) => {
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
  if (sent.record.outcome !== "success") return resultFromStep(sent, summary);
  const inspected = await context.executeStep(
    `${name}_inspect`,
    sent.snapshot,
    { kind: "inspect_state", args: {} },
    (snapshot, observations) =>
      observations.some((record) => record.event?.kind === "agent_state_completed")
        ? verify(snapshot)
        : undefined,
    context.inspectionTimeoutMilliseconds,
  );
  steps.push(inspected.record);
  return resultFromStep(inspected, summary);
}

export async function selectBuildingHero(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "select_building_hero" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  return runTownIdentityCommand(context,
    "select_building_hero", before,
    { kind: "select_building_hero", args: { heroGuid: action.heroGuid } },
    (snapshot) => snapshot.state.buildingDetails?.selectedHeroGuid === action.heroGuid
      ? { outcome: "success", reason: `Hero GUID ${action.heroGuid} is selected.` } : undefined,
    steps, `Selected building hero ${action.heroGuid}.`,
  );
}

export async function buyHeroUpgrade(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "buy_hero_upgrade" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  return runTownIdentityCommand(context,
    "buy_hero_upgrade", before,
    {
      kind: "buy_hero_upgrade", args: {
        heroGuid: action.heroGuid, optionId: action.optionId, stepCode: action.stepCode,
      }
    },
    (snapshot) => snapshot.state.buildingDetails?.heroOptions
      .find((option) => option.optionId === action.optionId)?.stepDetails
      .find((step) => step.code === action.stepCode)?.purchased
      ? { outcome: "success", reason: `${action.optionId}/${action.stepCode} is now purchased.` }
      : undefined,
    steps, `Bought ${action.optionId}/${action.stepCode} for hero ${action.heroGuid}.`,
  );
}

export async function buyTownItem(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "buy_town_item" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const beforeCount = before.state.buildingDetails?.shopItems.filter(
    (item) => item.itemId === action.itemId).length ?? 0;
  return runTownIdentityCommand(context,
    "buy_town_item", before,
    { kind: "buy_town_item", args: { itemId: action.itemId } },
    (snapshot) => (snapshot.state.buildingDetails?.shopItems.filter(
      (item) => item.itemId === action.itemId).length ?? 0) < beforeCount
      ? { outcome: "success", reason: `${action.itemId} left the shop inventory.` } : undefined,
    steps, `Bought town item ${action.itemId}.`,
  );
}

export async function assignTownActivity(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "assign_town_activity" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  return runTownIdentityCommand(context,
    "assign_town_activity", before,
    {
      kind: "assign_town_activity", args: {
        activityId: action.activityId, slot: action.slot, heroGuid: action.heroGuid,
      }
    },
    (snapshot) => snapshot.state.buildingDetails?.activities.some((row) =>
      row.activityId === action.activityId && row.slot === action.slot &&
      row.committedHeroGuid === action.heroGuid)
      ? { outcome: "success", reason: `Hero ${action.heroGuid} is committed to ${action.activityId} slot ${action.slot}.` }
      : undefined,
    steps, `Assigned hero ${action.heroGuid} to ${action.activityId} slot ${action.slot}.`,
  );
}

export async function cancelTownActivity(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "cancel_town_activity" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const result = await runTownIdentityCommand(context,
    "cancel_town_activity", before,
    { kind: "cancel_town_activity", args: { activityId: action.activityId, slot: action.slot } },
    (snapshot) => {
      if (snapshot.state.currentContext === 'dialog' && snapshot.state.activeDialog)
        return { outcome: 'success', reason: 'Cancellation confirmation is open; the activity has not yet been cancelled.' };
      const row = snapshot.state.buildingDetails?.activities.find((candidate) =>
        candidate.activityId === action.activityId && candidate.slot === action.slot);
      return row !== undefined && row.committedHeroGuid === undefined && row.pendingHeroGuid === undefined
        ? { outcome: "success", reason: `${action.activityId} slot ${action.slot} is empty.` }
        : undefined;
    },
    steps, `Cancelled ${action.activityId} slot ${action.slot}.`,
  );
  return result.outcome === 'success' && result.snapshot.state.currentContext === 'dialog'
    ? { ...result, awaitingConfirmation: true,
      reason: 'Cancellation requested; choose an answer to the displayed confirmation. The activity remains committed until confirmed.' }
    : result;
}

export async function openBuildingUpgrades(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  return runTownIdentityCommand(context,
    "open_building_upgrades", before,
    { kind: "open_building_upgrades", args: {} },
    (snapshot) => snapshot.state.buildingDetails?.mode === 1
      ? { outcome: "success", reason: "The building upgrade screen is active." } : undefined,
    steps, "Opened the building upgrade screen.",
  );
}

export async function buyBuildingUpgrade(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "buy_building_upgrade" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const oldBought = before.state.buildingDetails?.upgrades.find(
    (track) => track.trackId === action.trackId)?.bought ?? -1;
  return runTownIdentityCommand(context,
    "buy_building_upgrade", before,
    { kind: "buy_building_upgrade", args: { trackId: action.trackId, stepCode: action.stepCode } },
    (snapshot) => (snapshot.state.buildingDetails?.upgrades.find(
      (track) => track.trackId === action.trackId)?.bought ?? -1) > oldBought
      ? { outcome: "success", reason: `${action.trackId}/${action.stepCode} is now purchased.` }
      : undefined,
    steps, `Bought building upgrade ${action.trackId}/${action.stepCode}.`,
  );
}

export async function closeBuilding(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const step = await context.executeStep(
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
  return resultFromStep(step, "Closed the building and returned to town.");
}
