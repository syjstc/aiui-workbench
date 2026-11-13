import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Workbench} from '../core/service.mjs';
async function fixture(t){const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'aiui-source-')));const w=await new Workbench(home).init();t.after(async()=>{await w.close();await fs.rm(home,{recursive:true,force:true});});const {workflow}=await w.call('aiui_workflow_start',{request:'制作清单'});return {w,home,p:w.projects.get(workflow.projectId)};}

test('an MCP-only AI can read instructions, list and edit real source with a revision precondition',async t=>{
 const {w,p}=await fixture(t);const context=await w.call('aiui_context_get',{projectId:p.id});assert.match(context.projectInstructions,/一次物理滑动/);
 await fs.chmod(path.join(p.agentPath,'pages/index/index.ink'),0o600);
 const list=await w.call('aiui_project_files',{projectId:p.id,action:'list'});assert.ok(list.files.some(f=>f.path==='pages/index/index.ink'));assert.ok(!list.files.some(f=>f.path.startsWith('.')));
 const read=await w.call('aiui_project_files',{projectId:p.id,action:'read',paths:['pages/index/index.ink','AGENTS.md']});assert.match(read.files[1].content,/一次物理滑动/);
 const content=read.files[0].content+'\n<!-- MCP source edit -->';
 const written=await w.call('aiui_project_files',{projectId:p.id,action:'write',expectedRevision:read.revision,files:[{path:'pages/index/index.ink',content},{path:'lib/new-module.js',content:'export const value=1;'}]});
 assert.equal(written.written.length,2);assert.notEqual(written.revision,read.revision);assert.equal(await fs.readFile(path.join(p.agentPath,'pages/index/index.ink'),'utf8'),content);assert.equal(w.projects.get(p.id).revision,written.revision);assert.equal((await fs.stat(path.join(p.agentPath,'pages/index/index.ink'))).mode&0o777,0o600);
});

test('a stale AI write preserves newer user edits and reports the actual revision',async t=>{
 const {w,p}=await fixture(t),before=await w.call('aiui_project_files',{projectId:p.id,action:'list'});const file=path.join(p.agentPath,'pages/index/index.ink');await fs.writeFile(file,'newer user source');
 await assert.rejects(w.call('aiui_project_files',{projectId:p.id,action:'write',expectedRevision:before.revision,files:[{path:'pages/index/index.ink',content:'old AI edit'}]}),e=>!!e.result.currentRevision&&e.result.written.length===0);
 assert.equal(await fs.readFile(file,'utf8'),'newer user source');
});

test('preflight rejects traversal, symlinks, hidden configuration and instruction writes before touching any file',async t=>{
 const {w,p,home}=await fixture(t),before=await w.call('aiui_project_files',{projectId:p.id,action:'read',paths:['pages/index/index.ink']});
 await fs.writeFile(path.join(home,'outside.js'),'outside');await fs.symlink(path.join(home,'outside.js'),path.join(p.agentPath,'escape.js'));
 for(const target of ['../outside.js','.mcp.json','node_modules/a.js','agents.md','escape.js','lib']){
  await assert.rejects(w.call('aiui_project_files',{projectId:p.id,action:'write',expectedRevision:before.revision,files:[{path:'pages/index/index.ink',content:'should not write'},{path:target,content:'unsafe'}]}));
  assert.equal(await fs.readFile(path.join(p.agentPath,'pages/index/index.ink'),'utf8'),before.files[0].content);
 }
 await assert.rejects(w.call('aiui_project_files',{projectId:p.id,action:'read',paths:['escape.js']}),/符号链接/);assert.equal(await fs.readFile(path.join(home,'outside.js'),'utf8'),'outside');
});

test('broken app metadata can be read and repaired while an invalid replacement and active-job edits are refused',async t=>{
 const {w,p}=await fixture(t),appPath=path.join(p.agentPath,'app.json'),original=await fs.readFile(appPath,'utf8');await fs.writeFile(appPath,'{broken');
 const broken=await w.call('aiui_project_files',{projectId:p.id,action:'read',paths:['app.json']});assert.equal(broken.files[0].content,'{broken');
 await assert.rejects(w.call('aiui_project_files',{projectId:p.id,action:'write',expectedRevision:broken.revision,files:[{path:'app.json',content:'{bad replacement'}]}));assert.equal(await fs.readFile(appPath,'utf8'),'{broken');
 const fixed=await w.call('aiui_project_files',{projectId:p.id,action:'write',expectedRevision:broken.revision,files:[{path:'app.json',content:original}]});assert.ok(!fixed.metadataError);
 let release;const job=w.jobs.start('build',p.id,()=>new Promise(r=>{release=r;}));
 await assert.rejects(w.call('aiui_project_files',{projectId:p.id,action:'write',expectedRevision:fixed.revision,files:[{path:'new.js',content:'test'}]}),/任务运行/);release({});await w.jobs.wait(job.id,1000);
});
