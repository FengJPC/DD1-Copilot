import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

test("Copilot dismisses a town event and the pause menu opened by Escape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-town-event-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, "[ 10] axcontext -> townevent\n", "utf8");
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async (command) => {
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 27, mod: 0 },
      });
      if (transport.sendCount === 1) {
        await appendFile(
          path,
          [
            "[ 20] agent-ipc: serviced key sym=0x1b mod=0x0 accepted=1",
            "[ 21] axcontext -> townmap",
            "[ 22] axcontext -> pause",
            "",
          ].join("\n"),
          "utf8",
        );
      } else {
        await appendFile(
          path,
          [
            "[ 30] agent-ipc: serviced key sym=0x1b mod=0x0 accepted=1",
            "[ 31] axcontext -> townmap",
            "",
          ].join("\n"),
          "utf8",
        );
      }
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(log, transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    assert.equal(before.phase, "modal");
    assert.equal(before.context, "townevent");
    assert.equal(before.decision.kind, "modal");

    const result = await engine.act({
      requestId: "dismiss-town-event-1",
      expectedRevision: before.revision,
      action: { kind: "dismiss_modal" },
    });

    assert.equal(result.outcome, "success");
    assert.equal(transport.sendCount, 2);
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ["dismiss_town_event", "dismiss_pause_after_town_event"],
    );
    const after = await engine.getState("compact");
    assert.equal(after.phase, "town");
    assert.equal(after.context, "townmap");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot verifies a town location workflow and deduplicates the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> townmap",
        '[ 11] townmap rows: [6] id="stage_coach" elem=0x89d8f92d unlocked=1 screen=1 district=0 offsave=0 new=1 name="驿站马车"',
        "[ 12] townmap: active, layer 0, 11 locations, row 6",
        "",
      ].join("\n"),
      "utf8",
    );
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "activate_element") {
        assert.deepEqual(command.args, { elementId: "0x89d8f92d" });
        await appendFile(
          path,
          [
            "[ 20] agent-ipc: serviced activate element=0x89d8f92d accepted=1",
            "[ 21] building: active, \"stage_coach\" mode=0",
            "[ 22] axcontext -> building",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, { kind: "inspect_state", args: {} });
      await appendFile(
        path,
        ["[ 23] agent-state: begin", "[ 24] agent-state: end", ""].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(log, transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.revision, 3);

    const request = {
      requestId: "open-stagecoach-1",
      expectedRevision: 3,
      action: {
        kind: "open_town_location" as const,
        locationId: "stage_coach",
      },
    };
    const result = await engine.act(request);
    assert.equal(result.outcome, "success");
    assert.equal(result.stage, "settlement");
    assert.equal(result.finalRevision, 8);
    assert.equal(transport.sendCount, 2);

    const replay = await engine.act(request);
    assert.equal(replay.outcome, "success");
    assert.equal(replay.deduplicated, true);
    assert.equal(transport.sendCount, 2);

    const after = await engine.getState("compact");
    assert.equal(after.building, "stage_coach");
    assert.equal(after.context, "building");
    assert.equal(after.decision.kind, "stage_coach");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot compact state omits cached town data while inside a dungeon room", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-room-compact-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        '[ 10] building: active, "stage_coach" mode=0',
        '[ 11] townmap rows: [6] id="stage_coach" elem=0x89d8f92d unlocked=1 screen=1 district=0 offsave=0 new=0 name="驿站马车"',
        "[ 12] roomview enter: party=4 enemies=0 props=0 doors=1 wave=0 wayon=0",
        "[ 13] axcontext -> room",
        "[ 14] agent-map: begin areas=3 current='rooA'",
        "[ 15] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
        "[ 16] agent-map: tile area='rooA' index=0 type=0 content=-1 knowledge=1 visible=0 visited=1 current=1",
        "[ 17] agent-map: edge from='rooA' direction=3 to='rooB' corridor='corA' corridorTiles=2",
        "[ 18] agent-map: area index=1 id='corA' kind=1 current=0 tiles=2 visited=0",
        "[ 19] agent-map: tile area='corA' index=0 type=0 content=-1 knowledge=1 visible=0 visited=0 current=0",
        "[ 20] agent-map: tile area='corA' index=1 type=0 content=-1 knowledge=1 visible=0 visited=0 current=0",
        "[ 21] agent-map: area index=2 id='rooB' kind=0 current=0 tiles=1 visited=0",
        "[ 22] agent-map: tile area='rooB' index=0 type=0 content=7 knowledge=2 visible=1 visited=0 current=0",
        "[ 23] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async () => { });
    const engine = new CopilotEngine(new LocalGameGateway(log, transport));

    const state = await engine.getState("compact");
    assert.equal(state.phase, "room");
    assert.equal(state.building, undefined);
    assert.equal(state.town, undefined);
    assert.equal(state.buildingHeroes, undefined);
    assert.equal(state.recruitment, undefined);
    assert.equal(state.focusedHero, undefined);
    assert.deepEqual(state.room, {
      partyCount: 4,
      enemyCount: 0,
      propCount: 0,
      doorCount: 1,
      wave: false,
      wayOn: false,
      observedTick: 12,
      props: [],
    });
    assert.equal(state.map?.currentAreaId, "rooA");
    assert.equal(state.map?.areas.length, 3);
    assert.equal(state.decision.kind, "room");
    assert.deepEqual(state.decision.options, [
      {
        kind: "travel_to_room",
        roomId: "rooB",
        direction: "right",
        corridorAreaId: "corA",
        corridorTiles: 2,
        visited: false,
        knownContents: [7],
      },
    ]);
    await appendFile(
      path,
      "[ 24] agent-map: position area='rooB' tile=0\n",
      "utf8",
    );
    const delta = await engine.getState("delta", state.revision);
    assert.deepEqual(delta.mapUpdate, {
      currentAreaId: "rooB",
      currentRoomId: "rooB",
      visitedAreaIds: ["rooA", "rooB"],
    });
    assert.equal(
      delta.changes.some((record) =>
        record.event === undefined
          ? false
          : record.event.kind.startsWith("map_"),
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot selects a building hero by durable GUID without cursor input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-town-hero-id-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, [
      '[ 1] building: active, "guild" mode=0',
      '[ 2] axcontext -> building',
      '[ 3] agent-town: building_begin id="guild" mode=0',
      '[ 4] heroaction probe: "guild" skin=1 facility=0001 selected guid=0 heroes=2 spare=0',
      '[ 5] heroaction probe: hero 0 guid=7 "Reynauld" row=0002',
      '[ 6] heroaction probe: hero 1 guid=8 "Dismas" row=0003',
      '[ 7] agent-town: building_end id="guild"', ''
    ].join('\n'));
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "select_building_hero") {
        assert.deepEqual(command.args, { heroGuid: 8 });
        await appendFile(path, '[ 8] agent-ipc: serviced select_building_hero hero_guid=8 accepted=1\n');
      } else if (command.kind === "inspect_state") {
        await appendFile(path, [
          '[ 9] agent-state: begin',
          '[ 10] agent-town: building_begin id="guild" mode=0',
          '[ 11] heroaction probe: "guild" skin=1 facility=0001 selected guid=8 heroes=2 spare=0',
          '[ 12] heroaction probe: hero 0 guid=7 "Reynauld" row=0002',
          '[ 13] heroaction probe: hero 1 guid=8 "Dismas" row=0003',
          '[ 14] agent-town: building_end id="guild"',
          '[ 15] agent-state: end', ''
        ].join('\n'));
      } else assert.fail(`Unexpected positional input: ${command.kind}`);
    });
    const source = new CombatLogSource(path);
    const engine = new CopilotEngine(new LocalGameGateway(source, transport), {
      pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100,
    });
    const before = await source.refresh();
    const result = await engine.act({
      requestId: "select-dismas", expectedRevision: before.revision,
      action: { kind: "select_building_hero", heroGuid: 8 }
    });
    assert.equal(result.outcome, "success", result.reason);
    assert.deepEqual(transport.commands.map((command) => command.kind),
      ["select_building_hero", "inspect_state"]);
    assert.equal((await engine.getState("compact")).buildingDetails?.selectedHeroGuid, 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Copilot recruits a named Stagecoach hero and verifies the roster change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-recruit-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        '[ 10] building: active, "stage_coach" mode=0',
        '[ 11] bldrows probe: row 0 slot 0 hero=0000000000000001 "莫干斯" elem=0x737467 at (671,587)',
        '[ 12] bldrows probe: row 1 slot 1 hero=0000000000000002 "卡雷特" elem=0x737468 at (671,627)',
        "[ 13] axcontext -> building",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind !== "key_press") {
        assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
      }
      if (command.args.sym === 0x4000004a) {
        await appendFile(
          path,
          "[ 20] agent-ipc: serviced key sym=0x4000004a mod=0x0 accepted=1\n",
          "utf8",
        );
        return;
      }
      if (command.args.sym === 0x40000051) {
        await appendFile(
          path,
          "[ 30] agent-ipc: serviced key sym=0x40000051 mod=0x0 accepted=1\n",
          "utf8",
        );
        return;
      }
      if (command.args.sym === 13 && transport.sendCount === 3) {
        await appendFile(
          path,
          '[ 40] bldrows: recruit pending, slot 1 hero=0000000000000002 "卡雷特" (roster 2 of 10)\n[ 41] agent-ipc: serviced key sym=0xd mod=0x0 accepted=1\n',
          "utf8",
        );
        return;
      }
      if (command.args.sym === 13 && transport.sendCount === 4) {
        await appendFile(
          path,
          "[ 50] bldrows: recruit observed (entries 2 -> 3)\n[ 51] agent-ipc: serviced key sym=0xd mod=0x0 accepted=1\n",
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "stage_coach");

    const result = await engine.act({
      requestId: "recruit-karet-1",
      expectedRevision: state.revision,
      action: {
        kind: "recruit_stage_coach_hero",
        heroAddress: "0000000000000002",
      },
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(
      result.steps.map((step) => step.name),
      [
        "recruit_focus_first",
        "recruit_focus_next_1",
        "arm_recruit",
        "confirm_recruit",
      ],
    );
    assert.equal(transport.sendCount, 4);

    const after = await engine.getState("compact");
    assert.equal(after.recruitment?.rosterCount, 3);
    assert.deepEqual(
      after.buildingHeroes.map((hero) => hero.name),
      ["莫干斯"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot reconciles a provision purchase when the transaction event is delayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-provision-gap-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> provision",
        "[ 11] provision: active",
        "[ 12] prov probe: section 0 (store):",
        '[ 13] prov probe: slot 1 amount=5 type="supply" id="medicinal_herbs" price=gold 100 shard 0 free=0',
        "[ 14] prov probe: section 1 (bag):",
        "[ 15] provision: tx observed (gold 1000->1000 shard 0->0 bag 0->0)",
        "",
      ].join("\n"),
      "utf8",
    );
    let inspection = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "key_press" && command.args.sym !== 13) {
        await appendFile(
          path,
          `[ ${20 + transport.sendCount}] agent-ipc: serviced key sym=0x${Number(command.args.sym).toString(16)} mod=0x0 accepted=1\n`,
          "utf8",
        );
        return;
      }
      if (command.kind === "buy_provision") {
        // Deliberately omit the transaction event. The following inspection
        // must reconcile the purchase without sending Enter a second time.
        return;
      }
      if (command.kind === "inspect_state") {
        inspection += 1;
        const tick = 30 + inspection * 10;
        await appendFile(
          path,
          [
            `[ ${tick}] agent-state: begin`,
            `[ ${tick + 1}] prov probe: section 0 (store):`,
            `[ ${tick + 2}] prov probe: slot 1 amount=4 type="supply" id="medicinal_herbs" price=gold 100 shard 0 free=0`,
            `[ ${tick + 3}] prov probe: section 1 (bag):`,
            `[ ${tick + 4}] prov probe: slot 0 amount=1 type="supply" id="medicinal_herbs" price=gold 0 shard 0 free=0`,
            `[ ${tick + 5}] provision: tx observed (gold 1000->900 shard 0->0 bag 0->1)`,
            `[ ${tick + 6}] agent-state: end`,
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 5, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "buy-herbs-gap-1",
      expectedRevision: state.revision,
      action: { kind: "buy_provision", itemKey: "medicinal_herbs", quantity: 1 },
    });
    assert.equal(result.outcome, "success");
    assert.equal(
      transport.commands.filter(
        (command) => command.kind === "buy_provision",
      ).length,
      1,
    );
    assert.equal(inspection, 2);
    assert.equal(result.steps.at(-1)?.name, "inspect_after_buying_medicinal_herbs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
