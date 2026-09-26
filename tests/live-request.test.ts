import assert from "node:assert/strict";
import test from "node:test";

import {
  observeLiveActionState,
  resolveLiveExpectedRevision,
} from "../src/copilot/live-request.js";

test("live actions use the freshly observed revision when the caller omits one", () => {
  assert.equal(resolveLiveExpectedRevision(undefined, 109_823), 109_823);
  assert.equal(resolveLiveExpectedRevision(null, 109_823), 109_823);
  assert.equal(resolveLiveExpectedRevision(42, 109_823), 42);
  assert.equal(resolveLiveExpectedRevision("42", 109_823), 42);
  assert.equal(Number.isNaN(resolveLiveExpectedRevision("bad", 109_823)), true);
});

test("the first live action forces a game-side refresh before using reconstructed state", async () => {
  const calls: string[] = [];
  const source = {
    async getState() {
      calls.push("get");
      return { revision: 10, loot: { active: true } };
    },
    async forceRefresh() {
      calls.push("refresh");
      return { revision: 11, loot: undefined };
    },
  };

  const first = await observeLiveActionState(source, false);
  const later = await observeLiveActionState(source, true);

  assert.deepEqual(calls, ["refresh", "get"]);
  assert.deepEqual(first, { revision: 11, loot: undefined });
  assert.deepEqual(later, { revision: 10, loot: { active: true } });
});
