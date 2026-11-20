import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceStoreRecords, lastStoreSync, providerStoreApps, readStoreCatalog } from '../core/aiui-store-catalog.mjs';
import { AiuiCatalog, aiuiIcon, builtinAiuiApps } from '../core/aiui-catalog.mjs';
const entry={agentId:'builtin.rokid.example',fileName:'builtin.rokid.example.aix',agentName:'Example',nativeVersion:'1.0.0',inkVersion:'>=0.17.0',agentDesc:'A system-provided example',permissions:['INTERNET'],agentLogo:'https://images.example.com/icon.png',fileMd5:'a'.repeat(32)};
const manifest={schemaVersion:2,strategy:'BUILTIN',packages:[entry]};
test('system catalog keeps verified identities, rich metadata and explicit read-only ownership',()=>{
  const [app]=builtinAiuiApps(manifest,{hostApk:'/product/app/Host.apk',hostVersion:'1.2'});
  assert.equal(app.name,'Example');assert.equal(app.source,'builtin');assert.equal(app.readOnly,true);assert.equal(app.removable,false);assert.equal(app.description,entry.agentDesc);assert.deepEqual(app.permissions,['INTERNET']);assert.equal(app.icon,entry.agentLogo);
  for(const packages of [[{...entry,agentId:'develop.rokid.agent.example'}],[entry,entry],[{...entry,fileName:'wrong.aix'}]])assert.throws(()=>builtinAiuiApps({...manifest,packages}),/身份/);
});
test('catalog icons allow image data and public HTTPS, and reject active or credentialed sources',()=>{
  for(const value of ['javascript:alert(1)','file:///tmp/icon.png','http://example.com/icon.png','https://user:password@example.com/x','https://localhost/x','https://127.0.0.1/x','data:image/svg+xml;base64,AAAA'])assert.equal(aiuiIcon(value),null,value);
  assert.equal(aiuiIcon(entry.agentLogo),entry.agentLogo);
});
test('a permission-restricted store catalog stays unknown instead of claiming zero installed apps',async()=>{
  const reads=[];
  const glasses={ready:async()=>({transport:'one'}),shell:async(_serial,args)=>{reads.push(args);if(args[0]==='dumpsys')return 'versionName=1.2\nlastUpdateTime=2026-11-11 12:00:00';if(args[0]==='pm')return 'package:/product/app/Host.apk';return JSON.stringify(manifest);},adbCommand:async()=>({stdout:Buffer.from('Permission Denial: ACCESS_AIUI_PACKAGES'),stderr:''})};
  const catalog=new AiuiCatalog(glasses),first=await catalog.read('device'),second=await catalog.read('device');
  assert.equal(first,second);assert.deepEqual(reads.map(args=>args[0]),['dumpsys','pm','unzip','pidof']);assert.equal(first.apps.length,1);assert.deepEqual(first.sources.at(-1),{source:'store',status:'unavailable',readOnly:true,count:null,reason:'permission-denied',hostPackage:'com.rokid.os.sprite.assistserver',provider:'content://com.rokid.os.sprite.assistserver.aiui.packages/',complete:false});
  assert.ok(reads.every(args=>!args.includes('remove')&&!args.includes('delete')));
});

const epoch = '1794094741.629';
const log = (message, tag='AIUI_AgentAppManager') => epoch+' 2012 2379 D AssistServer_Log: '+tag+' -> '+message;
const start = log('syncAgentList start incomingSize=3');
const entryLog = (id, download=false) => log('syncAgentList agentId='+id+' shouldDownload='+download+' urlBlank=false artifact_revision=17');
const end = log('syncAgentList complete incomingSize=3');
const metadataLog = log('fetchAndSyncNativeAgentList response body={"code":1,"data":[{"agentId":"a1","agentName":"A {1}","nativeVersion":"1.2","filePath":"private-url"},{"agentId":"a2","agentName":"B","agentDesc":"incomplete', 'AIUI_JsaiAiuiHostProvider');
const sync = [metadataLog,start,entryLog('a1'),entryLog('a2'),entryLog('a3',true),end];

test('read-only device sync uses the last complete batch and exposes only evidenced fields',async()=>{
  const snapshot=lastStoreSync(sync.join('\n'));
  assert.deepEqual(snapshot.apps.map(app=>[app.name,app.version]),[['A {1}','1.2'],['B','']]);
  assert.equal(snapshot.observedAt,'2026-11-07T23:39:01.629Z');
  assert.ok(snapshot.apps.every(app=>app.readOnly&&!app.removable));
  assert.doesNotMatch(JSON.stringify(snapshot),/private-url|filePath|artifact_revision/);
  const calls=[];
  const glasses={adbCommand:async()=>({stdout:Buffer.from('SecurityException'),stderr:''}),shell:async(_serial,args)=>{
    calls.push(args);return args[0]==='pidof'?'2012':sync.join('\n');
  }};
  const result=await readStoreCatalog(glasses,'device','example.host','content://example');
  assert.equal(result.source.status,'snapshot');assert.equal(result.source.count,null);
  assert.equal(result.source.visibleCount,2);assert.equal(result.apps[0].name,'A {1}');
  assert.equal(calls[1][calls[1].indexOf('--pid')+1],'2012');
});

test('incomplete, duplicated, failed and superseded syncs never report an installed count',()=>{
  for(const lines of [sync.slice(1,-1),[start,entryLog('a'),end],[start,entryLog('a'),entryLog('a'),entryLog('b'),end],
    [...sync,start],[...sync,start,log('syncAgentList metadata refresh failed agentId=a'),end]])assert.equal(lastStoreSync(lines.join('\n')),null);
  const empty=lastStoreSync([...sync,log('syncAgentList start incomingSize=0'),log('syncAgentList complete incomingSize=0')].join('\n'));
  assert.deepEqual(empty.apps,[]);
});

test('provider results require explicit remote provenance and never promote an empty root cursor',()=>{
  assert.equal(providerStoreApps('No result found.'),null);
  assert.equal(providerStoreApps('Row: 0 agent_id=unknown, _size=32'),null);
  const text=['Row: 0 strategy=REMOTE, agent_id=a1, native_version=1.2, _size=20','Row: 1 strategy=BUILTIN, agent_id=b1',
    'Row: 2 strategy=REMOTE, agent_id=develop.rokid.fake'].join('\n');
  assert.deepEqual(providerStoreApps(text).map(a=>[a.agentId,a.version,a.bytes,a.readOnly,a.removable]),[['a1','1.2',20,true,false]]);
});

test('successful remote presentations are read-only device observations; a subsequent removal suppresses the entry', () => {
  const row = (id, strategy, outcome) => epoch+' 2012 2379 I AIUI_AiuiRuntimeCoordinator: [AIUI] event=presentation_result open_target=AGENT package_strategy='+strategy+' agent_id='+id+' outcome='+outcome;
  const accepted = row('online1','REMOTE_SYNC','COMMITTED');
  const ignored = [row('builtin.rokid.foo','REMOTE_SYNC','COMMITTED'),row('uncommitted','REMOTE_SYNC','ACCEPTED_PENDING_HOST'),
    row('dev-example','DEVELOPER_PUSH','COMMITTED'),accepted.replace('AIUI_AiuiRuntimeCoordinator:', 'AnotherTag:')];
  assert.equal(deviceStoreRecords(ignored.join('\n')),null);
  const result = deviceStoreRecords([...ignored,accepted,accepted].join('\n'));
  assert.equal(result.status,'observed');
  assert.deepEqual(result.apps.map(a=>[a.agentId,a.readOnly,a.removable,a.version,a.lastOpenedAt]),[['online1',true,false,'','2026-11-07T23:39:01.629Z']]);
  const removed = log('handleRemoveNativeAgent dispatch agentId=online1','JsaiCmdHelper');
  assert.equal(deviceStoreRecords([accepted,removed].join('\n')),null);
  assert.equal(deviceStoreRecords([accepted,removed,accepted].join('\n')).apps.length,1);
});

test('a later complete sync supersedes old presentations and later activity retains individual timestamps', () => {
  const later='1794094742.102 2012 2379 I AIUI_AiuiRuntimeCoordinator: [AIUI] event=presentation_result open_target=AGENT package_strategy=REMOTE_SYNC agent_id=extra outcome=COMMITTED';
  assert.equal(deviceStoreRecords([later.replace('1794094742.102','1794094740.000'),...sync].join('\n')).apps.length,2);
  const mixed=deviceStoreRecords([...sync,later].join('\n'));
  assert.equal(mixed.status,'observed');assert.equal(mixed.apps.length,3);
  assert.equal(mixed.apps[0].name,'A {1}');assert.ok(mixed.apps[0].syncedAt);
  assert.equal(mixed.apps[2].lastOpenedAt,'2026-11-07T23:39:02.102Z');
});
