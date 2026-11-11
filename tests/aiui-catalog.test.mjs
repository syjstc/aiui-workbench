import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(first,second);assert.equal(reads.length,3);assert.equal(first.apps.length,1);assert.deepEqual(first.sources.at(-1),{source:'store',status:'unavailable',readOnly:true,count:null,reason:'permission-denied',hostPackage:'com.rokid.os.sprite.assistserver',provider:'content://com.rokid.os.sprite.assistserver.aiui.packages/',complete:false});
  assert.ok(reads.every(args=>!args.includes('remove')&&!args.includes('delete')));
});
