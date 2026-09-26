import assert from "node:assert/strict";
import test from "node:test";
import { initialCombatState, reduceCombatState } from "../src/state/combat-state.js";
import { parseBlindestLine } from "../src/blindest/parse-line.js";
import { inventoryTarget, resolveRequestedTarget, resolveSkill } from "../src/copilot/identity.js";

test("runtime actor IDs remain separate from durable roster IDs", () => {
  const modern = parseBlindestLine('[ 1] agent-state: actor side=party idx=0 slot=1-1 address=0001 guid=7 active=1 name="Hero" health="10/20 HP" stress="0/200 Stress" conditions="" runtime_guid=107')!;
  assert.equal(modern.kind, "combatant_observed");
  const state = reduceCombatState(initialCombatState(), modern);
  assert.equal(state.combatants[0]?.heroGuid, 7);
  assert.equal(state.combatants[0]?.actorGuid, 107);
  assert.equal(inventoryTarget(state, { targetHeroGuid: 7 })?.actorGuid, 107);
  assert.equal(inventoryTarget(state, { targetHeroGuid: 107 }), undefined);
  assert.equal(resolveRequestedTarget(state, { targetGuid: 7 }), undefined);
  assert.equal(resolveRequestedTarget(state, { targetGuid: 107 })?.heroGuid, 7);
  const old = parseBlindestLine('[ 1] agent-state: actor side=enemy idx=0 slot=1-1 address=0002 guid=7 active=0 name="Enemy" health="10/20 HP" stress="" conditions=""')!;
  assert.equal(reduceCombatState(initialCombatState(), old).combatants[0]?.actorGuid, undefined);
});

test("identity resolution rejects conflicting and duplicate selectors", () => {
  const state = initialCombatState();
  const hero = { side: "party" as const, slot: 1, slotEnd: 1, actorAddress: "0001", actorGuid: 107,
    heroGuid: 7, name: "Same Name", conditions: "", details: [], resists: [], quirks: [], diseases: [] };
  state.combatants = [hero, { ...hero, actorGuid: 108, heroGuid: 8, actorAddress: "0002", slot: 2, slotEnd: 2 }];
  assert.equal(resolveRequestedTarget(state, { targetGuid: 107, slot: 2 }), undefined);
  assert.equal(resolveRequestedTarget(state, { targetGuid: 107, side: "enemy" }), undefined);
  assert.equal(inventoryTarget(state, { targetHeroGuid: 8, targetIndex: 0 }), undefined);
  assert.equal(inventoryTarget(state, { targetIndex: 1 })?.actorGuid, 108);
  state.combatants[1]!.actorGuid = 107;
  assert.equal(resolveRequestedTarget(state, { targetGuid: 107 }), undefined);
  assert.equal(resolveRequestedTarget(state, {}), undefined);
});

test("skill selection resolves the element ID and rejects a conflicting slot", () => {
  const state = initialCombatState();
  state.combatActions = [
    { kind: "skill", index: 0, skillSlot: 1, elementId: "0x111", name: "Heal", details: [] },
    { kind: "skill", index: 1, skillSlot: 2, elementId: "0x112", name: "Attack", details: [] },
  ];
  assert.equal(resolveSkill(state, { kind: "use_skill", skillElementId: "0x112" })?.skillSlot, 2);
  assert.equal(resolveSkill(state, { kind: "use_skill", skillElementId: "0x112", skillSlot: 1 }), undefined);
  assert.equal(resolveSkill(state, { kind: "use_skill" }), undefined);
});

test("provision totals include every stack of the requested item", async () => {
  const { provisionAmount } = await import("../src/copilot/identity.js");
  const state = initialCombatState();
  const item = { section: 1, slot: 0, amount: 12, itemType: "provision", itemId: "food", itemKey: "food", priceKnown: true, goldPrice: 75, shardPrice: 0, freeCount: 0 };
  state.provisioning = { items: [item, { ...item, slot: 1, amount: 3 }, { ...item, section: 0, amount: 99 }] };
  assert.equal(provisionAmount(state, "food"), 15);
});
