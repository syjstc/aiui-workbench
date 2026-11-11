const HOST = 'com.rokid.os.sprite.assistserver';
const ASSET = 'assets/aiui_builtin_agents/builtin_manifest.json';
export const STORE_PROVIDER = 'content://com.rokid.os.sprite.assistserver.aiui.packages/';

export function aiuiIcon(value) {
  if (typeof value !== 'string' || value.length > 400000) return null;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.hostname.includes('.') && !/^[\d.:\[\]]+$/.test(url.hostname) && !/\.(?:local|localhost|internal)$/.test(url.hostname) ? url.href : null; } catch { return null; }
}

export function builtinAiuiApps(manifest, { hostApk, hostVersion, hostUpdatedAt } = {}) {
  if (manifest?.schemaVersion !== 2 || manifest.strategy !== 'BUILTIN' || !Array.isArray(manifest.packages)) throw new Error('无法识别系统内置 AIUI 清单');
  const seen = new Set();
  return manifest.packages.map(item => {
    if (!item || typeof item.agentId !== 'string' || !/^builtin\.rokid\.[\w.-]+$/.test(item.agentId) || item.fileName !== item.agentId + '.aix' || seen.has(item.agentId)) throw new Error('系统内置 AIUI 清单身份不一致');
    seen.add(item.agentId);
    return { agentId:item.agentId, name:typeof item.agentName==='string'?item.agentName:item.agentId, version:typeof item.nativeVersion==='string'?item.nativeVersion:'', engine:typeof item.inkVersion==='string'?item.inkVersion:'', description:typeof item.agentDesc==='string'?item.agentDesc.slice(0,12000):'', permissions:Array.isArray(item.permissions)?item.permissions.filter(p=>typeof p==='string').slice(0,100):[], fileName:item.fileName, checksum:/^[a-f\d]{32}$/i.test(item.fileMd5)?item.fileMd5:null, definitionSha256:/^[a-f\d]{64}$/i.test(item.definitionSha256)?item.definitionSha256:null, kind:'aiui', source:'builtin', strategy:'BUILTIN', readOnly:true, removable:false, icon:aiuiIcon(item.agentLogo), iconSource:item.agentLogo?'system-manifest':null, hostPackage:HOST, hostApk, hostVersion, hostUpdatedAt, location:'assets/aiui_builtin_agents/'+item.fileName, availability:'bundled', localProject:null };
  });
}

// System assets can be inspected with shell read access. The private remote
// catalog is deliberately not accessed through root, grants, or mode changes.
export class AiuiCatalog {
  constructor(glasses, { now=Date.now } = {}) { this.glasses=glasses; this.now=now; this.cache=new Map(); this.pending=new Map(); }
  async read(serial) {
    const device=await this.glasses.ready(serial), key=serial+':'+device.transport;
    const cached=this.cache.get(key); if(cached&&cached.expires>this.now())return cached.value;
    if(this.pending.has(key))return this.pending.get(key);
    const task=this.readNow(serial).then(value=>{this.cache.set(key,{value,expires:this.now()+60000});return value;}).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  async readNow(serial) {
    const sources=[],apps=[];
    try {
      const info=await this.glasses.shell(serial,['dumpsys','package',HOST],{timeout:10000,maxBytes:2*1024*1024});
      const paths=await this.glasses.shell(serial,['pm','path','--user','0',HOST]);
      const hostApk=paths.split(/\r?\n/).map(line=>line.match(/^package:(\/(?:product|system|system_ext|data\/app)\/[^\r\n]+\.apk)$/)?.[1]).find(Boolean);
      if(!hostApk)throw new Error('未找到 AIUI 系统宿主安装包');
      const hostVersion=info.match(/\bversionName=([^\s]+)/)?.[1]||'',hostUpdatedAt=info.match(/lastUpdateTime=([^\r\n]+)/)?.[1]||'';
      const text=await this.glasses.shell(serial,['unzip','-p',hostApk,ASSET],{timeout:10000,maxBytes:2*1024*1024});
      apps.push(...builtinAiuiApps(JSON.parse(text),{hostApk,hostVersion,hostUpdatedAt}));
      sources.push({source:'builtin',status:'available',readOnly:true,count:apps.length,hostPackage:HOST,hostApk,hostVersion,hostUpdatedAt});
    } catch(error) { sources.push({source:'builtin',status:'unavailable',readOnly:true,count:null,error:error.message}); }
    let reason='not-supported';
    try { const result=await this.glasses.adbCommand(serial,['shell','content','query','--uri',STORE_PROVIDER],{timeout:10000,maxBytes:65536}); if(/Permission Denial|ACCESS_AIUI_PACKAGES|SecurityException/.test(result.stdout.toString()+result.stderr))reason='permission-denied'; }
    catch(error) { if(/Permission Denial|ACCESS_AIUI_PACKAGES|SecurityException/.test(error.message))reason='permission-denied'; }
    sources.push({source:'store',status:'unavailable',readOnly:true,count:null,reason,hostPackage:HOST,provider:STORE_PROVIDER,complete:false});
    return {apps,sources,checkedAt:new Date(this.now()).toISOString()};
  }
}
