import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Diagnostics,readServiceLog} from '../core/diagnostics.mjs';
import {Workbench} from '../core/service.mjs';
import {AdbTools} from '../core/adb.mjs';

async function fixture(t){
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'aiui-development-')));
  const w=await new Workbench(home).init();
  t.after(async()=>{await w.close();await fs.rm(home,{recursive:true,force:true});});
  return {w,home};
}
const steps=[{action:'tap',expect:{logContains:'APP_CHECKED true'}}];
async function finish(w,job){while(job.status==='running')job=await w.jobs.wait(job.id,1000);return job;}
function runtimeFixture(w){
  const counts={preview:0,build:0,install:0,launch:0,screenshot:0};
  const device={serial:'test-glasses',status:'device',inspection:{developerMode:'enabled',runtimeReady:true}};
  let devices=[];w.devices.check=async()=>({adb:true,aix:true,devices});
  w.automation.test=async args=>w.jobs.start('preview-test',args.projectId,async()=>{counts.preview++;return {passed:true,assertionsEvaluated:1,revision:w.projects.get(args.projectId).revision,capture:{path:'/simulated-test-capture.png'},logs:[]};});
  w.automation.build=async args=>w.jobs.start('build',args.projectId,async()=>{counts.build++;return {artifact:{path:'/test.aix'},check:{passed:true}};});
  w.cli=async args=>{if(args[0]==='install')counts.install++;if(args[0]==='launch-page')counts.launch++;return {code:0,output:'ok'};};
  w.glasses.screenshot=async()=>{counts.screenshot++;return {path:'/device-test.png',data:'test-only'};};
  w.glasses.logs=async()=>({path:'/device-test.log'});w.glasses.info=async()=>({system:{build:'test'}});
  return {counts,connect:()=>{devices=[device];},unauthorized:()=>{devices=[{...device,status:'unauthorized'}];}};
}

test('diagnostics survive restart, redact credentials, deduplicate and expose resolved cursor updates',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-diagnostic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const d=await new Diagnostics(dir).init();const error=new Error('fetch failed Bearer private-credential');
  const first=await d.record(error,{tool:'upload',context:{token:'private',pairingCode:'123456',path:'/project/file.ink'}});
  const cursor=first.sequence;const second=await d.record(error,{tool:'upload'});
  assert.equal(first.id,second.id);assert.equal(second.occurrences,2);assert.ok(!JSON.stringify(d.get()).includes('private-credential'));
  assert.ok(!JSON.stringify(d.get()).includes('123456'));assert.equal(d.get({afterSequence:cursor}).items.length,1);
  const reopened=await new Diagnostics(dir).init();assert.equal(reopened.get().items[0].id,first.id);
  await reopened.resolve({diagnosticIds:[first.id],note:'verified'});assert.equal(reopened.get({status:'open'}).items.length,0);assert.equal(reopened.get({afterSequence:second.sequence}).items[0].status,'resolved');
});

test('failed desktop operations and jobs retain stacks and can be discovered by another AI call',async t=>{
  const {w,home}=await fixture(t);let failure;
  try{await w.call('aiui_project_import',{directory:path.join(home,'absent')},'desktop');}catch(e){failure=e;}
  assert.ok(failure.diagnosticId);
  const result=await w.call('aiui_diagnostics_get',{diagnosticId:failure.diagnosticId},'MCP');
  assert.equal(result.items[0].actor,'desktop');assert.match(result.items[0].stack,/ENOENT/);assert.equal(result.items[0].context.directory,path.join(home,'absent'));
  const job=w.jobs.start('check',null,async()=>{throw Object.assign(new Error('compiler error'),{result:{diagnostics:[{path:'index.ink',line:4}]}});});
  const done=await finish(w,job);assert.equal(done.status,'failed');assert.ok(done.diagnosticId);assert.match(done.errorStack,/compiler error/);
  assert.equal(w.diagnostics.get({diagnosticId:done.diagnosticId}).items[0].details.diagnostics[0].line,4);
});

test('diagnostics show recent problems by default and preserve explicit cursor pagination',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-diagnostic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const d=await new Diagnostics(dir).init();
  for(let i=1;i<=5;i++)await d.record(new Error('problem '+i));
  assert.deepEqual(d.get({limit:2}).items.map(x=>x.sequence),[4,5]);
  const first=d.get({afterSequence:0,limit:2});assert.deepEqual(first.items.map(x=>x.sequence),[1,2]);assert.equal(first.nextSequence,2);
  assert.deepEqual(d.get({afterSequence:first.nextSequence,limit:2}).items.map(x=>x.sequence),[3,4]);
});

test('a damaged diagnostic journal preserves its bytes and does not disable recovery tools',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-diagnostic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'diagnostics.json'),'{damaged');const d=await new Diagnostics(dir).init();
  assert.equal(d.get().items.length,1);assert.match(d.get().items[0].message,/已保留备份/);
  const backup=(await fs.readdir(dir)).find(x=>x.startsWith('diagnostics.json.backup-'));assert.equal(await fs.readFile(path.join(dir,backup),'utf8'),'{damaged');
  assert.equal((await new Diagnostics(dir).init()).get().items.length,1);
});

test('one request creates a project without a supplied path and repeated requestId is idempotent',async t=>{
  const {w,home}=await fixture(t);
  const [a,b]=await Promise.all([w.call('aiui_workflow_start',{request:'做一个清单',requestId:'same'}),w.call('aiui_workflow_start',{request:'做一个清单',requestId:'same'})]);
  assert.equal(a.workflow.id,b.workflow.id);assert.equal(w.projects.items.length,1);assert.ok(a.workflow.projectPath.startsWith(path.join(home,'projects')));
  assert.match(await fs.readFile(path.join(a.workflow.projectPath,'AGENTS.md'),'utf8'),/一次物理滑动/);
  assert.match(await fs.readFile(path.join(a.workflow.projectPath,'lib/temple-navigation.js'),'utf8'),/excludeBlockedTime/);
  assert.match(a.context.developmentGuide,/aiui_workflow_continue/);
});

test('device blocker returns concrete user steps and resuming preserves preview and build evidence',async t=>{
  const {w}=await fixture(t),f=runtimeFixture(w),{workflow}=await w.call('aiui_workflow_start',{request:'做清单'});
  const blocked=await w.call('aiui_workflow_continue',{workflowId:workflow.id,steps});
  assert.equal(blocked.status,'succeeded');assert.equal(blocked.result.workflow.state,'waiting-user');assert.equal(blocked.result.workflow.nextAction.code,'no-device');assert.match(blocked.result.workflow.nextAction.steps.join(' '),/ADB/);
  assert.equal(f.counts.preview,1);assert.equal(f.counts.build,1);assert.equal(f.counts.install,0);
  f.unauthorized();const unauthorized=await w.call('aiui_workflow_continue',{workflowId:workflow.id});assert.equal(unauthorized.result.workflow.nextAction.code,'unauthorized');
  f.connect();const complete=await w.call('aiui_workflow_continue',{workflowId:workflow.id});assert.equal(complete.result.workflow.state,'completed');assert.equal(complete.result.deviceVerified,false);assert.equal(f.counts.preview,1);assert.equal(f.counts.build,1);assert.equal(f.counts.install,1);
  assert.equal(w.projects.items.length,1);
});

test('new source invalidates prior evidence, and new assertions rerun the preview without needless reinstall',async t=>{
  const {w}=await fixture(t),f=runtimeFixture(w),{workflow}=await w.call('aiui_workflow_start',{request:'做清单',target:'package'});
  await w.call('aiui_workflow_continue',{workflowId:workflow.id,steps});
  await w.call('aiui_workflow_continue',{workflowId:workflow.id,steps:[{action:'tap',expect:{logContains:'APP_NEW'}}]});
  assert.equal(f.counts.preview,2);assert.equal(f.counts.build,1);
  await fs.appendFile(path.join(workflow.projectPath,'pages/index/index.ink'),'\n<!-- edited -->');
  await w.projects.refresh(workflow.projectId);assert.equal(w.workflows.get({workflowId:workflow.id}).workflow.stale,true);
  await w.call('aiui_workflow_continue',{workflowId:workflow.id});assert.equal(f.counts.preview,3);assert.equal(f.counts.build,2);
});

test('missing behavior assertions stays with AI and does not claim functional completion',async t=>{
  const {w}=await fixture(t);runtimeFixture(w);const {workflow}=await w.call('aiui_workflow_start',{request:'做清单',target:'package'});
  const result=await w.call('aiui_workflow_continue',{workflowId:workflow.id});
  assert.equal(result.result.workflow.state,'needs-ai');assert.equal(result.result.workflow.nextAction.code,'behavior-assertions');assert.equal(result.result.needsUserAction,false);
});

test('failed device evidence can resume without repeating a successful install or launch',async t=>{
  const {w}=await fixture(t),f=runtimeFixture(w);f.connect();const {workflow}=await w.call('aiui_workflow_start',{request:'做清单'});
  const capture=w.glasses.screenshot;w.glasses.screenshot=async()=>{throw new Error('device capture temporarily failed');};
  const failed=await w.call('aiui_workflow_continue',{workflowId:workflow.id,steps});assert.equal(failed.status,'failed');assert.ok(failed.result.diagnostic);
  w.glasses.screenshot=capture;const done=await w.call('aiui_workflow_continue',{workflowId:workflow.id});assert.equal(done.result.workflow.state,'completed');assert.equal(f.counts.install,1);assert.equal(f.counts.launch,1);
});

test('unsupported simulator services can explicitly continue on glasses without claiming functional verification',async t=>{
  const {w}=await fixture(t),f=runtimeFixture(w),{workflow}=await w.call('aiui_workflow_start',{request:'拍照后让真实模型识别并朗读'});
  const verification={mode:'device',reason:'模拟器没有真实模型和语音服务，安装后检查真机识别结果与声音'};
  const blocked=await w.call('aiui_workflow_continue',{workflowId:workflow.id,verification});
  assert.equal(blocked.result.workflow.state,'waiting-user');assert.equal(blocked.result.workflow.nextAction.code,'no-device');
  assert.equal(f.counts.preview,0);assert.equal(f.counts.build,1);assert.equal(blocked.result.workflow.evidence.previewSkipped.simulatorVerified,false);
  f.connect();const result=await w.call('aiui_workflow_continue',{workflowId:workflow.id});
  assert.equal(result.status,'succeeded');assert.equal(result.result.functionalValidation,'pending-on-device');assert.equal(result.result.deviceVerified,false);assert.equal(f.counts.install,1);assert.equal(f.counts.build,1);
  assert.ok(!result.result.workflow.evidence.preview);assert.match(result.result.workflow.nextAction.steps.join(' '),/未验证/);
  const packageOnly=await w.call('aiui_workflow_start',{request:'只打包',target:'package'});
  await assert.rejects(w.call('aiui_workflow_continue',{workflowId:packageOnly.workflow.id,verification}),/只打包/);
});

test('a repaired workflow resolves its own previous failures and keeps unrelated diagnostics open',async t=>{
  const {w}=await fixture(t),f=runtimeFixture(w),{workflow}=await w.call('aiui_workflow_start',{request:'做清单',target:'package'});
  const own=await w.diagnostics.record(new Error('old runtime failure'),{source:'preview-log',projectId:workflow.projectId,workflowId:workflow.id,stage:'preview'});
  const other=await w.diagnostics.record(new Error('unrelated network problem'),{projectId:workflow.projectId});
  const done=await w.call('aiui_workflow_continue',{workflowId:workflow.id,steps});
  assert.equal(done.result.workflow.state,'completed');assert.equal(w.diagnostics.get({diagnosticId:own.id}).items[0].status,'resolved');assert.equal(w.diagnostics.get({diagnosticId:other.id}).items[0].status,'open');assert.equal(f.counts.preview,1);
});

test('source changes before device deployment stop an unverified install',async t=>{
  const {w}=await fixture(t),f=runtimeFixture(w);f.connect();const {workflow}=await w.call('aiui_workflow_start',{request:'做清单'});
  const build=w.automation.build;w.automation.build=async args=>{const job=await build(args);await finish(w,job);await fs.appendFile(path.join(workflow.projectPath,'pages/index/index.ink'),'\n<!-- concurrent edit -->');return w.jobs.get(job.id);};
  const result=await w.call('aiui_workflow_continue',{workflowId:workflow.id,steps});assert.equal(result.status,'failed');assert.equal(f.counts.install,0);assert.match(result.error,/变化/);
});

test('service log body works without starting a daemon and wireless ADB validates input',async t=>{
  const {home}=await fixture(t);await fs.writeFile(path.join(home,'service.log'),'startup failed Bearer hidden-token');
  const log=await readServiceLog(home);assert.match(log.content,/startup failed/);assert.ok(!log.content.includes('hidden-token'));
  const adb=new AdbTools(home);let args;adb.execute=async a=>{args=a;return {code:0,output:'connected to 192.168.1.2:5555'};};
  await adb.connect({address:'192.168.1.2:5555'});assert.deepEqual(args,['connect','192.168.1.2:5555']);
  await assert.rejects(adb.connect({address:'-s other'}),/IP/);await assert.rejects(adb.connect({address:'192.168.1.2:5555',pairingCode:'$(bad)'}),/六位/);
  adb.execute=async()=>({code:0,output:'failed to connect'});await assert.rejects(adb.connect({address:'192.168.1.2:5555'}),/连接失败/);
});
