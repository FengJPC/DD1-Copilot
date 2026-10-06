import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolvePluginConfiguration } from '../plugins/dd1-copilot/scripts/configuration.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return value;
}
try {
  if (!process.env.LOCALAPPDATA && !option('--config')) throw new Error('Set LOCALAPPDATA or pass --config.');
  const configPath = resolve(option('--config') || join(process.env.LOCALAPPDATA, 'DD1AgentBridge', 'copilot-plugin.local.json'));
  const fromProject = args.includes('--from-project');
  const previous = existsSync(configPath) ? JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/u, '')) : {};
  const memory = fromProject ? JSON.parse((await readFile(join(root, 'memory.local.json'), 'utf8')).replace(/^\uFEFF/u, '')) : previous;
  const gameDirectory = option('--game-directory');
  if (!gameDirectory || !isAbsolute(gameDirectory)) throw new Error('Pass an absolute --game-directory (PowerShell resolves the installation).');
  if (!existsSync(join(gameDirectory, 'Darkest.exe'))) throw new Error('Darkest.exe was not found in the game directory.');
  const config = {
    logPath: option('--log') || join(gameDirectory, 'ddaccess-debug.log'),
    commandPipe: option('--pipe') || previous.commandPipe || '\\\\.\\pipe\\dd1-agent-bridge',
    ...(memory.campaignId ? { campaignId: memory.campaignId } : {}),
    saveDirectory: option('--save-directory') || memory.saveDirectory,
    ...(memory.databasePath ? { databasePath: memory.databasePath } : {}),
  };
  if (option('--campaign-id')) config.campaignId = option('--campaign-id');
  if (!config.saveDirectory || !isAbsolute(config.saveDirectory) || !(await stat(config.saveDirectory)).isDirectory()) throw new Error('An existing absolute save directory is required.');
  if (config.databasePath && !isAbsolute(config.databasePath)) throw new Error('databasePath must be absolute.');
  const module = new URL('../build/dd1-copilot/runtime/dist/copilot/memory/storage-config.js', import.meta.url);
  if (!existsSync(module)) throw new Error('Run npm run plugin:package before configuring the plugin.');
  const { resolveMemoryConfiguration } = await import(module.href);
  // Bindings are read for validation; registry/database writes happen only when MCP starts.
  const env = { ...process.env, DD1_MEMORY_CONFIG: '', DD1_MEMORY_DB: config.databasePath || '',
    DD1_SAVE_DIR: config.saveDirectory, DD1_CAMPAIGN_ID: config.campaignId || '' };
  const binding = resolveMemoryConfiguration(env);
  config.campaignId = binding.campaignId;
  config.saveDirectory = binding.saveDirectory;
  resolvePluginConfiguration(config, configPath, { ...env, DD1_BLINDEST_LOG: '', DD1_COMMAND_PIPE: '' });
  if (args.includes('--apply')) {
    const temporary = `${configPath}.tmp-${randomUUID()}`;
    await mkdir(dirname(configPath), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
      if (existsSync(configPath)) await copyFile(configPath, `${configPath}.backup-${randomUUID()}`);
      await rename(temporary, configPath);
    } finally { await rm(temporary, { force: true }); }
  }
  console.log(JSON.stringify({ ok: true, applied: args.includes('--apply'), configPath, campaignId: binding.campaignId,
    logAvailable: existsSync(config.logPath), databaseExists: existsSync(binding.path) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
