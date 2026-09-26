import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CombatLogSource } from "../src/live/combat-log-source.js";

test("keeps unrecognized log lines and waits for complete lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-log-source-test-"));
  const path = join(directory, "ddaccess-debug.log");
  try {
    await writeFile(
      path,
      [
        "[ 10] an event the parser does not know yet",
        "[ 20] resting point: combat started",
        "",
      ].join("\n"),
      "utf8",
    );

    const source = new CombatLogSource(path, 20);
    const first = await source.refresh();
    const records = source.recordsAfter(0, 20);
    assert.equal(first.revision, 2);
    assert.equal(first.state.combatActive, true);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.message, "an event the parser does not know yet");
    assert.equal(records[0]?.event, undefined);
    assert.equal(records[1]?.event?.kind, "combat_started");

    await appendFile(path, "[ 30] incomplete", "utf8");
    assert.equal((await source.refresh()).revision, 2);
    await appendFile(path, " line\n", "utf8");
    assert.equal((await source.refresh()).revision, 3);
    assert.equal(
      source.recordsAfter(2, 20)[0]?.message,
      "incomplete line",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent log refreshes share a cursor and never duplicate events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-log-concurrency-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, "[ 1] resting point: combat started\n");
    const source = new CombatLogSource(path);
    const reads = await Promise.all(Array.from({ length: 20 }, () => source.refresh()));
    assert.equal(reads.every((snapshot) => snapshot.revision === 1), true);
    assert.equal(source.recordsAfter(0).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("log replacement invalidates old revisions even when the file regrows to the same size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-log-rotation-"));
  const path = join(directory, "log");
  try {
    await writeFile(path, "[ 1] axcontext -> room\n");
    const source = new CombatLogSource(path);
    const before = await source.refresh();
    await writeFile(path, "[ 2] axcontext -> menu\n");
    const after = await source.refresh();
    assert.ok(after.revision > before.revision);
    assert.equal(source.recordsAfter(0).length, 1);
    assert.equal(source.recordsAfter(before.revision)[0]?.message, "axcontext -> menu");
    await writeFile(path, "");
    assert.ok((await source.refresh()).revision > after.revision);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("large log reads preserve Chinese text across chunks and bound retained records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dd1-log-chunks-"));
  const path = join(directory, "log");
  try {
    const line = "[ 1] 战斗事件：英雄恢复生命\n";
    await writeFile(path, line.repeat(30_000));
    const source = new CombatLogSource(path, 20);
    const snapshot = await source.refresh();
    assert.equal(snapshot.revision, 30_000);
    assert.equal(source.recordsAfter(0, 100).length, 20);
    assert.equal(source.recordsAfter(0)[0]?.message, "战斗事件：英雄恢复生命");
    const partial = Buffer.from("[ 2] 火把\n");
    await appendFile(path, partial.subarray(0, partial.length - 2));
    assert.equal((await source.refresh()).revision, 30_000);
    await appendFile(path, partial.subarray(partial.length - 2));
    assert.equal((await source.refresh()).revision, 30_001);
    assert.equal(source.recordsAfter(30_000)[0]?.message, "火把");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
