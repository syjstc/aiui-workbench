import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../core/service.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-removal-')), directory = path.join(root, 'project'), home = path.join(root, 'home');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'app.json'), JSON.stringify({ name: 'Public example', version: '0.1.0', pages: ['index'] }));
  await fs.writeFile(path.join(directory, 'index.ink'), '<page><text>Public example</text></page>');
  const w = await new Workbench(home).init();
  t.after(async () => { await w.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  const project = await w.projects.import(directory);
  const args = operation => ({ projectId: project.id, operation, confirmationName: project.name, confirmationPath: project.projectPath, expectedRevision: project.revision, acknowledged: true });
  return { root, directory, home, w, project, args };
}

test('unbind preserves all source bytes, removes previews and watchers, and persists across restart', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.directory, 'index.ink'));
  f.w.origin = 'http://127.0.0.1:12345'; f.w.previews.open(f.project.id, f.w.origin);
  const intent = await f.w.call('ui_project_removal_begin', f.args('detach'));
  assert.equal(f.w.projects.watchers.has(f.project.id), false);
  const result = await f.w.call('ui_project_removal_commit', { intentId: intent.id });
  assert.equal(result.filesDeleted, false); assert.deepEqual(f.w.projects.list(), []); assert.deepEqual(f.w.previews.list(), []);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'index.ink')), before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home, 'projects.json'))), []);
  const reimported = await f.w.projects.import(f.directory); assert.notEqual(reimported.id, f.project.id);
});

test('confirmation requires an exact name, path, revision and explicit acknowledgment', async t => {
  const f = await fixture(t);
  for (const change of [{ confirmationName: 'wrong' }, { confirmationPath: f.root }, { expectedRevision: 'stale' }, { acknowledged: false }]) await assert.rejects(f.w.projectRemoval.begin({ ...f.args('detach'), ...change }));
  assert.equal(f.w.projects.list().length, 1); assert.ok(f.w.projects.watchers.has(f.project.id)); await fs.access(f.directory);
});

test('deletion cannot claim success before the whole folder reaches Trash; cancel restores watching', async t => {
  const f = await fixture(t), intent = await f.w.projectRemoval.begin(f.args('delete'));
  await assert.rejects(f.w.projectRemoval.commit(intent.id), /尚未移到/);
  await f.w.projectRemoval.cancel(intent.id); assert.ok(f.w.projects.watchers.has(f.project.id));
  const again = await f.w.projectRemoval.begin(f.args('delete'));
  const trash = path.join(f.root, 'test-trash'); await fs.rename(f.directory, trash);
  const result = await f.w.projectRemoval.commit(again.id);
  assert.equal(result.destination, 'system-trash'); assert.deepEqual(f.w.projects.list(), []); await fs.access(path.join(trash, 'index.ink'));
});

test('removal locks the selected project, leaves other projects alone, and rejects active tasks', async t => {
  const f = await fixture(t), intent = await f.w.projectRemoval.begin(f.args('detach'));
  await assert.rejects(f.w.call('aiui_project_check', { projectId: f.project.id }), /正在移除/);
  await assert.rejects(f.w.projectRemoval.begin(f.args('detach')), /正在移除/);
  await f.w.projectRemoval.cancel(intent.id);
  const job = f.w.jobs.start('test', f.project.id, ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })));
  await assert.rejects(f.w.projectRemoval.begin(f.args('detach')), /任务运行/); f.w.jobs.cancel(job.id);
});

test('delete refuses folders containing runtime data or another registered project', async t => {
  const f = await fixture(t);
  const child = path.join(f.directory, 'child'); await fs.mkdir(child);
  await fs.writeFile(path.join(child, 'app.json'), JSON.stringify({ name: 'Child', pages: ['index'] })); await fs.writeFile(path.join(child, 'index.ink'), '<page/>');
  await f.w.projects.import(child);
  await assert.rejects(f.w.projectRemoval.begin(f.args('delete')), /其他已绑定/);
  f.project.projectPath = await fs.realpath(f.root);
  await assert.rejects(f.w.projectRemoval.begin(f.args('delete')), /运行数据/);
});

test('parallel removals cannot acquire two intents, and an expired confirmation leaves files intact', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.w.projectRemoval.begin(f.args('delete')), f.w.projectRemoval.begin(f.args('delete'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const intent = results.find(result => result.status === 'fulfilled').value;
  f.w.projectRemoval.intents.get(intent.id).expiresAt = 0;
  await assert.rejects(f.w.projectRemoval.commit(intent.id), /确认已失效/);
  await fs.access(f.directory); assert.ok(f.w.projects.watchers.has(f.project.id)); assert.equal(f.w.projects.list().length, 1);
});
