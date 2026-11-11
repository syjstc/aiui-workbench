import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packagedPaths } from './packaged-paths.mjs';
import { ROOT, readJson, sha } from '../core/util.mjs';

const { executablePath, appRoot } = packagedPaths();
const home = await fs.mkdtemp(path.join(ROOT, '.local/packaged-glasses-')), output = path.join(ROOT, 'output/qa/glasses-packaged');
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, PATH: '', AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '', ADB: '/does-not-exist/adb', SCRCPY_SERVER_PATH: '/does-not-exist/server' };
delete env.Path; delete env.ANDROID_HOME; delete env.ANDROID_SDK_ROOT;
const report = { startedAt: new Date().toISOString(), executablePath, home, emptyPath: true, checks: [], errors: [] };
let app, mcp;
const check = async (name, work) => { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); };
try {
  app = await electron.launch({ executablePath, args: [], cwd: ROOT, env });
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.getByRole('button', { name: '眼镜工具', exact: true }).click();
  await check('完整客户端在空 PATH 下读取真实眼镜与空间信息', async () => {
    await page.getByRole('heading', { name: '存储空间', exact: true }).waitFor({ timeout: 30000 });
    assert.match(await page.locator('.glasses-info-list').innerText(), /RG-glasses/);
    const environment = await page.evaluate(() => window.workbench.call('aiui_environment_check'));
    assert.equal(environment.adbTool.source, 'bundled'); assert.ok(environment.adbTool.path.startsWith(appRoot));
    report.serialSuffix = environment.devices[0].serial.slice(-6);
    await page.screenshot({ path: path.join(output, '01-packaged-overview.png') });
  });
  await check('内置投屏完整性、真实首帧及停止操作', async () => {
    const key = `${process.platform}-${process.arch}`, directory = path.join(appRoot, 'vendor/scrcpy', key), receipt = await readJson(path.join(directory, 'bundle.json'));
    for (const [file, hash] of Object.entries(receipt.files)) assert.equal(sha(await fs.readFile(path.join(directory, file))), hash, file);
    for (const other of ['darwin-arm64','darwin-x64','win32-x64','linux-x64'].filter(value => value !== key)) assert.equal(await fs.access(path.join(appRoot, 'vendor/scrcpy', other)).then(() => true, () => false), false);
    await page.getByRole('tab', { name: '真机投屏', exact: true }).click();
    await page.getByRole('button', { name: '打开真机投屏', exact: true }).click();
    await page.getByText('眼镜正在投屏', { exact: true }).waitFor({ timeout: 30000 });
    const serial = await page.getByLabel('工具目标眼镜').inputValue();
    const status = await page.evaluate(serial => window.workbench.call('aiui_glasses_mirror_status', { serial }), serial);
    assert.equal(status.source, 'bundled'); assert.ok(status.binary.startsWith(directory)); assert.ok(status.server.startsWith(directory));
    assert.match(status.session.output, /Texture(?: \([^)]*\))?:/); assert.ok(!/Could not load icon|\/opt\/homebrew/.test(status.session.output));
    report.mirroring = status;
    await page.screenshot({ path: path.join(output, '02-packaged-mirroring.png') });
    await page.getByRole('button', { name: '停止投屏', exact: true }).click();
    await page.getByText('把眼镜画面带到电脑上', { exact: true }).waitFor();
  });
  await check('打包后的 APK 拖拽可读取真实文件且不会自动安装', async () => {
    const source = await readJson(path.join(ROOT, 'output/qa/glasses-tools/verification.json'));
    const apk = path.join(source.home, 'workbench QA.apk'); await fs.access(apk);
    await page.getByRole('tab', { name: '安装 APK', exact: true }).click();
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'qa-package-drop'; input.hidden = true; document.body.append(input); });
    await page.locator('#qa-package-drop').setInputFiles(apk);
    await page.evaluate(() => { const data = new DataTransfer(); data.items.add(document.querySelector('#qa-package-drop').files[0]); document.querySelector('.glasses-apk-picker').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })); });
    await page.getByText('workbench QA.apk', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.workbench.call('aiui_status'))).jobs.some(job => job.type === 'glasses-install'), false);
    await page.screenshot({ path: path.join(output, '03-packaged-drag-apk.png') });
  });
  await check('MCP 使用客户端自带运行时并暴露同一套眼镜工具', async () => {
    const config = (await page.evaluate(() => window.workbench.call('aiui_mcp_config'))).mcpServers['aiui-workbench'];
    assert.equal(config.command, executablePath);
    mcp = new Client({ name: 'packaged-glasses-qa', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...env, ...config.env } }));
    const names = (await mcp.listTools()).tools.map(tool => tool.name);
    for (const name of ['aiui_glasses_mirror_start','aiui_glasses_mirror_stop','aiui_glasses_install','aiui_glasses_read_file','aiui_glasses_push']) assert.ok(names.includes(name));
    report.mcpTools = names.length;
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  await mcp?.close(); await app?.close();
  const connection = await readJson(path.join(home, 'connection.json'), null);
  if (connection) {
    const result = await fetch(connection.origin + '/health', { headers: { Authorization: `Bearer ${connection.token}` } }).catch(() => null);
    if (result?.ok && (await result.json()).pid === connection.pid) process.kill(connection.pid, 'SIGTERM');
  }
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
}
