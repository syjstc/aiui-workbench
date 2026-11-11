import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { zipSync, strToU8 } from 'fflate';
import { startDaemon } from '../core/daemon.mjs';
import { startWeb } from '../web/server.mjs';
import { ROOT, atomicJson, sha, sleep } from '../core/util.mjs';

const home = path.join(ROOT, '.local/web-updates-qa', String(Date.now()));
const output = path.join(ROOT, 'output/qa/web-updates'); await fs.mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), home, checks: [], errors: [], updateSource: 'Simulated HTTPS responses with a real ZIP fixture; no public release or application replacement', deviceVerified: false };
let daemon, web, browser, app, mcp;
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(150); } throw new Error('等待验收状态超时'); }
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
async function tool(name, args = {}) { const result = await mcp.callTool({ name, arguments: args }); if (result.isError) throw new Error(result.content.map(c => c.text || '').join('\n')); return JSON.parse(result.content.find(c => c.type === 'text').text); }
try {
  daemon = await startDaemon(home); await daemon.service.sdk.settings({ autoCheck: false });
  web = await startWeb({ home });
  browser = await chromium.launch({ executablePath: process.env.AIUI_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(web.url); await page.getByRole('heading', { name: '项目库', exact: true }).waitFor();
  await check('浏览器通过随机链接登录，地址栏清除口令，刷新后会话仍有效', async () => {
    await page.getByText('本地服务运行中', { exact: true }).waitFor(); assert.equal(new URL(page.url()).hash, '');
    await page.reload(); await page.getByText('本地服务运行中', { exact: true }).waitFor();
    const cookies = await page.context().cookies(web.origin + '/api/health'); assert.equal(cookies[0].httpOnly, true); assert.equal(cookies[0].sameSite, 'Strict');
  });
  let project, preview;
  await check('Web 目录选择器导入真实示例工程，项目卡片和官方资料正常显示', async () => {
    await page.getByRole('button', { name: '导入项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '选择本机目录' }); await dialog.waitFor();
    await until(async () => !(await dialog.getByRole('button', { name: '前往', exact: true }).isDisabled()));
    await dialog.getByLabel('目录路径').fill(path.resolve(ROOT, 'examples/hello-aiui'));
    await dialog.getByRole('button', { name: '前往', exact: true }).click();
    await until(async () => !(await dialog.getByRole('button', { name: '选择此目录' }).isDisabled()));
    await dialog.getByRole('button', { name: '选择此目录' }).click();
    project = await until(() => daemon.service.projects.list()[0]);
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'web-projects.png') });
  });
  mcp = new Client({ name: 'web-updates-qa', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], env: { ...process.env, AIUI_WORKBENCH_HOME: home } }));
  await check('浏览器运行真实官方 Ink，MCP 共享预览、姿态与截图', async () => {
    assert.equal((await tool('aiui_projects_list')).projects[0].id, project.id);
    await page.getByRole('heading', { name: project.name, exact: true }).click();
    await page.getByText('预览运行中', { exact: true }).waitFor({ timeout: 60000 });
    await page.frameLocator('iframe').locator('#status').waitFor({ state: 'hidden' });
    preview = daemon.service.previews.list()[0];
    await tool('aiui_preview_action', { sessionId: preview.id, action: 'pose', parameters: { yaw: 9, pitch: -4, roll: 2 } });
    await until(async () => (await tool('aiui_preview_state', { sessionId: preview.id })).state.pose.yaw === 9);
    const capture = await mcp.callTool({ name: 'aiui_preview_capture', arguments: { sessionId: preview.id } });
    assert.equal(capture.content[0].type, 'image'); await fs.writeFile(path.join(output, 'web-mcp-capture.png'), Buffer.from(capture.content[0].data, 'base64'));
    await page.screenshot({ path: path.join(output, 'web-simulator.png') });
  });
  await check('浏览器照片选择器导入本机模拟照片', async () => {
    await page.getByRole('button', { name: '相机', exact: true }).click();
    const chooser = page.waitForEvent('filechooser'); await page.locator('.fixture-picker').click();
    await (await chooser).setFiles(path.join(ROOT, 'assets/icon.png'));
    await page.getByText('已载入模拟照片', { exact: true }).waitFor();
    assert.equal((await tool('aiui_preview_state', { sessionId: preview.id })).state.camera.fixture, true);
  });
  await check('Web 设置与窄屏项目库可正常使用', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('heading', { name: '启动与升级 Web 版' }).waitFor();
    await page.setViewportSize({ width: 680, height: 900 }); await page.getByRole('button', { name: /项目库/ }).first().click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(output, 'web-narrow.png') });
  });
  await browser.close(); browser = null;
  const archive = Buffer.from(zipSync({ 'README.txt': strToU8('Simulated update acceptance fixture. This is not an application installer.') }));
  const fixture = { schemaVersion: 1, version: '0.3.0', notes: '模拟发行源：Web 与更新链路验收', releaseUrl: 'https://updates.example/releases/v0.3.0', files: [{ platform: process.platform, arch: process.arch, url: './AIUI-qa.zip', sha256: sha(archive), size: archive.length }] };
  await atomicJson(path.join(home, 'app-updates.json'), { source: 'github', autoCheck: true, intervalHours: 24, sources: { github: { repository: 'test/workbench' } } });
  const wrapper = path.join(home, 'fixture-main.cjs');
  await fs.writeFile(wrapper, `const nativeFetch=globalThis.fetch;globalThis.__updateFixtureRequests=[];
const fixture=${JSON.stringify(fixture)},archive=Buffer.from('${archive.toString('base64')}','base64');
globalThis.fetch=async(input,options)=>{const url=String(input);if(url.startsWith('https://updates.example/')||url==='https://api.github.com/repos/test/workbench/releases/latest'){globalThis.__updateFixtureRequests.push(url);if(url.endsWith('/latest'))return new Response(JSON.stringify({tag_name:'v0.3.0',assets:[{name:'workbench-update.json',browser_download_url:'https://updates.example/workbench-update.json'}]}));if(url.endsWith('.zip'))return new Response(archive);return new Response(JSON.stringify(url.includes('bad.json')?{...fixture,files:[{...fixture.files[0],sha256:'0'.repeat(64)}]}:fixture));}return nativeFetch(input,options);};
require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});\n`);
  const launch = () => electron.launch({ args: [wrapper], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  app = await launch(); let desktop = await app.firstWindow(); desktop.on('pageerror', error => report.errors.push(error.message));
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await check('真实 Electron 启动自动检查 GitHub 发行源，显示适配当前平台的新版本', async () => {
    await desktop.getByRole('heading', { name: '发现新版本 0.3.0' }).waitFor();
    assert.equal((await desktop.evaluate(() => window.workbench.updates('status'))).checking, false);
    assert.ok((await app.evaluate(() => globalThis.__updateFixtureRequests)).some(url => url.includes('/releases/latest')));
    await desktop.screenshot({ path: path.join(output, 'desktop-update-available.png') });
  });
  await check('桌面下载真实 ZIP 数据并校验摘要，IPC 仅暴露既定更新操作', async () => {
    await desktop.getByRole('button', { name: '下载新版本安装包' }).click(); await desktop.getByText('SHA256 校验通过', { exact: true }).waitFor();
    const state = await desktop.evaluate(() => window.workbench.updates('status')); assert.deepEqual(await fs.readFile(state.downloaded.path), archive);
    assert.equal(await desktop.evaluate(async () => { try { await window.workbench.updates('unknown'); return false; } catch { return true; } }), true);
    await desktop.screenshot({ path: path.join(output, 'desktop-update-downloaded.png') });
  });
  await check('换源清除旧结果，校验失败不提供安装包', async () => {
    await desktop.getByLabel('客户端更新源').selectOption('custom'); await desktop.getByLabel('更新清单地址').fill('https://updates.example/bad.json');
    await desktop.getByRole('button', { name: '保存更新设置' }).click();
    await until(async () => !(await desktop.getByRole('button', { name: '立即检查更新' }).isDisabled()));
    assert.equal((await desktop.evaluate(() => window.workbench.updates('status'))).latest, null);
    await desktop.getByRole('button', { name: '立即检查更新' }).click(); await desktop.getByRole('heading', { name: '发现新版本 0.3.0' }).waitFor();
    await desktop.getByRole('button', { name: '下载新版本安装包' }).click(); await desktop.getByRole('alert').filter({ hasText: '校验失败' }).waitFor();
    assert.equal((await desktop.evaluate(() => window.workbench.updates('status'))).downloaded, null);
  });
  await check('CNB 来源和自动检查开关重启后保留，各平台地址互不覆盖', async () => {
    await desktop.getByLabel('客户端更新源').selectOption('cnb'); await desktop.getByLabel('更新清单地址').fill('https://updates.example/cnb.json');
    await desktop.getByText('启动时自动检查更新', { exact: true }).uncheck(); await desktop.getByLabel('后台检查频率').isDisabled();
    await desktop.getByRole('button', { name: '保存更新设置' }).click();
    await until(async () => (await desktop.evaluate(() => window.workbench.updates('status'))).source === 'cnb');
    await app.close(); app = await launch(); desktop = await app.firstWindow(); desktop.on('pageerror', error => report.errors.push(error.message));
    await desktop.getByRole('button', { name: '设置', exact: true }).click(); await desktop.getByLabel('更新清单地址').waitFor();
    assert.equal(await desktop.getByLabel('客户端更新源').inputValue(), 'cnb'); assert.equal(await desktop.getByText('启动时自动检查更新', { exact: true }).isChecked(), false);
    const state = await desktop.evaluate(() => window.workbench.updates('status'));
    assert.equal(state.sources.github.repository, 'test/workbench'); assert.equal(state.sources.custom.manifestUrl, 'https://updates.example/bad.json');
    assert.deepEqual(await app.evaluate(() => globalThis.__updateFixtureRequests), []);
    await desktop.screenshot({ path: path.join(output, 'desktop-update-sources.png') });
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
  await app?.close(); await browser?.close(); await mcp?.close(); await web?.close(); await daemon?.close();
}
