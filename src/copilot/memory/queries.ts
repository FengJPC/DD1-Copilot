import type { DatabaseSync } from 'node:sqlite';

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Read-only campaign projections; the store owns writes and database lifetime. */
export class CampaignQueries {
  constructor(private readonly database: DatabaseSync, private readonly campaignId: string, private readonly path: string, private readonly activeExpedition: () => string | undefined) { }
  buildExpeditionSummary(expeditionId: string): Record<string, unknown> {
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
  } = {}) {
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
      activeExpeditionId: this.activeExpedition(),
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
      activeExpeditionId: this.activeExpedition(),
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
      activeExpeditionId: this.activeExpedition(),
      counts,
    };
  }
}
