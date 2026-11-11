import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop } from './desktop-test.mjs';
import { startDaemon } from '../core/daemon.mjs';
import { ROOT, atomicJson, sha, sleep } from '../core/util.mjs';

const home = await fs.mkdtemp('/tmp/aiui-project-removal-'), output = path.join(ROOT, 'output/qa/project-removal');
await fs.mkdir(output, { recursive: true });
const report = { checks: [], publicExamplesOnly: true, actualSystemTrash: true, errors: [] };
let app, daemon;
try {
  daemon = await startDaemon(home);
  daemon.service.sdk.check = async () => daemon.service.sdk.status(); daemon.service.knowledge.sync = async () => daemon.service.knowledge.status();
  const projects = [];
  for (const name of ['Unbind Example', 'Delete Example']) {
    const directory = path.join(home, name); await fs.cp(path.join(ROOT, 'examples/hello-aiui'), directory, { recursive: true });
    const file = path.join(directory, 'app.json'), config = JSON.parse(await fs.readFile(file)); config.name = config.agentName = name; await atomicJson(file, config);
    projects.push(await daemon.service.call('aiui_project_import', { directory }));
  }
  const [unbind, deleting] = projects, original = sha(await fs.readFile(path.join(unbind.agentPath, 'pages/index/index.ink')));
  app = await launchDesktop({ args: [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.getByRole('heading', { name: unbind.name, exact: true }).waitFor({ timeout: 45000 });
  async function dialog(project, deletion = false) {
    await page.getByRole('button', { name: '项目操作 ' + project.name, exact: true }).click();
    await page.getByRole('menuitem', { name: deletion ? '删除项目和文件…' : '解绑项目', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '确认项目操作' }); await modal.waitFor(); return modal;
  }
  let modal = await dialog(unbind);
  assert.equal(await modal.getByRole('textbox').count(), 0); await fs.access(unbind.projectPath);
  await modal.getByRole('button', { name: '继续确认' }).click();
  const confirm = modal.getByRole('button', { name: '确认解绑项目', exact: true }); assert.equal(await confirm.isDisabled(), true);
  await modal.getByRole('textbox').fill('wrong'); await modal.getByRole('checkbox').check(); assert.equal(await confirm.isDisabled(), true);
  await modal.getByRole('textbox').fill(unbind.name); assert.equal(await confirm.isEnabled(), true);
  await page.screenshot({ path: path.join(output, 'unbind-confirmation.png') });
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await fs.access(unbind.projectPath); assert.equal(daemon.service.projects.list().length, 2); report.checks.push('cancel and wrong-name confirmation preserve source and registry');
  modal = await dialog(unbind); await modal.getByRole('button', { name: '继续确认' }).click(); await modal.getByRole('textbox').fill(unbind.name); await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: '确认解绑项目', exact: true }).click();
  await page.getByRole('heading', { name: unbind.name, exact: true }).waitFor({ state: 'hidden' });
  assert.equal(sha(await fs.readFile(path.join(unbind.agentPath, 'pages/index/index.ink'))), original);
  assert.equal(daemon.service.projects.watchers.has(unbind.id), false); report.checks.push('unbind removes registration and watcher while preserving source bytes');
  const imported = await daemon.service.call('aiui_project_import', { directory: unbind.projectPath });
  assert.notEqual(imported.id, unbind.id); await page.getByRole('heading', { name: unbind.name, exact: true }).waitFor(); report.checks.push('unbound source reimports normally');
  modal = await dialog(deleting, true); assert.ok((await modal.innerText()).includes(deleting.projectPath));
  await modal.getByRole('button', { name: '取消', exact: true }).click(); await fs.access(deleting.projectPath);
  modal = await dialog(deleting, true); await modal.getByRole('button', { name: '继续确认' }).click();
  const deleteConfirm = modal.getByRole('button', { name: '确认删除项目和文件', exact: true });
  await modal.getByRole('textbox').fill(deleting.name); assert.equal(await deleteConfirm.isDisabled(), true); await modal.getByRole('checkbox').check();
  await page.screenshot({ path: path.join(output, 'delete-confirmation.png') });
  await deleteConfirm.click(); await page.getByRole('heading', { name: deleting.name, exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
  await assert.rejects(fs.access(deleting.projectPath), { code: 'ENOENT' }); await fs.access(unbind.projectPath);
  assert.equal(daemon.service.projects.list().length, 1); report.checks.push('delete moves only the confirmed temporary example to native system Trash and removes its registration');
  await page.screenshot({ path: path.join(output, 'project-library.png') });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally { await app?.close(); await daemon?.close(); await atomicJson(path.join(output, 'verification.json'), report); }
