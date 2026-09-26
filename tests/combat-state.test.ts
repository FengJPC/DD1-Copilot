import assert from "node:assert/strict";
import test from "node:test";

import { parseBlindestLine } from "../src/blindest/parse-line.js";
import {
  initialCombatState,
  reduceCombatState,
} from "../src/state/combat-state.js";

test("only an explicit TURN heroswap changes the current actor", () => {
  const turn = parseBlindestLine(
    '[ 10] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Dismas, 强盗. 19/23 生命：. 7/200 压力：."',
  );
  assert.equal(turn?.kind, "actor_changed");
  if (turn === undefined) assert.fail("turn line was not parsed");
  let state = reduceCombatState(initialCombatState(), turn);
  assert.equal(state.phase, "combat");
  assert.equal(state.combatActive, true);
  assert.equal(state.combatEndCandidate, false);
  assert.deepEqual(state.currentActor, {
    address: "0002",
    name: "Dismas",
    heroClass: "强盗",
    currentHp: 19,
    maxHp: 23,
    stress: 7,
    maxStress: 200,
    turnTick: 10,
  });

  const focusOnly = parseBlindestLine(
    '[ 11] heroswap: 0002 -> 0003 -> "Reynauld, 十字军. 33/33 生命：. 0/200 压力：."',
  );
  assert.equal(focusOnly, undefined);
  assert.equal(state.currentActor?.address, "0002");
});

test("an active party member in a structured snapshot recovers a missed turn handoff", () => {
  const lines = [
    "[ 1] resting point: combat started — test",
    "[ 2] axcontext -> actions",
    '[ 3] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Dismas, 强盗. 19/23 生命：. 7/200 压力：."',
    '[ 4] armed-watch: the GAME armed "手枪射击" -- opening the target list (bar item 1, elem 0x736b6c6c)',
    '[ 5] target row 0/1 (enemy idx=0 slot=1) area=0 -> "邪教徒斗士, 85% to hit, 5-9 damage, 12.5% crit, 15/15 生命：. 敌方第1位."',
    '[ 6] heroswap: 0002 -> 0003 -> "Reynauld, 十字军. 31/33 生命：. 4/200 压力：."',
    "[ 7] agent-state: begin",
    '[ 8] agent-state: actor side=party idx=0 slot=1-1 address=0003 active=1 name="Reynauld, 十字军" health="31/33 生命：" stress="4/200 压力：" conditions=""',
    '[ 9] agent-state: action kind=skill index=1 skill_slot=1 element=0x7374756e name="眩晕打击"',
    "[ 10] agent-state: end",
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    if (line.includes("[ 6]")) {
      assert.equal(event, undefined, "focus-only heroswap must remain non-semantic");
      continue;
    }
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }

  assert.equal(state.phase, "combat");
  assert.deepEqual(state.currentActor, {
    address: "0003",
    name: "Reynauld",
    heroClass: "十字军",
    currentHp: 31,
    maxHp: 33,
    stress: 4,
    maxStress: 200,
    turnTick: 8,
  });
  assert.equal(state.selectedSkill, undefined);
  assert.equal(state.currentTarget, undefined);
  assert.deepEqual(state.targets, []);
  assert.equal(state.combatActions[0]?.name, "眩晕打击");
  assert.equal(state.inspection?.actorAddress, "0003");
  assert.equal(state.inspection?.completedTick, 10);
});

test("parses attack target previews and game-side inspection snapshots", () => {
  const lines = [
    "[ 20] agent-state: begin",
    '[ 21] agent-state: actor side=enemy idx=1 slot=2-2 address=0011 active=0 name="邪教徒斗士" health="15/15 生命：" stress="" conditions="流血。"',
    '[ 22] agent-state: action kind=skill index=1 skill_slot=1 element=0x736b6c6c name="手枪射击"',
    "[ 23] agent-state: end",
    '[ 24] target row 1/2 (enemy idx=1 slot=2) area=0 -> "邪教徒斗士, 85% to hit, 5-9 damage, 12.5% crit, 15/15 生命：. 敌方第2位."',
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.combatants[0]?.name, "邪教徒斗士");
  assert.equal(state.combatants[0]?.currentHp, 15);
  assert.equal(state.combatActions[0]?.skillSlot, 1);
  assert.equal(state.currentTarget?.targetIndex, 1);
  assert.equal(state.currentTarget?.hitPercent, 85);
});

test("builds a structured dungeon map and applies compact position updates", () => {
  const lines = [
    "[ 30] agent-map: begin areas=3 current='rooA'",
    "[ 31] agent-map: area index=0 id='rooA' kind=0 current=1 tiles=1 visited=1",
    "[ 32] agent-map: tile area='rooA' index=0 type=0 content=-1 knowledge=1 visible=0 visited=1 current=1",
    "[ 33] agent-map: edge from='rooA' direction=3 to='rooB' corridor='corA' corridorTiles=2",
    "[ 34] agent-map: area index=1 id='corA' kind=1 current=0 tiles=2 visited=0",
    "[ 35] agent-map: tile area='corA' index=0 type=0 content=-1 knowledge=1 visible=0 visited=0 current=0",
    "[ 36] agent-map: tile area='corA' index=1 type=0 content=-1 knowledge=1 visible=0 visited=0 current=0",
    "[ 37] agent-map: area index=2 id='rooB' kind=0 current=0 tiles=1 visited=0",
    "[ 38] agent-map: tile area='rooB' index=0 type=0 content=7 knowledge=2 visible=1 visited=0 current=0",
    "[ 39] agent-map: end",
    "[ 40] agent-map: position area='corA' tile=0",
    "[ 41] agent-map: position area='rooB' tile=0",
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.dungeonMap?.completedTick, 39);
  assert.equal(state.dungeonMap?.currentAreaId, "rooB");
  assert.equal(state.dungeonMap?.positionTick, 41);
  assert.equal(
    state.dungeonMap?.areas.find((area) => area.areaId === "rooB")?.visited,
    true,
  );
  assert.equal(
    state.dungeonMap?.areas.find((area) => area.areaId === "corA")?.visited,
    false,
  );
});

test("restores the room phase when camping ends", () => {
  const lines = [
    "[ 42] agent-map: begin areas=1 current='rooI'",
    "[ 43] agent-map: area index=0 id='rooI' kind=0 current=1 tiles=1 visited=1",
    "[ 44] agent-map: tile area='rooI' index=0 type=3 content=0 knowledge=3 visible=1 visited=1 current=1",
    "[ 45] agent-map: end",
    "[ 46] agent-state: camp phase=6 points=2 meal_options=0",
    "[ 47] agent-state: camp phase=0 points=2 meal_options=0",
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.camp?.phase, 0);
  assert.equal(state.phase, "room");
});

test("restores the physical corridor phase after a tutorial closes into inventory", () => {
  const lines = [
    "[ 30] agent-map: begin areas=1 current='corA'",
    "[ 31] agent-map: area index=0 id='corA' kind=1 current=1 tiles=3 visited=1",
    "[ 32] agent-map: tile area='corA' index=1 type=1 content=0 knowledge=3 visible=1 visited=1 current=1",
    "[ 33] agent-map: end",
    '[ 34] tutorialpopup id=disarm_trap text="Select a hero to disarm the trap."',
    "[ 35] axcontext -> tutorial",
    '[ 36] tutorial closed; context "inventory" does not re-announce',
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.activeTutorial, undefined);
  assert.equal(state.currentContext, "inventory");
  assert.equal(state.phase, "traveling");
});

test("builds structured room, inventory, event, and loot snapshots", () => {
  const eventLines = [
    "[ 50] roomview enter: party=4 enemies=0 props=1 doors=1 wave=0 wayon=0",
    '[ 51] event: scroll opened, skin=2 rows=2 title="未上锁的保险箱"',
    "[ 52] agent-state: begin",
    '[ 53] agent-state: prop index=0 address=0000ABCD active=1 trap=0 reachable=1 direction=1 dx=0.375 name="未上锁的保险箱"',
    '[ 54] agent-state: inventory slot=0 amount=2 type="provision" item_id="skeleton_key" key="inv_key" name="万能钥匙"',
    '[ 55] agent-state: inventory slot=5 amount=4 type="provision" item_id="torch" key="inv_torch" name="火把"',
    '[ 56] agent-state: event begin skin=2 rows=2 pick_item=0 title="未上锁的保险箱" flavour="一个结实的旧箱子。"',
    '[ 57] agent-state: event row=0 name="使用物品" desc="选择一件补给品。" item_slot=1 enabled=1',
    '[ 58] agent-state: event row=1 name="调查" desc="徒手打开。" item_slot=0 enabled=1',
    "[ 59] agent-state: event item slot=0 works=1",
    "[ 60] agent-state: event item slot=5 works=0",
    "[ 61] agent-state: event end",
    "[ 62] agent-state: end",
  ];
  let state = initialCombatState();
  for (const line of eventLines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.phase, "event");
  assert.equal(state.room?.props?.[0]?.name, "未上锁的保险箱");
  assert.equal(state.room?.props?.[0]?.reachable, true);
  assert.deepEqual(
    state.inventory.map((item) => [item.slot, item.name]),
    [
      [0, "万能钥匙"],
      [5, "火把"],
    ],
  );
  assert.deepEqual(state.eventOverlay?.compatibleInventorySlots, [0]);
  assert.equal(state.eventOverlay?.options[1]?.name, "调查");
  assert.equal(state.eventOverlay?.completedTick, 61);

  const lootLines = [
    '[ 70] loot: window opened, 2 items, token="curio" type=0 [input stack 3]',
    "[ 71] agent-state: begin",
    "[ 72] agent-state: loot begin count=2",
    '[ 73] agent-state: loot item=0 pool_slot=3 amount=1000 type="gold" item_id="gold" key="loot_gold" name="金币"',
    '[ 74] agent-state: loot item=1 pool_slot=7 amount=1 type="provision" item_id="shovel" key="loot_shovel" name="铲子"',
    "[ 75] agent-state: loot end",
    "[ 76] agent-state: end",
  ];
  for (const line of lootLines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.phase, "loot");
  assert.equal(state.loot?.itemCount, 2);
  assert.deepEqual(
    state.loot?.items.map((item) => [item.itemIndex, item.name, item.amount]),
    [
      [0, "金币", 1000],
      [1, "铲子", 1],
    ],
  );
  assert.equal(state.loot?.completedTick, 75);

  for (const line of ["[ 77] axcontext -> room", "[ 78] agent-state: begin", "[ 79] agent-state: end"]) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.eventOverlay, undefined);
  assert.equal(state.loot, undefined);
  assert.equal(state.phase, "room");
});

test("remembers a curio explicitly ignored by the player", () => {
  const lines = [
    '[ 1] agent-state: prop index=0 address=0000CAFE active=1 trap=0 reachable=1 direction=1 dx=0.1 name="铁处女"',
    '[ 2] event: scroll opened, skin=2 rows=3 title="铁处女"',
    '[ 3] event: activating "无视" via native action 0x707e00 (cap=0.0)',
    '[ 4] event: scroll closed',
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.deepEqual(state.ignoredPropKeys, ["0000CAFE\u0000铁处女"]);
  assert.equal(state.room?.props[0]?.active, true);
});

test("captures rich combat, inventory, light, camp, quest, and results inspection", () => {
  const lines = [
    "[ 80] agent-state: begin",
    '[ 81] agent-state: actor side=party idx=0 slot=1-1 address=00AA guid=4242 active=1 name="Dismas, Highwayman" health="20/23 HP" stress="5/200 Stress" conditions="" runtime_guid=4242',
    "[ 81] agent-state: trap_chance address=00AA hero_index=0 chance=90.0",
    '[ 82] agent-state: actor_detail address=00AA category=summary line=0 text="Bleed 2 damage for 3 rounds."',
    '[ 83] agent-state: actor_detail address=00AA category=resist line=0 text="Stun Resist: 40%."',
    '[ 83] agent-state: actor_detail address=00AA category=quirk line=0 text="Quick Reflexes. Positive. +2 SPD."',
    '[ 83] agent-state: actor_detail address=00AA category=disease line=0 text="The Runs. -20% Disease Resist."',
    "[ 84] agent-state: inventory begin slots=16 occupied=2",
    '[ 85] agent-state: inventory slot=2 amount=3 type="provision" item_id="torch" key="inv_torch" name="Torch"',
    "[ 86] agent-state: inventory end",
    '[ 87] agent-state: light kind=torch value=73.50 level=3 text="Radiant Light"',
    "[ 88] agent-state: camp phase=3 points=12 meal_options=2",
    '[ 89] agent-state: camp_meal option=0 food=0 available=8 text="No food."',
    '[ 90] agent-state: camp_meal option=1 food=4 available=8 text="Meal, heal 10%."',
    "[ 91] agent-state: quest rows=2 goals=1 button=abandon complete=0",
    '[ 92] agent-state: quest_row row=0 kind=goal text="Explore 90% of rooms."',
    '[ 93] agent-state: quest_row row=1 kind=button text="Abandon quest."',
    '[ 94] agent-state: action kind=skill index=0 skill_slot=1 element=0x736b6c6c name="Pistol Shot"',
    '[ 95] agent-state: skill_detail skill_slot=1 line=0 text="Usable from ranks 2, 3, 4."',
    '[ 96] agent-state: skill_detail skill_slot=1 line=1 text="85 ACC, 5-9 DMG, 10% CRIT."',
    "[ 97] agent-state: results state=1 rows=4 heroes=0",
    "[ 98] agent-state: end",
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.deepEqual(state.inventoryInfo, { slotCount: 16, occupiedCount: 2, completedTick: 86 });
  assert.deepEqual(state.combatants[0]?.details, ["Bleed 2 damage for 3 rounds."]);
  assert.deepEqual(state.combatants[0]?.resists, ["Stun Resist: 40%."]);
  assert.deepEqual(state.combatants[0]?.quirks, ["Quick Reflexes. Positive. +2 SPD."]);
  assert.deepEqual(state.combatants[0]?.diseases, ["The Runs. -20% Disease Resist."]);
  assert.equal(state.combatants[0]?.heroGuid, 4242);
  assert.equal(state.combatants[0]?.trapDisarmChance, 90);
  assert.equal(state.combatActions[0]?.details[1], "85 ACC, 5-9 DMG, 10% CRIT.");
  assert.equal(state.light?.value, 73.5);
  assert.equal(state.camp?.meals[1]?.foodRequired, 4);
  assert.equal(state.quest?.button, "abandon");
  assert.equal(state.results?.rowCount, 4);
  assert.equal(state.phase, "results");
});

test("builds an ID-addressed Butcher's Circus lineup and settles an assignment", () => {
  const lines = [
    "[ 1] axcontext -> ring",
    "[ 2] agent-circus: begin rows=2 slots=4",
    '[ 3] agent-circus: contestant row=0 hero=0000000000011000 name="朗克托" class="强盗" lineup=0 dlc_locked=0',
    '[ 4] agent-circus: contestant row=1 hero=0000000000012000 name="麦克雷" class="野蛮人" lineup=0 dlc_locked=0',
    '[ 5] agent-circus: slot=0 rank=4 hero=0000000000000000 name="" class=""',
    '[ 6] agent-circus: slot=1 rank=3 hero=0000000000000000 name="" class=""',
    '[ 7] agent-circus: slot=2 rank=2 hero=0000000000000000 name="" class=""',
    '[ 8] agent-circus: slot=3 rank=1 hero=0000000000000000 name="" class=""',
    "[ 9] agent-circus: end",
    "[ 10] agent-circus: assignment hero=0000000000011000 slot=3 observed=1",
  ];
  const state = lines.reduce((current, line) => {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    return reduceCombatState(current, event!);
  }, initialCombatState());

  assert.equal(state.phase, "circus");
  assert.equal(state.circus?.complete, true);
  assert.equal(state.circus?.contestants[0]?.heroAddress, "0000000000011000");
  assert.equal(state.circus?.contestants[0]?.inLineup, true);
  assert.deepEqual(state.circus?.slots[3], {
    slot: 3,
    rank: 1,
    heroAddress: "0000000000011000",
    name: "朗克托",
    heroClass: "强盗",
  });
});

test("builds a Butcher's Circus actor-selection snapshot and settles activation", () => {
  const lines = [
    "[ 1] agent-state: begin",
    "[ 2] agent-circus-combat: begin pick_open=1 battle_state=0x1c party=4",
    '[ 3] agent-circus-combat: hero index=0 actor_guid=101 address=0000000000011000 can_activate=1 active=0 name="朗克托, 强盗"',
    '[ 4] agent-circus-combat: hero index=1 actor_guid=102 address=0000000000012000 can_activate=0 active=0 name="麦克雷, 野蛮人"',
    "[ 5] agent-circus-combat: end",
    '[ 6] agent-state: actor side=party idx=0 slot=1-1 address=0000000000011000 guid=5001 active=0 name="朗克托, 强盗" health="20/23 生命：" stress="10/200 压力：" conditions="" runtime_guid=101',
    '[ 7] agent-state: actor side=enemy idx=0 slot=1-1 address=0000000000021000 active=0 name="敌方十字军" health="33/33 生命：" stress="35/200 压力：" conditions="" runtime_guid=201',
    "[ 8] agent-state: end",
    "[ 9] agent-circus-combat: activation actor_guid=101 hero=0000000000011000 observed=1",
  ];
  const state = lines.reduce((current, line) => {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    return reduceCombatState(current, event!);
  }, initialCombatState());

  assert.equal(state.phase, "combat");
  assert.equal(state.combatActive, true);
  assert.equal(state.circusCombat?.complete, true);
  assert.equal(state.circusCombat?.pickOpen, false);
  assert.equal(state.circusCombat?.heroes[0]?.actorGuid, 101);
  assert.equal(state.circusCombat?.heroes[0]?.active, true);
  assert.equal(state.combatants.find((actor) => actor.side === "enemy")?.stress, 35);
});

test("keeps results modal while a tutorial is open and records detailed result rows", () => {
  const lines = [
    "[ 1] axcontext -> results",
    '[ 2] tutorialpopup id=resolve_level text="Resolve level increased."',
    "[ 3] axcontext -> tutorial",
    "[ 4] agent-state: results state=2 rows=0 heroes=1",
    "[ 5] agent-state: results_hero hero=0 rows=3",
    '[ 6] agent-state: results_hero_row hero=0 row=0 text="Reynauld, Veteran Crusader"',
    '[ 7] agent-state: results_hero_row hero=0 row=1 text="+2 resolve XP"',
    '[ 8] agent-state: results_hero_row hero=0 row=2 text="Ruins Explorer"',
  ];
  let state = initialCombatState();
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }
  assert.equal(state.phase, "modal");
  assert.equal(state.results?.heroes[0]?.rows[2]?.text, "Ruins Explorer");

  const closed = parseBlindestLine('[ 9] tutorial closed -> handing focus back to "results"');
  assert.notEqual(closed, undefined);
  state = reduceCombatState(state, closed!);
  assert.equal(state.phase, "results");
  assert.equal(state.activeTutorial, undefined);
});

test("a new game load clears overlays and raid state reconstructed from an older process", () => {
  const lines = [
    '[ 1] loot: window opened, 1 items, token="curio" type=0 [input stack 3]',
    "[ 2] agent-state: begin",
    '[ 3] agent-state: inventory slot=2 amount=2 type="provision" item_id="antivenom" key="inv_antivenom" name="解毒剂"',
    "[ 4] agent-state: loot begin count=1",
    '[ 5] agent-state: loot item=0 pool_slot=3 amount=2 type="heirloom" item_id="deed" key="loot_deed" name="契约"',
    "[ 6] agent-state: loot end",
    "[ 7] agent-state: end",
    "[ 8] axcontext -> title",
    "[ 9] axcontext -> loading",
    "[ 10] axcontext -> room",
  ];
  let state = initialCombatState();
  state.currentBuilding = "tavern";
  state.townLocations = [{
    row: 0,
    id: "stale_town",
    elementId: "stale",
    unlocked: true,
    screen: true,
    district: false,
    offSave: false,
    isNew: false,
    name: "Stale town location",
  }];
  state.expedition = {
    questCount: 99,
    locationCount: 9,
    cursorColumn: 0,
    cursorRow: 0,
    locations: [],
    quests: [],
  };
  state.provisioning = { items: [], gold: 100_840, bagTotal: 40 };
  for (const line of lines) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }

  assert.equal(state.phase, "room");
  assert.equal(state.loot, undefined);
  assert.equal(state.eventOverlay, undefined);
  assert.deepEqual(state.inventory, []);
  assert.equal(state.inventoryInfo, undefined);
  assert.equal(state.dungeonMap, undefined);
  assert.equal(state.combatActive, false);
  assert.equal(state.currentBuilding, undefined);
  assert.deepEqual(state.townLocations, []);
  assert.equal(state.expedition, undefined);
  assert.equal(state.provisioning, undefined);
});

test("a routine none context preserves the discovered town location roster", () => {
  let state = initialCombatState();
  for (const line of [
    '[ 1] townmap rows: [0] id="guild" elem=0x31e1ea6d unlocked=1 screen=1 district=0 offsave=0 new=0 name="公会"',
    "[ 2] townmap: active, layer 0, 1 locations, row 0",
    "[ 3] axcontext -> none",
    "[ 4] townmap: active, layer 0, 1 locations, row 0",
    "[ 5] axcontext -> townmap",
  ]) {
    const event = parseBlindestLine(line);
    assert.notEqual(event, undefined, line);
    state = reduceCombatState(state, event!);
  }

  assert.equal(state.phase, "town");
  assert.equal(state.currentContext, "townmap");
  assert.deepEqual(state.townLocations.map((location) => location.id), ["guild"]);
});

test("normalizes ratio trap chances to percentage points", () => {
  const event = parseBlindestLine(
    "[ 99] agent-state: trap_chance address=00AA hero_index=0 chance=0.9",
  );
  assert.notEqual(event, undefined);
  assert.equal(event?.kind, "trap_chance_observed");
  if (event?.kind === "trap_chance_observed") {
    assert.equal(event.chance, 90);
  }
});

test("parses structured trap outcomes and kleptomaniac loot withholding", () => {
  const consolidation = parseBlindestLine(
    "[ 109] agent-event: inventory_consolidated merges=2 freed=1 accepted=1",
  );
  assert.equal(consolidation?.kind, "inventory_consolidated");
  if (consolidation?.kind === "inventory_consolidated") {
    assert.equal(consolidation.merges, 2);
    assert.equal(consolidation.freed, 1);
    assert.equal(consolidation.accepted, true);
  }

  const started = parseBlindestLine(
    "[ 110] agent-event: trap_started prop=000002A258001000 actor=000002A258AC2638 guid=17 hero_index=0 deliberate=1",
  );
  assert.deepEqual(started, {
    tick: 110,
    raw: "[ 110] agent-event: trap_started prop=000002A258001000 actor=000002A258AC2638 guid=17 hero_index=0 deliberate=1",
    kind: "trap_interaction_started",
    propAddress: "000002A258001000",
    actorAddress: "000002A258AC2638",
    heroGuid: 17,
    heroIndex: 0,
    deliberate: true,
  });

  const result = parseBlindestLine(
    "[ 111] agent-event: trap_result prop=000002A258001000 actor=000002A258AC2638 guid=17 outcome=triggered hp_delta=-5.0 stress_delta=8.0 deliberate=1",
  );
  assert.equal(result?.kind, "trap_result");
  if (result?.kind === "trap_result") {
    assert.equal(result.outcome, "triggered");
    assert.equal(result.hpDelta, -5);
    assert.equal(result.stressDelta, 8);
  }

  const theft = parseBlindestLine(
    '[ 112] agent-event: quirk_loot_withheld actor=000002A258AC2638 guid=17 quirk="kleptomaniac" text="Reynauld: 我会把这份留给自己。辛劳，难以得到回报……"',
  );
  assert.deepEqual(theft, {
    tick: 112,
    raw: '[ 112] agent-event: quirk_loot_withheld actor=000002A258AC2638 guid=17 quirk="kleptomaniac" text="Reynauld: 我会把这份留给自己。辛劳，难以得到回报……"',
    kind: "quirk_loot_withheld",
    actorAddress: "000002A258AC2638",
    heroGuid: 17,
    quirkId: "kleptomaniac",
    text: "Reynauld: 我会把这份留给自己。辛劳，难以得到回报……",
  });

  const forcedCurio = parseBlindestLine(
    '[ 113] announce: slot 1/1 actor=0000000000000000 [no turn actor] -> "柜门的锁上有机关！"',
  );
  assert.deepEqual(forcedCurio, {
    tick: 113,
    raw: '[ 113] announce: slot 1/1 actor=0000000000000000 [no turn actor] -> "柜门的锁上有机关！"',
    kind: "dungeon_announcement",
    slot: 1,
    slotCount: 1,
    actorAddress: "0000000000000000",
    text: "柜门的锁上有机关！",
  });
});
