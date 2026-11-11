import path from 'node:path';
import { id, redact, atomicJson, readJson } from './util.mjs';
export class Jobs {
  constructor(emit, home) { this.items = []; this.emit = emit; this.controllers = new Map(); this.file = home && path.join(home, 'jobs.json'); }
  async init() { if (this.file) this.items = (await readJson(this.file, [])).map(j => j.status === 'running' ? { ...j, status: 'interrupted', error: '上次服务结束时任务尚未完成，请检查结果后重新执行' } : j); return this; }
  save() { if (!this.file) return Promise.resolve(); const snapshot = this.list(); this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => atomicJson(this.file, snapshot)); return this.saving; }
  list() { return this.items.map(({ promise, ...j }) => ({ ...j, logs: j.logs.slice(-80) })); }
  get(jobId) { const j = this.items.find(j => j.id === jobId); if (!j) throw new Error('任务不存在'); const { promise, ...result } = j; return result; }
  async wait(jobId, waitMs = 45000) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 55000) throw new Error('等待时间范围为 0–55000 毫秒');
    const job = this.items.find(j => j.id === jobId); this.get(jobId);
    if (job.status === 'running' && waitMs > 0) {
      let timer;
      try { await Promise.race([job.promise, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
      finally { clearTimeout(timer); }
    }
    return this.get(jobId);
  }
  start(type, projectId, work, metadata = {}) {
    const controller = new AbortController(), job = { ...metadata, id: id(), type, projectId, status: 'running', startedAt: new Date().toISOString(), message: '准备中', logs: [] };
    this.controllers.set(job.id, controller); this.items.unshift(job); this.items = this.items.slice(0,60);
    const progress = message => { job.message = redact(message); job.logs.push({ at: new Date().toISOString(), message: job.message }); job.logs = job.logs.slice(-120); this.emit('job', this.get(job.id)); };
    this.save().catch(() => {});
    job.promise = (async () => { try { job.result = await work({ signal: controller.signal, progress }); job.status = controller.signal.aborted ? 'cancelled' : 'succeeded'; } catch(e) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = redact(e.message); if(e.result)job.result=e.result; } finally { job.finishedAt = new Date().toISOString(); this.controllers.delete(job.id); this.emit('job', this.get(job.id)); await this.save(); } })();
    return this.get(job.id);
  }
  cancel(jobId) { this.controllers.get(jobId)?.abort(); return this.get(jobId); }
  async delete(jobIds) {
    if (!Array.isArray(jobIds) || !jobIds.length || jobIds.length > 60 || jobIds.some(value => typeof value !== 'string' || !value)) throw new Error('请明确选择要删除的任务记录（最多 60 项）');
    const selected = new Set(jobIds), deletedIds = [], skippedRunningIds = [];
    this.items = this.items.filter(job => {
      if (!selected.has(job.id)) return true;
      if (job.status === 'running') { skippedRunningIds.push(job.id); return true; }
      deletedIds.push(job.id); return false;
    });
    if (deletedIds.length) { await this.save(); this.emit('jobs-deleted', { deletedIds }); }
    return { deletedIds, skippedRunningIds };
  }
  async close() { for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled(this.items.map(j => j.promise).filter(Boolean)); await this.save(); }
}
