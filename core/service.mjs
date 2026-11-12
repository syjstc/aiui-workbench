import fs from 'node:fs/promises';
import path from 'node:path';
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

export class Workbench {
  constructor(home) { this.home = home; this.origin = ''; this.events = []; this.sequence = 0; this.clients = new Map(); this.emit = this.emit.bind(this); this.projects = new Projects(home, this.emit); this.knowledge = new Knowledge(home); this.previews = new Previews(this.projects, home, this.emit); this.jobs = new Jobs(this.emit, home); this.adb = new AdbTools(home); this.glasses = new GlassesTools(home, this.adb); this.devices = new DeviceDiscovery((args, options) => this.cli(args, options), (_command, args, options) => this.adb.execute(args, options)); }
  emit(type, value) {
    if (type === 'jobs-deleted') this.events = this.events.filter(event => event.type !== 'job' || !value.deletedIds.includes(event.value.id));
    if (type === 'preview-logs-cleared') this.events = this.events.filter(event => event.type !== 'preview-log' || event.value.sessionId !== value.sessionId);
    this.events.push({ sequence: ++this.sequence, type, value, at: new Date().toISOString() }); this.events = this.events.slice(-300); if (type === 'source-changed') this.previews.reload(value.projectId);
  }
  async init() {
    this.aiuiApps = new AiuiApps(this.glasses, (args, options) => this.cli(args, options), this.projects);
    this.mirroring = new Mirroring(this.adb, this.glasses, this.emit);
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    this.mcpConfig = await installMcpLauncher(this.home);
    await Promise.all([this.projects.init(), this.knowledge.init(), this.jobs.init()]);
    this.sdk = await new SdkManager(this.home, this.projects, this.emit).init();
    this.projects.getToolchain = () => this.sdk.get();
    this.previews.getToolchain = project => this.sdk.forProject(project);
    this.automation = new Automation(this);
    this.recordings = await new Recordings(this).init();
    this.projectRemoval = new ProjectRemoval(this);
    this.platform = await new Platform(this).init();
    return this;
  }
  async cli(args, options, releaseId) { return run(process.execPath, [this.sdk.cliPath(releaseId), ...args], { ...options, env: { ...process.env, ...options?.env, ...await this.adb.environment() } }); }
  runtimeInfo(project) { const release = project ? this.sdk.forProject(project) : this.sdk.get(); return { runtime: release.runtime, webSdkVersion: release.versions.ink, cliVersion: release.versions.cli, toolchainId: release.id }; }
  config() { return this.mcpConfig; }
  status() { return { version: APP_VERSION, ...this.runtimeInfo(), sdk: this.sdk.status(), home: this.home, projects: this.projects.list(), knowledge: this.knowledge.status(), previews: this.previews.list(), jobs: this.jobs.list(), recordings:this.recordings?.status().recordings||[], clients: [...this.clients.values()].filter(c => Date.now()-c.lastSeen < 60000), sequence: this.sequence, platform: this.platform?.status() }; }
  async call(tool, args = {}, actor = 'desktop') {
    if (args.projectId && !tool.startsWith('ui_project_removal_') && this.projectRemoval?.locked(args.projectId)) throw new Error('此项目正在移除，请等待操作完成');
    this.clients.set(actor, { name: actor, lastSeen: Date.now() });
    const definition = TOOL_DEFINITIONS.find(([name]) => name === tool);
    if (definition) args = z.object(definition[2]).parse(args);
    switch (tool) {
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
      case 'aiui_docs_sync': return this.jobs.start('knowledge', null, context => this.knowledge.sync(context));
      case 'aiui_docs_settings': return this.knowledge.settings(args);
      case 'aiui_docs_image': return this.knowledge.image(args);
      case 'aiui_docs_catalog': return { ...await this.knowledge.catalog(args), knowledge: this.knowledge.status() };
      case 'aiui_docs_search': return { ...await this.knowledge.searchPage(args.query, args), knowledge: this.knowledge.status() };
      case 'aiui_docs_read': { const doc = await this.knowledge.read(args.path, args.revision, args.from); const offset = Math.max(0, args.offset || 0), limit = Math.min(24000, args.limit || 16000); return { ...doc, content: doc.content.slice(offset, offset + limit), totalLength: doc.content.length, nextOffset: offset+limit < doc.content.length ? offset+limit : null }; }
      case 'aiui_context_get': {
        const project = args.projectId ? this.projects.get(args.projectId) : null;
        let skill = null; try { skill = await this.knowledge.read('skills/aiui-dev/SKILL.md', project?.knowledgeRevision); } catch {}
        return { project, ...this.runtimeInfo(project), sdkUpdates: this.sdk.status(), officialSkill: skill, knowledge: this.knowledge.status(), instruction: '先读取官方 Skill 及相关 references；所有操作显式传入 projectId / sessionId。源码由现有 AI 编码工具编辑，不复制维护另一套页面。优先用 aiui_preview_test 一次完成打开、等待、批量模拟、断言、截图和日志报告；用 aiui_project_build 一次完成官方检查、AIX 和平台导入清单。两者默认等待 45 秒，status 为 running 时才用 aiui_job_wait 继续。模拟通过不代表佩戴或发布通过；没有应用行为断言时只说明运行与输入正常。完整能力、边界与示例见 aiui_capabilities_get。Skill 文档引用通过 aiui_docs_read 继续读取。', capabilities: capabilities(), simulation: { input: 'keydown/keyup, keyup-only, repeated bursts', orientation: 'host absoluteOrientation capability, Android +Z gravity', camera: 'photo fixtures and opt-in computer webcam; continuous getUserMedia / ImageCapture.grabFrame / takePhoto; runtime Canvas and photo adapters encode preview-frame PNG, not full-resolution camera modes; no audio', bluetooth: 'unsupported', network:'online/offline events only; outbound application requests are not enabled', ai: 'no bundled model' } };
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
        if (existing.mcpServers?.['aiui-workbench']) return { path: file, status: 'already-configured' };
        try { await fs.copyFile(file, `${file}.backup-${Date.now()}`); } catch(e) { if (e.code !== 'ENOENT') throw e; }
        await atomicJson(file, { ...existing, mcpServers: { ...existing.mcpServers, ...this.config().mcpServers } });
        const ignoreFile=path.join(p.agentPath,'.aixignore'), ignoreText=await fs.readFile(ignoreFile,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
        const excluded=['.mcp.json','.mcp.json.backup-*','.aiui-workbench.json'];
        const missing=excluded.filter(rule=>!ignoreText.split(/\r?\n/).includes(rule));
        if(missing.length)await fs.writeFile(ignoreFile,ignoreText+(ignoreText&&!ignoreText.endsWith('\n')?'\n':'')+missing.join('\n')+'\n');
        return { path: file, status: 'configured', scope: 'project' };
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
  async close() { await this.knowledge.close(); await this.mirroring?.close(); await this.jobs.close(); await this.recordings?.close(); this.previews.close(); await this.sdk?.close(); await this.projects.close(); }
}
