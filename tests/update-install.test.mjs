import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync,strToU8 } from 'fflate';
import { validateUpdateArchive,macInstallScript,prepareMacUpdate,finishMacUpdate } from '../core/update-install.mjs';
import { run,sha,atomicJson } from '../core/util.mjs';

test('upgrade ZIP entries cannot escape the staging directory',()=>{
  validateUpdateArchive(zipSync({'AIUI Workshop.app/Contents/Info.plist':strToU8('fixture')}));
  for(const name of ['../escape','/absolute','C:/escape','a\\b'])assert.throws(()=>validateUpdateArchive(zipSync({[name]:strToU8('x')})),/不安全/);
});
test('framework symlinks stay inside the app before the archive is extracted',()=>{
  const name='AIUI Workshop.app/Contents/Frameworks/Test.framework/Test';
  function archive(link){const bytes=Buffer.from(zipSync({[name]:strToU8(link)}));const central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(0xa1ff0000,central+38);return bytes;}
  validateUpdateArchive(archive('Versions/Current/Test'));
  for(const link of ['/tmp/outside','../../../../../outside','../../../../outside'])assert.throws(()=>validateUpdateArchive(archive(link)),/符号链接/);
});
test('download bytes are reverified before extracting or replacing an application',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-install-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const target=path.join(home,'Old.app');await fs.mkdir(target);
  const archive=path.join(home,'app.zip');await fs.writeFile(archive,'modified bytes');
  await assert.rejects(prepareMacUpdate({home,target,pid:123,downloaded:{path:archive,version:'9.0.0',sha256:'a'.repeat(64),size:14},command:()=>assert.fail('No command before checksum verification')}),/校验失败/);
  await fs.access(target);
});
test('a mismatched application identity cannot prepare an upgrade',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-install-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const target=path.join(home,'Old.app');await fs.mkdir(target);
  const archive=path.join(home,'app.zip'),bytes=zipSync({'AIUI Workshop.app/Contents/Info.plist':strToU8('fixture')});await fs.writeFile(archive,bytes);
  await assert.rejects(prepareMacUpdate({home,target,pid:123,downloaded:{path:archive,version:'9.0.0',sha256:sha(bytes),size:bytes.length},command:async(name,args)=>({code:0,output:name==='plutil'?(args[1]==='CFBundleIdentifier'?'different.application':'9.0.0'):''})}),/身份或版本/);
  assert.equal((await fs.readdir(home)).some(name=>name.includes('.next-')),false);await fs.access(target);
});
for(const missing of [false,true])test(missing?'failed replacement restores the previous app':'the detached installer replaces only the app and preserves project data',{skip:process.platform==='win32'},async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-install-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const target=path.join(home,'App with spaces.app'),next=target+'.next-test',backup=target+'.backup-test',result=path.join(home,'result.txt'),script=path.join(home,'install.sh');
  await fs.mkdir(target);await fs.writeFile(path.join(target,'version'),'old');await fs.writeFile(path.join(home,'project.ink'),'user source');
  if(!missing){await fs.mkdir(next);await fs.writeFile(path.join(next,'version'),'new');}
  await fs.writeFile(script,macInstallScript());
  const process=await run('/bin/sh',[script,'2147483647',next,target,backup,result,'/usr/bin/true',home]);
  assert.equal(process.code,missing?1:0);assert.equal(await fs.readFile(path.join(target,'version'),'utf8'),missing?'old':'new');assert.equal(await fs.readFile(path.join(home,'project.ink'),'utf8'),'user source');assert.equal((await fs.readFile(result,'utf8')).trim(),missing?'rollback':'installed');
});
test('only a successfully started target version removes its own application backup',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-install-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const target=path.join(home,'App.app'),backup=target+'.backup-ab12';await fs.mkdir(backup);
  await atomicJson(path.join(home,'update-install.json'),{version:'9.0.0',target,backup,phase:'prepared'});
  assert.equal(await finishMacUpdate(home,{target,version:'8.0.0'}),false);await fs.access(backup);
  assert.equal(await finishMacUpdate(home,{target,version:'9.0.0'}),true);await assert.rejects(fs.access(backup),{code:'ENOENT'});
});
