import assert from "node:assert/strict";
import test from "node:test";

import {
  TacticalStateProjector,
  type TacticalStateSource,
} from "../src/copilot/tactical-projector.js";

function combatState(revision: number): TacticalStateSource {
  return {
    revision,
    observedAt: "2026-09-25T12:00:00.000Z",
    phase: "combat",
    context: "actions",
    light: { value: 48, text: "影绰" },
    combat: {
      active: true,
      actor: {
        address: "hero-1",
        name: "莫干斯",
        heroClass: "瘟疫医生",
        currentHp: 16,
        maxHp: 22,
        stress: 23,
        maxStress: 200,
      },
      party: [
        {
          side: "party",
          slot: 3,
          slotEnd: 3,
          actorAddress: "hero-1",
          heroGuid: 4242,
          name: "莫干斯",
          currentHp: 16,
          maxHp: 22,
          stress: 23,
          maxStress: 200,
          conditions: "",
          details: ["16/22 生命：.", "23/200 压力：, 多疑.", "闪避 5", "速度 7"],
          resists: ["腐蚀抗性 40%"],
          quirks: ["快速反应. 正面. +2速度."],
          diseases: ["红疫. -10%最大生命."],
        },
      ],
      enemies: [
        {
          side: "enemy",
          slot: 1,
          slotEnd: 1,
          actorAddress: "enemy-1",
          name: "骸骨战士",
          currentHp: 7,
          maxHp: 10,
          conditions: "",
          details: ["闪避 8", "速度 2"],
          resists: ["眩晕抗性 25%", "腐蚀抗性 10%"],
        },
      ],
      skills: [
        {
          skillSlot: 1,
          name: "瘟疫手雷",
          details: ["命中 95", "腐蚀 4点，持续3回合", "目标：敌方后排"],
        },
        {
          skillSlot: 2,
          name: "战场药物",
          details: ["治疗腐蚀和流血", "目标无"],
        },
      ],
      recentResults: [
        {
          tick: 100,
          kind: "combat_result",
          resultType: "damage",
          text: "骸骨战士受到3点伤害。",
        },
      ],
      recentBuffs: [],
    },
  };
}

test("tactical projection keeps decision facts while deduplicating static profiles and history", () => {
  const projector = new TacticalStateProjector();
  const first = projector.project(combatState(10));
  assert.equal(first.available, true);
  assert.equal(first.baseline, true);
  assert.equal(first.skillUpdates?.[0]?.details.length, 3);
  assert.equal(first.profileUpdates?.length, 2);
  assert.ok(first.profileUpdates?.[0]?.details.includes("多疑."));
  assert.ok(!first.profileUpdates?.[0]?.details.some((line) => line.includes("16/22")));
  assert.deepEqual(first.profileUpdates?.[0]?.quirks, ["快速反应. 正面. +2速度."]);
  assert.deepEqual(first.profileUpdates?.[0]?.diseases, ["红疫. -10%最大生命."]);
  assert.equal(first.profileUpdates?.[0]?.heroGuid, 4242);
  assert.equal(first.party[0]?.heroGuid, 4242);
  assert.deepEqual(first.partyHealth, {
    allFull: false,
    injuredCount: 1,
    totalMissingHp: 6,
  });
  assert.equal(first.skills[0]?.targetMode, undefined);
  assert.equal(first.skills[1]?.targetMode, "none");
  assert.equal(first.recentResults?.length, 1);

  const nextState = combatState(20);
  nextState.combat!.party[0]!.currentHp = 20;
  nextState.combat!.recentResults!.push({
    tick: 110,
    kind: "combat_result",
    resultType: "heal",
    text: "莫干斯恢复4点生命。",
  });
  const second = projector.project(nextState);
  assert.equal(second.baseline, false);
  assert.equal(second.party[0]?.hp[0], 20);
  assert.equal(second.skills[0]?.name, "瘟疫手雷");
  assert.equal(second.skillUpdates, undefined);
  assert.equal(second.profileUpdates, undefined);
  assert.deepEqual(
    second.recentResults?.map((event) => event.tick),
    [110],
  );
  assert.ok(JSON.stringify(second).length < JSON.stringify(first).length);
});

test("tactical projection starts a new baseline when the enemy roster is replaced", () => {
  const projector = new TacticalStateProjector();
  projector.project(combatState(10));
  const wave = combatState(30);
  wave.combat!.enemies[0] = {
    ...wave.combat!.enemies[0]!,
    actorAddress: "enemy-2",
    name: "邪教侍僧",
  };
  const projected = projector.project(wave);
  assert.equal(projected.baseline, true);
  assert.equal(projected.profileUpdates?.length, 2);
});
