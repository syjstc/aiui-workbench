import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, id, sha, redact } from './util.mjs';

const secret = /token|password|cookie|authorization|secret|desktopKey|approvalId|base64|dataUrl|pairingCode/i;
export function diagnosticValue(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return redact(value).replace(/([?&](?:key|api_key|access_token)=)[^&#\s]+/gi, '$1[hidden]').slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 30).map(v => diagnosticValue(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key) && !['data','fixture','files'].includes(key)).slice(0, 50).map(([key,v]) => [key, diagnosticValue(v, depth + 1)]));
  return value;
}

export function recoveryFor(message = '', source = '') {
  if(source==='startup')return {category:'startup',owner:'user',title:'请重新打开工坊并检查启动环境',steps:['确认使用完整客户端，重新打开工坊。','AI 可先读取服务日志与诊断；修复环境后调用 aiui_environment_check 重试，继续原任务。'],view:'logs'};
  if (/unauthorized|允许.*调试|调试.*授权/i.test(message)) return {category:'authorization',owner:'user',title:'请在眼镜上允许连接',steps:['戴上眼镜，确认“允许 USB 调试”。','没有看到提示时，重新连接数据线。','完成后点击“重新检查并继续”，或告诉 AI 继续。'],view:'devices'};
  if (/developer mode|开发者模式/i.test(message)) return {category:'device-mode',owner:'user',title:'请开启眼镜开发者模式',steps:['打开工坊的“连接眼镜”页面。','点击“开启 AIUI 开发者模式”，等待眼镜准备完成。','完成后让 AI 继续原来的制作任务。'],view:'devices'};
  if (/ADB|眼镜.*(?:断开|离线|连接)|未发现眼镜|数据线/i.test(message)) return {category:'device-connection',owner:'user',title:'请连接眼镜并开启调试',steps:['在手机 Rokid AI App 的眼镜设置中打开“眼镜 ADB 调试”。','用支持数据传输的开发线连接电脑和眼镜，或按官方无线连接指南操作。','在眼镜上确认调试授权，然后重新检查并继续。'],view:'devices'};
  if (/NotSupported|not.configured|未接入|未配置.*(?:模型|语音)|尚未支持|尚未.*模拟/i.test(message)) return {category:'capability',owner:'ai',title:'这项能力需要换一种验证方式',steps:['先读取 aiui_context_get 的能力边界，区分应用错误与模拟器尚未提供的服务。','相机、模型或语音需要真实服务时，使用已授权的真机验证；不要用固定响应冒充真实结果。'],view:'simulator'};
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|fetch failed|网络|HTTP (?:401|403|408|429|5\d\d)|登录.*(?:失效|过期)|未登录/i.test(message)) return {category:'network-or-account',owner:'user',title:'请检查网络或登录状态',steps:['确认电脑可以联网；如使用代理，检查代理是否可用。','涉及官方平台时，在“构建与上传”中重新检查登录状态。','结果待确认的上传先回查云端，不要重复上传；确认后再继续。'],view:'publish'};
  if (/ENOENT|不存在|找不到|directory|目录|EACCES|EPERM/i.test(message)) return {category:'local-files',owner:source==='startup'?'user':'ai',title:'需要检查文件位置或访问权限',steps:['核对诊断中的实际文件路径和原操作；不要覆盖已有项目。','缺少项目资源时由 AI 修正引用或补齐文件；系统权限需要用户允许。','修复后重新执行原检查。'],view:'projects'};
  return {category:'application',owner:'ai',title:'AI 可以继续检查这个问题',steps:['读取此诊断的原始错误、上下文和关联任务结果。','修改实际项目源码后重新验证；以当前源码和工具链的测试结果为准。'],view:'studio'};
}

export class Diagnostics {
  constructor(home, emit = () => {}) { this.home=home; this.file=path.join(home,'diagnostics.json'); this.emit=emit; this.items=[]; this.sequence=0; this.enrich=context=>({scope:context.scope||(context.projectId?'project':'workbench')}); }
  async init() {
    try{const saved=await readJson(this.file,{sequence:0,items:[]});if(!Array.isArray(saved.items)||!Number.isSafeInteger(saved.sequence))throw new Error('诊断记录格式无效');this.sequence=saved.sequence;this.items=saved.items;}
    catch(error){
      // A damaged journal must not disable the service and its recovery tools.
      // Keep the original bytes locally so an AI can investigate the cause.
      if(error.code&&error.code!=='ENOENT')throw error;
      const backup=this.file+'.backup-'+Date.now();await fs.rename(this.file,backup).catch(e=>{if(e.code!=='ENOENT')throw e;});
      await this.record(new Error('诊断记录无法读取，已保留备份：'+backup),{source:'diagnostics',recovery:{owner:'ai',category:'local-files',title:'诊断记录已恢复',steps:['原始记录已保留为本机备份，AI 可以继续检查备份和服务日志。'],view:'logs'}});
    }
    return this;
  }
  save() { const value={sequence:this.sequence,items:structuredClone(this.items)}; this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(this.file,value)); return this.saving; }
  async record(error, context = {}) {
    const message=diagnosticValue(error?.message || String(error)), safe=diagnosticValue({...context,...this.enrich?.(context)});
    const recovery=safe.recovery || recoveryFor(message,safe.source);
    const fingerprint=sha(JSON.stringify([safe.tool,safe.projectId,safe.sessionId,safe.workflowId,safe.operationPath,safe.revision,message]));
    const previous=this.items.find(item=>item.fingerprint===fingerprint&&item.status==='open');
    const now=new Date().toISOString();
    const item=previous || {id:id(),fingerprint,status:'open',createdAt:now,occurrences:0};
    Object.assign(item,safe,{message,stack:diagnosticValue(error?.stack || safe.stack || ''),code:error?.code || safe.code,details:diagnosticValue(error?.result || safe.details),recovery,lastSeenAt:now,sequence:++this.sequence,occurrences:item.occurrences+1,readAt:null,readBy:null});
    if(!previous)this.items.unshift(item);
    this.items.sort((a,b)=>b.sequence-a.sequence); this.items=this.items.slice(0,200);
    await this.save().catch(e=>{this.persistenceError=e.message;}); this.emit('diagnostic',item); return structuredClone(item);
  }
  get({diagnosticId,projectId,scope,read,afterSequence,status,limit=30}={}) {
    const all=this.items.map(item=>({...item,...this.enrich?.(item)}));
    const matches=item=>(!diagnosticId||item.id===diagnosticId)&&(!projectId||item.projectId===projectId)&&(!scope||item.scope===scope);
    const filtered=all.filter(item=>matches(item)&&item.sequence>(afterSequence??0)&&(!status||item.status===status)&&(read===undefined||!!item.readAt===read)).sort((a,b)=>a.sequence-b.sequence);
    // A normal read shows the latest problems. Explicit cursors paginate from
    // the oldest unread event so a polling AI cannot silently lose updates.
    const items=afterSequence===undefined?filtered.slice(-limit):filtered.slice(0,limit);
    const open=all.filter(item=>matches(item)&&item.status==='open');
    return {items:structuredClone(items),nextSequence:afterSequence!==undefined&&filtered.length>limit?items.at(-1).sequence:this.sequence,hasMore:filtered.length>limit,openCount:open.length,unreadCount:open.filter(item=>!item.readAt).length,readOpenCount:open.filter(item=>item.readAt).length,truncated:afterSequence>0&&this.items.length===200&&Math.min(...this.items.map(x=>x.sequence))>afterSequence+1,persistenceError:this.persistenceError||null};
  }
  summary() { const {openCount,unreadCount,readOpenCount}=this.get();return {openCount,unreadCount,readOpenCount,sequence:this.sequence}; }
  async markRead(records, reader) {
    const changed=[], now=new Date().toISOString();
    for(const snapshot of records){
      const item=this.items.find(item=>item.id===snapshot.id);
      // A new occurrence queued while the response was being prepared must
      // remain unread. Acknowledging a delivered occurrence is not a repair.
      if(!item||item.sequence!==snapshot.sequence||item.readAt)continue;
      Object.assign(item,{readAt:now,readBy:reader,sequence:++this.sequence});changed.push(item.id);
    }
    if(changed.length){await this.save();this.emit('diagnostics-read',{diagnosticIds:changed,reader});}
    return {readIds:changed};
  }
  async read(options={},reader='MCP') {
    const result=this.get(options);
    if(options.markRead===false)return result;
    const acknowledged=await this.markRead(result.items,reader);
    for(const item of result.items){
      const current=this.items.find(current=>current.id===item.id);
      if(acknowledged.readIds.includes(item.id)&&current?.readAt&&current.occurrences===item.occurrences)Object.assign(item,{readAt:current.readAt,readBy:current.readBy});
    }
    return {...result,...acknowledged};
  }
  async resolve({diagnosticIds,note=''}) {
    const changed=[];
    for(const item of this.items)if(diagnosticIds.includes(item.id)&&item.status!=='resolved'){Object.assign(item,{status:'resolved',resolvedAt:new Date().toISOString(),resolution:diagnosticValue(note),sequence:++this.sequence});changed.push(item.id);}
    await this.save();return {resolvedIds:changed};
  }
  async close(){await this.saving;}
}

export async function readServiceLog(home,{maxBytes=32000}={}) {
  const file=path.join(home,'service.log'); let handle;
  try {handle=await fs.open(file,'r');const {size}=await handle.stat(),start=Math.max(0,size-maxBytes),buffer=Buffer.alloc(size-start);await handle.read(buffer,0,buffer.length,start);return {path:file,bytes:size,content:diagnosticValue(buffer.toString('utf8').slice(-12000)),truncated:start>0||buffer.length>12000};}
  catch(error){if(error.code==='ENOENT')return {path:file,bytes:0,content:'',truncated:false};throw error;}
  finally{await handle?.close();}
}
