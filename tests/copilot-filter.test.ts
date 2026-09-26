import assert from "node:assert/strict";
import test from "node:test";

import { filterCopilotRecords } from "../src/copilot/filter.js";
import type { BlindestLogRecord } from "../src/live/combat-log-source.js";

function record(
  revision: number,
  message: string,
  event?: BlindestLogRecord["event"],
): BlindestLogRecord {
  return {
    revision,
    observedAt: "2026-09-25T00:00:00.000Z",
    raw: `[ ${revision}] ${message}`,
    tick: revision,
    message,
    ...(event === undefined ? {} : { event }),
  };
}

test("Copilot filtering keeps decisions, summarizes diagnostics, and samples unknowns", () => {
  const result = filterCopilotRecords(
    [
      record(1, "speech->prism kind=nav ok=1"),
      record(2, "ctrlprobe: cursor fight"),
      record(3, "tutorialpopup id=combat text=help"),
      record(4, "agent-ipc: serviced key sym=0x63 mod=0x0 accepted=1"),
      record(5, 'building: active, "stage_coach" mode=0', {
        kind: "building_opened",
        buildingId: "stage_coach",
        mode: 0,
        tick: 5,
        raw: '[ 5] building: active, "stage_coach" mode=0',
      }),
      record(6, "new parser coverage is needed for this line"),
      record(7, "another unknown line"),
      record(8, "map pan: the panel is panning to the party -- standing aside until it arrives"),
      record(9, "map pan: the panel's pan arrived -- centering the cursor tile again"),
      record(10, "repeated skill snapshot", {
        kind: "skill_observed",
        skillId: "divine_comfort",
        name: "神圣抚慰",
        tick: 10,
        raw: "[ 10] repeated skill snapshot",
      }),
      record(11, "repeated embark quest snapshot", {
        kind: "embark_quest_observed",
        row: 0,
        questIndex: 1,
        questId: "quest_a",
        dungeonId: "ruins",
        length: 1,
        difficulty: 1,
        elementId: "0x01",
        onScreen: true,
        tick: 11,
        raw: "[ 11] repeated embark quest snapshot",
      }),
      record(12, "repeated inventory item", {
        kind: "inventory_item_observed",
        slot: 2,
        amount: 3,
        itemType: "provision",
        itemId: "torch",
        itemKey: "inv_torch",
        name: "火把",
        tick: 12,
        raw: "[ 12] repeated inventory item",
      }),
      record(13, "quest: complete? 0"),
    ],
    { unclassifiedSampleLimit: 1 },
  );

  assert.deepEqual(
    result.records.map(({ revision, category }) => ({ revision, category })),
    [
      { revision: 3, category: "guidance" },
      { revision: 4, category: "action" },
      { revision: 5, category: "state" },
    ],
  );
  assert.equal(result.suppressed.count, 8);
  assert.deepEqual(result.suppressed.byReason, {
    speech_backend: 1,
    cursor_probe: 1,
    map_auto_pan: 2,
    agent_state_snapshot: 3,
    repeated_quest_completion_probe: 1,
  });
  assert.equal(result.unclassified.count, 2);
  assert.equal(result.unclassified.samples.length, 1);
  assert.equal(result.unclassified.samples[0]?.revision, 7);
  assert.equal("raw" in (result.records[2]?.event ?? {}), false);
});

test("Copilot keeps structured dungeon incidents as critical state", () => {
  const result = filterCopilotRecords([
    record(20, "trap result", {
      kind: "trap_result",
      propAddress: "AA",
      actorAddress: "BB",
      heroGuid: 17,
      outcome: "disarmed",
      hpDelta: 0,
      stressDelta: 0,
      deliberate: true,
      tick: 20,
      raw: "[ 20] trap result",
    }),
    record(21, "kleptomaniac theft", {
      kind: "quirk_loot_withheld",
      actorAddress: "BB",
      heroGuid: 17,
      quirkId: "kleptomaniac",
      text: "Reynauld: 我会把这份留给自己。",
      tick: 21,
      raw: "[ 21] kleptomaniac theft",
    }),
    record(22, "forced curio warning", {
      kind: "dungeon_announcement",
      slot: 1,
      slotCount: 1,
      actorAddress: "0",
      text: "柜门的锁上有机关！",
      tick: 22,
      raw: "[ 22] forced curio warning",
    }),
  ]);

  assert.deepEqual(result.records.map((item) => item.importance), ["critical", "critical", "critical"]);
  assert.deepEqual(
    result.records.map((item) => item.event?.kind),
    ["trap_result", "quirk_loot_withheld", "dungeon_announcement"],
  );
});
