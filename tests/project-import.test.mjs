import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Projects} from '../core/projects.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-import-')),directory=path.join(root,'project');
  await fs.mkdir(directory);await fs.writeFile(path.join(directory,'app.json'),JSON.stringify({name:'Import example',pages:['index']}));await fs.writeFile(path.join(directory,'index.ink'),'<page/>');
  const projects=await new Projects(path.join(root,'home'),()=>{}).init();
  t.after(async()=>{await projects.close();await fs.rm(root,{recursive:true,force:true});});
  return {projects,directory};
}
test('slow imports stay absent from status until complete, and concurrent imports share one project',async t=>{
  const {projects,directory}=await fixture(t);
  let release,entered;const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),refresh=projects.refreshItem.bind(projects);
  projects.refreshItem=async(...args)=>{entered();await waiting;return refresh(...args);};
  const first=projects.import(directory);await started;
  assert.deepEqual(projects.list(),[]);await assert.rejects(fs.access(projects.file),{code:'ENOENT'});
  const second=projects.import(directory);release();
  const [a,b]=await Promise.all([first,second]);assert.equal(a.id,b.id);assert.equal(projects.list().length,1);assert.equal(a.name,'Import example');assert.deepEqual(a.pages,['index']);assert.match(a.revision,/^[a-f\d]{64}$/);
});
test('a failed metadata read does not publish or persist an incomplete project',async t=>{
  const {projects,directory}=await fixture(t);
  projects.refreshItem=async()=>{throw new Error('Read interrupted');};
  await assert.rejects(projects.import(directory),/Read interrupted/);assert.deepEqual(projects.list(),[]);assert.equal(projects.pendingImports.size,0);await assert.rejects(fs.access(projects.file),{code:'ENOENT'});
});
