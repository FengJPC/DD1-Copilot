import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportCampaignJournal } from './memory/export-journal.js';
import { CampaignQueries } from './memory/queries.js';
import { installCampaignSchema } from './memory/schema.js';

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
}

export interface CampaignMemoryOptions {
  path: string;
  campaignId: string;
  now?: () => string;
}

const ACTIVE_PHASES = new Set([
  "loading",
  "room",
  "traveling",
  "combat",
  "targeting",
  "event",
  "loot",
  "camp",
  "quest",
  "post_combat",
  "results",
]);

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-");
  return cleaned || "local-default";
}

export function campaignIdFromEnvironment(): string {
  const configured = process.env.DD1_CAMPAIGN_ID?.trim();
  if (configured) return configured;
  const saveDirectory = process.env.DD1_SAVE_DIR?.trim();
  if (saveDirectory) return basename(saveDirectory.replace(/[\\/]+$/u, ""));
  return "local-default";
}

export function campaignMemoryPathFromEnvironment(campaignId: string): string {
  const configured = process.env.DD1_MEMORY_DB?.trim();
  if (configured) return resolve(configured);
  const localData = process.env.LOCALAPPDATA?.trim() || process.cwd();
  return join(
    localData,
    "DD1AgentBridge",
    "campaigns",
    safeSegment(campaignId),
    "campaign.sqlite",
  );
}

export function campaignMemoryOptionsFromEnvironment(): CampaignMemoryOptions {
  const campaignId = campaignIdFromEnvironment();
  return {
    campaignId,
    path: campaignMemoryPathFromEnvironment(campaignId),
  };
}

export class CampaignMemoryStore {
  readonly path: string;
  readonly campaignId: string;

  private readonly database: DatabaseSync;
  private readonly queries: CampaignQueries;
  private readonly now: () => string;
  private activeExpeditionId?: string;
  private lastPhase?: string;
  private closed = false;

  constructor(options: CampaignMemoryOptions) {
    this.path = resolve(options.path);
    this.campaignId = options.campaignId;
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
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

    const active = this.database
      .prepare(
        `SELECT expedition_id FROM expeditions
         WHERE campaign_id=? AND status='active'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(this.campaignId) as { expedition_id?: string } | undefined;
    this.activeExpeditionId = active?.expedition_id;
    this.queries = new CampaignQueries(this.database, this.campaignId, this.path, () => this.activeExpeditionId);
  }

  static fromEnvironment(): CampaignMemoryStore {
    return new CampaignMemoryStore(campaignMemoryOptionsFromEnvironment());
  }

  private touch(timestamp = this.now()): void {
    this.database
      .prepare("UPDATE campaigns SET updated_at=? WHERE campaign_id=?")
      .run(timestamp, this.campaignId);
  }

  private startExpedition(revision: number, quest: unknown, timestamp: string): void {
    if (this.activeExpeditionId) return;
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
      .run(timestamp, revision, stableJson(summary), this.activeExpeditionId);
    this.activeExpeditionId = undefined;
  }

  observeState(state: CampaignStateObservation): void {
    const phase = state.phase ?? "unknown";
    const timestamp = state.observedAt ?? this.now();
    if (ACTIVE_PHASES.has(phase) && !this.activeExpeditionId) {
      this.startExpedition(state.revision, state.quest, timestamp);
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
        `phase:${state.revision}:${digest(payload)}`,
        timestamp,
      );
      this.lastPhase = phase;
    }
    this.touch(timestamp);
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
        details: profile.details,
        resists: profile.resists,
        quirks: profile.quirks,
        diseases: profile.diseases,
      };
      const profileHash = digest(payload);
      const existing = this.database
        .prepare(
          `SELECT first_seen_at FROM heroes
           WHERE campaign_id=? AND hero_guid=?`,
        )
        .get(this.campaignId, profile.heroGuid) as
        | { first_seen_at: string }
        | undefined;
      this.database
        .prepare(
          `INSERT INTO heroes(
             campaign_id, hero_guid, name, first_seen_at, last_seen_at,
             latest_revision, profile_hash, profile_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(campaign_id, hero_guid) DO UPDATE SET
             name=excluded.name,
             last_seen_at=excluded.last_seen_at,
             latest_revision=excluded.latest_revision,
             profile_hash=excluded.profile_hash,
             profile_json=excluded.profile_json`,
        )
        .run(
          this.campaignId,
          profile.heroGuid,
          profile.name,
          existing?.first_seen_at ?? timestamp,
          timestamp,
          packet.revision,
          profileHash,
          stableJson(payload),
        );
      this.database
        .prepare(
          `INSERT OR IGNORE INTO hero_observations(
             campaign_id, hero_guid, expedition_id, revision, observed_at,
             profile_hash, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.campaignId,
          profile.heroGuid,
          this.activeExpeditionId ?? null,
          packet.revision,
          timestamp,
          profileHash,
          stableJson(payload),
        );
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
        `tactical:${packet.revision}:${digest(meaningful)}`,
        timestamp,
      );
    }
    this.touch(timestamp);
  }

  recordAction(action: ActionRecord): void {
    this.database
      .prepare(
        `INSERT INTO decisions(
           request_id, campaign_id, expedition_id, started_at, completed_at,
           source_revision, final_revision, rationale, action_json, outcome,
           reason, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           completed_at=excluded.completed_at,
           final_revision=excluded.final_revision,
           outcome=excluded.outcome,
           reason=excluded.reason,
           record_json=excluded.record_json`,
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
        stableJson(action),
      );
    this.touch(action.completedAt);
  }

  addReflection(input: ReflectionInput): { id: number; createdAt: string } {
    const createdAt = this.now();
    const result = this.database
      .prepare(
        `INSERT INTO reflections(
           campaign_id, expedition_id, hero_guid, created_at, kind, title,
           body, evidence_json, tags_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.campaignId,
        this.activeExpeditionId ?? null,
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
    const packet = this.getResumePacket({ heroes: 1000, decisions: 1000, reflections: 1000, expeditions: 1000 });
    return exportCampaignJournal(outputDirectory, packet, this.campaignId, this.now(), this.activeExpeditionId);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
