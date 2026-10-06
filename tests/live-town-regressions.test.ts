import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CopilotEngine } from '../src/copilot/engine.js';
import { LocalGameGateway } from '../src/copilot/local-game-gateway.js';
import { passiveRevisionAdvance } from '../src/copilot/revision-guard.js';
import { CombatLogSource, type BlindestLogRecord } from '../src/live/combat-log-source.js';
import { FakeCommandTransport } from './helpers/fake-command-transport.js';
import { initialGameState } from '../src/state/game-state.js';
import { buildingDetailsView } from '../src/copilot/town-availability.js';
import { preparationAdvisories } from '../src/copilot/preparation-advisories.js';

test('passive revision guard rejects gaps, truncation, future cursors and unknown or parsed events', () => {
  const record: BlindestLogRecord = { revision: 2, observedAt: '', raw: '', message: 'townbark: hello' };
  assert.equal(passiveRevisionAdvance(1, 2, () => [record]), true);
  assert.equal(passiveRevisionAdvance(1, 3, () => [record]), false);
  assert.equal(passiveRevisionAdvance(1, 2, () => [{ ...record, revision: 3 }]), false);
  assert.equal(passiveRevisionAdvance(1, 2, () => [{ ...record, message: 'unrecognized input change' }]), false);
  assert.equal(passiveRevisionAdvance(1, 2, () => [{ ...record, event: {
    kind: 'context_changed', context: 'townmap', tick: 1, raw: '',
  } }]), false);
  assert.equal(passiveRevisionAdvance(1, 2_002, () => [record]), false);
  assert.equal(passiveRevisionAdvance(3, 2, () => [record]), false);
});

test('locked activity slots cannot advertise eligibility, while diagnostic state stays intact', () => {
  const state = initialGameState();
  const row = { row: 0, activityId: 'prayer', activityOrder: 0, slot: 1, slotCount: 1,
    elementId: '0x1', pendingHeroName: '', occupant: -1, locked: true, eventLocked: false, costsMoney: true };
  const candidate = { activityId: 'prayer', slot: 1, heroGuid: 1, name: 'Hero', known: true,
    eligible: true, affordable: true, priceKnown: true, price: 0, currency: 'gold', reason: '' };
  state.buildingDetails = { buildingId: 'abbey', mode: 0, complete: true, activities: [row],
    activityCandidates: [candidate], heroes: [], heroOptions: [], upgrades: [], shopItems: [], memorials: [] };
  assert.deepEqual(buildingDetailsView(state)?.activityCandidates, []);
  assert.equal(state.buildingDetails.activityCandidates?.length, 1);
  state.buildingDetails.activities[0] = { ...row, locked: false };
  assert.deepEqual(buildingDetailsView(state)?.activityCandidates, [candidate]);
  state.buildingDetails.activities[0] = { ...row, locked: false, eventLocked: true };
  assert.deepEqual(buildingDetailsView(state)?.activityCandidates, []);
});

test('suspicious town health is marked unverified without rewriting the raw reading', () => {
  const state = initialGameState();
  state.phase = 'embark';
  state.partyPlanning = { slots: [], rosterCandidates: [{ row: 0, heroGuid: 11, name: '莫干斯',
    state: 0, building: '', missing: false, healthText: '1/22 生命：' }] };
  const warning = preparationAdvisories(state).find(item => item.kind === 'verify_town_health');
  assert.deepEqual(warning?.heroes, [{ heroGuid: 11, name: '莫干斯', rawHealthText: '1/22 生命：' }]);
  assert.equal(state.partyPlanning.rosterCandidates[0]?.healthText, '1/22 生命：');
  state.phase = 'room';
  assert.deepEqual(preparationAdvisories(state), []);
});

test('a town action crosses passive noise once, but rejects a new context before input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-passive-town-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'game.log');
  await writeFile(path, '[ 1] axcontext -> townmap\n');
  const transport = new FakeCommandTransport(async () => {
    await appendFile(path, '[ 5] axcontext -> embark\n');
  });
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport));
  const before = await engine.getState();
  await appendFile(path, '[ 2] townbark: assigned\n[ 3] ctrlprobe: cursor fight diagnostic\n[ 4] speech->prism kind=nav ok=1\n');
  const result = await engine.act({ requestId: 'passive-1', expectedRevision: before.revision,
    action: { kind: 'open_embark' } });
  assert.equal(result.outcome, 'success');
  assert.equal(result.sourceRevision, before.revision + 3);
  assert.equal(transport.sendCount, 1);
  const duplicate = await engine.act({ requestId: 'passive-1', expectedRevision: before.revision,
    action: { kind: 'open_embark' } });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(transport.sendCount, 1);
  const latest = await engine.getState();
  const sendsBeforeStale = transport.sendCount;
  await appendFile(path, '[ 6] axcontext -> charsheet\n');
  const stale = await engine.act({ requestId: 'passive-2', expectedRevision: latest.revision,
    action: { kind: 'return_to_town' } });
  assert.equal(stale.outcome, 'failure');
  assert.match(stale.reason, /Stale action/);
  assert.equal(transport.sendCount, sendsBeforeStale);
});

for (const panel of ['charsheet', 'realminv']) {
  test(`${panel} blocks background embark observations and closes only with observed evidence`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'dd1-panel-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'game.log');
    await writeFile(path, `[ 1] axcontext -> embark\n[ 2] axcontext -> ${panel}\n[ 3] embark: active, 1 quests in 1 locations, cursor 0/0\n`);
    const transport = new FakeCommandTransport(async () => {
      await appendFile(path, '[ 4] axcontext -> embark\n');
    });
    const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport));
    const before = await engine.getState();
    assert.equal(before.phase, 'modal');
    assert.equal(before.decision.kind, 'modal');
    assert.deepEqual(before.decision.options, [{ kind: 'dismiss_modal' }]);
    assert.equal(engine.observedSnapshot?.state.modalSourcePhase, 'embark');
    const blocked = await engine.act({ requestId: 'blocked', expectedRevision: before.revision,
      action: { kind: 'return_to_town' } });
    assert.equal(blocked.outcome, 'failure');
    assert.equal(transport.sendCount, 0);
    const closed = await engine.act({ requestId: 'close', expectedRevision: before.revision,
      action: { kind: 'dismiss_modal' } });
    assert.equal(closed.outcome, 'success');
    assert.equal((await engine.getState()).phase, 'embark');
  });
}

test('quest text is emitted once in delta decision and changed descriptions stay available', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-quest-text-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'game.log');
  const header = '[ 1] axcontext -> embark\n[ 2] embark: active, 1 quests in 1 locations, cursor 0/0\n[ 3] embark probe: row 0 qIdx=0 id="quest" dungeon="crypts" len=1 diff=1 elem(0x01)=onscreen\n';
  await writeFile(path, header + '[ 4] agent-prep: quest_detail qidx=0 line=0 text="旧任务说明"\n');
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), new FakeCommandTransport(async () => {})));
  const before = await engine.getState();
  await appendFile(path, '[ 5] agent-prep: quest_detail qidx=0 line=0 text="更新后的任务说明"\n');
  const delta = await engine.getState('delta', before.revision);
  assert.equal(delta.changes.some(record => record.event?.kind === 'embark_quest_detail_observed'), false);
  const option = delta.decision.options.find(option => option.kind === 'select_embark_quest');
  assert.deepEqual(option.details, ['更新后的任务说明']);
  const full = await engine.getState('full', before.revision);
  assert.equal(full.records.some(record => record.event?.kind === 'embark_quest_detail_observed'), true);
});
