import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SdkManager, SDK_PACKAGES, registryMetadata, probeSdk } from '../core/sdk.mjs';
import { Projects, collectFiles, sourceRevision } from '../core/projects.mjs';
import { ROOT, atomicJson, readJson } from '../core/util.mjs';

const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
function metadata(name, version) { return { name, version, engines: { node: '>=22' }, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`, integrity } }; }
const probe = async (_dir, ranges = []) => ({ runtime: '0.19.0', bundleVersion: '0.19.1', matches: ranges.map(range => ({ range, compatible: range === '>=0.18.0' })) });
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-sdk-test-'));
  const projects = await new Projects(home, () => {}).init();
  const manager = await new SdkManager(home, projects, () => {}, { probe, ...options }).init();
  projects.getToolchain = () => manager.get();
  t.after(async () => { await manager.close(); await projects.close(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, projects, manager };
}
async function project(f, name = '兼容项目', engine = '>=0.18.0') {
  const dir = path.join(f.home, name);
  await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
  await atomicJson(path.join(dir, 'app.json'), { name, version: '1.0.0', ...(engine === null ? {} : { engine }), pages: ['pages/index'] });
  await fs.writeFile(path.join(dir, 'pages/index.ink'), '<script def>{}</script><script setup>export default {}</script><page><text>test</text></page>');
  return f.projects.import(dir);
}
function registry(versions = { ink: '0.19.2', cli: '0.12.1' }) {
  return async url => { const [name, requested] = url.slice('https://registry.npmjs.org/'.length).split('/'); const decoded = decodeURIComponent(name), key = Object.keys(SDK_PACKAGES).find(k => SDK_PACKAGES[k] === decoded); return { ok: true, json: async () => metadata(decoded, requested === 'latest' ? versions[key] : requested) }; };
}
function installer({ corrupt = false, fail = false } = {}) {
  return async (_command, args, options = {}) => {
    if (args[0].endsWith('npm-cli.js')) {
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(args.includes('--registry=https://registry.npmjs.org'));
      if (fail) throw new Error('模拟下载中断');
      const pkg = await readJson(path.join(options.cwd, 'package.json')), packages = {};
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        await atomicJson(path.join(options.cwd, 'node_modules', name, 'package.json'), { name, version });
        const m = metadata(name, version);
        packages['node_modules/' + name] = { version, integrity: corrupt ? 'bad-integrity' : m.dist.integrity, resolved: m.dist.tarball };
      }
      await atomicJson(path.join(options.cwd, 'package-lock.json'), { packages });
    }
    return { code: 0, output: '{"diagnostics":[]}' };
  };
}

test('official WASM determines compatibility independently of the npm version', async () => {
  const result = await probeSdk(path.join(ROOT, 'node_modules', SDK_PACKAGES.ink), ['>=0.18.0', '^0.19.1']);
  assert.equal(result.runtime, '0.19.0'); assert.equal(result.bundleVersion, '0.19.1');
  assert.deepEqual(result.matches.map(m => m.compatible), [true, false]);
});
test('registry rejects prereleases, deprecated packages, foreign sources and missing integrity', () => {
  const name = SDK_PACKAGES.ink, good = metadata(name, '0.20.0');
  assert.equal(registryMetadata(good, name).version, '0.20.0');
  for (const invalid of [{ ...good, version: '0.20.0-beta.1' }, { ...good, deprecated: 'withdrawn' }, { ...good, name: 'other' }, { ...good, dist: { ...good.dist, tarball: 'https://example.com/package.tgz' } }, { ...good, dist: { ...good.dist, integrity: undefined } }]) assert.throws(() => registryMetadata(invalid, name));
});
test('daily schedule persists, deduplicates checks, respects disable and retries offline in one hour', async t => {
  let now = Date.parse('2026-11-11T00:00:00Z'), calls = 0, offline = false;
  const f = await fixture(t, { now: () => now, fetcher: async (...args) => { calls++; if (offline) throw new Error('offline'); return registry()(...args); } });
  await Promise.all([f.manager.check(), f.manager.check()]); assert.equal(calls, 2);
  const checkedAt = f.manager.status().checkedAt;
  assert.equal(f.manager.status().candidate.packages.ink.version, '0.19.2');
  await f.manager.checkIfDue(); assert.equal(calls, 2);
  now += 24 * 3600000; offline = true; await f.manager.checkIfDue();
  assert.equal(calls, 4); assert.equal(f.manager.status().checkedAt, checkedAt);
  assert.equal(f.manager.status().updateAvailable, true); assert.match(f.manager.status().error, /offline/);
  assert.equal(Date.parse(f.manager.status().nextCheckAt), now + 3600000);
  await f.manager.checkIfDue(); assert.equal(calls, 4);
  await f.manager.settings({ autoCheck: false }); now += 8 * 24 * 3600000;
  await f.manager.checkIfDue(); assert.equal(calls, 4);
  await f.manager.check(); assert.equal(calls, 6, 'manual check works with schedule disabled');
  const stored = await readJson(f.manager.file); assert.equal(stored.autoCheck, false);
  await assert.rejects(f.manager.settings({ intervalHours: 1 }));
});
test('older latest tags never propose downgrades and multi-digit versions compare correctly', async t => {
  const f = await fixture(t, { fetcher: registry({ ink: '0.18.9', cli: '0.11.9' }) });
  await f.manager.check(); assert.equal(f.manager.status().updateAvailable, false);
  f.manager.fetcher = registry({ ink: '0.19.10', cli: '0.12.0' });
  await f.manager.check(); assert.equal(f.manager.status().candidate.packages.ink.version, '0.19.10');
});
test('download integrity failure or interruption leaves current runtime and projects unchanged', async t => {
  const f = await fixture(t, { fetcher: registry(), execute: installer({ corrupt: true }) }), p = await project(f);
  const original = f.manager.get().id;
  await f.manager.check(); await assert.rejects(f.manager.prepare(), /完整性/);
  assert.equal(f.manager.get().id, original); assert.equal(p.toolchainId, original);
  assert.equal(f.manager.status().installed.length, 1); assert.deepEqual(await fs.readdir(path.join(f.manager.dir, 'staging')), []);
  f.manager.execute = installer({ fail: true }); await assert.rejects(f.manager.prepare(), /下载中断/);
  assert.equal(f.manager.get().id, original); assert.equal(f.manager.operation, null);
});
test('compatibility checks snapshots, keeps incompatible projects pinned, and allows independent migration and rollback', async t => {
  const f = await fixture(t, { fetcher: registry(), execute: installer() });
  const compatible = await project(f), incompatible = await project(f, '未来引擎项目', '>=9.0.0'), undeclared = await project(f, '未声明项目', null);
  const original = f.manager.get().id, before = sourceRevision(await collectFiles(compatible.agentPath));
  await f.manager.check(); const report = await f.manager.prepare();
  assert.deepEqual(report.projects.map(p => p.status).sort(), ['blocked', 'compatible', 'needs-declaration']);
  assert.equal(sourceRevision(await collectFiles(compatible.agentPath)), before);
  assert.equal(report.deviceVerified, false);
  assert.equal(f.manager.get().id, original, 'preparing never activates a runtime');
  await f.manager.activate({ releaseId: report.releaseId, reportId: report.id });
  assert.equal(f.manager.get().id, report.releaseId); assert.equal(compatible.toolchainId, original); assert.equal(incompatible.toolchainId, original);
  await assert.rejects(f.manager.useForProject({ projectId: incompatible.id, releaseId: report.releaseId, reportId: report.id }), /尚未通过/);
  await assert.rejects(f.manager.useForProject({ projectId: undeclared.id, releaseId: report.releaseId, reportId: report.id }), /尚未通过/);
  await f.manager.useForProject({ projectId: compatible.id, releaseId: report.releaseId, reportId: report.id });
  assert.equal(compatible.toolchainId, report.releaseId);
  const next = await project(f, '新项目'); assert.equal(next.toolchainId, report.releaseId);
  await f.manager.rollback(); assert.equal(f.manager.get().id, original);
  assert.equal(compatible.toolchainId, report.releaseId, 'default rollback does not silently move projects');
  assert.equal(f.manager.status().updateAvailable, true);
  const old = await f.manager.prepare({ releaseId: original });
  await f.manager.useForProject({ projectId: compatible.id, releaseId: original, reportId: old.id });
  assert.equal(compatible.toolchainId, original);
});
test('changing a project or adding one invalidates the exact reviewed report', async t => {
  const f = await fixture(t, { fetcher: registry(), execute: installer() }), p = await project(f);
  await f.manager.check(); const report = await f.manager.prepare();
  await fs.appendFile(path.join(p.agentPath, 'pages/index.ink'), '\n<!-- modified -->');
  await assert.rejects(f.manager.activate({ releaseId: report.releaseId, reportId: report.id }), /已变化/);
  const refreshed = await f.manager.prepare({ releaseId: report.releaseId });
  await project(f, '新增项目');
  await assert.rejects(f.manager.useForProject({ projectId: p.id, releaseId: refreshed.releaseId, reportId: refreshed.id }), /已变化/);
});
test('cancelled and overlapping preparations cannot enable a new default', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fetcher: registry(), execute: async (...args) => { await gate; return installer()(...args); } });
  await f.manager.check(); const controller = new AbortController(), first = f.manager.prepare({}, { signal: controller.signal });
  await assert.rejects(f.manager.prepare(), /正在进行/); controller.abort(); release();
  await assert.rejects(first); assert.equal(f.manager.get().id, f.manager.bundled.id); assert.equal(f.manager.operation, null);
});
test('saved default, project pins and schedule survive a service restart', async t => {
  const f = await fixture(t, { fetcher: registry(), execute: installer() }), p = await project(f);
  await f.manager.check(); const report = await f.manager.prepare();
  await f.manager.activate({ releaseId: report.releaseId, reportId: report.id });
  await f.manager.settings({ intervalHours: 168 }); await f.manager.close();
  const next = await new SdkManager(f.home, f.projects, () => {}, { probe }).init(); t.after(() => next.close());
  assert.equal(next.get().id, report.releaseId); assert.equal(p.toolchainId, f.manager.bundled.id); assert.equal(next.status().intervalHours, 168);
});
test('unavailable projects stay pinned without blocking the default; restored source invalidates the report', async t => {
  const f = await fixture(t, { fetcher: registry(), execute: installer() }), p = await project(f);
  const original = p.toolchainId, backup = p.agentPath + '-away';
  await fs.rename(p.agentPath, backup);
  await f.manager.check(); const report = await f.manager.prepare();
  assert.equal(report.projects[0].sourceUnavailable, true);
  await f.manager.activate({ releaseId: report.releaseId, reportId: report.id });
  assert.equal(p.toolchainId, original);
  await assert.rejects(f.manager.useForProject({ projectId: p.id, releaseId: report.releaseId, reportId: report.id }), /尚未通过/);
  await fs.rename(backup, p.agentPath);
  await assert.rejects(f.manager.activate({ releaseId: report.releaseId, reportId: report.id }), /已变化/);
});
test('real bundled CLI and WASM preflight report compatible and invalid engine projects', async t => {
  const f = await fixture(t, { probe: probeSdk }), p = await project(f), original = sourceRevision(await collectFiles(p.agentPath));
  await project(f, '不兼容', '^0.19.1');
  const broken = await project(f, '错误源码');
  await fs.writeFile(path.join(broken.agentPath, 'pages/index.ink'), '<script def>{}</script><script setup>export default {data:{value:}};</script><page><text>broken</text></page>');
  const report = await f.manager.prepare({ releaseId: f.manager.bundled.id });
  assert.equal(report.projects.find(row => row.projectId === p.id).status, 'compatible');
  assert.equal(report.projects.find(row => row.engine === '^0.19.1').status, 'blocked');
  assert.equal(report.projects.find(row => row.projectId === broken.id).staticPassed, false);
  assert.equal(sourceRevision(await collectFiles(p.agentPath)), original);
});
