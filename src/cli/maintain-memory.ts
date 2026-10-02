import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { maintainMemory } from '../copilot/memory/maintenance.js';

const schema=z.object({archiveRoot:z.string().min(1),entries:z.array(z.object({
  label:z.string().min(1),source:z.string().min(1),mode:z.enum(['bind','archive']),
  campaignId:z.string().min(1).optional(),saveDirectory:z.string().min(1).optional(),
})).min(1)});
const args=process.argv.slice(2);
const planPath=args[args.indexOf('--plan')+1];
if(!args.includes('--plan') || !planPath) throw new Error('Usage: memory:maintain -- --plan <plan.local.json> [--apply --offline]');
if(args.includes('--apply') && !args.includes('--offline')) throw new Error('Close the game and Copilot before maintenance, then explicitly pass --offline.');
const plan=schema.parse(JSON.parse(readFileSync(planPath,'utf8').replace(/^\uFEFF/u,'')));
const resume=args.includes('--resume') ? args[args.indexOf('--resume')+1] : undefined;
console.log(JSON.stringify(await maintainMemory(plan,args.includes('--apply'),resume),null,2));
