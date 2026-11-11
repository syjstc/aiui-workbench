import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { createRequire } from 'node:module';
import { ROOT, atomicJson, readJson, run, id, sha, redact } from './util.mjs';
import { collectFiles, sourceRevision } from './projects.mjs';

export const SDK_PACKAGES = { ink: '@yodaos-pkg/ink', cli: '@yodaos-pkg/aix-cli' };
const require = createRequire(import.meta.url);
const bundledPackage = name => path.dirname(require.resolve(name + '/package.json'));
const REGISTRY = 'https://registry.npmjs.org';
const HOUR = 3600000;
const stable = value => !!semver.valid(value) && !semver.prerelease(value);
const releaseId = value => typeof value === 'string' && /^(?:bundled-[\d.]+-[\d.]+|[a-f0-9-]{36})$/.test(value);

export async function probeSdk(directory, ranges = [], options = {}) {
  const result = await run(process.execPath, [path.join(ROOT, 'core/sdk-probe.mjs'), directory, JSON.stringify(ranges)], { ...options, timeout: 30000 });
  const record = result.output.match(/WORKBENCH_SDK_PROBE (.+)/);
  if (result.code !== 0 || !record) throw new Error('SDK 引擎或工坊接口检查失败：' + result.output);
  const value = JSON.parse(record[1]);
  if (!semver.valid(value.runtime)) throw new Error('SDK 未返回有效的实际引擎版本');
  return value;
}

export function registryMetadata(value, name) {
  if (value?.name !== name || !stable(value.version)) throw new Error(`${name} 的 latest 不是有效稳定版`);
  const url = new URL(value.dist?.tarball);
  if (url.origin !== REGISTRY || url.username || url.password || !url.pathname.startsWith('/' + name + '/-/')) throw new Error('安装包不在官方 npm 源');
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.dist?.integrity || '')) throw new Error('官方安装包缺少 SHA512 完整性信息');
  if (value.deprecated) throw new Error(`${name} ${value.version} 已被上游弃用：${value.deprecated}`);
  return { name, version: value.version, tarball: url.href, integrity: value.dist.integrity, node: value.engines?.node || '*' };
}

export class SdkManager {
  constructor(home, projects, emit, { fetcher = fetch, execute = run, probe = probeSdk, now = Date.now } = {}) {
    this.home = home; this.dir = path.join(home, 'sdk'); this.file = path.join(this.dir, 'state.json');
    this.projects = projects; this.emit = emit; this.fetcher = fetcher; this.execute = execute; this.probe = probe; this.now = now;
    this.releases = new Map(); this.checking = null; this.operation = null; this.controller = new AbortController();
  }
  async init() {
    const versions = {};
    for (const [key, name] of Object.entries(SDK_PACKAGES)) versions[key] = (await readJson(path.join(bundledPackage(name), 'package.json'))).version;
    const actual = await this.probe(bundledPackage(SDK_PACKAGES.ink));
    this.bundled = { id: `bundled-${versions.ink}-${versions.cli}`, versions, runtime: actual.runtime, bundleVersion: actual.bundleVersion, bundled: true };
    this.releases.set(this.bundled.id, this.bundled);
    this.data = await readJson(this.file, { autoCheck: true, intervalHours: 24, activeId: this.bundled.id, history: [], installed: [] });
    this.data.autoCheck = this.data.autoCheck !== false;
    this.data.intervalHours = [24, 168].includes(this.data.intervalHours) ? this.data.intervalHours : 24;
    for (const entry of this.data.installed || []) {
      if (!releaseId(entry.id) || entry.bundled) continue;
      try {
        for (const [key, name] of Object.entries(SDK_PACKAGES)) {
          const pkg = await readJson(path.join(this.directory(entry.id), 'node_modules', name, 'package.json'));
          if (pkg.name !== name || pkg.version !== entry.versions[key]) throw new Error('版本文件不匹配');
        }
        this.releases.set(entry.id, entry);
      } catch { this.data.error = '一个已下载的 SDK 版本不完整，请重新下载；关联项目不会自动换版。'; }
    }
    if (!this.releases.has(this.data.activeId)) { this.data.activeId = this.bundled.id; this.data.error = '默认 SDK 不可用，已恢复内置版本；请检查项目的版本设置。'; }
    for (const p of this.projects.items) if (!p.toolchainId) p.toolchainId = this.data.activeId;
    if (this.projects.items.length) await this.projects.save();
    return this;
  }
  directory(versionId) {
    if (!releaseId(versionId)) throw new Error('无效的 SDK 版本标识');
    return versionId === this.bundled?.id ? ROOT : path.join(this.dir, 'releases', versionId);
  }
  get(versionId = this.data.activeId) { const value = this.releases.get(versionId); if (!value) throw new Error('项目绑定的 SDK 版本不可用，请在 SDK 更新中检查版本'); return value; }
  forProject(project) { return this.get(project.toolchainId || this.data.activeId); }
  packagePath(versionId, key) { const release = this.get(versionId); return release.bundled ? bundledPackage(SDK_PACKAGES[key]) : path.join(this.directory(versionId), 'node_modules', SDK_PACKAGES[key]); }
  cliPath(versionId = this.data.activeId) { return path.join(this.packagePath(versionId, 'cli'), 'dist/cli.js'); }
  status() {
    const active = this.get();
    const candidate = this.data.candidate && Object.keys(SDK_PACKAGES).every(key => semver.gte(this.data.candidate.packages[key].version, active.versions[key])) && Object.keys(SDK_PACKAGES).some(key => semver.gt(this.data.candidate.packages[key].version, active.versions[key])) ? this.data.candidate : null;
    const report = this.data.report ? { ...this.data.report, stale: this.reportStale(this.data.report) } : null;
    return { active, installed: [...this.releases.values()], candidate, updateAvailable: !!candidate, checking: !!this.checking, operation: this.operation,
      autoCheck: this.data.autoCheck, intervalHours: this.data.intervalHours, checkedAt: this.data.checkedAt, attemptedAt: this.data.attemptedAt,
      nextCheckAt: this.data.autoCheck ? this.data.nextCheckAt : null, error: this.data.error, report,
      canRollback: (this.data.history || []).some(key => key !== active.id && this.releases.has(key)), registry: REGISTRY };
  }
  async save() {
    this.data.installed = [...this.releases.values()].filter(r => !r.bundled);
    const snapshot = structuredClone(this.data);
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => atomicJson(this.file, snapshot));
    await this.saving; this.emit('sdk', this.status());
  }
  start() {
    const tick = () => this.checkIfDue().catch(() => {});
    this.timer = setInterval(tick, 60000); this.timer.unref(); tick();
  }
  async checkIfDue() {
    if (this.data.autoCheck && (!this.data.nextCheckAt || this.now() >= Date.parse(this.data.nextCheckAt))) return this.check();
    return this.status();
  }
  async settings({ autoCheck, intervalHours } = {}) {
    if (autoCheck !== undefined && typeof autoCheck !== 'boolean') throw new Error('自动检查设置无效');
    if (intervalHours !== undefined && ![24, 168].includes(intervalHours)) throw new Error('检查频率只能为每天或每周');
    if (autoCheck !== undefined) this.data.autoCheck = autoCheck;
    if (intervalHours !== undefined) this.data.intervalHours = intervalHours;
    this.data.nextCheckAt = new Date(this.now() + this.data.intervalHours * HOUR).toISOString();
    await this.save(); return this.status();
  }
  async metadata(name, version = 'latest', signal) {
    const response = await this.fetcher(`${REGISTRY}/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.any([this.controller.signal, signal || this.controller.signal, AbortSignal.timeout(20000)]), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${name} 版本检查失败：HTTP ${response.status}`);
    return registryMetadata(await response.json(), name);
  }
  check() {
    if (!this.checking) this.checking = this.checkNow().finally(() => { this.checking = null; });
    return this.checking;
  }
  async checkNow() {
    this.data.attemptedAt = new Date(this.now()).toISOString();
    try {
      const entries = await Promise.all(Object.entries(SDK_PACKAGES).map(async ([key, name]) => [key, await this.metadata(name)]));
      const packages = Object.fromEntries(entries), current = this.get();
      // A dist-tag can move backwards. Keep the installed component in that case.
      for (const [key, name] of Object.entries(SDK_PACKAGES)) if (semver.lt(packages[key].version, current.versions[key])) packages[key] = await this.metadata(name, current.versions[key]);
      this.data.candidate = { id: sha(JSON.stringify(packages)), packages, discoveredAt: new Date(this.now()).toISOString() };
      this.data.checkedAt = new Date(this.now()).toISOString(); this.data.error = null;
      this.data.nextCheckAt = new Date(this.now() + this.data.intervalHours * HOUR).toISOString();
    } catch (error) {
      this.data.error = '暂时无法检查 SDK 更新：' + redact(error.message);
      this.data.nextCheckAt = new Date(this.now() + HOUR).toISOString();
    }
    await this.save(); return this.status();
  }
  async exclusive(name, work) {
    if (this.operation) throw new Error('已有 SDK 操作正在进行，请等待完成');
    this.operation = name;
    try { return await work(); } finally { this.operation = null; }
  }
  prepare({ releaseId: installedId } = {}, context = {}) {
    return this.exclusive('preparing', async () => {
      const release = installedId ? this.get(installedId) : await this.install(context);
      return this.compatibility(release, context);
    });
  }
  async install({ signal, progress = () => {} } = {}) {
    const candidate = this.status().candidate;
    if (!candidate) throw new Error('尚无可下载的新版，请先检查更新');
    const cached = [...this.releases.values()].find(r => r.candidateId === candidate.id);
    if (cached) return cached;
    for (const pkg of Object.values(candidate.packages)) if (!semver.satisfies(process.versions.node, pkg.node)) throw new Error(`${pkg.name} 要求 Node ${pkg.node}，请先更新工坊客户端`);
    const versionId = id(), stage = path.join(this.dir, 'staging', versionId), target = this.directory(versionId);
    await fs.mkdir(stage, { recursive: true });
    try {
      await atomicJson(path.join(stage, 'package.json'), { name: 'aiui-workbench-sdk', version: '1.0.0', private: true, dependencies: Object.fromEntries(Object.values(candidate.packages).map(pkg => [pkg.name, pkg.version])) });
      const userconfig = path.join(stage, 'user.npmrc'), globalconfig = path.join(stage, 'global.npmrc');
      await fs.writeFile(userconfig, ''); await fs.writeFile(globalconfig, '');
      progress('下载官方 SDK 与构建工具，校验安装包完整性…');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_|^node_options$|^node_path$/i.test(key)));
      env.ELECTRON_RUN_AS_NODE = '1';
      const result = await this.execute(process.execPath, [path.join(bundledPackage('npm'), 'bin/npm-cli.js'), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=' + REGISTRY, '--userconfig=' + userconfig, '--globalconfig=' + globalconfig, '--cache=' + path.join(this.dir, 'npm-cache')], { cwd: stage, env, signal, timeout: 300000, onOutput: progress });
      if (result.code !== 0) throw new Error('SDK 下载失败：' + result.output);
      const lock = await readJson(path.join(stage, 'package-lock.json'));
      for (const pkg of Object.values(candidate.packages)) {
        const entry = lock.packages?.['node_modules/' + pkg.name];
        if (entry?.version !== pkg.version || entry?.integrity !== pkg.integrity || entry?.resolved !== pkg.tarball) throw new Error('安装包与已检查的官方版本或完整性信息不一致');
        const actual = await readJson(path.join(stage, 'node_modules', pkg.name, 'package.json'));
        if (actual.name !== pkg.name || actual.version !== pkg.version) throw new Error('下载的 SDK 版本不匹配');
      }
      signal?.throwIfAborted();
      progress('检查实际 WASM 引擎、工坊接口与构建工具…');
      const actual = await this.probe(path.join(stage, 'node_modules', SDK_PACKAGES.ink), [], { signal });
      const cli = await this.execute(process.execPath, [path.join(stage, 'node_modules', SDK_PACKAGES.cli, 'dist/cli.js'), '--help'], { signal, timeout: 15000 });
      if (cli.code !== 0) throw new Error('新版构建工具无法运行：' + cli.output);
      const release = { id: versionId, versions: Object.fromEntries(Object.entries(candidate.packages).map(([key, pkg]) => [key, pkg.version])), runtime: actual.runtime, bundleVersion: actual.bundleVersion, candidateId: candidate.id, installedAt: new Date(this.now()).toISOString() };
      signal?.throwIfAborted();
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.rename(stage, target);
      this.releases.set(versionId, release); await this.save(); return release;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async compatibility(release, { signal, progress = () => {} } = {}) {
    const report = { id: id(), releaseId: release.id, versions: release.versions, runtime: release.runtime, checkedAt: new Date(this.now()).toISOString(), projects: [], scope: 'engine-and-static-check', deviceVerified: false };
    const scratch = path.join(this.dir, 'checks', report.id);
    try {
      const actual = await this.probe(this.packagePath(release.id, 'ink'), [], { signal });
      if (actual.runtime !== release.runtime) throw new Error('SDK 引擎版本发生变化，请重新下载');
      const cli = await this.execute(process.execPath, [this.cliPath(release.id), '--help'], { signal, timeout: 15000 });
      if (cli.code !== 0) throw new Error('构建工具不可用：' + cli.output);
      for (const p of this.projects.list()) {
        signal?.throwIfAborted(); progress('检查项目：' + p.name);
        const item = { projectId: p.id, name: p.name, previousReleaseId: p.toolchainId, revision: p.revision, sourceUnavailable: true, status: 'blocked' };
        try {
          const files = await collectFiles(p.agentPath);
          item.revision = sourceRevision(files); item.sourceUnavailable = false;
          const app = JSON.parse(files.find(f => f.path === 'app.json')?.data.toString() || '{}');
          item.engine = typeof app.engine === 'string' && app.engine.trim() ? app.engine : null;
          if (!item.engine) { item.status = 'needs-declaration'; item.message = '项目未声明 engine，请补齐要求后再迁移'; }
          else {
            const result = await this.probe(this.packagePath(release.id, 'ink'), [item.engine], { signal });
            item.engineCompatible = result.matches[0]?.compatible === true;
            if (!item.engineCompatible) item.message = `项目要求 ${item.engine}，目标实际引擎为 ${actual.runtime}`;
            else {
              const snapshot = path.join(scratch, p.id);
              for (const f of files) { const file = path.join(snapshot, f.path); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, f.data); }
              const checked = await this.execute(process.execPath, [this.cliPath(release.id), 'check', snapshot, '--format', 'json'], { signal, timeout: 120000 });
              item.staticPassed = checked.code === 0;
              item.diagnostics = checked.output.slice(0, 16000);
              item.status = item.staticPassed ? 'compatible' : 'blocked';
              item.message = item.staticPassed ? '引擎要求与静态检查通过；迁移后仍需预览和真机验证' : '目标版本的官方源码检查未通过，请查看诊断';
            }
          }
        } catch (error) { signal?.throwIfAborted(); item.message = redact(error.message); }
        report.projects.push(item);
      }
      signal?.throwIfAborted();
      this.data.report = report; await this.save(); return report;
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
  reportStale(report) {
    const current = this.projects.list();
    return current.length !== report.projects.length || current.some(p => !report.projects.some(r => r.projectId === p.id && (r.sourceUnavailable || p.error || r.revision === p.revision) && r.previousReleaseId === p.toolchainId));
  }
  async requireReport(reportId, versionId) {
    const report = this.data.report;
    if (!report || report.id !== reportId || report.releaseId !== versionId) throw new Error('请先检查此版本的项目兼容性');
    const current = this.projects.list(), stale = () => new Error('项目或版本设置已变化，请重新检查兼容性');
    if (current.length !== report.projects.length) throw stale();
    for (const p of current) {
      const row = report.projects.find(r => r.projectId === p.id);
      if (!row || row.previousReleaseId !== p.toolchainId) throw stale();
      let files;
      try { files = await collectFiles(p.agentPath); }
      catch { if (row.sourceUnavailable) continue; throw stale(); }
      if (row.sourceUnavailable || sourceRevision(files) !== row.revision) throw stale();
    }
    return report;
  }
  activate({ releaseId: versionId, reportId }) {
    return this.exclusive('activating', async () => {
      const release = this.get(versionId); await this.requireReport(reportId, versionId);
      if (this.data.activeId !== release.id) {
        const before = { activeId: this.data.activeId, history: this.data.history };
        this.data.history = [...(this.data.history || []), this.data.activeId].slice(-20);
        this.data.activeId = release.id;
        try { await this.save(); } catch (error) { Object.assign(this.data, before); throw error; }
      }
      return this.status();
    });
  }
  useForProject({ projectId, releaseId: versionId, reportId }) {
    return this.exclusive('migrating', async () => {
      this.get(versionId); const report = await this.requireReport(reportId, versionId);
      const row = report.projects.find(p => p.projectId === projectId);
      if (row?.status !== 'compatible') throw new Error('此项目尚未通过目标版本的兼容性检查');
      const p = this.projects.get(projectId);
      const before = { toolchainId: p.toolchainId, previousToolchainId: p.previousToolchainId, lastCheck: p.lastCheck && { ...p.lastCheck } };
      p.previousToolchainId = p.toolchainId; p.toolchainId = versionId;
      if (p.lastCheck) p.lastCheck.stale = true;
      try { await this.projects.save(); } catch (error) { Object.assign(p, before); throw error; }
      this.emit('project-sdk-changed', { projectId, releaseId: versionId });
      // Preserve other rows so a reviewed batch can be migrated one project at a time.
      row.previousReleaseId = versionId; await this.save(); return p;
    });
  }
  rollback() {
    return this.exclusive('rollback', async () => {
      const history = [...(this.data.history || [])]; let previous;
      while (history.length && !previous) { const candidate = history.pop(); if (candidate !== this.data.activeId && this.releases.has(candidate)) previous = candidate; }
      if (!previous) throw new Error('没有可回退的默认版本');
      await this.probe(this.packagePath(previous, 'ink'));
      const before = { activeId: this.data.activeId, history: this.data.history };
      this.data.activeId = previous; this.data.history = history;
      try { await this.save(); } catch (error) { Object.assign(this.data, before); throw error; }
      return this.status();
    });
  }
  async close() { clearInterval(this.timer); this.controller.abort(); await this.checking; await this.saving; }
}
