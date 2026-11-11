import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import semver from 'semver';
import { launchDesktop, portableEnvironment, closeDesktop, bounded } from './desktop-test.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AppUpdates, validateManifest } from '../core/updates.mjs';
import { Workbench } from '../core/service.mjs';
import { ROOT, atomicJson, readJson, run, sleep } from '../core/util.mjs';
import { APP_VERSION } from '../core/version.mjs';

const repository = process.env.AIUI_UPDATE_REPOSITORY || 'syjstc/aiui-workbench';
const target = process.env.AIUI_UPDATE_TARGET_VERSION || APP_VERSION;
const from = process.env.AIUI_UPDATE_FROM_VERSION || (semver.patch(target) > 0 ? `${semver.major(target)}.${semver.minor(target)}.${semver.patch(target) - 1}` : '0.3.1');
assert.ok(semver.valid(target) && semver.valid(from) && semver.lt(from, target));
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-github-upgrade-')), home = path.join(base, 'user-data');
const output = path.join(ROOT, 'output/qa/github-upgrade', process.platform + '-' + process.arch); await fs.mkdir(output, { recursive: true });
const report = { repository, fromVersion: from, targetVersion: target, realGitHub: true, responsesMocked: false, isolatedUserData: true, checks: [], errors: [] };
let app, manager, page, mcp;
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
async function until(work, timeout = 120000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await work(); if (value) return value; await sleep(300); } throw new Error('GitHub upgrade check timed out'); }
async function hash(file) { const h = createHash('sha256'); for await (const part of createReadStream(file)) h.update(part); return h.digest('hex'); }
async function command(command, args) { const r = await run(command, args, { timeout: 300000 }); assert.equal(r.code, 0, r.output); return r.output; }
async function stop() {
  await mcp?.close(); mcp = null;
  await closeDesktop(app); app = null;
  const connection = await readJson(path.join(home, 'connection.json'), null);
  if (connection) {
    const healthy = await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (healthy?.ok && (await healthy.json()).pid === connection.pid) {
      process.kill(connection.pid, 'SIGTERM');
      await until(async () => !(await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(500) }).catch(() => null)), 15000);
    }
  }
}
async function extract(archive, destination) {
  // Verify entry names without inflating the archive into memory.
  unzipSync(await fs.readFile(archive), { filter: entry => { assert.ok(!entry.name.startsWith('/') && !entry.name.includes('\\') && !entry.name.includes(':') && !entry.name.split('/').includes('..'), 'Unsafe ZIP entry'); return false; } });
  await fs.mkdir(destination, { recursive: true });
  if (process.platform === 'darwin') await command('ditto', ['-x', '-k', archive, destination]);
  else await command(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe'), ['-xf', archive, '-C', destination]);
  return process.platform === 'darwin' ? path.join(destination, 'AIUI Workshop.app/Contents/MacOS/AIUI Workshop') : path.join(destination, 'AIUI Workshop-win32-x64/AIUI Workshop.exe');
}
async function launch(executablePath) {
  app = await launchDesktop({ executablePath, args: [], cwd: ROOT, env: portableEnvironment(home) });
  page = await app.firstWindow({ timeout: 45000 }); page.setDefaultTimeout(45000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor({ timeout: 45000 });
}
try {
  manager = await new AppUpdates(home, { version: from }).init();
  await manager.settings({ source: 'github', sources: { github: { repository } }, autoCheck: true });
  const baselineRelease = (await manager.json(`https://api.github.com/repos/${repository}/releases/tags/v${from}`, manager.controller.signal)).value;
  const manifestUrl = baselineRelease.assets.find(asset => asset.name === 'workbench-update.json')?.browser_download_url; assert.ok(manifestUrl, 'Previous release manifest missing');
  const baselineManifest = (await manager.json(manifestUrl, manager.controller.signal)).value;
  const previous = validateManifest(baselineManifest, manifestUrl, process.platform, process.arch);
  const previousZip = path.join(base, 'previous.zip'), handle = await fs.open(previousZip, 'wx');
  try { const { response } = await manager.request(previous.file.url, manager.controller.signal); for await (const part of response.body) await handle.writeFile(part); } finally { await handle.close(); }
  assert.equal(await hash(previousZip), previous.file.sha256); assert.equal((await fs.stat(previousZip)).size, previous.file.size);
  const previousExecutable = await extract(previousZip, path.join(base, 'previous'));
  await check('the previous official release downloads from GitHub with its exact SHA256', async () => { assert.equal(previous.version, from); await fs.access(previousExecutable); });
  const directory = path.join(home, 'projects/Upgrade Example'); await fs.cp(path.join(ROOT, 'examples/hello-aiui'), directory, { recursive: true });
  const projectConfig = await readJson(path.join(directory, 'app.json')); projectConfig.name = projectConfig.agentName = 'Upgrade Example'; await atomicJson(path.join(directory, 'app.json'), projectConfig);
  const service = await new Workbench(home).init(); let project;
  try { project = await service.projects.import(directory); } finally { await service.close(); }
  const originalHash = await hash(path.join(project.agentPath, 'pages/index/index.ink'));
  await launch(previousExecutable);
  await check('the real previous desktop app detects the new GitHub release automatically on startup', async () => {
    const status = await until(async () => { const s = await page.evaluate(() => window.workbench.updates('status')); if (s.error && !s.checking) throw new Error(s.error); return !s.checking && s.latest && s; });
    assert.equal(status.version, from); assert.equal(status.latest.version, target); assert.equal(status.updateAvailable, true); assert.equal(status.autoCheck, true);
    report.automaticCheck = { currentVersion: status.version, foundVersion: status.latest.version, source: status.source };
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await sleep(500); await page.screenshot({ path: path.join(output, 'old-client-found-update.png') });
  });
  let downloaded;
  await check('the old app downloads the real installer and independently verifies bytes and SHA256', async () => {
    downloaded = await page.evaluate(() => window.workbench.updates('download'));
    assert.equal(downloaded.version, target); assert.equal(await hash(downloaded.path), downloaded.sha256); assert.equal((await fs.stat(downloaded.path)).size, downloaded.size);
    report.download = { version: target, sha256: downloaded.sha256, bytes: downloaded.size };
  });
  await stop();
  const nextExecutable = await extract(downloaded.path, path.join(base, 'updated'));
  await check('the downloaded package has the documented platform signing status', async () => {
    if (process.platform !== 'darwin') { report.windowsUnsigned = true; return; }
    const bundle = path.resolve(path.dirname(nextExecutable), '../..');
    await command('codesign', ['--verify', '--deep', '--strict', bundle]); await command('xcrun', ['stapler', 'validate', bundle]); await command('spctl', ['--assess', '--type', 'execute', bundle]);
    report.notarizedDownloadVerified = true;
  });
  await launch(nextExecutable);
  await check('the downloaded new app starts with the same local project and source bytes', async () => {
    const status = await until(async () => { const s = await page.evaluate(() => window.workbench.updates('status')); if (s.error && !s.checking) throw new Error(s.error); return !s.checking && s.latest && s; });
    assert.equal(status.version, target); assert.equal(status.updateAvailable, false);
    const projects = await page.evaluate(() => window.workbench.call('aiui_projects_list'));
    assert.equal(projects.projects.find(p => p.id === project.id)?.agentPath, project.agentPath); assert.equal(await hash(path.join(project.agentPath, 'pages/index/index.ink')), originalHash);
    report.newVersion = status.version; report.projectPreserved = true; await page.screenshot({ path: path.join(output, 'updated-client.png') });
  });
  await check('the upgraded installation exports a working MCP launcher without external Node', async () => {
    const config = (await page.evaluate(() => window.workbench.call('aiui_mcp_config'))).mcpServers['aiui-workbench'];
    mcp = new Client({ name: 'github-upgrade-test', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ ...config, env: { ...portableEnvironment(home), ...config.env } }), { timeout: 15000 });
    assert.equal(mcp.getServerVersion().version, target);
    report.mcpToolCount = (await mcp.listTools()).tools.length; assert.ok(report.mcpToolCount >= 30);
    await mcp.close(); mcp = null;
  });
  if (semver.gte(target, '0.3.2')) await check('the downloaded upgrade implements two-stage unbind and native Trash deletion', async () => {
    async function confirmation(deleting) {
      await page.getByRole('button', { name: 'Project actions Upgrade Example', exact: true }).click(); await page.getByRole('menuitem', { name: deleting ? 'Delete project and files…' : 'Unbind project', exact: true }).click();
      const modal = page.getByRole('dialog'); assert.equal(await modal.getByRole('textbox').count(), 0); await modal.getByRole('button', { name: 'Continue to confirmation' }).click();
      const submit = modal.getByRole('button', { name: deleting ? 'Confirm deleting project and files' : 'Confirm unbinding project', exact: true }); assert.equal(await submit.isDisabled(), true);
      await modal.getByRole('textbox').fill('wrong'); await modal.getByRole('checkbox').check(); assert.equal(await submit.isDisabled(), true);
      await modal.getByRole('textbox').fill('Upgrade Example'); await submit.click(); await modal.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: 'Upgrade Example', exact: true }).waitFor({ state: 'hidden' });
    }
    await confirmation(false); assert.equal(await hash(path.join(directory, 'pages/index/index.ink')), originalHash);
    await page.evaluate(directory => window.workbench.call('aiui_project_import', { directory }), directory); await page.getByRole('heading', { name: 'Upgrade Example', exact: true }).waitFor();
    await confirmation(true); await assert.rejects(fs.access(directory), { code: 'ENOENT' }); report.upgradedRemovalVerified = true;
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; console.error(error); if (page) { report.pageURL = page.url(); report.pageText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => null); await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {}); } await atomicJson(path.join(output, 'verification.json'), report); }
finally {
  try { await bounded(stop(), 30000); } catch (error) { report.cleanupError = error.message; report.passed = false; }
  await manager?.close(); await atomicJson(path.join(output, 'verification.json'), report);
  process.exit(report.passed ? 0 : 1);
}
