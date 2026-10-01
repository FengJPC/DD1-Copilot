import type {
  BlindestLogRecord,
  CombatLogSnapshot,
} from "../live/combat-log-source.js";
import { PollingLifetime } from './cancellation.js';
import type { StepEvaluation, StepResult } from './execution-types.js';
import type {
  GameGateway
} from "./types.js";
import { compactRecord } from './workflow-support.js';

/** Runs a primitive once and waits for semantic completion evidence. */
export class StepExecutor {
  constructor(private readonly game: GameGateway, private readonly settlementTimeoutMilliseconds: number, private readonly pollIntervalMilliseconds: number, private readonly lifetime = new PollingLifetime()) { }
  async execute(
    name: string,
    before: CombatLogSnapshot,
    command: { kind: string; args: Record<string, unknown> },
    evaluate: (
      snapshot: CombatLogSnapshot,
      observations: BlindestLogRecord[],
    ) => StepEvaluation | undefined,
    timeoutMilliseconds = this.settlementTimeoutMilliseconds,
  ): Promise<StepResult> {
    this.lifetime.ensureOpen();
    const acknowledgement = await this.game.send(command).catch((error) => ({
      commandId: "unknown", transport: "unavailable" as const, status: "timeout" as const,
      receivedAt: new Date().toISOString(), reason: `Command submission interrupted: ${error instanceof Error ? error.message : String(error)}. Execution is unknown.`,
    }));
    const transportOutcome =
      acknowledgement.status === "timeout"
        ? ("uncertain" as const)
        : acknowledgement.status === "rejected" ||
          acknowledgement.status === "unavailable"
          ? ("failure" as const)
          : undefined;
    if (transportOutcome !== undefined) {
      return {
        snapshot: before,
        record: {
          name,
          sourceRevision: before.revision,
          finalRevision: before.revision,
          outcome: transportOutcome,
          reason:
            acknowledgement.reason ??
            `Primitive command was ${acknowledgement.status}.`,
          primitiveCommand: command,
          acknowledgement,
          observations: [],
        },
      };
    }

    const deadline = Date.now() + timeoutMilliseconds;
    let snapshot = before;
    let observations: BlindestLogRecord[] = [];
    while (!this.lifetime.closed && Date.now() <= deadline) {
      snapshot = await this.game.refresh();
      observations = this.game.recordsAfter(before.revision, 2_000);
      const commandStart = observations.findIndex((record) => record.message === `agent-command: begin id=${acknowledgement.commandId}`);
      if (commandStart >= 0) observations = observations.slice(commandStart);
      const rejected = commandStart >= 0
        ? observations.some((record) => record.message === `agent-command: end id=${acknowledgement.commandId} accepted=0`)
        : observations.some((record) => /^agent-ipc: serviced .* accepted=0$/u.test(record.message ?? ""));
      if (rejected) {
        const commandEnd = observations.findIndex((record) => record.message === `agent-command: end id=${acknowledgement.commandId} accepted=0`);
        const scoped = commandStart >= 0 ? observations.slice(0, commandEnd + 1) : [];
        const nativeReason = scoped.map((record) => /\breason=(.*)$/u.exec(record.message ?? '')?.[1])
          .filter((reason) => reason !== undefined).at(-1);
        return {
          snapshot,
          record: {
            name,
            sourceRevision: before.revision,
            finalRevision: snapshot.revision,
            outcome: "failure",
            reason: nativeReason ? `The game rejected ${command.kind}: ${nativeReason}` : "The game thread explicitly rejected the primitive input.",
            primitiveCommand: command,
            acknowledgement,
            observations: observations.map(compactRecord),
          },
        };
      }
      const evaluation = evaluate(snapshot, observations);
      if (evaluation !== undefined) {
        return {
          snapshot,
          record: {
            name,
            sourceRevision: before.revision,
            finalRevision: snapshot.revision,
            outcome: evaluation.outcome,
            reason: evaluation.reason,
            primitiveCommand: command,
            acknowledgement,
            observations: observations.map(compactRecord),
          },
        };
      }
      await this.lifetime.wait(this.pollIntervalMilliseconds);
    }

    return {
      snapshot,
      record: {
        name,
        sourceRevision: before.revision,
        finalRevision: snapshot.revision,
        outcome: "uncertain",
        reason:
          this.lifetime.closed ? "Session closed before completion could be verified. Execution is unknown." : "No semantic completion evidence arrived before the step timeout.",
        primitiveCommand: command,
        acknowledgement,
        observations: observations.map(compactRecord),
      },
    };
  }
}

export function resultFromStep(step: StepResult,
  successReason: string) {
  return {
    outcome: step.record.outcome,
    reason:
      step.record.outcome === "success" ? successReason : step.record.reason,
    snapshot: step.snapshot,
  };
}
