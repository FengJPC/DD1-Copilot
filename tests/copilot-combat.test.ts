import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

for (const resultGuid of [1, 4]) test(`Copilot checks actual item recipient GUID ${resultGuid}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-item-target-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-state: begin",
        '[ 12] agent-state: actor side=party idx=3 slot=4-4 address=0004 guid=4 active=0 name="Plague Doctor" health="15/22 HP" stress="0/200 Stress" conditions="" runtime_guid=4',
        '[ 13] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=1 active=0 name="Reynauld" health="9/33 HP" stress="0/200 Stress" conditions="" runtime_guid=1',
        '[ 14] agent-state: inventory slot=3 amount=2 type="provision" item_id="" key="food" name="食物"',
        "[ 15] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let enterCount = 0;
    let directTargetCount = 0;
    let tick = 20;
    const append = async (...lines: string[]) => {
      await appendFile(path, `${lines.map((line) => `[ ${tick++}] ${line}`).join("\n")}\n`, "utf8");
    };
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_map") return;
      if (command.kind === "commit_item_target") {
        assert.deepEqual(command, { kind: "commit_item_target", args: { targetGuid: 1, inventorySlot: 3, expectedAmount: 2, itemKey: "food" } });
        directTargetCount += 1;
        await append(
          'itemuse: commit "食物" -> Reynauld (called=1 ok=1 amount 2 -> 1 trinket=0)',
          `agent-item: result slot=3 target_guid=${resultGuid} called=1 ok=1 before=2 after=1`,
          "axcontext -> inventory",
        );
        return;
      }
      if (command.kind === "inspect_state") {
        await append(
          "agent-state: begin",
          'agent-state: actor side=party idx=0 slot=1-1 address=0001 active=0 name="Reynauld" health="11/33 HP" stress="0/200 Stress" conditions=""',
          'agent-state: inventory slot=3 amount=1 type="provision" item_id="" key="food" name="食物"',
          "agent-state: end",
        );
        return;
      }
      if (command.kind !== "key_press") return;
      if (command.args.sym === 105) {
        await append("axcontext -> inventory");
      } else if (command.args.sym === 13) {
        enterCount += 1;
        if (enterCount === 1) {
          await append(
            'itemuse: begin "食物" slot 3 targets=4 trinket=0 camp=0',
            "axcontext -> itemuse",
          );
        }
      } else {
        await append(`agent-ipc: serviced key sym=0x${command.args.sym.toString(16)} mod=0x0 accepted=1`);
      }
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "front-hero-food-1",
      expectedRevision: before.revision,
      action: { kind: "use_inventory_item", inventorySlot: 3, targetHeroGuid: 1 },
    });

    assert.equal(result.outcome, resultGuid === 1 ? "success" : "failure");
    assert.equal(directTargetCount, 1);
    assert.equal(result.steps.at(-1)?.name, resultGuid === 1 ? "inspect_after_inventory_item" : "commit_inventory_target_by_guid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot inspects a combat turn and completes skill targeting as one action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-combat-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] resting point: combat started — test",
        "[ 11] axcontext -> actions",
        '[ 12] heroswap: 0000000000000001 -> 0000000000000002 is the TURN — taking the action bar -> "Dismas, 强盗. 23/23 生命：. 0/200 压力：."',
        "",
      ].join("\n"),
      "utf8",
    );

    let initialTargetReady = false;
    let actionCommitted = false;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        if (actionCommitted) {
          await appendFile(
            path,
            [
              "[ 60] agent-state: begin",
              '[ 61] agent-state: actor side=party idx=0 slot=3-3 address=0000000000000004 guid=4 active=1 name="Transient Vestal, 修女" health="20/24 生命：" stress="4/200 压力：" conditions="" runtime_guid=4',
              '[ 62] agent-state: actor side=enemy idx=0 slot=1-1 address=0000000000000010 guid=16 active=0 name="土匪割喉者" health="12/12 生命：" stress="" conditions="" runtime_guid=16',
              '[ 63] agent-state: actor side=enemy idx=1 slot=2-2 address=0000000000000011 guid=17 active=0 name="邪教徒斗士" health="8/15 生命：" stress="" conditions="" runtime_guid=17',
              '[ 64] agent-state: action kind=skill index=1 skill_slot=1 element=0x6865616c name="神圣恩惠"',
              "[ 65] agent-state: end",
              "[ 66] agent-ipc: serviced inspect_state accepted=1",
              "",
            ].join("\n"),
            "utf8",
          );
          setTimeout(() => {
            void appendFile(
              path,
              [
                "[ 70] agent-state: begin",
                '[ 71] agent-state: actor side=party idx=0 slot=1-1 address=0000000000000003 guid=3 active=1 name="Reynauld, 十字军" health="31/33 生命：" stress="4/200 压力：" conditions="" runtime_guid=3',
                '[ 72] agent-state: actor side=enemy idx=0 slot=1-1 address=0000000000000010 guid=16 active=0 name="土匪割喉者" health="12/12 生命：" stress="" conditions="" runtime_guid=16',
                '[ 73] agent-state: actor side=enemy idx=1 slot=2-2 address=0000000000000011 guid=17 active=0 name="邪教徒斗士" health="8/15 生命：" stress="" conditions="" runtime_guid=17',
                '[ 74] agent-state: action kind=skill index=1 skill_slot=1 element=0x7374756e name="眩晕打击"',
                "[ 75] agent-state: end",
                "",
              ].join("\n"),
              "utf8",
            );
            // The game can expose a complete but transient action bar for a few
            // hundred milliseconds while the round is still settling.
          }, 250);
          return;
        }
        await appendFile(
          path,
          [
            "[ 20] agent-state: begin",
            '[ 21] agent-state: actor side=party idx=0 slot=1-1 address=0000000000000002 guid=2 active=1 name="Dismas, 强盗" health="23/23 生命：" stress="0/200 压力：" conditions="" runtime_guid=2',
            '[ 22] agent-state: actor side=enemy idx=0 slot=1-1 address=0000000000000010 guid=16 active=0 name="土匪割喉者" health="12/12 生命：" stress="" conditions="" runtime_guid=16',
            '[ 23] agent-state: actor side=enemy idx=1 slot=2-2 address=0000000000000011 guid=17 active=0 name="邪教徒斗士" health="15/15 生命：" stress="" conditions="" runtime_guid=17',
            '[ 24] agent-state: action kind=skill index=1 skill_slot=1 element=0x736b6c6c name="手枪射击"',
            "[ 25] agent-state: end",
            "[ 26] agent-ipc: serviced inspect_state accepted=1",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      if (
        command.kind === "activate_combat_skill" &&
        command.args.skillElementId === "0x736b6c6c"
      ) {
        await appendFile(
          path,
          [
            "[ 30] agent-ipc: serviced click element=0x736b6c6c accepted=1",
            '[ 31] actionbar skill id="pistol_shot" key="combat_skill_name_highwayman_pistol_shot" -> 手枪射击',
            '[ 32] armed-watch: the GAME armed "手枪射击" -- opening the target list (bar item 1, elem 0x736b6c6c)',
            "",
          ].join("\n"),
          "utf8",
        );
        setTimeout(() => {
          initialTargetReady = true;
          void appendFile(
            path,
            [
              '[ 33] target row 0/2 (enemy idx=0 slot=1) area=0 -> "土匪割喉者, 85% to hit, 5-9 damage, 12.5% crit, 12/12 生命：. 敌方第1位."',
              "",
            ].join("\n"),
            "utf8",
          );
        }, 10);
        return;
      }
      if (command.kind === "commit_combat_target") {
        assert.equal(
          initialTargetReady,
          true,
          "GUID target commit must wait until the initial cursor preview is ready",
        );
        assert.deepEqual(command, { kind: "commit_combat_target", args: { targetGuid: 17, actorGuid: 2, skillElementId: "0x736b6c6c" } });
        actionCommitted = true;
        await appendFile(
          path,
          [
            "[ 49] targeting: agent selected guid=17 actor=0000000000000011 (enemy slot 2)",
            "[ 50] agent-ipc: serviced commit_combat_target target_guid=17 accepted=1",
            '[ 51] combattext: actor=0000000000000011 prop=0000000000000100 type=9(damage) -> "邪教徒斗士受到7点伤害。."',
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });

    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 200), transport),
      {
        settlementTimeoutMilliseconds: 100,
        inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      },
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "combat_turn");
    assert.equal(state.combat.actor?.name, "Dismas");
    assert.equal(state.combat.skills[0]?.name, "手枪射击");
    assert.equal(state.combat.enemies.length, 2);

    const refused = await engine.act({
      requestId: "wrong-actor", expectedRevision: state.revision,
      action: { kind: "use_skill", actorGuid: 999, skillElementId: "0x736b6c6c", target: { targetGuid: 17 } }
    });
    assert.equal(refused.outcome, "failure");
    assert.equal(transport.sendCount, 1, "stale actor ID must be rejected before skill activation");
    const result = await engine.act({
      requestId: "combat-action-1",
      expectedRevision: state.revision,
      action: {
        kind: "use_skill",
        actorGuid: 2,
        skillElementId: "0x736b6c6c",
        target: { targetGuid: 17 },
      },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.steps.length, 2);
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ["select_skill", "commit_skill_target_by_guid"],
    );
    assert.equal(transport.sendCount, 3);
    assert.deepEqual(transport.commands[1], {
      kind: "activate_combat_skill",
      args: { actorGuid: 2, skillElementId: "0x736b6c6c" },
    });
    const resolving = await engine.getState("compact");
    assert.equal(resolving.decision.kind, "combat_resolving");
    assert.deepEqual(resolving.decision.options, []);

    const transition = await engine.waitForNextCombatDecision(1_200);
    assert.equal(transition.status, "ready");
    assert.match(transition.reason, /Reynauld/u);
    assert.equal(
      transport.commands.filter((command) => command.kind === "inspect_state").length,
      2,
    );
    assert.equal(
      transport.commands.filter(
        (command) => command.kind === "commit_combat_target",
      ).length,
      1,
      "waiting must never resend the committed combat action",
    );
    const next = await engine.getState("compact");
    assert.equal(next.decision.kind, "combat_turn");
    assert.equal(next.combat.actor?.name, "Reynauld");
    assert.equal(next.combat.skills[0]?.name, "眩晕打击");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot hides and rejects skills that the active rank cannot use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-rank-filter-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] resting point: combat started — test",
        "[ 11] axcontext -> actions",
        '[ 12] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Vestal. 20/24 HP. 0/200 Stress."',
        "[ 20] agent-state: begin",
        '[ 21] agent-state: actor side=party idx=0 slot=3-3 address=0002 active=1 name="Vestal" health="20/24 HP" stress="0/200 Stress" conditions=""',
        '[ 22] agent-state: actor side=enemy idx=0 slot=1-1 address=0010 active=0 name="Bone Rabble" health="7/7 HP" stress="" conditions=""',
        '[ 23] agent-state: action kind=skill index=1 skill_slot=1 element=0x01 name="Mace Bash"',
        '[ 24] agent-state: skill_detail skill_slot=1 line=0 text="Usable from ranks 1, 2."',
        '[ 25] agent-state: action kind=skill index=2 skill_slot=2 element=0x02 name="Judgement"',
        '[ 26] agent-state: skill_detail skill_slot=2 line=0 text="Usable from ranks 2, 3, 4."',
        "[ 27] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async () => { });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 10, inspectionTimeoutMilliseconds: 10, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.deepEqual(
      state.decision.skills.map((skill: { name: string }) => skill.name),
      ["Judgement"],
    );
    const result = await engine.act({
      requestId: "illegal-rank-skill-1",
      expectedRevision: state.revision,
      action: { kind: "use_skill", skillSlot: 1, target: { side: "enemy", slot: 1 } },
    });
    assert.equal(result.outcome, "failure");
    assert.match(result.reason, /current rank/u);
    assert.equal(transport.sendCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot does not repeat an accepted skill selection with an unknown outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-skill-fallback-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] resting point: combat started — test",
        "[ 11] axcontext -> actions",
        '[ 12] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Dismas, 强盗. 23/23 生命：. 0/200 压力：."',
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          [
            "[ 20] agent-state: begin",
            '[ 21] agent-state: actor side=party idx=0 slot=2-2 address=0002 active=1 name="Dismas" health="23/23 生命：" stress="0/200 压力：" conditions=""',
            '[ 22] agent-state: actor side=enemy idx=0 slot=3-3 address=0010 active=0 name="骸骨弩手" health="10/15 生命：" stress="" conditions=""',
            '[ 23] agent-state: action kind=skill index=2 skill_slot=2 element=0x736b6c6d name="手枪射击"',
            "[ 24] agent-state: end",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      if (command.kind === "click_element") return;
      if (command.kind === "key_press" && command.args.sym === 50) {
        await appendFile(
          path,
          [
            '[ 30] actionbar skill id="pistol_shot" key="pistol" -> 手枪射击',
            '[ 31] armed-watch: the GAME armed "手枪射击" -- opening the target list (bar item 2, elem 0x736b6c6d)',
            '[ 32] target row 0/1 (enemy idx=0 slot=3) area=0 -> "骸骨弩手"',
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 13) {
        await appendFile(
          path,
          '[ 40] combattext: actor=0010 prop=0100 type=9(damage) -> "骸骨弩手受到7点伤害。."\n',
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 10, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "skill-fallback-1",
      expectedRevision: state.revision,
      action: { kind: "use_skill", skillSlot: 2, target: { side: "enemy", slot: 3 } },
    });
    assert.equal(result.outcome, "uncertain");
    assert.deepEqual(result.steps.map((step) => step.name), ["select_skill"]);
    assert.equal(transport.commands.filter((command) => command.kind === "key_press").length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const light of [73, 23]) test(`Copilot checks torch light increase: ${light}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-torch-refresh-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-state: begin",
        '[ 11] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=7 active=1 name="Hero" health="20/20 HP" stress="0/200 Stress" conditions="" runtime_guid=107',
        '[ 12] agent-state: inventory slot=0 amount=1 type="provision" item_id="torch" key="inv_torch" name="火把"',
        '[ 12] agent-state: inventory slot=5 amount=4 type="provision" item_id="torch" key="inv_torch" name="火把"',
        '[ 13] agent-state: light kind=torch value=48.00 level=2 text="昏暗"',
        "[ 14] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "key_press") {
        if (command.args.sym === 105) {
          await appendFile(path, "[ 20] axcontext -> inventory\n", "utf8");
        } else if (command.args.sym === 0x4000004a) {
          await appendFile(path, "[ 21] agent-ipc: serviced key sym=0x4000004a mod=0x0 accepted=1\n", "utf8");
        } else if (command.args.sym === 13) {
          await appendFile(path, `[ 22] light: ${light}.00 level=3 -> "明亮"\n`, "utf8");
        }
        return;
      }
      if (command.kind !== "inspect_state") return;
      await appendFile(
        path,
        [
          "[ 23] agent-state: begin",
          '[ 24] agent-state: inventory slot=5 amount=4 type="provision" item_id="torch" key="inv_torch" name="火把"',
          '[ 25] agent-state: light kind=torch value=73.00 level=3 text="明亮"',
          "[ 26] agent-state: end",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "torch-refresh-1",
      expectedRevision: state.revision,
      action: { kind: "use_torch" },
    });
    assert.equal(result.outcome, light > 48 ? "success" : "uncertain");
    if (light < 48) { assert.equal(transport.commands.some((command) => command.kind === "commit_item_target"), false); return; }
    assert.equal(result.steps.some((step) => step.name === "use_torch_from_slot_0"), true);
    assert.equal(result.steps.at(-1)?.name, "inspect_after_torch");
    const after = await engine.getState("compact");
    assert.equal(after.light?.value, 73);
    assert.equal(after.inventory?.items.find((item) => item.itemId === "torch")?.amount, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot stops inventory navigation when combat begins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-torch-race-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-state: begin",
        '[ 11] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=7 active=1 name="Hero" health="20/20 HP" stress="0/200 Stress" conditions="" runtime_guid=107',
        '[ 12] agent-state: inventory slot=5 amount=4 type="provision" item_id="torch" key="inv_torch" name="火把"',
        '[ 13] agent-state: light kind=torch value=41.00 level=2 text="昏暗"',
        "[ 14] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind !== "key_press") return;
      if (command.args.sym === 105) {
        await appendFile(path, "[ 20] axcontext -> inventory\n", "utf8");
      } else if (command.args.sym === 0x4000004a) {
        await appendFile(
          path,
          [
            "[ 21] agent-ipc: serviced key sym=0x4000004a mod=0x0 accepted=1",
            '[ 22] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Dismas, 强盗. 16/26 生命：. 12/200 压力：."',
            "",
          ].join("\n"),
          "utf8",
        );
      }
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "torch-race-1",
      expectedRevision: state.revision,
      action: { kind: "use_torch" },
    });
    assert.equal(result.outcome, "failure");
    assert.match(result.reason, /Combat began while focusing the inventory/u);
    assert.equal(transport.commands.some((command) => command.kind === "key_press" && command.args.sym === 13), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot selects a curio actor by durable hero GUID before interaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-curio-hero-guid-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, [
      "[ 1] roomview enter: party=1 enemies=0 props=1 doors=0 wave=0 wayon=0",
      "[ 2] axcontext -> room",
      "[ 3] agent-state: begin",
      '[ 4] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=12 active=0 name="卡雷特" health="8/24 HP" stress="24/200 Stress" conditions="" runtime_guid=112',
      '[ 5] agent-state: prop index=0 address=0000ABCD active=1 trap=0 reachable=1 direction=0 dx=0.000 name="装饰瓮"',
      "[ 6] agent-state: end",
      "",
    ].join("\n"), "utf8");
    let step = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_map") {
        await appendFile(path, [
          "[ 7] agent-map: begin areas=1 current='rooA'",
          "[ 8] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
          "[ 9] agent-map: tile area='rooA' index=0 type=1 content=0 knowledge=3 visible=1 visited=1 current=1",
          "[ 9] agent-map: end",
          "",
        ].join("\n"), "utf8");
        return;
      }
      step += 1;
      if (step === 1) {
        assert.deepEqual(command, { kind: "select_raid_hero", args: { heroGuid: 12 } });
        await appendFile(path, "[ 10] agent-raid: selected hero_guid=12 actor=00AA previous=00BB\n", "utf8");
      } else if (step === 2) {
        assert.deepEqual(command, { kind: "key_press", args: { sym: 1073741898, mod: 0 } });
        await appendFile(path, '[ 11] roomview row 0/2 (actor party idx=0 slot=1) -> "卡雷特"\n', "utf8");
      } else if (step === 3) {
        assert.deepEqual(command, { kind: "key_press", args: { sym: 1073741903, mod: 0 } });
        await appendFile(path, '[ 12] roomview row 1/2 (prop party idx=0 slot=0) -> "装饰瓮"\n', "utf8");
      } else {
        assert.deepEqual(command, { kind: "key_press", args: { sym: 13, mod: 0 } });
        await appendFile(path, "[ 13] curio: InteractWithProp returned 1 (called=1 ok=1) state 0 -> 1, prop now 0000ABCD\n", "utf8");
      }
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "curio-guid-1",
      expectedRevision: before.revision,
      action: { kind: "interact_room_prop", propIndex: 0, heroGuid: 12 },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.steps[0]?.name, "select_room_prop_hero_by_guid");
    assert.equal(result.steps[0]?.reason, "卡雷特 was selected for the interaction.");
    assert.equal(transport.sendCount, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot returns from inventory to a still-open loot window with the dedicated loot return key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-return-loot-test-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, [
      '[ 1] loot: window opened, 1 items, token="curio" type=0 [input stack 3]',
      "[ 2] axcontext -> inventory",
      "[ 3] agent-state: begin",
      "[ 4] agent-state: loot begin count=1",
      '[ 5] agent-state: loot item=0 pool_slot=3 amount=2 type="heirloom" item_id="deed" key="loot_deed" name="地契"',
      "[ 6] agent-state: loot end",
      "[ 7] agent-state: end",
      "",
    ].join("\n"), "utf8");
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_map") return;
      assert.deepEqual(command, { kind: "key_press", args: { sym: 114, mod: 0 } });
      await appendFile(path, "[ 10] loot: back to the window via R\n[ 11] axcontext -> loot\n", "utf8");
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    assert.deepEqual(before.decision.options, [{ kind: "return_to_loot" }]);
    const result = await engine.act({
      requestId: "return-loot-1",
      expectedRevision: before.revision,
      action: { kind: "return_to_loot" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.steps.at(-1)?.name, "return_to_loot");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot treats an all-party combat skill as caller-target-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-no-target-skill-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] resting point: combat started — test",
        "[ 11] axcontext -> actions",
        '[ 12] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Reynauld. 24/33 HP. 10/200 Stress."',
        "[ 20] agent-state: begin",
        '[ 21] agent-state: actor side=party idx=0 slot=1-1 address=0002 active=1 name="Reynauld" health="24/33 HP" stress="10/200 Stress" conditions=""',
        '[ 22] agent-state: actor side=enemy idx=0 slot=1-1 address=0010 active=0 name="Cultist" health="8/8 HP" stress="" conditions=""',
        '[ 23] agent-state: action kind=skill index=1 skill_slot=1 element=0x01 name="Bulwark of Faith"',
        '[ 24] agent-state: skill_detail skill_slot=1 line=0 text="目标所有位置"',
        "[ 25] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "click_element") {
        await appendFile(
          path,
          [
            '[ 30] armed-watch: the GAME armed "Bulwark of Faith" -- opening the target list (bar item 1, elem 0x01)',
            '[ 31] target row 0/1 (party idx=0 slot=1) area=0 -> "Reynauld, party rank 1."',
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 13) {
        await appendFile(
          path,
          '[ 40] combatbuff: actor=0002 gained stat=1 sub="PROT" amount=20 rounds=4 pol=1\n',
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 10, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.match(state.decision.options[0].target, /omit/u);
    const result = await engine.act({
      requestId: "no-target-skill-1",
      expectedRevision: state.revision,
      action: { kind: "use_skill", skillSlot: 1 },
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(result.steps.map((step) => step.name), ["select_skill", "confirm_skill_target"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const interrupt of [false, true]) {
  test(`Copilot serializes concurrent actions and caches ${interrupt ? "uncertain" : "successful"} results`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dd1-action-concurrency-"));
    const path = join(directory, "log");
    try {
      await writeFile(path, "[ 1] axcontext -> pause\n");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let submitted!: () => void;
      const sent = new Promise<void>((resolve) => { submitted = resolve; });
      const transport = new FakeCommandTransport(async () => {
        submitted();
        await gate;
        if (interrupt) throw new Error("connection lost after submit");
        await appendFile(path, "[ 2] axcontext -> townmap\n");
      });
      const source = new CombatLogSource(path);
      const engine = new CopilotEngine(new LocalGameGateway(source, transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 50 });
      const before = await source.refresh();
      const request = { requestId: "one", expectedRevision: before.revision, action: { kind: "dismiss_modal" as const } };
      const first = engine.act(request);
      await sent;
      const duplicate = engine.act(request);
      const collision = await engine.act({ ...request, requestId: "two" });
      assert.equal(collision.outcome, "failure");
      assert.match(collision.reason, /in flight/);
      release();
      const [result, repeated] = await Promise.all([first, duplicate]);
      assert.equal(result.outcome, interrupt ? "uncertain" : "success");
      assert.equal(repeated.deduplicated, true);
      assert.equal((await engine.act(request)).deduplicated, true);
      assert.equal(transport.sendCount, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
