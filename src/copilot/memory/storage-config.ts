import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MemoryConfiguration {
  campaignId: string;
  path: string;
  saveDirectory?: string;
  registryPath?: string;
}

interface Binding { campaignId: string; path: string; saveDirectory: string; }
function readBindings(path: string): Binding[] {
  if (!existsSync(path)) return [];
  const data=JSON.parse(readFileSync(path,'utf8')) as {version:number;bindings:Binding[]};
  if(data.version!==1 || !Array.isArray(data.bindings) || data.bindings.some(row=>!row.campaignId || !row.path || !row.saveDirectory)) throw new Error('Invalid storage binding registry.');
  return data.bindings;
}
function pathKey(path:string) { const p=resolve(path); return process.platform==='win32'?p.toLowerCase():p; }

export function registerMemoryConfiguration(config: MemoryConfiguration): void {
  if(!config.saveDirectory || !config.registryPath) return;
  mkdirSync(dirname(config.registryPath),{recursive:true});
  const lock=`${config.registryPath}.lock`;
  const handle=openSync(lock,'wx');
  const temporary=`${config.registryPath}.tmp-${randomUUID()}`;
  try {
    const bindings=readBindings(config.registryPath);
    const collision=bindings.find(row=> row.saveDirectory===config.saveDirectory || row.campaignId===config.campaignId || pathKey(row.path)===pathKey(config.path));
    if(collision && (collision.saveDirectory!==config.saveDirectory || collision.campaignId!==config.campaignId || pathKey(collision.path)!==pathKey(config.path))) throw new Error('Save, campaign ID and database must keep their registered one-to-one binding.');
    if(!collision) bindings.push({campaignId:config.campaignId,path:config.path,saveDirectory:config.saveDirectory});
    writeFileSync(temporary,JSON.stringify({version:1,bindings},null,2),'utf8');
    renameSync(temporary,config.registryPath);
  } finally { closeSync(handle); rmSync(lock,{force:true}); rmSync(temporary,{force:true}); }
}

export function normalizeSaveDirectory(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`Save directory does not exist: ${resolved}`);
  const canonical = realpathSync.native(resolved);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function campaignSegment(campaignId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u.test(campaignId) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(campaignId)) return campaignId;
  return `campaign-${createHash('sha256').update(campaignId).digest('hex').slice(0, 20)}`;
}

/** Explicit environment bindings override the project-local configuration as a unit. */
export function resolveMemoryConfiguration(env: NodeJS.ProcessEnv = process.env): MemoryConfiguration {
  const explicit = ['DD1_CAMPAIGN_ID', 'DD1_SAVE_DIR', 'DD1_MEMORY_DB'].some(key => env[key]?.trim());
  const configPath = resolve(env.DD1_MEMORY_CONFIG?.trim() || fileURLToPath(new URL('../../../memory.local.json', import.meta.url)));
  let config: { campaignId?: string; saveDirectory?: string; databasePath?: string } = {};
  if (!explicit && existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Memory configuration must be an object.');
    config = parsed;
    for (const key of ['campaignId', 'saveDirectory', 'databasePath'] as const) {
      if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key]?.trim())) throw new Error(`Invalid memory configuration field: ${key}`);
    }
  }
  const saveDirectory = env.DD1_SAVE_DIR?.trim() || config.saveDirectory;
  const canonicalSave = saveDirectory ? normalizeSaveDirectory(saveDirectory) : undefined;
  const registryPath=env.LOCALAPPDATA?.trim() ? join(env.LOCALAPPDATA,'DD1AgentBridge','storage-bindings.json') : undefined;
  const registered=canonicalSave && registryPath ? readBindings(registryPath).find(row=>row.saveDirectory===canonicalSave) : undefined;
  const selectedId=env.DD1_CAMPAIGN_ID?.trim() || config.campaignId;
  if(registered && selectedId && selectedId!==registered.campaignId) throw new Error('Save directory is already bound to a different campaign ID.');
  const campaignId = registered?.campaignId || selectedId || (canonicalSave
    ? `${basename(canonicalSave)}-${createHash('sha256').update(canonicalSave).digest('hex').slice(0, 12)}` : undefined);
  if (!campaignId || campaignId === 'local-default') throw new Error('Bind a save with DD1_SAVE_DIR or memory.local.json (campaignId and saveDirectory). For an isolated test, set an explicit DD1_CAMPAIGN_ID. The ambiguous local-default fallback is disabled.');
  const localData = env.LOCALAPPDATA?.trim();
  const overridden = env.DD1_MEMORY_DB?.trim() || config.databasePath;
  if(registered && overridden && pathKey(overridden)!==pathKey(registered.path)) throw new Error('Save directory is already bound to another database.');
  if (!overridden && !localData) throw new Error('Set DD1_MEMORY_DB or LOCALAPPDATA to a local storage directory.');
  return {
    campaignId,
    path: registered?.path || (overridden ? resolve(overridden) : join(localData!, 'DD1AgentBridge', 'campaigns', campaignSegment(campaignId), 'campaign.sqlite')),
    ...(canonicalSave ? { saveDirectory: canonicalSave } : {}),
    registryPath,
  };
}
