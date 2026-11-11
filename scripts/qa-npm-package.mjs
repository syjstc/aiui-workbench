import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { ROOT, atomicJson, readJson, run, sleep } from '../core/util.mjs';
import { APP_VERSION } from '../core/version.mjs';

const require = createRequire(import.meta.url), base = path.join(ROOT, '.local/npm-package-qa', String(Date.now()));
const home = path.join(base, 'data'), installed = path.join(base, 'node_modules/aiui-workbench'), output = path.join(ROOT, 'output/qa/web-updates');
const report = { startedAt: new Date().toISOString(), version: APP_VERSION, hoistedDependencies: true, checks: [] };
let child, browser, connection;
async function until(fn) { for (let i = 0; i < 160; i++) { const result = await fn(); if (result) return result; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('npm 命令提前退出'); await sleep(150); } throw new Error('npm 包启动验证超时'); }
try {
  const packed = (await readJson(path.join(ROOT, 'output/npm/pack.json')))[0];
  await fs.mkdir(installed, { recursive: true }); await fs.mkdir(output, { recursive: true });
  const unpack = await run('tar', ['-xzf', path.join(ROOT, 'output/npm', packed.filename), '--strip-components=1', '-C', installed]); assert.equal(unpack.code, 0);
  await atomicJson(path.join(base, 'package.json'), { private: true, dependencies: { 'aiui-workbench': APP_VERSION } });
  // Simulate npm/npx's hoisted install layout without redownloading dependencies.
  for (const entry of await fs.readdir(path.join(ROOT, 'node_modules'))) {
    if (entry.startsWith('.') || entry === 'aiui-workbench') continue;
    await fs.symlink(path.join(ROOT, 'node_modules', entry), path.join(base, 'node_modules', entry));
  }
  await fs.mkdir(path.join(base, 'node_modules/.bin'), { recursive: true });
  await fs.symlink(path.join(installed, 'web/cli.mjs'), path.join(base, 'node_modules/.bin/aiui-workbench'));
  assert.equal(await fs.access(path.join(installed, 'node_modules')).then(() => true, () => false), false);
  const npm = path.join(path.dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js'); let stdout = '', stderr = '';
  child = spawn(process.execPath, [npm, 'exec', '--offline', '--cache', path.join(ROOT, '.local/npm-cache'), '--prefix', base, '--', 'aiui-workbench', '--no-open'], { cwd: base, env: { ...process.env, AIUI_WORKBENCH_HOME: home }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const url = await until(() => { if (child.exitCode !== null) throw new Error(stderr || stdout); return stdout.match(/http:\/\/127\.0\.0\.1:\d+\/renderer\/index\.html#key=[a-f0-9]+/)?.[0]; });
  connection = await readJson(path.join(home, 'connection.json')); assert.equal(connection.version || (await (await fetch(connection.origin + '/health', { headers: { Authorization: `Bearer ${connection.token}` } })).json()).version, APP_VERSION);
  report.checks.push('npm exec 自动启动包内服务与 Web，不依赖源码目录的 node_modules 布局');
  browser = await chromium.launch({ executablePath: process.env.AIUI_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.getByText('本地服务运行中', { exact: true }).waitFor();
  const status = await page.evaluate(() => window.workbench.call('aiui_status')); assert.ok(status.knowledge.documents > 100); assert.equal(status.version, APP_VERSION);
  const project = await page.evaluate(directory => window.workbench.call('aiui_project_create', { directory, name: 'npm 安装包验证' }), path.join(home, 'projects/example'));
  await page.evaluate(projectId => window.workbench.call('aiui_preview_open', { projectId }), project.id);
  await page.getByRole('button', { name: '模拟器', exact: true }).click(); await page.getByRole('button', { name: '运行 npm 安装包验证', exact: true }).click();
  await page.getByText('预览运行中', { exact: true }).waitFor({ timeout: 45000 }); await page.frameLocator('iframe').locator('#status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'npm-installed-web.png') }); assert.deepEqual(errors, []);
  report.checks.push('真实 npm 包内离线资料、官方模板创建和 Ink 运行时正常'); report.passed = true;
  console.log('PASS npm 打包产物一条命令启动、依赖提升布局、资料和模拟器');
} catch (error) { report.error = error.stack; throw error; }
finally {
  await browser?.close();
  if (child?.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  if (!connection) connection = await readJson(path.join(home, 'connection.json'), null);
  if (connection?.pid) { try { process.kill(connection.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'npm-package-acceptance.json'), JSON.stringify(report, null, 2));
}
