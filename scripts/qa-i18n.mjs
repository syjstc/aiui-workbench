import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { ROOT, atomicJson, sleep } from '../core/util.mjs';

const output = path.join(ROOT, 'output/qa/i18n');
const home = path.join(ROOT, '.local/i18n-qa', String(Date.now()));
await fs.mkdir(output, { recursive: true });
const daemon = await startDaemon(home);
// No real USB actions are needed to review language and layout.
daemon.service.devices.check = async () => ({ adb: true, aix: true, node: process.version, adbTool: { source: 'bundled', version: '37.0.1' }, devices: [] });
const report = { home, platform: process.platform, checks: [], errors: [], deviceActionsPerformed: false };
let app, page, project;
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
async function until(work, timeout = 20000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await work()) return; await sleep(100); } throw new Error('Timed out'); }
async function englishOnly() {
  const text = await page.evaluate(() => {
    const copy = document.querySelector('.app-shell').cloneNode(true);
    for (const node of copy.querySelectorAll('.language-switcher,.doc-list,.doc-prose,.console-entries,.job-output,.project-path')) node.remove();
    return copy.textContent;
  });
  const remaining = text.replaceAll(project?.name || '\0', '').match(/[^\n]{0,30}[\u3400-\u9fff][^\n]{0,80}/g);
  assert.equal(remaining, null, 'Untranslated UI: ' + JSON.stringify(remaining));
}
try {
  app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await check('a permanent bilingual language switch is visible and switches immediately', async () => {
    await page.getByRole('group', { name: 'Language / 语言' }).waitFor();
    await page.getByRole('button', { name: '切换到中文', exact: true }).click();
    await page.getByRole('heading', { name: '项目库', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await englishOnly(); await page.screenshot({ path: path.join(output, 'english-projects.png') });
  });
  await check('all main pages and every onboarding step are translated', async () => {
    for (const name of ['Simulator', 'Official docs', 'Connect glasses', 'Build & upload', 'Connect AI tools', 'SDK updates', 'Logs & history', 'Settings', 'Getting started']) {
      await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
      await page.locator('main h1').waitFor(); await sleep(350);
      await englishOnly();
      assert.ok(await page.getByRole('group', { name: 'Language / 语言' }).isVisible());
    }
    for (let i = 0; i < 4; i++) {
      await page.locator('.setup-steps button').nth(i).click(); await englishOnly();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1080, 740));
    await page.screenshot({ path: path.join(output, 'english-guide-compact.png') });
    const language = await page.locator('.language-switcher').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(language.x >= 0 && language.x + language.width <= viewport.width && language.y < 80);
  });
  await check('project names remain unchanged and simulator controls are translated', async () => {
    project = await daemon.service.call('aiui_project_create', { directory: path.join(home, 'Project 中文 & spaces'), name: '用户项目 User project' });
    const preview = await daemon.service.call('aiui_preview_open', { projectId: project.id }, 'MCP');
    await page.getByText('Preview running', { exact: true }).waitFor({ timeout: 30000 });
    for (const name of ['Orientation', 'Motion', 'Input', 'Camera']) {
      await page.locator('.control-tabs').getByRole('button', { name, exact: true }).click(); await englishOnly();
    }
    await page.getByRole('button', { name: 'Save screenshot', exact: true }).click();
    await page.getByRole('heading', { name: 'Current preview saved', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open file location', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'english-capture.png') });
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: '切换到中文', exact: true }).click();
    await page.getByText('预览运行中', { exact: true }).waitFor();
    assert.equal((await daemon.service.call('aiui_preview_state', { sessionId: preview.id })).projectId, project.id);
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  });
  await check('the selected language survives a reload', async () => {
    await page.reload(); await page.getByRole('group', { name: 'Language / 语言' }).waitFor();
    await until(async () => await page.locator('html').getAttribute('lang') === 'en');
    assert.equal(await page.getByRole('button', { name: 'Switch to English', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.locator('.language-switcher').screenshot({ path: path.join(output, 'language-switcher.png') });
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally { await app?.close(); await daemon.close(); await atomicJson(path.join(output, 'verification.json'), report); }
