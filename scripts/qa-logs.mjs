import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomicJson } from '../core/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(process.env.AIUI_QA_APP_ROOT || root);
const { startDaemon } = await import(pathToFileURL(path.join(appRoot, 'core/daemon.mjs')));
const { Workbench } = await import(pathToFileURL(path.join(appRoot, 'core/service.mjs')));
const home = path.join(root, '.local/log-verification', Date.now().toString());
const output = path.resolve(root, process.env.AIUI_QA_LOGS_OUTPUT || 'output/qa/logs');
await fs.mkdir(output, { recursive: true });
const records = ['check', 'pack', 'deploy', 'launch', 'sdk-prepare', 'knowledge', 'platform-prepare', 'device-setup'].map((type, index) => ({
  id: 'qa-' + type, type, projectId: null, status: ['succeeded', 'failed', 'cancelled', 'interrupted'][index % 4],
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), message: '日志清理验证记录', logs: [{ at: new Date().toISOString(), message: 'QA fixture output: ' + type }],
}));
await atomicJson(path.join(home, 'jobs.json'), records);
const daemon = await startDaemon(home), service = daemon.service;
// This verification exercises log controls; startup sync uses an offline fixture.
service.knowledge.sync = async ({ progress }) => { progress('离线资料已就绪'); return service.knowledge.status(); };
await service.sdk.settings({ autoCheck: false });
const project = await service.projects.create({ directory: path.join(home, 'fixture-project'), name: '日志验证应用' }, service.knowledge);
let finishActive;
const active = service.jobs.start('pack', project.id, ({ progress }) => new Promise(resolve => { finishActive = resolve; progress('等待验证完成'); }));
const activePromise = service.jobs.items.find(job => job.id === active.id).promise;
const mcp = new Client({ name: 'log-cleanup-qa', version: '1.0.0' });
const report = { home, appRoot, checks: [], errors: [] };
let app, writer, closed = false;
async function tool(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.map(item => item.text || '').join('\n'));
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
async function waitFor(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('等待验证状态超时');
}
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(appRoot, 'mcp/server.mjs')], env: { ...process.env, AIUI_WORKBENCH_HOME: home } }));
  app = await electron.launch({ executablePath: process.env.AIUI_QA_APP_EXECUTABLE || undefined, args: [appRoot], cwd: appRoot, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  const gotoLogs = () => page.getByRole('button', { name: '日志与记录', exact: true }).click();
  const history = page.getByRole('region', { name: '全部任务记录', exact: true });
  const row = id => page.locator(`[data-job-id="${id}"]`);
  await check('桌面与 MCP 都提供日志管理入口', async () => {
    const names = (await mcp.listTools()).tools.map(tool => tool.name);
    for (const name of ['aiui_jobs_delete', 'aiui_preview_logs_clear', 'aiui_service_log_status', 'aiui_service_log_clear']) assert.ok(names.includes(name));
    await gotoLogs(); await page.getByRole('heading', { name: '日志与记录', exact: true }).waitFor();
    await row('qa-check').waitFor();
    await page.screenshot({ path: path.join(output, '01-log-manager.png') });
  });
  await check('运行中的任务提供取消，删除操作会保留任务', async () => {
    assert.equal(await row(active.id).getByRole('button', { name: /删除/ }).count(), 0);
    await row(active.id).getByRole('button', { name: '取消', exact: true }).waitFor();
    const result = await tool('aiui_jobs_delete', { jobIds: [active.id] });
    assert.deepEqual(result.skippedRunningIds, [active.id]);
    assert.equal(service.jobs.get(active.id).status, 'running');
  });
  await check('按类型批量删除只清理该类型已结束的任务', async () => {
    await page.getByRole('combobox', { name: '筛选任务类型' }).selectOption('check');
    await page.getByRole('region', { name: '官方源码检查记录', exact: true }).getByRole('button', { name: '清空已结束记录', exact: true }).click();
    await row('qa-check').waitFor({ state: 'detached' });
    assert.throws(() => service.jobs.get('qa-check'), /不存在/);
    assert.equal(service.jobs.get('qa-deploy').status, 'cancelled');
    await page.getByRole('combobox', { name: '筛选任务类型' }).selectOption('all');
  });
  await check('单条删除同步更新桌面、MCP 和磁盘', async () => {
    await row('qa-deploy').getByRole('button', { name: '删除安装到眼镜记录', exact: true }).click();
    await row('qa-deploy').waitFor({ state: 'detached' });
    assert.ok(!(await tool('aiui_status')).jobs.some(job => job.id === 'qa-deploy'));
    assert.ok(!JSON.parse(await fs.readFile(path.join(home, 'jobs.json'), 'utf8')).some(job => job.id === 'qa-deploy'));
  });
  await check('SDK 和安装页可以直接删除各自的记录', async () => {
    await page.getByRole('button', { name: 'SDK 更新', exact: true }).click();
    await row('qa-sdk-prepare').getByRole('button', { name: '删除SDK 兼容性检查记录', exact: true }).click();
    await row('qa-sdk-prepare').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '连接眼镜', exact: true }).click();
    await row('qa-launch').getByRole('button', { name: '删除启动眼镜页面记录', exact: true }).click();
    await row('qa-launch').waitFor({ state: 'detached' });
  });
  await check('构建页清空已结束记录，保留正在构建的任务', async () => {
    await page.getByRole('button', { name: '构建与上传', exact: true }).click();
    await page.getByRole('region', { name: '构建与检查记录', exact: true }).getByRole('button', { name: '清空已结束记录', exact: true }).click();
    await row('qa-pack').waitFor({ state: 'detached' });
    await row(active.id).waitFor();
    assert.throws(() => service.jobs.get('qa-platform-prepare'), /不存在/);
    assert.ok(service.jobs.get('qa-knowledge'));
  });
  await check('全部清理涵盖资料同步和眼镜环境记录', async () => {
    await gotoLogs();
    await history.getByRole('button', { name: '清空已结束记录', exact: true }).click();
    await row('qa-knowledge').waitFor({ state: 'detached' });
    await row('qa-device-setup').waitFor({ state: 'detached' });
    assert.deepEqual(service.jobs.list().map(job => job.id), [active.id]);
    assert.equal(await history.getByRole('button', { name: '清空已结束记录', exact: true }).isDisabled(), true);
  });
  await check('服务日志清空后原有写入句柄仍可继续写入', async () => {
    writer = await fs.open(path.join(home, 'service.log'), 'a');
    await writer.writeFile('QA old diagnostic\n');
    await page.getByRole('button', { name: '刷新服务日志大小', exact: true }).click();
    await page.getByRole('button', { name: '清空服务日志', exact: true }).click();
    await waitFor(async () => (await fs.stat(path.join(home, 'service.log'))).size === 0);
    await writer.writeFile('QA new diagnostic\n');
    assert.equal(await fs.readFile(path.join(home, 'service.log'), 'utf8'), 'QA new diagnostic\n');
    const result = await tool('aiui_service_log_clear'); assert.ok(result.clearedBytes > 0);
    await writer.close(); writer = null;
  });
  let preview;
  await check('实际模拟器运行日志可清空并继续记录新日志', async () => {
    preview = await tool('aiui_preview_open', { projectId: project.id });
    await waitFor(async () => (await tool('aiui_preview_state', { sessionId: preview.id })).status === 'ready', 45000);
    const frame = page.frames().find(frame => frame.url().includes('/runtime/preview/'));
    assert.ok(frame);
    await frame.evaluate(() => console.info('QA_BEFORE_CLEAR'));
    await waitFor(async () => (await tool('aiui_preview_logs', { sessionId: preview.id })).logs.some(log => log.message.includes('QA_BEFORE_CLEAR')));
    await page.getByRole('button', { name: '清空运行日志', exact: true }).click();
    await waitFor(async () => !(await tool('aiui_preview_logs', { sessionId: preview.id })).logs.length);
    await frame.evaluate(() => console.info('QA_AFTER_CLEAR'));
    await waitFor(async () => (await tool('aiui_preview_logs', { sessionId: preview.id })).logs.some(log => log.message.includes('QA_AFTER_CLEAR')));
    await page.locator('.console-entries').getByText('QA_AFTER_CLEAR', { exact: true }).waitFor();
    assert.ok(!(await tool('aiui_preview_logs', { sessionId: preview.id })).logs.some(log => log.message.includes('QA_BEFORE_CLEAR')));
    await page.screenshot({ path: path.join(output, '02-cleared-runtime-logs.png') });
  });
  await check('统一日志页也可以清空当前运行会话', async () => {
    await gotoLogs();
    await page.getByRole('button', { name: '清空日志验证应用运行日志', exact: true }).click();
    await waitFor(async () => !(await tool('aiui_preview_logs', { sessionId: preview.id })).logs.length);
    await waitFor(async () => page.getByRole('button', { name: '清空日志验证应用运行日志', exact: true }).isEnabled());
    assert.equal((await tool('aiui_preview_state', { sessionId: preview.id })).status, 'ready');
    await page.screenshot({ path: path.join(output, '03-clean-log-manager.png') });
    const window = await app.browserWindow(page);
    await window.evaluate(window => window.setSize(1080, 740));
    await page.screenshot({ path: path.join(output, '04-minimum-window.png') });
  });
  finishActive('verification complete'); await activePromise;
  await app.close(); app = null; await mcp.close(); await daemon.close(); closed = true;
  await check('重启后删除的记录不会恢复，项目和保留任务仍在', async () => {
    const restored = await new Workbench(home).init();
    try {
      for (const record of records) assert.throws(() => restored.jobs.get(record.id), /不存在/);
      assert.equal(restored.jobs.get(active.id).status, 'succeeded');
      assert.equal(restored.projects.get(project.id).name, '日志验证应用');
    } finally { await restored.close(); }
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  finishActive?.();
  await writer?.close(); await app?.close(); await mcp.close().catch(() => {});
  if (!closed) await daemon.close();
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
}
