import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandTransport, GameCommand } from '../src/command/transport.js';
import { CampaignMemoryStore } from '../src/copilot/campaign-memory.js';
import { CopilotEngine } from '../src/copilot/engine.js';
import { LiveRequestHandler } from '../src/copilot/live-handler.js';
import { LocalGameGateway } from '../src/copilot/local-game-gateway.js';
import { CopilotSession } from '../src/copilot/session.js';
import { CombatLogSource } from '../src/live/combat-log-source.js';
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

async function fixture(t: TestContext, initial: string, transportFactory: (path: string) => CommandTransport,
  options: ConstructorParameters<typeof CopilotEngine>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-session-'));
  const path = join(directory, 'log');
  await writeFile(path, initial);
  const transport = transportFactory(path);
  const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport), {
    inspectionTimeoutMilliseconds: 15, settlementTimeoutMilliseconds: 100,
    pollIntervalMilliseconds: 1, combatActorStabilityMilliseconds: 3, ...options,
  });
  const memory = new CampaignMemoryStore({ path: join(directory, 'memory.sqlite'), campaignId: 'test' });
  const session = new CopilotSession(engine, memory);
  t.after(async () => { session.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, transport, engine, memory, session };
}

test('fresh observation rejects unavailable input rather than returning an old snapshot', async (t) => {
  let submitted = 0;
  const { engine } = await fixture(t, '[ 1] axcontext -> pause\n[ 2] agent-state: end\n', () => ({
    async health() { return { configured: false, available: false, transport: 'unavailable' }; },
    async send() {
      submitted++;
      return { commandId: 'no', transport: 'unavailable', status: 'unavailable', receivedAt: '', reason: 'no pipe' };
    },
  }));
  await assert.rejects(engine.forceRefresh(), /Fresh observation failed.*unavailable/);
  assert.equal(submitted, 1);
});

test('a queued refresh without a completed snapshot cannot prime live actions', async (t) => {
  const { transport, session } = await fixture(t, '[ 1] axcontext -> pause\n[ 2] agent-state: end\n',
    () => new FakeCommandTransport(async () => { }));
  const handler = new LiveRequestHandler(session);
  const request = { id: 'dismiss', op: 'act_current', action: { kind: 'dismiss_modal' } };
  await assert.rejects(handler.handle(request), /no new completed inspect_state/);
  await assert.rejects(handler.handle(request), /no new completed inspect_state/);
  assert.deepEqual((transport as FakeCommandTransport).commands.map((command) => command.kind), ['inspect_state', 'inspect_state']);
});

test('shared turn handoff returns the next hero and reuses receipts without replaying input', async (t) => {
  const initial = [
    '[ 10] resting point: combat started — test', '[ 11] axcontext -> actions',
    '[ 12] heroswap: 0001 -> 0002 is the TURN — taking the action bar -> "Reynauld. 24/33 HP. 10/200 Stress."',
    '[ 13] agent-state: begin',
    '[ 14] agent-state: actor side=party idx=0 slot=1-1 address=0002 active=1 name="Reynauld" health="24/33 HP" stress="10/200 Stress" conditions=""',
    '[ 15] agent-state: action kind=pass index=0 skill_slot=0 element=0x02 name="Pass"',
    '[ 16] agent-state: action kind=skill index=1 skill_slot=1 element=0x01 name="Strike"',
    '[ 17] agent-state: end', '',
  ].join('\n');
  let passed!: () => void;
  const passSubmitted = new Promise<void>((resolve) => { passed = resolve; });
  let tick = 100;
  const { path, session, transport, memory } = await fixture(t, initial, (path) => new FakeCommandTransport(async (command) => {
    if (command.kind === 'click_element') {
      await appendFile(path, '[ 50] combatbuff: actor=0002 gained stat=1 sub="PROT" amount=0 rounds=1 pol=1\n');
      passed();
    } else if (command.kind === 'inspect_state') {
      await appendFile(path, `[ ${tick++}] agent-state: begin\n[ ${tick++}] agent-state: end\n`);
    } else assert.fail(`Unexpected command: ${command.kind}`);
  }));
  const state = await session.getState();
  const request = { requestId: 'pass', expectedRevision: state.revision, action: { kind: 'pass_turn' as const } };
  const first = session.execute(request);
  await passSubmitted;
  const repeated = session.execute(request);
  await assert.rejects(session.execute({ ...request, requestId: 'other' }), /handoff is in flight/);
  await appendFile(path, [
    '[ 200] heroswap: 0002 -> 0003 is the TURN — taking the action bar -> "Dismas. 18/23 HP. 0/200 Stress."',
    '[ 201] agent-state: begin',
    '[ 202] agent-state: actor side=party idx=0 slot=2-2 address=0003 active=1 name="Dismas" health="18/23 HP" stress="0/200 Stress" conditions=""',
    '[ 203] agent-state: action kind=skill index=1 skill_slot=1 element=0x03 name="Open Vein"',
    '[ 204] agent-state: end', '',
  ].join('\n'));
  const [result, duplicate] = await Promise.all([first, repeated]);
  assert.equal(result.action.outcome, 'success');
  assert.equal(result.transition?.status, 'ready');
  assert.equal(result.nextDecision?.available, true);
  assert.equal(duplicate.action.deduplicated, true);
  assert.deepEqual(duplicate.nextDecision, result.nextDecision);
  const again = await session.execute(request);
  assert.deepEqual(again.nextDecision, result.nextDecision);
  await assert.rejects(session.execute({ ...request, expectedRevision: request.expectedRevision + 1 }), /already used/);
  assert.deepEqual((await session.execute(request)).nextDecision, result.nextDecision);
  assert.equal((transport as FakeCommandTransport).commands.filter((command) => command.kind === 'click_element').length, 1);
  assert.equal((memory.getStatus().counts as { decisions: number }).decisions, 1);
});

test('session close interrupts settlement and prevents subsequent commands', async (t) => {
  let sent!: () => void;
  const submitted = new Promise<void>((resolve) => { sent = resolve; });
  const { session, transport } = await fixture(t, '[ 1] axcontext -> pause\n',
    () => new FakeCommandTransport(async () => { sent(); }),
    { settlementTimeoutMilliseconds: 30_000, pollIntervalMilliseconds: 2_000 });
  const state = await session.getState();
  const pending = session.execute({ requestId: 'dismiss', expectedRevision: state.revision, action: { kind: 'dismiss_modal' } });
  await submitted;
  await delay(5);
  const stoppedAt = Date.now();
  session.close();
  await assert.rejects(pending, /session is closed/);
  assert.ok(Date.now() - stoppedAt < 1_000);
  await assert.rejects(session.getState(), /session is closed/);
  assert.equal((transport as FakeCommandTransport).sendCount, 1);
});

test('live implicit revision retries preserve the original request identity', async (t) => {
  let tick = 2;
  const { session, transport } = await fixture(t, '[ 1] axcontext -> pause\n', (path) => new FakeCommandTransport(async (command: GameCommand) => {
    if (command.kind === 'inspect_state') {
      await appendFile(path, `[ ${tick++}] agent-state: begin\n[ ${tick++}] agent-state: end\n`);
    } else await appendFile(path, `[ ${tick++}] axcontext -> townmap\n`);
  }));
  const handler = new LiveRequestHandler(session);
  const request = { id: 'dismiss', op: 'act_current', action: { kind: 'dismiss_modal' } };
  const first = await handler.handle(request);
  const second = await handler.handle(request);
  assert.equal((first.action as { outcome: string }).outcome, 'success');
  assert.equal((second.action as { deduplicated: boolean }).deduplicated, true);
  assert.equal((transport as FakeCommandTransport).commands.filter((command) => command.kind === 'key_press').length, 1);
});

test('completed inspections in the same tick are fresh when new completion records arrive', async (t) => {
  const { engine } = await fixture(t, '[ 1] axcontext -> townmap\n[ 2] agent-state: end\n',
    (path) => new FakeCommandTransport(async () => {
      await appendFile(path, '[ 2] agent-state: begin\n[ 2] agent-state: end\n');
    }));
  const fresh = await engine.forceRefresh();
  assert.equal(fresh.revision, 4);
});

test('map baselines return after town boundaries and discoveries while movement stays compact', async (t) => {
  const { path, session } = await fixture(t, '[ 1] axcontext -> townmap\n', () => new FakeCommandTransport(async () => { }));
  const handler = new LiveRequestHandler(session);
  await handler.handle({ op: 'state', project: 'summary' });
  const map = [
    '[ 2] axcontext -> room',
    "[ 3] agent-map: begin areas=1 current='room0'",
    "[ 4] agent-map: area index=0 id='room0' kind=0 current=1 tiles=1 visited=1",
    "[ 5] agent-map: tile area='room0' index=0 type=0 content=0 knowledge=0 visible=1 visited=1 current=1",
    '[ 6] agent-map: end', '',
  ].join('\n');
  await appendFile(path, map);
  const first = await handler.handle({ op: 'state', project: 'summary' });
  assert.equal((first.state as { map: { areas: unknown[] } }).map.areas.length, 1);
  await appendFile(path, "[ 7] agent-map: position area='room0' tile=0\n");
  const moved = await handler.handle({ op: 'state', project: 'summary' });
  assert.equal((moved.state as { map?: unknown }).map, undefined);
  assert.ok((moved.state as { mapUpdate: unknown }).mapUpdate);
  await appendFile(path, "[ 8] agent-map: tile area='room0' index=0 type=0 content=3 knowledge=1 visible=1 visited=1 current=1\n");
  const discovered = await handler.handle({ op: 'state', project: 'summary' });
  assert.ok((discovered.state as { map: unknown }).map);
  await appendFile(path, '[ 9] axcontext -> townmap\n');
  await handler.handle({ op: 'state', project: 'summary' });
  await appendFile(path, map);
  const returned = await handler.handle({ op: 'state', project: 'summary' });
  assert.ok((returned.state as { map: unknown }).map);
});

test('live summary preserves full diagnostics and more than sixteen meaningful changes', async (t) => {
  const { path, session } = await fixture(t, '[ 1] axcontext -> townmap\n', () => new FakeCommandTransport(async () => { }));
  const handler = new LiveRequestHandler(session);
  await handler.handle({ op: 'state', project: 'summary' });
  await appendFile(path, Array.from({ length: 20 }, (_, i) => `[ ${i + 2}] axcontext -> townmap\n`).join(''));
  const delta = await handler.handle({ op: 'state', project: 'summary' });
  assert.equal((delta.state as { changes: unknown[] }).changes.length, 20);
  const full = await handler.handle({ op: 'state', project: 'summary', mode: 'full' });
  assert.ok('state' in (full.state as object));
  assert.ok('records' in (full.state as object));
});
