import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { StepResult, WorkflowResult } from '../execution-types.js';
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_DOWN, SDLK_HOME, SDLK_RETURN, SDLK_RIGHT } from '../workflow-support.js';
import { inspectAfterDungeonInteraction } from './inspection.js';
import { navigateInventory } from './inventory.js';

export async function chooseEventOption(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "choose_event_option" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const choose = await context.executeStep(
    "choose_event_option",
    before,
    { kind: "activate_event_option", args: { optionIndex: action.optionIndex } },
    (snapshot, observations) =>
      snapshot.state.eventOverlay?.active !== true ||
        observations.some((record) =>
          /^(?:event: ".*" taken|event: agent option \d+ )/u.test(record.message ?? ""),
        )
        ? { outcome: "success", reason: "The event choice was accepted by the game." }
        : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(choose.record);
  if (choose.record.outcome !== "success") {
    return resultFromStep(choose, `Chose event option ${action.optionIndex}.`);
  }
  return inspectAfterDungeonInteraction(context,
    choose.snapshot,
    steps,
    `Chose event option ${action.optionIndex} and refreshed dungeon state.`,
  );
}

export async function useItemOnEvent(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "use_item_on_event" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  const focus = await focusEventItemOption(context, action.optionIndex, current, steps);
  if (focus.record.outcome !== "success") return resultFromStep(focus, "Focused the event item slot.");
  current = focus.snapshot;

  const openInventory = await context.executeStep(
    "open_event_item_picker",
    current,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) =>
        /^event: handing over to the inventory to pick an item/u.test(record.message ?? ""),
      )
        ? { outcome: "success", reason: "The event inventory picker opened." }
        : undefined,
  );
  steps.push(openInventory.record);
  if (openInventory.record.outcome !== "success") return resultFromStep(openInventory, "Opened event inventory.");
  current = openInventory.snapshot;

  const home = await context.executeStep(
    "focus_inventory_slot_0",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) => /^invnav jump slot \d+ -> 0 /u.test(record.message ?? ""))
        ? { outcome: "success", reason: "Inventory slot 0 is focused." }
        : undefined,
    1_500,
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") return resultFromStep(home, "Focused the inventory.");
  current = home.snapshot;

  const downCount = Math.floor(action.inventorySlot / 8);
  const rightCount = action.inventorySlot % 8;
  let slot = 0;
  for (let index = 0; index < downCount; index += 1) {
    slot += 8;
    const move = await navigateInventory(context, current, SDLK_DOWN, slot, steps);
    if (move.record.outcome !== "success") return resultFromStep(move, "Moved in the inventory.");
    current = move.snapshot;
  }
  for (let index = 0; index < rightCount; index += 1) {
    slot += 1;
    const move = await navigateInventory(context, current, SDLK_RIGHT, slot, steps);
    if (move.record.outcome !== "success") return resultFromStep(move, "Moved in the inventory.");
    current = move.snapshot;
  }

  const use = await context.executeStep(
    "use_item_on_event",
    current,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (_snapshot, observations) => {
      if (
        observations.some((record) =>
          new RegExp(`^event: dropped slot ${action.inventorySlot} .*accepted=1`, "u").test(
            record.message ?? "",
          ),
        ) ||
        observations.some((record) =>
          new RegExp(
            `^event: obstacle item slot ${action.inventorySlot} accepted=1$`,
            "u",
          ).test(record.message ?? ""),
        )
      ) {
        return { outcome: "success", reason: "The compatible item was applied to the event." };
      }
      if (
        observations.some((record) =>
          new RegExp(`^event: dropped slot ${action.inventorySlot} .*accepted=0`, "u").test(
            record.message ?? "",
          ),
        ) ||
        observations.some((record) =>
          new RegExp(
            `^event: obstacle item slot ${action.inventorySlot} accepted=0$`,
            "u",
          ).test(record.message ?? ""),
        )
      ) {
        return { outcome: "failure", reason: "The game rejected the item for this event." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(use.record);
  if (use.record.outcome !== "success") {
    return resultFromStep(use, `Used inventory slot ${action.inventorySlot} on the event.`);
  }
  return inspectAfterDungeonInteraction(context,
    use.snapshot,
    steps,
    `Used inventory slot ${action.inventorySlot} on the event and refreshed dungeon state.`,
  );
}

export async function focusEventItemOption(context: WorkflowContext,
  optionIndex: number,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<StepResult> {
  let current = before;
  const home = await context.executeStep(
    "focus_first_event_option",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) => /^eventnav jump row \d+ -> 0 /u.test(record.message ?? ""))
        ? { outcome: "success", reason: "The first event option is focused." }
        : undefined,
    1_500,
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") return home;
  current = home.snapshot;
  for (let row = 1; row <= optionIndex; row += 1) {
    const move = await context.executeStep(
      `focus_event_option_${row}`,
      current,
      { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(`^eventnav dir=\\+1 row \\d+ -> ${row} `, "u").test(record.message ?? ""),
        )
          ? { outcome: "success", reason: `Event option ${row} is focused.` }
          : undefined,
      1_500,
    );
    steps.push(move.record);
    if (move.record.outcome !== "success") return move;
    current = move.snapshot;
  }
  return {
    snapshot: current,
    record: steps.at(-1)!,
  };
}
