import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Workbench } from '../core/service.mjs';
import { Jobs } from '../core/jobs.mjs';
import { previewTestSchema } from '../core/automation-contract.mjs';
import { TOOL_DEFINITIONS } from '../core/tool-definitions.mjs';
import { CAPABILITIES } from '../core/capabilities.mjs';
import en from '../shared/locales/en.json' with { type: 'json' };

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-automation-'));
  const projectPath=path.join(directory,'project'); await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath,'app.json'),JSON.stringify({name:'Automation fixture',version:'1.0.0',engine:'>=0.18.0',pages:['index'],permissions:[]}));
  await fs.writeFile(path.join(projectPath,'index.ink'),'<script def>{}</script><script setup>export default {}</script><page><text>Test</text></page>');
  const service=await new Workbench(path.join(directory,'home')).init();
  const project=await service.projects.import(projectPath);
  t.after(async()=>{await service.close();await fs.rm(directory,{recursive:true,force:true});});
  return {service,project};
}

test('simulation validates action-specific arguments before dispatch and publishes a compact input schema',()=>{
  const parsed=previewTestSchema.parse({projectId:'p',steps:[{action:'swipe'},{action:'tap'}]});
  assert.equal(parsed.steps[0].parameters.direction,'forward');assert.equal(parsed.steps[1].settleMs,200);
  for(const step of [{action:'scenario'},{action:'pose_stream'},{action:'pose',parameters:{pitch:95}},{action:'tap',parameters:{typo:true}},{action:'swipe',parameters:{repeats:50,intervalMs:500}}]) assert.equal(previewTestSchema.safeParse({projectId:'p',steps:[step]}).success,false,JSON.stringify(step));
  const definition=TOOL_DEFINITIONS.find(([name])=>name==='aiui_preview_test');
  const schema=z.toJSONSchema(z.object(definition[2]),{io:'input'});
  assert.deepEqual(schema.required,['projectId']);
  assert.ok(JSON.stringify(schema).length<9000,'AI discovery should not repeat a large schema for each action');
});

test('one wait returns the same job and preserves structured failure diagnostics',async()=>{
  const jobs=new Jobs(()=>{});let finish,runs=0;
  const job=jobs.start('fixture',null,async()=>{runs++;await new Promise(resolve=>{finish=resolve;});throw Object.assign(new Error('check failed'),{result:{diagnostics:['actual failure']}});});
  assert.equal((await jobs.wait(job.id,0)).status,'running');finish();
  const result=await jobs.wait(job.id,1000);assert.equal(result.status,'failed');assert.deepEqual(result.result.diagnostics,['actual failure']);assert.equal(runs,1);
  assert.equal((await jobs.wait(job.id,0)).id,job.id);await jobs.close();
});

test('failed official checks return diagnostics without attempting to pack',async t=>{
  const {service,project}=await fixture(t),calls=[];
  service.cli=async args=>{calls.push(args[0]);return{code:1,output:JSON.stringify({diagnostics:[{code:'AIX011',message:'invalid fixture'}]})};};
  const job=await service.call('aiui_project_build',{projectId:project.id});
  assert.equal(job.status,'failed');assert.deepEqual(calls,['check']);assert.equal(job.result.uploaded,false);assert.equal(job.result.check.diagnostics.diagnostics[0].code,'AIX011');
});

test('source changes while packing invalidate the combined result',async t=>{
  const {service,project}=await fixture(t);
  service.cli=async args=>{if(args[0]==='pack'){await fs.writeFile(args.at(-1),'fixture archive');await fs.appendFile(path.join(project.agentPath,'index.ink'),'\n<!-- concurrent edit -->');}return{code:0,output:'{"diagnostics":[]}'};};
  const job=await service.call('aiui_project_build',{projectId:project.id});
  assert.equal(job.status,'failed');assert.equal(job.result.stale,true);assert.equal(job.result.uploaded,false);assert.equal(project.platform.status,'unlinked');
});

test('bundle revision describes the actual bytes even before the file watcher refreshes metadata',async t=>{
  const {service,project}=await fixture(t),old=project.revision;
  await fs.appendFile(path.join(project.agentPath,'index.ink'),'\n<!-- immediately edited -->');
  const bundle=await service.projects.bundle(project.id);
  assert.notEqual(bundle.project.revision,old);assert.equal(project.revision,old);
});

test('cancelling a preview command removes its queue and pending listener',async t=>{
  const {service,project}=await fixture(t),preview=service.previews.open(project.id,'http://127.0.0.1:1'),controller=new AbortController();
  const pending=service.previews.action(preview.id,'tap',{}, {signal:controller.signal});controller.abort();
  await assert.rejects(pending);const session=service.previews.get(preview.id);assert.equal(session.pending.size,0);assert.equal(session.queue.length,0);
});

test('a new AI request waits for a fresh ready report instead of reusing an unmounted runtime state',async t=>{
  const {service,project}=await fixture(t),preview=service.previews.open(project.id,'http://127.0.0.1:1'),s=service.previews.get(preview.id);
  service.previews.update(s,{status:'ready',revision:project.revision,state:{running:true,runId:'previous'}});s.readyAt=Date.now()-100;
  service.previews.open(project.id,'http://127.0.0.1:1',{requestedBy:'MCP'});service.clients.set('desktop',{name:'desktop',lastSeen:Date.now()});
  const controller=new AbortController();t.after(()=>controller.abort());
  for(const previousStatus of ['ready','failed']){
    s.status=previousStatus;s.failedAt=Date.now()-100;s.readyAt=Date.now()-100;
    service.previews.open(project.id,'http://127.0.0.1:1',{requestedBy:'MCP'});
    const ready=service.automation.ready(s.id,project.revision,{signal:controller.signal,progress:()=>{}});
    const timer=setTimeout(()=>service.previews.update(s,{status:'ready',revision:project.revision,state:{running:true,runId:'newly-mounted-'+previousStatus}}),25);t.after(()=>clearTimeout(timer));
    assert.equal((await ready).state.runId,'newly-mounted-'+previousStatus);
  }
});

test('incremental logs paginate with stable cursors, filters and explicit retention gaps',async t=>{
  const {service,project}=await fixture(t),preview=service.previews.open(project.id,'http://127.0.0.1:1'),s=service.previews.get(preview.id);
  for(let i=0;i<505;i++)service.previews.log(s,i%2?'error':'info','message '+i,s.logGeneration,undefined,{runId:'actual-run'});
  const first=await service.call('aiui_preview_logs',{sessionId:s.id,afterSequence:0,limit:2,level:'error',runId:'actual-run'});
  assert.equal(first.truncated,true);assert.deepEqual(first.logs.map(l=>l.sequence),[6,8]);assert.equal(first.nextSequence,8);
  const next=await service.call('aiui_preview_logs',{sessionId:s.id,afterSequence:first.nextSequence,limit:2,contains:'message 10'});
  assert.ok(next.logs.every(log=>log.sequence>8));
  const end=await service.call('aiui_preview_logs',{sessionId:s.id,afterSequence:505});assert.deepEqual(end.logs,[]);assert.equal(end.nextSequence,505);
});

test('capability cards have complete English titles and descriptions and honest upload status',()=>{
  for(const capability of CAPABILITIES){assert.ok(en[capability.title],capability.title);assert.ok(en[capability.description],capability.description);}
  for(const capability of CAPABILITIES)for(const tool of [capability.tool,...(capability.relatedTools||[])])assert.ok(TOOL_DEFINITIONS.some(([name])=>name===tool),tool);
  assert.equal(CAPABILITIES.find(c=>c.id==='platform').status,'available');
});
