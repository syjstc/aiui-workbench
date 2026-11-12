import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, atomicJson, readJson, safeRelative, sha, redact } from './util.mjs';
import { documentCatalog, documentLink, resolveDocumentLink } from './document-links.mjs';
import { DocumentSearch } from './document-search.mjs';
import { documentNavigation } from './document-navigation.mjs';
import { documentImagePath, documentImages, isDocumentImage, imageMime } from './document-images.mjs';

const REPO = 'yodaos-project/AIUI';
const wanted = p => /^(documentation\/.*\.(md|json)|skills\/aiui-dev\/.*\.(md|ink|js)|README(?:\.zh-CN)?\.md|LICENSE(?:\.md)?)$/.test(p);
const HOUR = 3600000;
async function fetchOk(url, signal, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]), headers: { 'User-Agent': 'AIUI-Workbench/0.1', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`官方资料同步失败：HTTP ${response.status}`);
  return response;
}
export class Knowledge {
  constructor(home, { fetcher = fetch, now = Date.now, emit = () => {} } = {}) {
    this.dir = path.join(home, 'knowledge'); this.meta = { status: 'empty', documents: 0, source: `https://github.com/${REPO}`, revision: null }; this.syncing = null;
    this.fetcher = fetcher; this.now = now; this.emit = emit; this.controller = new AbortController();
    this.updates = { autoUpdate: true, intervalHours: 24 }; this.indexes = new Map(); this.searchIndexes = new Map();
    this.imageManifests = new Map(); this.imageRequests = new Map();
  }
  async init() {
    this.meta = await readJson(path.join(this.dir, 'current.json'), this.meta);
    if (!this.meta.revision) {
      const bundled = await readJson(path.join(ROOT, 'vendor/official/current.json'), null);
      if (bundled) {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.cp(path.join(ROOT, 'vendor/official', bundled.revision), path.join(this.dir, bundled.revision), { recursive: true });
        this.meta = { ...bundled, bundled: true };
        await atomicJson(path.join(this.dir, 'current.json'), this.meta);
      }
    }
    this.updates = { ...this.updates, ...await readJson(path.join(this.dir, 'updates.json'), {}) };
    this.updates.autoUpdate = this.updates.autoUpdate !== false;
    this.updates.intervalHours = [24, 168].includes(this.updates.intervalHours) ? this.updates.intervalHours : 24;
    return this;
  }
  status() { return { ...this.meta, ...this.updates, syncing: Boolean(this.syncing), nextCheckAt: this.updates.autoUpdate ? this.updates.nextCheckAt || null : null }; }
  saveUpdates() {
    const value = { ...this.updates };
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => atomicJson(path.join(this.dir, 'updates.json'), value));
    return this.saving.then(() => this.emit('knowledge', this.status()));
  }
  async settings({ autoUpdate, intervalHours } = {}) {
    if (autoUpdate !== undefined && typeof autoUpdate !== 'boolean') throw new Error('文档自动更新设置无效');
    if (intervalHours !== undefined && ![24, 168].includes(intervalHours)) throw new Error('文档更新频率只能为每天或每周');
    if (autoUpdate !== undefined) this.updates.autoUpdate = autoUpdate;
    if (intervalHours !== undefined) this.updates.intervalHours = intervalHours;
    this.updates.nextCheckAt = new Date(this.now() + this.updates.intervalHours * HOUR).toISOString();
    await this.saveUpdates(); return this.status();
  }
  start(onDue = () => this.sync()) {
    if (this.timer) return;
    const tick = () => this.checkIfDue(onDue).catch(() => {});
    this.startTimer = setTimeout(tick, 3000); this.startTimer.unref();
    this.timer = setInterval(tick, 60000); this.timer.unref();
  }
  async checkIfDue(onDue = () => this.sync()) {
    if (!this.controller.signal.aborted && this.updates.autoUpdate && !this.syncing && (!this.updates.nextCheckAt || this.now() >= Date.parse(this.updates.nextCheckAt))) return onDue();
    return this.status();
  }
  async close() {
    clearTimeout(this.startTimer); clearInterval(this.timer); this.timer = null; this.controller.abort();
    await this.syncing?.catch(() => {}); await this.saving;
  }
  async sync({ signal, progress = () => {} } = {}) {
    if (this.syncing) { await this.syncing; return this.status(); }
    const combined = AbortSignal.any([this.controller.signal, signal || this.controller.signal]);
    this.syncing = (async () => {
      this.updates.attemptedAt = new Date(this.now()).toISOString();
      await this.saveUpdates();
      try {
        await this.doSync(combined, progress);
        this.updates.error = null;
        this.updates.nextCheckAt = new Date(this.now() + this.updates.intervalHours * HOUR).toISOString();
      } catch (error) {
        this.updates.error = redact(error.message);
        this.updates.nextCheckAt = new Date(this.now() + HOUR).toISOString();
        throw error;
      } finally { await this.saveUpdates(); }
    })().finally(() => { this.syncing = null; this.emit('knowledge', this.status()); });
    await this.syncing;
    return this.status();
  }
  async doSync(signal, progress) {
    progress('正在检查官方仓库版本');
    const commit = await (await fetchOk(`https://api.github.com/repos/${REPO}/commits/main`, signal, this.fetcher)).json();
    const revision = commit.sha;
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('官方资料版本校验失败');
    if (this.meta.revision === revision) {
      const images = await this.cacheImages(await this.index(revision), revision, signal, progress);
      this.meta = { ...this.meta, images, checkedAt: new Date(this.now()).toISOString() };
      await atomicJson(path.join(this.dir, 'current.json'), this.meta); return this.status();
    }
    progress('正在读取官方文档目录');
    const tree = await (await fetchOk(`https://api.github.com/repos/${REPO}/git/trees/${revision}?recursive=1`, signal, this.fetcher)).json();
    if (tree.truncated) throw new Error('官方目录返回不完整，保留现有资料版本');
    const entries = tree.tree.filter(f => f.type === 'blob' && wanted(f.path) && f.size < 2 * 1024 * 1024);
    if (entries.length > 1800) throw new Error('官方资料目录超过同步上限');
    const snapshot = path.join(this.dir, revision), index = [];
    await fs.mkdir(snapshot, { recursive: true });
    let completed = 0, cursor = 0;
    const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++], relative = entry.path; safeRelative(relative);
        let content;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { content = await (await fetchOk(`https://raw.githubusercontent.com/${REPO}/${revision}/${relative}`, signal, this.fetcher)).text(); break; }
          catch(e) { if (signal?.aborted || attempt) throw e; }
        }
        const value = Buffer.from(content);
        const gitBlob = createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
        if (gitBlob !== entry.sha) throw new Error(`官方资料完整性核对失败：${relative}`);
        await fs.mkdir(path.dirname(path.join(snapshot, relative)), { recursive: true });
        await fs.writeFile(path.join(snapshot, relative), value);
        index.push({ path: relative, title: content.match(/^#\s+(.+)$/m)?.[1] || path.basename(relative), sha256: sha(value), content });
        completed++; if (completed % 15 === 0 || completed === entries.length) progress(`正在同步官方文档与 Skill：${completed} / ${entries.length}`);
      }
    });
    await Promise.all(workers);
    index.sort((a,b) => a.path.localeCompare(b.path));
    if (!index.some(d => d.path === 'skills/aiui-dev/SKILL.md') || !index.some(d => d.path === 'skills/aiui-dev/assets/minimal-page.ink')) throw new Error('官方资料缺少必要 Skill 或模板；保留上一次版本');
    await atomicJson(path.join(snapshot, 'index.json'), index);
    const images = await this.cacheImages(index, revision, signal, progress, tree.tree);
    this.indexes.delete(revision); this.searchIndexes.delete(revision);
    const updated = { status: 'ready', source: `https://github.com/${REPO}`, revision, documents: index.length, images, syncedAt: new Date(this.now()).toISOString(), checkedAt: new Date(this.now()).toISOString(), upstreamDate: commit.commit?.committer?.date, license: 'Apache-2.0' };
    await atomicJson(path.join(this.dir, 'current.json'), updated);
    this.meta = updated;
    progress(`已同步 ${index.length} 份官方资料`);
    return this.status();
  }
  async index(revision = this.meta.revision) {
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) return [];
    if (!this.indexes.has(revision)) {
      const pending = (async () => {
        const cached = await readJson(path.join(this.dir, revision, 'index.json'), null);
        const index = cached || await readJson(path.join(ROOT, 'vendor/official', revision, 'index.json'), []);
        if (!index.length) this.indexes.delete(revision);
        return index;
      })().catch(error => { this.indexes.delete(revision); throw error; });
      this.indexes.set(revision, pending);
    }
    return this.indexes.get(revision);
  }
  async searchPage(query = '', options = {}) {
    const revision = options.revision || this.meta.revision, index = await this.index(revision);
    if (!this.searchIndexes.has(revision)) this.searchIndexes.set(revision, new DocumentSearch(index));
    return this.searchIndexes.get(revision).search(query, { ...options, revision });
  }
  async search(query = '', options = {}) { return (await this.searchPage(query, options)).documents; }
  async catalog(options = {}) {
    const revision = options.revision || this.meta.revision;
    return documentNavigation(await this.index(revision), { ...options, revision });
  }
  async imageManifest(revision, signal = this.controller.signal, entries) {
    if (!this.imageManifests.has(revision)) this.imageManifests.set(revision, (async () => {
      const file = path.join(this.dir, revision, 'images.json');
      let manifest = await readJson(file, null) || await readJson(path.join(ROOT, 'vendor/official', revision, 'images.json'), null);
      if (!manifest) {
        const tree = entries || (await (await fetchOk(`https://api.github.com/repos/${REPO}/git/trees/${revision}?recursive=1`, signal, this.fetcher)).json()).tree;
        if (!Array.isArray(tree)) throw new Error('官方图片目录读取失败');
        manifest = tree.filter(entry => entry.type === 'blob' && isDocumentImage(entry.path) && /^[a-f0-9]{40}$/.test(entry.sha) && entry.size <= 10 * 1024 * 1024).map(({ path, sha, size }) => ({ path, sha, size }));
        await atomicJson(file, manifest);
      }
      return manifest;
    })().catch(error => { this.imageManifests.delete(revision); throw error; }));
    return this.imageManifests.get(revision);
  }
  async imageAsset(relative, revision, signal = this.controller.signal) {
    const key = `${revision}/${relative}`;
    if (!this.imageRequests.has(key)) this.imageRequests.set(key, (async () => {
      const entry = (await this.imageManifest(revision, signal)).find(item => item.path === relative);
      if (!entry) throw new Error('该版本未包含此图片');
      const file = path.join(this.dir, revision, relative);
      let bytes = await fs.readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      bytes ||= await fs.readFile(path.join(ROOT, 'vendor/official', revision, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!bytes) {
        const response = await fetchOk(`https://raw.githubusercontent.com/${REPO}/${revision}/${relative}`, signal, this.fetcher);
        if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('官方图片超过大小限制');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error('官方图片超过大小限制'); chunks.push(chunk); }
        bytes = Buffer.concat(chunks);
        if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new Error('官方图片完整性核对失败');
        imageMime(bytes);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes, { mode: 0o600 });
      }
      return { path: relative, revision, dataUrl: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}` };
    })().finally(() => this.imageRequests.delete(key)));
    return this.imageRequests.get(key);
  }
  async image({ path: href, from, revision = this.meta.revision }) {
    safeRelative(from);
    const document = (await this.index(revision)).find(doc => doc.path === from), relative = documentImagePath(href, from);
    if (!document || !relative || !documentImages(document).has(relative)) throw new Error('无效的文档图片引用');
    return this.imageAsset(relative, revision);
  }
  async cacheImages(index, revision, signal, progress, entries) {
    const images = [...new Set(index.flatMap(doc => [...documentImages(doc)]))];
    let cached = 0, cursor = 0;
    const missing = [];
    if (!images.length) return { total: 0, cached: 0, missing };
    try { await this.imageManifest(revision, signal, entries); }
    catch (error) { if (signal.aborted) throw error; return { total: images.length, cached: 0, missing: images, error: redact(error.message) }; }
    await Promise.all(Array.from({ length: Math.min(4, images.length) }, async () => {
      while (cursor < images.length) {
        signal.throwIfAborted(); const relative = images[cursor++];
        try { await this.imageAsset(relative, revision, signal); cached++; }
        catch (error) { if (signal.aborted) throw error; missing.push(relative); }
        if ((cached + missing.length) % 10 === 0 || cached + missing.length === images.length) progress(`正在缓存文档图片：${cached + missing.length} / ${images.length}`);
      }
    }));
    return { total: images.length, cached, missing };
  }
  async read(relative, revision = this.meta.revision, from) {
    if (!from && !/^(?:https?:|\/)/.test(relative)) safeRelative(relative);
    if (from) safeRelative(from);
    const index = await this.index(revision), link = documentLink(relative, from);
    const target = link && resolveDocumentLink(link, documentCatalog(index));
    const doc = target && index.find(d => d.path === target.path);
    if (!doc) throw new Error('资料尚未同步或该版本没有此文档，请先同步官方资料');
    return { ...doc, fragment: target.fragment, revision, source: `https://github.com/${REPO}/blob/${revision}/${doc.path}` };
  }
}
