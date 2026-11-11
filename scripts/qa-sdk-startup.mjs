import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { SDK_PACKAGES } from '../core/sdk.mjs';
import { ROOT, atomicJson, readJson, sleep } from '../core/util.mjs';

const home = path.join(ROOT, '.local/sdk-startup-qa', String(Date.now()));
const packaged = process.argv.includes('--packaged');
const output = path.join(ROOT, 'output/qa/sdk', packaged ? 'startup-packaged-verification.json' : 'startup-verification.json');
const versions = {};
for (const [key, name] of Object.entries(SDK_PACKAGES)) versions[key] = (await readJson(path.join(ROOT, 'node_modules', name, 'package.json'))).version;
const activeId = `bundled-${versions.ink}-${versions.cli}`;
await atomicJson(path.join(home, 'sdk/state.json'), { activeId, autoCheck: true, intervalHours: 24, history: [], installed: [], checkedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 86400000).toISOString() });
const daemon = await startDaemon(home), sdk = daemon.service.sdk;
const report = { home, packaged, checks: [], errors: [], registry: 'controlled metadata fixtures; no installation' };
let app, page, requests = 0, offline = false, release;
let gate = new Promise(resolve => { release = resolve; });
// Hold registry replies to prove that opening the UI does not wait for the network.
sdk.fetcher = async url => {
  requests++;
  if (gate) await gate;
  if (offline) throw new Error('SDK startup offline fixture');
  const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
  const key = Object.keys(SDK_PACKAGES).find(key => SDK_PACKAGES[key] === name);
  return { ok: true, json: async () => ({ name, version: versions[key], dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${versions[key]}.tgz`, integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') } }) };
};
// Documentation sync is outside this test's scope.
daemon.service.knowledge.sync = async () => daemon.service.knowledge.status();
async function until(fn, timeout = 20000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await fn()) return; await sleep(100); } throw new Error('SDK startup verification timed out'); }
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: process.env.AIUI_SDK_QA_APP || path.join(ROOT, 'output/desktop/AIUI Workshop-darwin-arm64/AIUI Workshop.app/Contents/MacOS/AIUI Workshop') } : {}), args: packaged ? [] : [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('heading', { name: '项目库', exact: true }).waitFor();
}
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
try {
  await check('opening checks immediately despite a future schedule, without blocking the UI', async () => {
    await launch(); await until(() => requests === 2);
    assert.equal(sdk.status().checking, true);
    await page.getByRole('button', { name: 'SDK 更新', exact: true }).click();
    await page.getByRole('heading', { name: '当前默认版本' }).waitFor();
    await page.getByRole('button', { name: '正在检查…', exact: true }).waitFor();
    const simultaneous = sdk.check(); assert.equal(requests, 2, 'overlapping checks must share the pending request');
    release(); gate = null; await simultaneous; await until(() => !sdk.checking);
    assert.ok(Date.parse(sdk.status().nextCheckAt) > Date.now());
    await app.close(); app = null;
  });
  await check('reopening checks again while reusing the same running service', async () => {
    const pid = (await readJson(path.join(home, 'connection.json'))).pid;
    await launch(); await until(() => requests === 4 && !sdk.checking);
    assert.equal((await readJson(path.join(home, 'connection.json'))).pid, pid);
    assert.equal(sdk.status().error, null);
    await app.close(); app = null;
  });
  await check('opening still checks with periodic checks disabled, and offline failure keeps the UI usable', async () => {
    await sdk.settings({ autoCheck: false }); offline = true;
    await launch(); await until(() => requests === 6 && !sdk.checking);
    await page.getByRole('button', { name: 'SDK 更新', exact: true }).click();
    await page.getByText(/SDK startup offline fixture/).waitFor();
    assert.equal(await page.getByLabel('SDK 检查频率').inputValue(), 'off');
    assert.equal(sdk.get().id, activeId);
    await page.locator('nav').getByRole('button', { name: /项目库/ }).click();
    await page.getByRole('heading', { name: '项目库', exact: true }).waitFor();
  });
  assert.deepEqual(report.errors, []);
} finally {
  release();
  if (app) await app.close();
  await daemon.close();
  report.requests = requests; await atomicJson(output, report);
}
