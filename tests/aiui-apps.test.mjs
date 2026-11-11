import test from 'node:test';
import assert from 'node:assert/strict';
import { AiuiApps, installedAiuiApps } from '../core/aiui-apps.mjs';

const agentId='develop.rokid.agent.test-1', fileName=agentId+'.aix';
const entry={name:fileName,type:'file',bytes:128,modifiedAt:'2026-11-11T00:00:00Z'};
const metadata={agentId,fileName,agentName:'开发实验',nativeVersion:'0.1.0',inkVersion:'>=0.18.0'};
const manifest=packages=>({schemaVersion:1,packages});

test('AIUI inventory joins actual installed files with unique manifest identities, not names',()=>{
  const apps=installedAiuiApps([entry,{...entry,name:'orphan.aix'},{...entry,name:'agent.json'}],manifest([metadata,{...metadata,fileName:'missing.aix',agentId:'develop.rokid.agent.missing'}]),[{id:'local',agentId:'test-1',name:'开发实验',version:'0.2.0'}]);
  assert.equal(apps.length,2);
  const app=apps.find(app=>app.agentId===agentId);
  assert.equal(app.removable,true);assert.equal(app.version,'0.1.0');assert.equal(app.localProject.version,'0.2.0');
  assert.equal(apps.find(app=>app.fileName==='orphan.aix').removable,false);
});
test('ambiguous, store, mismatched and malformed AIUI identities cannot authorize removal',()=>{
  for(const packages of [[metadata,metadata],[{...metadata,agentId:'store.rokid.agent.test'}],[{...metadata,agentId:'develop.rokid.agent.other'}]]){
    assert.equal(installedAiuiApps([entry],manifest(packages))[0].removable,false);
  }
  assert.throws(()=>installedAiuiApps([entry],{packages:[]}),/无法识别/);
});
function fixture({stillInstalled=false,cliCode=0}={}){
  let installed=true;const calls=[];
  const glasses={ready:async()=>{},exclusive:async(serial,fn)=>fn(),files:async()=>({entries:installed?[entry]:[]}),shell:async()=>JSON.stringify(manifest([metadata]))};
  const cli=async(args,options)=>{calls.push(args);options.signal?.throwIfAborted();if(!cliCode&&!stillInstalled)installed=false;return {code:cliCode,output:cliCode?'remove failed':'localCompleted=true'};};
  return {apps:new AiuiApps(glasses,cli,{list:()=>[]}),calls};
}
test('AIUI uninstall requires exact confirmation and a currently verified installed identity',async()=>{
  const {apps,calls}=fixture();
  await assert.rejects(apps.uninstall({serial:'device',agentId,confirmAgentId:'different'}),/请确认/);
  await assert.rejects(apps.uninstall({serial:'device',agentId:'store.agent',confirmAgentId:'store.agent'}),/有效/);
  await assert.rejects(apps.uninstall({serial:'device',agentId:'develop.rokid.agent.other',confirmAgentId:'develop.rokid.agent.other'}),/身份未核实/);
  assert.equal(calls.length,0);
  const result=await apps.uninstall({serial:'device',agentId,confirmAgentId:agentId});
  assert.deepEqual(calls,[['uninstall',agentId,'--serial','device']]);assert.equal(result.localRemoved,true);assert.equal(result.cloudRemoval,'not-verified');
});
test('AIUI removal does not report success on CLI failure, remaining packages or cancellation',async()=>{
  for(const options of [{cliCode:1},{stillInstalled:true}]){
    const {apps}=fixture(options);await assert.rejects(apps.uninstall({serial:'device',agentId,confirmAgentId:agentId}),/remove failed|仍检测到/);
  }
  const {apps,calls}=fixture();await assert.rejects(apps.uninstall({serial:'device',agentId,confirmAgentId:agentId},{signal:AbortSignal.abort()}),{name:'AbortError'});assert.equal(calls.length,0);
});

test('an unreadable developer directory does not hide the separate read-only catalog or authorize removal',async()=>{
  const apps=new AiuiApps({files:async()=>{throw new Error('No such file or directory');}},async()=>{throw new Error('must not uninstall');},{list:()=>[]});
  apps.catalog.read=async()=>({apps:[{agentId:'builtin.rokid.example',source:'builtin',readOnly:true,removable:false}],sources:[{source:'builtin',status:'available',readOnly:true,count:1}]});
  const result=await apps.list({serial:'device'});
  assert.equal(result.apps[0].source,'builtin');assert.equal(result.sources[0].status,'unavailable');assert.equal(result.sources[0].count,null);
  await assert.rejects(apps.list({serial:'device',includeCatalog:false}),/No such file/);
});
