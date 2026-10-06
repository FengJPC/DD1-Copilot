import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CommandTransport } from '../src/command/transport.js';
import { LeasedCommandTransport } from '../src/copilot/leased-command-transport.js';

test('discovery stays free while competing sessions cannot send input, and close releases ownership', async (t) => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dd1-lease-${randomUUID()}` : join(tmpdir(), `dd1-lease-${randomUUID()}.sock`);
  let sent = 0;
  const command: CommandTransport = {
    async health() { return { configured: true, available: true, transport: 'named_pipe' }; },
    async send() { sent++; return { commandId: randomUUID(), transport: 'named_pipe', status: 'accepted', receivedAt: new Date().toISOString() }; },
  };
  const first = new LeasedCommandTransport(command, pipe);
  const second = new LeasedCommandTransport(command, pipe);
  t.after(async () => { await first.close(); await second.close(); });
  assert.equal((await second.health()).available, true);
  assert.equal((await first.send({ kind: 'test', args: {} })).status, 'accepted');
  const busy = await second.send({ kind: 'test', args: {} });
  assert.equal(busy.status, 'rejected');
  assert.match(busy.reason!, /already owns/);
  assert.equal(sent, 1);
  await first.close();
  assert.equal((await second.send({ kind: 'test', args: {} })).status, 'accepted');
  assert.equal(sent, 2);
  assert.equal((await first.send({ kind: 'test', args: {} })).status, 'rejected');
});
