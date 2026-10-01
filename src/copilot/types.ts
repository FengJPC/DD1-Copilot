import type { CommandAcknowledgement, GameCommand } from "../command/transport.js";
import type {
  BlindestLogRecord,
  CombatLogSnapshot,
} from "../live/combat-log-source.js";

import type { CopilotAction } from "./action-schema.js";
export type { CopilotAction } from "./action-schema.js";

export type ActionOutcome = "success" | "failure" | "uncertain";

export interface ActionRequest {
  requestId: string;
  expectedRevision: number;
  action: CopilotAction;
  rationale?: string;
}

export interface ActionStepRecord {
  name: string;
  sourceRevision: number;
  finalRevision: number;
  outcome: ActionOutcome;
  reason: string;
  primitiveCommand: GameCommand;
  acknowledgement: CommandAcknowledgement;
  observations: BlindestLogRecord[];
}

export interface ActionRecord {
  requestId: string;
  action: CopilotAction;
  rationale?: string;
  expectedRevision: number;
  sourceRevision: number;
  finalRevision: number;
  startedAt: string;
  completedAt: string;
  outcome: ActionOutcome;
  stage: "validation" | "workflow" | "settlement";
  reason: string;
  recovery: string;
  primitiveCommand?: GameCommand;
  acknowledgement?: CommandAcknowledgement;
  steps: ActionStepRecord[];
  observations: BlindestLogRecord[];
  deduplicated?: boolean;
  awaitingConfirmation?: boolean;
}

export interface GameGateway {
  refresh(): Promise<CombatLogSnapshot>;
  recordsAfter(revision: number, limit?: number): BlindestLogRecord[];
  send(command: GameCommand): Promise<CommandAcknowledgement>;
}
