import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

test("Copilot rejects a stale revision before sending input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-stale-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, "[ 10] axcontext -> townmap\n", "utf8");
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async () => { });
    const engine = new CopilotEngine(new LocalGameGateway(log, transport));
    await engine.getState("compact");

    const result = await engine.act({
      requestId: "stale-1",
      expectedRevision: 0,
      action: { kind: "open_town_location", locationId: "stage_coach" },
    });
    assert.equal(result.outcome, "failure");
    assert.equal(result.stage, "validation");
    assert.match(result.reason, /Stale action/u);
    assert.equal(transport.sendCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot delta filters a full retained window before compacting noise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-delta-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, "[ 10] axcontext -> loading\n", "utf8");
    const log = new CombatLogSource(path, 2_000);
    const transport = new FakeCommandTransport(async () => { });
    const engine = new CopilotEngine(new LocalGameGateway(log, transport));
    const before = await engine.getState("compact");

    const noise = Array.from(
      { length: 600 },
      (_, index) => `[ ${20 + index}] roomview: party vector empty or bad`,
    );
    await appendFile(
      path,
      ["[ 19] axcontext -> room", ...noise, ""].join("\n"),
      "utf8",
    );

    const delta = await engine.getState("delta", before.revision);
    assert.equal(delta.truncated, false);
    assert.equal(delta.resyncRequired, false);
    assert.equal(delta.context, "room");
    assert.ok(
      delta.changes.some(
        (record) => record.event?.kind === "context_changed" &&
          record.event.context === "room",
      ),
    );
    assert.equal(delta.diagnostics.suppressedCount, 600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot does not treat a queued acknowledgement as semantic success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-uncertain-test-"));
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
    const transport = new FakeCommandTransport(async () => { });
    const engine = new CopilotEngine(
      new LocalGameGateway(log, transport),
      { settlementTimeoutMilliseconds: 5, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "uncertain-1",
      expectedRevision: state.revision,
      action: { kind: "open_town_location", locationId: "stage_coach" },
    });
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.stage, "workflow");
    assert.equal(transport.sendCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot navigates party targets in the friendly-list direction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-friendly-target-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] resting point: combat started — test",
        "[ 11] axcontext -> actions",
        '[ 12] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Vestal, 修女. 20/20 生命：. 0/200 压力：."',
        "",
      ].join("\n"),
      "utf8",
    );
    let friendlyCursor = 1;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          [
            "[ 20] agent-state: begin",
            '[ 21] agent-state: actor side=party idx=0 slot=1-1 address=0001 active=0 name="Reynauld" health="20/33 生命：" stress="0/200 压力：" conditions=""',
            '[ 22] agent-state: actor side=party idx=1 slot=2-2 address=0002 active=1 name="Vestal" health="20/20 生命：" stress="0/200 压力：" conditions=""',
            '[ 23] agent-state: actor side=party idx=2 slot=3-3 address=0003 active=0 name="Dismas" health="10/23 生命：" stress="0/200 压力：" conditions=""',
            '[ 24] agent-state: action kind=skill index=1 skill_slot=1 element=0x6865616c name="神圣恩惠"',
            "[ 25] agent-state: end",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      if (command.kind === "click_element") {
        await appendFile(
          path,
          [
            '[ 30] actionbar skill id="divine_grace" key="heal" -> 神圣恩惠',
            '[ 31] armed-watch: the GAME armed "神圣恩惠" -- opening the target list (bar item 1, elem 0x6865616c)',
            '[ 32] target row 3/4 (party idx=0 slot=1) area=0 -> "Reynauld"',
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 0x40000050) {
        friendlyCursor += 1;
        await appendFile(
          path,
          `[ ${32 + friendlyCursor}] target row ${4 - friendlyCursor}/4 (party idx=${friendlyCursor - 1} slot=${friendlyCursor}) area=0 -> "ally"\n`,
          "utf8",
        );
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 13) {
        await appendFile(
          path,
          '[ 40] heroswap: 0002 -> 0001 is the TURN — taking the action bar -> "Reynauld, 十字军. 27/33 生命：. 0/200 压力：."\n',
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 200), transport),
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "friendly-heal-1",
      expectedRevision: state.revision,
      action: { kind: "use_skill", skillSlot: 1, target: { side: "party", slot: 3 } },
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(
      transport.commands.slice(2, 4),
      [
        { kind: "key_press", args: { sym: 0x40000050, mod: 0 } },
        { kind: "key_press", args: { sym: 0x40000050, mod: 0 } },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot takes journal pages individually instead of sending the unsafe take-all key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-journal-loot-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, [
      '[ 10] loot: window opened, 1 items, token="curio" type=0 [input stack 3]',
      "[ 11] agent-state: begin",
      "[ 12] agent-state: inventory begin slots=16 occupied=10",
      "[ 13] agent-state: inventory end",
      "[ 14] agent-state: loot begin count=1",
      '[ 15] agent-state: loot item=0 pool_slot=0 amount=1 type="journal_page" item_id="" key="str_inventory_title_journal_page" name="一页日记"',
      "[ 16] agent-state: loot end",
      "[ 17] agent-state: end",
      "",
    ].join("\n"), "utf8");
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "consolidate_inventory") {
        await appendFile(path, "[ 20] agent-event: inventory_consolidated merges=0 freed=0 accepted=1\n", "utf8");
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 0x4000004a) {
        await appendFile(path, '[ 21] lootnav jump item 0 -> 0 "一页日记"\n', "utf8");
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 13) {
        await appendFile(path, '[ 22] loot: took item 1 "一页日记" amount 1\n', "utf8");
        return;
      }
      if (command.kind === "inspect_state") {
        await appendFile(path, [
          "[ 30] agent-state: begin",
          "[ 31] agent-state: inventory begin slots=16 occupied=11",
          '[ 32] agent-state: inventory slot=10 amount=1 type="journal_page" item_id="" key="str_inventory_title_journal_page" name="一页日记"',
          "[ 33] agent-state: inventory end",
          "[ 34] agent-state: loot begin count=0",
          "[ 35] agent-state: loot end",
          "[ 36] agent-state: end",
          "",
        ].join("\n"), "utf8");
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      {
        settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1
      },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "take-journal-safely",
      expectedRevision: before.revision,
      action: { kind: "take_all_loot" },
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(
      transport.commands.filter((command) => command.kind === "key_press")
        .map((command) => command.args.sym),
      [0x4000004a, 13],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live-helper actions get the same schema validation as MCP actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-action-schema-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, "[ 1] axcontext -> room\n");
    const source = new CombatLogSource(path);
    const transport = new FakeCommandTransport(async () => assert.fail("invalid input must not execute"));
    const engine = new CopilotEngine(new LocalGameGateway(source, transport));
    const before = await source.refresh();
    const result = await engine.act({
      requestId: "bad", expectedRevision: before.revision,
      action: { kind: "use_inventory_item", inventorySlot: -1, targetIndex: 0 }
    });
    assert.equal(result.outcome, "failure");
    assert.match(result.reason, /Invalid action request/);
    assert.equal(transport.sendCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("preparation party assignment uses GUIDs despite identical names and shuffled roster order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-prep-guids-"));
  const path = join(directory, "log");
  try {
    let tick = 10;
    const party = new Map<number, number>();
    const snapshot = () => {
      const lines = ["agent-state: begin", "agent-prep: party_begin"];
      for (let position = 1; position <= 4; position++) {
        const guid = party.get(position) ?? 0;
        lines.push(`party probe: slot ${4 - position} = position ${position} iface=0010 hero=000${guid} entry=001${guid} "${guid ? "Same Name" : "(empty)"}" barred=0 elem=0x111 found hero_guid=${guid}`);
      }
      for (const [row, guid] of [4, 2, 1, 3].entries()) lines.push(`roster probe: row ${row} entry=001${guid} "Same Name" state=0 building="" missing=0 hero_guid=${guid}`);
      lines.push(`agent-prep: party_end slots=4 filled=${party.size}`, "agent-state: end");
      return lines.map((line) => `[ ${tick++}] ${line}`).join("\n") + "\n";
    };
    await writeFile(path, '[ 1] axcontext -> embark\n[ 2] embark: active, 1 quests in 1 locations, cursor 0/0\n[ 3] embark probe: qsState=1 sel=0 special=-1 camp=0001\n' + snapshot());
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "assign_party_hero") {
        const guid = Number(command.args.heroGuid), position = Number(command.args.position);
        party.set(position, guid);
        await appendFile(path, `[ ${tick++}] agent-command: begin id=fake-${transport.sendCount}\n[ ${tick++}] agent-command: end id=fake-${transport.sendCount} accepted=1\n`);
      } else if (command.kind === "inspect_state") await appendFile(path, snapshot());
      else assert.fail(`Unexpected keyboard/UI navigation: ${command.kind}`);
    });
    const source = new CombatLogSource(path);
    const engine = new CopilotEngine(new LocalGameGateway(source, transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100 });
    const before = await source.refresh();
    const result = await engine.act({
      requestId: "party", expectedRevision: before.revision,
      action: { kind: "form_embark_party", frontToBack: [1, 2, 3, 4] }
    });
    assert.equal(result.outcome, "success", result.reason);
    assert.deepEqual([1, 2, 3, 4].map((position) => party.get(position)), [1, 2, 3, 4]);
    assert.equal(transport.commands.filter((command) => command.kind === "assign_party_hero").length, 4);
    const repeat = await engine.act({
      requestId: "same-party", expectedRevision: (await source.refresh()).revision,
      action: { kind: "form_embark_party", frontToBack: [1, 2, 3, 4] }
    });
    assert.equal(repeat.outcome, "success");
    assert.equal(transport.commands.filter((command) => command.kind === "assign_party_hero").length, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("quest selection resolves the quest instance index without cursor navigation or repeated clicks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-quest-id-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, [
      '[ 1] axcontext -> embark',
      '[ 2] embark: active, 1 quests in 1 locations, cursor 0/0',
      '[ 3] embark probe: qsState=1 sel=-1 special=-1 camp=0001',
      '[ 4] embark probe: row 0 qIdx=5 id="quest_a" dungeon="ruins" len=1 diff=1 elem(0x717379)=onscreen', ''
    ].join('\n'));
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "select_embark_quest") {
        assert.deepEqual(command.args, { questIndex: 5 });
        await appendFile(path, '[ 5] embark: selection observed -> 5\n');
      } else if (command.kind === "inspect_state") {
        await appendFile(path, '[ 6] agent-state: begin\n[ 7] agent-prep: party_begin\n[ 8] roster probe: row 0 entry=0001 "Hero" state=0 building="" missing=0 hero_guid=1\n[ 9] agent-state: end\n');
      } else assert.fail(`Unexpected positional input: ${command.kind}`);
    });
    const source = new CombatLogSource(path);
    const engine = new CopilotEngine(new LocalGameGateway(source, transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100 });
    const invalidParty = await engine.act({
      requestId: "no-quest-party", expectedRevision: (await source.refresh()).revision,
      action: { kind: "form_embark_party", frontToBack: [1, 2, 3, 4] }
    });
    assert.equal(invalidParty.outcome, "failure");
    assert.match(invalidParty.reason, /Select an embark quest/);
    assert.equal(transport.sendCount, 0);
    const result = await engine.act({
      requestId: "quest", expectedRevision: (await source.refresh()).revision,
      action: { kind: "select_embark_quest", questIndex: 5, questId: "quest_a" }
    });
    assert.equal(result.outcome, "success", result.reason);
    assert.match(result.reason, /instance 5/);
    assert.equal(transport.commands.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
