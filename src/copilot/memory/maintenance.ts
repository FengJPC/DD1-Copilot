import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CampaignMemoryStore } from '../campaign-memory.js';
import { normalizeSaveDirectory, registerMemoryConfiguration } from './storage-config.js';

export interface MemoryMaintenancePlan {
  archiveRoot: string;
  entries: Array<{label:string;source:string;mode:'bind'|'archive';campaignId?:string;saveDirectory?:string}>;
}

export function auditDatabase(path: string) {
  const database=new DatabaseSync(resolve(path),{readOnly:true});
  try {
    database.exec('PRAGMA query_only=ON; BEGIN;');
    const tables=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const contents:Record<string,{count:number;sha256:string}>={};
    for(const row of tables) {
      const name=String(row.name); const hash=createHash('sha256'); let count=0;
      for(const record of database.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).iterate()) { hash.update(JSON.stringify(record)+'\n'); count++; }
      contents[name]={count,sha256:hash.digest('hex')};
    }
    const campaigns=database.prepare('SELECT campaign_id FROM campaigns').all().map(row=>String(row.campaign_id));
    const result={path:resolve(path),campaigns,contents};
    database.exec('ROLLBACK;'); return result;
  } finally {database.close();}
}

function moveVerifiedFile(source:string,destination:string) {
  if(existsSync(destination)) {
    const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
    if(hash(source)!==hash(destination)) throw new Error('Archive destination already exists with different bytes. Source retained.');
    unlinkSync(source); return;
  }
  try { renameSync(source,destination); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EXDEV') throw error;
    const before=statSync(source);
    copyFileSync(source,destination,constants.COPYFILE_EXCL);
    const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
    const after=statSync(source);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || hash(source)!==hash(destination)) throw new Error('Cross-volume copy changed during verification; source retained.');
    unlinkSync(source);
  }
}

type ManifestEntry = MemoryMaintenancePlan['entries'][number] & {
  audit:ReturnType<typeof auditDatabase>; backupPath:string;
  status:string; archivedPath?:string; memory?:unknown;
};

export async function maintainMemory(plan:MemoryMaintenancePlan,apply=false,resumeDirectory?:string) {
  const archiveRoot=resolve(plan.archiveRoot);
  if(resumeDirectory && (!apply || !resolve(resumeDirectory).startsWith(archiveRoot+sep))) throw new Error('Resume must apply a manifest inside the specified archive root.');
  const resumed=resumeDirectory ? JSON.parse(readFileSync(join(resolve(resumeDirectory),'manifest.json'),'utf8')) as {status:string;entries:ManifestEntry[]} : undefined;
  const sourcePaths=new Set<string>(); const labels=new Set<string>();
  const entries=plan.entries.map(entry=>{
    if(!/^[a-zA-Z0-9_-]{1,64}$/u.test(entry.label) || labels.has(entry.label)) throw new Error('Archive labels must be unique safe directory names.');
    labels.add(entry.label);
    const source=resolve(entry.source);
    if(!source.endsWith('.sqlite') || sourcePaths.has(source.toLowerCase())) throw new Error('Sources must be distinct SQLite files.');
    sourcePaths.add(source.toLowerCase());
    const previous=resumed?.entries.find(row=>row.label===entry.label && resolve(row.source)===source && row.mode===entry.mode);
    if(resumed && !previous) throw new Error('Resume manifest does not match this maintenance plan.');
    const audit=previous?.audit ?? auditDatabase(source);
    if(entry.mode==='bind') {
      if(!entry.campaignId || !entry.saveDirectory) throw new Error('A binding requires a campaignId and saveDirectory.');
      normalizeSaveDirectory(entry.saveDirectory);
      if(audit.campaigns.length!==1 || audit.campaigns[0]!==entry.campaignId) throw new Error('Binding does not match the existing campaign. Ambiguous histories must be archived.');
    }
    return {...entry,source,audit};
  });
  if(!apply) return {applied:false,entries};
  const directory=resumeDirectory ? resolve(resumeDirectory) : join(archiveRoot,`${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID().slice(0,8)}`);
  if(!directory.startsWith(archiveRoot+sep)) throw new Error('Archive directory escapes its root.');
  mkdirSync(directory,{recursive:true});
  const manifest:{status:string;entries:ManifestEntry[]}=resumed ?? {status:'backing_up',entries:[]};
  const saveManifest=()=>writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
  saveManifest();
  // Complete and verify every backup before changing any source location/schema.
  for(const entry of entries) {
    const backupPath=join(directory,entry.label,'backup.sqlite');
    mkdirSync(join(directory,entry.label),{recursive:true});
    if(!existsSync(backupPath)) {
      const database=new DatabaseSync(entry.source,{readOnly:true});
      try {await backup(database,backupPath);} finally {database.close();}
    }
    const backedUp=auditDatabase(backupPath);
    if(JSON.stringify(backedUp.contents)!==JSON.stringify(entry.audit.contents)) throw new Error('Backup differs from source. Stop active writers and rerun maintenance.');
    if(!resumed) manifest.entries.push({...entry,backupPath,status:'backed_up'}); saveManifest();
  }
  manifest.status='applying'; saveManifest();
  for(let i=0;i<entries.length;i++) {
    const entry=entries[i]!;
    const previous=manifest.entries[i]!;
    if(previous.status==='archived_unassigned') {
      if(!previous.archivedPath || JSON.stringify(auditDatabase(previous.archivedPath).contents)!==JSON.stringify(entry.audit.contents)) throw new Error('Archived data no longer matches its verified backup.');
      continue;
    }
    if(previous.status==='bound') {
      const current=auditDatabase(entry.source);
      for(const table of ['heroes','hero_observations','decisions','records','reflections','expeditions']) if(current.contents[table]?.count!==entry.audit.contents[table]?.count) throw new Error('Bound data changed while offline; inspect the manifest before resuming.');
      continue;
    }
    if(previous.status!=='archiving' && JSON.stringify(auditDatabase(entry.source).contents)!==JSON.stringify(entry.audit.contents)) throw new Error('Source changed since backup; maintenance stopped.');
    if(entry.mode==='bind') {
      const memory=new CampaignMemoryStore({path:entry.source,campaignId:entry.campaignId!,saveDirectory:entry.saveDirectory!});
      const status=memory.getStatus(); memory.close();
      const after=auditDatabase(entry.source);
      for(const table of ['heroes','hero_observations','decisions','records','reflections','expeditions']) {
        if(after.contents[table]?.count!==entry.audit.contents[table]?.count) throw new Error('Schema migration changed historical row counts.');
      }
      registerMemoryConfiguration({campaignId:entry.campaignId!,path:entry.source,saveDirectory:normalizeSaveDirectory(entry.saveDirectory!),
        registryPath:join(resolve(process.env.LOCALAPPDATA!), 'DD1AgentBridge','storage-bindings.json')});
      manifest.entries[i]={...previous,status:'bound',memory:status};
    } else {
      manifest.entries[i]={...previous,status:'archiving'}; saveManifest();
      const targetDirectory=join(directory,entry.label,'original'); mkdirSync(targetDirectory,{recursive:true});
      for(const suffix of ['', '-wal', '-shm']) {
        const source=entry.source+suffix; const destination=join(targetDirectory,basename(source));
        if(!destination.startsWith(directory+sep)) throw new Error('Archive target escapes the verified root.');
        if(existsSync(source)) moveVerifiedFile(source,destination);
      }
      if(JSON.stringify(auditDatabase(join(targetDirectory,basename(entry.source))).contents)!==JSON.stringify(entry.audit.contents)) throw new Error('Archived source differs from its backup; use the verified backup to recover.');
      manifest.entries[i]={...previous,status:'archived_unassigned',archivedPath:join(targetDirectory,basename(entry.source))};
    }
    saveManifest();
  }
  manifest.status='complete'; saveManifest();
  return {applied:true,directory,manifest};
}
