import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Diagnostics } from '../core/diagnostics.mjs';
import { Workbench } from '../core/service.mjs';

async function journal(t) {
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'aiui-diagnostic-read-')));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  return {home,d:await new Diagnostics(home).init()};
}
async function fixture(t) {
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'aiui-diagnostic-scope-'))),w=await new Workbench(home).init();
  t.after(async()=>{await w.close();await fs.rm(home,{recursive:true,force:true});});
  const a=await w.projects.create({directory:path.join(home,'project-a'),name:'同名应用'},w.knowledge);
  const b=await w.projects.create({directory:path.join(home,'project-b'),name:'同名应用'},w.knowledge);
  return {home,w,a,b};
}

test('read persists separately from repair and another occurrence becomes unread again',async t=>{
  const {home,d}=await journal(t);
  const first=await d.record(new Error('application failure'),{projectId:'a'});
  const read=await d.read({projectId:'a',read:false},'MCP');
  assert.deepEqual(read.readIds,[first.id]);assert.ok(read.items[0].readAt);
  const reopened=await new Diagnostics(home).init();
  assert.equal(reopened.get({read:false}).items.length,0);
  const retained=reopened.get({read:true}).items[0];
  assert.equal(retained.status,'open');assert.equal(retained.readBy,'MCP');
  assert.equal(reopened.get().readOpenCount,1);
  const again=await reopened.record(new Error('application failure'),{projectId:'a'});
  assert.equal(again.id,first.id);assert.equal(again.occurrences,2);assert.equal(again.readAt,null);
  assert.equal(reopened.get({read:false}).items.length,1);
  await reopened.resolve({diagnosticIds:[first.id],note:'Reverified'});
  assert.equal(reopened.get({status:'open'}).items.length,0);
});

test('limited reads acknowledge only returned versions and never consume a queued new occurrence',async t=>{
  const {d}=await journal(t);
  const first=await d.record(new Error('first'));
  const second=await d.record(new Error('second'));
  const stale=d.get({read:false,limit:1});assert.equal(stale.hasMore,true);
  await d.record(new Error('second'));
  assert.deepEqual((await d.markRead(stale.items,'MCP')).readIds,[]);
  assert.equal(d.get({read:false}).items.length,2);
  await d.read({limit:1,markRead:false},'MCP');assert.equal(d.get().unreadCount,2);
  await d.read({limit:1},'CLI');
  assert.deepEqual(d.get({read:false}).items.map(item=>item.id),[first.id]);
  assert.equal(d.get({diagnosticId:second.id}).items[0].readBy,'CLI');
  assert.equal(d.get({afterSequence:stale.nextSequence}).items[0].id,second.id);
});

test('session, job, workflow and directory evidence identify projects even with identical names',async t=>{
  const {w,a,b}=await fixture(t);
  const session=w.previews.open(a.id,'http://127.0.0.1');
  const job=w.jobs.start('check',b.id,async()=>({passed:true}));await w.jobs.wait(job.id);
  w.workflows.items.push({id:'flow-a',projectId:a.id});
  for(const [context,project] of [[{sessionId:session.id},a],[{jobId:job.id},b],[{workflowId:'flow-a'},a],[{tool:'aiui_project_import',context:{directory:b.projectPath}},b]]){
    const diagnostic=await w.captureDiagnostic(new Error('same failure'),context);
    assert.equal(diagnostic.projectId,project.id);assert.equal(diagnostic.projectName,project.name);assert.equal(diagnostic.projectPath,project.projectPath);assert.equal(diagnostic.scope,'project');
  }
  const outside=await w.captureDiagnostic(new Error('missing path'),{tool:'aiui_project_import',context:{directory:a.projectPath+'-other'}});
  assert.equal(outside.scope,'unassigned');assert.equal(outside.projectId,undefined);
  const conflict=await w.captureDiagnostic(new Error('conflicting identity'),{projectId:b.id,sessionId:session.id});
  assert.equal(conflict.scope,'unassigned');assert.equal(conflict.projectId,undefined);assert.equal(conflict.association,'conflict');
  const global=await w.captureDiagnostic(new Error('old sync failure'),{source:'job',tool:'knowledge',jobId:'removed-global-job'});
  assert.equal(global.scope,'workbench');
  const unknown=await w.captureDiagnostic(new Error('old preview failure'),{source:'job',tool:'preview-test',jobId:'removed-project-job'});
  assert.equal(unknown.scope,'unassigned');
});

test('desktop polling and discovery preserve unread; project AI calls consume only their own scope',async t=>{
  const {w,a,b}=await fixture(t);
  const own=await w.captureDiagnostic(new Error('same failure'),{projectId:a.id});
  const other=await w.captureDiagnostic(new Error('same failure'),{projectId:b.id});
  const environment=await w.captureDiagnostic(new Error('network temporarily unavailable'),{source:'startup'});
  await w.call('aiui_diagnostics_get',{status:'open'},'desktop');
  await w.call('aiui_tools_list',{},'MCP');await w.call('aiui_status',{},'MCP-discovery');
  assert.equal(w.diagnostics.get().unreadCount,3);
  const result=await w.call('aiui_project_refresh',{projectId:a.id},'MCP');
  assert.equal(w.projects.get(a.id).sharedDiagnostics,undefined);
  assert.deepEqual(new Set(result.sharedDiagnostics.items.map(item=>item.id)),new Set([own.id,environment.id]));
  assert.ok(result.sharedDiagnostics.items.every(item=>item.readBy==='MCP'));
  assert.equal(w.diagnostics.get({diagnosticId:other.id}).unreadCount,1);
  assert.equal(w.diagnostics.get({diagnosticId:own.id}).items[0].status,'open');
  const repeated=await w.call('aiui_project_refresh',{projectId:a.id},'MCP');assert.equal(repeated.sharedDiagnostics,undefined);
  const general=await w.call('aiui_status',{},'MCP');
  assert.equal(general.sharedDiagnostics,undefined);assert.equal(general.diagnostics.latest,undefined);
  assert.equal(w.diagnostics.get({projectId:b.id}).unreadCount,1);
  await w.call('aiui_project_refresh',{projectId:b.id},'CLI');
  assert.equal(w.diagnostics.get({diagnosticId:other.id}).items[0].readBy,'CLI');
});

test('AI reads inferred from session and job arguments stay scoped to that project',async t=>{
  const {w,a,b}=await fixture(t),session=w.previews.open(a.id,'http://127.0.0.1');
  const own=await w.captureDiagnostic(new Error('preview failure'),{sessionId:session.id});
  const other=await w.captureDiagnostic(new Error('unrelated build failure'),{projectId:b.id});
  const result=await w.call('aiui_preview_state',{sessionId:session.id},'MCP');
  assert.deepEqual(result.sharedDiagnostics.items.map(item=>item.id),[own.id]);
  const job=w.jobs.start('check',b.id,async()=>({passed:true}));await w.jobs.wait(job.id);
  const done=await w.call('aiui_job_get',{jobId:job.id},'MCP');
  assert.deepEqual(done.sharedDiagnostics.items.map(item=>item.id),[other.id]);
});

test('tool failures deliver their diagnostic inline and mark it read without resolving it',async t=>{
  const {w,a,b}=await fixture(t);
  const other=await w.captureDiagnostic(new Error('other failure'),{projectId:b.id});
  await assert.rejects(w.call('aiui_project_files',{projectId:a.id,action:'read',paths:['absent.ink']},'MCP'),error=>{
    const diagnostic=error.sharedDiagnostics.items.find(item=>item.id===error.diagnosticId);
    assert.equal(diagnostic.projectId,a.id);assert.equal(diagnostic.projectPath,a.projectPath);assert.ok(diagnostic.stack);assert.ok(diagnostic.readAt);assert.equal(diagnostic.status,'open');return true;
  });
  assert.equal(w.diagnostics.get({diagnosticId:other.id}).unreadCount,1);
});

test('explicit AI inspection can opt out; manual read hides without resolving',async t=>{
  const {w,a}=await fixture(t),diagnostic=await w.captureDiagnostic(new Error('failure'),{projectId:a.id});
  await w.call('aiui_diagnostics_get',{diagnosticId:diagnostic.id,markRead:false},'MCP');
  assert.equal(w.diagnostics.get().unreadCount,1);
  await w.call('aiui_diagnostics_mark_read',{diagnosticIds:[diagnostic.id]},'desktop');
  assert.equal(w.diagnostics.get({read:false}).items.length,0);assert.equal(w.diagnostics.get({read:true}).items[0].status,'open');
});

test('legacy job-only records gain persistent project identity after service restart',async t=>{
  const {home,w,a}=await fixture(t);
  const job=w.jobs.start('check',a.id,async()=>({passed:true}));await w.jobs.wait(job.id);await w.close();
  const legacy=await new Diagnostics(home).init();
  const diagnostic=await legacy.record(new Error('legacy check failure'),{jobId:job.id});
  const reopened=await new Workbench(home).init();
  try{
    const item=reopened.diagnostics.get({projectId:a.id}).items[0];
    assert.equal(item.id,diagnostic.id);assert.equal(item.projectPath,a.projectPath);assert.equal(item.projectName,a.name);
    assert.equal(item.revision,undefined);
    reopened.projects.items=[];
    const orphan=reopened.diagnostics.get({diagnosticId:diagnostic.id}).items[0];
    assert.equal(orphan.projectId,a.id);assert.equal(orphan.projectName,a.name);assert.equal(orphan.projectPath,a.projectPath);assert.equal(orphan.projectAvailable,false);
  }finally{await reopened.close();}
});
