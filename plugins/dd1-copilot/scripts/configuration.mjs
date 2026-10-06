import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function readPluginConfiguration(env = process.env) {
  const localData = env.LOCALAPPDATA?.trim();
  const override = env.DD1_PLUGIN_CONFIG?.trim();
  const configPath = override || (localData && join(localData, 'DD1AgentBridge', 'copilot-plugin.local.json'));
  if (override && !existsSync(override)) throw new Error('The explicit DD1_PLUGIN_CONFIG file does not exist.');
  const config = configPath && existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, '')) : {};
  return resolvePluginConfiguration(config, configPath, env);
}

export function resolvePluginConfiguration(config, configPath, env = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('DD1 plugin configuration must be an object.');
  for (const key of ['logPath', 'commandPipe', 'campaignId', 'saveDirectory', 'databasePath']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) throw new Error(`Invalid DD1 plugin configuration field: ${key}`);
  }
  const logPath = env.DD1_BLINDEST_LOG?.trim() || config.logPath;
  const commandPipe = env.DD1_COMMAND_PIPE?.trim() || config.commandPipe;
  if (!logPath || !commandPipe) throw new Error('Configure DD1 Copilot with scripts/configure-plugin.ps1. Set logPath and commandPipe in the local plugin configuration.');
  if (!isAbsolute(logPath)) throw new Error('DD1 logPath must be absolute.');
  if (process.platform === 'win32' && !/^\\\\\.\\pipe\\[^\\]+$/iu.test(commandPipe)) throw new Error('DD1 commandPipe must be a Windows named pipe.');
  const explicitMemory = ['DD1_CAMPAIGN_ID', 'DD1_SAVE_DIR', 'DD1_MEMORY_DB', 'DD1_MEMORY_CONFIG'].some(key => env[key]?.trim());
  if (!explicitMemory && (!config.saveDirectory || !isAbsolute(config.saveDirectory))) throw new Error('Bind an absolute saveDirectory in the DD1 plugin configuration.');
  const runtimeEnv = { ...env, DD1_BLINDEST_LOG: resolve(logPath), DD1_COMMAND_PIPE: commandPipe };
  if (!explicitMemory) runtimeEnv.DD1_MEMORY_CONFIG = resolve(configPath);
  return { env: runtimeEnv, configPath, logAvailable: existsSync(logPath) && statSync(logPath).isFile() };
}
