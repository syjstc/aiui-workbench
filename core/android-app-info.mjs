import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJson, sha } from './util.mjs';

export function parseAppInfo(output, packages) {
  const line=output.split(/\r?\n/).find(line=>line.startsWith('AIUI_APP_INFO '));
  if(!line)throw new Error('设备没有返回应用图标信息');
  const value=JSON.parse(line.slice('AIUI_APP_INFO '.length));
  if(value.schemaVersion!==1||!Array.isArray(value.apps))throw new Error('无法识别应用图标信息');
  const allowed=new Set(packages),result=new Map();
  for(const item of value.apps){
    if(!item||!allowed.has(item.packageName))continue;
    const icon=typeof item.icon==='string'&&item.icon.length<=160000&&item.icon.startsWith('data:image/png;base64,iVBORw0KGgo')?item.icon:null;
    result.set(item.packageName,{label:typeof item.label==='string'?item.label.slice(0,300):null,icon,iconSource:icon?'device':null});
  }
  return result;
}

// The tiny, bundled dex asks Android's PackageManager to render its own
// drawable, including adaptive/vector icons. No APK transfer or SDK install.
export class AndroidAppInfo {
  constructor(glasses,{root=ROOT,now=Date.now}={}){Object.assign(this,{glasses,root,now});this.cache=new Map();this.pending=new Map();this.uploaded=new Set();}
  invalidate(serial){for(const key of this.cache.keys())if(key.startsWith(serial+':'))this.cache.delete(key);}
  async read(serial,transport,packages){
    const key=serial+':'+transport+':'+sha(Buffer.from(JSON.stringify(packages.map(p=>[p.packageName,p.versionCode]))));
    const cached=this.cache.get(key);if(cached&&cached.expires>this.now())return cached.result;
    if(this.pending.has(key))return this.pending.get(key);
    const work=this.readNow(serial,transport,packages.map(p=>p.packageName)).then(result=>{this.cache.set(key,{result,expires:this.now()+60000});return result;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
  async readNow(serial,transport,packages){
    if(!packages.length)return new Map();
    if(packages.length>1500||packages.some(name=>!(/^[A-Za-z][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(name))))throw new Error('应用包名无效');
    const file=path.join(this.root,'assets/android/app-info.dex'),bytes=await fs.readFile(file);
    const receipt=await readJson(path.join(this.root,'assets/android/app-info.json'));
    if(sha(bytes)!==receipt.dexSha256)throw new Error('应用图标组件校验失败');
    const remote='/data/local/tmp/aiui-workbench-app-info-'+receipt.dexSha256.slice(0,16)+'.dex',uploadKey=serial+':'+transport;
    if(!this.uploaded.has(uploadKey)){await this.glasses.adbCommand(serial,['push',file,remote],{timeout:15000});this.uploaded.add(uploadKey);}
    try{
      const command=`CLASSPATH='${remote}' app_process / local.aiui.workbench.AppInfo `+packages.map(name=>`'${name}'`).join(' ');
      const output=await this.glasses.shell(serial,command,{timeout:20000,maxBytes:16*1024*1024});
      return parseAppInfo(output,packages);
    }catch(error){this.uploaded.delete(uploadKey);throw error;}
  }
}
