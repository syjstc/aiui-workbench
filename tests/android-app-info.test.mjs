import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AndroidAppInfo,parseAppInfo } from '../core/android-app-info.mjs';
import { ROOT,readJson,sha } from '../core/util.mjs';

const name='com.fastemulator.gba';
const output='AIUI_APP_INFO '+JSON.stringify({schemaVersion:1,apps:[{packageName:name,label:'My Boy!',icon:'data:image/png;base64,iVBORw0KGgo='},{packageName:'other.app',label:'Other'}]});
test('device app labels and raster icons are accepted only for requested packages',()=>{
  const result=parseAppInfo('Android log\n'+output,[name]);assert.equal(result.size,1);assert.equal(result.get(name).label,'My Boy!');assert.equal(result.get(name).iconSource,'device');
  assert.throws(()=>parseAppInfo('{}',[name]),/没有返回/);
  assert.equal(parseAppInfo('AIUI_APP_INFO '+JSON.stringify({schemaVersion:1,apps:[{packageName:name,icon:'https://example.com/icon.png'}]}),[name]).get(name).icon,null);
});
test('bundled read-only metadata helper matches its source and binary receipts',async()=>{
  const receipt=await readJson(ROOT+'/assets/android/app-info.json');assert.equal(sha(await fs.readFile(ROOT+'/assets/android/app-info.dex')),receipt.dexSha256);assert.equal(sha(await fs.readFile(ROOT+'/assets/android/AppInfo.java')),receipt.sourceSha256);
});
test('app metadata requests coalesce, reuse their upload and refresh on transport or explicit invalidation',async()=>{
  let uploads=0,reads=0;const glasses={adbCommand:async()=>uploads++,shell:async()=>{reads++;return output;}};
  const info=new AndroidAppInfo(glasses),packages=[{packageName:name,versionCode:'1'}];
  await Promise.all([info.read('device','1',packages),info.read('device','1',packages)]);assert.equal(uploads,1);assert.equal(reads,1);
  info.invalidate('device');await info.read('device','1',packages);assert.equal(uploads,1);assert.equal(reads,2);
  await info.read('device','2',packages);assert.equal(uploads,2);
  await assert.rejects(info.readNow('device','1',['bad;name']),/包名无效/);
});
