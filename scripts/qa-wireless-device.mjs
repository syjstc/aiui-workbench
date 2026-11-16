import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, homePath, id, sleep } from '../core/util.mjs';
import { AdbTools } from '../core/adb.mjs';

const serial = process.argv[2];
if (!serial || !serial.includes(':')) throw new Error('Pass the connected wireless IP:port as the first argument.');
const bundle = path.resolve(process.argv[3] || path.join(ROOT, 'output/local-062-wireless/AIUI Workshop-darwin-arm64/AIUI Workshop.app'));
const executablePath = path.join(bundle, 'Contents/MacOS/AIUI Workshop'), appRoot = path.join(bundle, 'Contents/Resources/app');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-wireless-device-'));
const output = path.join(ROOT, 'output/qa/wireless');
await fs.mkdir(output, { recursive: true });
await fs.copyFile(path.join(homePath(), 'wireless-devices.json'), path.join(home, 'wireless-devices.json'));
const env = { ...process.env, PATH: '', AIUI_WORKBENCH_HOME: home, AIUI_SKILL_HOME: home, ELECTRON_RUN_AS_NODE: '' };
delete env.Path; delete env.ANDROID_HOME; delete env.ANDROID_SDK_ROOT;
const adb = new AdbTools(home, { root: appRoot });
const remote = '/sdcard/Download/aiui-wireless-qa-' + id() + '.txt';
const report = { at: new Date().toISOString(), serial, simulatedTransport: false, checks: [], errors: [] };
let app, mcp, connection, copied = false;
async function check(name, work) { await work(); report.checks.push(name); console.log('PASS', name); }
async function waitFor(read, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await read()) return; await sleep(150); } throw new Error('Timed out'); }
try {
  app = await electron.launch({ executablePath, args: [], cwd: ROOT, env });
  const page = await app.firstWindow();
  connection = JSON.parse(await fs.readFile(path.join(home, 'connection.json'), 'utf8'));
  page.on('pageerror', error => report.errors.push(error.message));
  const call = (tool, args = {}) => page.evaluate(({ tool, args }) => window.workbench.call(tool, args), { tool, args });
  async function job(tool, args) {
    const started = await call(tool, args);
    let result;
    await waitFor(async () => { result = await call('aiui_job_get', { jobId: started.id }); if (result.status === 'failed') throw new Error(result.error); return result.status === 'succeeded'; }, 60000);
    return result.result;
  }
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
  await check('packaged app uses its bundled ADB with no PATH or Android SDK configuration', async () => {
    let environment;
    await waitFor(async () => { environment = await call('aiui_environment_check'); return environment.devices.some(device => device.serial === serial && device.inspection?.runtimeReady); });
    assert.equal(environment.adbTool.source, 'bundled');
    assert.ok(environment.adbTool.path.startsWith(appRoot));
    report.physicalUsbAbsent = environment.usbDevices.length === 0;
    if (process.env.AIUI_QA_REQUIRE_NO_USB === '1') assert.equal(report.physicalUsbAbsent, true, 'Unplug the data cable before this acceptance run');
    assert.equal(environment.devices.filter(device => device.connection === 'wireless').length, 1);
    await page.getByRole('heading', { name: '眼镜已就绪', exact: true }).waitFor();
  });
  await check('device information, app listing, screenshots and logs work over the Wi-Fi serial', async () => {
    const info = await call('aiui_glasses_info', { serial });
    assert.ok(info.system.model);
    const apps = await call('aiui_glasses_apps', { serial, appearance: false });
    assert.ok(apps.packages.length);
    await call('aiui_glasses_control', { serial, action: 'wake' });
    const screenshot = await call('aiui_glasses_screenshot', { serial });
    assert.ok(screenshot.width > 0 && screenshot.height > 0);
    const logs = await call('aiui_glasses_logs', { serial, lines: 100 });
    assert.ok(logs.output.length > 0);
    report.device = { model: info.system.model, screenshot: { width: screenshot.width, height: screenshot.height }, logBytes: logs.output.length };
  });
  await check('file import, preview and export preserve exact bytes over Wi-Fi', async () => {
    const file = path.join(home, path.posix.basename(remote)), contents = Buffer.from('AIUI wireless transport verification\n中文文件内容\n');
    await fs.writeFile(file, contents);
    await job('aiui_glasses_push', { serial, directory: '/sdcard/Download', files: [file] }); copied = true;
    const preview = await call('aiui_glasses_read_file', { serial, path: remote });
    assert.equal(preview.content, contents.toString());
    const pulled = await job('aiui_glasses_pull', { serial, path: remote });
    assert.deepEqual(await fs.readFile(pulled.path), contents);
  });
  await check('a temporary AIUI app installs over Wi-Fi and is removed after verification', async () => {
    const project = await call('aiui_project_create', { directory: path.join(home, 'wireless-install-qa'), name: 'Wireless Connection QA' });
    await job('aiui_device_deploy', { projectId: project.id, serial });
    const identity = (await fs.readFile(path.join(project.agentPath, '.aix/agent-id'), 'utf8')).trim();
    const agentId = identity.startsWith('develop.rokid.') ? identity : 'develop.rokid.agent.' + identity;
    try {
      const installed = await call('aiui_glasses_aiui_apps', { serial });
      assert.ok(installed.apps.some(app => app.agentId === agentId));
    } finally {
      await job('aiui_glasses_aiui_uninstall', { serial, agentId, confirmAgentId: agentId });
    }
    report.temporaryAppRemoved = true;
  });
  await check('packaged MCP discovers the wireless tools and shares the same saved glasses', async () => {
    mcp = new Client({ name: 'wireless-device-qa', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: executablePath, args: [path.join(appRoot, 'mcp/server.mjs')], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }));
    const catalog = await mcp.listTools();
    assert.ok(catalog.tools.some(tool => tool.name === 'aiui_adb_restart'));
    const discovered = await mcp.callTool({ name: 'aiui_adb_discover', arguments: { refresh: true } });
    assert.ok(!discovered.isError);
    assert.ok(JSON.stringify(discovered).includes(serial));
  });
  await check('embedded mirroring receives and renders live frames over Wi-Fi', async () => {
    await page.locator('.sidebar').getByRole('button', { name: '眼镜工具', exact: true }).click();
    await page.getByRole('tab', { name: '真机投屏', exact: true }).click();
    // Opening this tab starts the stream automatically.
    await waitFor(async () => { const state = await call('aiui_glasses_mirror_embed_status', { serial }); report.frames = state.session?.frames || 0; return state.session?.status === 'running' && state.session.frames >= 2; });
    await page.frameLocator('iframe[title="内嵌真机投屏"]').locator('canvas').waitFor();
    await sleep(500);
    await page.screenshot({ path: path.join(output, 'real-wireless-mirroring.png'), fullPage: true });
    await call('aiui_glasses_mirror_embed_stop', { serial });
  });
  await check('dropping the wireless transport is recovered automatically from the saved record', async () => {
    const result = await adb.execute(['disconnect', serial]);
    assert.equal(result.code, 0);
    await waitFor(async () => {
      const environment = await call('aiui_environment_check');
      return environment.devices.some(device => device.serial === serial && device.status === 'device') && environment.wireless.saved.some(record => record.status === 'connected');
    });
  });
  assert.deepEqual(report.errors, []);
} finally {
  await mcp?.close();
  await app?.close();
  if (copied) await adb.execute(['-s', serial, 'shell', 'rm', remote]).catch(() => {});
  if (connection) {
    const health = await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(1500) }).then(response => response.json()).catch(() => null);
    if (health?.pid === connection.pid) process.kill(connection.pid, 'SIGTERM');
  }
  await fs.writeFile(path.join(output, 'real-device-report.json'), JSON.stringify(report, null, 2) + '\n');
  // Allow the daemon to persist its final state before discarding isolated QA data.
  await sleep(300);
  await fs.rm(home, { recursive: true, force: true });
}
