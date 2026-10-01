import type { StepExecutor } from './step-executor.js';
import type { GameGateway } from './types.js';

/** Narrow shared services; scene workflows do not own session or request state. */
export interface WorkflowContext {
  readonly game: GameGateway;
  readonly settlementTimeoutMilliseconds: number;
  readonly inspectionTimeoutMilliseconds: number;
  readonly pollIntervalMilliseconds: number;
  readonly executeStep: StepExecutor['execute'];
}
