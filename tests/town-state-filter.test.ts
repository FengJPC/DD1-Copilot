import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UnavailableCommandTransport } from "../src/command/transport.js";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";

test("Copilot compacts town locations and Stagecoach heroes into current state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-town-state-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> townmap",
        '[ 11] townmap rows: [0] id="abbey" elem=0x2ee40da3 unlocked=0 screen=1 district=0 offsave=0 new=0 name="教堂"',
        '[ 12] townmap rows: [6] id="stage_coach" elem=0x89d8f92d unlocked=1 screen=1 district=0 offsave=0 new=1 name="驿站马车"',
        "[ 13] townmap: active, layer 0, 11 locations, row 0",
        '[ 14] building: active, "stage_coach" mode=0',
        '[ 15] bldrows probe: row 0 slot 0 hero=000002135B98C060 "莫干斯" elem=0x737467 at (671,587)',
        '[ 16] actionbar hero=000002135B98C060 class=0000021359ABEE90 name="莫干斯" class="瘟疫医生"',
        "[ 17] charsheet rank: xp=0 thresholds=7 -> level 0",
        '[ 18] tutorialpopup id=stage_coach text="驿站马车说明"',
        "[ 19] axcontext -> tutorial",
        "",
      ].join("\n"),
      "utf8",
    );
    const engine = new CopilotEngine(
      new LocalGameGateway(
        new CombatLogSource(path),
        new UnavailableCommandTransport(),
      ),
    );
    const state = await engine.getState("compact");
    assert.equal(state.revision, 10);
    assert.equal(state.phase, "modal");
    assert.equal(state.town.locations.length, 2);
    assert.equal(state.town.locations[1]?.id, "stage_coach");
    assert.equal(state.town.locations[1]?.unlocked, true);
    assert.equal(state.buildingHeroes[0]?.name, "莫干斯");
    assert.deepEqual(state.focusedHero, {
      heroAddress: "000002135B98C060",
      classAddress: "0000021359ABEE90",
      name: "莫干斯",
      heroClass: "瘟疫医生",
      xp: 0,
      level: 0,
    });
    assert.equal(state.activeTutorial?.tutorialId, "stage_coach");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot exposes structured building and expedition planning details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-town-rich-state-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, [
      '[ 1] building: active, "nomad_wagon" mode=0',
      '[ 2] axcontext -> building',
      '[ 3] agent-town: building_begin id="nomad_wagon" mode=0',
      '[ 4] agent-town: wallet gold=23010 bust=16 portrait=11 deed=10 crest=40 shard=2',
      '[ 4] bldact probe: row 0 act="meditation" (0) slot 1/3 elem=0x6d656469(live) cancel=0xd0d3c7d5(absent) committed=0 pending=0000000000000000"" pending_guid=0 occupant=-1 locked=0 evtlocked=0 costsmoney=1',
      '[ 5] bldrows probe: row 0 slot 0 id="chirurgeons_charm" name="医者挂坠" price=10000 elem=0x696e7620 at (1083,656)',
      '[ 6] bldrows probe: row 0 effects=1 "+15%生命治疗"',
      '[ 7] bldrows probe: row 0 rec=0001 rarity="优良" classreq=""',
      '[ 8] agent-town: building_end id="nomad_wagon"',
      '',
    ].join('\n'), "utf8");
    const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), new UnavailableCommandTransport()));
    const state = await engine.getState("compact");
    assert.equal(state.decision.wallet.gold, 23010);
    assert.equal(state.buildingDetails.complete, true);
    assert.deepEqual(state.buildingDetails.activities[0], {
      row: 0, activityId: "meditation", activityOrder: 0, slot: 1, slotCount: 3,
      elementId: "0x6d656469", committedHeroGuid: undefined, pendingHeroGuid: undefined,
      pendingHeroName: "", occupant: -1, locked: false, eventLocked: false, costsMoney: true,
    });
    assert.deepEqual(state.buildingDetails.shopItems[0], {
      row: 0, slot: 0, itemId: "chirurgeons_charm", name: "医者挂坠", priceKnown: true,
      price: 10000, elementId: "0x696e7620", effects: "+15%生命治疗", rarity: "优良", classRequirement: "",
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Copilot exposes rich embark profiles and rejects an ambiguous quest ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-embark-rich-state-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, [
      '[ 1] axcontext -> embark',
      '[ 2] embark: active, 2 quests in 1 locations, cursor 0/0',
      '[ 3] embark probe: qsState=1 sel=-1 special=-1 camp=0001',
      '[ 4] embark probe: row 0 qIdx=4 id="explore_same" dungeon="crypts" len=1 diff=1 elem(0x717378)=onscreen',
      '[ 5] agent-prep: quest_detail qidx=4 line=0 text="探索遗迹。短。学徒。"',
      '[ 6] embark probe: row 1 qIdx=6 id="explore_same" dungeon="crypts" len=1 diff=1 elem(0x71737a)=onscreen',
      '[ 7] agent-prep: quest_detail qidx=6 line=0 text="另一份探索任务。"',
      '[ 8] agent-prep: party_begin',
      '[ 9] roster probe: row 0 entry=0001 "Reynauld" state=0 building="" missing=0 hero_guid=1',
      '[ 10] agent-prep: roster_profile guid=1 name="Reynauld" class="十字军" level=1 health="31/33 生命" stress="12 压力" weapon=1 armour=1',
      '[ 11] agent-prep: roster_detail guid=1 category=quirk line=0 text="光明战士"',
      '[ 12] agent-prep: party_end slots=4 filled=0',
      '',
    ].join('\n'), "utf8");
    const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), new UnavailableCommandTransport()));
    const state = await engine.getState("compact");
    assert.equal(state.decision.options[0].questIndex, 4);
    assert.deepEqual(state.decision.options[0].details, ["探索遗迹。短。学徒。"]);
    assert.equal(state.decision.roster[0].heroClass, "十字军");
    assert.deepEqual(state.decision.roster[0].quirks, ["光明战士"]);
    const result = await engine.act({ requestId: "ambiguous", expectedRevision: state.revision,
      action: { kind: "select_embark_quest", questId: "explore_same" } });
    assert.equal(result.outcome, "failure");
    assert.match(result.reason, /ambiguous/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Copilot exposes structured building upgrade tracks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-town-upgrade-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, [
      '[ 1] building: active, "blacksmith" mode=1',
      '[ 2] agent-town: building_begin id="blacksmith" mode=1',
      "[ 3] bldup rows: track 0 step 'a' urd=0000000012345678 stride=0x180 armed=1 f80=0x0 f84=0x0",
      '[ 4] bldup rows: track 0 hash=0x17e784f1 id="blacksmith.weapon" def=yes steps=4 armed=0 bought=0 next=0 "武器锻造"',
      '[ 5] agent-town: building_end id="blacksmith"',
      '',
    ].join('\n'), "utf8");
    const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), new UnavailableCommandTransport()));
    const state = await engine.getState("compact");
    assert.deepEqual(state.buildingDetails.upgrades[0], {
      track: 0, trackHash: "0x17e784f1", trackId: "blacksmith.weapon", knownDefinition: true,
      steps: 4, armed: 0, bought: 0, next: 0, name: "武器锻造",
      stepDetails: [{ code: "a", armed: 1 }],
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
