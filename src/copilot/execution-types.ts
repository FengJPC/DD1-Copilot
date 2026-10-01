import type { BlindestLogRecord, CombatLogSnapshot } from '../live/combat-log-source.js';
import type { ActionOutcome, ActionStepRecord } from './types.js';

export interface CopilotEngineOptions {
  settlementTimeoutMilliseconds?: number;
  pollIntervalMilliseconds?: number;
  inspectionTimeoutMilliseconds?: number;
  combatDecisionTimeoutMilliseconds?: number;
  combatActorStabilityMilliseconds?: number;
  actionHistoryLimit?: number;
}

export interface CombatDecisionWaitResult {
  status: "ready" | "combat_ended" | "timeout" | "not_applicable";
  reason: string;
  sourceRevision: number;
  finalRevision: number;
  elapsedMs: number;
  observations: BlindestLogRecord[];
}

export interface StepEvaluation {
  outcome: "success" | "failure";
  reason: string;
}

export interface StepResult {
  record: ActionStepRecord;
  snapshot: CombatLogSnapshot;
}

export interface WorkflowResult {
  outcome: ActionOutcome;
  reason: string;
  snapshot: CombatLogSnapshot;
  awaitingConfirmation?: boolean;
}

export interface PendingCombatTransition {
  actorAddress: string;
  turnTick: number;
  actionRevision: number;
  startedAt: string;
}
