import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

test("Copilot exposes and safely cancels a stranded inventory item target selector", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-itemuse-recovery-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        '[ 11] itemuse: begin item="food" amount=2',
        "[ 12] axcontext -> itemuse",
        "",
      ].join("\n"),
      "utf8",
    );
    let escapeCount = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind !== "key_press") return;
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 27, mod: 0 },
      });
      escapeCount += 1;
      await appendFile(
        path,
        [
          "[ 20] agent-ipc: serviced key sym=0x1b mod=0x0 accepted=1",
          "[ 21] axcontext -> room",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    assert.equal(before.context, "itemuse");
    assert.equal(before.decision.kind, "targeting_recovery");

    const result = await engine.act({
      requestId: "cancel-itemuse-1",
      expectedRevision: before.revision,
      action: { kind: "cancel_targeting" },
    });

    assert.equal(result.outcome, "success");
    assert.match(result.reason, /inventory item target selection/u);
    assert.equal(escapeCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot switches the raid map to the inventory HUD before advancing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-map-close-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> map",
        "[ 11] agent-map: begin areas=1 current='corA'",
        "[ 12] agent-map: area index=0 id='corA' kind=1 current=1 tiles=2 visited=0",
        "[ 13] agent-map: tile area='corA' index=0 type=2 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 14] agent-map: tile area='corA' index=1 type=2 content=-1 knowledge=1 visible=0 visited=0 current=0",
        "[ 15] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let step = 0;
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          "[ 16] agent-state: begin\n[ 17] agent-state: end\n",
          "utf8",
        );
        return;
      }
      step += 1;
      if (step === 1) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 105, mod: 0 },
        });
        await appendFile(
          path,
          "[ 20] mapreview auto-closed (another panel is active, idx=2)\n[ 21] axcontext -> inventory\n",
          "utf8",
        );
      } else {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 100, mod: 1 },
        });
        await appendFile(
          path,
          "[ 22] tilestep: arrived tile=1 newArea=0 -> \"第2格，共2格.\"\n",
          "utf8",
        );
      }
    });
    const engine = new CopilotEngine(new LocalGameGateway(log, transport), {
      settlementTimeoutMilliseconds: 100,
      pollIntervalMilliseconds: 1,
    });
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "close-map-then-advance-1",
      expectedRevision: before.revision,
      action: { kind: "advance_corridor" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.steps[0]?.name, "close_raid_map");
    assert.equal(transport.sendCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot refuses torch use before opening inventory when runtime GUIDs are unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-torch-id-preflight-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-state: begin",
        '[ 12] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=7 active=1 name="Hero" health="20/20 HP" stress="0/200 Stress" conditions=""',
        '[ 13] agent-state: inventory slot=5 amount=4 type="provision" item_id="torch" key="inv_torch" name="火把"',
        '[ 14] agent-state: light kind=torch value=48.00 level=2 text="昏暗"',
        "[ 15] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async () => { });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "torch-no-runtime-guid-1",
      expectedRevision: state.revision,
      action: { kind: "use_torch" },
    });
    assert.equal(result.outcome, "failure");
    assert.match(result.reason, /verified runtime GUID/u);
    assert.equal(transport.commands.some((command) => command.kind === "key_press"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot takes all loot and verifies that the loot window closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-loot-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        '[ 10] loot: window opened, 1 items, token="curio" type=0 [input stack 3]',
        "[ 11] agent-state: begin",
        "[ 12] agent-state: loot begin count=1",
        '[ 13] agent-state: loot item=0 pool_slot=3 amount=1000 type="gold" item_id="gold" key="loot_gold" name="金币"',
        "[ 14] agent-state: loot end",
        "[ 15] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "consolidate_inventory") {
        assert.deepEqual(command, { kind: "consolidate_inventory", args: {} });
        await appendFile(
          path,
          "[ 19] agent-event: inventory_consolidated merges=0 freed=0 accepted=1\n",
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 32, mod: 0 },
      });
      await appendFile(path, "[ 20] loot: window closed\n", "utf8");
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    assert.equal(before.decision.kind, "loot");
    const result = await engine.act({
      requestId: "take-all-loot-1",
      expectedRevision: before.revision,
      action: { kind: "take_all_loot" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.steps[0]?.name, "consolidate_inventory_before_loot");
    assert.equal(result.steps[1]?.name, "take_all_loot");
    assert.equal(transport.sendCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot keeps stackable loot out of replacement options and refreshes after taking it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-stackable-loot-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        '[ 10] loot: window opened, 2 items, token="battle" type=0 [input stack 3]',
        "[ 11] agent-state: begin",
        "[ 12] agent-state: inventory begin slots=16 occupied=16",
        '[ 13] agent-state: inventory slot=4 amount=300 type="gold" item_id="" key="str_inventory_title_gold" name="金币"',
        "[ 14] agent-state: inventory end",
        "[ 15] agent-state: loot begin count=2",
        '[ 16] agent-state: loot item=0 pool_slot=0 amount=225 type="gold" item_id="" key="str_inventory_title_gold" name="金币"',
        '[ 17] agent-state: loot item=1 pool_slot=1 amount=1 type="trinket" item_id="paralyzers_crest" key="str_inventory_title_trinketparalyzers_crest" name="制裁饰章"',
        "[ 18] agent-state: loot end",
        "[ 19] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "consolidate_inventory") {
        await appendFile(
          path,
          "[ 20] agent-event: inventory_consolidated merges=0 freed=0 accepted=1\n",
          "utf8",
        );
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 0x4000004a) {
        await appendFile(path, '[ 21] lootnav jump item 0 -> 0 "金币"\n', "utf8");
        return;
      }
      if (command.kind === "key_press" && command.args.sym === 13) {
        await appendFile(path, '[ 22] loot: took item 1 "金币" amount 225\n', "utf8");
        return;
      }
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          [
            "[ 30] agent-state: begin",
            "[ 31] agent-state: inventory begin slots=16 occupied=16",
            '[ 32] agent-state: inventory slot=4 amount=525 type="gold" item_id="" key="str_inventory_title_gold" name="金币"',
            "[ 33] agent-state: inventory end",
            "[ 34] agent-state: loot begin count=1",
            '[ 35] agent-state: loot item=0 pool_slot=1 amount=1 type="trinket" item_id="paralyzers_crest" key="str_inventory_title_trinketparalyzers_crest" name="制裁饰章"',
            "[ 36] agent-state: loot end",
            "[ 37] agent-state: end",
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
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    assert.equal(before.decision.kind, "loot");
    if (before.decision.kind !== "loot") assert.fail("loot decision was not projected");
    assert.deepEqual(
      before.decision.options
        .filter((option) => option.kind === "replace_inventory_with_loot")
        .map((option) => option.itemIndex),
      [1],
      "gold with enough existing stack capacity must not request a discard",
    );

    const result = await engine.act({
      requestId: "take-stackable-gold-1",
      expectedRevision: before.revision,
      action: { kind: "take_loot_item", itemIndex: 0 },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.steps.at(-1)?.name, "inspect_after_loot_change");
    const after = await engine.getState("compact");
    assert.equal(after.inventory?.items[0]?.amount, 525);
    assert.deepEqual(after.loot?.items.map((item) => item.name), ["制裁饰章"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot warns about low light with the current torch count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-light-advisory-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-state: begin",
        '[ 12] agent-state: inventory slot=2 amount=3 type="provision" item_id="torch" key="inv_torch" name="火把"',
        '[ 13] agent-state: light kind=torch value=18.00 level=0 text="漆黑"',
        "[ 14] agent-state: end",
        "[ 15] agent-map: begin areas=1 current='rooA'",
        "[ 16] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
        "[ 17] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), new FakeCommandTransport(async () => { })),
    );
    const state = await engine.getState("compact");
    assert.deepEqual(state.advisories, [
      {
        kind: "critical_light",
        light: 18,
        torches: 3,
        message: "Torchlight is critically low; evaluate using a torch before the next risk.",
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
