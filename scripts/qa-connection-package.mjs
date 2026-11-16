import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchDesktop, closeDesktop, portableEnvironment } from './desktop-test.mjs';
import { packagedPaths } from './packaged-paths.mjs';
import { APP_VERSION } from '../core/version.mjs';
import { ROOT, readJson, sha, sleep } from '../core/util.mjs';

const { executablePath, appRoot } = packagedPaths();
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-connection-package-'));
const env = { ...portableEnvironment(home), AIUI_SKILL_HOME: path.join(home, 'skills') };
let app, client;
try {
  assert.equal((await readJson(path.join(appRoot, 'package.json'))).version, APP_VERSION);
  for (const file of ['core/connection-guide.mjs', 'core/wireless-pair-qr.mjs', 'mcp/server.mjs', 'assets/wireless-helper/manifest.json', 'assets/skills/aiui-workshop/references/connection.md']) {
    assert.equal(sha(await fs.readFile(path.join(appRoot, file))), sha(await fs.readFile(path.join(ROOT, file))), file);
  }
  for (const locale of ['zh-CN', 'en']) for (const step of ['overview', 'install', 'pair', 'ready', 'usage', 'usb', 'usb-ready', 'usb-usage']) {
    const file = 'assets/connection-guide/' + locale + '/' + step + '.png';
    assert.equal(sha(await fs.readFile(path.join(appRoot, file))), sha(await fs.readFile(path.join(ROOT, file))), file);
  }
  app = await launchDesktop({ executablePath, args: [], cwd: ROOT, env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
  await page.getByRole('list', { name: '连接进度', exact: true }).waitFor();
  assert.equal(await page.locator('.wireless-progress li').count(), 3);
  await page.locator('.device-connection-methods').getByRole('tab', { name: '有线连接', exact: true }).click();
  await page.locator('.wired-connection').waitFor();
  assert.equal(await page.locator('.wireless-connection').count(), 0);
  await page.locator('.device-connection-methods').getByRole('tab', { name: '无线连接', exact: true }).click();
  const config = (await page.evaluate(() => window.workbench.call('aiui_mcp_config'))).mcpServers['aiui-workbench'];
  client = new Client({ name: 'connection-package-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...env, ...config.env }, stderr: 'pipe' }), { timeout: 15000 });
  const tools = (await client.listTools()).tools;
  for (const name of ['aiui_connection_guide', 'aiui_adb_pair_qr']) assert.ok(tools.some(tool => tool.name === name));
  const skill = await client.callTool({ name: 'aiui_skill_read', arguments: { path: 'references/connection.md' } });
  assert.equal(skill.isError, undefined); assert.match(skill.content[0].text, /Remote control/);
  for (const locale of ['zh-CN', 'en']) {
    const guide = await client.callTool({ name: 'aiui_connection_guide', arguments: { step: 'ready', method: 'usb', locale } });
    assert.equal(guide.isError, undefined);
    assert.equal(guide.content.filter(item => item.type === 'image' && item.mimeType === 'image/png').length, 2);
  }
  const qr = await client.callTool({ name: 'aiui_adb_pair_qr', arguments: { action: 'start' } });
  assert.equal(qr.isError, undefined); assert.equal(qr.content[0].type, 'image');
  const id = JSON.parse(qr.content.find(item => item.type === 'text').text).id;
  const cancel = await client.callTool({ name: 'aiui_adb_pair_qr', arguments: { action: 'cancel', id } });
  assert.equal(cancel.isError, undefined);
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await page.getByRole('list', { name: 'Connection progress', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS packaged ' + APP_VERSION + ': desktop, localized guide images, bundled helper, Skill and MCP QR lifecycle');
} finally {
  await client?.close();
  await closeDesktop(app);
  const connection = await readJson(path.join(home, 'connection.json'), null);
  if (connection) {
    const health = await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (health?.ok && (await health.json()).pid === connection.pid) {
      process.kill(connection.pid, 'SIGTERM');
      for (let i = 0; i < 50; i++) {
        if (!await fs.stat(path.join(home, 'connection.json')).catch(() => null)) break;
        await sleep(100);
      }
    }
  }
  await fs.rm(home, { recursive: true, force: true });
}
