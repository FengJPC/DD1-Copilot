import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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
    this.installSchema();

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
  }

  static fromEnvironment(): CampaignMemoryStore {
    return new CampaignMemoryStore(campaignMemoryOptionsFromEnvironment());
  }

  private installSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_meta(version)
      SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);

      CREATE TABLE IF NOT EXISTS campaigns (
        campaign_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS expeditions (
        expedition_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        start_revision INTEGER NOT NULL,
        end_revision INTEGER,
        quest_json TEXT,
        summary_json TEXT,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id)
      );
      CREATE INDEX IF NOT EXISTS expeditions_campaign_started
        ON expeditions(campaign_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS heroes (
        campaign_id TEXT NOT NULL,
        hero_guid INTEGER NOT NULL,
        name TEXT NOT NULL,
        hero_class TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        latest_revision INTEGER NOT NULL,
        profile_hash TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        PRIMARY KEY(campaign_id, hero_guid),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id)
      );

      CREATE TABLE IF NOT EXISTS hero_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        hero_guid INTEGER NOT NULL,
        expedition_id TEXT,
        revision INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        profile_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(campaign_id, hero_guid, profile_hash),
        FOREIGN KEY(campaign_id, hero_guid) REFERENCES heroes(campaign_id, hero_guid),
        FOREIGN KEY(expedition_id) REFERENCES expeditions(expedition_id)
      );

      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        expedition_id TEXT,
        revision INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        record_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(campaign_id, record_key),
        FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id),
        FOREIGN KEY(expedition_id) REFERENCES expeditions(expedition_id)
      );
      CREATE INDEX IF NOT EXISTS records_campaign_revision
        ON records(campaign_id, revision DESC, id DESC);

      CREATE TABLE IF NOT EXISTS decisions (
        request_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        expedition_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        final_revision INTEGER NOT NULL,
        rationale TEXT,
        action_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        record_json TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id),
        FOREIGN KEY(expedition_id) REFERENCES expeditions(expedition_id)
      );
      CREATE INDEX IF NOT EXISTS decisions_campaign_completed
        ON decisions(campaign_id, completed_at DESC);

      CREATE TABLE IF NOT EXISTS reflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        expedition_id TEXT,
        hero_guid INTEGER,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id),
        FOREIGN KEY(expedition_id) REFERENCES expeditions(expedition_id)
      );
      CREATE INDEX IF NOT EXISTS reflections_campaign_created
        ON reflections(campaign_id, created_at DESC, id DESC);
    `);
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

  private buildExpeditionSummary(expeditionId: string): Record<string, unknown> {
    const outcomes = this.database
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM decisions
         WHERE expedition_id=? GROUP BY outcome`,
      )
      .all(expeditionId) as Array<{ outcome: string; count: number }>;
    const eventCount = this.database
      .prepare("SELECT COUNT(*) AS count FROM records WHERE expedition_id=?")
      .get(expeditionId) as { count: number };
    return {
      decisions: Object.fromEntries(outcomes.map((row) => [row.outcome, row.count])),
      recordedEvents: Number(eventCount.count),
    };
  }

  getResumePacket(limits: {
    heroes?: number;
    decisions?: number;
    reflections?: number;
    expeditions?: number;
  } = {}): Record<string, unknown> {
    const heroLimit = limits.heroes ?? 24;
    const decisionLimit = limits.decisions ?? 8;
    const reflectionLimit = limits.reflections ?? 8;
    const expeditionLimit = limits.expeditions ?? 5;

    const heroes = this.database
      .prepare(
        `SELECT hero_guid, name, latest_revision, profile_json
         FROM heroes WHERE campaign_id=?
         ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(this.campaignId, heroLimit)
      .map((row) => {
        const typed = row as {
          hero_guid: number;
          name: string;
          latest_revision: number;
          profile_json: string;
        };
        return {
          heroGuid: typed.hero_guid,
          name: typed.name,
          revision: typed.latest_revision,
          profile: parseJson(typed.profile_json, {}),
        };
      });
    const decisions = this.database
      .prepare(
        `SELECT request_id, completed_at, source_revision, final_revision,
                rationale, action_json, outcome, reason
         FROM decisions WHERE campaign_id=?
         ORDER BY completed_at DESC LIMIT ?`,
      )
      .all(this.campaignId, decisionLimit)
      .map((row) => {
        const typed = row as Record<string, unknown>;
        return {
          requestId: typed.request_id,
          completedAt: typed.completed_at,
          sourceRevision: typed.source_revision,
          finalRevision: typed.final_revision,
          rationale: typed.rationale || undefined,
          action: parseJson(typed.action_json, {}),
          outcome: typed.outcome,
          reason: typed.reason,
        };
      });
    const reflections = this.database
      .prepare(
        `SELECT id, created_at, kind, title, body, hero_guid,
                evidence_json, tags_json
         FROM reflections WHERE campaign_id=?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(this.campaignId, reflectionLimit)
      .map((row) => {
        const typed = row as Record<string, unknown>;
        return {
          id: typed.id,
          createdAt: typed.created_at,
          kind: typed.kind,
          title: typed.title,
          body: typed.body,
          heroGuid: typed.hero_guid ?? undefined,
          evidenceRevisions: parseJson(typed.evidence_json, []),
          tags: parseJson(typed.tags_json, []),
        };
      });
    const expeditions = this.database
      .prepare(
        `SELECT expedition_id, started_at, ended_at, status, start_revision,
                end_revision, quest_json, summary_json
         FROM expeditions WHERE campaign_id=?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(this.campaignId, expeditionLimit)
      .map((row) => {
        const typed = row as Record<string, unknown>;
        return {
          expeditionId: typed.expedition_id,
          startedAt: typed.started_at,
          endedAt: typed.ended_at ?? undefined,
          status: typed.status,
          startRevision: typed.start_revision,
          endRevision: typed.end_revision ?? undefined,
          quest: parseJson(typed.quest_json, undefined),
          summary: parseJson(typed.summary_json, undefined),
        };
      });

    return {
      campaignId: this.campaignId,
      databasePath: this.path,
      activeExpeditionId: this.activeExpeditionId,
      heroes,
      decisions,
      reflections,
      expeditions,
    };
  }

  getCampaignOverview(limits: {
    heroes?: number;
    decisions?: number;
    reflections?: number;
    expeditions?: number;
  } = {}): Record<string, unknown> {
    const heroLimit = limits.heroes ?? 24;
    const decisionLimit = limits.decisions ?? 3;
    const reflectionLimit = limits.reflections ?? 4;
    const expeditionLimit = limits.expeditions ?? 3;
    const shortLabel = (value: unknown) =>
      String(value).split(/[.!。]/u, 1)[0]?.trim() || String(value);
    const compactText = (value: unknown, limit: number) => {
      if (typeof value !== "string") return undefined;
      return value.length <= limit ? value : `${value.slice(0, limit)}…`;
    };

    const roster = this.database
      .prepare(
        `SELECT hero_guid, name, latest_revision, profile_json
         FROM heroes WHERE campaign_id=?
         ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(this.campaignId, heroLimit)
      .map((row) => {
        const typed = row as {
          hero_guid: number;
          name: string;
          latest_revision: number;
          profile_json: string;
        };
        const profile = parseJson<{
          quirks?: unknown[];
          diseases?: unknown[];
        }>(typed.profile_json, {});
        return {
          heroGuid: typed.hero_guid,
          name: typed.name,
          revision: typed.latest_revision,
          quirkCount: profile.quirks?.length ?? 0,
          diseases: profile.diseases?.map(shortLabel) ?? [],
        };
      });
    const decisions = this.database
      .prepare(
        `SELECT completed_at, rationale, action_json, outcome, reason
         FROM decisions WHERE campaign_id=?
         ORDER BY completed_at DESC LIMIT ?`,
      )
      .all(this.campaignId, decisionLimit)
      .map((row) => {
        const typed = row as Record<string, unknown>;
        return {
          completedAt: typed.completed_at,
          action: parseJson(typed.action_json, {}),
          rationale: compactText(typed.rationale, 300),
          outcome: typed.outcome,
          reason: compactText(typed.reason, 300),
        };
      });
    const plans = this.database
      .prepare(
        `SELECT id, created_at, kind, title, body, hero_guid, tags_json
         FROM reflections WHERE campaign_id=?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(this.campaignId, reflectionLimit)
      .map((row) => {
        const typed = row as Record<string, unknown>;
        return {
          id: typed.id,
          createdAt: typed.created_at,
          kind: typed.kind,
          title: typed.title,
          body: compactText(typed.body, 800),
          heroGuid: typed.hero_guid ?? undefined,
          tags: parseJson(typed.tags_json, []),
        };
      });
    const expeditions = this.database
      .prepare(
        `SELECT expedition_id, started_at, ended_at, status, summary_json
         FROM expeditions WHERE campaign_id=?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(this.campaignId, expeditionLimit)
      .map((row) => {
        const typed = row as Record<string, unknown>;
        return {
          expeditionId: typed.expedition_id,
          startedAt: typed.started_at,
          endedAt: typed.ended_at ?? undefined,
          status: typed.status,
          summary: parseJson(typed.summary_json, undefined),
        };
      });

    return {
      campaignId: this.campaignId,
      activeExpeditionId: this.activeExpeditionId,
      roster,
      recentDecisions: decisions,
      plans,
      recentExpeditions: expeditions,
      hint:
        "Call get_hero_memory only when a decision needs one hero's full profile or history.",
    };
  }

  getHeroMemory(
    heroGuid: number,
    limits: { observations?: number; reflections?: number } = {},
  ): Record<string, unknown> {
    const observationLimit = limits.observations ?? 8;
    const reflectionLimit = limits.reflections ?? 8;
    const row = this.database
      .prepare(
        `SELECT name, hero_class, first_seen_at, last_seen_at,
                latest_revision, profile_json
         FROM heroes WHERE campaign_id=? AND hero_guid=?`,
      )
      .get(this.campaignId, heroGuid) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        campaignId: this.campaignId,
        heroGuid,
        found: false,
      };
    }
    const observations = this.database
      .prepare(
        `SELECT revision, observed_at, payload_json
         FROM hero_observations
         WHERE campaign_id=? AND hero_guid=?
         ORDER BY observed_at DESC, id DESC LIMIT ?`,
      )
      .all(this.campaignId, heroGuid, observationLimit)
      .map((item) => {
        const typed = item as Record<string, unknown>;
        return {
          revision: typed.revision,
          observedAt: typed.observed_at,
          profile: parseJson(typed.payload_json, {}),
        };
      });
    const reflections = this.database
      .prepare(
        `SELECT id, created_at, kind, title, body, evidence_json, tags_json
         FROM reflections
         WHERE campaign_id=? AND hero_guid=?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(this.campaignId, heroGuid, reflectionLimit)
      .map((item) => {
        const typed = item as Record<string, unknown>;
        return {
          id: typed.id,
          createdAt: typed.created_at,
          kind: typed.kind,
          title: typed.title,
          body: typed.body,
          evidenceRevisions: parseJson(typed.evidence_json, []),
          tags: parseJson(typed.tags_json, []),
        };
      });
    return {
      campaignId: this.campaignId,
      heroGuid,
      found: true,
      name: row.name,
      heroClass: row.hero_class ?? undefined,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      latestRevision: row.latest_revision,
      currentProfile: parseJson(row.profile_json, {}),
      observations,
      reflections,
    };
  }

  getStatus(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const table of [
      "heroes",
      "hero_observations",
      "expeditions",
      "records",
      "decisions",
      "reflections",
    ]) {
      const row = this.database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE campaign_id=?`)
        .get(this.campaignId) as { count: number };
      counts[table] = Number(row.count);
    }
    return {
      campaignId: this.campaignId,
      databasePath: this.path,
      activeExpeditionId: this.activeExpeditionId,
      counts,
    };
  }

  exportMarkdown(outputDirectory: string): { directory: string; files: string[] } {
    const directory = resolve(outputDirectory);
    mkdirSync(directory, { recursive: true });
    const resume = this.getResumePacket({
      heroes: 1000,
      decisions: 1000,
      reflections: 1000,
      expeditions: 1000,
    }) as {
      heroes: Array<Record<string, unknown>>;
      decisions: Array<Record<string, unknown>>;
      reflections: Array<Record<string, unknown>>;
      expeditions: Array<Record<string, unknown>>;
    };
    const files: string[] = [];
    const writeAtomic = (name: string, contents: string) => {
      const target = join(directory, name);
      const temporary = `${target}.tmp-${process.pid}`;
      writeFileSync(temporary, contents, "utf8");
      try {
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
      files.push(target);
    };

    writeAtomic(
      "campaign.md",
      [
        `# DD1 战役：${this.campaignId}`,
        "",
        `- 导出时间：${this.now()}`,
        `- 当前远征：${this.activeExpeditionId ?? "无"}`,
        `- 英雄档案：${resume.heroes.length}`,
        `- 已记录决策：${resume.decisions.length}`,
        `- 复盘条目：${resume.reflections.length}`,
        "",
        "## 近期复盘",
        "",
        ...resume.reflections.flatMap((item) => [
          `### ${String(item.title)}`,
          "",
          `${String(item.body)}`,
          "",
          `类型：${String(item.kind)}；时间：${String(item.createdAt)}`,
          "",
        ]),
      ].join("\n"),
    );

    writeAtomic(
      "heroes.md",
      [
        "# 英雄档案",
        "",
        ...resume.heroes.flatMap((item) => {
          const profile = item.profile as Record<string, unknown>;
          return [
            `## ${String(item.name)}（GUID ${String(item.heroGuid)}）`,
            "",
            `- 最近状态版本：${String(item.revision)}`,
            `- 特质：${(profile.quirks as unknown[] | undefined)?.join("；") || "无记录"}`,
            `- 疾病：${(profile.diseases as unknown[] | undefined)?.join("；") || "无记录"}`,
            `- 抗性：${(profile.resists as unknown[] | undefined)?.join("；") || "无记录"}`,
            "",
          ];
        }),
      ].join("\n"),
    );

    writeAtomic(
      "expeditions.md",
      [
        "# 远征与决策记录",
        "",
        "## 远征",
        "",
        ...resume.expeditions.map(
          (item) =>
            `- ${String(item.startedAt)}｜${String(item.status)}｜版本 ${String(item.startRevision)}→${String(item.endRevision ?? "进行中")}`,
        ),
        "",
        "## 决策",
        "",
        ...resume.decisions.flatMap((item) => [
          `### ${String(item.completedAt)}｜${String(item.outcome)}`,
          "",
          `- 行动：\`${stableJson(item.action)}\``,
          `- 理由：${String(item.rationale ?? "未记录")}`,
          `- 核验：${String(item.reason)}`,
          "",
        ]),
      ].join("\n"),
    );
    return { directory, files };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
