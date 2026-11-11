import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { ROOT, atomicJson, readJson, safeRelative, sha } from './util.mjs';
import { documentCatalog, documentLink, resolveDocumentLink } from './document-links.mjs';

const REPO = 'yodaos-project/AIUI';
const wanted = p => /^(documentation\/.*\.(md|json)|skills\/aiui-dev\/.*\.(md|ink|js)|README(?:\.zh-CN)?\.md|LICENSE(?:\.md)?)$/.test(p);
async function fetchOk(url, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(90000)]), headers: { 'User-Agent': 'AIUI-Workbench/0.1', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`官方资料同步失败：HTTP ${response.status}`);
  return response;
}
export class Knowledge {
  constructor(home) { this.dir = path.join(home, 'knowledge'); this.meta = { status: 'empty', documents: 0, source: `https://github.com/${REPO}`, revision: null }; this.syncing = null; }
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
    return this;
  }
  status() { return { ...this.meta }; }
  async sync({ signal, progress = () => {} } = {}) {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync(signal, progress).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async doSync(signal, progress) {
    progress('正在检查官方仓库版本');
    const commit = await (await fetchOk(`https://api.github.com/repos/${REPO}/commits/main`, signal)).json();
    const revision = commit.sha;
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('官方资料版本校验失败');
    if (this.meta.revision === revision) { this.meta.checkedAt = new Date().toISOString(); await atomicJson(path.join(this.dir, 'current.json'), this.meta); return this.status(); }
    progress('正在读取官方文档目录');
    const tree = await (await fetchOk(`https://api.github.com/repos/${REPO}/git/trees/${revision}?recursive=1`, signal)).json();
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
          try { content = await (await fetchOk(`https://raw.githubusercontent.com/${REPO}/${revision}/${relative}`, signal)).text(); break; }
          catch(e) { if (signal?.aborted || attempt) throw e; }
        }
        const value = Buffer.from(content);
        const gitBlob = (await import('node:crypto')).createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
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
    this.meta = { status: 'ready', source: `https://github.com/${REPO}`, revision, documents: index.length, syncedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), upstreamDate: commit.commit?.committer?.date, license: 'Apache-2.0' };
    await atomicJson(path.join(this.dir, 'current.json'), this.meta);
    progress(`已同步 ${index.length} 份官方资料`);
    return this.status();
  }
  async index(revision = this.meta.revision) {
    if (!revision || !/^[a-f0-9]{40}$/.test(revision)) return [];
    const cached = await readJson(path.join(this.dir, revision, 'index.json'), null);
    return cached || readJson(path.join(ROOT, 'vendor/official', revision, 'index.json'), []);
  }
  async search(query = '', { limit = 16, offset = 0, revision, sort = 'recommended', locale = 'zh-CN' } = {}) {
    const index = await this.index(revision), words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const { order } = documentCatalog(index), collator = new Intl.Collator(locale === 'en' ? 'en' : 'zh-CN', { numeric: true, sensitivity: 'base' });
    const start = Math.max(0, Math.floor(offset) || 0);
    return index.map(d => { const lower = d.content.toLowerCase(), title = (d.title + ' ' + d.path).toLowerCase(), headings=lower.split('\n').filter(l=>l.startsWith('#')).join(' '); const score = words.reduce((n,w) => n + (title.includes(w)?30:0) + (headings.includes(w)?20:0) + Math.min(15,lower.split(w).length-1),0); const at = words.length ? Math.max(0, lower.indexOf(words[0])) : 0; return { path: d.path, title: d.title, score, excerpt: d.content.slice(Math.max(0,at-80),at+260), revision: revision || this.meta.revision, source: `https://github.com/${REPO}/blob/${revision || this.meta.revision}/${d.path}` }; }).filter(d => !words.length || d.score > 0).sort((a,b) => {
      const language = (Number(a.path.includes('.en-US.')) - Number(b.path.includes('.en-US.'))) * (locale === 'en' ? -1 : 1);
      if (sort === 'title') return language || collator.compare(a.title, b.title) || collator.compare(a.path, b.path);
      if (sort === 'path') return language || collator.compare(a.path, b.path);
      return b.score - a.score || language || (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity) || collator.compare(a.path, b.path);
    }).slice(start, start + Math.max(1, Math.min(limit, 50)));
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
