import { resolve } from 'node:path';
import { z } from 'zod';
import { copilotActionSchema } from './action-schema.js';
import { resolveLiveExpectedRevision } from './live-request.js';
import { summarizeActionRecord, summarizeCombatTransition } from './presentation.js';
import { CopilotSession, DEFAULT_DECISION_TIMEOUT_MS } from './session.js';
import { SessionStatePresenter } from './state-presenter.js';
import type { ActionRequest } from './types.js';

const reflectionSchema = z.object({
  kind: z.enum(['expedition_review', 'hero_plan', 'lesson', 'campaign_plan']),
  title: z.string().min(1).max(160), body: z.string().min(1).max(8_000),
  heroGuid: z.number().int().positive().optional(),
  evidenceRevisions: z.array(z.number().int().nonnegative()).max(100).optional(),
  tags: z.array(z.string().min(1).max(80)).max(32).optional(),
});
const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  op: z.enum(['state', 'refresh', 'act', 'act_current', 'briefing', 'resume',
    'hero_memory', 'memory_status', 'reflect', 'export_memory', 'stop']),
  project: z.enum(['summary']).optional(),
  mode: z.enum(['compact', 'delta', 'full']).optional(),
  sinceRevision: z.coerce.number().int().nonnegative().optional(),
  expectedRevision: z.unknown().optional(),
  includeMap: z.boolean().optional(),
  requestId: z.string().min(1).max(128).optional(),
  action: copilotActionSchema.optional(),
  rationale: z.string().min(1).max(500).optional(),
  waitForNextDecision: z.boolean().optional(),
  waitTimeoutMilliseconds: z.coerce.number().int().min(1_000).max(60_000).optional(),
  scope: z.enum(['recent', 'session']).optional(),
  detail: z.enum(['full']).optional(),
  heroGuid: z.coerce.number().int().positive().optional(),
  observationLimit: z.coerce.number().int().min(1).max(32).optional(),
  reflectionLimit: z.coerce.number().int().min(1).max(32).optional(),
  reflection: reflectionSchema.optional(),
  outputDirectory: z.string().min(1).max(1_024).optional(),
});

/** JSON protocol adapter; action execution and durable memory belong to the session. */
export class LiveRequestHandler {
  private readonly presenter: SessionStatePresenter;
  private lastSummaryRevision?: number;
  private primed = false;
  private readonly normalizedRequests = new Map<string, ActionRequest>();

  constructor(private readonly session: CopilotSession) {
    this.presenter = new SessionStatePresenter(session);
  }

  async handle(value: unknown): Promise<Record<string, unknown>> {
    const request = requestSchema.parse(value);
    const { memory, engine } = this.session;
    switch (request.op) {
      case 'state': {
        const autoDelta = request.project === 'summary' && request.mode === undefined &&
          !request.includeMap && this.lastSummaryRevision !== undefined;
        let mode = request.mode ?? (autoDelta ? 'delta' : 'compact');
        let state = await this.session.getState(mode, request.sinceRevision ?? (autoDelta ? this.lastSummaryRevision! : 0));
        if (request.project === 'summary' && state.resyncRequired) {
          this.presenter.reset();
          mode = 'compact';
          state = await this.session.getState(mode, 0);
        }
        if (request.project === 'summary') this.lastSummaryRevision = state.revision;
        let projected = request.project === 'summary' ? this.presenter.project(state, request.includeMap) : state;
        if (request.project === 'summary' && state.mapUpdate !== undefined) {
          const current = await this.session.getState('compact', 0);
          const currentView = this.presenter.project(current, request.includeMap);
          const map = currentView.map;
          // A newly learned topology needs a baseline even during delta mode.
          if (map && typeof map === 'object' && 'areas' in map) projected = { ...projected, map };
        }
        return { mode, state: projected };
      }
      case 'refresh': {
        const mode = request.mode ?? 'compact';
        const state = await this.session.refresh(mode, request.sinceRevision ?? 0, request.includeMap);
        this.primed = true;
        if (request.project === 'summary') this.lastSummaryRevision = state.revision;
        return { mode, state: request.project === 'summary' ? this.presenter.project(state, request.includeMap) : state };
      }
      case 'act':
      case 'act_current': {
        if (!request.action) throw new Error('An action is required.');
        const state = this.primed ? await this.session.getState() : await this.session.refresh();
        this.primed = true;
        const requestId = request.requestId ?? String(request.id ?? 'request');
        const previous = this.normalizedRequests.get(requestId);
        const implicitRevision = request.op === 'act_current' || request.expectedRevision == null;
        const sameAction = previous && JSON.stringify(previous.action) === JSON.stringify(request.action);
        const normalized: ActionRequest = {
          requestId,
          expectedRevision: implicitRevision && sameAction ? previous.expectedRevision
            : resolveLiveExpectedRevision(request.op === 'act_current' ? undefined : request.expectedRevision, state.revision),
          action: request.action, rationale: request.rationale,
        };
        if (!previous) {
          this.normalizedRequests.set(requestId, normalized);
          if (this.normalizedRequests.size > 100) this.normalizedRequests.delete(this.normalizedRequests.keys().next().value!);
        }
        const result = await this.session.execute(normalized, {
          waitForNextDecision: request.waitForNextDecision,
          waitTimeoutMilliseconds: request.waitTimeoutMilliseconds ?? DEFAULT_DECISION_TIMEOUT_MS,
        });
        return {
          source: { revision: state.revision, phase: state.phase, context: state.context },
          ...result,
          action: request.op === 'act' ? result.action : summarizeActionRecord(result.action),
          transition: result.transition ? summarizeCombatTransition(result.transition) : undefined,
          nextState: result.nextState ? this.presenter.project(result.nextState) : undefined,
          reconciled: result.reconciled ? this.presenter.project(result.reconciled) : undefined,
        };
      }
      case 'briefing': return { briefing: await engine.getBriefing(request.scope ?? 'recent') };
      case 'resume': return { memory: request.detail === 'full' ? memory.getResumePacket() : memory.getCampaignOverview() };
      case 'hero_memory': {
        if (request.heroGuid === undefined) throw new Error('heroGuid is required.');
        return {
          memory: memory.getHeroMemory(request.heroGuid, {
            observations: request.observationLimit ?? 8, reflections: request.reflectionLimit ?? 8,
          })
        };
      }
      case 'memory_status': return { memory: memory.getStatus() };
      case 'reflect': {
        if (!request.reflection) throw new Error('A reflection is required.');
        return { reflection: memory.addReflection(request.reflection) };
      }
      case 'export_memory': return { export: memory.exportMarkdown(request.outputDirectory ?? resolve('runs', 'campaign-memory', memory.campaignId)) };
      case 'stop': return { stopped: true };
    }
  }
}
