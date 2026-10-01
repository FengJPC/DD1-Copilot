import { CampaignMemoryStore } from './campaign-memory.js';
import type { CopilotEngine } from './engine.js';
import { TacticalStateProjector } from './tactical-projector.js';
import type { ActionRequest } from './types.js';
import { actionSignature } from './workflow-support.js';

export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;
const COMBAT_DECISIONS = new Set(['use_skill', 'pass_turn', 'move_hero']);
export type CopilotState = Awaited<ReturnType<CopilotEngine['getState']>>;

export interface SessionActionOptions {
  waitForNextDecision?: boolean;
  waitTimeoutMilliseconds?: number;
}

/** Shared action/turn handoff and durable observation for both entry points. */
export class CopilotSession {
  readonly tactical = new TacticalStateProjector();
  private closed = false;
  private inFlight?: { requestId: string; signature: string; promise: Promise<SessionActionResult> };
  private readonly receipts = new Map<string, { signature: string; result: SessionActionResult }>();

  constructor(readonly engine: CopilotEngine, readonly memory: CampaignMemoryStore) { }

  async getState(mode: 'compact' | 'delta' | 'full' = 'compact', afterRevision = 0) {
    this.ensureOpen();
    const state = await this.engine.getState(mode, afterRevision);
    this.ensureOpen();
    this.memory.observeState(state);
    if (state.phase !== 'combat' && state.phase !== 'targeting') this.tactical.reset();
    return state;
  }

  async refresh(mode: 'compact' | 'delta' | 'full' = 'compact', afterRevision = 0, includeMap = false) {
    this.ensureOpen();
    const state = await this.engine.forceRefresh(mode, afterRevision, includeMap);
    this.ensureOpen();
    this.memory.observeState(state);
    if (state.phase !== 'combat' && state.phase !== 'targeting') this.tactical.reset();
    return state;
  }

  projectCombat(state: CopilotState): ReturnType<TacticalStateProjector['project']> {
    this.ensureOpen();
    const packet = this.tactical.project(state);
    if (packet.available) this.memory.observeTactical(packet);
    return packet;
  }

  async execute(request: ActionRequest, options: SessionActionOptions = {}): Promise<SessionActionResult> {
    this.ensureOpen();
    const signature = actionSignature(request);
    const previous = this.receipts.get(request.requestId);
    if (previous?.signature === signature) {
      return { ...previous.result, action: { ...previous.result.action, deduplicated: true } };
    }
    if (previous) throw new Error('requestId was already used for a different action. No input was sent.');
    if (this.inFlight) {
      if (this.inFlight.requestId !== request.requestId || this.inFlight.signature !== signature) {
        throw new Error('Another action or turn handoff is in flight. No input was sent.');
      }
      const result = await this.inFlight.promise;
      return { ...result, action: { ...result.action, deduplicated: true } };
    }
    const promise = this.executeOnce(request, options);
    this.inFlight = { requestId: request.requestId, signature, promise };
    try {
      const result = await promise;
      this.receipts.set(request.requestId, { signature, result });
      if (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
      return result;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async executeOnce(request: ActionRequest, options: SessionActionOptions): Promise<SessionActionResult> {
    this.ensureOpen();
    const action = await this.engine.act(request);
    this.ensureOpen();
    this.memory.recordAction(action);
    const shouldWait = options.waitForNextDecision !== false &&
      action.outcome === 'success' && COMBAT_DECISIONS.has(action.action.kind);
    const transition = shouldWait
      ? await this.engine.waitForNextCombatDecision(options.waitTimeoutMilliseconds ?? DEFAULT_DECISION_TIMEOUT_MS)
      : undefined;
    this.ensureOpen();
    const dialogAnswered = action.outcome === 'success' && action.action.kind === 'choose_dialog_option';
    const state = transition !== undefined || action.outcome === 'uncertain' || action.awaitingConfirmation || dialogAnswered
      ? await this.getState('compact', 0) : undefined;
    return {
      action,
      transition,
      nextDecision: transition?.status === 'ready' && state ? this.projectCombat(state) : undefined,
      nextState: transition?.status === 'combat_ended' || action.awaitingConfirmation || dialogAnswered ? state : undefined,
      reconciled: transition?.status === 'timeout' || action.outcome === 'uncertain' ? state : undefined,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.close();
    this.tactical.reset();
    this.memory.close();
  }

  private ensureOpen() {
    if (this.closed) throw new Error('The DD1 session is closed.');
  }
}

export interface SessionActionResult {
  action: Awaited<ReturnType<CopilotEngine['act']>>;
  transition?: Awaited<ReturnType<CopilotEngine['waitForNextCombatDecision']>>;
  nextDecision?: ReturnType<TacticalStateProjector['project']>;
  nextState?: CopilotState;
  reconciled?: CopilotState;
}
