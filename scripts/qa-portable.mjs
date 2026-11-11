import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, portableEnvironment, bounded, closeDesktop } from './desktop-test.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, atomicJson, readJson, run, sha, sleep, redact } from '../core/util.mjs';
import { packagedPaths } from './packaged-paths.mjs';

const { executablePath } = packagedPaths();
const output = path.join(ROOT, 'output/qa/portable', process.platform + '-' + process.arch);
const home = path.join(ROOT, '.local', 'portable qa 中文 & spaces', String(Date.now()));
await fs.mkdir(output, { recursive: true });
const env = portableEnvironment(home);
const report = { home, executablePath, platform: process.platform, arch: process.arch, checks: [], errors: [], systemPathEmpty: env.PATH === '', onlySystemUtilitiesOnPath: process.platform === 'win32', deviceInstallPerformed: false };
let app, page, mcp;
async function check(name, work) { report.stage = name; await atomicJson(path.join(output, 'verification.json'), report); await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); await atomicJson(path.join(output, 'verification.json'), report); }
async function until(work, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await work(); if (value) return value; await sleep(150); } throw new Error('Portable check timed out'); }
async function tool(name, args = {}) {
  const value = await mcp.callTool({ name, arguments: args });
  if (value.isError) throw new Error(value.content.map(c => c.text || '').join('\n'));
  return JSON.parse(value.content.find(c => c.type === 'text').text);
}
async function job(name, args) {
  const started = await tool(name, args);
  const result = await until(async () => { const value = await tool('aiui_job_get', { jobId: started.id }); return value.status !== 'running' && value; }, 120000);
  assert.equal(result.status, 'succeeded', result.error); return result.result;
}
async function stop() {
  await mcp?.close(); mcp = null;
  await closeDesktop(app); app = null;
  const connection = await readJson(path.join(home, 'connection.json'), null);
  if (connection) {
    const response = await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok && (await response.json()).pid === connection.pid) {
      process.kill(connection.pid, 'SIGTERM');
      await until(async () => !(await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(500) }).catch(() => null)));
    }
  }
}
async function launch() {
  report.stage = 'launching desktop'; await atomicJson(path.join(output, 'verification.json'), report);
  app = await launchDesktop({ executablePath, args: [], cwd: ROOT, env });
  page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { (report.rendererErrors ||= []).push(message.text()); console.log('RENDERER', message.text()); } });
  console.log('STAGE desktop window opened', page.url());
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor({ timeout: 45000 });
  report.stage = 'desktop UI ready'; console.log('STAGE', report.stage); await atomicJson(path.join(output, 'verification.json'), report);
  const config = (await page.evaluate(() => window.workbench.call('aiui_mcp_config'))).mcpServers['aiui-workbench'];
  const installation = await readJson(path.join(home, 'mcp/installation.json'));
  assert.equal(path.resolve(installation.executable), path.resolve(executablePath));
  assert.notEqual(config.command, executablePath);
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
  mcp = new Client({ name: 'portable-qa', version: '1.0.0' });
  report.stage = 'connecting generated MCP launcher'; console.log('STAGE', report.stage); await atomicJson(path.join(output, 'verification.json'), report);
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...env, ...config.env }, stderr: 'pipe' });
  transport.stderr.on('data', chunk => { const message = redact(chunk.toString()); report.mcpStderr = ((report.mcpStderr || '') + message).slice(-8000); console.error('MCP STDERR', message); });
  await mcp.connect(transport, { timeout: 15000 });
  return config;
}
try {
  await fs.access(executablePath);
  const probe = await run(executablePath, ['-e', 'console.log(JSON.stringify(process.versions))'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 });
  report.runtimeProbe = probe;
  await atomicJson(path.join(output, 'verification.json'), report);
  assert.equal(probe.code, 0, probe.output);
  let config, project;
  await check('packaged app and bundled MCP start with no system Node, npm or ADB on PATH', async () => { config = await launch(); assert.ok((await mcp.listTools()).tools.length >= 30); });
  await check('bundled npm and ADB run without external tools', async () => {
    const appRoot = (await readJson(path.join(home, 'mcp/installation.json'))).root;
    const npm = await run(executablePath, [path.join(appRoot, 'node_modules/npm/bin/npm-cli.js'), '--version'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(npm.code, 0, npm.output); assert.match(npm.output, /\d+\.\d+\.\d+/);
    const environment = await tool('aiui_environment_check');
    assert.equal(environment.adbTool.source, 'bundled'); assert.equal(environment.adb, true, JSON.stringify(environment.diagnostics)); assert.equal(environment.aix, true);
    report.environment = environment;
  });
  await check('Unicode and spaced project folders support check, build, preview and screenshots', async () => {
    project = await tool('aiui_project_create', { directory: path.join(home, 'Project 用户 & spaces'), name: '用户项目 User project' });
    await job('aiui_project_check', { projectId: project.id });
    const build = await job('aiui_project_pack', { projectId: project.id });
    assert.equal(sha(await fs.readFile(build.path)), build.sha256);
    const preview = await tool('aiui_preview_open', { projectId: project.id });
    await page.getByText('Preview running', { exact: true }).waitFor({ timeout: 30000 });
    const capture = await mcp.callTool({ name: 'aiui_preview_capture', arguments: { sessionId: preview.id } });
    assert.equal(capture.content[0].type, 'image');
    await fs.writeFile(path.join(output, 'preview.png'), Buffer.from(capture.content[0].data, 'base64'));
    await page.screenshot({ path: path.join(output, 'desktop-english.png') });
  });
  await check('source watching and language persistence survive a packaged service restart', async () => {
    await fs.appendFile(path.join(project.agentPath, 'pages/index/index.ink'), '\n<!-- portable QA -->\n');
    await until(async () => (await tool('aiui_projects_list')).projects.find(p => p.id === project.id)?.revision !== project.revision);
    await stop(); await launch();
    assert.equal((await tool('aiui_projects_list')).projects[0].id, project.id);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.error = error.stack; report.serviceLog = await fs.readFile(path.join(home, 'service.log'), 'utf8').then(text => text.slice(-8000)).catch(() => null);
  if (app) report.desktopState = await bounded(app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), url: window.webContents.getURL(), loading: window.webContents.isLoading() })) })), 3000).catch(error => ({ error: error.message }));
  if (page) { report.pageURL = page.url(); report.pageText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => null); await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {}); }
  console.error(error); await atomicJson(path.join(output, 'verification.json'), report);
} finally {
  try { await bounded(stop(), 25000); } catch (error) { report.cleanupError = error.message; report.passed = false; }
  await atomicJson(path.join(output, 'verification.json'), report);
  process.exit(report.passed ? 0 : 1);
}
