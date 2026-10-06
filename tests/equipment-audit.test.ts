import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialGameState, reduceGameState } from '../src/state/game-state.js';
import { parseBlindestLine } from '../src/blindest/parse-line.js';
import { equipmentFailure } from '../src/copilot/equipment.js';
import { CopilotEngine } from '../src/copilot/engine.js';
import { LocalGameGateway } from '../src/copilot/local-game-gateway.js';
import { CombatLogSource } from '../src/live/combat-log-source.js';
import { FakeCommandTransport } from './helpers/fake-command-transport.js';
import { townHeroView } from '../src/copilot/town-health.js';
import { mergeHeroProfile } from '../src/copilot/memory/merge-profile.js';
import { collectHeroProfiles } from '../src/copilot/memory/profile-observation.js';
import { ObservationCache } from '../src/copilot/observation-cache.js';
import { projectState } from '../src/copilot/state-view.js';

const roster = (item = '', heroGuid = 11) => [
  'agent-prep: party_begin',
  `roster probe: row 0 entry=00010010 "Hero" state=0 building="" missing=0 hero_guid=${heroGuid}`,
  `agent-prep: roster_profile guid=${heroGuid} name="Hero" class="plague_doctor" level=1 health="1/22" stress="27" weapon=0 armour=0`,
  `agent-prep: trinket guid=${heroGuid} slot=0 status=${item ? 'equipped' : 'empty'} id="${item}" name="Stone" effects="Speed"`,
  `agent-prep: trinket guid=${heroGuid} slot=1 status=empty id="" name="" effects=""`,
  'agent-prep: party_end slots=4 filled=0',
];
const stock = (items = [0]) => [
  'agent-equipment: begin native_control=1',
  ...items.map(slot => `agent-equipment: item slot=${slot} amount=1 id="stone" name="Stone" effects="Speed" class=""`),
  `agent-equipment: end items=${items.length}`,
];
function lines(messages: string[]) { return messages.map((message, i) => `[ ${i + 1}] ${message}`).join('\n') + '\n'; }
function state(messages = [...roster(), ...stock()]) {
  let s = initialGameState();
  for (const line of lines(['axcontext -> embark', ...messages]).trim().split('\n')) {
    const event = parseBlindestLine(line); if (event) s = reduceGameState(s, event);
  }
  return s;
}
const equip = { kind: 'equip_trinket' as const, heroGuid: 11, slot: 0 as const, itemId: 'stone' };

test('equipment enumeration clears removed stock and requires a complete snapshot', () => {
  const s = state([...roster(), ...stock([0, 1]), ...stock([2])]);
  assert.deepEqual(s.equipment?.items.map(item => item.inventorySlot), [2]);
  assert.equal(equipmentFailure(s, equip), undefined);
  assert.equal(equipmentFailure(state([...roster(), ...stock().slice(0, -1)]), equip)?.includes('complete'), true);
  assert.equal(state([...roster(), ...stock(), 'agent-equipment: unavailable reason=bad vector']).equipment, undefined);
});
test('equipment ID guards reject duplicates, unknown slots and implicit replacement', () => {
  assert.match(equipmentFailure(state([...roster(), ...stock([0, 1])]), equip)!, /ambiguous/);
  assert.equal(equipmentFailure(state([...roster(), ...stock([0, 1])]), { ...equip, inventorySlot: 1 }), undefined);
  assert.match(equipmentFailure(state([...roster('other'), ...stock()]), equip)!, /replacement/);
  const unknown = state(); unknown.partyPlanning!.rosterCandidates[0]!.trinkets![0]!.status = 'unknown';
  assert.match(equipmentFailure(unknown, equip)!, /verified/);
  assert.match(equipmentFailure(state(), { ...equip, heroGuid: 99 })!, /hero/);
  assert.match(equipmentFailure(state([...roster('stone'), ...stock()]), { kind: 'unequip_trinket', heroGuid: 11, slot: 0, itemId: 'other' })!, /match/);
});

for (const scenario of ['success', 'wrong_hero', 'stock_not_consumed', 'unrelated_command', 'native_unknown', 'missing_hero_snapshot', 'unequip'] as const) {
  test(`equipment workflow verifies both inventories and command identity: ${scenario}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dd1-equipment-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'game.log');
    await writeFile(path, lines(['axcontext -> embark', ...roster(scenario === 'unequip' ? 'stone' : ''), ...stock(scenario === 'unequip' ? [] : [0])]));
    const transport = new FakeCommandTransport(async command => {
      assert.equal(command.kind, scenario === 'unequip' ? 'unequip_trinket' : 'equip_trinket');
      const id = scenario === 'unrelated_command' ? 'wrong-id' : 'fake-1';
      await appendFile(path, lines([
        `agent-command: begin id=${id}`,
        ...(scenario === 'native_unknown' ? ['agent-equipment: outcome_unknown reason=refresh failed'] : [
          ...(scenario === 'missing_hero_snapshot' ? [] : roster(scenario === 'unequip' ? '' : 'stone', scenario === 'wrong_hero' ? 99 : 11)),
          ...stock(scenario === 'unequip' || scenario === 'stock_not_consumed' ? [0] : []),
        ]),
        `agent-command: end id=${id} accepted=1`,
      ]));
    });
    const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 });
    t.after(() => engine.close());
    const before = await engine.getState();
    const action = scenario === 'unequip' ? { kind: 'unequip_trinket' as const, heroGuid: 11, slot: 0 as const, itemId: 'stone' } : equip;
    const request = { requestId: 'equipment-1', expectedRevision: before.revision, action };
    const result = await engine.act(request);
    assert.equal(result.outcome, scenario === 'success' || scenario === 'unequip' ? 'success' : 'uncertain');
    const duplicate = await engine.act(request);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(transport.sendCount, 1);
  });
}
test('town HP is provenance-tagged in presentation, raid HP is retained as history', () => {
  const view = townHeroView({ heroGuid: 11, healthText: '1/22' });
  assert.deepEqual(view.health, { source: 'town_actor', currentHpVerified: false, maxHp: 22 });
  assert.equal('healthText' in view, false);
  assert.equal('currentHp' in view.health, false);
  assert.equal(townHeroView({ healthText: 'unreadable' }).health.maxHp, undefined);
  const p = mergeHeroProfile({ currentHp: 3, maxHp: 22, healthText: '1/22' }, { townHealth: view.health }, 'Hero');
  assert.equal('currentHp' in p, false); assert.equal('healthText' in p, false);
  assert.deepEqual(p.lastRaidHealth, { currentHp: 3, maxHp: 22, source: 'prior_expedition_observation' });
});
test('compact town state includes the GUIDs and equipped slots needed for native actions', () => {
  const s = state(); s.phase = 'town';
  const view = projectState({ state: s, revision: 1, observedAt: 'now', source: {} } as never, 'compact', 0, () => []);
  assert.ok('partyPlanning' in view);
  assert.equal(view.partyPlanning?.rosterCandidates[0]?.heroGuid, 11);
  assert.equal(view.partyPlanning?.rosterCandidates[0]?.trinkets?.[0]?.status, 'empty');
  assert.equal(view.partyPlanning?.rosterCandidates[0]?.health.currentHpVerified, false);
});
test('cached focused hero cannot overwrite a different building hero GUID', () => {
  const s = state(); s.phase = 'building';
  s.buildingDetails = { buildingId: 'guild', mode: 0, complete: true, heroes: [], heroOptions: [], activities: [], upgrades: [], shopItems: [], memorials: [], selectedHeroGuid: 11 };
  s.focusedHero = { name: 'Dismas', heroClass: 'highwayman', heroAddress: '20000', classAddress: '30000' };
  assert.equal(collectHeroProfiles(s).some(hero => hero.profile.heroClass === 'highwayman'), false);
  s.focusedHero = { ...s.focusedHero, name: 'Hero', heroClass: 'plague_doctor', heroAddress: '10018' };
  assert.equal(collectHeroProfiles(s).filter(hero => hero.profile.training).length, 0);
  s.buildingDetails.heroOptions.push({ optionId: 'skill', name: 'Skill', column: 0, steps: '', stepDetails: [], details: [] } as never);
  assert.equal(collectHeroProfiles(s).filter(hero => hero.profile.training).length, 1);
  s.partyPlanning!.rosterCandidates[0]!.entryAddress = 'invalid';
  assert.doesNotThrow(() => collectHeroProfiles(s));
});
test('inspection cache stays bounded without weakening durable action receipts', () => {
  const cache = new ObservationCache(2); cache.add('a'); cache.add('b'); cache.add('c');
  assert.equal(cache.has('a'), false); assert.equal(cache.has('c'), true);
  cache.clear(); assert.equal(cache.has('b'), false);
});
