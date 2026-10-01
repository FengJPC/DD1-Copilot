import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CopilotEngine } from "../src/copilot/engine.js";
import { LocalGameGateway } from "../src/copilot/local-game-gateway.js";
import { CombatLogSource } from "../src/live/combat-log-source.js";
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

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
    const transport = new FakeCommandTransport(async () => { });
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
      new LocalGameGateway(new CombatLogSource(path, 100), new FakeCommandTransport(async () => { })),
      { settlementTimeoutMilliseconds: 20, pollIntervalMilliseconds: 1 },
    );
    const state = await engine.getState("compact");
    assert.equal(state.room?.props?.[0]?.name, "墙上火把");
    assert.equal(state.decision.options?.[0]?.name, "墙上火把");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    const transport = new FakeCommandTransport(async () => { });
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
    const transport = new FakeCommandTransport(async () => { });
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
    const transport = new FakeCommandTransport(async () => { });
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
      new LocalGameGateway(new CombatLogSource(path, 100), new FakeCommandTransport(async () => { })),
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
    const result = await engine.act({
      requestId: "camp", expectedRevision: before.revision,
      action: { kind: "use_camp_skill", skillSlot: 1, targetHeroGuid: 8 }
    });
    assert.equal(result.outcome, "success", result.reason);
    assert.equal(transport.commands.length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
