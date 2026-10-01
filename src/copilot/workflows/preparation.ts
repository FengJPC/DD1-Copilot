import type {
  CombatLogSnapshot
} from "../../live/combat-log-source.js";
import type { WorkflowResult } from '../execution-types.js';
import { provisionAmount } from "../identity.js";
import { resultFromStep } from '../step-executor.js';
import type {
  ActionStepRecord,
  CopilotAction
} from "../types.js";
import type { WorkflowContext } from '../workflow-context.js';
import { SDLK_ESCAPE, SDLK_SPACE, SDLK_e } from '../workflow-support.js';
import { inspectUntil } from './inspection.js';

export async function openEmbark(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const step = await context.executeStep(
    "open_embark",
    before,
    { kind: "key_press", args: { sym: SDLK_e, mod: 0 } },
    (snapshot) =>
      snapshot.state.phase === "embark" ||
        snapshot.state.currentContext === "embark"
        ? { outcome: "success", reason: "The expedition planner became active." }
        : undefined,
  );
  steps.push(step.record);
  return resultFromStep(step, "Opened expedition planning.");
}

export async function returnToTown(context: WorkflowContext, before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  // The native back callback is not exposed yet. Escape is a compatibility
  // route; each transition must settle before another input can be sent.
  let current = before;
  if (before.state.phase === 'provision') {
    const close = await context.executeStep('close_provision', before,
      { kind: 'key_press', args: { sym: SDLK_ESCAPE, mod: 0 } },
      (snapshot) => ['embark', 'town'].includes(snapshot.state.phase)
        ? { outcome: 'success', reason: 'The provision screen closed.' }
        : snapshot.state.phase === 'modal' ? { outcome: 'failure', reason: 'A modal interrupted returning to town; read it before continuing.' } : undefined);
    steps.push(close.record);
    if (close.record.outcome !== 'success' || close.snapshot.state.phase === 'town')
      return resultFromStep(close, 'Returned from preparation to town.');
    current = close.snapshot;
  }
  const step = await context.executeStep('return_to_town', current,
    { kind: 'key_press', args: { sym: SDLK_ESCAPE, mod: 0 } },
    (snapshot) => snapshot.state.phase === 'town' && snapshot.state.currentContext === 'townmap'
      ? { outcome: 'success', reason: 'The town map became active.' } : undefined);
  steps.push(step.record);
  return resultFromStep(step, 'Returned from expedition planning to town via the verified Escape compatibility input.');
}

export async function selectEmbarkQuest(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "select_embark_quest" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const quest = before.state.expedition!.quests.find((candidate) =>
    action.questIndex !== undefined
      ? candidate.questIndex === action.questIndex
      : candidate.questId === action.questId)!;
  if (
    before.state.expedition?.selectedQuestIndex === quest.questIndex
  ) {
    return {
      outcome: "success" as const,
      reason: `Quest instance ${quest.questIndex} (${quest.questId}) is already selected.`,
      snapshot: before,
    };
  }
  const step = await context.executeStep("select_embark_quest", before,
    { kind: "select_embark_quest", args: { questIndex: quest.questIndex } },
    (snapshot) => snapshot.state.expedition?.selectedQuestIndex === quest.questIndex
      ? { outcome: "success", reason: `The game selected quest instance ${quest.questIndex} (${quest.questId}).` } : undefined);
  steps.push(step.record);
  if (step.record.outcome !== "success") return resultFromStep(step, `Selected quest instance ${quest.questIndex}.`);
  const refreshed = await inspectUntil(context, "inspect_preparation_roster", step.snapshot, steps,
    (state) => (state.partyPlanning?.rosterCandidates.length ?? 0) > 0,
    "The preparation roster was refreshed.");
  return refreshed.outcome === "success"
    ? { ...refreshed, reason: `Selected quest instance ${quest.questIndex} (${quest.questId}) and refreshed the preparation roster.` }
    : refreshed;
}

export async function formEmbarkParty(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "form_embark_party" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  // Fill back-to-front so rank is explicit and list order never becomes identity.
  for (let index = 3; index >= 0; index -= 1) {
    const heroGuid = action.frontToBack[index]!;
    const position = index + 1;
    if (current.state.partyPlanning?.slots.some((slot) => slot.position === position && slot.heroGuid === heroGuid)) continue;
    const commit = await context.executeStep(`assign_party_${heroGuid}_rank_${position}`, current,
      { kind: "assign_party_hero", args: { heroGuid, position } },
      (_snapshot, observations) => observations.some((record) => /^agent-command: end id=\S+ accepted=1$/u.test(record.message ?? ""))
        ? { outcome: "success", reason: "The party assignment was accepted; checking the actual lineup." } : undefined);
    steps.push(commit.record);
    if (commit.record.outcome !== "success") return resultFromStep(commit, "Assigned party hero.");
    const observed = await inspectUntil(context, `verify_party_${heroGuid}`, commit.snapshot, steps,
      (state) => state.partyPlanning?.slots.some((slot) => slot.position === position && slot.heroGuid === heroGuid) === true,
      `Verified hero GUID ${heroGuid} at rank ${position}.`);
    if (observed.outcome !== "success") return observed;
    current = observed.snapshot;
  }
  const matches = action.frontToBack.every((guid, index) => current.state.partyPlanning?.slots.some(
    (slot) => slot.position === index + 1 && slot.heroGuid === guid));
  return {
    outcome: matches ? "success" as const : "failure" as const, snapshot: current,
    reason: matches ? "All four party positions match the requested hero GUIDs." : "The final lineup differs from the requested GUID order."
  };
}

export async function proceedToProvision(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  let current = before;
  if (current.state.currentContext === "party") {
    const close = await context.executeStep(
      "close_party_lineup",
      current,
      { kind: "key_press", args: { sym: SDLK_ESCAPE, mod: 0 } },
      (snapshot, observations) =>
        observations.some(
          (record) => record.event?.kind === "party_lineup_closed",
        ) || snapshot.state.currentContext === "embark"
          ? {
            outcome: "success",
            reason: "The party lineup returned to expedition planning.",
          }
          : undefined,
    );
    steps.push(close.record);
    if (close.record.outcome !== "success") {
      return resultFromStep(close, "Closed the party lineup.");
    }
    current = close.snapshot;
  }

  const advance = await context.executeStep(
    "open_provision",
    current,
    { kind: "key_press", args: { sym: SDLK_e, mod: 0 } },
    (snapshot, observations) =>
      observations.some(
        (record) =>
          record.event?.kind === "embark_forward_outcome" &&
          record.event.provision,
      ) ||
        snapshot.state.phase === "provision" ||
        snapshot.state.currentContext === "provision"
        ? { outcome: "success", reason: "Provisioning became active." }
        : undefined,
  );
  steps.push(advance.record);
  return resultFromStep(advance, "Opened provisioning.");
}

export async function buyProvision(context: WorkflowContext,
  action: Extract<CopilotAction, { kind: "buy_provision" }>,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const item = before.state.provisioning!.items.find(
    (candidate) =>
      candidate.section === 0 && candidate.itemKey === action.itemKey,
  )!;
  const initialBagAmount = provisionAmount(before.state, action.itemKey);
  const initialBagTotal = before.state.provisioning!.bagTotal;
  const initialGold = before.state.provisioning!.gold;
  const expectedGold =
    initialGold === undefined || !item.priceKnown
      ? undefined
      : initialGold - Math.max(0, action.quantity - item.freeCount) * item.goldPrice;
  let current = before;
  for (let count = 0; count < action.quantity; count += 1) {
    const purchase = await context.executeStep(
      `buy_${action.itemKey}_${count + 1}`,
      current,
      { kind: "buy_provision", args: { itemKey: action.itemKey } },
      (_snapshot, observations) => {
        const transaction = observations.find(
          (record) =>
            record.event?.kind === "provision_transaction_observed",
        )?.event;
        if (transaction?.kind !== "provision_transaction_observed") {
          return undefined;
        }
        return transaction.bagTotal > transaction.previousBagTotal
          ? {
            outcome: "success",
            reason: `${action.itemKey} purchase increased bag total ${transaction.previousBagTotal} -> ${transaction.bagTotal}.`,
          }
          : {
            outcome: "failure",
            reason: `${action.itemKey} purchase did not increase the bag total.`,
          };
      },
    );
    steps.push(purchase.record);
    if (purchase.record.outcome !== "success") {
      const previousInspectionTick = purchase.snapshot.state.inspection?.completedTick;
      const reconcile = await context.executeStep(
        `inspect_after_${action.itemKey}_purchase_gap_${count + 1}`,
        purchase.snapshot,
        { kind: "inspect_state", args: {} },
        (snapshot) => {
          if (
            snapshot.state.inspection?.completedTick === undefined ||
            snapshot.state.inspection.completedTick === previousInspectionTick
          ) {
            return undefined;
          }
          const observedAmount = provisionAmount(snapshot.state, action.itemKey);
          return observedAmount === initialBagAmount + count + 1
            ? {
              outcome: "success",
              reason: `${action.itemKey} was present in the inspected bag despite the missing transaction event.`,
            }
            : {
              outcome: "failure",
              reason: `${action.itemKey} was not added; the input was not retried automatically.`,
            };
        },
        context.inspectionTimeoutMilliseconds,
      );
      steps.push(reconcile.record);
      if (reconcile.record.outcome !== "success") {
        return resultFromStep(reconcile, `Reconciled ${action.itemKey} after a transaction-state gap.`);
      }
      current = reconcile.snapshot;
      continue;
    }
    current = purchase.snapshot;
  }

  const previousInspectionTick = current.state.inspection?.completedTick;
  const verify = await context.executeStep(
    `inspect_after_buying_${action.itemKey}`,
    current,
    { kind: "inspect_state", args: {} },
    (snapshot) => {
      if (
        snapshot.state.inspection?.completedTick === undefined ||
        snapshot.state.inspection.completedTick === previousInspectionTick
      ) {
        return undefined;
      }
      const provisioning = snapshot.state.provisioning;
      const observedAmount = provisionAmount(snapshot.state, action.itemKey);
      const amountMatches = observedAmount === initialBagAmount + action.quantity;
      const totalMatches =
        initialBagTotal === undefined ||
        provisioning?.bagTotal === undefined ||
        provisioning.bagTotal === initialBagTotal + action.quantity;
      const walletMatches =
        expectedGold === undefined ||
        provisioning?.gold === undefined ||
        provisioning.gold === expectedGold;
      return amountMatches && totalMatches && walletMatches
        ? {
          outcome: "success",
          reason: `Verified ${action.itemKey} quantity and available wallet totals after purchase.`,
        }
        : {
          outcome: "failure",
          reason: `Provision reconciliation failed for ${action.itemKey}: bag=${observedAmount}, total=${provisioning?.bagTotal ?? "unknown"}, gold=${provisioning?.gold ?? "unknown"}.`,
        };
    },
    context.inspectionTimeoutMilliseconds,
  );
  steps.push(verify.record);
  if (verify.record.outcome !== "success") {
    return resultFromStep(verify, `Verified the ${action.itemKey} purchase.`);
  }
  current = verify.snapshot;

  return {
    outcome: "success" as const,
    reason: `Bought ${action.quantity} ${action.itemKey}.`,
    snapshot: current,
  };
}

export async function startExpedition(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const start = await context.executeStep(
    "start_expedition",
    before,
    { kind: "key_press", args: { sym: SDLK_e, mod: 0 } },
    (snapshot, observations) =>
      observations.some(
        (record) =>
          record.event?.kind === "embark_forward_outcome" &&
          record.event.previousProvision &&
          !record.event.provision,
      ) ||
        snapshot.state.currentContext === "room"
        ? {
          outcome: "success",
          reason: "The game left provisioning and started the expedition.",
        }
        : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(start.record);
  return resultFromStep(start, "Started the expedition.");
}

export async function continueLoading(context: WorkflowContext,
  before: CombatLogSnapshot,
  steps: ActionStepRecord[]): Promise<WorkflowResult> {
  const step = await context.executeStep(
    "continue_loading",
    before,
    { kind: "key_press", args: { sym: SDLK_SPACE, mod: 0 } },
    (snapshot, observations) =>
      snapshot.state.phase !== "loading" ||
        observations.some(
          (record) =>
            record.event?.kind === "context_changed" &&
            record.event.context !== "loading",
        )
        ? {
          outcome: "success",
          reason: "The loading screen advanced to the expedition.",
        }
        : undefined,
    context.settlementTimeoutMilliseconds * 2,
  );
  steps.push(step.record);
  return resultFromStep(step, "Continued past the loading screen.");
}
