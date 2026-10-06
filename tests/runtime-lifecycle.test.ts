import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CampaignMemoryStore } from '../src/copilot/campaign-memory.js';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-process-'));
  const log = join(directory, 'log');
  await writeFile(log, '[ 1] axcontext -> townmap\n');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dd1-test-${randomUUID()}` : join(directory, 'game.sock');
  const children: ChildProcessWithoutNullStreams[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const launch = (mcp = false) => {
    const args = mcp ? ['--import', 'tsx', 'src/copilot/stdio.ts']
      : ['--import', 'tsx', '--input-type=module', '--eval',
        "import {runLiveSession} from './src/cli/live-session.ts'; await runLiveSession().catch(error=>{console.error(error.message);process.exitCode=1;});"];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env, DD1_BLINDEST_LOG: log, DD1_COMMAND_PIPE: pipe,
        DD1_MEMORY_DB: join(directory, 'memory.sqlite'), DD1_CAMPAIGN_ID: 'test',
      }, windowsHide: true
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    children.push(child);
    const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    const waitForOutput = async (pattern: RegExp) => {
      if (pattern.test(stdout)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`No output matching ${pattern}; ${stderr}`)), 8_000);
        const onData = () => { if (pattern.test(stdout)) finish(); };
        const onClose = () => finish(new Error(`Process exited before readiness: ${stderr}`));
        function finish(error?: Error) {
          clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose);
          if (error) reject(error); else resolve();
        }
        child.stdout.on('data', onData); child.once('close', onClose);
      });
    };
    return { child, closed, waitForOutput };
  };
  return { launch, directory };
}

test('live helper stops, releases its lease and permits an immediate restart', { timeout: 15_000 }, async (t) => {
  const { launch, directory } = await setup(t);
  const first = launch();
  await first.waitForOutput(/"ready":true/);
  first.child.stdin.write('\uFEFF{"id":"bom-status","op":"memory_status"}\n');
  await first.waitForOutput(/"id":"bom-status","ok":true/);
  const duplicate = launch();
  const duplicateResult = await duplicate.closed;
  assert.equal(duplicateResult.code, 1);
  assert.match(duplicateResult.stderr, /already owns this game command pipe/);
  first.child.stdin.write('{"id":"stop","op":"stop"}\n');
  assert.equal((await first.closed).code, 0);
  const second = launch();
  await second.waitForOutput(/"ready":true/);
  second.child.stdin.end();
  assert.equal((await second.closed).code, 0);
  const memory = new CampaignMemoryStore({ path: join(directory, 'memory.sqlite'), campaignId: 'test' });
  try { assert.equal(memory.getStatus().campaignId, 'test'); } finally { memory.close(); }
});

test('MCP discovery works alongside a controlling helper and MCP exits on input EOF', { timeout: 15_000 }, async (t) => {
  const { launch } = await setup(t);
  const live = launch();
  await live.waitForOutput(/"ready":true/);
  const mcp = launch(true);
  mcp.child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    }
  }) + '\n');
  await mcp.waitForOutput(/"serverInfo"/);
  mcp.child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await mcp.waitForOutput(/"tools":\[/);
  mcp.child.stdin.end();
  assert.equal((await mcp.closed).code, 0);
  live.child.stdin.end();
  assert.equal((await live.closed).code, 0);
});

test('a broken output pipe closes the helper without keeping stdin alive', { timeout: 15_000 }, async (t) => {
  const { launch } = await setup(t);
  const live = launch();
  await live.waitForOutput(/"ready":true/);
  live.child.stdout.destroy();
  live.child.stdin.write('{"id":"memory","op":"memory_status"}\n');
  assert.equal((await live.closed).code, 0);
});
