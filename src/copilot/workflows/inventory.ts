import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { StepResult, WorkflowResult } from '../execution-types.js';
import { inventoryTarget } from "../identity.js";
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_DELETE, SDLK_DOWN, SDLK_ESCAPE, SDLK_HOME, SDLK_RETURN, SDLK_RIGHT, SDLK_i, keyAccepted } from '../workflow-support.js';


export async function navigateInventory(context: WorkflowContext,
  before: CombatLogSnapshot,
  sym: number,
  targetSlot: number,
  steps: ActionStepRecord[]): Promise<StepResult> {
  const move = await context.executeStep(
    `focus_inventory_slot_${targetSlot}`,
    before,
    { kind: "key_press", args: { sym, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) =>
        new RegExp(`^invnav dir=\\d slot \\d+ -> ${targetSlot} `, "u").test(
          record.message ?? "",
        ),
      )
        ? { outcome: "success", reason: `Inventory slot ${targetSlot} is focused.` }
        : undefined,
    1_500,
  );
  steps.push(move.record);
  return move;
}

export async function focusInventorySlot(context: WorkflowContext,
  slot: number,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  const combatInterrupted = (snapshot: CombatLogSnapshot) =>
    snapshot.state.combatActive ||
    snapshot.state.phase === "combat" ||
    snapshot.state.phase === "targeting";
  const interruptedResult = (snapshot: CombatLogSnapshot) => ({
    outcome: "failure" as const,
    reason: "Combat began while focusing the inventory; no item input was sent.",
    snapshot,
  });
  if (combatInterrupted(current)) return interruptedResult(current);
  if (current.state.currentContext !== "inventory") {
    const open = await context.executeStep(
      "open_inventory",
      current,
      { kind: "key_press", args: { sym: SDLK_i, mod: 0 } },
      (snapshot) => snapshot.state.currentContext === "inventory"
        ? { outcome: "success", reason: "The raid inventory opened." }
        : undefined,
    );
    steps.push(open.record);
    if (open.record.outcome !== "success") return resultFromStep(open, "Opened the raid inventory.");
    current = open.snapshot;
    if (combatInterrupted(current)) return interruptedResult(current);
  }
  const home = await context.executeStep(
    "inventory_focus_first",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    keyAccepted(SDLK_HOME),
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") return resultFromStep(home, "Focused inventory slot 0.");
  current = home.snapshot;
  if (combatInterrupted(current)) return interruptedResult(current);
  const rows = Math.floor(slot / 8);
  const columns = slot % 8;
  for (let i = 0; i < rows; i += 1) {
    const down = await context.executeStep(
      `inventory_row_${i + 1}`,
      current,
      { kind: "key_press", args: { sym: SDLK_DOWN, mod: 0 } },
      keyAccepted(SDLK_DOWN),
    );
    steps.push(down.record);
    if (down.record.outcome !== "success") return resultFromStep(down, `Focused inventory slot ${slot}.`);
    current = down.snapshot;
    if (combatInterrupted(current)) return interruptedResult(current);
  }
  for (let i = 0; i < columns; i += 1) {
    const right = await context.executeStep(
      `inventory_column_${i + 1}`,
      current,
      { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
      keyAccepted(SDLK_RIGHT),
    );
    steps.push(right.record);
    if (right.record.outcome !== "success") return resultFromStep(right, `Focused inventory slot ${slot}.`);
    current = right.snapshot;
    if (combatInterrupted(current)) return interruptedResult(current);
  }
  return { outcome: "success" as const, reason: `Focused inventory slot ${slot}.`, snapshot: current };
}

export async function useInventoryItem(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "use_inventory_item" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  return consumeInventoryItem(context, action.inventorySlot, inventoryTarget(before.state, action)?.actorGuid, before, steps);
}

export async function consumeInventoryItem(context: WorkflowContext,
  slot: number,
  targetGuid: number | undefined,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[],
  torch = false): Promise<WorkflowResult> {
  const item = before.state.inventory.find((entry) => entry.slot === slot)!;
  const focused = await focusInventorySlot(context, slot, before, steps);
  if (focused.outcome !== "success") return focused;
  const arm = await context.executeStep(
    torch ? `use_torch_from_slot_${slot}` : "arm_inventory_item",
    focused.snapshot, { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (snapshot, observations) => {
      if (observations.some((record) => /^itemuse: (?:no legal target|blocked|.* refused)/u.test(record.message ?? ""))) {
        return { outcome: "failure", reason: "The game refused this item use." };
      }
      if (observations.some((record) => new RegExp(`^itemuse: begin .* slot ${slot} targets=`).test(record.message ?? ""))) {
        return { outcome: "success", reason: "The requested inventory slot opened targeting." };
      }
      const reportedLight = observations.map((record) => /^light: ([-\d.]+) level=/u.exec(record.message ?? ""))
        .filter((match) => match !== null).at(-1);
      if (torch && before.state.light !== undefined &&
        Math.max(snapshot.state.light?.value ?? -1, Number(reportedLight?.[1] ?? -1)) > before.state.light.value) {
        return { outcome: "success", reason: "Light increased; checking the consumed stack." };
      }
      return undefined;
    }, context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(arm.record);
  if (arm.record.outcome !== "success") return resultFromStep(arm, "Armed the inventory item.");
  let current = arm.snapshot;
  const targeting = arm.record.observations.some((record) => /^itemuse: begin /u.test(record.message ?? ""));
  if (targeting) {
    if (targetGuid === undefined) {
      const cancel = await context.executeStep(
        "cancel_unresolved_inventory_target",
        current,
        { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
        (snapshot, observations) =>
          snapshot.state.currentContext !== "itemuse" ||
            observations.some((record) => /^itemuse: abandoned \(cancelled\)$/u.test(record.message ?? ""))
            ? { outcome: "success", reason: "The unresolved item target selector closed." }
            : undefined,
      );
      steps.push(cancel.record);
      return {
        outcome: "failure" as const,
        snapshot: cancel.snapshot,
        reason: cancel.record.outcome === "success"
          ? "No verified target GUID was available, so targeting was cancelled before item use."
          : "No verified target GUID was available and automatic cancellation was not verified. Refresh before further input.",
      };
    }
    const commit = await context.executeStep(
      "commit_inventory_target_by_guid", current,
      { kind: "commit_item_target", args: { targetGuid, inventorySlot: slot, expectedAmount: item.amount, itemKey: item.itemKey } },
      (_snapshot, observations) => {
        for (const record of observations) {
          const result = /^agent-item: result slot=(\d+) target_guid=(\d+) called=(\d+) ok=(\d+) before=(\d+) after=(\d+)$/u.exec(record.message ?? "");
          if (result === null) continue;
          if (Number(result[1]) !== slot || Number(result[2]) !== targetGuid) {
            return { outcome: "failure", reason: "Item result identified a different slot or recipient. Reconcile before further input." };
          }
          return result[3] === "1" && result[4] === "1" && Number(result[5]) === item.amount && Number(result[6]) === item.amount - 1
            ? { outcome: "success", reason: "The game consumed exactly one item for the requested GUID." }
            : { outcome: "failure", reason: "The game did not confirm the expected item consumption." };
        }
        return undefined;
      }, context.settlementTimeoutMilliseconds * 2,
    );
    steps.push(commit.record);
    if (commit.record.outcome !== "success") return resultFromStep(commit, "Committed inventory item.");
    current = commit.snapshot;
  }
  const inspection = await context.executeStep(
    torch ? "inspect_after_torch" : "inspect_after_inventory_item", current,
    { kind: "inspect_state", args: {} },
    (snapshot, observations) => {
      if (!observations.some((record) => record.event?.kind === "agent_state_completed")) return undefined;
      const remaining = snapshot.state.inventory.find((entry) => entry.slot === slot);
      const amount = remaining === undefined ? 0 : remaining.itemKey === item.itemKey ? remaining.amount : -1;
      if (amount !== item.amount - 1) return { outcome: "failure", reason: "Fresh inventory does not confirm exactly one consumed item." };
      if (torch && before.state.light !== undefined && before.state.light.value < 100 &&
        (snapshot.state.light?.value ?? -1) <= before.state.light.value) {
        return { outcome: "failure", reason: "Torch consumption was reported, but fresh light did not increase." };
      }
      return { outcome: "success", reason: "Fresh party, inventory and light state confirm item use." };
    }, context.inspectionTimeoutMilliseconds * 2,
  );
  steps.push(inspection.record);
  return resultFromStep(inspection, `Used one ${item.itemId} from slot ${slot}.`);
}

export async function discardInventoryItem(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "discard_inventory_item" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const focused = await focusInventorySlot(context, action.inventorySlot, before, steps);
  if (focused.outcome !== "success") return focused;
  const begin = await context.executeStep(
    "begin_discard",
    focused.snapshot,
    { kind: "key_press", args: { sym: SDLK_DELETE, mod: 0 } },
    (snapshot, observations) => {
      if (observations.some((record) => /^discard: .* gone /u.test(record.message ?? ""))) {
        return { outcome: "success", reason: "The item was discarded without a confirmation dialog." };
      }
      if (snapshot.state.currentContext === "dialog") {
        return { outcome: "success", reason: "The discard confirmation dialog opened." };
      }
      if (observations.some((record) => /^discard: .*FAULTED|^discard: no panel/u.test(record.message ?? ""))) {
        return { outcome: "failure", reason: "The game could not start the discard." };
      }
      return undefined;
    },
  );
  steps.push(begin.record);
  if (begin.record.outcome !== "success" || begin.snapshot.state.currentContext !== "dialog") {
    return resultFromStep(begin, `Discarded inventory slot ${action.inventorySlot}.`);
  }
  const confirm = await context.executeStep(
    "confirm_discard",
    begin.snapshot,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (_snapshot, observations) => {
      if (observations.some((record) => /^discard: .* gone /u.test(record.message ?? ""))) {
        return { outcome: "success", reason: "The item amount decreased after confirmation." };
      }
      if (observations.some((record) => /^discard: dialog closed, .* kept/u.test(record.message ?? ""))) {
        return { outcome: "failure", reason: "The discard dialog closed without removing the item." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(confirm.record);
  return resultFromStep(confirm, `Discarded inventory slot ${action.inventorySlot}.`);
}

export async function useTorch(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const torch = before.state.inventory
    .filter((item) => item.itemId === "torch" && item.amount > 0)
    .sort((left, right) => left.amount - right.amount || left.slot - right.slot)[0]!;
  return consumeInventoryItem(context, torch.slot, inventoryTarget(before.state, {})?.actorGuid, before, steps, true);
}
