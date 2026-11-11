import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../core/daemon.mjs';
import { ROOT, atomicJson, readJson, sleep } from '../core/util.mjs';

const home = path.join(ROOT, '.local/sdk-qa', String(Date.now()));
const output = path.join(ROOT, 'output/qa/sdk');
await fs.mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), home, checks: [], errors: [], deviceVerified: false, updateFixture: 'The isolated bundled version metadata is temporarily set to 0.19.0 to exercise a newer-version notification. Downloaded npm packages, SHA512, CLI and WASM are real and unmodified.' };
const daemon = await startDaemon(home), sdk = daemon.service.sdk;
await sdk.checking;
await sdk.settings({ autoCheck: false });
const call = (tool, args = {}) => daemon.service.call(tool, args, 'sdk-qa');
const app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
const mcp = new Client({ name: 'sdk-qa', version: '1.0.0' });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], env: { ...process.env, AIUI_WORKBENCH_HOME: home } }));
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
async function until(fn, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(150); } throw new Error('SDK 验证等待超时'); }
async function jobDone(id, timeout = 360000) { const job = await until(async () => { const value = await call('aiui_job_get', { jobId: id }); return value.status !== 'running' && value; }, timeout); assert.equal(job.status, 'succeeded', job.error); return job.result; }
let originalVersions;
try {
  const compatible = await call('aiui_project_create', { directory: path.join(home, 'projects/compatible'), name: '可迁移示例' });
  const incompatible = await call('aiui_project_create', { directory: path.join(home, 'projects/incompatible'), name: '需要旧环境的示例' });
  const manifest = await readJson(path.join(incompatible.agentPath, 'app.json'));
  await atomicJson(path.join(incompatible.agentPath, 'app.json'), { ...manifest, engine: '>=99.0.0' }); await call('aiui_project_refresh', { projectId: incompatible.id });
  const original = sdk.get().id;
  await check('MCP exposes update, schedule, preflight, activation, migration and rollback tools', async () => {
    const names = (await mcp.listTools()).tools.map(t => t.name);
    for (const name of ['aiui_sdk_status', 'aiui_sdk_check', 'aiui_sdk_settings', 'aiui_sdk_prepare', 'aiui_sdk_activate', 'aiui_sdk_project_use', 'aiui_sdk_rollback']) assert.ok(names.includes(name), name);
    const result = await mcp.callTool({ name: 'aiui_sdk_status', arguments: {} }); assert.ok(!result.isError);
  });
  await page.getByRole('button', { name: 'SDK 更新', exact: true }).click();
  await check('desktop schedule settings persist', async () => {
    await page.getByLabel('SDK 检查频率').selectOption('168'); await until(() => sdk.status().intervalHours === 168 && sdk.status().autoCheck);
    await until(async () => (await readJson(sdk.file)).intervalHours === 168);
    await page.getByLabel('SDK 检查频率').selectOption('24'); await until(() => sdk.status().intervalHours === 24);
  });
  await check('official update detection and real isolated download pass integrity and compatibility checks', async () => {
    originalVersions = { ...sdk.bundled.versions }; sdk.bundled.versions = { ...originalVersions, ink: '0.19.0' };
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('heading', { name: '发现官方新版本' }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: '下载并检查兼容性' }).click();
    const job = await until(() => daemon.service.jobs.list().find(j => j.type === 'sdk-prepare'));
    const result = await jobDone(job.id);
    sdk.bundled.versions = originalVersions; originalVersions = null;
    report.downloaded = sdk.get(result.releaseId); report.preflight = result;
    assert.equal(result.projects.find(p => p.projectId === compatible.id).status, 'compatible');
    assert.equal(result.projects.find(p => p.projectId === incompatible.id).status, 'blocked');
    assert.equal(sdk.get().id, original);
  });
  await check('activation preserves existing project versions and blocks incompatible migration', async () => {
    await page.getByRole('button', { name: '设为默认版本' }).click(); await until(() => sdk.get().id === report.downloaded.id);
    assert.equal(daemon.service.projects.get(compatible.id).toolchainId, original);
    const blocked = page.locator('.sdk-table tr').filter({ hasText: '需要旧环境的示例' });
    assert.equal(await blocked.getByRole('button', { name: '切换到此版本' }).isDisabled(), true);
    const row = page.locator('.sdk-table tr').filter({ hasText: '可迁移示例' });
    await row.getByRole('button', { name: '切换到此版本' }).click(); await until(() => daemon.service.projects.get(compatible.id).toolchainId === report.downloaded.id);
    await page.locator('.sdk-report').screenshot({ path: path.join(output, 'compatibility-report.png') });
  });
  await check('migrated preview loads downloaded SDK assets and project check/build use its CLI', async () => {
    const result = await mcp.callTool({ name: 'aiui_preview_open', arguments: { projectId: compatible.id } }); assert.ok(!result.isError);
    const preview = JSON.parse(result.content[0].text);
    await page.frameLocator('iframe').locator('#status').waitFor({ state: 'hidden', timeout: 60000 });
    const state = await until(async () => { const s = await call('aiui_preview_state', { sessionId: preview.id }); return s.status === 'ready' && s; });
    assert.equal(state.toolchainId, report.downloaded.id); assert.equal(state.state.sdkVersion, report.downloaded.versions.ink); assert.equal(state.state.runtime, report.downloaded.runtime);
    const asset = await fetch(daemon.connection.origin + state.sdkUrl); assert.equal(asset.status, 200);
    const checked = await jobDone((await call('aiui_project_check', { projectId: compatible.id })).id);
    assert.equal(checked.toolchainId, report.downloaded.id);
    const packed = await jobDone((await call('aiui_project_pack', { projectId: compatible.id })).id);
    assert.equal(packed.toolchainId, report.downloaded.id); assert.ok(packed.bytes > 0);
    report.preview = { runtime: state.state.runtime, sdkVersion: state.state.sdkVersion, toolchainId: state.toolchainId };
    await page.screenshot({ path: path.join(output, 'downloaded-sdk-preview.png') });
  });
  await page.getByRole('button', { name: 'SDK 更新', exact: true }).click();
  await check('default rollback leaves migrated projects intact; project rollback is separately checked', async () => {
    await page.getByRole('button', { name: '回退默认版本' }).click(); await until(() => sdk.get().id === original);
    assert.equal(daemon.service.projects.get(compatible.id).toolchainId, report.downloaded.id);
    await page.getByLabel('选择兼容性检查版本').selectOption(original);
    await page.getByRole('button', { name: '检查项目兼容性', exact: true }).click();
    await until(() => sdk.status().report.releaseId === original && !sdk.operation);
    const row = page.locator('.sdk-table tr').filter({ hasText: '可迁移示例' });
    await row.getByRole('button', { name: '切换到此版本' }).click(); await until(() => daemon.service.projects.get(compatible.id).toolchainId === original);
  });
  await check('offline check displays an error and retains installed runtime', async () => {
    const fetcher = sdk.fetcher; sdk.fetcher = async () => { throw new Error('QA offline fixture'); };
    try { await page.getByRole('button', { name: '检查更新', exact: true }).click(); await page.getByText(/暂时无法检查 SDK 更新/).waitFor(); assert.equal(sdk.get().id, original); }
    finally { sdk.fetcher = fetcher; await sdk.check(); }
  });
  await until(() => !sdk.checking); await page.getByText('当前默认版本已是官方最新稳定版。').waitFor();
  await page.locator('.content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'sdk-updates.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1080, height: 800 }));
  await check('SDK page remains usable at minimum window width without document overflow', async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'sdk-updates-1080.png') });
  });
  assert.deepEqual(report.errors, []);
} finally {
  if (originalVersions) sdk.bundled.versions = originalVersions;
  report.finishedAt = new Date().toISOString(); await atomicJson(path.join(output, 'verification.json'), report);
  await mcp.close(); await app.close(); await daemon.close();
}
