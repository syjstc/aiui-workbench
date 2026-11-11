import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { ROOT, readJson, atomicJson, run, sleep, sha } from '../core/util.mjs';

const bundle = path.join(ROOT, 'output/desktop/AIUI Workshop-darwin-arm64/AIUI Workshop.app');
const appRoot = path.join(bundle, 'Contents/Resources/app'), executablePath = path.join(bundle, 'Contents/MacOS/AIUI Workshop');
const output = path.join(ROOT, 'output/qa/sdk');
const previous = await readJson(path.join(output, 'verification.json'));
const home = previous.home; // Reopen the isolated fixture to verify persistent downloaded versions.
const report = { home, executablePath, checks: [], errors: [], deviceVerified: false };
for (const file of ['core/sdk.mjs', 'core/sdk-probe.mjs']) {
  assert.equal(sha(await fs.readFile(path.join(appRoot, file))), sha(await fs.readFile(path.join(ROOT, file))), 'Packaged SDK code must match the tested source: ' + file);
}
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
async function until(fn, ms = 30000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(150); } throw new Error('Packaged SDK verification timed out'); }
let app, page;
async function launch() {
  app = await electron.launch({ executablePath, args: [], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  page = await app.firstWindow(); page.on('pageerror', e => report.errors.push(e.message));
  await page.getByRole('button', { name: 'SDK 更新', exact: true }).click();
  await page.getByRole('heading', { name: '当前默认版本' }).waitFor();
}
const call = (tool, args = {}) => page.evaluate(({ tool, args }) => window.workbench.call(tool, args), { tool, args });
async function stop() {
  if (app) { await app.close(); app = null; }
  const connection = await readJson(path.join(home, 'connection.json'), null);
  if (connection) {
    const response = await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token } });
    assert.equal((await response.json()).pid, connection.pid);
    process.kill(connection.pid, 'SIGTERM');
    await until(async () => !(await readJson(path.join(home, 'connection.json'), null)));
  }
}
try {
  await check('standalone application includes a runnable npm without system npm', async () => {
    const result = await run(executablePath, [path.join(appRoot, 'node_modules/npm/bin/npm-cli.js'), '--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(result.code, 0, result.output); assert.match(result.output, /11\.19\.0/);
  });
  await launch();
  let selected;
  await check('packaged service restores installed versions and verifies projects using downloaded SDK and CLI', async () => {
    const sdk = await call('aiui_sdk_status'); selected = sdk.installed.find(r => !r.bundled); assert.ok(selected);
    const config = await call('aiui_mcp_config'); assert.equal(JSON.parse(await fs.readFile(path.join(config.mcpServers['aiui-workbench'].env.AIUI_WORKBENCH_HOME, 'mcp/installation.json'), 'utf8')).executable, executablePath);
    const started = await call('aiui_sdk_prepare', { releaseId: selected.id });
    const job = await until(async () => { const j = await call('aiui_job_get', { jobId: started.id }); return j.status !== 'running' && j; });
    assert.equal(job.status, 'succeeded', job.error);
    await call('aiui_sdk_activate', { releaseId: selected.id, reportId: job.result.id });
  });
  await check('standalone service restart preserves the activated default', async () => {
    await stop(); await launch();
    const sdk = await call('aiui_sdk_status'); assert.equal(sdk.active.id, selected.id); assert.equal(sdk.active.runtime, selected.runtime);
    await page.screenshot({ path: path.join(output, 'packaged-sdk-updates.png') });
    await call('aiui_sdk_rollback');
  });
  assert.deepEqual(report.errors, []);
} finally {
  await stop(); await atomicJson(path.join(output, 'packaged-verification.json'), report);
}
