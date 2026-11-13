import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { watch } from 'chokidar';
import ignore from 'ignore';
import { atomicJson, readJson, id, inside, sha, ROOT } from './util.mjs';
import { t } from '../shared/i18n.mjs';
import { projectIcon, projectIconWatchPaths } from './project-icon.mjs';

const SKIP = new Set(['node_modules', '.git', '.aix', '.local', 'dist', 'output', 'artifacts', '.DS_Store', '.claude', '.cursor', '.agents', '.mcp.json', '.aiui-workbench.json']);
export function sourceRevision(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.path).update('\0').update(file.data).update('\0');
  return hash.digest('hex');
}
export async function collectFiles(root) {
  const entries = [], rules = ignore();
  try { rules.add(await fs.readFile(path.join(root, '.aixignore'), 'utf8')); } catch {}
  let bytes = 0;
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (rules.ignores(relative + (entry.isDirectory() ? '/' : ''))) continue;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), relative + '/');
      else if (entry.isFile()) {
        const data = await fs.readFile(path.join(dir, entry.name)); bytes += data.length;
        if (entries.length >= 5000 || bytes > 64 * 1024 * 1024) throw new Error('项目超过本地预览上限（5000 个文件 / 64 MB）');
        entries.push({ path: relative, data });
      }
    }
  }
  await visit(root);
  return entries;
}
export class Projects {
  constructor(home, emit) { this.home = home; this.file = path.join(home, 'projects.json'); this.emit = emit; this.items = []; this.watchers = new Map(); }
  async init() {
    this.items = await readJson(this.file, []);
    for (const item of this.items) { try { await this.refresh(item.id, false); this.watch(item); } catch (e) { item.missing = true; item.error = e.message; } }
    return this;
  }
  list() { return this.items.map(item => ({ ...item })); }
  get(projectId) { const item = this.items.find(p => p.id === projectId); if (!item) throw new Error('项目不存在，请先导入项目'); return item; }
  async save() {
    const snapshot = structuredClone(this.items);
    this.saveQueue = (this.saveQueue || Promise.resolve()).catch(() => {}).then(() => atomicJson(this.file, snapshot));
    await this.saveQueue; this.emit('projects', this.list());
  }
  async import(directory) {
    const projectPath = await fs.realpath(directory);
    let agentPath = projectPath;
    try { await fs.access(path.join(agentPath, 'app.json')); } catch { agentPath = path.join(projectPath, 'agent'); }
    agentPath = await fs.realpath(agentPath);
    const existing = this.items.find(p => p.agentPath === agentPath);
    if (existing) { await this.refresh(existing.id); return existing; }
    this.pendingImports ||= new Map();
    if (this.pendingImports.has(agentPath)) return this.pendingImports.get(agentPath);
    const pending = this.importNew(projectPath, agentPath).finally(() => this.pendingImports.delete(agentPath));
    this.pendingImports.set(agentPath, pending);
    return pending;
  }
  async importNew(projectPath, agentPath) {
    const app = await readJson(path.join(agentPath, 'app.json'));
    if (!Array.isArray(app.pages) && !Array.isArray(app.widgets)) throw new Error('所选目录不是 AIUI 项目：缺少页面或 Widget 声明');
    const item = { id: id(), projectPath, agentPath, toolchainId: this.getToolchain?.().id, importedAt: new Date().toISOString(), openedAt: new Date().toISOString(), platform: { status: 'unlinked' } };
    // Status polling must never see a project before its name/pages/revision
    // are available. Slow disks can otherwise expose an incomplete UI card.
    await this.refreshItem(item, false);
    this.items.unshift(item);
    try { await this.save(); this.watch(item); return item; } catch (e) { this.items = this.items.filter(p => p !== item); throw e; }
  }
  async refresh(projectId, save = true) {
    return this.refreshItem(this.get(projectId), save);
  }
  async refreshItem(p, save = true) {
    const app = await readJson(path.join(p.agentPath, 'app.json'));
    const files = await collectFiles(p.agentPath);
    const revision = sourceRevision(files), changed = p.revision && p.revision !== revision;
    Object.assign(p, { name: app.agentName || app.name || path.basename(p.projectPath), description: app.agentDesc || app.description || '', version: app.version || '未声明', engine: app.engine || '*', pages: app.pages || [], widgets: app.widgets || [], permissions: app.permissions || [], revision, fileCount: files.length, size: files.reduce((n,f) => n+f.data.length, 0), missing: false, error: null });
    if (changed) { p.changedAt = new Date().toISOString(); if (p.lastCheck) p.lastCheck.stale = true; }
    try { p.agentId = (await fs.readFile(path.join(p.agentPath, '.aix/agent-id'), 'utf8')).trim(); } catch { p.agentId = null; }
    Object.assign(p, await projectIcon(p, app, files));
    if (save) await this.save();
    if (changed) this.emit('source-changed', { projectId: p.id, revision: p.revision });
    return p;
  }
  watch(p) {
    if (this.watchers.has(p.id)) return;
    let timer, closing = false, pending = Promise.resolve();
    const watcher = watch(projectIconWatchPaths(p), { ignoreInitial: true, followSymlinks: false, ignored: entry => path.relative(p.projectPath, entry).split(path.sep).some(part => SKIP.has(part) || part.startsWith('.mcp.json.backup-')), awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 } });
    const refresh = () => {
      if (closing) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending = pending.then(async () => {
          if (closing) return;
          try { await this.refresh(p.id); } catch(e) { p.error = e.message; await this.save(); }
        });
      }, 250);
    };
    // Reconcile the gap between reading metadata and the native watch becoming
    // active; initial events are ignored and can coalesce with an atomic save.
    watcher.on('ready', refresh);
    watcher.on('all', refresh);
    watcher.on('error', error => this.emit('log', { level: 'error', message: error.message, projectId: p.id, revision: p.revision }));
    this.watchers.set(p.id, { watcher, close: async () => { closing = true; clearTimeout(timer); await watcher.close(); await pending; } });
  }
  async bundle(projectId) {
    const p = this.get(projectId), files = await collectFiles(p.agentPath);
    return { project: { ...p, revision: sourceRevision(files) }, files: files.map(f => ({ path: '/' + f.path, base64: f.data.toString('base64') })) };
  }
  async create({ directory, name = '我的 AIUI 应用', template = 'page', locale = 'zh-CN' }, knowledge) {
    const target = path.resolve(directory);
    try { await fs.access(target); throw new Error('目标目录已存在，请选择一个新目录'); } catch(e) { if (e.code !== 'ENOENT') throw e; }
    const source = await knowledge.read('skills/aiui-dev/assets/minimal-page.ink');
    if (template !== 'page') throw new Error('首版支持全屏 Page 模板');
    await fs.mkdir(path.join(target, 'pages/index'), { recursive: true });
    await fs.writeFile(path.join(target, 'pages/index/index.ink'), source.content);
    await atomicJson(path.join(target, 'app.json'), { name, agentName: name, version: '0.1.0', engine: '>=0.18.0', pages: ['pages/index/index'], permissions: [], window: { navigationBarTitleText: '', backgroundColor: '#000000' } });
    const cli = { command: process.execPath, args: [path.join(ROOT,'web/cli.mjs')], env: { AIUI_WORKBENCH_HOME:this.home, ...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{}) } };
    await fs.writeFile(path.join(target, 'AGENTS.md'), t('# {0}\n\n使用 MCP 工具 aiui_context_get 获取本项目版本对应的官方开发规范。\n开发全屏交互 Page；模拟通过、真机通过与平台发布分别验收。\n', { 0: name }, locale) + t('\n优先使用 aiui_preview_test 一次模拟并返回断言、截图和日志；通过后使用 aiui_project_build 检查并打包。\n没有 MCP 时，使用以下工坊 CLI 入口，保留 env 以共享桌面项目、模拟日志和任务。\n在 args 后追加 tools 查看能力，或追加 call、工具名、--args-file、参数文件路径执行；参数文件仅包含工具参数 JSON。\n直接调用独立 aix 的终端日志不会同步。\n\n```json\n{0}\n```\n', {0:JSON.stringify(cli,null,2)}, locale));
    await fs.mkdir(path.join(target,'lib'),{recursive:true});
    await fs.copyFile(path.join(ROOT,'assets/templates/temple-navigation.js'),path.join(target,'lib/temple-navigation.js'));
    const inputRules=locale==='en'?'\n## Temple input\nUse lib/temple-navigation.js for discrete menus and paging. One physical swipe performs at most one action. Normalize direction aliases and coalesce repeats, including keyup-only firmware. Repeats refresh the quiet window; do not use a fixed cooldown. Clear input on hide/unload/card transitions and consume only owned keys. Canvas rendering must exclude synchronous blocking time with excludeBlockedTime(). Test long swipes, duplicate aliases, a second swipe after a pause, reverse, paging and back. Simulator success does not establish worn gesture acceptance.\n':'\n## 镜腿离散输入\n菜单和翻页使用 lib/temple-navigation.js。一次物理滑动最多执行一次离散操作。归一方向别名、合并重复事件，兼容 keyup-only 固件。重复事件持续刷新静默窗口，不使用固定周期防抖；页面隐藏、销毁或切换卡片时清理，消费接管的按键。Canvas 同步绘制应调用 excludeBlockedTime() 扣除阻塞时间。至少测试长滑、重复别名、停顿后第二滑、反向、翻页与返回。模拟通过不代表佩戴手势已验收。\n';
    await fs.appendFile(path.join(target,'AGENTS.md'),inputRules);
    await fs.writeFile(path.join(target, '.aixignore'), '.aiui-workbench.json\n.mcp.json\n.mcp.json.backup-*\nAGENTS.md\nnode_modules/\n.agents/\n.claude/\n.cursor/\n.codex/\n');
    const toolchain = this.getToolchain?.();
    await atomicJson(path.join(target, '.aiui-workbench.json'), { version: 1, knowledgeRevision: source.revision, runtime: toolchain?.runtime, webSdkVersion: toolchain?.versions.ink, template: source.path });
    const p = await this.import(target);
    p.knowledgeRevision = source.revision;
    await this.save();
    return p;
  }
  async forget(projectId) {
    const project = this.get(projectId), index = this.items.indexOf(project), watcher = this.watchers.get(projectId);
    if (watcher) { await watcher.close(); this.watchers.delete(projectId); }
    this.items.splice(index, 1);
    try { await this.save(); }
    catch (error) { this.items.splice(index, 0, project); if (await fs.access(project.agentPath).then(() => true, () => false)) this.watch(project); throw error; }
    return project;
  }
  async close() { await Promise.all([...this.watchers.values()].map(w => w.close())); this.watchers.clear(); await this.saveQueue; }
}
