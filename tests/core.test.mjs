import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Projects,collectFiles } from '../core/projects.mjs';
import { Workbench } from '../core/service.mjs';
import { Knowledge } from '../core/knowledge.mjs';
import { Jobs } from '../core/jobs.mjs';
import { startDaemon } from '../core/daemon.mjs';
import { atomicJson,inside,safeRelative,sleep } from '../core/util.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-workbench-test-'));const closers=[];t.after(async()=>{for(const close of closers.reverse())await close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});const project=path.join(root,'project');await fs.mkdir(path.join(project,'agent/pages/index'),{recursive:true});await atomicJson(path.join(project,'agent/app.json'),{name:'Test',version:'1.0.0',pages:['pages/index/index'],permissions:[]});await fs.writeFile(path.join(project,'agent/pages/index/index.ink'),'<script def>{}</script><script setup>export default {}</script><page><text>hello</text></page>');return{root,project,home:path.join(root,'home'),cleanup:close=>closers.push(close)};}
test('registry deduplicates canonical directories and follows externally edited source',async t=>{const f=await fixture(t),events=[];const p=await new Projects(f.home,(...e)=>events.push(e)).init();f.cleanup(()=>p.close());const first=await p.import(f.project),initial=first.revision;assert.equal((await p.import(path.join(f.project,'agent'))).id,first.id);assert.equal(p.list().length,1);first.lastCheck={passed:true};await sleep(150);await fs.appendFile(path.join(first.agentPath,'pages/index/index.ink'),'\n<!-- external edit -->');for(let i=0;i<50&&!events.some(e=>e[0]==='source-changed');i++)await sleep(100);assert.notEqual(first.revision,initial);assert.equal(first.lastCheck.stale,true);assert.ok(events.some(e=>e[0]==='source-changed'));});
test('an explicit refresh cannot consume a change before the watcher notifies active previews',async t=>{const f=await fixture(t),events=[],p=await new Projects(f.home,(...e)=>events.push(e)).init();f.cleanup(()=>p.close());const item=await p.import(f.project);await fs.appendFile(path.join(item.agentPath,'pages/index/index.ink'),'\n<!-- changed -->');await p.refresh(item.id);assert.equal(events.filter(e=>e[0]==='source-changed').length,1);await sleep(650);assert.equal(events.filter(e=>e[0]==='source-changed').length,1);});
test('closing the registry drains an in-flight watcher refresh before its data directory can be removed',async t=>{
  const f=await fixture(t),p=await new Projects(f.home,()=>{}).init();f.cleanup(()=>p.close());
  const item=await p.import(f.project),entered=Promise.withResolvers(),proceed=Promise.withResolvers(),watcherClosed=Promise.withResolvers();
  const refresh=p.refresh.bind(p);
  p.refresh=async(...args)=>{entered.resolve();await proceed.promise;return refresh(...args);};
  const watcher=p.watchers.get(item.id).watcher,nativeClose=watcher.close.bind(watcher);
  watcher.close=async()=>{await nativeClose();watcherClosed.resolve();};
  await entered.promise;
  let finished=false;const closing=p.close().then(()=>{finished=true;});
  await watcherClosed.promise;await new Promise(setImmediate);
  try {assert.equal(finished,false,'close must wait for the refresh and its queued project save');}
  finally {proceed.resolve();await closing;}
  await fs.rm(f.home,{recursive:true,force:true});await new Promise(setImmediate);
  await assert.rejects(fs.access(f.home),{code:'ENOENT'});
});
test('bundle excludes private caches, ignored files and symlinks outside project',async t=>{const f=await fixture(t),root=path.join(f.project,'agent');await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules/secret.js'),'private');await fs.writeFile(path.join(root,'local.txt'),'private');await fs.writeFile(path.join(root,'.aixignore'),'local.txt');const external=path.join(f.root,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,'private.txt'),'private');await fs.symlink(external,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');const names=(await collectFiles(root)).map(f=>f.path);assert.ok(!names.includes('local.txt'));assert.ok(!names.includes('escape'));assert.ok(!names.some(n=>n.startsWith('node_modules/')));});
test('resource paths cannot escape through traversal or symlinks',async t=>{const f=await fixture(t);assert.throws(()=>safeRelative('../secret'));assert.throws(()=>safeRelative('/etc/hosts'));assert.throws(()=>safeRelative('a\\..\\secret'));const external=path.join(f.root,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,'private.txt'),'private');await fs.symlink(external,path.join(f.project,'outside'),process.platform==='win32'?'junction':'dir');await assert.rejects(inside(f.project,'outside/private.txt'),/超出/);});
test('desktop and MCP share registry data across service restart',async t=>{const f=await fixture(t),s=await new Workbench(f.home).init();const p=await s.call('aiui_project_import',{directory:f.project},'MCP');assert.equal((await s.call('aiui_projects_list',{},'desktop')).projects[0].id,p.id);await s.close();const next=await new Workbench(f.home).init();f.cleanup(()=>next.close());assert.equal(next.projects.list()[0].agentPath,p.agentPath);});
test('project MCP installation merges other servers and excludes config from AIX',async t=>{const f=await fixture(t),s=await new Workbench(f.home).init();f.cleanup(()=>s.close());const p=await s.projects.import(f.project);await atomicJson(path.join(p.projectPath,'.mcp.json'),{mcpServers:{existing:{command:'kept'}},custom:true});await s.call('aiui_mcp_install_project',{projectId:p.id});const config=JSON.parse(await fs.readFile(path.join(p.projectPath,'.mcp.json'),'utf8'));assert.equal(config.mcpServers.existing.command,'kept');assert.equal(config.custom,true);assert.ok(config.mcpServers['aiui-workbench']);assert.match(await fs.readFile(path.join(p.agentPath,'.aixignore'),'utf8'),/\.mcp\.json/);assert.ok((await fs.readdir(p.projectPath)).some(n=>n.startsWith('.mcp.json.backup-')));});
test('official documents work offline from the bundled snapshot with source revision',async t=>{const f=await fixture(t),k=await new Knowledge(f.home).init();assert.ok(k.status().documents>100);const skill=await k.read('skills/aiui-dev/SKILL.md');assert.match(skill.content,/AIUI Development/);assert.match(skill.revision,/^[a-f0-9]{40}$/);assert.ok((await k.search('AbsoluteOrientationSensor')).length);await assert.rejects(k.read('../secret'));});
test('completed and cancelled jobs persist without serializing running promises',async t=>{const f=await fixture(t),jobs=await new Jobs(()=>{},f.home).init();let j=jobs.start('cancel-test',null,({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')))));jobs.cancel(j.id);for(let i=0;i<20&&jobs.get(j.id).status==='running';i++)await sleep(20);assert.equal(jobs.get(j.id).status,'cancelled');await jobs.close();const restored=await new Jobs(()=>{},f.home).init();assert.equal(restored.get(j.id).status,'cancelled');});
test('local service requires authentication and rejects foreign web origins',async t=>{const f=await fixture(t),daemon=await startDaemon(f.home);f.cleanup(()=>daemon.close());const{origin,token}=daemon.connection;assert.equal((await fetch(origin+'/health')).status,401);assert.equal((await fetch(origin+'/health',{headers:{Authorization:`Bearer ${token}`,Origin:'https://malicious.example'}})).status,403);const good=await fetch(origin+'/api/call',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({tool:'aiui_projects_list'})});assert.equal(good.status,200);assert.deepEqual((await good.json()).result.projects,[]);});
test('new official template engine declaration matches the actual WASM engine, not the npm wrapper version',async t=>{const f=await fixture(t),k=await new Knowledge(f.home).init(),p=await new Projects(f.home,()=>{}).init();f.cleanup(()=>p.close());const created=await p.create({directory:path.join(f.root,'created'),name:'Compatibility check'},k);const wasm=await import('../node_modules/@yodaos-pkg/ink/pkg/ink_web.js');await wasm.default({module_or_path:await fs.readFile(new URL('../node_modules/@yodaos-pkg/ink/pkg/ink_web_bg.wasm',import.meta.url))});assert.equal(wasm.get_version(),'0.19.0');assert.equal(wasm.get_bundle_version(),'0.19.1');assert.equal(wasm.satisfies_engine(created.engine),true);});
test('standalone daemon entry starts correctly inside a packaged path containing spaces',async t=>{
  const f=await fixture(t),appRoot=path.join(f.root,'AIUI Workshop.app','Resources','app');
  await fs.mkdir(appRoot,{recursive:true});
  await fs.cp(new URL('../core',import.meta.url),path.join(appRoot,'core'),{recursive:true});
  await fs.cp(new URL('../shared',import.meta.url),path.join(appRoot,'shared'),{recursive:true});
  await fs.copyFile(new URL('../package.json',import.meta.url),path.join(appRoot,'package.json'));
  await fs.symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),path.join(appRoot,'node_modules'),process.platform==='win32'?'junction':'dir');
  const child=spawn(process.execPath,[path.join(appRoot,'core/daemon.mjs')],{env:{...process.env,AIUI_WORKBENCH_HOME:f.home},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  f.cleanup(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}});
  let connection;
  for(let i=0;i<40&&child.exitCode===null;i++){
    try{connection=JSON.parse(await fs.readFile(path.join(f.home,'connection.json'),'utf8'));break;}catch{}
    await sleep(100);
  }
  assert.ok(connection,`standalone service must create its connection file: ${stderr}`);
  assert.equal((await fetch(connection.origin+'/health',{headers:{Authorization:`Bearer ${connection.token}`}})).status,200);
  child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
});
