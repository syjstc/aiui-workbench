import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import semver from 'semver';
import { ROOT, atomicJson, readJson, id } from './util.mjs';
import { APP_VERSION } from './version.mjs';

export const UPDATE_SOURCES = ['github', 'cnb', 'gitee', 'custom'];
export const MANIFEST_NAME = 'workbench-update.json';
const HOUR = 3600000, MAX_PACKAGE = 2 * 1024 ** 3;
export function httpsUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('更新地址不能为空');
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('更新地址必须是无账号、无片段的 HTTPS 地址');
  return url.href;
}

export function validateManifest(value, base, platform, arch) {
  const version = semver.valid(value?.version);
  if (value?.schemaVersion !== 1 || !version || semver.prerelease(version) || !Array.isArray(value.files)) throw new Error('更新清单格式或稳定版本号无效');
  const matches = value.files.filter(f => f.platform === platform && f.arch === arch);
  if (matches.length > 1) throw new Error('更新清单中有重复的平台安装包');
  let file = null;
  if (matches.length) {
    const entry = matches[0], url = httpsUrl(entry.url, base);
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    if (!name || name.length > 180 || /[\\/\x00-\x1f<>:"|?*]/.test(name) || !/\.(?:zip|dmg|exe|msi|AppImage|deb|rpm|tar\.gz)$/i.test(name)) throw new Error('安装包文件名或格式无效');
    if (!/^[a-f\d]{64}$/i.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_PACKAGE) throw new Error('安装包缺少有效的 SHA256 或文件大小');
    file = { platform, arch, url, name, sha256: entry.sha256.toLowerCase(), size: entry.size };
  }
  return { version, notes: String(value.notes || '').slice(0, 12000), publishedAt: value.publishedAt || null, releaseUrl: value.releaseUrl ? httpsUrl(value.releaseUrl, base) : null, file };
}

export class AppUpdates {
  constructor(home, { fetcher = fetch, now = Date.now, version = APP_VERSION, platform = process.platform, arch = process.arch } = {}) {
    this.home = home; this.fetcher = fetcher; this.now = now; this.version = version; this.platform = platform; this.arch = arch;
    this.file = path.join(home, 'app-updates.json'); this.controller = new AbortController(); this.latest = null; this.downloaded = null;
  }
  async init() {
    const defaults = await readJson(path.join(ROOT, 'assets/updates.json'));
    this.defaults = { autoCheck:true, intervalHours:24, ...defaults };
    const saved = await readJson(this.file, {});
    this.data = { autoCheck: true, intervalHours: 24, ...defaults, ...saved, sources: Object.fromEntries(UPDATE_SOURCES.map(key => [key, { ...defaults.sources[key], ...saved.sources?.[key] }])) };
    if (!UPDATE_SOURCES.includes(this.data.source)) this.data.source = 'github';
    if (![24, 168].includes(this.data.intervalHours)) this.data.intervalHours = 24;
    this.data.autoCheck = this.data.autoCheck !== false;
    return this;
  }
  configured() { const source = this.data.sources[this.data.source]; return !!(this.data.source === 'github' ? source.repository : source.manifestUrl); }
  status() {
    return { version: this.version, platform: this.platform, arch: this.arch, ...structuredClone(this.data), defaults:structuredClone(this.defaults), configured: this.configured(), checking: !!this.checking, downloading: !!this.downloading, progress: this.progress || null, latest: this.latest, updateAvailable: !!this.latest && semver.gt(this.latest.version, this.version), downloaded: this.downloaded };
  }
  async save() { await atomicJson(this.file, this.data); }
  async settings({ source, sources, autoCheck, intervalHours } = {}) {
    if (this.checking || this.downloading) throw new Error('正在检查或下载更新，请完成后再修改更新源');
    if (source !== undefined && !UPDATE_SOURCES.includes(source)) throw new Error('未知更新源');
    if (autoCheck !== undefined && typeof autoCheck !== 'boolean') throw new Error('自动检查设置无效');
    if (intervalHours !== undefined && ![24, 168].includes(intervalHours)) throw new Error('检查频率只能为每天或每周');
    const next = structuredClone(this.data), before = JSON.stringify([next.source, next.sources]);
    if (sources !== undefined) {
      if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new Error('更新源设置无效');
      for (const [key, value] of Object.entries(sources)) {
        if (!UPDATE_SOURCES.includes(key) || !value || typeof value !== 'object') throw new Error('未知更新源设置');
        if (key === 'github') {
          const repository = String(value.repository || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
          if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GitHub 仓库格式为 owner/repo');
          next.sources[key] = { repository };
        } else next.sources[key] = { manifestUrl: value.manifestUrl ? httpsUrl(String(value.manifestUrl).trim()) : '' };
      }
    }
    if (source !== undefined) next.source = source;
    if (autoCheck !== undefined) next.autoCheck = autoCheck;
    if (intervalHours !== undefined) next.intervalHours = intervalHours;
    if (before !== JSON.stringify([next.source, next.sources])) {
      this.latest = null; this.downloaded = null; this.progress = null;
      delete next.checkedAt; delete next.attemptedAt; delete next.error; delete next.nextCheckAt;
    }
    this.data = next; await this.save(); return this.status();
  }
  // Follow HTTPS redirects explicitly, including GitHub's signed asset CDN URLs.
  async request(url, signal) {
    let current = httpsUrl(url);
    for (let count = 0; count < 6; count++) {
      const response = await this.fetcher(current, { redirect: 'manual', headers: { Accept: 'application/json, application/octet-stream', 'User-Agent': `AIUI-Workbench/${this.version}` }, signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('更新源返回了无效跳转');
        current = httpsUrl(location, current); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`更新源请求失败：HTTP ${response.status}`); }
      return { response, url: current };
    }
    throw new Error('更新源跳转次数过多');
  }
  async json(url, signal) {
    const result = await this.request(url, signal); let length = 0, parts = [];
    for await (const chunk of result.response.body) {
      length += chunk.length; if (length > 1024 * 1024) throw new Error('更新清单超过大小限制'); parts.push(chunk);
    }
    return { value: JSON.parse(Buffer.concat(parts).toString('utf8')), url: result.url };
  }
  check() {
    if (this.downloading) return Promise.reject(new Error('请等待安装包下载完成'));
    if (!this.checking) this.checking = this.checkNow().finally(() => { this.checking = null; });
    return this.checking.then(() => this.status());
  }
  async checkNow() {
    if (!this.configured()) { this.data.error = null; return; }
    this.data.attemptedAt = new Date(this.now()).toISOString(); this.data.error = null;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]);
    try {
      const config = this.data.sources[this.data.source]; let manifestUrl = config.manifestUrl, release = null;
      if (this.data.source === 'github') {
        const result = await this.json(`https://api.github.com/repos/${config.repository}/releases/latest`, signal);
        release = result.value;
        if (release.draft || release.prerelease || !semver.valid(release.tag_name)) throw new Error('GitHub 最新发行版不是有效稳定版');
        const asset = release.assets?.find(a => a.name === MANIFEST_NAME);
        if (!asset) throw new Error(`该发行版未附带 ${MANIFEST_NAME}`);
        manifestUrl = httpsUrl(asset.browser_download_url);
      }
      // Resolve relative package URLs against the publisher's stable manifest URL,
      // not an expiring CDN redirect used to transfer the manifest itself.
      const result = await this.json(manifestUrl, signal), latest = validateManifest(result.value, manifestUrl, this.platform, this.arch);
      if (release && !semver.eq(release.tag_name, latest.version)) throw new Error('更新清单与发行版的版本号不一致');
      this.latest = latest;
      if (this.downloaded?.version !== latest.version || this.downloaded?.sha256 !== latest.file?.sha256) this.downloaded = null;
      this.data.checkedAt = new Date(this.now()).toISOString();
    } catch (error) { this.latest = null; this.downloaded = null; this.data.error = error.message; }
    this.data.nextCheckAt = new Date(this.now() + this.data.intervalHours * HOUR).toISOString(); await this.save();
  }
  start() {
    // Each desktop launch checks once; periodic checks then follow the setting.
    if (this.data.autoCheck && this.configured()) this.check().catch(() => {});
    this.timer = setInterval(() => {
      if (this.data.autoCheck && this.configured() && (!this.data.nextCheckAt || this.now() >= Date.parse(this.data.nextCheckAt))) this.check().catch(() => {});
    }, 60000); this.timer.unref();
  }
  download() {
    if (this.checking) return Promise.reject(new Error('请等待版本检查完成'));
    if (!this.downloading) this.downloading = this.downloadNow().finally(() => { this.downloading = null; });
    return this.downloading;
  }
  async downloadNow() {
    if (!this.latest || !semver.gt(this.latest.version, this.version) || !this.latest.file) throw new Error('没有适合当前系统的新版本安装包');
    const { file, version } = this.latest, dir = path.join(this.home, 'updates', version);
    await fs.mkdir(dir, { recursive: true }); const destination = path.join(dir, file.name), temporary = path.join(dir, id() + '.part');
    this.progress = { received: 0, total: file.size }; this.data.error = null;
    let handle;
    try {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      const { response } = await this.request(file.url, signal), hash = createHash('sha256');
      handle = await fs.open(temporary, 'wx', 0o600);
      for await (const chunk of response.body) {
        this.progress.received += chunk.length;
        if (this.progress.received > file.size) throw new Error('安装包大小与清单不符');
        hash.update(chunk); await handle.writeFile(chunk);
      }
      if (this.progress.received !== file.size || hash.digest('hex') !== file.sha256) throw new Error('安装包 SHA256 或大小校验失败，请更换源或稍后重试');
      await handle.close(); handle = null; await fs.rename(temporary, destination);
      this.downloaded = { path: destination, version, sha256: file.sha256, size: file.size }; return this.downloaded;
    } catch (error) { this.data.error = error.message; throw error; }
    finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
  }
  async close() { clearInterval(this.timer); this.controller.abort(); await Promise.allSettled([this.checking, this.downloading]); }
}
