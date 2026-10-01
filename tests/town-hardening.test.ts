import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBlindestLine } from '../src/blindest/parse-line.js';
import { CampaignMemoryStore } from '../src/copilot/campaign-memory.js';
import { buildDecision } from '../src/copilot/decision.js';
import { CopilotEngine } from '../src/copilot/engine.js';
import { LocalGameGateway } from '../src/copilot/local-game-gateway.js';
import { CopilotSession } from '../src/copilot/session.js';
import { projectState } from '../src/copilot/state-view.js';
import { validateAction } from '../src/copilot/validate-action.js';
import { stateAdvisories } from '../src/copilot/workflow-support.js';
import { CombatLogSource } from '../src/live/combat-log-source.js';
import { initialGameState, reduceGameState, type GameState } from '../src/state/game-state.js';
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

const replay = (lines: string[], initial = initialGameState()) => lines.reduce((state, line, tick) => {
  const event = parseBlindestLine(`[ ${tick + 1}] ${line}`);
  assert.ok(event, line);
  return reduceGameState(state, event);
}, initial);
const begin = (id: string) => [`building: active, "${id}" mode=0`, 'axcontext -> building', `agent-town: building_begin id="${id}" mode=0`];
const activity = (guid = 0) => `bldact probe: row 0 act="prayer" (0) slot 1/3 elem=0x10(x) cancel=0x11(x) committed=${guid} pending=0000"" pending_guid=0 occupant=${guid ? 0 : -1} locked=0 evtlocked=0 costsmoney=1`;

test('preparation reminder identifies current party by GUID, distinguishes empty and unknown, and expires at town', () => {
  let state = replay([
    'axcontext -> embark', 'agent-prep: party_begin',
    'party probe: slot 3 = position 1 iface=0001 hero=0002 entry=0003 "Same" barred=0 elem=0x123 live hero_guid=1',
    'party probe: slot 2 = position 2 iface=0004 hero=0005 entry=0006 "Same" barred=0 elem=0x124 live hero_guid=2',
    'roster probe: row 0 entry=0003 "Same" state=1 building="" missing=0 hero_guid=1',
    'roster probe: row 1 entry=0006 "Same" state=1 building="" missing=0 hero_guid=2',
    'agent-prep: trinket guid=1 slot=0 status=equipped id="crest" name="饰章" effects="眩晕+20%"',
    'agent-prep: trinket guid=1 slot=1 status=empty id="" name="" effects=""',
    'agent-prep: trinket guid=2 slot=0 status=unknown id="" name="" effects=""',
    'agent-prep: party_end slots=4 filled=2',
  ]);
  const reminder = stateAdvisories(state)[0]!;
  const party = reminder.party as Array<{ heroGuid: number; trinkets: Array<{status: string; name?: string}> }>;
  assert.deepEqual(party.map((hero) => hero.heroGuid), [1, 2]);
  assert.equal(party[0]!.trinkets[0]!.name, '饰章');
  assert.deepEqual(party.map((hero) => hero.trinkets.map((item) => item.status)), [['equipped', 'empty'], ['unknown', 'unknown']]);
  state = replay(['axcontext -> provision'], state);
  assert.equal(stateAdvisories(state)[0]?.kind, 'prepare_trinkets');
  state = replay(['agent-prep: party_begin'], state);
  assert.equal(state.partyPlanning?.rosterCandidates.length, 0, 'fresh snapshot must discard prior equipment');
  state = replay(['axcontext -> townmap'], state);
  state.light = { kind: 'torch', value: 0, level: 0, text: 'cached expedition light' };
  assert.deepEqual(stateAdvisories(state), []);
});

test('town options and validation reject unaffordable goods and cached activity eligibility', () => {
  const state = replay([...begin('nomad_wagon'),
    'agent-town: wallet gold=18780 bust=0 portrait=0 deed=0 crest=0 shard=20',
    'bldrows probe: row 0 slot 0 id="garlic" name="大蒜" price=25000 elem=0x10',
    'bldrows probe: row 1 slot 1 id="crest" name="饰章" price=1000 elem=0x11',
    'agent-town: shop_currency id="gold"', 'agent-town: capabilities upgrades=0',
    activity(),
    'agent-town: activity_kind id="prayer" slot=1 treatment=0',
    'agent-town: activity_candidate id="prayer" slot=1 guid=2 name="Dismas" known=1 eligible=1 affordable=1 price_known=1 price=1250 currency="gold" reason=""',
    'agent-town: activity_candidate id="prayer" slot=1 guid=1 name="Reynauld" known=1 eligible=0 affordable=1 price_known=1 price=1250 currency="gold" reason="怪癖限制"',
    'agent-town: building_end id="nomad_wagon"',
  ]);
  state.partyPlanning = { slotCount: 4, filledCount: 0, slots: [], rosterCandidates: [
    { row: 0, heroGuid: 1, entryAddress: '1', name: 'Reynauld', state: 0, missing: false, building: '' },
    { row: 1, heroGuid: 3, entryAddress: '3', name: 'Cached', state: 0, missing: false, building: '' },
  ] };
  const options = buildDecision(state).options as Array<Record<string, unknown>>;
  assert.deepEqual(options.filter((o) => o.kind === 'buy_town_item').map((o) => o.itemId), ['crest']);
  assert.deepEqual(options.filter((o) => o.kind === 'assign_town_activity').map((o) => o.heroGuid), [2]);
  assert.match(validateAction({ kind: 'buy_town_item', itemId: 'garlic' }, state)!, /Insufficient gold/);
  assert.match(validateAction({ kind: 'assign_town_activity', activityId: 'prayer', slot: 1, heroGuid: 1 }, state)!, /怪癖限制/);
  assert.ok(validateAction({ kind: 'assign_town_activity', activityId: 'prayer', slot: 1, heroGuid: 3 }, state));
  assert.ok(validateAction({ kind: 'open_building_upgrades' }, state));
  state.buildingDetails!.shopItems[0]!.currency = 'shard';
  state.buildingDetails!.shopItems[0]!.price = 10;
  assert.equal(validateAction({ kind: 'buy_town_item', itemId: 'garlic' }, state), undefined, 'shard purchases use shard balance');
});

test('live lock reasons and all upgrade currencies enter the decision', () => {
  const state = replay([...begin('blacksmith'),
    'agent-town: wallet gold=1000 bust=0 portrait=0 deed=0 crest=0 shard=0',
    'heroaction probe: "blacksmith" skin=0 facility=0001 selected guid=8 heroes=1 spare=0',
    'heroaction: tree "highwayman.armour" step \'0\' purchased=0 armed=0 cost=750 gold resolve=2 elem=0x10 live=1',
    'heroaction: column 1 "highwayman.armour" hash=0x1 kind=2 idx=-1 level=0 selected=0 steps=1 bought=0 next=0 name="护甲"',
    'agent-town: cost owner=hero id="highwayman.armour" code=0 currency="gold" amount=750',
    'agent-town: hero_step option="highwayman.armour" code=0 available=0 cost_known=1 reason="需要决心等级2"',
    'agent-town: hero_effect option="highwayman.armour" column=1 line=0 text="生命+5"',
    'agent-town: capabilities upgrades=1', 'agent-town: building_end id="blacksmith"',
  ]);
  assert.match(validateAction({ kind: 'buy_hero_upgrade', heroGuid: 8, optionId: 'highwayman.armour', stepCode: '0' }, state)!, /需要决心/);
  assert.deepEqual(state.buildingDetails?.heroOptions[0]?.effects, [ , ['生命+5']]);
  assert.ok(!(buildDecision(state).options as Array<Record<string, unknown>>).some((o) => o.kind === 'buy_hero_upgrade'));
});

test('recruit profiles are keyed by address and full roster removes recruit actions', () => {
  const state = replay([...begin('stage_coach'),
    'bldrows probe: row 0 slot 0 hero=0001 "同名" elem=0x737467 at (671,587)',
    'bldrows probe: row 1 slot 1 hero=0002 "同名" elem=0x737468 at (671,627)',
    'agent-town: roster_capacity count=10 capacity=10',
    'agent-town: recruit_profile hero=0001 class="修女" level=0 health="24/24" stress="0"',
    'agent-town: recruit_profile hero=0002 class="强盗" level=1 health="20/23" stress="5"',
    'agent-town: recruit_detail hero=0002 category=quirk line=0 text="盗窃癖"',
    'agent-town: capabilities upgrades=1', 'agent-town: building_end id="stage_coach"',
  ]);
  assert.equal(state.buildingHeroes[0]?.heroClass, '修女');
  assert.deepEqual(state.buildingHeroes[1]?.quirks, ['盗窃癖']);
  const decision = buildDecision(state);
  assert.ok(!(decision.options as Array<Record<string, unknown>>).some((o) => o.kind === 'recruit_stage_coach_hero'));
  assert.ok((decision.options as Array<Record<string, unknown>>).some((o) => o.kind === 'open_building_upgrades'));
});

test('cancel activity returns the confirmation and does not report cancellation or repeat input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-town-confirm-'));
  const path = join(directory, 'log');
  await writeFile(path, [...begin('abbey'), activity(1), 'agent-town: building_end id="abbey"'].map((line, i) => `[ ${i + 1}] ${line}`).join('\n') + '\n');
  let cancelled = false;
  const transport = new FakeCommandTransport(async (command) => {
    if (command.kind === 'cancel_town_activity') await appendFile(path,
      '[ 20] agent-ipc: serviced cancel_town_activity activity="prayer" slot=1 accepted=1\n[ 21] axcontext -> dialog\n[ 22] confirmpopup dev=ctrl alt=0 entry=0x123 count=2 got=2 btn0=-1 btn1=-1 text="费用不返还。 A, 是. B, 否."\n');
    else if (command.kind === 'activate_element') {
      assert.equal(command.args.elementId, '0x636e6661'); cancelled = true;
      await appendFile(path, '[ 25] agent-ipc: serviced activate element=0x636e6661 accepted=1\n[ 26] axcontext -> building\n');
    } else {
      assert.equal(command.kind, 'inspect_state');
      await appendFile(path, '[ 27] agent-state: begin\n' + (cancelled
        ? `[ 28] agent-town: building_begin id="abbey" mode=0\n[ 29] ${activity()}\n[ 30] agent-town: building_end id="abbey"\n` : '') + '[ 31] agent-state: end\n');
    }
  });
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport), { pollIntervalMilliseconds: 1, inspectionTimeoutMilliseconds: 50 });
  const session = new CopilotSession(engine, new CampaignMemoryStore({ path: join(directory, 'memory.sqlite'), campaignId: 'test' }));
  t.after(async () => { session.close(); await rm(directory, { recursive: true, force: true }); });
  const before = await session.getState();
  const request = { requestId: 'cancel-prayer', expectedRevision: before.revision, action: { kind: 'cancel_town_activity' as const, activityId: 'prayer', slot: 1 } };
  const result = await session.execute(request);
  assert.equal(result.action.outcome, 'success', result.action.reason);
  assert.equal(result.action.awaitingConfirmation, true);
  assert.equal(result.action.stage, 'workflow');
  assert.match(result.action.reason, /remains committed/);
  assert.equal(result.nextState?.activeDialog?.text, '费用不返还。 A, 是. B, 否.');
  assert.equal(result.nextState?.buildingDetails?.activities[0]?.committedHeroGuid, 1);
  assert.equal((await session.execute(request)).action.deduplicated, true);
  assert.equal(transport.sendCount, 2);
  const answered = await session.execute({ requestId: 'confirm-cancel', expectedRevision: result.action.finalRevision,
    action: { kind: 'choose_dialog_option', optionIndex: 0 } });
  assert.equal(answered.action.outcome, 'success', answered.action.reason);
  assert.equal(answered.nextState?.buildingDetails?.activities[0]?.committedHeroGuid, undefined);
  assert.equal(answered.nextState?.activeDialog, undefined);
  assert.equal(transport.sendCount, 4);
});

test('a native rejection returns its own reason and ignores later commands', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-native-reject-'));
  const path = join(directory, 'log');
  const initial = [...begin('nomad_wagon'),
    'agent-town: wallet gold=2000 bust=0 portrait=0 deed=0 crest=0 shard=0',
    'bldrows probe: row 0 slot 0 id="crest" name="饰章" price=1000 elem=0x10',
    'agent-town: shop_currency id="gold"', 'agent-town: building_end id="nomad_wagon"',
  ];
  await writeFile(path, initial.map((line, i) => `[ ${i + 1}] ${line}`).join('\n') + '\n');
  const transport = new FakeCommandTransport(async () => appendFile(path,
    '[ 20] agent-command: begin id=fake-1\n[ 21] agent-town: buy_shop_item accepted=0 reason=locked\n[ 22] agent-command: end id=fake-1 accepted=0\n[ 23] agent-command: begin id=other\n[ 24] agent-town: other accepted=0 reason=unrelated\n'));
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 50 });
  t.after(async () => { engine.close(); await rm(directory, { recursive: true, force: true }); });
  const before = await engine.getState();
  const result = await engine.act({ requestId: 'locked', expectedRevision: before.revision, action: { kind: 'buy_town_item', itemId: 'crest' } });
  assert.equal(result.outcome, 'failure');
  assert.match(result.reason, /locked/);
  assert.doesNotMatch(result.reason, /unrelated/);
  assert.equal(transport.sendCount, 1);
});

test('treatment preparation, ID choice and commitment are separate verified native operations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-treatment-'));
  const path = join(directory, 'log');
  let pending = false, chosen = false, committed = false, tick = 0;
  const lines = () => [
    'agent-state: begin', 'agent-town: building_begin id="sanitarium" mode=0',
    'agent-town: wallet gold=2000 bust=0 portrait=0 deed=0 crest=0 shard=0',
    `bldact probe: row 0 act="quirks" (0) slot 1/3 elem=0x10(x) cancel=0x11(x) committed=${committed ? 8 : 0} pending=000C"Dismas" pending_guid=${pending ? 8 : 0} occupant=${committed ? 0 : -1} locked=0 evtlocked=0 costsmoney=1`,
    'agent-town: activity_kind id="quirks" slot=1 treatment=1',
    ...(pending ? [`agent-town: treatment id="quirks" slot=1 quirk="kleptomaniac" mode=2 name="盗窃癖" chosen=${chosen ? 1 : 0} price_known=1 price=1000 currency="gold"`] : []),
    ...(!pending && !committed ? ['agent-town: activity_candidate id="quirks" slot=1 guid=8 name="Dismas" known=1 eligible=1 affordable=1 price_known=1 price=1000 currency="gold" reason=""'] : []),
    'agent-town: building_end id="sanitarium"', 'agent-state: end',
  ];
  const format = (lines: string[]) => lines.map((line) => `[ ${++tick}] ${line}`).join('\n') + '\n';
  await writeFile(path, format(['building: active, "sanitarium" mode=0', 'axcontext -> building', ...lines()]));
  const transport = new FakeCommandTransport(async (command) => {
    if (command.kind === 'inspect_state') { await appendFile(path, format(lines())); return; }
    if (command.kind === 'prepare_town_treatment') { assert.equal(command.args.heroGuid, 8); pending = true; }
    else if (command.kind === 'choose_town_treatment') { assert.equal(command.args.quirkId, 'kleptomaniac'); assert.equal(command.args.heroGuid, 8); chosen = true; }
    else { assert.equal(command.kind, 'confirm_town_treatment'); assert.equal(command.args.heroGuid, 8); pending = false; committed = true; }
    await appendFile(path, format([`agent-ipc: serviced ${command.kind} activity="quirks" slot=1 accepted=1`]));
  });
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 50, inspectionTimeoutMilliseconds: 50 });
  t.after(async () => { engine.close(); await rm(directory, { recursive: true, force: true }); });
  const execute = async (action: Parameters<CopilotEngine['act']>[0]['action']) => {
    const before = await engine.getState();
    const result = await engine.act({ requestId: action.kind, expectedRevision: before.revision, action });
    assert.equal(result.outcome, 'success', result.reason);
  };
  await execute({ kind: 'prepare_town_treatment', activityId: 'quirks', slot: 1, heroGuid: 8 });
  assert.equal((await engine.getState()).buildingDetails?.activities[0]?.committedHeroGuid, undefined);
  await execute({ kind: 'choose_town_treatment', activityId: 'quirks', slot: 1, heroGuid: 8, quirkId: 'kleptomaniac', mode: 2 });
  assert.equal(validateAction({ kind: 'confirm_town_treatment', activityId: 'quirks', slot: 1, heroGuid: 7 }, (await engine.getState('full')).state!), 'This hero is not pending in the specified treatment slot.');
  await execute({ kind: 'confirm_town_treatment', activityId: 'quirks', slot: 1, heroGuid: 8 });
  assert.deepEqual(transport.commands.map((command) => command.kind), ['prepare_town_treatment', 'inspect_state', 'choose_town_treatment', 'inspect_state', 'confirm_town_treatment', 'inspect_state']);
});

test('a town dialog omits a cached expedition but a preparation dialog preserves it', () => {
  let state = replay(['axcontext -> embark', 'embark: active, 0 quests in 0 locations, cursor 0/0', ...begin('abbey'), 'axcontext -> dialog']);
  const project = (state: GameState) => projectState({ state, revision: 1, observedAt: '', source: { available: true } } as Parameters<typeof projectState>[0], 'compact', 0, () => []);
  assert.equal(project(state).expedition, undefined);
  state = replay(['axcontext -> embark', 'axcontext -> dialog'], state);
  assert.ok(project(state).expedition);
});

test('facility purchases check all live material costs and retain effect text', () => {
  const state = replay([
    'building: active, "blacksmith" mode=1', 'axcontext -> building',
    'agent-town: building_begin id="blacksmith" mode=1',
    'agent-town: wallet gold=1000 bust=0 portrait=0 deed=8 crest=3 shard=0',
    'bldup rows: track 0 hash=0x1 id="blacksmith.armour" def=yes steps=1 armed=0 bought=0 next=0 "护甲"',
    'agent-town: cost owner=facility id="blacksmith.armour" code=a currency="deed" amount=8',
    'agent-town: cost owner=facility id="blacksmith.armour" code=a currency="crest" amount=4',
    'agent-town: facility track=0 available=1 cost_known=1 source=registry text="解锁2级护甲"',
    'agent-town: building_end id="blacksmith"',
  ]);
  assert.match(validateAction({ kind: 'buy_building_upgrade', trackId: 'blacksmith.armour', stepCode: 'a' }, state)!, /Insufficient crest/);
  assert.ok(!(buildDecision(state).options as Array<Record<string, unknown>>).some((o) => o.kind === 'buy_building_upgrade'));
  state.townWallet!.crest = 4;
  assert.equal(validateAction({ kind: 'buy_building_upgrade', trackId: 'blacksmith.armour', stepCode: 'a' }, state), undefined);
  assert.equal(state.buildingDetails?.upgrades[0]?.description, '解锁2级护甲');
});

test('return from provision waits for embark before issuing the second Escape', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-return-town-'));
  const path = join(directory, 'log');
  await writeFile(path, '[ 1] axcontext -> provision\n');
  const transport = new FakeCommandTransport(async (command) => {
    assert.deepEqual(command, { kind: 'key_press', args: { sym: 27, mod: 0 } });
    await appendFile(path, transport.sendCount === 1 ? '[ 2] axcontext -> embark\n' : '[ 3] axcontext -> townmap\n');
  });
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport), { pollIntervalMilliseconds: 1, settlementTimeoutMilliseconds: 50 });
  t.after(async () => { engine.close(); await rm(directory, { recursive: true, force: true }); });
  const before = await engine.getState();
  const result = await engine.act({ requestId: 'return-town', expectedRevision: before.revision, action: { kind: 'return_to_town' } });
  assert.equal(result.outcome, 'success', result.reason);
  assert.deepEqual(result.steps.map((step) => step.name), ['close_provision', 'return_to_town']);
});
