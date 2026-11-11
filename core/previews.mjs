import fs from 'node:fs/promises';
import path from 'node:path';
import { id, redact, sha } from './util.mjs';

export class Previews {
  constructor(projects, home, emit) { this.projects = projects; this.home = home; this.emit = emit; this.sessions = new Map(); }
  list() { return [...this.sessions.values()].map(s => this.public(s)); }
  public(s) {
    const { key, pending, queue, fixture, logs, testLock, ...result } = s;
    let sdk = {};
    try { const release = this.getToolchain?.(this.projects.get(s.projectId)); if (release) sdk = { toolchainId: release.id, webSdkVersion: release.versions.ink, runtime: release.runtime, sdkUrl: `/sdk/${release.id}/index.js` }; } catch (e) { sdk = { sdkError: e.message }; }
    const sourceRevision = this.projects.get(s.projectId).revision;
    return { ...result, ...sdk, sourceRevision, stale: s.revision !== sourceRevision, status:s.status==='ready'&&s.lastSeen&&Date.now()-Date.parse(s.lastSeen)>4500?'detached':s.status, url: this.url(s, s.origin), logCount: logs.length };
  }
  get(sessionId) { const s = this.sessions.get(sessionId); if (!s) throw new Error('预览会话不存在，请先打开预览'); return s; }
  open(projectId, origin, { target = '_blank', page, requestedBy = 'desktop' } = {}) {
    const project = this.projects.get(projectId), existing = [...this.sessions.values()].find(s => s.projectId === projectId && s.target === target && s.page === (page || project.pages[0]));
    if (existing) { existing.requestedAt=Date.now();existing.requestedBy=requestedBy; if(existing.status==='closed'){existing.status='waiting';existing.queue=[];} return this.public(existing); }
    const s = { id: id(), key: id(), origin, requestedAt:Date.now(), requestedBy, projectId, page: page || project.pages[0], target, width: target === '_current' ? 448 : 480, height: target === '_current' ? 150 : 352, revision: project.revision, status: 'waiting', createdAt: new Date().toISOString(), state: {}, queue: [], pending: new Map(), logs: [], logGeneration: id(), fixture: null };
    this.sessions.set(s.id, s); this.emit('preview', this.public(s));
    return { ...this.public(s), url: this.url(s, origin) };
  }
  url(s, origin) { return `${origin}/runtime/preview/index.html?session=${s.id}&key=${s.key}`; }
  authorize(sessionId, key) { const s = this.get(sessionId); if (s.key !== key) throw new Error('预览会话授权无效'); return s; }
  log(s, level, message, generation = s.logGeneration, createdAt, context = {}) {
    // A new log can precede the runtime's next poll for the updated generation.
    // Its original timestamp preserves it without restoring buffered old logs.
    const afterClear = Number.isFinite(createdAt) && createdAt > (s.logsClearedAt || 0);
    if (generation !== s.logGeneration && !afterClear) return;
    if (Number.isFinite(createdAt) && !afterClear) return;
    const entry = { sequence: s.logSequence = (s.logSequence || 0) + 1, at: new Date().toISOString(), createdAt: Number.isFinite(createdAt)?createdAt:null, level, message: redact(message).slice(0,10000), runId: context.runId || null, revision: context.revision || s.revision }; s.logs.push(entry); s.logs = s.logs.slice(-500); this.emit('preview-log', { sessionId: s.id, ...entry });
  }
  clearLogs(sessionId) {
    const s = this.get(sessionId), deletedCount = s.logs.length;
    s.logs = []; s.logGeneration = id(); s.logsClearedAt = performance.timeOrigin + performance.now();
    this.emit('preview-logs-cleared', { sessionId, logGeneration: s.logGeneration });
    return { sessionId, deletedCount, logGeneration: s.logGeneration };
  }
  async action(sessionId, action, args = {}, { signal, observe = false } = {}) {
    signal?.throwIfAborted();
    const s = this.get(sessionId);
    let nextFixture;
    if (action === 'camera_fixture') {
      if (!/\.(png|jpe?g|webp)$/i.test(args.path || '')) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
      const info = await fs.stat(args.path); if (info.size > 10 * 1024 * 1024) throw new Error('模拟照片不能超过 10 MB');
      const data = await fs.readFile(args.path); nextFixture = { data: data.toString('base64'), mimeType: /\.png$/i.test(args.path) ? 'image/png' : /\.webp$/i.test(args.path) ? 'image/webp' : 'image/jpeg' };
      args = { fixture: nextFixture };
    }
    const command = { id: id(), action, args, createdAt: Date.now() };
    const result = await new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); s.pending.delete(command.id); s.queue = s.queue.filter(c => c.id !== command.id); };
      const abort = () => { clean(); reject(signal.reason || new Error('预览操作已取消')); };
      const timer = setTimeout(() => { clean(); reject(new Error('预览没有响应，请确认桌面模拟器已打开且页面仍在运行')); }, action === 'scenario' ? 90000 : 20000);
      s.pending.set(command.id, { observe, resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); }, timer }); s.queue.push(command);
      signal?.addEventListener('abort', abort, { once: true }); if(signal?.aborted)abort();
    });
    if (nextFixture) s.fixture = nextFixture;
    return result;
  }
  acknowledge(s, body) {
    const pending = s.pending.get(body.id); if (!pending) return;
    clearTimeout(pending.timer); s.pending.delete(body.id);
    if (body.error) pending.reject(new Error(redact(body.error))); else pending.resolve(pending.observe?{value:body.result,startedAt:body.startedAt,runId:body.runId}:body.result);
  }
  update(s, body) { s.status = body.status || s.status; s.state = body.state || s.state; s.lastSeen = new Date().toISOString(); if (body.revision) s.revision = body.revision; this.emit('preview', this.public(s)); }
  async capture(sessionId, options) {
    const result = await this.action(sessionId, 'capture', {}, options), s = this.get(sessionId);
    if (!result.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('预览未返回有效截图');
    const directory = path.join(this.home, 'captures', s.projectId); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${Date.now()}-${s.id.slice(0,8)}.png`);
    const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64'); await fs.writeFile(file, bytes);
    const revision = result.revision || s.revision;
    return { path: file, width: result.width, height: result.height, revision, runId: result.runId || null, sha256: sha(bytes), stale: revision !== this.projects.get(s.projectId).revision, simulated: true, data: result.dataUrl.split(',')[1] };
  }
  reload(projectId) { for (const s of this.sessions.values()) if (s.projectId === projectId && s.status !== 'closed') { s.status = 'loading'; if(!s.queue.some(c=>c.action==='reload'))s.queue.push({ id: id(), action: 'reload', args: {} }); } }
  removeProject(projectId) { for (const session of this.sessions.values()) if (session.projectId === projectId) { for (const pending of [...session.pending.values()]) pending.reject(new Error('项目已解绑')); session.queue = []; this.sessions.delete(session.id); } }
  close() { for (const s of this.sessions.values()) for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(new Error('预览已关闭')); } this.sessions.clear(); }
}
