import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PreviewStorage} from '../core/preview-storage.mjs';
import {installPreviewStorage} from '../preview/storage-runtime.js';

test('simulator storage survives a new runtime and host, stays per project and supports sync/async removal',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-preview-storage-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const storage=new PreviewStorage(home),wx={},pending=[];
  installPreviewStorage(wx,await storage.read('ab01'),change=>pending.push(storage.update('ab01',change)));
  wx.setStorageSync('__proto__',{done:[1]});const copy=wx.getStorageSync('__proto__');copy.done.push(2);assert.deepEqual(wx.getStorageSync('__proto__'),{done:[1]});
  let callback;await wx.setStorage({key:'progress',data:{checked:1},success:r=>callback=r.errMsg});assert.equal(callback,'setStorage:ok');
  await Promise.all(pending);await storage.close();
  const reopened=new PreviewStorage(home),next={};installPreviewStorage(next,await reopened.read('ab01'),change=>pending.push(reopened.update('ab01',change)));
  assert.equal((await next.getStorage({key:'progress'})).data.checked,1);assert.deepEqual(await reopened.read('ab02'),[]);
  next.removeStorageSync('__proto__');assert.equal(next.getStorageSync('__proto__'),undefined);await next.clearStorage();await Promise.all(pending);assert.deepEqual(await reopened.read('ab01'),[]);
});

test('simulator storage rejects unsafe IDs, quotas and undefined values without damaging saved data',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-preview-storage-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const storage=new PreviewStorage(home),wx={};installPreviewStorage(wx,[],()=>{});
  assert.throws(()=>wx.setStorageSync('value',undefined),/JSON/);await assert.rejects(storage.read('../outside'),/ID/);
  await storage.update('ab01',{operation:'set',key:'safe',value:42});
  await assert.rejects(storage.update('ab01',{operation:'set',key:'too-big',value:'x'.repeat(1024*1024)}),/限制/);
  assert.deepEqual(await storage.read('ab01'),[['safe',42]]);await storage.close();
});
