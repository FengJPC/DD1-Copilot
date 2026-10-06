import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportCampaignJournal } from './memory/export-journal.js';
import { CampaignQueries } from './memory/queries.js';
import { installCampaignSchema } from './memory/schema.js';
import { normalizeSaveDirectory, registerMemoryConfiguration, resolveMemoryConfiguration } from './memory/storage-config.js';
import { collectHeroProfiles } from './memory/profile-observation.js';
import { mergeHeroProfile } from './memory/merge-profile.js';
import { durableActionRecord } from './memory/action-evidence.js';
import type { CombatLogSnapshot } from '../live/combat-log-source.js';

import type { ActionRecord } from "./types.js";

export type ReflectionKind =
  | "expedition_review"
  | "hero_plan"
  | "lesson"
  | "campaign_plan";

export interface ReflectionInput {
  kind: ReflectionKind;
  title: string;
  body: string;
  heroGuid?: number;
  evidenceRevisions?: number[];
  tags?: string[];
  expeditionId?: string;
}

interface ProfileUpdate {
  side: "party" | "enemy";
  slot: number;
  heroGuid?: number;
  name: string;
  details: string[];
  resists: string[];
  quirks: string[];
  diseases: string[];
}

export interface TacticalMemoryPacket {
  revision: number;
  observedAt?: string;
  phase?: string;
  baseline?: boolean;
  profileUpdates?: ProfileUpdate[];
  recentResults?: unknown[];
  recentBuffs?: unknown[];
  questUpdate?: unknown;
}

export interface CampaignStateObservation {
  revision: number;
  observedAt?: string;
  phase?: string;
  context?: string;
  quest?: unknown;
  results?: unknown;
  circusActive?: boolean;
}

export interface CampaignMemoryOptions {
  path: string;
  campaignId: string;
  now?: () => string;
  saveDirectory?: string;
}

const ACTIVE_PHASES = new Set([
  "room",
  "traveling",
  "combat",
  "targeting",
  "event",
  "loot",
  "camp",
  "quest",
  "post_combat",
]);

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function campaignIdFromEnvironment(): string {
  return resolveMemoryConfiguration().campaignId;
}

export function campaignMemoryPathFromEnvironment(campaignId: string): string {
  const configuration = resolveMemoryConfiguration();
  if (configuration.campaignId !== campaignId) throw new Error('Campaign ID does not match the storage binding.');
  return configuration.path;
}

export function campaignMemoryOptionsFromEnvironment(): CampaignMemoryOptions {
  return resolveMemoryConfiguration();
}

export class CampaignMemoryStore {
  readonly path: string;
  readonly campaignId: string;

  private readonly database: DatabaseSync;
  private readonly queries: CampaignQueries;
  private readonly now: () => string;
  private activeExpeditionId?: string;
  private lastPhase?: string;
  private readonly observationSession = randomUUID();
  private latestQuest?: unknown;
  private latestResults?: unknown;
  private closed = false;

  constructor(options: CampaignMemoryOptions) {
    this.path = resolve(options.path);
    this.campaignId = options.campaignId;
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    const existingSchema = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
    if (existingSchema) {
      const existingCampaigns = this.database.prepare('SELECT campaign_id FROM campaigns').all() as Array<{ campaign_id: string }>;
      if (existingCampaigns.some(row => row.campaign_id !== this.campaignId)) {
        this.database.close();
        throw new Error('This database belongs to another campaign. Use its binding or a separate database.');
      }
      if(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_binding'").get()) {
        const prior=this.database.prepare('SELECT save_directory FROM campaign_binding WHERE campaign_id=?').get(this.campaignId) as {save_directory:string}|undefined;
        if(prior && (!options.saveDirectory || normalizeSaveDirectory(options.saveDirectory)!==prior.save_directory)) {
          this.database.close();
          throw new Error(options.saveDirectory ? 'Campaign database is bound to a different save directory.' : 'Configure its saveDirectory before opening this bound database.');
        }
      }
    }
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA busy_timeout = 3000;");
    installCampaignSchema(this.database);

    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT INTO campaigns(campaign_id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(campaign_id) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .run(this.campaignId, timestamp, timestamp);

    const binding = this.database.prepare('SELECT save_directory FROM campaign_binding WHERE campaign_id=?').get(this.campaignId) as { save_directory: string } | undefined;
    if (options.saveDirectory) {
      const saveDirectory = normalizeSaveDirectory(options.saveDirectory);
      if (binding && binding.save_directory !== saveDirectory) {
        this.database.close();
        throw new Error('Campaign database is bound to a different save directory. Use a new campaign ID/database.');
      }
      this.database.prepare('INSERT OR IGNORE INTO campaign_binding(campaign_id,save_directory) VALUES (?,?)').run(this.campaignId, saveDirectory);
    } else if (binding) {
      this.database.close();
      throw new Error('This database is bound to a save. Configure its saveDirectory before opening it.');
    }

    const active = this.database
      .prepare(
        `SELECT expedition_id FROM expeditions
         WHERE campaign_id=? AND status='active'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(this.campaignId) as { expedition_id?: string } | undefined;
    this.activeExpeditionId = active?.expedition_id;
    if (this.activeExpeditionId) {
      const previous = this.database.prepare('SELECT quest_json,result_json FROM expeditions WHERE expedition_id=?').get(this.activeExpeditionId) as { quest_json?: string; result_json?: string };
      this.latestQuest = previous.quest_json ? JSON.parse(previous.quest_json) : undefined;
      this.latestResults = previous.result_json ? JSON.parse(previous.result_json) : undefined;
    }
    this.queries = new CampaignQueries(this.database, this.campaignId, this.path, () => this.activeExpeditionId);
  }

  static fromEnvironment(): CampaignMemoryStore {
    const configuration=resolveMemoryConfiguration();
    registerMemoryConfiguration(configuration);
    return new CampaignMemoryStore(configuration);
  }

  private touch(timestamp = this.now()): void {
    this.database
      .prepare("UPDATE campaigns SET updated_at=? WHERE campaign_id=?")
      .run(timestamp, this.campaignId);
  }

  private startExpedition(revision: number, quest: unknown, timestamp: string): void {
    if (this.activeExpeditionId) return;
    this.latestQuest = quest;
    this.latestResults = undefined;
    const expeditionId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO expeditions(
           expedition_id, campaign_id, started_at, status, start_revision, quest_json
         ) VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        expeditionId,
        this.campaignId,
        timestamp,
        revision,
        quest === undefined ? null : stableJson(quest),
      );
    this.activeExpeditionId = expeditionId;
  }

  private endExpedition(revision: number, timestamp: string): void {
    if (!this.activeExpeditionId) return;
    const summary = this.buildExpeditionSummary(this.activeExpeditionId);
    this.database
      .prepare(
        `UPDATE expeditions
         SET ended_at=?, status='complete', end_revision=?, summary_json=?
         WHERE expedition_id=?`,
      )
      .run(timestamp, revision, stableJson({ ...summary, endReason: 'returned_to_town',
        questOutcome: this.latestQuest && typeof this.latestQuest === 'object' && 'complete' in this.latestQuest && this.latestQuest.complete === true ? 'objective_complete_observed' : 'unknown',
        results: this.latestResults,
      }), this.activeExpeditionId);
    this.activeExpeditionId = undefined;
  }

  observeState(state: CampaignStateObservation): void {
    const phase = state.phase ?? "unknown";
    const timestamp = state.observedAt ?? this.now();
    if (!state.circusActive && ACTIVE_PHASES.has(phase) && !this.activeExpeditionId) {
      this.startExpedition(state.revision, state.quest, timestamp);
    }
    if (this.activeExpeditionId) {
      if (state.quest !== undefined && phase !== 'town' && phase !== 'building') this.latestQuest = state.quest;
      if (phase === 'results' && state.results !== undefined) this.latestResults = state.results;
      this.database.prepare('UPDATE expeditions SET quest_json=COALESCE(?,quest_json),result_json=COALESCE(?,result_json) WHERE expedition_id=?')
        .run(this.latestQuest === undefined ? null : stableJson(this.latestQuest), this.latestResults === undefined ? null : stableJson(this.latestResults), this.activeExpeditionId);
    }
    if ((phase === "town" || phase === "building") && this.activeExpeditionId) {
      this.endExpedition(state.revision, timestamp);
    }

    if (phase !== this.lastPhase) {
      const payload = {
        phase,
        context: state.context,
        quest: state.quest,
        results: state.results,
      };
      this.insertRecord(
        "phase",
        "state",
        state.revision,
        payload,
        `phase:${this.observationSession}:${state.revision}:${digest(payload)}`,
        timestamp,
      );
      this.lastPhase = phase;
    }
    this.touch(timestamp);
  }

  observeSnapshot(snapshot: CombatLogSnapshot): void {
    if (!snapshot.source.available) return;
    const state = snapshot.state;
    this.observeState({ revision: snapshot.revision, observedAt: snapshot.observedAt,
      phase: state.phase, context: state.currentContext, quest: state.quest, results: state.results,
      circusActive: state.circusCombat?.active === true,
    });
    if (state.inspection && (state.inspection.completedTick ?? -1) < state.inspection.startedTick) return;
    for (const hero of collectHeroProfiles(state)) this.observeHero(hero.heroGuid, hero.name, hero.profile, snapshot.revision, snapshot.observedAt);
    const facts = {
      ...(state.townWallet && ['town','building'].includes(state.phase) ? { wallet: state.townWallet } : {}),
      ...(state.phase === 'results' && state.results ? { results: state.results } : {}),
      ...(state.partyPlanning && ['embark','provision'].includes(state.phase) ? { party: state.partyPlanning.slots.map(({heroGuid,position,name})=>({heroGuid,position,name})) } : {}),
    };
    if (Object.keys(facts).length) {
      const previous = this.database.prepare("SELECT payload_json FROM records WHERE campaign_id=? AND kind='checkpoint' ORDER BY id DESC LIMIT 1").get(this.campaignId) as { payload_json: string } | undefined;
      if (previous?.payload_json !== stableJson(facts)) this.insertRecord('checkpoint', 'memory_log', snapshot.revision, facts, `checkpoint:${this.observationSession}:${snapshot.revision}:${digest(facts)}`, snapshot.observedAt);
    }
  }

  private observeHero(heroGuid: number, name: string, update: Record<string, unknown>, revision: number, timestamp: string): void {
    const existing = this.database.prepare('SELECT first_seen_at,profile_hash,profile_json,hero_class FROM heroes WHERE campaign_id=? AND hero_guid=?').get(this.campaignId, heroGuid) as { first_seen_at: string; profile_hash: string; profile_json: string; hero_class?: string } | undefined;
    const prior=existing ? JSON.parse(existing.profile_json) : {};
    const payload = mergeHeroProfile(prior, update, name);
    const hash = digest(payload);
    this.database.prepare(`INSERT INTO heroes(campaign_id,hero_guid,name,hero_class,first_seen_at,last_seen_at,latest_revision,profile_hash,profile_json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,hero_guid) DO UPDATE SET name=excluded.name,hero_class=excluded.hero_class,last_seen_at=excluded.last_seen_at,latest_revision=excluded.latest_revision,profile_hash=excluded.profile_hash,profile_json=excluded.profile_json`)
      .run(this.campaignId,heroGuid,name,typeof payload.heroClass === 'string' ? payload.heroClass : existing?.hero_class ?? null,existing?.first_seen_at ?? timestamp,timestamp,revision,hash,stableJson(payload));
    if (existing?.profile_hash !== hash) this.database.prepare('INSERT INTO hero_observations(campaign_id,hero_guid,expedition_id,revision,observed_at,profile_hash,payload_json) VALUES (?,?,?,?,?,?,?)')
      .run(this.campaignId,heroGuid,this.activeExpeditionId ?? null,revision,timestamp,hash,stableJson(payload));
  }

  observeTactical(packet: TacticalMemoryPacket): void {
    const timestamp = packet.observedAt ?? this.now();
    if (ACTIVE_PHASES.has(packet.phase ?? "") && !this.activeExpeditionId) {
      this.startExpedition(packet.revision, packet.questUpdate, timestamp);
    }

    for (const profile of packet.profileUpdates ?? []) {
      if (profile.side !== "party" || profile.heroGuid === undefined) continue;
      const payload = {
        name: profile.name,
        ...(profile.details.length ? {details:profile.details,resists:profile.resists,quirks:profile.quirks,diseases:profile.diseases} : {}),
      };
      this.observeHero(profile.heroGuid, profile.name, payload, packet.revision, timestamp);
    }

    const meaningful = {
      baseline: packet.baseline || undefined,
      recentResults: packet.recentResults,
      recentBuffs: packet.recentBuffs,
      questUpdate: packet.questUpdate,
    };
    if (
      meaningful.baseline ||
      (meaningful.recentResults?.length ?? 0) > 0 ||
      (meaningful.recentBuffs?.length ?? 0) > 0 ||
      meaningful.questUpdate !== undefined
    ) {
      this.insertRecord(
        meaningful.baseline ? "tactical_baseline" : "tactical_event",
        "tactical_projector",
        packet.revision,
        meaningful,
        `tactical:${this.observationSession}:${packet.revision}:${digest(meaningful)}`,
        timestamp,
      );
    }
    this.touch(timestamp);
  }

  recordAction(action: ActionRecord): void {
    const previous=this.getRecordedAction(action.requestId);
    if(previous) {
      if(previous.startedAt===action.startedAt && stableJson(previous.action)===stableJson(action.action)) return;
      throw new Error('requestId already exists in this campaign. Historical decisions cannot be overwritten.');
    }
    this.database
      .prepare(
        `INSERT INTO decisions(
           request_id, campaign_id, expedition_id, started_at, completed_at,
           source_revision, final_revision, rationale, action_json, outcome,
           reason, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         `,
      )
      .run(
        action.requestId,
        this.campaignId,
        this.activeExpeditionId ?? null,
        action.startedAt,
        action.completedAt,
        action.sourceRevision,
        action.finalRevision,
        action.rationale ?? null,
        stableJson(action.action),
        action.outcome,
        action.reason,
        stableJson(durableActionRecord(action)),
      );
    this.touch(action.completedAt);
  }

  addReflection(input: ReflectionInput): { id: number; createdAt: string } {
    const createdAt = this.now();
    const expeditionId = input.expeditionId ?? (input.kind === 'expedition_review'
      ? this.getPendingReviews(1)[0]?.expeditionId : this.activeExpeditionId);
    if (input.kind === 'expedition_review' && !expeditionId) throw new Error('An expedition review must name a recorded expeditionId.');
    if (expeditionId && !this.database.prepare('SELECT 1 FROM expeditions WHERE campaign_id=? AND expedition_id=?').get(this.campaignId, expeditionId)) throw new Error('Expedition does not belong to this campaign.');
    if (input.kind === 'expedition_review' && this.database.prepare("SELECT 1 FROM expeditions WHERE expedition_id=? AND status='active'").get(expeditionId!)) throw new Error('The expedition is still active; record a lesson or plan, then review it after returning to town.');
    const result = this.database
      .prepare(
        `INSERT INTO reflections(
           campaign_id, expedition_id, hero_guid, created_at, kind, title,
           body, evidence_json, tags_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.campaignId,
        expeditionId ?? null,
        input.heroGuid ?? null,
        createdAt,
        input.kind,
        input.title,
        input.body,
        stableJson(input.evidenceRevisions ?? []),
        stableJson(input.tags ?? []),
      );
    this.touch(createdAt);
    return { id: Number(result.lastInsertRowid), createdAt };
  }

  private insertRecord(
    kind: string,
    source: string,
    revision: number,
    payload: unknown,
    recordKey: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO records(
           campaign_id, expedition_id, revision, recorded_at, kind, source,
           record_key, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.campaignId,
        this.activeExpeditionId ?? null,
        revision,
        timestamp,
        kind,
        source,
        recordKey,
        stableJson(payload),
      );
  }

  private buildExpeditionSummary(expeditionId: string): Record<string, unknown> { return this.queries.buildExpeditionSummary(expeditionId); }

  getPendingReviews(limit = 3) { return this.queries.getPendingReviews(limit); }

  getRecordedAction(requestId:string):ActionRecord|undefined {
    const row=this.database.prepare('SELECT record_json FROM decisions WHERE campaign_id=? AND request_id=?').get(this.campaignId,requestId) as {record_json:string}|undefined;
    return row ? JSON.parse(row.record_json) as ActionRecord : undefined;
  }

  getResumePacket(limits: {
    heroes?: number;
    decisions?: number;
    reflections?: number;
    expeditions?: number;
  } = {}) { return this.queries.getResumePacket(limits); }

  getCampaignOverview(limits: {
    heroes?: number;
    decisions?: number;
    reflections?: number;
    expeditions?: number;
  } = {}): Record<string, unknown> { return this.queries.getCampaignOverview(limits); }

  getHeroMemory(
    heroGuid: number,
    limits: { observations?: number; reflections?: number } = {},
  ): Record<string, unknown> { return this.queries.getHeroMemory(heroGuid, limits); }

  getStatus(): Record<string, unknown> { return this.queries.getStatus(); }

  exportMarkdown(outputDirectory: string): { directory: string; files: string[] } {
    const counts=this.getStatus().counts as Record<string,number>;
    const packet = this.getResumePacket({ heroes: counts.heroes, decisions: counts.decisions, reflections: counts.reflections, expeditions: counts.expeditions });
    return exportCampaignJournal(outputDirectory, packet, this.campaignId, this.now(), this.activeExpeditionId);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
