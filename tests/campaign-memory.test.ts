import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CampaignMemoryStore } from "../src/copilot/campaign-memory.js";
import type { ActionRecord } from "../src/copilot/types.js";

function actionRecord(): ActionRecord {
  return {
    requestId: "decision-1",
    action: {
      kind: "use_skill",
      skillSlot: 1,
      target: { side: "enemy", slot: 2 },
    },
    rationale: "先控制后排压力怪。",
    expectedRevision: 10,
    sourceRevision: 10,
    finalRevision: 14,
    startedAt: "2026-09-25T12:00:01.000Z",
    completedAt: "2026-09-25T12:00:02.000Z",
    outcome: "success",
    stage: "settlement",
    reason: "观察到敌方被眩晕且轮次推进。",
    recovery: "无需恢复。",
    steps: [],
    observations: [],
  };
}

test("campaign memory survives restart and only appends changed hero profiles", () => {
  const directory = mkdtempSync(join(tmpdir(), "dd1-memory-"));
  const databasePath = join(directory, "campaign.sqlite");
  let clock = 0;
  const now = () => `2026-09-25T12:00:${String(clock++).padStart(2, "0")}.000Z`;

  try {
    const memory = new CampaignMemoryStore({
      path: databasePath,
      campaignId: "profile-test",
      now,
    });
    memory.observeState({ revision: 10, phase: "combat", context: "actions" });

    const baseline = {
      revision: 10,
      phase: "combat",
      baseline: true,
      profileUpdates: [
        {
          side: "party" as const,
          slot: 3,
          heroGuid: 4242,
          name: "莫干斯",
          details: ["速度 7"],
          resists: ["腐蚀抗性 40%"],
          quirks: ["快速反应"],
          diseases: ["红疫"],
        },
      ],
    };
    memory.observeTactical(baseline);
    memory.observeTactical({ ...baseline, revision: 11 });
    memory.observeTactical({
      ...baseline,
      revision: 12,
      profileUpdates: [
        { ...baseline.profileUpdates[0]!, diseases: ["红疫", "破伤风"] },
      ],
    });
    memory.recordAction(actionRecord());
    const reflection = memory.addReflection({
      kind: "lesson",
      title: "优先处理压力怪",
      body: "这支队伍生命恢复尚可，但压力恢复薄弱。",
      heroGuid: 4242,
      evidenceRevisions: [10, 14],
      tags: ["战斗", "压力"],
    });
    assert.ok(reflection.id > 0);
    memory.observeState({ revision: 20, phase: "town", context: "hamlet" });

    const status = memory.getStatus() as {
      counts: Record<string, number>;
      activeExpeditionId?: string;
    };
    assert.equal(status.counts.heroes, 1);
    assert.equal(status.counts.hero_observations, 2);
    assert.equal(status.counts.decisions, 1);
    assert.equal(status.counts.reflections, 1);
    assert.equal(status.activeExpeditionId, undefined);
    memory.close();

    const reopened = new CampaignMemoryStore({
      path: databasePath,
      campaignId: "profile-test",
      now,
    });
    const resume = reopened.getResumePacket() as {
      heroes: Array<{ heroGuid: number; profile: { diseases: string[] } }>;
      decisions: Array<{ rationale: string; outcome: string }>;
      reflections: Array<{ title: string; evidenceRevisions: number[] }>;
      expeditions: Array<{ status: string; summary: { decisions: Record<string, number> } }>;
    };
    assert.equal(resume.heroes[0]?.heroGuid, 4242);
    assert.deepEqual(resume.heroes[0]?.profile.diseases, ["红疫", "破伤风"]);
    assert.equal(resume.decisions[0]?.outcome, "success");
    assert.equal(resume.reflections[0]?.title, "优先处理压力怪");
    assert.deepEqual(resume.reflections[0]?.evidenceRevisions, [10, 14]);
    assert.equal(resume.expeditions[0]?.status, "complete");
    assert.equal(resume.expeditions[0]?.summary.decisions.success, 1);

    const overview = reopened.getCampaignOverview() as {
      roster: Array<{
        heroGuid: number;
        quirkCount: number;
        diseases: string[];
        profile?: unknown;
      }>;
      plans: Array<{ title: string }>;
    };
    assert.equal(overview.roster[0]?.heroGuid, 4242);
    assert.equal(overview.roster[0]?.quirkCount, 1);
    assert.deepEqual(overview.roster[0]?.diseases, ["红疫", "破伤风"]);
    assert.equal(overview.roster[0]?.profile, undefined);
    assert.equal(overview.plans[0]?.title, "优先处理压力怪");
    assert.ok(JSON.stringify(overview).length < JSON.stringify(resume).length);

    const hero = reopened.getHeroMemory(4242) as {
      found: boolean;
      currentProfile: { diseases: string[] };
      observations: Array<{ revision: number }>;
      reflections: Array<{ title: string }>;
    };
    assert.equal(hero.found, true);
    assert.deepEqual(hero.currentProfile.diseases, ["红疫", "破伤风"]);
    assert.deepEqual(
      hero.observations.map((item) => item.revision),
      [12, 10],
    );
    assert.equal(hero.reflections[0]?.title, "优先处理压力怪");
    assert.equal(
      (reopened.getHeroMemory(9999) as { found: boolean }).found,
      false,
    );

    const exported = reopened.exportMarkdown(join(directory, "export"));
    assert.equal(exported.files.length, 3);
    assert.ok(existsSync(join(directory, "export", "campaign.md")));
    assert.match(
      readFileSync(join(directory, "export", "heroes.md"), "utf8"),
      /GUID 4242/u,
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
