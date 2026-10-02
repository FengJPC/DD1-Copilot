import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CampaignMemoryStore } from '../src/copilot/campaign-memory.js';
import { registerMemoryConfiguration, resolveMemoryConfiguration } from '../src/copilot/memory/storage-config.js';
import { auditDatabase, maintainMemory } from '../src/copilot/memory/maintenance.js';
import { initialGameState } from '../src/state/game-state.js';
import type { CombatLogSnapshot } from '../src/live/combat-log-source.js';
import { durableActionRecord } from '../src/copilot/memory/action-evidence.js';
import type { ActionRecord } from '../src/copilot/types.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dd1-storage-'));
  const save = join(root, 'profile_2'); mkdirSync(save);
  const path = join(root, 'campaign.sqlite');
  const memory = new CampaignMemoryStore({path,campaignId:'profile_2',saveDirectory:save});
  const stores=[memory];
  t.after(()=>{ for(const store of stores) store.close(); rmSync(root, {recursive:true,force:true,maxRetries:3,retryDelay:50}); });
  return {root,save,path,memory,track:(store:CampaignMemoryStore)=>{stores.push(store);return store;}};
}
function snapshot(phase: 'embark' | 'building' = 'embark'): CombatLogSnapshot {
  const state = initialGameState(); state.phase = phase;
  return {revision:10,observedAt:'2026-10-02T01:00:00.000Z',state,source:{kind:'blindest_log',path:'log',available:true,bytesConsumed:10,latestRevision:10,parsedEventCount:1}};
}

test('storage rejects ambiguous defaults and separates identically named saves by full path', t=>{
  const {root,save}=fixture(t);
  const env={LOCALAPPDATA:root, DD1_MEMORY_CONFIG:join(root,'missing.json')};
  assert.throws(()=>resolveMemoryConfiguration(env),/local-default fallback is disabled/);
  const other=join(root,'another','profile_2'); mkdirSync(other,{recursive:true});
  const a=resolveMemoryConfiguration({...env,DD1_SAVE_DIR:save});
  const b=resolveMemoryConfiguration({...env,DD1_SAVE_DIR:other});
  assert.notEqual(a.campaignId,b.campaignId); assert.notEqual(a.path,b.path);
  const config=join(root,'memory.local.json'); writeFileSync(config,JSON.stringify({campaignId:'profile_2',saveDirectory:save}));
  assert.equal(resolveMemoryConfiguration({...env,DD1_MEMORY_CONFIG:config}).campaignId,'profile_2');
  assert.equal(resolveMemoryConfiguration({...env,DD1_MEMORY_CONFIG:config,DD1_CAMPAIGN_ID:'isolated',DD1_MEMORY_DB:join(root,'test.sqlite')}).saveDirectory,undefined);
});

test('a campaign database cannot be opened with another save or campaign', t=>{
  const {root,save,path,memory}=fixture(t); memory.close();
  const other=join(root,'profile_1'); mkdirSync(other);
  assert.throws(()=>new CampaignMemoryStore({path,campaignId:'profile_2',saveDirectory:other}),/different save/);
  assert.throws(()=>new CampaignMemoryStore({path,campaignId:'profile_1',saveDirectory:save}),/another campaign/);
  assert.throws(()=>new CampaignMemoryStore({path,campaignId:'profile_2'}),/Configure its saveDirectory/);
});

test('preparation and town update hero facts, preserve missing fields, and retain A B A history', t=>{
  const {memory}=fixture(t);
  const s=snapshot();
  s.state.partyPlanning={slotCount:4,filledCount:0,slots:[],rosterCandidates:[{
    heroGuid:1,row:0,entryAddress:'ABC',name:'雷蒙德',state:0,building:'',missing:false,
    heroClass:'crusader',level:2,quirks:['盗窃癖'],diseases:[],trinkets:[{slot:0,status:'equipped',itemId:'stone'}],
  }]};
  memory.observeSnapshot(s); memory.observeSnapshot({...s,revision:11});
  s.state.partyPlanning.rosterCandidates[0]!.quirks=[]; memory.observeSnapshot({...s,revision:12});
  s.state.partyPlanning.rosterCandidates[0]!.quirks=['盗窃癖']; memory.observeSnapshot({...s,revision:13});
  let hero=memory.getHeroMemory(1) as {heroClass:string;currentProfile:Record<string,unknown>;observations:unknown[]};
  assert.equal(hero.heroClass,'crusader'); assert.equal(hero.observations.length,3);
  memory.observeTactical({revision:14,phase:'combat',profileUpdates:[{side:'party',slot:1,heroGuid:1,name:'雷蒙德',details:['速度：1'],resists:[],quirks:['盗窃癖'],diseases:[]}]});
  hero=memory.getHeroMemory(1) as typeof hero;
  assert.deepEqual(hero.currentProfile.trinkets,[{slot:0,status:'equipped',itemId:'stone'}]);
  assert.equal(hero.currentProfile.level,2);
});

test('unavailable and incomplete telemetry does not write hero profiles', t=>{
  const {memory}=fixture(t); const s=snapshot();
  s.state.partyPlanning={slotCount:4,filledCount:0,slots:[],rosterCandidates:[{heroGuid:1,row:0,entryAddress:'ABC',name:'hero',state:0,building:'',missing:false,heroClass:'crusader'}]};
  memory.observeSnapshot({...s,source:{...s.source,available:false}});
  s.state.inspection={startedTick:20,completedTick:10}; memory.observeSnapshot(s);
  assert.equal((memory.getStatus().counts as Record<string,number>).heroes,0);
});

test('loading, detached results and circus combat do not create expeditions', t=>{
  const {memory}=fixture(t);
  for(const phase of ['loading','results','circus']) memory.observeState({revision:1,phase});
  memory.observeState({revision:2,phase:'combat',circusActive:true});
  assert.equal((memory.getStatus().counts as Record<string,number>).expeditions,0);
});

test('expedition end retains results and binds review to completed expedition across restart', t=>{
  const {memory,path,save,track}=fixture(t);
  memory.observeState({revision:10,phase:'room',quest:{complete:false,rows:['探索90%']}});
  memory.observeState({revision:20,phase:'results',quest:{complete:true},results:{rows:[{text:'获得1000金币'}]}});
  memory.observeState({revision:21,phase:'town',quest:{complete:false}});
  const pending=memory.getPendingReviews(); assert.equal(pending.length,1);
  assert.equal((pending[0]!.summary as {questOutcome:string}).questOutcome,'objective_complete_observed');
  assert.deepEqual((pending[0]!.summary as {results:unknown}).results,{rows:[{text:'获得1000金币'}]});
  memory.close();
  const reopened=track(new CampaignMemoryStore({path,campaignId:'profile_2',saveDirectory:save}));
  reopened.addReflection({kind:'expedition_review',title:'完成探索',body:'保留光照并控制压力。'});
  assert.equal(reopened.getPendingReviews().length,0);
  const reflection=(reopened.getResumePacket().reflections[0] as {expeditionId:string});
  assert.equal(reflection.expeditionId,pending[0]!.expeditionId);
  assert.throws(()=>reopened.addReflection({kind:'expedition_review',title:'错档',body:'x',expeditionId:'other-save'}),/does not belong/);
});

test('returning to town closes an expedition with unknown outcome when no victory was observed', t=>{
  const {memory}=fixture(t);
  memory.observeState({revision:1,phase:'room',quest:{complete:false}});
  memory.observeState({revision:2,phase:'town'});
  assert.equal((memory.getPendingReviews()[0]!.summary as {questOutcome:string}).questOutcome,'unknown');
});

test('schema migration keeps legacy rows and permits repeated historical profile values', t=>{
  const {root}=fixture(t); const path=join(root,'legacy.sqlite');
  const first=new CampaignMemoryStore({path,campaignId:'legacy'}); first.close();
  const db=new DatabaseSync(path);
  db.exec(`DROP TABLE campaign_binding; DROP INDEX hero_observations_hero; UPDATE schema_meta SET version=1;
    ALTER TABLE expeditions DROP COLUMN result_json;
    CREATE UNIQUE INDEX old_profile_dedup ON hero_observations(campaign_id,hero_guid,profile_hash);`);
  db.close();
  const migrated=new CampaignMemoryStore({path,campaignId:'legacy'}); migrated.close();
  const check=new DatabaseSync(path,{readOnly:true});
  assert.equal(check.prepare('SELECT version FROM schema_meta').get()?.version,2);
  assert.equal(check.prepare('SELECT count(*) AS n FROM campaigns').get()?.n,1); check.close();
});

test('durable action evidence excludes diagnostic floods and keeps command correlation', ()=>{
  const records=Array.from({length:500},(_,i)=>({revision:i+1,observedAt:'now',raw:'secret raw dump',message:'cursor probe'}));
  records.push({revision:501,observedAt:'now',raw:'raw',message:'agent-command: end id=x accepted=0'});
  const action={requestId:'x',action:{kind:'use_torch'},observations:records,steps:[]} as unknown as ActionRecord;
  const saved=durableActionRecord(action);
  assert.equal(saved.evidenceSummary.suppressed.count,500);
  assert.match(JSON.stringify(saved.observations),/accepted=0/);
  assert.doesNotMatch(JSON.stringify(saved),/secret raw dump/);
});

test('registered saves reuse their canonical database and reject silent database rebinding', t=>{
  const {root,save}=fixture(t);
  const env={LOCALAPPDATA:root,DD1_MEMORY_CONFIG:join(root,'none')};
  const configured=resolveMemoryConfiguration({...env,DD1_SAVE_DIR:save,DD1_CAMPAIGN_ID:'official'});
  registerMemoryConfiguration(configured);
  const reused=resolveMemoryConfiguration({...env,DD1_SAVE_DIR:save});
  assert.equal(reused.campaignId,'official'); assert.equal(reused.path,configured.path);
  assert.throws(()=>resolveMemoryConfiguration({...env,DD1_SAVE_DIR:save,DD1_MEMORY_DB:join(root,'temporary.sqlite')}),/another database/);
  assert.throws(()=>resolveMemoryConfiguration({...env,DD1_SAVE_DIR:save,DD1_CAMPAIGN_ID:'changed'}),/different campaign/);
});

test('maintenance is read-only by default and archives only after verifying a full backup', async t=>{
  const {root,memory,path}=fixture(t); memory.close();
  const before=auditDatabase(path);
  const plan={archiveRoot:join(root,'archives'),entries:[{label:'unassigned',source:path,mode:'archive' as const}]};
  assert.equal((await maintainMemory(plan)).applied,false);
  assert.deepEqual(auditDatabase(path).contents,before.contents);
  const applied=await maintainMemory(plan,true);
  assert.equal(applied.applied,true);
  assert.ok('directory' in applied);
  const copied=auditDatabase(join(applied.directory!,'unassigned','backup.sqlite'));
  const original=auditDatabase(join(applied.directory!,'unassigned','original','campaign.sqlite'));
  assert.deepEqual(copied.contents,before.contents); assert.deepEqual(original.contents,before.contents);
  const resumed=await maintainMemory(plan,true,applied.directory);
  assert.equal(resumed.applied,true);
});
