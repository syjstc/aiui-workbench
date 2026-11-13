import path from 'node:path';
import fs from 'node:fs/promises';
import {z} from 'zod';
import {ROOT,readJson,atomicJson,id,sha,redact} from './util.mjs';
import {APP_VERSION} from './version.mjs';

const DAY=86400000,COOLDOWN=60000,MAX_DAILY=3;
const repositoryPattern=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const text=z.string().trim();
export const feedbackDraftSchema=z.object({
  kind:z.enum(['workbench-bug','suggestion']),title:text.min(5).max(160),description:text.min(20).max(6000),
  steps:text.max(3000).optional(),expected:text.max(2000).optional(),actual:text.max(2000).optional(),
  diagnosticIds:z.array(z.string().min(1).max(100)).max(5).default([]),
}).strict();

// Local diagnostics contain useful private context. Public reports use only
// explicitly selected fields, with a separate, more restrictive text filter.
// This deterministic local filter and draft formatting never call an AI model.
export function publicFeedbackText(value){
  return redact(String(value||''))
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,'[redacted credential]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g,'[redacted credential]')
    .replace(/((?:api[_-]?key|secret|access[_-]?token|refresh[_-]?token|serial|deviceId|pairingCode)["']?\s*[:=]\s*)[^\s,;\n}"']+/gi,'$1[redacted]')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s]+/gi,'$1[redacted]')
    .replace(/https?:\/\/[^\s/]+:[^\s/@]+@/gi,'https://[redacted]@')
    .replaceAll(ROOT.replaceAll('\\','/'),'<workbench>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|private|tmp|var)\/)[^\r\n"'<>|]*/g,'[local path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]')
    .replace(/@(?=[a-z0-9])/gi,'＠')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,'[omitted remote image]')
    .replace(/!\[/g,'[omitted image] [')
    .replace(/<(?:img|video|iframe)\b[^>]*>/gi,'[omitted media]')
    .replace(/\b\d{12,20}\b/g,'[device or local identifier]')
    .replace(/(?:data:[^\s,]+;base64,)[A-Za-z0-9+/=]+/g,'[omitted media]')
    .replace(/<!--\s*aiui-workshop-feedback:[\s\S]*?-->/gi,'')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim();
}

export async function feedbackTarget(home){
  const defaults=await readJson(path.join(ROOT,'assets/updates.json'));
  const saved=await readJson(path.join(home,'app-updates.json'),{});
  const source=saved.source??defaults.source;
  const repository=String(saved.sources?.[source]?.repository??defaults.sources?.[source]?.repository??'').trim();
  if(source!=='github')return {supported:false,source,repository:null,reason:'当前更新源尚不支持 issue 提交；不会改投其他仓库'};
  if(!repositoryPattern.test(repository)||['.','..'].includes(repository.split('/')[1]))return {supported:false,source,repository:null,reason:'请先在设置中保存有效的 GitHub 更新仓库'};
  return {supported:true,source,repository,url:`https://github.com/${repository}/issues`,identity:sha(JSON.stringify([source,repository.toLowerCase()]))};
}

const issueLink=(repository,issue)=>Number.isSafeInteger(issue?.number)&&issue.number>0&&typeof issue.html_url==='string'&&issue.html_url.toLowerCase()===`https://github.com/${repository}/issues/${issue.number}`.toLowerCase()?{number:issue.number,url:issue.html_url}:null;
const marker=fingerprint=>`<!-- aiui-workshop-feedback:${fingerprint} -->`;

export class Feedback {
  constructor(home,diagnostics,{fetcher=fetch,now=Date.now,environment=()=>({}),serviceUrl}={}){
    this.home=home;this.diagnostics=diagnostics;this.fetcher=fetcher;this.now=now;this.environment=environment;
    this.file=path.join(home,'feedback.json');this.records=[];this.serviceUrl=serviceUrl;this.active=new Map();this.controllers=new Set();
  }
  async init(){
    let saved;
    try{saved=await readJson(this.file,{records:[]});}
    catch(error){
      if(!(error instanceof SyntaxError))throw error;
      await fs.rename(this.file,this.file+'.backup-'+this.now());
      await this.diagnostics.record(new Error('反馈记录格式损坏，已保留本机备份并恢复反馈入口'),{source:'feedback',scope:'workbench'});
      saved={records:[]};
    }
    this.records=Array.isArray(saved?.records)?saved.records.filter(r=>r&&typeof r.id==='string'&&typeof r.title==='string'&&typeof r.body==='string'&&/^[a-f0-9]{64}$/.test(r.digest)&&/^[a-f0-9]{64}$/.test(r.fingerprint)&&r.target?.supported===true&&repositoryPattern.test(r.target.repository)&&/^[a-f0-9]{64}$/.test(r.target.identity)&&Array.isArray(r.attempts)&&r.attempts.every(Number.isFinite)).slice(0,100):[];
    for(const record of this.records)if(record.stage==='submitting')record.stage='unknown';
    return this;
  }
  save(){const value={schemaVersion:1,records:structuredClone(this.records)};this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(this.file,value));return this.saving;}
  public(record){return structuredClone(record);}
  async status(){const target=await feedbackTarget(this.home);return {target,service:await this.service(target),records:this.records.filter(r=>!r.deletedAt).slice(0,30).map(r=>this.public(r)),limits:{perDay:MAX_DAILY,cooldownSeconds:COOLDOWN/1000}};}
  summary(){return {pending:this.records.filter(r=>!r.deletedAt&&r.stage==='draft').length};}
  async prepare(args){
    args=feedbackDraftSchema.parse(args);
    const target=await feedbackTarget(this.home);if(!target.supported)throw new Error(target.reason);
    const diagnostics=args.diagnosticIds.map(key=>{
      const record=this.diagnostics.get({diagnosticId:key}).items[0];
      if(!record||record.scope!=='workbench'||record.projectId||record.sessionId||record.workflowId)throw new Error('只能附加工坊公共环境诊断；应用开发报错不自动提交为工坊问题');
      return {source:publicFeedbackText(record.source),message:publicFeedbackText(record.message).slice(0,1000),stack:publicFeedbackText(record.stack).split('\n').slice(0,10).join('\n').slice(0,2000)};
    });
    if(args.kind==='suggestion'&&diagnostics.length)throw new Error('功能建议无需附加错误日志');
    const content=Object.fromEntries(['title','description','steps','expected','actual'].map(key=>[key,publicFeedbackText(args[key])]));
    content.title=content.title.replace(/[\r\n]+/g,' ');
    if(content.title.length<5||content.description.length<20)throw new Error('脱敏后内容过短，请补充不含私人信息的工坊现象或建议');
    const fingerprint=sha(JSON.stringify([args.kind,content,diagnostics]));
    const previous=this.records.find(r=>!r.deletedAt&&r.target.identity===target.identity&&r.fingerprint===fingerprint&&r.stage!=='failed');
    if(previous)return this.public(previous);
    const info=this.environment(),environment={version:APP_VERSION,platform:process.platform,arch:process.arch,runtime:info.runtime,webSdkVersion:info.webSdkVersion,cliVersion:info.cliVersion};
    const title=`[${args.kind==='suggestion'?'Suggestion':'Workbench bug'}] ${content.title}`;
    const sections=[`## ${args.kind==='suggestion'?'Suggestion':'Workbench problem'}\n\n${content.description}`];
    for(const [key,label] of [['steps','Steps to reproduce'],['expected','Expected behavior'],['actual','Actual behavior']])if(content[key])sections.push(`## ${label}\n\n${content[key]}`);
    sections.push('## Environment\n\n'+Object.entries(environment).filter(([,value])=>value!==undefined).map(([key,value])=>`- ${key}: ${publicFeedbackText(value)}`).join('\n'));
    if(diagnostics.length)sections.push('## Selected Workshop diagnostics\n\n'+diagnostics.map(d=>`Source: ${d.source}\n\n${d.message}\n\n${d.stack}`).join('\n\n---\n\n'));
    sections.push('Submitted from AIUI Workshop. Local paths, credentials and device identifiers are omitted.\n\n'+marker(fingerprint));
    const record={id:id(),kind:args.kind,input:{...content,kind:args.kind,diagnosticIds:args.diagnosticIds},title,body:sections.join('\n\n'),target,fingerprint,createdAt:new Date(this.now()).toISOString(),stage:'draft',attempts:[]};
    record.digest=sha(JSON.stringify([record.title,record.body,target.identity]));
    this.records.unshift(record);this.records=this.records.slice(0,100);await this.save();return this.public(record);
  }
  async endpoint(){
    const value=this.serviceUrl??(await readJson(path.join(ROOT,'assets/feedback.json'),{})).serviceUrl;
    if(!value)return null;
    const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('反馈服务地址无效');
    return url.href.replace(/\/$/,'');
  }
  async request(method,route,body){
    const base=await this.endpoint();if(!base)throw new Error('反馈机器人尚未部署，可以先保存预览');
    const controller=new AbortController();this.controllers.add(controller);
    try{
      const response=await this.fetcher(base+route,{method,redirect:'error',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
      if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`反馈服务请求失败：HTTP ${response.status}`),{httpStatus:response.status,definitive:response.status>=400&&response.status<500});}
      const raw=await response.text();if(Buffer.byteLength(raw)>100000)throw new Error('反馈服务响应超出大小限制');return JSON.parse(raw);
    }finally{this.controllers.delete(controller);}
  }
  async service(target){
    const url=await this.endpoint();if(!url)return {configured:false,available:false};
    if(!target.supported)return {configured:true,available:false};
    try{
      const config=await this.request('GET','/config?repository='+encodeURIComponent(target.repository));
      if(config.schemaVersion!==1||config.repository?.toLowerCase()!==target.repository.toLowerCase())return {configured:true,available:false,error:'机器人尚未接收当前更新源仓库的反馈'};
      return {configured:true,available:true};
    }catch{return {configured:true,available:false,error:'暂时无法连接反馈机器人，请稍后重试'};}
  }
  draft({draftId,digest},{includeDeleted=false}={}){const record=this.records.find(r=>r.id===draftId);if(!record||record.digest!==digest)throw new Error('反馈草稿已变化，请重新预览');if(record.deletedAt&&!includeDeleted)throw new Error('反馈草稿已删除，可先撤销删除或重新生成预览');return record;}
  editableDraft(args){
    if(this.active.has(args.draftId))throw new Error('反馈正在处理中，请等待完成后再操作');
    const record=this.draft(args,{includeDeleted:true});
    if(record.issue||!['draft','failed'].includes(record.stage))throw new Error('只能删除未提交的反馈；结果待核对时请先核对提交结果');
    return record;
  }
  async deleteDraft(args){
    const record=this.editableDraft(args);
    // Keep a local tombstone so undo and the submission quota survive deletion.
    if(!record.deletedAt){record.deletedAt=new Date(this.now()).toISOString();await this.save();}
    return {draftId:record.id,deleted:true};
  }
  async restoreDraft(args){const record=this.editableDraft(args);if(record.deletedAt){delete record.deletedAt;await this.save();}return this.public(record);}
  async checkTarget(record){const target=await feedbackTarget(this.home);if(!target.supported||target.identity!==record.target.identity)throw new Error('更新源仓库已变化，请重新生成反馈预览');}
  accept(record,result){
    if(!['submitted','duplicate','unknown','failed'].includes(result?.stage))throw new Error('反馈服务回执无法核实');
    const issue=result.issue&&issueLink(record.target.repository,{number:result.issue.number,html_url:result.issue.url});
    if(['submitted','duplicate'].includes(result.stage)&&!issue)throw new Error('反馈服务 issue 回执无法核实');
    Object.assign(record,{stage:result.stage,...(issue?{issue}:{}),error:result.stage==='unknown'?'提交结果未确认，请核对后再操作':result.stage==='failed'?'反馈服务未完成提交，请重新生成预览后再试':null});
  }
  reconcile(args){return this.exclusive(args,async()=>{
    const record=this.draft(args);await this.checkTarget(record);
    const result=await this.request('GET',`/receipts/${record.id}?digest=${record.digest}`);
    this.accept(record,result);await this.save();return this.public(record);
  });}
  exclusive(args,work){if(this.active.has(args.draftId))return this.active.get(args.draftId);const promise=work().finally(()=>this.active.delete(args.draftId));this.active.set(args.draftId,promise);return promise;}
  submit(args){return this.exclusive(args,async()=>{
    const record=this.draft(args);await this.checkTarget(record);
    if(record.issue)return this.public(record);
    if(['unknown','submitting'].includes(record.stage))throw new Error('上次提交结果未确认，请先核对结果；不会重复创建 issue');
    if(this.now()-Date.parse(record.createdAt)>7*DAY)throw new Error('反馈草稿已过期，请重新生成预览');
    const now=this.now(),attempts=this.records.flatMap(r=>r.attempts||[]).filter(t=>now-t<DAY);
    if(attempts.length>=MAX_DAILY||attempts.some(t=>now-t<COOLDOWN))throw new Error('反馈提交过于频繁，请稍后再试；每分钟一次、每天最多三次');
    if(this.submissionBusy)throw new Error('另一条反馈正在提交，请等待完成');
    this.submissionBusy=true;
    try{
      record.stage='submitting';record.attempts.push(this.now());record.error=null;await this.save();
      try{
        const result=await this.request('POST','/submit',{requestId:record.id,digest:record.digest,kind:record.kind,repository:record.target.repository,title:record.title,body:record.body,fingerprint:record.fingerprint});
        this.accept(record,result);
      }catch(error){record.stage=error.definitive?'failed':'unknown';record.error=error.httpStatus===403?'机器人尚未接收当前更新源仓库的反馈':error.httpStatus===429?'反馈提交过于频繁，请稍后再试':error.httpStatus===409?'反馈目标或内容已变化，请重新生成预览':'提交结果未确认，请核对后再操作';}
      await this.save();return this.public(record);
    }finally{this.submissionBusy=false;}
  });}
  async close(){for(const controller of this.controllers)controller.abort();await Promise.allSettled([...this.active.values()]);await this.saving;}
}
