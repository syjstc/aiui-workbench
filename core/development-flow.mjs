import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,readJson,id} from './util.mjs';

export const DEVELOPMENT_GUIDE = `用户只需描述想法。官方 aiui-dev 负责开发规则和交付验收，工坊只补 MCP 编排；官方要求的检查可用工坊等效工具执行，不能降低验收标准。以下工具只在当前清单中存在时使用，不根据 runtime/CLI 版本猜测：
1. aiui_workflow_start(request) 自动准备项目目录并返回官方规范、当前源码路径和验收要求。已有项目可传 projectId。不要要求新手选择目录或学习 MCP。
2. start 已返回项目上下文、自动检测及补齐的 Skill 和规范，不必再次读取；缺少上下文或切换项目时再调用 aiui_context_get。按需读取官方 references/checklist.md 及相关领域文档；项目 AGENTS.md 包含镜腿输入要求。aiui_project_files(action=list/read) 批量读取源码，然后 action=write 携带 expectedRevision 批量写入真实应用；也可使用自己的编码工具。按用户想法实现，加入可验证的应用行为日志。源码版本变化时重新读取并合并，不覆盖用户的新改动。
3. aiui_workflow_continue(workflowId, steps) 一次执行真实预览、应用行为断言、截图、静态检查和打包；眼镜就绪时安装、启动并采集画面和日志。steps 必须含应用行为断言，不能把运行健康当成功能验收。
4. 每次工具调用自动附带当前项目与公共环境的未读 sharedDiagnostics，直接读取并处理，无需用户复制。按每条 projectId、项目目录和 workflowId 匹配，不能混用其他项目；归属不明时先核实。读取会自动标记已读并收起，已读不代表修复；失败时按 projectId/diagnosticId 调用 aiui_diagnostics_get 补充证据，read=false 继续读未读。owner=ai 的问题自行修复并继续；owner=user 时用简短语言告诉用户卡在哪一步、具体操作和继续方法。不要甩日志，不要无限重复失败操作。用户说完成后调用同一 workflowId 继续，不重建项目。
5. 通过 aiui_workflow_get 展示真实阶段和证据；代码或 SDK 变化会使旧结果失效。检查截图，不冒充佩戴体验或真实模型服务。没有设备时先完成模拟和打包，再清楚告知连接步骤。模拟器未配置真实模型/语音等服务时，可明确传 verification={mode:"device",reason:"具体的能力限制及真机验收计划"} 改走真机，保留未模拟验证的说明，不伪造通过；只有 target=glasses 才可使用。
6. 发布是后续可选步骤，使用已有平台草稿和材料工具；正式提审继续由用户在工坊确认。`;

export function deviceBlocker(environment, serial) {
  const e=environment;
  if(!e?.adb||!e?.aix)return {code:'tools-unavailable',message:'连接工具暂时不可用，请检查完整客户端',owner:'user',title:'请检查工坊安装',steps:['确认使用完整桌面安装包，重新打开工坊。','连接工具仍不可用时，打开新手指南选择备用工具。'],view:'guide'};
  if(!e.devices?.length)return {code:'no-device',message:'尚未发现眼镜，请检查数据线和手机 ADB 开关',owner:'user',title:'连接眼镜后就可以继续',steps:['在手机 Rokid AI App 的眼镜设置中打开“眼镜 ADB 调试”。','连接支持数据传输的开发线，或按官方无线连接指南操作。','在眼镜上允许调试后，点击“重新检查并继续”或告诉 AI 继续。'],view:'devices'};
  const d=serial?e.devices.find(d=>d.serial===serial):e.devices.length===1?e.devices[0]:null;
  if(!d)return {code:'select-device',message:'请选择明确的目标眼镜',owner:'user',title:'请选择这次使用的眼镜',steps:['打开“连接眼镜”，按设备名称和尾号选择目标。','让 AI 使用该设备继续原任务。'],view:'devices'};
  if(d.status==='unauthorized')return {code:'unauthorized',message:'请在眼镜上允许 USB 调试',owner:'user',title:'请在眼镜上允许连接',steps:['戴上眼镜，确认“允许 USB 调试”。','没有出现提示时重新连接，然后继续。'],view:'devices'};
  if(d.status!=='device')return {code:'offline',message:'眼镜连接已中断',owner:'user',title:'请重新连接眼镜',steps:['确认眼镜开机，重新连接数据线或无线连接。','连接恢复后重新检查并继续。'],view:'devices'};
  if(d.inspection?.developerMode==='disabled')return {code:'developer-mode',message:'需要开启 AIUI 开发者模式',owner:'user',title:'请开启眼镜开发者模式',steps:['在“连接眼镜”页面点击“开启 AIUI 开发者模式”。','等待眼镜运行环境就绪，再继续。'],view:'devices'};
  if(d.inspection?.error||!d.inspection?.runtimeReady)return {code:'runtime-not-ready',message:'眼镜运行环境尚未就绪',owner:'user',title:'请保持眼镜开机并稍等',steps:['保持连接，等待眼镜运行环境准备完成。','如果一直未就绪，重新启动眼镜后再检查。'],view:'devices'};
  return null;
}

export class DevelopmentFlow {
  constructor(w){this.w=w;this.file=path.join(w.home,'workflows.json');this.items=[];this.starts=new Map();}
  async init(){this.items=await readJson(this.file,[]);for(const f of this.items)if(f.state==='running'){f.state='needs-ai';f.message='上次制作已中断，可以继续原任务';}return this;}
  save(){const value=structuredClone(this.items);this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(this.file,value));return this.saving;}
  list(){return this.items.map(f=>this.public(f));}
  find(workflowId){const f=this.items.find(f=>f.id===workflowId);if(!f)throw new Error('制作任务不存在，请先开始制作');return f;}
  public(f){
    const p=this.w.projects.items.find(p=>p.id===f.projectId),stale=!!p&&!!f.revision&&(p.revision!==f.revision||p.toolchainId!==f.toolchainId);
    const result=structuredClone(f);
    if(result.evidence.preview){const {logs,errors,state,steps,...preview}=result.evidence.preview;result.evidence.preview=preview;}
    return {...result,stale,projectName:p?.name||f.name,projectPath:p?.projectPath,sourceRevision:p?.revision};
  }
  get({workflowId,projectId}={}){const f=workflowId?this.find(workflowId):this.items.find(f=>!projectId||f.projectId===projectId);return f?{workflow:this.public(f),diagnostics:this.w.diagnostics.get({projectId:f.projectId,status:'open',read:false}),guide:DEVELOPMENT_GUIDE}:{workflow:null,guide:DEVELOPMENT_GUIDE};}
  async start(args){
    if(args.requestId&&this.starts.has(args.requestId))return this.starts.get(args.requestId);
    const work=this.startNew(args);if(args.requestId)this.starts.set(args.requestId,work);
    try{return await work;}finally{if(args.requestId)this.starts.delete(args.requestId);}
  }
  async startNew({request,name,projectId,directory,target='glasses',locale='zh-CN',requestId,existingSkills}){
    if(requestId){const existing=this.items.find(f=>f.requestId===requestId);if(existing)return this.get({workflowId:existing.id});}
    const flowId=id(),applicationName=name||request.replace(/\s+/g,' ').slice(0,24)||'我的眼镜应用';
    const p=projectId?await this.w.projects.refresh(projectId):await this.w.call('aiui_project_create',{name:applicationName,directory:directory||path.join(this.w.home,'projects',flowId.slice(0,8)),locale},'workflow');
    const f={id:flowId,requestId,projectId:p.id,name:applicationName,request,target,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),state:'needs-ai',stage:'create',message:'项目已准备好，等待 AI 制作应用',steps:[],evidence:{},nextAction:{owner:'ai',title:'根据需求制作应用',steps:['读取官方规范并编辑项目源码。','为关键交互添加应用行为断言，然后调用 aiui_workflow_continue。']}};
    this.items.unshift(f);this.items=this.items.slice(0,50);await this.save();this.w.emit('workflow',this.public(f));
    return {...this.get({workflowId:f.id}),context:await this.w.call('aiui_context_get',{projectId:p.id,existingSkills},'workflow'),nextTool:'aiui_workflow_continue'};
  }
  async blocked(f,blocker){
    f.state=blocker.owner==='user'?'waiting-user':'needs-ai';f.message=blocker.title;f.nextAction=blocker;f.updatedAt=new Date().toISOString();
    const diagnostic=await this.w.diagnostics.record(new Error(blocker.message||blocker.title),{source:'workflow',workflowId:f.id,projectId:f.projectId,revision:f.revision,toolchainId:f.toolchainId,recovery:blocker});f.diagnosticId=diagnostic.id;
    await this.save();this.w.emit('workflow',this.public(f));return {workflow:this.public(f),diagnostic,needsUserAction:blocker.owner==='user'};
  }
  async continue({workflowId,steps,verification,serial,waitMs=45000}){
    const f=this.find(workflowId);
    const running=this.w.jobs.list().find(j=>j.type==='workflow'&&j.workflowId===f.id&&j.status==='running');
    if(running)return this.w.jobs.wait(running.id,waitMs);
    if(verification){
      if(verification.mode==='device'&&f.target!=='glasses')throw new Error('真机验证需要眼镜目标，不能用于只打包任务');
      if(JSON.stringify(verification)!==JSON.stringify(f.verification)){f.verification=verification;delete f.evidence.preview;delete f.evidence.previewSkipped;}
    }
    if(steps){if(JSON.stringify(steps)!==JSON.stringify(f.steps))delete f.evidence.preview;f.steps=steps;}
    const job=this.w.jobs.start('workflow',f.projectId,context=>this.run(f,serial,context),{workflowId:f.id});
    return this.w.jobs.wait(job.id,waitMs);
  }
  async run(f,serial,{signal,progress}){
    const w=this.w,p=await w.projects.refresh(f.projectId),revision=p.revision,toolchainId=p.toolchainId;
    if(f.revision!==revision||f.toolchainId!==toolchainId)f.evidence={};
    f.revision=revision;f.toolchainId=toolchainId;f.state='running';delete f.nextAction;f.updatedAt=new Date().toISOString();
    const assertCurrent=async()=>{const current=await w.projects.refresh(p.id);if(current.revision!==revision||current.toolchainId!==toolchainId)throw new Error('制作期间源码或 SDK 已变化，请重新验证');};
    const stage=async(name,message)=>{await assertCurrent();f.stage=name;f.message=message;progress(message);await this.save();w.emit('workflow',this.public(f));signal.throwIfAborted();};
    const waitChild=async job=>{const abort=()=>w.jobs.cancel(job.id);signal.addEventListener('abort',abort,{once:true});try{while(job.status==='running'){signal.throwIfAborted();job=await w.jobs.wait(job.id,1000);}if(job.status!=='succeeded')throw Object.assign(new Error(job.error||'验证未完成'),{result:job.result,diagnosticId:job.diagnosticId});return job.result;}finally{signal.removeEventListener('abort',abort);}};
    try{
      if(f.verification?.mode==='device'){
        f.evidence.previewSkipped={reason:f.verification.reason,revision,toolchainId,simulatorVerified:false,functionalValidation:'pending-on-device'};
      }else if(!f.evidence.preview){
        await stage('preview','正在运行预览并验证交互');
        const preview=await waitChild(await w.automation.test({projectId:p.id,steps:f.steps,reload:true,capture:true,failOnError:true,waitMs:0},'workflow',{workflowId:f.id}));
        f.evidence.preview=preview;
        await w.diagnostics.resolve({diagnosticIds:w.diagnostics.items.filter(d=>d.workflowId===f.id&&d.stage==='preview').map(d=>d.id),note:'同一制作任务的预览重新验证通过，原始错误保留供回查'});
      }
      if(!f.evidence.build){await stage('build','正在检查源码并生成安装包');f.evidence.build=await waitChild(await w.automation.build({projectId:p.id,waitMs:0}));}
      if(f.verification?.mode!=='device'&&!f.steps.some(s=>s.expect?.logContains||s.expect?.logCount))return this.blocked(f,{code:'behavior-assertions',owner:'ai',title:'预览和打包完成，等待 AI 验证实际功能',message:'尚未提供应用行为断言',steps:['为用户要求的关键交互添加日志断言。','传入 steps 再调用 aiui_workflow_continue；没有应用行为断言不能宣称功能已验收。'],view:'simulator'});
      if(f.target==='glasses'){
        await stage('device','正在检查眼镜连接与授权');
        const environment=await w.call('aiui_environment_check',{},'workflow'),blocker=deviceBlocker(environment,serial);
        if(blocker)return this.blocked(f,blocker);
        const device=serial?environment.devices.find(d=>d.serial===serial):environment.devices[0];serial=device.serial;
        if(f.evidence.device?.serial!==serial)delete f.evidence.device;
        f.evidence.device||={serial};
        if(!f.evidence.device.install){await stage('install','正在安装到眼镜');f.evidence.device.install=await waitChild(await w.call('aiui_device_deploy',{projectId:p.id,serial},'workflow'));}
        if(!f.evidence.device.launch){await stage('launch','正在眼镜上打开应用');f.evidence.device.launch=await waitChild(await w.call('aiui_device_launch',{projectId:p.id,serial},'workflow'));}
        await stage('device-evidence','正在采集眼镜画面和日志');
        const {data,...capture}=await w.glasses.screenshot({serial});f.evidence.device.capture=capture;
        f.evidence.device.logs=await w.glasses.logs({serial,lines:300});
        f.evidence.device.info=await w.glasses.info({serial});
      }
      const current=await w.projects.refresh(p.id);if(current.revision!==revision||current.toolchainId!==toolchainId)throw new Error('制作期间源码或 SDK 已变化，请重新验证');
      f.state='completed';f.stage='complete';f.message=f.target==='glasses'?'应用已安装并打开，请戴上眼镜体验':'交互验证和打包已完成';f.updatedAt=new Date().toISOString();f.nextAction={owner:f.target==='glasses'?'user':'ai',title:f.target==='glasses'?'请戴上眼镜确认实际体验':'查看截图并向用户交付',steps:[...(f.evidence.previewSkipped?['此应用改用真机验证，模拟器未验证实际功能；请让 AI 检查真机截图与日志。']:[]),f.target==='glasses'?'检查画面、镜腿操作和声音；这一步仍需佩戴确认。':'检查实际预览截图，向用户说明已通过的断言及安装包位置。']};
      await w.diagnostics.resolve({diagnosticIds:w.diagnostics.items.filter(d=>(d.workflowId===f.id||d.id===f.diagnosticId)&&!(f.evidence.previewSkipped&&d.stage==='preview')).map(d=>d.id),note:'同一制作任务重新验证后已继续，原始错误保留供回查'});
      await this.save();w.emit('workflow',this.public(f));return {workflow:this.public(f),deviceVerified:false,wornAcceptance:'pending',functionalValidation:f.evidence.previewSkipped?'pending-on-device':'simulator-assertions-passed',capture:f.evidence.preview?.capture||f.evidence.device?.capture};
    }catch(error){
      f.state=signal.aborted?'interrupted':'needs-ai';f.updatedAt=new Date().toISOString();
      const diagnostic=error.diagnosticId?w.diagnostics.items.find(x=>x.id===error.diagnosticId):await w.diagnostics.record(error,{source:'workflow',workflowId:f.id,projectId:p.id,revision,toolchainId,stage:f.stage});
      if(diagnostic){f.diagnosticId=diagnostic.id;f.nextAction=diagnostic.recovery;f.state=diagnostic.recovery.owner==='user'?'waiting-user':f.state;f.message=diagnostic.recovery.title;}
      // A failed stage must be rerun after repair even when source did not change.
      if(f.stage==='preview')delete f.evidence.preview;if(f.stage==='build')delete f.evidence.build;
      await this.save();w.emit('workflow',this.public(f));throw Object.assign(error,{result:{workflow:this.public(f),diagnostic},diagnosticId:diagnostic?.id});
    }
  }
  async close(){await this.saving;}
}
