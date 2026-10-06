import type {
  CombatLogSnapshot
} from "../live/combat-log-source.js";
import type { GameState } from "../state/game-state.js";
import { actionRequestSchema } from "./action-schema.js";
import { PollingLifetime } from './cancellation.js';
import type { CombatDecisionWaitResult, CopilotEngineOptions, PendingCombatTransition } from './execution-types.js';
import { ObservationCoordinator } from './observation.js';
import { projectState } from './state-view.js';
import { StepExecutor } from './step-executor.js';
import type {
  ActionOutcome,
  ActionRecord,
  ActionRequest,
  ActionStepRecord,
  GameGateway
} from "./types.js";
import { validateAction } from './validate-action.js';
import { passiveRevisionAdvance } from './revision-guard.js';
import type { WorkflowContext } from './workflow-context.js';
import { actionSignature, COMBAT_TURN_ACTIONS } from './workflow-support.js';
import { chooseCampMeal, finishCamp, useCampSkill } from './workflows/camp.js';
import { activateCircusHero, moveHero, passTurn, useSkill } from './workflows/combat.js';
import { chooseEventOption, useItemOnEvent } from './workflows/events.js';
import { advanceCorridor, approachRoomProp, enterRoom, interactRoomProp, returnToPreviousRoom, travelToRoom } from './workflows/exploration.js';
import { assignCircusContestant, cancelTargeting, chooseDialogOption, dismissModal } from './workflows/interface.js';
import { discardInventoryItem, useInventoryItem, useTorch } from './workflows/inventory.js';
import { closeLoot, replaceInventoryWithLoot, returnToLoot, takeAllLoot, takeLootItem } from './workflows/loot.js';
import { buyProvision, continueLoading, formEmbarkParty, openEmbark, proceedToProvision, returnToTown, selectEmbarkQuest, startExpedition } from './workflows/preparation.js';
import { chooseQuestCompletion, continueResults, useQuestControl } from './workflows/results.js';
import { assignTownActivity, buyBuildingUpgrade, buyHeroUpgrade, buyTownItem, cancelTownActivity, closeBuilding, openBuildingUpgrades, openTownLocation, recruitStageCoachHero, selectBuildingHero } from './workflows/town.js';
import { townTreatment } from './workflows/treatment.js';
import { changeTrinket } from './workflows/equipment.js';
export type { CombatDecisionWaitResult, CopilotEngineOptions } from './execution-types.js';

export class CopilotEngine {
  private lastObservedSnapshot?: CombatLogSnapshot;
  get observedSnapshot(): CombatLogSnapshot | undefined { return this.lastObservedSnapshot; }
  async readSnapshot(): Promise<CombatLogSnapshot> { return this.game.refresh(); }
  private readonly lifetime = new PollingLifetime();
  private readonly game: GameGateway;

  private readonly workflowContext: WorkflowContext;
  private readonly observation: ObservationCoordinator;
  private readonly settlementTimeoutMilliseconds: number;

  private readonly pollIntervalMilliseconds: number;

  private readonly inspectionTimeoutMilliseconds: number;

  private readonly combatDecisionTimeoutMilliseconds: number;

  private readonly combatActorStabilityMilliseconds: number;

  private readonly actionHistoryLimit: number;

  private readonly actions: ActionRecord[] = [];

  private readonly requests = new Map<
    string,
    { signature: string; record: ActionRecord }
  >();

  private pendingCombatTransition?: PendingCombatTransition;

  private inFlight?: { requestId: string; signature: string; promise: Promise<ActionRecord> };

  constructor(
    game: GameGateway,
    options: CopilotEngineOptions = {},
  ) {
    this.game = {
      refresh: () => { this.lifetime.ensureOpen(); return game.refresh(); },
      send: (command) => { this.lifetime.ensureOpen(); return game.send(command); },
      recordsAfter: game.recordsAfter.bind(game),
    };
    this.settlementTimeoutMilliseconds =
      options.settlementTimeoutMilliseconds ?? 6_000;
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 100;
    this.inspectionTimeoutMilliseconds =
      options.inspectionTimeoutMilliseconds ?? 750;
    this.combatDecisionTimeoutMilliseconds =
      options.combatDecisionTimeoutMilliseconds ?? 30_000;
    // DD1 can expose a fully populated action bar for an actor that is still
    // being skipped during round settlement.  A short debounce prevents that
    // transient actor from becoming a model-facing decision.
    this.combatActorStabilityMilliseconds =
      options.combatActorStabilityMilliseconds ?? 450;
    this.actionHistoryLimit = options.actionHistoryLimit ?? 100;
    this.observation = new ObservationCoordinator(this.game, this.lifetime, () => this.inFlight !== undefined, options);
    const executor = new StepExecutor(this.game, this.settlementTimeoutMilliseconds, this.pollIntervalMilliseconds, this.lifetime);
    this.workflowContext = {
      game: this.game,
      settlementTimeoutMilliseconds: this.settlementTimeoutMilliseconds,
      inspectionTimeoutMilliseconds: this.inspectionTimeoutMilliseconds,
      pollIntervalMilliseconds: this.pollIntervalMilliseconds,
      executeStep: executor.execute.bind(executor),
    };
  }

  async getState(mode: 'compact' | 'delta' | 'full' = 'compact', afterRevision = 0) {
    const snapshot = await this.observation.getSnapshot();
    this.lastObservedSnapshot = snapshot;
    this.reconcilePendingCombatTransition(snapshot.state);
    return projectState(snapshot, mode, afterRevision, this.game.recordsAfter.bind(this.game), this.pendingCombatTransition);
  }

  close() { this.lifetime.close(); }

  async forceRefresh(
    mode: "compact" | "delta" | "full" = "compact",
    afterRevision = 0,
    includeMap = false,
  ) {
    await this.observation.forceRefresh(includeMap);
    return this.getState(mode, afterRevision);
  }

  async act(request: ActionRequest): Promise<ActionRecord> {
    const parsed = actionRequestSchema.safeParse(request);
    if (!parsed.success) return this.validationFailure(request, await this.game.refresh(),
      `Invalid action request: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    request = parsed.data;
    const signature = actionSignature(request);
    const running = this.inFlight;
    if (running !== undefined) {
      if (running.requestId === request.requestId && running.signature === signature) {
        return { ...await running.promise, deduplicated: true };
      }
      return this.validationFailure(request, await this.game.refresh(),
        "Another action is in flight; refresh after it settles. No input was sent.");
    }
    const promise = this.actOnce(request);
    this.inFlight = { requestId: request.requestId, signature, promise };
    try { return await promise; }
    finally { this.inFlight = undefined; }
  }

  private async actOnce(request: ActionRequest): Promise<ActionRecord> {
    await this.observation.waitForPending();
    const previous = this.requests.get(request.requestId);
    const signature = actionSignature(request);
    if (previous !== undefined) {
      if (previous.signature === signature) {
        return { ...previous.record, deduplicated: true };
      }
      return this.validationFailure(
        request,
        await this.game.refresh(),
        "requestId was already used for a different action.",
      );
    }

    const before = await this.game.refresh();
    if (!before.source.available) return this.remember(signature,
      this.validationFailure(request, before, "The primary observation source is unavailable; no action was sent."));
    this.reconcilePendingCombatTransition(before.state);
    if (request.expectedRevision !== before.revision &&
      !passiveRevisionAdvance(request.expectedRevision, before.revision, this.game.recordsAfter.bind(this.game))) {
      return this.remember(
        signature,
        this.validationFailure(
          request,
          before,
          `Stale action: expected revision ${request.expectedRevision}, current revision is ${before.revision}.`,
        ),
      );
    }

    if (
      this.combatTransitionIsPending(before.state) &&
      COMBAT_TURN_ACTIONS.has(request.action.kind)
    ) {
      return this.remember(
        signature,
        this.validationFailure(
          request,
          before,
          "The previous combat action is still resolving; wait for the actor or turn tick to change.",
        ),
      );
    }

    const invalidReason = validateAction(request.action, before.state);
    if (invalidReason !== undefined) {
      return this.remember(
        signature,
        this.validationFailure(request, before, invalidReason),
      );
    }

    const startedAt = new Date().toISOString();
    const steps: ActionStepRecord[] = [];
    let result: {
      outcome: ActionOutcome;
      reason: string;
      snapshot: CombatLogSnapshot;
      awaitingConfirmation?: boolean;
    };

    try {
      switch (request.action.kind) {
        case 'equip_trinket':
        case 'unequip_trinket':
          result = await changeTrinket(this.workflowContext, request.action, before, steps);
          break;
        case "open_town_location":
          result = await openTownLocation(this.workflowContext, request.action, before, steps);
          break;
        case "open_embark":
          result = await openEmbark(this.workflowContext, before, steps);
          break;
        case 'return_to_town':
          result = await returnToTown(this.workflowContext, before, steps);
          break;
        case "select_embark_quest":
          result = await selectEmbarkQuest(this.workflowContext, request.action, before, steps);
          break;
        case "form_embark_party":
          result = await formEmbarkParty(this.workflowContext, request.action, before, steps);
          break;
        case "proceed_to_provision":
          result = await proceedToProvision(this.workflowContext, before, steps);
          break;
        case "buy_provision":
          result = await buyProvision(this.workflowContext, request.action, before, steps);
          break;
        case "start_expedition":
          result = await startExpedition(this.workflowContext, before, steps);
          break;
        case "continue_loading":
          result = await continueLoading(this.workflowContext, before, steps);
          break;
        case "travel_to_room":
          result = await travelToRoom(this.workflowContext, request.action, before, steps);
          break;
        case "advance_corridor":
          result = await advanceCorridor(this.workflowContext, before, steps);
          break;
        case "enter_room":
          result = await enterRoom(this.workflowContext, before, steps);
          break;
        case "return_to_previous_room":
          result = await returnToPreviousRoom(this.workflowContext, before, steps);
          break;
        case "approach_room_prop":
          result = await approachRoomProp(this.workflowContext, request.action, before, steps);
          break;
        case "interact_room_prop":
          result = await interactRoomProp(this.workflowContext, request.action, before, steps);
          break;
        case "choose_event_option":
          result = await chooseEventOption(this.workflowContext, request.action, before, steps);
          break;
        case "use_item_on_event":
          result = await useItemOnEvent(this.workflowContext, request.action, before, steps);
          break;
        case "take_all_loot":
          result = await takeAllLoot(this.workflowContext, before, steps);
          break;
        case "return_to_loot":
          result = await returnToLoot(this.workflowContext, before, steps);
          break;
        case "take_loot_item":
          result = await takeLootItem(this.workflowContext, request.action, before, steps);
          break;
        case "replace_inventory_with_loot":
          result = await replaceInventoryWithLoot(this.workflowContext, request.action, before, steps);
          break;
        case "close_loot":
          result = await closeLoot(this.workflowContext, before, steps);
          break;
        case "move_hero":
          result = await moveHero(this.workflowContext, request.action, before, steps);
          break;
        case "use_inventory_item":
          result = await useInventoryItem(this.workflowContext, request.action, before, steps);
          break;
        case "discard_inventory_item":
          result = await discardInventoryItem(this.workflowContext, request.action, before, steps);
          break;
        case "use_torch":
          result = await useTorch(this.workflowContext, before, steps);
          break;
        case "choose_camp_meal":
          result = await chooseCampMeal(this.workflowContext, request.action, before, steps);
          break;
        case "use_camp_skill":
          result = await useCampSkill(this.workflowContext, request.action, before, steps);
          break;
        case "finish_camp":
          result = await finishCamp(this.workflowContext, before, steps);
          break;
        case "retreat_combat":
        case "abandon_expedition":
        case "finish_quest":
          result = await useQuestControl(this.workflowContext, request.action, before, steps);
          break;
        case "choose_quest_completion":
          result = await chooseQuestCompletion(this.workflowContext, request.action, before, steps);
          break;
        case "continue_results":
          result = await continueResults(this.workflowContext, before, steps);
          break;
        case "recruit_stage_coach_hero":
          result = await recruitStageCoachHero(this.workflowContext, request.action, before, steps);
          break;
        case "select_building_hero":
          result = await selectBuildingHero(this.workflowContext, request.action, before, steps);
          break;
        case 'prepare_town_treatment':
        case 'choose_town_treatment':
        case 'confirm_town_treatment':
          result = await townTreatment(this.workflowContext, request.action, before, steps);
          break;
        case "buy_hero_upgrade":
          result = await buyHeroUpgrade(this.workflowContext, request.action, before, steps);
          break;
        case "buy_town_item":
          result = await buyTownItem(this.workflowContext, request.action, before, steps);
          break;
        case "assign_town_activity":
          result = await assignTownActivity(this.workflowContext, request.action, before, steps);
          break;
        case "cancel_town_activity":
          result = await cancelTownActivity(this.workflowContext, request.action, before, steps);
          break;
        case "open_building_upgrades":
          result = await openBuildingUpgrades(this.workflowContext, before, steps);
          break;
        case "buy_building_upgrade":
          result = await buyBuildingUpgrade(this.workflowContext, request.action, before, steps);
          break;
        case "close_building":
          result = await closeBuilding(this.workflowContext, before, steps);
          break;
        case "assign_circus_contestant":
          result = await assignCircusContestant(this.workflowContext, request.action, before, steps);
          break;
        case "activate_circus_hero":
          result = await activateCircusHero(this.workflowContext, request.action, before, steps);
          break;
        case "dismiss_modal":
          result = await dismissModal(this.workflowContext, before, steps);
          break;
        case 'choose_dialog_option':
          result = await chooseDialogOption(this.workflowContext, request.action, before, steps);
          break;
        case "cancel_targeting":
          result = await cancelTargeting(this.workflowContext, before, steps);
          break;
        case "pass_turn":
          result = await passTurn(this.workflowContext, before, steps);
          break;
        case "use_skill":
          result = await useSkill(this.workflowContext, request.action, before, steps);
          break;
      }

    } catch (error) {
      // A transport/read error may happen AFTER the game applied input. Cache the
      // uncertain outcome so retrying this request ID cannot execute it twice.
      result = {
        outcome: "uncertain", snapshot: before,
        reason: `Action interrupted: ${error instanceof Error ? error.message : String(error)}. Reconcile state; do not resend.`
      };
    }

    const record: ActionRecord = {
      requestId: request.requestId,
      action: request.action,
      ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
      expectedRevision: request.expectedRevision,
      sourceRevision: before.revision,
      finalRevision: result.snapshot.revision,
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: result.outcome,
      ...(result.awaitingConfirmation ? { awaitingConfirmation: true } : {}),
      stage: result.outcome === "success" && !result.awaitingConfirmation ? "settlement" : "workflow",
      reason: result.reason,
      recovery:
        result.awaitingConfirmation ? 'Read nextState.decision and explicitly choose a confirmation answer; the requested cancellation is not complete.' : result.outcome === "success"
          ? "Continue from the returned final revision."
          : result.outcome === "failure"
            ? "Refresh state before choosing another action."
            : "Refresh state and reconcile the current screen. Do not resend this request.",
      ...(steps[0] === undefined
        ? {}
        : {
          primitiveCommand: steps[0].primitiveCommand,
          acknowledgement: steps[0].acknowledgement,
        }),
      steps,
      observations: steps.flatMap((step) => step.observations),
    };
    if (
      record.outcome === "success" &&
      (request.action.kind === "use_skill" ||
        request.action.kind === "pass_turn" ||
        request.action.kind === "move_hero") &&
      before.state.currentActor !== undefined
    ) {
      this.pendingCombatTransition = {
        actorAddress: before.state.currentActor.address,
        turnTick: before.state.currentActor.turnTick,
        actionRevision: record.finalRevision,
        startedAt: record.completedAt,
      };
    }
    return this.remember(signature, record);
  }

  private reconcilePendingCombatTransition(state: GameState): void {
    const pending = this.pendingCombatTransition;
    if (pending === undefined) return;
    const actor = state.currentActor;
    if (
      !state.combatActive ||
      (state.phase !== "combat" && state.phase !== "targeting") ||
      actor === undefined ||
      actor.address !== pending.actorAddress ||
      actor.turnTick !== pending.turnTick
    ) {
      this.pendingCombatTransition = undefined;
    }
  }

  private combatTransitionIsPending(state: GameState): boolean {
    this.reconcilePendingCombatTransition(state);
    return this.pendingCombatTransition !== undefined;
  }

  async getBriefing(scope: "recent" | "session" = "recent") {
    const snapshot = await this.game.refresh();
    const selected = scope === "session" ? this.actions : this.actions.slice(-10);
    return {
      scope,
      generatedAt: new Date().toISOString(),
      currentRevision: snapshot.revision,
      currentPhase: snapshot.state.phase,
      currentContext: snapshot.state.currentContext,
      currentBuilding: snapshot.state.currentBuilding,
      outcomes: {
        success: selected.filter((record) => record.outcome === "success").length,
        failure: selected.filter((record) => record.outcome === "failure").length,
        uncertain: selected.filter((record) => record.outcome === "uncertain").length,
      },
      actions: selected,
    };
  }

  async waitForNextCombatDecision(
    timeoutMilliseconds = this.combatDecisionTimeoutMilliseconds,
  ): Promise<CombatDecisionWaitResult> {
    const pending = this.pendingCombatTransition;
    const startedAt = Date.now();
    if (pending === undefined) {
      const snapshot = await this.game.refresh();
      return {
        status: "not_applicable",
        reason: "No verified combat action is awaiting a turn transition.",
        sourceRevision: snapshot.revision,
        finalRevision: snapshot.revision,
        elapsedMs: Date.now() - startedAt,
        observations: [],
      };
    }

    const deadline = startedAt + Math.max(0, timeoutMilliseconds);
    let snapshot = await this.game.refresh();
    let readyCandidate:
      | { address: string; turnTick: number; firstSeenAt: number }
      | undefined;
    let nextInspectionAt = startedAt + Math.max(100, this.pollIntervalMilliseconds);
    while (!this.lifetime.closed && Date.now() <= deadline) {
      snapshot = await this.game.refresh();
      const state = snapshot.state;
      const observations = this.game.recordsAfter(pending.actionRevision, 2_000);
      if (
        !state.combatActive ||
        (state.phase !== "combat" && state.phase !== "targeting")
      ) {
        this.pendingCombatTransition = undefined;
        return {
          status: "combat_ended",
          reason: `Combat left the actionable loop in phase ${state.phase}.`,
          sourceRevision: pending.actionRevision,
          finalRevision: snapshot.revision,
          elapsedMs: Date.now() - startedAt,
          observations,
        };
      }

      const actor = state.currentActor;
      const actorAdvanced =
        state.phase === "combat" &&
        actor !== undefined &&
        actor.turnTick > pending.turnTick;
      if (actorAdvanced && actor !== undefined) {
        if (
          readyCandidate?.address !== actor.address ||
          readyCandidate.turnTick !== actor.turnTick
        ) {
          readyCandidate = {
            address: actor.address,
            turnTick: actor.turnTick,
            firstSeenAt: Date.now(),
          };
        }
        const inspectedActorReady =
          state.inspection?.actorAddress === actor.address &&
          state.combatActions.length > 0;
        if (
          !inspectedActorReady ||
          Date.now() - readyCandidate.firstSeenAt <
          Math.max(
            this.combatActorStabilityMilliseconds,
            this.pollIntervalMilliseconds * 2,
          )
        ) {
          // Actor handoffs can briefly expose a previous action bar. Require a
          // matching structured inspection and a short stable window before
          // returning a model-facing decision.
        } else {
          this.pendingCombatTransition = undefined;
          return {
            status: "ready",
            reason: `The next controllable hero is ${actor.name}.`,
            sourceRevision: pending.actionRevision,
            finalRevision: snapshot.revision,
            elapsedMs: Date.now() - startedAt,
            observations,
          };
        }
      } else {
        readyCandidate = undefined;
      }

      const now = Date.now();
      if (now >= nextInspectionAt && this.inFlight === undefined) {
        await this.game.send({ kind: "inspect_state", args: {} });
        nextInspectionAt = now + Math.max(750, this.inspectionTimeoutMilliseconds);
      }
      await this.lifetime.wait(this.pollIntervalMilliseconds);
    }

    return {
      status: "timeout",
      reason:
        "Timed out while waiting for the next controllable hero. The action will not be resent.",
      sourceRevision: pending.actionRevision,
      finalRevision: snapshot.revision,
      elapsedMs: Date.now() - startedAt,
      observations: this.game.recordsAfter(pending.actionRevision, 2_000),
    };
  }

  private validationFailure(
    request: ActionRequest,
    snapshot: CombatLogSnapshot,
    reason: string,
  ): ActionRecord {
    const now = new Date().toISOString();
    return {
      requestId: request.requestId,
      action: request.action,
      ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
      expectedRevision: request.expectedRevision,
      sourceRevision: snapshot.revision,
      finalRevision: snapshot.revision,
      startedAt: now,
      completedAt: now,
      outcome: "failure",
      stage: "validation",
      reason,
      recovery:
        "Refresh state and submit a new requestId with the current revision.",
      steps: [],
      observations: [],
    };
  }

  private remember(signature: string, record: ActionRecord): ActionRecord {
    this.actions.push(record);
    this.requests.set(record.requestId, { signature, record });
    if (this.actions.length > this.actionHistoryLimit) {
      const removed = this.actions.splice(
        0,
        this.actions.length - this.actionHistoryLimit,
      );
      for (const action of removed) this.requests.delete(action.requestId);
    }
    return record;
  }
}
