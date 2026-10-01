import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBlindestLine } from '../src/blindest/parse-line.js';
import { initialGameState, reduceGameState } from '../src/state/game-state.js';
import { CopilotEngine } from '../src/copilot/engine.js';
import { LocalGameGateway } from '../src/copilot/local-game-gateway.js';
import { CombatLogSource } from '../src/live/combat-log-source.js';
import { FakeCommandTransport } from './helpers/fake-command-transport.js';

const text = '你花费将不会返还，但是英雄将可以立即加入任务。你确定么？ A, 是. B, 否.';
const popup = `[ 11] confirmpopup dev=ctrl alt=0 entry=0x1f668ca0d60 count=2 got=2 btn0=-1 btn1=-1 text="${text}"`;

test('live confirmation text and answer identities survive inspections but clear on leaving dialog', () => {
  const event = parseBlindestLine(popup)!;
  assert.equal(event.kind, 'confirmation_dialog_observed');
  let state = reduceGameState(initialGameState(), parseBlindestLine('[ 10] axcontext -> dialog')!);
  state = reduceGameState(state, event);
  assert.equal(state.activeDialog?.text, text);
  assert.deepEqual(state.activeDialog?.options.map(({ optionIndex, label, elementId }) => ({ optionIndex, label, elementId })), [
    { optionIndex: 0, label: '是', elementId: '0x636e6661' },
    { optionIndex: 1, label: '否', elementId: '0x636e6662' },
  ]);
  state = reduceGameState(state, parseBlindestLine('[ 12] agent-state: begin')!);
  state = reduceGameState(state, parseBlindestLine('[ 13] agent-state: end')!);
  assert.equal(state.activeDialog?.text, text);
  state = reduceGameState(state, parseBlindestLine('[ 14] axcontext -> building')!);
  assert.equal(state.activeDialog, undefined);
  const unknown = parseBlindestLine(popup.replace('count=2 got=2', 'count=3 got=3'));
  assert.equal(unknown?.kind, 'confirmation_dialog_observed');
  if (unknown?.kind === 'confirmation_dialog_observed') {
    assert.equal(unknown.text, text);
    assert.deepEqual(unknown.options, []);
  }
});

test('Copilot exposes both answers in baseline and delta, selects native answer once, and rejects stale answers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-dialog-'));
  const path = join(directory, 'ddaccess-debug.log');
  try {
    await writeFile(path, `[ 10] axcontext -> dialog\n${popup}\n`, 'utf8');
    const transport = new FakeCommandTransport(async (command) => {
      assert.deepEqual(command, { kind: 'activate_element', args: { elementId: '0x636e6662' } });
      await appendFile(path, '[ 20] agent-ipc: serviced activate element=0x636e6662 accepted=1\n[ 21] axcontext -> building\n', 'utf8');
    });
    const engine = new CopilotEngine(new LocalGameGateway(new CombatLogSource(path), transport),
      { settlementTimeoutMilliseconds: 50, pollIntervalMilliseconds: 1 });
    const before = await engine.getState('compact');
    assert.equal(before.decision.prompt, text);
    assert.equal(before.activeDialog?.options[1]?.label, '否');
    const delta = await engine.getState('delta', 0);
    assert.equal(delta.decision.prompt, text);
    assert.ok(delta.changes?.some((record) => record.event?.kind === 'confirmation_dialog_observed' && record.importance === 'critical'));
    const request = { requestId: 'answer-no', expectedRevision: before.revision,
      action: { kind: 'choose_dialog_option' as const, optionIndex: 1 } };
    assert.equal((await engine.act(request)).outcome, 'success');
    assert.equal((await engine.act(request)).deduplicated, true);
    const after = await engine.getState('compact');
    assert.equal(after.activeDialog, undefined);
    assert.equal((await engine.act({ ...request, requestId: 'stale-answer', expectedRevision: after.revision })).stage, 'validation');
    assert.equal(transport.sendCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
