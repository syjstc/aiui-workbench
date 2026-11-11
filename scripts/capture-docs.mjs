import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { ROOT, atomicJson, sleep } from '../core/util.mjs';

// Always use a new profile and copies of the public examples. No personal
// project list, platform session, device serial or camera fixture is loaded.
const home = await fs.mkdtemp('/tmp/aiui-workshop-docs-');
const out = path.join(ROOT, 'docs/screenshots'); await fs.mkdir(out, { recursive: true });
const report = { version: JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'))).version, source: 'public examples only', simulated: true, deviceVerified: false, screenshots: [], checks: [], errors: [] };
let daemon, app;
try {
  daemon = await startDaemon(home);
  await daemon.service.sdk.settings({ autoCheck: false });
  // Keep the bundled documentation/runtime stable throughout this capture.
  daemon.service.sdk.check = async () => daemon.service.sdk.status();
  daemon.service.knowledge.sync = async () => daemon.service.knowledge.status();
  const call = (tool, args = {}) => daemon.service.call(tool, args, 'MCP');
  const projects = [];
  for (const name of ['motion-lab', 'hello-aiui']) {
    const destination = path.join(home, 'examples', name);
    await fs.cp(path.join(ROOT, 'examples', name), destination, { recursive: true, filter: source => !source.split(path.sep).includes('.aix') });
    const project = await call('aiui_project_import', { directory: destination });
    const started = await call('aiui_project_build', { projectId: project.id });
    const job = started.status === 'running' ? await call('aiui_job_wait', { jobId: started.id, waitMs: 45000 }) : started;
    assert.equal(job.status, 'succeeded', JSON.stringify(job));
    report.checks.push({ example: name, officialCheckAndBuild: true }); projects.push(project);
  }
  app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.getByRole('heading', { name: 'Hello AIUI', exact: true }).waitFor({ timeout: 45000 });
  await capture('projects-zh.png');
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await capture('projects-en.png');
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.getByRole('heading', { name: 'Hello AIUI', exact: true }).click();
  await page.getByText('预览运行中', { exact: true }).waitFor({ timeout: 45000 });
  await page.frameLocator('iframe').locator('#status').waitFor({ state: 'hidden', timeout: 45000 });
  await capture('simulator-zh.png');
  const hello = projects.find(p => p.name === 'Hello AIUI');
  let result = await call('aiui_preview_test', { projectId: hello.id, steps: [
    { action: 'swipe', parameters: { direction: 'forward', repeats: 24, intervalMs: 65, keyupOnly: true, aliases: true }, expect: { logContains: '"choice":1', logCount: { contains: 'HELLO_NAV', count: 1 } } },
    { action: 'swipe', waitMs: 400, parameters: { direction: 'forward', repeats: 8, intervalMs: 60, aliases: true }, expect: { logContains: '"choice":2', logCount: { contains: 'HELLO_NAV', count: 1 } } },
    { action: 'swipe', parameters: { direction: 'backward', repeats: 8, intervalMs: 60, keyupOnly: true, aliases: true }, expect: { logContains: '"choice":1', logCount: { contains: 'HELLO_NAV', count: 1 } } },
    { action: 'tap', expect: { logContains: 'HELLO_OPEN' } },
    { action: 'swipe', parameters: { direction: 'forward', repeats: 12, keyupOnly: true, aliases: true }, expect: { logContains: '"page":1', logCount: { contains: 'HELLO_NAV', count: 1 } } },
    { action: 'back', expect: { logContains: 'HELLO_BACK' } },
  ] });
  if (result.status === 'running') result = await call('aiui_job_wait', { jobId: result.id, waitMs: 45000 });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  report.checks.push({ example: 'hello-aiui', longSwipeRepeatedAliasesSecondSwipeReversePagingBack: true, assertions: result.result.assertionsEvaluated });
  const motion = projects.find(p => p.name === 'Motion Lab');
  const preview = await call('aiui_preview_open', { projectId: motion.id });
  await page.getByText('预览运行中', { exact: true }).waitFor({ timeout: 45000 });
  await until(async () => (await call('aiui_preview_state', { sessionId: preview.id })).state?.sensorSessions > 0);
  await call('aiui_preview_action', { sessionId: preview.id, action: 'pose', parameters: { yaw: 18, pitch: -8, roll: 3 } });
  await capture('motion-zh.png');
  await page.getByRole('button', { name: '连接 AI 工具', exact: true }).click();
  await page.getByRole('heading', { name: '连接后，AI 可以做什么', exact: true }).waitFor();
  await capture('mcp-zh.png');
  await page.getByRole('button', { name: '官方资料', exact: true }).click();
  await page.locator('.doc-list button').first().waitFor({ timeout: 15000 });
  await capture('docs-zh.png');
  assert.deepEqual(report.errors, []); report.passed = true;

  async function capture(name) { await sleep(700); await page.screenshot({ path: path.join(out, name) }); report.screenshots.push(name); console.log('Captured', name); }
  async function until(work) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await work()) return; await sleep(100); } throw new Error('Screenshot workflow timed out'); }
} catch (error) { report.error = error.stack; if (daemon) { report.previews = daemon.service.previews.list(); for (const p of report.previews) { try { report.runtimeLogs = await daemon.service.call('aiui_preview_logs', { sessionId: p.id, limit: 40 }, 'MCP'); } catch {} } } throw error; }
finally { await app?.close(); await daemon?.close(); await atomicJson(path.join(ROOT, 'output/qa/documentation.json'), report); }
