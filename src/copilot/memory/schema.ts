import type { DatabaseSync } from 'node:sqlite';

export function installCampaignSchema(database: DatabaseSync): void {
  database.exec(`
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
