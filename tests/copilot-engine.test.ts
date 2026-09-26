import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CommandAcknowledgement,
  CommandHealth,
  CommandTransport,
  GameCommand,
} from "../src/command/transport.js";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";

class FakeCommandTransport implements CommandTransport {
  sendCount = 0;
  commands: GameCommand[] = [];

  constructor(
    private readonly onSend: (command: GameCommand) => Promise<void>,
  ) {}

  async health(): Promise<CommandHealth> {
    return {
      configured: true,
      available: true,
      transport: "named_pipe",
    };
  }

  async send(command: GameCommand): Promise<CommandAcknowledgement> {
    this.sendCount += 1;
    this.commands.push(command);
    await this.onSend(command);
    return {
      commandId: `fake-${this.sendCount}`,
      transport: "named_pipe",
      status: "queued",
      receivedAt: new Date().toISOString(),
    };
  }
}

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

test("Copilot treats a results reveal as success without issuing a duplicate click", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-results-retry-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> results",
        "[ 11] agent-state: results state=0 rows=4 heroes=4",
        "",
      ].join("\n"),
      "utf8",
    );
    let resultsPresses = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          [
            "[ 15] agent-state: begin",
            "[ 16] agent-state: results state=0 rows=4 heroes=4",
            "[ 17] agent-state: end",
            "[ 18] agent-ipc: serviced inspect_state accepted=1",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 13, mod: 0 },
      });
      resultsPresses += 1;
      if (resultsPresses === 1) {
        await appendFile(
          path,
          [
            "[ 20] agent-ipc: serviced key sym=0xd mod=0x0 accepted=1",
            "[ 21] results: reveal observed, flags 0x0 -> 0x9",
            "",
          ].join("\n"),
          "utf8",
        );
      }
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 10, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "results");

    const result = await engine.act({
      requestId: "results-retry-1",
      expectedRevision: state.revision,
      action: { kind: "continue_results" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(resultsPresses, 1);
    assert.deepEqual(
      result.steps.map((step) => step.name),
      ["continue_results"],
    );
    assert.equal(result.steps[0]?.outcome, "success");
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

test("Copilot rejects a stale revision before sending input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-stale-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, "[ 10] axcontext -> townmap\n", "utf8");
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async () => {});
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
    const transport = new FakeCommandTransport(async () => {});
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
    const transport = new FakeCommandTransport(async () => {});
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

test("Copilot keeps a doorway corridor distinct from a room decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-doorway-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] roomview DUMP doors=1 (rows suppressed: wave=0)",
        "[ 11] rv-door[0] door=0001 dest='rooH' -> \"exit\"",
        "[ 12] roomview enter: party=4 enemies=0 props=0 doors=1 wave=0 wayon=0",
        "[ 13] axcontext -> room",
        "[ 14] agent-map: begin areas=5 current='corH'",
        "[ 15] agent-map: area index=0 id='rooD' kind=0 current=0 tiles=1 visited=0",
        "[ 16] agent-map: area index=1 id='rooG' kind=0 current=0 tiles=1 visited=0",
        "[ 17] agent-map: edge from='rooG' direction=0 to='rooD' corridor='corG' corridorTiles=6",
        "[ 18] agent-map: edge from='rooG' direction=1 to='rooH' corridor='corH' corridorTiles=6",
        "[ 19] agent-map: area index=2 id='rooH' kind=0 current=0 tiles=1 visited=1",
        "[ 20] agent-map: edge from='rooH' direction=0 to='rooG' corridor='corH' corridorTiles=6",
        "[ 21] agent-map: area index=3 id='corG' kind=1 current=0 tiles=6 visited=0",
        "[ 22] agent-map: area index=4 id='corH' kind=1 current=1 tiles=6 visited=0",
        "[ 23] agent-map: tile area='corH' index=0 type=2 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 24] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async () => {});
    const engine = new CopilotEngine(new LocalGameGateway(log, transport));
    const state = await engine.getState("compact");
    assert.equal(state.map?.currentAreaId, "corH");
    assert.equal(state.map?.currentRoomId, undefined);
    assert.equal(state.decision.kind, "corridor");
    assert.equal(state.decision.currentAreaId, "corH");
    assert.equal(state.decision.currentTile, 0);
    assert.equal(state.decision.destinationRoomId, "rooG");
    assert.deepEqual(state.decision.options, [{ kind: "advance_corridor" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot advances corridor tiles continuously and stops at the forward door", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-corridor-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] roomview DUMP doors=1 (rows suppressed: wave=0)",
        "[ 11] rv-door[0] door=0001 dest='rooA' -> \"exit\"",
        "[ 12] roomview enter: party=4 enemies=0 props=0 doors=1 wave=0 wayon=0",
        "[ 13] axcontext -> room",
        "[ 14] agent-map: begin areas=3 current='corA'",
        "[ 15] agent-map: area index=0 id='rooA' kind=0 current=0 tiles=1 visited=1",
        "[ 16] agent-map: edge from='rooA' direction=3 to='rooB' corridor='corA' corridorTiles=3",
        "[ 17] agent-map: area index=1 id='corA' kind=1 current=1 tiles=3 visited=0",
        "[ 18] agent-map: tile area='corA' index=0 type=2 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 19] agent-map: tile area='corA' index=1 type=1 content=-1 knowledge=1 visible=0 visited=0 current=0",
        "[ 20] agent-map: tile area='corA' index=2 type=2 content=-1 knowledge=1 visible=0 visited=0 current=0",
        "[ 21] agent-map: area index=2 id='rooB' kind=0 current=0 tiles=1 visited=0",
        "[ 22] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let tile = 0;
    const log = new CombatLogSource(path, 100);
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          "[ 25] agent-state: begin\n[ 26] agent-state: end\n",
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 100, mod: 1 },
      });
      tile += 1;
      await appendFile(
        path,
        `[ ${30 + tile}] tilestep: arrived tile=${tile} newArea=0 -> \"第${tile + 1}格，共3格.\"\n`,
        "utf8",
      );
    });
    const engine = new CopilotEngine(new LocalGameGateway(log, transport), {
      settlementTimeoutMilliseconds: 100,
      pollIntervalMilliseconds: 1,
    });
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "advance-corridor-1",
      expectedRevision: before.revision,
      action: { kind: "advance_corridor" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.reason, "The party reached the forward door.");
    assert.equal(result.steps.length, 2);
    assert.equal(transport.sendCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot treats a hunger event during continuous travel as a safe decision stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-corridor-hunger-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-map: begin areas=1 current='corA'",
        "[ 12] agent-map: area index=0 id='corA' kind=1 current=1 tiles=4 visited=1",
        "[ 13] agent-map: tile area='corA' index=0 type=2 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 14] agent-map: tile area='corA' index=1 type=1 content=0 knowledge=3 visible=1 visited=0 current=0",
        "[ 15] agent-map: tile area='corA' index=2 type=1 content=0 knowledge=3 visible=1 visited=0 current=0",
        "[ 16] agent-map: tile area='corA' index=3 type=2 content=0 knowledge=3 visible=1 visited=0 current=0",
        "[ 17] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let movementAttempts = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          "[ 18] agent-state: begin\n[ 19] agent-state: end\n",
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 100, mod: 1 },
      });
      movementAttempts += 1;
      if (movementAttempts === 1) {
        await appendFile(
          path,
          '[ 20] tilestep: arrived tile=1 newArea=0 -> "第2格，共4格."\n',
          "utf8",
        );
        return;
      }
      await appendFile(
        path,
        [
          '[ 30] event: scroll opened, skin=4 rows=2 title="饥饿"',
          "[ 31] axcontext -> event",
          "[ 32] tilestep: no movement after key press",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "advance-to-hunger-1",
      expectedRevision: before.revision,
      action: { kind: "advance_corridor" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.reason, "Corridor travel stopped for an event, object, or hazard.");
    assert.equal(result.steps.at(-1)?.outcome, "success");
    assert.equal(movementAttempts, 2);
    const after = await engine.getState("compact");
    assert.equal(after.phase, "event");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot projects a tutorial over results as a dismissible modal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-results-tutorial-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> results",
        '[ 11] tutorialpopup id=resolve_level text="Resolve level increased. Press Escape."',
        "[ 12] axcontext -> tutorial",
        "[ 13] agent-state: results state=2 rows=0 heroes=4",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(path, "[ 14] agent-state: end\n[ 15] agent-ipc: serviced inspect_state accepted=1\n", "utf8");
        return;
      }
      assert.deepEqual(command, { kind: "key_press", args: { sym: 27, mod: 0 } });
      await appendFile(
        path,
        '[ 20] agent-ipc: serviced key sym=0x1b mod=0x0 accepted=1\n[ 21] tutorial closed -> handing focus back to "results"\n[ 22] axcontext -> results\n',
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.phase, "modal");
    assert.equal(state.decision.kind, "modal");
    assert.equal(state.activeTutorial?.tutorialId, "resolve_level");

    const result = await engine.act({
      requestId: "dismiss-results-tutorial-1",
      expectedRevision: state.revision,
      action: { kind: "dismiss_modal" },
    });
    assert.equal(result.outcome, "success");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot localizes the Sconce room prop for decisions and compact state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-sconce-name-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] roomview enter: party=1 enemies=0 props=1 doors=0 wave=0 wayon=0",
        '[ 12] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=1 active=1 name="Hero" health="10/10" stress="0/200" conditions="" runtime_guid=1',
        '[ 13] agent-state: prop index=0 address=0000ABCD active=1 trap=0 reachable=1 direction=0 dx=0.000 name="Sconce"',
        "",
      ].join("\n"),
      "utf8",
    );
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), new FakeCommandTransport(async () => {})),
      { settlementTimeoutMilliseconds: 20, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.room?.props?.[0]?.name, "墙上火把");
    assert.equal(state.decision.options?.[0]?.name, "墙上火把");
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
    const result = await engine.act({ requestId: "select-dismas", expectedRevision: before.revision,
      action: { kind: "select_building_hero", heroGuid: 8 } });
    assert.equal(result.outcome, "success", result.reason);
    assert.deepEqual(transport.commands.map((command) => command.kind),
      ["select_building_hero", "inspect_state"]);
    assert.equal((await engine.getState("compact")).buildingDetails?.selectedHeroGuid, 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Copilot settles promptly at a revealed trap and refreshes its choices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-trap-stop-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> inventory",
        "[ 11] agent-map: begin areas=1 current='corA'",
        "[ 12] agent-map: area index=0 id='corA' kind=1 current=1 tiles=7 visited=0",
        "[ 13] agent-map: tile area='corA' index=4 type=1 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 14] agent-map: tile area='corA' index=5 type=1 content=2 knowledge=3 visible=1 visited=0 current=0",
        "[ 15] agent-map: end",
        "[ 16] agent-state: begin",
        "[ 17] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let step = 0;
    const transport = new FakeCommandTransport(async (command) => {
      step += 1;
      if (step === 1) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 100, mod: 1 },
        });
        await appendFile(
          path,
          [
            "[ 20] tilestep: 'd' approaches the revealed trap on tile 6 of 7 - will park short of the boundary onto it",
            "[ 21] tilestep: released 'd' (scan=7) - parked short of the trap boundary",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, { kind: "inspect_state", args: {} });
      await appendFile(
        path,
        [
          "[ 22] agent-state: begin",
          '[ 23] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=1 active=1 name="Dismas" health="20/23 HP" stress="0/200 Stress" conditions="" runtime_guid=1',
          "[ 24] agent-state: trap_chance address=00AA hero_index=0 chance=0.9",
          '[ 25] agent-state: prop index=0 address=0000ABCD active=1 trap=1 reachable=1 direction=0 dx=0.000 name="陷阱"',
          "[ 26] agent-state: end",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      {
        settlementTimeoutMilliseconds: 100,
        inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "stop-before-trap-1",
      expectedRevision: before.revision,
      action: { kind: "advance_corridor" },
    });
    assert.equal(result.outcome, "success");
    assert.match(result.reason, /refreshed the available choices/u);
    assert.deepEqual(
      result.steps.map((record) => record.name),
      ["advance_corridor_from_tile_4", "inspect_after_dungeon_interaction"],
    );
    assert.equal(transport.sendCount, 2);
    const after = await engine.getState("compact");
    assert.equal(after.decision.kind, "corridor");
    assert.equal(after.decision.props[0]?.trap, true);
    assert.equal(after.decision.options[0]?.disarmChance, 90);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot walks forward after crossing a door before declaring room entry complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-enter-room-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> inventory",
        "[ 11] agent-map: begin areas=2 current='coAF'",
        "[ 12] agent-map: area index=0 id='coAF' kind=1 current=1 tiles=7 visited=0",
        "[ 13] agent-map: tile area='coAF' index=6 type=2 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 14] agent-map: area index=1 id='rooF' kind=0 current=0 tiles=1 visited=0",
        "[ 15] agent-map: end",
        "[ 16] agent-state: begin",
        "[ 17] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let step = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_map") {
        await appendFile(
          path,
          [
            "[ 27] agent-map: begin areas=2 current='rooF'",
            "[ 28] agent-map: area index=0 id='coAF' kind=1 current=0 tiles=7 visited=1",
            "[ 29] agent-map: area index=1 id='rooF' kind=0 current=1 tiles=1 visited=1",
            "[ 30] agent-map: tile area='rooF' index=0 type=1 content=0 knowledge=3 visible=1 visited=1 current=1",
            "[ 31] agent-map: end",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      step += 1;
      if (step === 1) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 119, mod: 0 },
        });
        await appendFile(path, "[ 20] agent-map: position area='rooF' tile=0\n", "utf8");
        return;
      }
      if (step === 2) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 100, mod: 1 },
        });
        await appendFile(
          path,
          [
            "[ 21] tilestep: room step 'd' - 0 prop(s) readable, 0 out of reach that way",
            "[ 22] resting point: landing in the dungeon view",
            "[ 23] roomview enter: party=4 enemies=0 props=0 doors=1 wave=0 wayon=0",
            "[ 24] axcontext -> room",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, { kind: "inspect_state", args: {} });
      await appendFile(
        path,
        "[ 25] agent-state: begin\n[ 26] agent-state: end\n",
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      {
        settlementTimeoutMilliseconds: 100,
        inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "enter-room-and-walk-1",
      expectedRevision: before.revision,
      action: { kind: "enter_room" },
    });
    assert.equal(result.outcome, "success");
    assert.deepEqual(
      result.steps.map((record) => record.name),
      ["enter_forward_room", "advance_into_room", "inspect_after_dungeon_interaction"],
    );
    assert.equal(transport.sendCount, 3);
    const after = await engine.getState("compact");
    assert.equal(after.phase, "room");
    assert.equal(after.map?.currentAreaId, "rooF");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot treats quest completion during room entry as a successful terminal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-room-questdone-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-map: begin areas=2 current='coAF'",
        "[ 12] agent-map: area index=0 id='coAF' kind=1 current=1 tiles=7 visited=1",
        "[ 13] agent-map: area index=1 id='rooF' kind=0 current=0 tiles=1 visited=0",
        "[ 14] agent-map: tile area='coAF' index=6 type=2 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 15] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    let step = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(
          path,
          "[ 15] agent-state: begin\n[ 16] agent-state: end\n",
          "utf8",
        );
        return;
      }
      step += 1;
      if (step === 1) {
        assert.deepEqual(command, { kind: "key_press", args: { sym: 119, mod: 0 } });
        await appendFile(path, "[ 20] agent-map: position area='rooF' tile=0\n", "utf8");
        return;
      }
      assert.deepEqual(command, {
        kind: "key_press",
        args: { sym: 100, mod: 1 },
      });
      await appendFile(
        path,
        [
          "[ 21] axcontext -> questdone",
          "[ 22] agent-state: quest rows=2 goals=1 button=regroup complete=0",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      {
        settlementTimeoutMilliseconds: 100,
        inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "enter-room-questdone-1",
      expectedRevision: before.revision,
      action: { kind: "enter_room" },
    });

    assert.equal(result.outcome, "success");
    assert.deepEqual(
      result.steps.map((record) => record.name),
      ["enter_forward_room", "advance_into_room"],
    );
    assert.equal(
      result.observations.some(
        (record) =>
          record.event?.kind === "context_changed" &&
          record.event.context === "questdone",
      ),
      true,
    );
    assert.equal(transport.sendCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot inspects a corridor stop and exposes a trap before movement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-corridor-trap-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> inventory",
        "[ 11] agent-map: begin areas=1 current='corA'",
        "[ 12] agent-map: area index=0 id='corA' kind=1 current=1 tiles=3 visited=1",
        "[ 13] agent-map: tile area='corA' index=1 type=1 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 14] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      assert.deepEqual(command, { kind: "inspect_state", args: {} });
      await appendFile(
        path,
        [
          "[ 15] agent-state: begin",
          '[ 16] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=1 active=1 name="Reynauld" health="20/33 HP" stress="17/200 Stress" conditions="" runtime_guid=1',
          '[ 17] agent-state: actor side=party idx=1 slot=2-2 address=00BB guid=2 active=0 name="Dismas" health="23/23 HP" stress="0/200 Stress" conditions="" runtime_guid=2',
          "[ 18] agent-state: trap_chance address=00AA hero_index=0 chance=60.0",
          "[ 19] agent-state: trap_chance address=00BB hero_index=1 chance=90.0",
          '[ 20] agent-state: prop index=0 address=0000ABCD active=1 trap=1 reachable=1 direction=0 dx=0.000 name="陷阱"',
          "[ 21] agent-state: end",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "corridor");
    assert.equal(state.decision.props[0]?.trap, true);
    assert.deepEqual(state.decision.options, [
      {
        kind: "interact_room_prop",
        propIndex: 0,
        name: "陷阱",
        heroGuid: 1,
        heroName: "Reynauld",
        disarmChance: 60,
      },
      {
        kind: "interact_room_prop",
        propIndex: 0,
        name: "陷阱",
        heroGuid: 2,
        heroName: "Dismas",
        disarmChance: 90,
      },
    ]);
    assert.equal(transport.sendCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot selects the requested hero for a trap and waits for the final result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-disarm-trap-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] roomview enter: party=2 enemies=0 props=1 doors=0 wave=0 wayon=0",
        "[ 11] axcontext -> room",
        "[ 12] agent-state: begin",
        '[ 13] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=1 active=1 name="Reynauld" health="20/33 HP" stress="17/200 Stress" conditions="" runtime_guid=1',
        '[ 14] agent-state: actor side=party idx=1 slot=2-2 address=00BB guid=2 active=0 name="Dismas" health="23/23 HP" stress="0/200 Stress" conditions="" runtime_guid=2',
        "[ 15] agent-state: trap_chance address=00AA hero_index=0 chance=60.0",
        "[ 16] agent-state: trap_chance address=00BB hero_index=1 chance=90.0",
        '[ 17] agent-state: prop index=0 address=0000ABCD active=1 trap=1 reachable=1 direction=0 dx=0.000 name="陷阱"',
        "[ 18] agent-state: end",
        "[ 18] agent-map: begin areas=1 current='rooA'",
        "[ 18] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
        "[ 18] agent-map: tile area='rooA' index=0 type=1 content=0 knowledge=3 visible=1 visited=1 current=1",
        "[ 18] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "disarm_trap") {
        assert.deepEqual(command, {
          kind: "disarm_trap",
          args: { propIndex: 0, heroIndex: 1 },
        });
        await appendFile(
          path,
          [
            "[ 20] agent-event: trap_started prop=0000ABCD actor=00BB guid=2 hero_index=1 deliberate=1",
            "[ 21] agent-event: trap_result prop=0000ABCD actor=00BB guid=2 outcome=disarmed hp_delta=0.0 stress_delta=0.0 deliberate=1",
            "",
          ].join("\n"),
          "utf8",
        );
        return;
      }
      assert.deepEqual(command, { kind: "inspect_state", args: {} });
      await appendFile(
        path,
        [
          "[ 22] agent-state: begin",
          '[ 23] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=1 active=1 name="Reynauld" health="20/33 HP" stress="17/200 Stress" conditions="" runtime_guid=1',
          '[ 24] agent-state: actor side=party idx=1 slot=2-2 address=00BB guid=2 active=0 name="Dismas" health="23/23 HP" stress="0/200 Stress" conditions="" runtime_guid=2',
          "[ 25] agent-state: end",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      {
        settlementTimeoutMilliseconds: 100,
        inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "disarm-trap-1",
      expectedRevision: before.revision,
      action: { kind: "interact_room_prop", propIndex: 0, heroGuid: 2 },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.reason, "Dismas disarmed 陷阱 (90% chance).");
    assert.equal(result.steps[0]?.name, "disarm_trap");
    assert.equal(result.steps[1]?.name, "inspect_after_dungeon_interaction");
    assert.equal(transport.sendCount, 2);
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

test("Copilot travels only to the room explicitly selected by the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-travel-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] roomview enter: party=4 enemies=0 props=0 doors=2 wave=0 wayon=0",
        "[ 11] axcontext -> room",
        "[ 12] agent-map: begin areas=3 current='rooA'",
        "[ 13] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
        "[ 14] agent-map: tile area='rooA' index=0 type=0 content=-1 knowledge=1 visible=0 visited=1 current=1",
        "[ 15] agent-map: edge from='rooA' direction=3 to='rooB' corridor='corA' corridorTiles=2",
        "[ 16] agent-map: area index=1 id='corA' kind=1 current=0 tiles=2 visited=0",
        "[ 17] agent-map: area index=2 id='rooB' kind=0 current=0 tiles=1 visited=0",
        "[ 18] agent-map: tile area='rooB' index=0 type=0 content=-1 knowledge=1 visible=0 visited=0 current=0",
        "[ 19] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const log = new CombatLogSource(path, 100);
    let step = 0;
    const transport = new FakeCommandTransport(async (command) => {
      step += 1;
      if (step === 1) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 109, mod: 0 },
        });
        await appendFile(
          path,
          "[ 20] mapreview open (focus)\n[ 21] axcontext -> map\n",
          "utf8",
        );
      } else if (step === 2) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 0x4000004a, mod: 0 },
        });
        await appendFile(path, "[ 22] mapnav home -> area=0 tile=0\n", "utf8");
      } else if (step === 3) {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 0x4000004f, mod: 0 },
        });
        await appendFile(
          path,
          "[ 23] mapnav room-step dir=3 -> area=2 tile=0\n",
          "utf8",
        );
      } else {
        assert.deepEqual(command, {
          kind: "key_press",
          args: { sym: 13, mod: 0 },
        });
        await appendFile(
          path,
          "[ 24] map-move: 'rooA' -> 'rooB' via door {'corA', tile 0}\n[ 25] map-move: party started moving -> \"Room B\"\n",
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
      requestId: "travel-rooB-1",
      expectedRevision: before.revision,
      action: { kind: "travel_to_room", roomId: "rooB" },
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.action.kind, "travel_to_room");
    assert.equal(result.steps.length, 4);
    assert.equal(transport.sendCount, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    const transport = new FakeCommandTransport(async () => {});
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

    const refused = await engine.act({ requestId: "wrong-actor", expectedRevision: state.revision,
      action: { kind: "use_skill", actorGuid: 999, skillElementId: "0x736b6c6c", target: { targetGuid: 17 } } });
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
    const transport = new FakeCommandTransport(async () => {});
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

test("Copilot refuses to consume curio-only supplies outside an event item option", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-curio-supply-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-state: begin",
        '[ 12] agent-state: inventory slot=8 amount=1 type="supply" item_id="skeleton_key" key="inv_key" name="万能钥匙"',
        "[ 13] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async () => {});
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 10, inspectionTimeoutMilliseconds: 5, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    const result = await engine.act({
      requestId: "unsafe-key-use-1",
      expectedRevision: state.revision,
      action: { kind: "use_inventory_item", inventorySlot: 8 },
    });
    assert.equal(result.outcome, "failure");
    assert.match(result.reason, /verified event item option/u);
    assert.equal(transport.commands.some((command) => command.kind !== "inspect_map"), false);
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
    const transport = new FakeCommandTransport(async () => {});
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

test("Copilot exposes only verified compatible supplies for an active event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-event-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        '[ 10] event: scroll opened, skin=2 rows=2 title="未上锁的保险箱"',
        "[ 11] agent-state: begin",
        '[ 12] agent-state: inventory slot=0 amount=2 type="provision" item_id="skeleton_key" key="inv_key" name="万能钥匙"',
        '[ 13] agent-state: inventory slot=5 amount=4 type="provision" item_id="torch" key="inv_torch" name="火把"',
        '[ 14] agent-state: event begin skin=2 rows=2 pick_item=0 title="未上锁的保险箱" flavour="一个结实的旧箱子。"',
        '[ 15] agent-state: event row=0 name="使用物品" desc="选择一件补给品。" item_slot=1 enabled=1',
        '[ 16] agent-state: event row=1 name="调查" desc="徒手打开。" item_slot=0 enabled=1',
        "[ 17] agent-state: event item slot=0 works=1",
        "[ 18] agent-state: event item slot=5 works=0",
        "[ 19] agent-state: event end",
        "[ 20] agent-state: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async () => {});
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "event");
    assert.deepEqual(state.decision.options, [
      {
        kind: "use_item_on_event",
        optionIndex: 0,
        inventorySlot: 0,
        optionName: "使用物品",
        itemName: "万能钥匙",
        amount: 2,
      },
      {
        kind: "choose_event_option",
        optionIndex: 1,
        name: "调查",
        description: "徒手打开。",
      },
    ]);
    assert.equal(transport.sendCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot activates an event option by index without cursor key simulation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-event-direct-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, [
      '[ 10] event: scroll opened, skin=2 rows=2 title="未上锁的保险箱"',
      '[ 11] agent-state: event begin skin=2 rows=2 pick_item=0 title="未上锁的保险箱" flavour="一个结实的旧箱子。"',
      '[ 12] agent-state: event row=0 name="使用物品" desc="选择一件补给品。" item_slot=1 enabled=1',
      '[ 13] agent-state: event row=1 name="调查" desc="徒手打开。" item_slot=0 enabled=1',
      '[ 14] agent-state: event end',
      "",
    ].join("\n"), "utf8");
    let inspectionCount = 0;
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        inspectionCount += 1;
        if (inspectionCount > 1) {
          await appendFile(path, '[ 40] agent-state: begin\n[ 41] agent-state: end\n', "utf8");
          return;
        }
        await appendFile(path, [
          '[ 15] agent-state: begin',
          '[ 16] agent-state: event begin skin=2 rows=2 pick_item=0 title="未上锁的保险箱" flavour="一个结实的旧箱子。"',
          '[ 17] agent-state: event row=0 name="使用物品" desc="选择一件补给品。" item_slot=1 enabled=1',
          '[ 18] agent-state: event row=1 name="调查" desc="徒手打开。" item_slot=0 enabled=1',
          '[ 19] agent-state: event end',
          '[ 20] agent-state: end',
          "",
        ].join("\n"), "utf8");
        return;
      }
      assert.deepEqual(command, {
        kind: "activate_event_option",
        args: { optionIndex: 1 },
      });
      await appendFile(path, [
        '[ 30] event: agent option 1 "调查" result=native state 2 -> 3',
        '[ 31] event: scroll closed',
        "",
      ].join("\n"), "utf8");
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 },
    );
    const before = await engine.getState("compact");
    const result = await engine.act({
      requestId: "event-direct-1",
      expectedRevision: before.revision,
      action: { kind: "choose_event_option", optionIndex: 1 },
    });
    assert.equal(result.outcome, "success");
    assert.equal(transport.commands.filter((command) => command.kind === "activate_event_option").length, 1);
    assert.equal(transport.commands.some((command) => command.kind === "key_press"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copilot blocks route choices while a room interactable is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-prop-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] roomview enter: party=4 enemies=0 props=1 doors=1 wave=0 wayon=0",
        "[ 11] axcontext -> room",
        "[ 12] agent-state: begin",
        '[ 13] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=1 active=1 name="Reynauld" health="20/33 HP" stress="17/200 Stress" conditions="" runtime_guid=101',
        '[ 14] agent-state: prop index=0 address=0000ABCD active=1 trap=0 reachable=1 direction=1 dx=0.250 name="未上锁的保险箱"',
        "[ 15] agent-state: end",
        "[ 15] agent-map: begin areas=3 current='rooA'",
        "[ 16] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
        "[ 17] agent-map: edge from='rooA' direction=3 to='rooB' corridor='corA' corridorTiles=2",
        "[ 18] agent-map: area index=1 id='corA' kind=1 current=0 tiles=2 visited=0",
        "[ 19] agent-map: area index=2 id='rooB' kind=0 current=0 tiles=1 visited=0",
        "[ 20] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const transport = new FakeCommandTransport(async () => {});
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "room");
    assert.deepEqual(state.decision.options, [
      {
        kind: "interact_room_prop",
        propIndex: 0,
        name: "未上锁的保险箱",
        heroGuid: 1,
        heroName: "Reynauld",
      },
    ]);
    assert.equal(transport.sendCount, 0);
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
      { settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1 },
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
      new LocalGameGateway(new CombatLogSource(path, 100), new FakeCommandTransport(async () => {})),
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

test("forceRefresh requests fresh state and map snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-force-refresh-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(path, "[ 10] axcontext -> room\n", "utf8");
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "inspect_state") {
        await appendFile(path, "[ 20] agent-state: begin\n[ 21] agent-state: end\n", "utf8");
        return;
      }
      if (command.kind === "inspect_map") {
        await appendFile(
          path,
          "[ 30] agent-map: begin areas=1 current='rooA'\n[ 31] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1\n[ 32] agent-map: end\n",
          "utf8",
        );
        return;
      }
      assert.fail(`Unexpected command: ${JSON.stringify(command)}`);
    });
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), transport),
      { inspectionTimeoutMilliseconds: 100, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.forceRefresh("compact", 0, true);
    assert.equal(state.map?.currentAreaId, "rooA");
    assert.deepEqual(transport.commands.slice(0, 2).map((command) => command.kind), [
      "inspect_state",
      "inspect_map",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a secret room exposes its two real endpoint rooms instead of the corridor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-copilot-secret-exit-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] axcontext -> room",
        "[ 11] agent-map: begin areas=4 current='secA'",
        "[ 12] agent-map: area index=0 id='rooA' kind=0 current=0 tiles=1 visited=1",
        "[ 13] agent-map: area index=1 id='coAB' kind=1 current=0 tiles=5 visited=1",
        "[ 14] agent-map: area index=2 id='rooB' kind=0 current=0 tiles=1 visited=0",
        "[ 15] agent-map: area index=3 id='secA' kind=0 current=1 tiles=1 visited=1",
        "[ 16] agent-map: edge from='rooA' direction=3 to='rooB' corridor='coAB' corridorTiles=5",
        "[ 17] agent-map: edge from='rooB' direction=2 to='rooA' corridor='coAB' corridorTiles=5",
        "[ 18] agent-map: edge from='secA' direction=0 to='coAB' corridor='coAB' corridorTiles=5",
        "[ 19] agent-map: end",
        "",
      ].join("\n"),
      "utf8",
    );
    const engine = new CopilotEngine(
      new LocalGameGateway(new CombatLogSource(path, 100), new FakeCommandTransport(async () => {})),
    );
    const state = await engine.getState("compact");
    assert.equal(state.decision.kind, "room");
    assert.deepEqual(
      state.decision.options.map((option: { roomId: string }) => option.roomId).sort(),
      ["rooA", "rooB"],
    );
    assert.equal(state.decision.options.some((option: { roomId: string }) => option.roomId === "coAB"), false);
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

test("live-helper actions get the same schema validation as MCP actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-action-schema-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, "[ 1] axcontext -> room\n");
    const source = new CombatLogSource(path);
    const transport = new FakeCommandTransport(async () => assert.fail("invalid input must not execute"));
    const engine = new CopilotEngine(new LocalGameGateway(source, transport));
    const before = await source.refresh();
    const result = await engine.act({ requestId: "bad", expectedRevision: before.revision,
      action: { kind: "use_inventory_item", inventorySlot: -1, targetIndex: 0 } });
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
    const result = await engine.act({ requestId: "party", expectedRevision: before.revision,
      action: { kind: "form_embark_party", frontToBack: [1, 2, 3, 4] } });
    assert.equal(result.outcome, "success", result.reason);
    assert.deepEqual([1, 2, 3, 4].map((position) => party.get(position)), [1, 2, 3, 4]);
    assert.equal(transport.commands.filter((command) => command.kind === "assign_party_hero").length, 4);
    const repeat = await engine.act({ requestId: "same-party", expectedRevision: (await source.refresh()).revision,
      action: { kind: "form_embark_party", frontToBack: [1, 2, 3, 4] } });
    assert.equal(repeat.outcome, "success");
    assert.equal(transport.commands.filter((command) => command.kind === "assign_party_hero").length, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("camp targeting commits the requested GUID without cursor navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-camp-guid-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, [
      '[ 1] agent-state: begin',
      '[ 2] agent-state: camp phase=6 points=12 meal_options=0',
      '[ 3] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=7 active=1 name="Actor" health="20/20 HP" stress="0/200 Stress" conditions="" runtime_guid=107',
      '[ 4] agent-state: actor side=party idx=1 slot=2-2 address=0002 guid=8 active=0 name="Target" health="10/20 HP" stress="0/200 Stress" conditions="" runtime_guid=108',
      '[ 5] agent-state: action kind=skill index=0 skill_slot=1 element=0x111 name="Heal"',
      '[ 6] agent-state: end', ''
    ].join('\n'));
    const transport = new FakeCommandTransport(async (command) => {
      if (command.kind === "click_element") await appendFile(path, '[ 10] axcontext -> camptarget\n');
      else if (command.kind === "commit_camp_target") {
        assert.deepEqual(command.args, { targetGuid: 108, actorGuid: 107, skillElementId: "0x111" });
        await appendFile(path, '[ 11] camp target: agent selected guid=108 performer_guid=107\n[ 12] camp: respite points 12 -> 9\n');
      } else if (command.kind === "inspect_state") await appendFile(path, '[ 13] agent-state: begin\n[ 14] agent-state: camp phase=6 points=9 meal_options=0\n[ 15] agent-state: end\n');
      else assert.fail(`Unexpected cursor navigation: ${command.kind}`);
    });
    const source = new CombatLogSource(path);
    const engine = new CopilotEngine(new LocalGameGateway(source, transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 100, inspectionTimeoutMilliseconds: 100 });
    const before = await source.refresh();
    const result = await engine.act({ requestId: "camp", expectedRevision: before.revision,
      action: { kind: "use_camp_skill", skillSlot: 1, targetHeroGuid: 8 } });
    assert.equal(result.outcome, "success", result.reason);
    assert.equal(transport.commands.length, 3);
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
    const invalidParty = await engine.act({ requestId: "no-quest-party", expectedRevision: (await source.refresh()).revision,
      action: { kind: "form_embark_party", frontToBack: [1, 2, 3, 4] } });
    assert.equal(invalidParty.outcome, "failure");
    assert.match(invalidParty.reason, /Select an embark quest/);
    assert.equal(transport.sendCount, 0);
    const result = await engine.act({ requestId: "quest", expectedRevision: (await source.refresh()).revision,
      action: { kind: "select_embark_quest", questIndex: 5, questId: "quest_a" } });
    assert.equal(result.outcome, "success", result.reason);
    assert.match(result.reason, /instance 5/);
    assert.equal(transport.commands.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
