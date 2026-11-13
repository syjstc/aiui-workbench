import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Projects } from './projects.mjs';
import { Knowledge } from './knowledge.mjs';
import { Previews } from './previews.mjs';
import { Jobs } from './jobs.mjs';
import { serviceLogStatus, clearServiceLog } from './logs.mjs';
import { DeviceDiscovery } from './devices.mjs';
import { AdbTools } from './adb.mjs';
import { GlassesTools } from './glasses.mjs';
import { AiuiApps } from './aiui-apps.mjs';
import { Mirroring } from './mirroring.mjs';
import { SdkManager } from './sdk.mjs';
import { ROOT, atomicJson, readJson, run, sha, redact } from './util.mjs';
import { APP_VERSION } from './version.mjs';
import { capabilities } from './capabilities.mjs';
import { Automation } from './automation.mjs';
import { jobWaitSchema } from './automation-contract.mjs';
import { recordingSchema,clipSchema } from './automation-contract.mjs';
import { Recordings } from './recordings.mjs';
import { z } from 'zod';
import { TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { toolCatalog } from './tool-catalog.mjs';
import { installMcpLauncher } from './mcp-launcher.mjs';
import { ProjectRemoval } from './project-removal.mjs';
import { Platform } from './platform.mjs';
import {Diagnostics,readServiceLog} from './diagnostics.mjs';
import {DevelopmentFlow,DEVELOPMENT_GUIDE} from './development-flow.mjs';
import {ProjectFiles} from './project-files.mjs';
import {ensureAgentSkills,workflowSkill,workflowSkillFiles} from './agent-skills.mjs';
import {SimulatorAi,AI_DEVICE_HINT} from './simulator-ai.mjs';
import {AiConnection} from './ai-connection.mjs';
import {Feedback} from './feedback.mjs';
import {diagnosticScope} from './diagnostic-scope.mjs';

const isAi = actor => actor === 'MCP' || actor === 'CLI';

export class Workbench {
  constructor(home) { this.home = home; this.origin = ''; this.events = []; this.sequence = 0; this.clients = new Map(); this.emit = this.emit.bind(this); this.projects = new Projects(home, this.emit); this.knowledge = new Knowledge(home); this.previews = new Previews(this.projects, home, this.emit); this.jobs = new Jobs(this.emit, home); this.adb = new AdbTools(home); this.glasses = new GlassesTools(home, this.adb); this.devices = new DeviceDiscovery((args, options) => this.cli(args, options), (_command, args, options) => this.adb.execute(args, options)); }
  emit(type, value) {
    if (type === 'jobs-deleted') this.events = this.events.filter(event => event.type !== 'job' || !value.deletedIds.includes(event.value.id));
    if (type === 'preview-logs-cleared') this.events = this.events.filter(event => event.type !== 'preview-log' || event.value.sessionId !== value.sessionId);
    this.events.push({ sequence: ++this.sequence, type, value, at: new Date().toISOString() }); this.events = this.events.slice(-300); if (type === 'source-changed') this.previews.reload(value.projectId);
    if(this.diagnostics&&((type==='preview-log'&&value.level==='error')||(type==='log'&&value.level==='error'))){
      const session=type==='preview-log'?this.previews.sessions.get(value.sessionId):null;
      const test=this.jobs.items.find(j=>j.type==='preview-test'&&j.sessionId===value.sessionId&&j.status==='running');
      this.captureDiagnostic(new Error(value.message),{source:type,sessionId:value.sessionId,projectId:value.projectId||session?.projectId,revision:value.revision,runId:value.runId,jobId:test?.id,workflowId:test?.workflowId,stage:test?'preview':undefined}).catch(()=>{});
    }
  }
  async init() {
    this.diagnostics=await new Diagnostics(this.home,this.emit).init();
    this.diagnostics.enrich=context=>diagnosticScope(context,this);
    try{return await this.initialize();}catch(error){await this.captureDiagnostic(error,{source:'startup'}).catch(()=>{});throw error;}
  }
  async initialize() {
    this.skillHome=process.env.AIUI_SKILL_HOME||os.homedir();
    if(this.skillHome!==os.homedir())this.skillOptions={globalRoots:['.agents','.codex','.claude','.cursor'].map(name=>path.join(this.skillHome,name,'skills'))};
    this.skillTargets=await readJson(path.join(this.home,'skill-targets.json'),{user:false,projects:[]});
    this.simulatorAi=new SimulatorAi(this.previews,this.emit);this.previews.ai=this.simulatorAi;
    this.aiuiApps = new AiuiApps(this.glasses, (args, options) => this.cli(args, options), this.projects);
    this.mirroring = new Mirroring(this.adb, this.glasses, this.emit);
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    this.mcpConfig = await installMcpLauncher(this.home);
    await Promise.all([this.projects.init(), this.knowledge.init(), this.jobs.init()]);
    this.aiConnection=await new AiConnection(this.home,toolCatalog()).init();
    this.jobs.onFailure=async(error,job)=>{const d=await this.captureDiagnostic(error,{source:'job',tool:job.type,jobId:job.id,projectId:job.projectId,workflowId:job.workflowId,stage:job.type==='preview-test'?'preview':job.stage});return d?.id;};
    this.sdk = await new SdkManager(this.home, this.projects, this.emit).init();
    this.projects.getToolchain = () => this.sdk.get();
    this.previews.getToolchain = project => this.sdk.forProject(project);
    this.automation = new Automation(this);
    this.recordings = await new Recordings(this).init();
    this.projectRemoval = new ProjectRemoval(this);
    this.platform = await new Platform(this).init();
    this.workflows=await new DevelopmentFlow(this).init();
    // Backfill legacy records from their recorded jobs/sessions/workflows.
    // Persist names and paths so removed projects remain identifiable.
    for(const item of this.diagnostics.items)Object.assign(item,this.diagnostics.enrich(item));
    if(this.diagnostics.items.length)await this.diagnostics.save();
    this.projectFiles=new ProjectFiles(this);
    this.feedback=await new Feedback(this.home,this.diagnostics,{environment:()=>this.runtimeInfo()}).init();
    return this;
  }
  async cli(args, options, releaseId) { return run(process.execPath, [this.sdk.cliPath(releaseId), ...args], { ...options, env: { ...process.env, ...options?.env, ...await this.adb.environment() } }); }
  runtimeInfo(project) { const release = project ? this.sdk.forProject(project) : this.sdk.get(); return { runtime: release.runtime, webSdkVersion: release.versions.ink, cliVersion: release.versions.cli, toolchainId: release.id }; }
  config() { return this.mcpConfig; }
  async syncKnowledge(options){const result=await this.knowledge.sync(options);await this.refreshAgentSkills();return result;}
  async refreshAgentSkills(){
    const targets=[...(this.skillTargets.user?[{projectPath:this.skillHome,agentPath:this.skillHome}]:[]),...this.projects.list().filter(p=>this.skillTargets.projects.includes(p.id))];
    this.skillUpdates=[];
    for(const target of targets){try{this.skillUpdates.push(await ensureAgentSkills(target,this.knowledge,{...this.skillOptions,installMissing:false,writeIgnore:false,adoptOriginal:false}));}catch(error){this.skillUpdates.push({status:'requires-attention',error:error.message});}}
    return this.skillUpdates;
  }
  status() { return { version: APP_VERSION, ...this.runtimeInfo(), sdk: this.sdk.status(), home: this.home, projects: this.projects.list(), knowledge: this.knowledge.status(), previews: this.previews.list(), jobs: this.jobs.list(), recordings:this.recordings?.status().recordings||[], clients: [...this.clients.values()].filter(c => Date.now()-c.lastSeen < 60000), sequence: this.sequence, platform: this.platform?.status(),lastAiAt:this.aiConnection?.status().verifiedAt||null,aiConnection:this.aiConnection?.status(),diagnostics:this.diagnostics.summary(),workflows:this.workflows?.list()||[] }; }
  async captureDiagnostic(error,context={}) {
    return this.diagnostics.record(error,context);
  }
  async deliverDiagnostics(result,args,actor,diagnosticId) {
    const delivered=[...(result?.diagnostics?.items||[]),...(result?.context?.diagnostics?.items||[])];
    for(const diagnostic of [result?.diagnostic,result?.result?.diagnostic])if(diagnostic?.id)delivered.push(diagnostic);
    const failure=diagnosticId?this.diagnostics.get({diagnosticId}).items[0]:null;
    if(failure)delivered.push(failure);
    const projectId=failure?.projectId||result?.projectId||result?.workflow?.projectId||result?.result?.workflow?.projectId||result?.project?.id||result?.context?.project?.id||(result?.agentPath?result.id:undefined)||args.projectId;
    const scope=this.diagnostics.enrich({...args,projectId,context:args});
    const filters=scope.scope==='project'?[{projectId:scope.projectId},{scope:'workbench'}]:[{scope:'workbench'},{scope:'unassigned'}];
    const pending=filters.flatMap(filter=>this.diagnostics.get({...filter,status:'open',read:false,limit:20}).items);
    const items=[...new Map([...delivered,...pending].map(item=>[item.id,item])).values()];
    await this.diagnostics.markRead(items,actor);
    // Update only the delivered version; a concurrent new occurrence stays unread.
    for(const snapshot of [...delivered,...items]){
      const current=this.diagnostics.items.find(item=>item.id===snapshot.id);
      if(current?.readAt&&current.occurrences===snapshot.occurrences)Object.assign(snapshot,{readAt:current.readAt,readBy:current.readBy});
    }
    const remainingUnread=filters.reduce((sum,filter)=>sum+this.diagnostics.get(filter).unreadCount,0);
    return {projectId:scope.projectId||null,items,remainingUnread,instruction:'这些诊断已自动交给 AI 并标为已读；已读不表示已修复。严格按每条 projectId、项目目录和 workflowId 处理，不修改其他项目。scope=workbench 是公共环境，scope=unassigned 必须先核实归属。owner=ai 时自行检查并验证；owner=user 时说明具体操作。修复验证后再 resolve；有 remainingUnread 时按相同范围继续读取 aiui_diagnostics_get(read=false)。'};
  }
  async call(tool, args = {}, actor = 'desktop') {
    try{let result=await this.dispatch(tool,args,actor);await this.aiConnection?.record(tool,actor,result);
      if(isAi(actor)&&args.sessionId&&!tool.startsWith('aiui_ai_')){const hint=this.simulatorAi?.hints(args.sessionId);if(hint)result={...result,pendingAiRequest:hint};}
      if(isAi(actor)&&result&&typeof result==='object'&&!tool.startsWith('aiui_diagnostics_')&&!tool.startsWith('aiui_ai_')&&tool!=='aiui_tools_list'){
        const shared=await this.deliverDiagnostics(result,args,actor);
        if(shared.items.length||shared.remainingUnread)return {...result,sharedDiagnostics:shared};
      }
      return result;
    }catch(error){
      if(!error.diagnosticId&&!tool.startsWith('aiui_diagnostics_')){
        const d=await this.captureDiagnostic(error,{source:'operation',actor,tool,projectId:args?.projectId,sessionId:args?.sessionId,workflowId:args?.workflowId,context:args}).catch(()=>null);
        if(d)error.diagnosticId=d.id;
      }
      if(isAi(actor)&&!tool.startsWith('aiui_diagnostics_'))error.sharedDiagnostics=await this.deliverDiagnostics(error.result,args,actor,error.diagnosticId).catch(()=>undefined);
      throw error;
    }
  }
  async dispatch(tool,args={},actor='desktop') {
    if (args.projectId && !tool.startsWith('ui_project_removal_') && this.projectRemoval?.locked(args.projectId)) throw new Error('此项目正在移除，请等待操作完成');
    this.clients.set(actor, { name: actor, lastSeen: Date.now() });
    const definition = TOOL_DEFINITIONS.find(([name]) => name === tool);
    if (definition) args = z.object(definition[2]).parse(args);
    switch (tool) {
      case 'aiui_feedback_status':return this.feedback.status();
      case 'aiui_feedback_prepare':return this.feedback.prepare(args);
      case 'ui_feedback_submit':
      case 'ui_feedback_reconcile':
      case 'ui_feedback_delete':
      case 'ui_feedback_restore': {
        if(!['desktop-feedback','web-feedback'].includes(actor))throw new Error('反馈发布只能由反馈页面发起');
        const draft=z.object({draftId:z.string(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(args);
        if(tool==='ui_feedback_delete')return this.feedback.deleteDraft(draft);
        if(tool==='ui_feedback_restore')return this.feedback.restoreDraft(draft);
        return tool==='ui_feedback_submit'?this.feedback.submit(draft):this.feedback.reconcile(draft);
      }
      case 'aiui_ai_configure':
      case 'aiui_ai_wait':
      case 'aiui_ai_reply': {
        if(!['MCP','CLI','workflow','qa'].includes(actor))throw new Error('AI 事件接管仅供自动化工具使用；模拟器 AI 功能请在真机测试');
        return this.simulatorAi[tool==='aiui_ai_configure'?'configure':tool==='aiui_ai_wait'?'wait':'reply'](args);
      }
      case 'aiui_skill_read': {const files=await workflowSkillFiles();return {path:args.path,version:APP_VERSION,content:files[args.path]};}
      case 'aiui_adb_connect':return this.adb.connect(args);
      case 'aiui_project_files':return this.projectFiles.operate(args);
      case 'aiui_workflow_start':return this.workflows.start(args);
      case 'aiui_workflow_get':return this.workflows.get(args);
      case 'aiui_workflow_continue':return this.workflows.continue(args);
      case 'aiui_diagnostics_get':return isAi(actor)?this.diagnostics.read(args,actor):this.diagnostics.get(args);
      case 'aiui_diagnostics_mark_read':return this.diagnostics.markRead(this.diagnostics.get({limit:200}).items.filter(item=>args.diagnosticIds.includes(item.id)),actor);
      case 'aiui_diagnostics_resolve':return this.diagnostics.resolve(args);
      case 'aiui_diagnostics_report':return this.captureDiagnostic(Object.assign(new Error(args.message),{stack:args.stack}),{...args,source:args.source||actor});
      case 'aiui_service_log_read':return readServiceLog(this.home,args);
      case 'ui_platform_session': {
        if (actor !== 'desktop-session') throw new Error('官方登录会话仅由桌面客户端同步');
        return this.platform.setSession(args.token,args.desktopKey,args.expiresAt);
      }
      case 'ui_platform_review_confirmation':
      case 'ui_platform_review_submit': {
        if (actor !== 'desktop-confirmation') throw new Error('提审仅可由桌面用户确认');
        return tool.endsWith('_submit') ? this.platform.submitConfirmed(args) : this.platform.confirmation(args.projectId,args.draftId,args.desktopKey);
      }
      case 'ui_platform_bind': {
        if(!['desktop','web'].includes(actor))throw new Error('应用的官方绑定只能在工坊中设置');
        return this.platform.bind(args);
      }
      case 'aiui_platform_status': return args.reconcile ? this.platform.reconcile(args.projectId) : this.platform.status(args.projectId);
      case 'aiui_platform_agents': return this.platform.list();
      case 'aiui_platform_upload': return this.platform.upload(args);
      case 'aiui_platform_review_prepare': return this.platform.prepareReview(args);
      case 'aiui_platform_review_request': return this.platform.requestReview(args);
      case 'ui_project_removal_begin': return this.projectRemoval.begin(args);
      case 'ui_project_removal_commit': return this.projectRemoval.commit(z.string().min(1).parse(args.intentId));
      case 'ui_project_removal_cancel': return this.projectRemoval.cancel(z.string().min(1).parse(args.intentId));
      case 'aiui_tools_list': return toolCatalog();
      case 'aiui_status': return this.status();
      case 'aiui_capabilities_get': return capabilities();
      case 'aiui_record_start': return this.recordings.start(recordingSchema.parse(args),actor);
      case 'aiui_record_stop': return this.recordings.stop(args);
      case 'aiui_record_status': return this.recordings.status(args);
      case 'aiui_record_clip': return this.recordings.clip(clipSchema.parse(args),actor);
      case 'aiui_cli_info': {
        const p=args.projectId?this.projects.get(args.projectId):null, release=p?this.sdk.forProject(p):this.sdk.get();
        return { shared: { command: process.execPath, args: [path.join(ROOT,'web/cli.mjs')], env: this.config().mcpServers['aiui-workbench'].env, commands: ['tools', 'call <tool> --args <JSON>', 'call <tool> --args-file <absolute JSON path>', 'mcp'], synchronization: 'Same authenticated local service and data directory as desktop/MCP; shared previews, runtime logs, jobs and results. CLI stdout returns JSON and local image/report paths.' }, official: { command: process.execPath, args: [this.sdk.cliPath(release.id)], ...this.runtimeInfo(p), synchronization: 'Direct aix commands are independent processes. Their terminal output and separately started previews are not collected by Workbench; use the shared CLI call entry for synchronized tasks and simulator logs.' } };
      }
      case 'aiui_sdk_status': return this.sdk.status();
      case 'aiui_sdk_check': return this.sdk.check();
      case 'aiui_sdk_settings': return this.sdk.settings(args);
      case 'aiui_sdk_prepare': return this.jobs.start('sdk-prepare', null, context => this.sdk.prepare(args, context));
      case 'aiui_sdk_activate': return this.sdk.activate(args);
      case 'aiui_sdk_rollback': return this.sdk.rollback();
      case 'aiui_sdk_project_use': {
        if (this.jobs.list().some(j => j.projectId === args.projectId && j.status === 'running')) throw new Error('项目仍有任务运行，请完成后再切换 SDK');
        const project = await this.sdk.useForProject(args);
        this.previews.reload(project.id); return project;
      }
      case 'aiui_projects_list': return { projects: this.projects.list() };
      case 'aiui_project_import': { const p=await this.projects.import(args.directory); if(!p.knowledgeRevision&&this.knowledge.meta.revision){p.knowledgeRevision=this.knowledge.meta.revision;await this.projects.save();}return p; }
      case 'aiui_project_refresh': return this.projects.refresh(args.projectId);
      case 'aiui_project_create': return this.projects.create(args, this.knowledge);
      case 'aiui_docs_sync': return this.jobs.start('knowledge', null, context => this.syncKnowledge(context));
      case 'aiui_docs_settings': return this.knowledge.settings(args);
      case 'aiui_docs_image': return this.knowledge.image(args);
      case 'aiui_docs_catalog': return { ...await this.knowledge.catalog(args), knowledge: this.knowledge.status() };
      case 'aiui_docs_search': return { ...await this.knowledge.searchPage(args.query, args), knowledge: this.knowledge.status() };
      case 'aiui_docs_read': { const doc = await this.knowledge.read(args.path, args.revision, args.from); const offset = Math.max(0, args.offset || 0), limit = Math.min(24000, args.limit || 16000); return { ...doc, content: doc.content.slice(offset, offset + limit), totalLength: doc.content.length, nextOffset: offset+limit < doc.content.length ? offset+limit : null }; }
      case 'aiui_context_get': {
        const project = args.projectId ? this.projects.get(args.projectId) : null;
        let skill = null; try { skill = await this.knowledge.read('skills/aiui-dev/SKILL.md', project?.knowledgeRevision); } catch {}
        let skillSetup={status:'deferred',reason:'A project or setup=true is needed to install skills. Both guides are provided inline without installation.'};
        {
          try{const target=project||{projectPath:this.skillHome,agentPath:this.skillHome};if(args.setup&&!project)await fs.mkdir(this.skillHome,{recursive:true});skillSetup={status:'ready',...await ensureAgentSkills(target,this.knowledge,{writeIgnore:!!project,installMissing:!!project||!!args.setup,...this.skillOptions,existingSkills:args.existingSkills})};if(skillSetup.skills.some(s=>s.status==='user-modified'))skillSetup.status='user-modified';if(skillSetup.skills.some(s=>s.status==='name-conflict'))skillSetup.status='requires-attention';this.skillTargets.user=true;if(project&&!this.skillTargets.projects.includes(project.id))this.skillTargets.projects.push(project.id);await atomicJson(path.join(this.home,'skill-targets.json'),this.skillTargets);if(project)await this.projects.refresh(project.id);}
          catch(error){const diagnostic=await this.captureDiagnostic(error,{source:'skill-setup',projectId:project?.id});skillSetup={status:'requires-attention',error:error.message,diagnosticId:diagnostic?.id,fallback:'Use officialSkill and workflowSkill inline; existing skill files were preserved.'};}
        }
        let environment;
        if(args.setup){try{environment={...await this.devices.check(),adbTool:await this.adb.resolveInfo(),...this.runtimeInfo()};}catch(error){const diagnostic=await this.captureDiagnostic(error,{source:'setup-environment'});environment={error:error.message,diagnosticId:diagnostic?.id};}}
        const projectInstructions=project?await fs.readFile(path.join(project.projectPath,'AGENTS.md'),'utf8').then(s=>s.slice(0,24000)).catch(()=>''):'';
        return { project, projectInstructions, serviceVersion:APP_VERSION,connection:this.aiConnection.status(),availableTools:toolCatalog().tools.map(t=>t.name),setup:!!args.setup,skillSetup,workflowSkill:await workflowSkill(),...(environment?{environment}:{}),...(args.setup?{nextAction:'If the user supplied an idea, continue that request with the available workflow tools now. Otherwise ask what app the user wants to make. Do not create a demo project without a request. Missing glasses should not prevent preview and packaging; explain device connection when installation is reached.'}:{}),...this.runtimeInfo(project), sdkUpdates: this.sdk.status(), officialSkill: skill, knowledge: this.knowledge.status(), instruction: '开发规则及验收要求以项目绑定版本的官方 aiui-dev 和 references/checklist.md 为准；工坊 aiui-workshop 只补 MCP 编排和恢复。首次使用项目自动检查并补齐缺失 Skill；setup=true 同时检查用户级 Skill 与环境，无需逐项调用。自动更新未修改的工坊管理全局/继承 Skill（含参考文件），existingSkills 不跳过版本检查；保留用户修改，不重复安装。当前聊天使用最新内联规范，客户端技能缓存可能需要重载。工具及参数以当前服务清单为准，不要根据 runtime/CLI 版本猜测工坊工具。源码可通过 aiui_project_files 带 expectedRevision 读写，也可使用现有编码工具。优先用 aiui_workflow_start 返回项目上下文，aiui_workflow_continue 一次验证、打包并在就绪时安装；无需重复检查已返回的信息。仅 status=running 时调用 aiui_job_wait。正式提审由用户在工坊确认。', developmentGuide:DEVELOPMENT_GUIDE, diagnostics:this.diagnostics.get({...project?{projectId:project.id}:{scope:'workbench'},status:"open",read:false,limit:10}), capabilities: capabilities(), simulation: { input: 'keydown/keyup, keyup-only, repeated bursts', orientation: 'host absoluteOrientation capability, Android +Z gravity', camera: 'photo fixtures and opt-in computer webcam; continuous getUserMedia / ImageCapture.grabFrame / takePhoto; runtime Canvas and photo adapters encode preview-frame PNG, not full-resolution camera modes; no audio', bluetooth: 'unsupported', network:'online/offline events only; outbound application requests are not enabled', ai: {default:'device-test-required',hint:AI_DEVICE_HINT,automation:{configure:'aiui_ai_configure',wait:'aiui_ai_wait',reply:'aiui_ai_reply',guide:'references/simulator-ai.md',requiresImageCapabilityDeclaration:true,processStarted:false}} } };
      }
      case 'aiui_preview_open': await this.projects.refresh(args.projectId); return this.previews.open(args.projectId, this.origin, { ...args, requestedBy:actor });
      case 'aiui_preview_test': return this.automation.test(args, actor);
      case 'aiui_preview_state': return this.previews.public(this.previews.get(args.sessionId));
      case 'aiui_preview_action': return this.previews.action(args.sessionId, args.action, args.parameters || {});
      case 'aiui_preview_capture': return this.previews.capture(args.sessionId);
      case 'aiui_preview_logs': {
        const s = this.previews.get(args.sessionId), limit = Math.max(1,Math.min(args.limit || 80,300));
        const matches = s.logs.filter(log=>(args.afterSequence===undefined || log.sequence>args.afterSequence) && (!args.level || log.level===args.level) && (!args.contains || log.message.includes(args.contains)) && (!args.runId || log.runId===args.runId));
        const logs = args.afterSequence===undefined ? matches.slice(-limit) : matches.slice(0,limit);
        return { logs, revision: s.revision, logGeneration: s.logGeneration, nextSequence: logs.length===limit ? logs.at(-1).sequence : s.logSequence || 0, truncated: args.afterSequence!==undefined && s.logs[0]?.sequence>args.afterSequence+1 };
      }
      case 'aiui_preview_logs_clear': return this.previews.clearLogs(args.sessionId);
      case 'aiui_job_get': return this.jobs.get(args.jobId);
      case 'aiui_job_wait': { const options=jobWaitSchema.parse(args); return this.jobs.wait(options.jobId,options.waitMs); }
      case 'aiui_job_cancel': return this.jobs.cancel(args.jobId);
      case 'aiui_jobs_delete': return this.jobs.delete(args.jobIds);
      case 'aiui_service_log_status': return serviceLogStatus(this.home);
      case 'aiui_service_log_clear': return clearServiceLog(this.home);
      case 'aiui_mcp_config': return this.config();
      case 'aiui_mcp_install_project': {
        const p = this.projects.get(args.projectId), file = path.join(p.projectPath, '.mcp.json');
        const existing = await readJson(file, {});
        const configured=!!existing.mcpServers?.['aiui-workbench'];
        if(!configured){try { await fs.copyFile(file, `${file}.backup-${Date.now()}`); } catch(e) { if (e.code !== 'ENOENT') throw e; }
        await atomicJson(file, { ...existing, mcpServers: { ...existing.mcpServers, ...this.config().mcpServers } });}
        const ignoreFile=path.join(p.agentPath,'.aixignore'), ignoreText=await fs.readFile(ignoreFile,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
        const excluded=['.mcp.json','.mcp.json.backup-*','.aiui-workbench.json'];
        const missing=excluded.filter(rule=>!ignoreText.split(/\r?\n/).includes(rule));
        if(missing.length)await fs.writeFile(ignoreFile,ignoreText+(ignoreText&&!ignoreText.endsWith('\n')?'\n':'')+missing.join('\n')+'\n');
        return { path: file, status: configured?'already-configured':'configured', scope: 'project',skillSetup:await ensureAgentSkills(p,this.knowledge,this.skillOptions) };
      }
      case 'aiui_environment_check': return { ...await this.devices.check(), adbTool: await this.adb.resolveInfo(), ...this.runtimeInfo() };
      case 'aiui_adb_configure': return this.adb.configure(args.directory);
      case 'aiui_glasses_info': return this.glasses.info(args);
      case 'aiui_glasses_files': return this.glasses.files(args);
      case 'aiui_glasses_read_file': return this.glasses.readFile(args);
      case 'aiui_glasses_mkdir': return this.glasses.mkdir(args);
      case 'aiui_glasses_pull': return this.jobs.start('glasses-pull', null, context => this.glasses.pull(args, context), { serial: args.serial });
      case 'aiui_glasses_push': return this.jobs.start('glasses-push', null, context => this.glasses.push(args, context), { serial: args.serial });
      case 'aiui_glasses_apps': return this.glasses.apps(args);
      case 'aiui_glasses_aiui_apps': return this.aiuiApps.list(args);
      case 'aiui_glasses_aiui_uninstall': return this.jobs.start('glasses-aiui-uninstall', null, context => this.aiuiApps.uninstall(args, context), { serial: args.serial });
      case 'aiui_glasses_app_details': return this.glasses.appDetails(args);
      case 'aiui_glasses_app_action': return this.jobs.start('glasses-app', null, async ({ signal, progress }) => { progress(`${args.action} · ${args.packageName}`); return this.glasses.appAction(args, { signal }); }, { serial: args.serial });
      case 'aiui_glasses_install': return this.jobs.start('glasses-install', null, context => this.glasses.install(args, context), { serial: args.serial });
      case 'aiui_glasses_screenshot': return this.glasses.screenshot(args);
      case 'aiui_glasses_logs': return this.glasses.logs(args);
      case 'aiui_glasses_control': return this.glasses.control(args);
      case 'aiui_glasses_mirror_status': return this.mirroring.status(args);
      case 'aiui_glasses_mirror_start': return this.mirroring.start(args);
      case 'aiui_glasses_mirror_stop': return this.mirroring.stop(args);
      case 'aiui_glasses_mirror_embed_status': return {...await this.mirroring.status(args),...this.mirroring.embedded.status(args)};
      case 'aiui_glasses_mirror_embed_start': return this.mirroring.embedded.start(args);
      case 'aiui_glasses_mirror_embed_stop': return this.mirroring.embedded.stop(args);
      case 'aiui_device_enable_developer': {
        if (!args.serial) throw new Error('请选择明确的目标眼镜');
        return this.jobs.start('device-setup', null, async ({ signal, progress }) => {
          const result = await this.cli(['device', 'set-dev', '--serial', args.serial], { signal, onOutput: progress });
          this.devices.inspections.delete(args.serial);
          if (result.code) throw new Error(result.output);
          return result;
        });
      }
      case 'aiui_device_inspect': {
        if (!args.serial) throw new Error('请选择明确的目标眼镜');
        const result = await this.cli(['device', '--serial', args.serial]); if (result.code) throw new Error(result.output); return result;
      }
      case 'aiui_project_check': {
        const p = this.projects.get(args.projectId);
        return this.jobs.start('check', p.id, async ({ signal, progress }) => {
          const result = await this.checkNow(p.id, { signal, progress });
          if (!result.passed) throw Object.assign(new Error('官方静态检查未通过，请查看任务日志与诊断'),{result}); return result;
        });
      }
      case 'aiui_project_build': return this.automation.build(args);
      case 'aiui_project_pack': return this.pack(args.projectId);
      case 'aiui_device_deploy': {
        const p = this.projects.get(args.projectId); if (!args.serial) throw new Error('请选择明确的目标眼镜');
        return this.jobs.start('deploy', p.id, async ({ signal, progress }) => { const result = await this.cli(['install', p.agentPath, '--serial', args.serial], { signal, onOutput: progress }, this.sdk.forProject(p).id); if (result.code) throw new Error(result.output); p.lastDeploy = { at: new Date().toISOString(), revision: p.revision, serial: args.serial, output: result.output, cloudIndexing: 'not-verified' }; await this.projects.save(); return p.lastDeploy; });
      }
      case 'aiui_device_launch': {
        const p = this.projects.get(args.projectId); if (!args.serial) throw new Error('请选择明确的目标眼镜');
        return this.jobs.start('launch', p.id, async ({ signal, progress }) => { const result = await this.cli(['launch-page', p.agentPath, args.page || p.pages[0], '--serial', args.serial], { signal, onOutput: progress }, this.sdk.forProject(p).id); if (result.code) throw new Error(result.output); return result; });
      }
      case 'aiui_platform_prepare': {
        const p = this.projects.get(args.projectId);
        return this.jobs.start('platform-prepare', p.id, async ({ signal, progress }) => {
          const result = await this.packNow(p.id, { signal, progress });
          return this.platformReceipt(p, result);
        });
      }
      default: throw new Error('未知工具：' + tool);
    }
  }
  async checkNow(projectId, { signal, progress }) {
    const p = await this.projects.refresh(projectId), revision = p.revision, toolchainId = this.sdk.forProject(p).id;
    const result = await this.cli(['check', p.agentPath, '--format', 'json'], { signal, onOutput: progress }, toolchainId);
    let diagnostics; try { diagnostics = JSON.parse(result.output); } catch { diagnostics = { output: result.output }; }
    await this.projects.refresh(p.id);
    p.lastCheck = { at: new Date().toISOString(), revision, toolchainId, passed: result.code===0, stale: p.revision!==revision || p.toolchainId!==toolchainId, diagnostics }; await this.projects.save();
    return p.lastCheck;
  }
  async platformReceipt(p, result) {
    const receipt = { stage: 'prepared-locally', projectId: p.id, applicationName: p.name, version: p.version, artifact: result.path, sha256: result.sha256, sourceRevision: result.revision, studioUrl: 'https://aiui.rokid.com/space', uploaded: false, submittedForReview: false, message: 'AIX 已保存在本机。下一步：使用 aiui_platform_upload 上传云端草稿，aiui_platform_review_prepare 准备提审材料；用户在工坊确认后才能提交审核。' };
    await atomicJson(path.join(path.dirname(result.path), 'platform-preflight.json'), receipt); p.platform = receipt; await this.projects.save(); return receipt;
  }
  pack(projectId) { return this.jobs.start('pack', projectId, context => this.packNow(projectId, context)); }
  async packNow(projectId, { signal, progress }) {
    const p = await this.projects.refresh(projectId), revision = p.revision;
    const dir = path.join(this.home, 'builds', p.id, Date.now().toString()); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'application.aix');
    const toolchainId = this.sdk.forProject(p).id;
    const result = await this.cli(['pack', p.agentPath, '-o', file], { signal, onOutput: progress }, toolchainId); if (result.code) throw new Error(result.output);
    const bytes = await fs.readFile(file), record = { path: file, sha256: sha(bytes), bytes: bytes.length, revision, toolchainId, at: new Date().toISOString() };
    p.lastBuild = record; await this.projects.refresh(p.id); await this.projects.save(); return record;
  }
  async close() { await this.feedback?.close();await this.skillRefresh;await this.workflows?.close(); await this.knowledge.close(); await this.mirroring?.close(); await this.jobs.close(); await this.recordings?.close(); await this.previews.close(); await this.sdk?.close(); await this.projects.close(); await this.diagnostics?.close(); }
}
