import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ROOT, id } from './util.mjs';

const confirmation = z.object({ projectId: z.string().min(1), operation: z.enum(['detach', 'delete']), confirmationName: z.string(), confirmationPath: z.string(), expectedRevision: z.string(), acknowledged: z.literal(true) });
const contains = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };

export class ProjectRemoval {
  constructor(workbench) { this.w = workbench; this.intents = new Map(); this.reservations = new Set(); }
  locked(projectId) { return this.reservations.has(projectId) || [...this.intents.values()].some(intent => intent.projectId === projectId); }
  async begin(input) {
    const args = confirmation.parse(input);
    for (const intent of this.intents.values()) if (intent.expiresAt < Date.now()) await this.cancel(intent.id);
    if (this.locked(args.projectId)) throw new Error('此项目正在移除，请等待操作完成');
    const project = this.w.projects.get(args.projectId);
    if (args.confirmationName !== project.name || args.confirmationPath !== project.projectPath || args.expectedRevision !== project.revision) throw new Error('项目名称、路径或源码已变化，请重新打开确认窗口');
    if (this.w.jobs.list().some(job => job.projectId === project.id && job.status === 'running')) throw new Error('项目仍有任务运行，请先完成或取消任务');
    if (this.w.recordings.items.some(record => record.projectId === project.id && ['starting', 'recording', 'finalizing'].includes(record.status))) throw new Error('请先停止此项目的录制');
    if ([...this.w.previews.sessions.values()].some(session => session.projectId === project.id && session.pending.size)) throw new Error('项目仍有操作执行，请稍后重试');
    this.reservations.add(project.id);
    try {
    if (args.operation === 'delete') {
      const target = await fs.realpath(project.projectPath).catch(() => null);
      if (target !== project.projectPath) throw new Error('项目目录不存在或位置已变化，请使用解绑或重新导入');
      const protectedPaths = await Promise.all([path.parse(target).root, os.homedir(), ROOT, this.w.home].map(protectedPath => fs.realpath(protectedPath).catch(() => path.resolve(protectedPath))));
      if (protectedPaths.some(protectedPath => contains(target, protectedPath))) throw new Error('此目录包含工坊、用户目录或运行数据，不能删除');
      if (this.w.projects.items.some(other => other.id !== project.id && (contains(target, other.projectPath) || contains(target, other.agentPath)))) throw new Error('此目录还包含其他已绑定项目，请先处理这些项目');
    }
    const intent = { id: id(), projectId: project.id, name: project.name, path: project.projectPath, operation: args.operation, expiresAt: Date.now() + 5 * 60000 };
    this.intents.set(intent.id, intent);
    try { const watcher = this.w.projects.watchers.get(project.id); if (watcher) { await watcher.close(); this.w.projects.watchers.delete(project.id); } }
    catch (error) { this.intents.delete(intent.id); throw error; }
    return { ...intent };
    } finally { this.reservations.delete(project.id); }
  }
  async commit(intentId) {
    const intent = this.intents.get(intentId); if (!intent) throw new Error('确认已失效，请重新操作');
    if (intent.expiresAt < Date.now()) { await this.cancel(intentId); throw new Error('确认已失效，请重新操作'); }
    if (intent.operation === 'delete') {
      try { await fs.lstat(intent.path); throw new Error('项目目录尚未移到系统废纸篓或回收站'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.w.previews.removeProject(intent.projectId);
    await this.w.projects.forget(intent.projectId);
    this.intents.delete(intent.id);
    return { projectId: intent.projectId, name: intent.name, operation: intent.operation, filesDeleted: intent.operation === 'delete', destination: intent.operation === 'delete' ? 'system-trash' : null };
  }
  async cancel(intentId) {
    const intent = this.intents.get(intentId); if (!intent) return;
    this.intents.delete(intentId);
    const project = this.w.projects.items.find(item => item.id === intent.projectId);
    if (project && await fs.access(project.agentPath).then(() => true, () => false)) this.w.projects.watch(project);
  }
}
