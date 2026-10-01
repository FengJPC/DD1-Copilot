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
import { SDLK_ESCAPE, SDLK_HOME, SDLK_RETURN, SDLK_RIGHT, SDLK_SPACE, SDLK_r } from '../workflow-support.js';
import { discardInventoryItem } from './inventory.js';

export async function consolidateBeforeLoot(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<StepResult> {
  const consolidate = await context.executeStep(
    "consolidate_inventory_before_loot",
    before,
    { kind: "consolidate_inventory", args: {} },
    (_snapshot, observations) => {
      const event = observations.find(
        (record) => record.event?.kind === "inventory_consolidated",
      )?.event;
      if (event?.kind !== "inventory_consolidated") return undefined;
      return event.accepted
        ? {
          outcome: "success",
          reason: `Inventory consolidation completed (${event.merges} merges, ${event.freed} slots freed).`,
        }
        : {
          outcome: "failure",
          reason: "The game rejected inventory consolidation.",
        };
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(consolidate.record);
  if (consolidate.record.outcome !== "success") return consolidate;

  const event = consolidate.record.observations.find(
    (record) => record.event?.kind === "inventory_consolidated",
  )?.event;
  if (event?.kind !== "inventory_consolidated" || event.merges === 0) {
    return consolidate;
  }

  const previousCompletedTick = consolidate.snapshot.state.inspection?.completedTick;
  const inspection = await context.executeStep(
    "inspect_after_inventory_consolidation",
    consolidate.snapshot,
    { kind: "inspect_state", args: {} },
    (snapshot, observations) =>
      observations.some((record) => record.event?.kind === "agent_state_completed") &&
        snapshot.state.inspection?.completedTick !== previousCompletedTick
        ? {
          outcome: "success",
          reason: "The consolidated inventory and remaining loot were refreshed.",
        }
        : undefined,
    context.inspectionTimeoutMilliseconds * 2,
  );
  steps.push(inspection.record);
  return inspection;
}

export async function takeAllLoot(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const consolidation = await consolidateBeforeLoot(context, before, steps);
  if (consolidation.record.outcome !== "success") {
    return resultFromStep(consolidation, "Consolidated inventory before taking loot.");
  }
  const journal = consolidation.snapshot.state.loot?.items.find(
    (item) => item.itemType === "journal_page",
  );
  if (journal !== undefined) {
    const beforeCount = consolidation.snapshot.state.loot?.items.length ?? 0;
    const journalResult = await takeLootItem(context,
      { kind: "take_loot_item", itemIndex: journal.itemIndex },
      consolidation.snapshot,
      steps,
      false,
    );
    if (journalResult.outcome !== "success") return journalResult;
    const remaining = journalResult.snapshot.state.loot?.items ?? [];
    if (
      remaining.length >= beforeCount ||
      remaining.some((item) => item.itemType === "journal_page")
    ) {
      return {
        outcome: "uncertain" as const,
        reason: "The journal page was accepted but remained in the refreshed loot state.",
        snapshot: journalResult.snapshot,
      };
    }
    if (remaining.length === 0) {
      return {
        outcome: "success" as const,
        reason: "Took the journal page through the verified single-item path.",
        snapshot: journalResult.snapshot,
      };
    }
    return takeAllLoot(context, journalResult.snapshot, steps);
  }
  const step = await context.executeStep(
    "take_all_loot",
    consolidation.snapshot,
    { kind: "key_press", args: { sym: SDLK_SPACE, mod: 0 } },
    (snapshot, observations) =>
      snapshot.state.loot?.active !== true ||
        observations.some((record) => record.event?.kind === "loot_closed")
        ? { outcome: "success", reason: "The loot window closed after taking all." }
        : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(step.record);
  return resultFromStep(step, "Took all available loot.");
}

export async function takeLootItem(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "take_loot_item" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[],
  consolidate = true): Promise<WorkflowResult> {
  let current = before;
  if (consolidate) {
    const consolidation = await consolidateBeforeLoot(context, current, steps);
    if (consolidation.record.outcome !== "success") {
      return resultFromStep(consolidation, "Consolidated inventory before taking loot.");
    }
    current = consolidation.snapshot;
  }
  const home = await context.executeStep(
    "focus_first_loot_item",
    current,
    { kind: "key_press", args: { sym: SDLK_HOME, mod: 0 } },
    (_snapshot, observations) =>
      observations.some((record) => /^lootnav jump item \d+ -> 0 /u.test(record.message ?? ""))
        ? { outcome: "success", reason: "The first loot item is focused." }
        : undefined,
    1_500,
  );
  steps.push(home.record);
  if (home.record.outcome !== "success") return resultFromStep(home, "Focused loot.");
  current = home.snapshot;
  for (let item = 1; item <= action.itemIndex; item += 1) {
    const move = await context.executeStep(
      `focus_loot_item_${item}`,
      current,
      { kind: "key_press", args: { sym: SDLK_RIGHT, mod: 0 } },
      (_snapshot, observations) =>
        observations.some((record) =>
          new RegExp(`^lootnav dir=\\+1 item \\d+ -> ${item} `, "u").test(
            record.message ?? "",
          ),
        )
          ? { outcome: "success", reason: `Loot item ${item} is focused.` }
          : undefined,
      1_500,
    );
    steps.push(move.record);
    if (move.record.outcome !== "success") return resultFromStep(move, "Focused the loot item.");
    current = move.snapshot;
  }
  const take = await context.executeStep(
    "take_loot_item",
    current,
    { kind: "key_press", args: { sym: SDLK_RETURN, mod: 0 } },
    (_snapshot, observations) => {
      if (observations.some((record) => /^loot: took item /u.test(record.message ?? ""))) {
        return { outcome: "success", reason: "The selected loot item left the loot list." };
      }
      if (
        observations.some((record) =>
          /^loot: take item .* (?:could not be attempted|nothing moved)/u.test(
            record.message ?? "",
          ),
        )
      ) {
        return { outcome: "failure", reason: "The selected loot item could not be taken." };
      }
      return undefined;
    },
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(take.record);
  if (take.record.outcome !== "success") {
    return resultFromStep(take, `Took loot item ${action.itemIndex}.`);
  }
  return inspectAfterLootChange(context,
    take.snapshot,
    steps,
    `Took loot item ${action.itemIndex} and refreshed the inventory and remaining loot.`,
  );
}

export async function inspectAfterLootChange(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[],
  successReason: string): Promise<WorkflowResult> {
  const previousCompletedTick = before.state.inspection?.completedTick;
  const inspection = await context.executeStep(
    "inspect_after_loot_change",
    before,
    { kind: "inspect_state", args: {} },
    (snapshot, observations) =>
      observations.some((record) => record.event?.kind === "agent_state_completed") &&
        snapshot.state.inspection?.completedTick !== previousCompletedTick
        ? {
          outcome: "success",
          reason: "Fresh inventory and remaining loot state was observed.",
        }
        : undefined,
    context.inspectionTimeoutMilliseconds * 2,
  );
  steps.push(inspection.record);
  return resultFromStep(inspection, successReason);
}

export async function replaceInventoryWithLoot(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "replace_inventory_with_loot" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const consolidation = await consolidateBeforeLoot(context, before, steps);
  if (consolidation.record.outcome !== "success") {
    return resultFromStep(consolidation, "Consolidated inventory before replacing loot.");
  }
  const current = consolidation.snapshot;
  const discarded = current.state.inventory.find(
    (item) => item.slot === action.inventorySlot,
  );
  const wanted = current.state.loot!.items.find(
    (item) => item.itemIndex === action.itemIndex,
  )!;

  if (
    current.state.inventoryInfo !== undefined &&
    current.state.inventoryInfo.occupiedCount < current.state.inventoryInfo.slotCount
  ) {
    const take = await takeLootItem(context,
      { kind: "take_loot_item", itemIndex: action.itemIndex },
      current,
      steps,
      false,
    );
    if (take.outcome !== "success") return take;
    return {
      outcome: "success" as const,
      reason: `Consolidated inventory and took ${wanted.name} without discarding an item.`,
      snapshot: take.snapshot,
    };
  }

  if (discarded === undefined) {
    return {
      outcome: "failure" as const,
      reason: `Inventory slot ${action.inventorySlot} became empty but no free slot was reported after consolidation.`,
      snapshot: current,
    };
  }

  const discard = await discardInventoryItem(context,
    { kind: "discard_inventory_item", inventorySlot: action.inventorySlot },
    current,
    steps,
  );
  if (discard.outcome !== "success") {
    return discard;
  }

  const returned = await returnToLoot(context, discard.snapshot, steps);
  if (returned.outcome !== "success") return returned;

  const take = await takeLootItem(context,
    { kind: "take_loot_item", itemIndex: action.itemIndex },
    returned.snapshot,
    steps,
    false,
  );
  if (take.outcome !== "success") return take;

  return {
    outcome: "success" as const,
    reason: `Discarded ${discarded.name} from inventory slot ${action.inventorySlot} and took ${wanted.name}.`,
    snapshot: take.snapshot,
  };
}

export async function returnToLoot(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const returned = await context.executeStep(
    "return_to_loot",
    before,
    { kind: "key_press", args: { sym: SDLK_r, mod: 0 } },
    (snapshot, observations) =>
      snapshot.state.currentContext === "loot" ||
        observations.some((record) => /^loot: back to the window/u.test(record.message ?? ""))
        ? { outcome: "success", reason: "Returned to the open loot window." }
        : undefined,
  );
  steps.push(returned.record);
  return resultFromStep(returned, "Returned to the open loot window.");
}

export async function closeLoot(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const step = await context.executeStep(
    "close_loot",
    before,
    { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
    (snapshot, observations) =>
      snapshot.state.loot?.active !== true ||
        observations.some((record) => record.event?.kind === "loot_closed")
        ? { outcome: "success", reason: "The loot window closed." }
        : undefined,
  );
  steps.push(step.record);
  return resultFromStep(step, "Closed the loot window.");
}
