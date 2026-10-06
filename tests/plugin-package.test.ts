import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readPluginConfiguration } from '../plugins/dd1-copilot/scripts/configuration.mjs';

test('plugin settings keep explicit memory overrides together and reject incomplete bindings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dd1-plugin-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'plugin.local.json');
  const log = join(directory, 'game.log');
  const config = { logPath: log, commandPipe: '\\\\.\\pipe\\dd1-test', campaignId: 'saved', saveDirectory: directory };
  await writeFile(log, '');
  await writeFile(configPath, '\uFEFF' + JSON.stringify(config));
  const base = { DD1_PLUGIN_CONFIG: configPath };
  const configured = readPluginConfiguration(base);
  assert.equal(configured.env.DD1_MEMORY_CONFIG, configPath);
  assert.equal(configured.logAvailable, true);
  const overridden = readPluginConfiguration({ ...base, DD1_CAMPAIGN_ID: 'explicit', DD1_SAVE_DIR: directory });
  assert.equal(overridden.env.DD1_MEMORY_CONFIG, undefined);
  assert.equal(overridden.env.DD1_CAMPAIGN_ID, 'explicit');
  await writeFile(configPath, JSON.stringify({ ...config, logPath: 'relative.log' }));
  assert.throws(() => readPluginConfiguration(base), /must be absolute/);
  await writeFile(configPath, JSON.stringify({ logPath: log, commandPipe: config.commandPipe }));
  assert.throws(() => readPluginConfiguration(base), /Bind an absolute saveDirectory/);
  if (process.platform === 'win32') {
    await writeFile(configPath, JSON.stringify({ ...config, commandPipe: 'wrong' }));
    assert.throws(() => readPluginConfiguration(base), /Windows named pipe/);
  }
});

test('relocated packaged plugin speaks MCP, reads state, releases ownership and contains only public runtime', { timeout: 90_000 }, async (t) => {
  const packageResult = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/package-plugin.mjs'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  assert.equal(packageResult.code, 0, packageResult.output);
  const source = join(process.cwd(), 'build', 'dd1-copilot');
  const manifest = JSON.parse(await readFile(join(source, 'package-contents.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies.map((row: { name: string }) => row.name).sort(), ['@modelcontextprotocol/core', '@modelcontextprotocol/server', 'zod']);
  for (const file of manifest.files) assert.doesNotMatch(file.path, /^(?:references|backups|runs|fixtures)\/|\.(?:dll|exe|jar|sqlite|db|log)$|\.local\.json$/u);
  assert.equal(manifest.files.some((file: { path: string }) => file.path.endsWith('typescript/bin/tsc')), false);
  const directory = await mkdtemp(join(tmpdir(), 'dd1-plugin 搬家 '));
  const children: ChildProcessWithoutNullStreams[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill(); await new Promise<void>(done => child.once('close', () => done()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const relocated = join(directory, 'plugin');
  await cp(source, relocated, { recursive: true });
  const saveDirectory = join(directory, 'profile_2');
  await mkdir(saveDirectory);
  const logPath = join(directory, 'game.log');
  await writeFile(logPath, '[ 1] axcontext -> townmap\n');
  const configPath = join(directory, 'plugin.local.json');
  await writeFile(configPath, JSON.stringify({ logPath, commandPipe: process.platform === 'win32' ? `\\\\.\\pipe\\dd1-plugin-${randomUUID()}` : join(directory, 'game.sock'),
    campaignId: 'plugin-test', saveDirectory }));
  const env = { ...process.env, LOCALAPPDATA: directory, DD1_PLUGIN_CONFIG: configPath,
    DD1_BLINDEST_LOG: '', DD1_COMMAND_PIPE: '', DD1_CAMPAIGN_ID: '', DD1_SAVE_DIR: '', DD1_MEMORY_DB: '', DD1_MEMORY_CONFIG: '' };
  const check = await new Promise<{ code: number | null; output: string }>((done, fail) => {
    const child = spawn(process.execPath, [join(relocated, 'scripts', 'server.mjs'), '--check'], { cwd: directory, env, windowsHide: true });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', fail);
    child.once('close', code => done({ code, output }));
  });
  assert.equal(check.code, 0, check.output);
  assert.equal(JSON.parse(check.output).databaseExists, false);
  assert.equal(existsSync(join(directory, 'DD1AgentBridge', 'storage-bindings.json')), false);
  assert.equal(existsSync(join(directory, 'DD1AgentBridge', 'campaigns', 'plugin-test', 'campaign.sqlite')), false);
  const start = () => {
    const child = spawn(process.execPath, [join(relocated, 'scripts', 'server.mjs')], { cwd: directory, env, windowsHide: true });
    children.push(child);
    let buffered = '', stderr = '';
    const messages = new Map<number, unknown>();
    const waiters = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        const message = JSON.parse(line);
        if (typeof message.id !== 'number') continue;
        const waiter = waiters.get(message.id);
        if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.id); waiter.resolve(message); }
        else messages.set(message.id, message);
      }
    });
    const closed = new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', code => {
      for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}: ${stderr}`)); }
      waiters.clear(); done(code);
    }); });
    const request = (id: number, method: string, params?: unknown) => {
      const result = new Promise<any>((resolve, reject) => {
        if (messages.has(id)) { resolve(messages.get(id)); return; }
        waiters.set(id, { resolve, reject, timer: setTimeout(() => { waiters.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 8_000) });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
      return result;
    };
    return { child, closed, request };
  };
  const first = start();
  const init = await first.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'dd1-copilot');
  first.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await first.request(2, 'tools/list');
  assert.equal(listed.result.tools.length, 9);
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === 'act'));
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === 'record_reflection'));
  const state = await first.request(3, 'tools/call', { name: 'get_state', arguments: { mode: 'compact' } });
  assert.notEqual(state.result.isError, true);
  const resume = await first.request(4, 'tools/call', { name: 'get_campaign_resume', arguments: {} });
  assert.notEqual(resume.result.isError, true);
  assert.match(JSON.stringify(resume.result), /plugin-test/);
  first.child.stdin.end();
  assert.equal(await first.closed, 0);
  const second = start();
  await second.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'restart', version: '1' } });
  second.child.stdin.end();
  assert.equal(await second.closed, 0);
});
