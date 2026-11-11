import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from '../core/jobs.mjs';
import { Workbench } from '../core/service.mjs';
import { startDaemon } from '../core/daemon.mjs';
import { atomicJson } from '../core/util.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-log-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await atomicJson(path.join(project, 'app.json'), { name: 'Log fixture', version: '1.0.0', pages: ['index'], permissions: [] });
  await fs.writeFile(path.join(project, 'index.ink'), '<page><text>Logs</text></page>');
  return { root, project, home: path.join(root, 'home') };
}

test('task deletion is scoped, durable, and preserves a running task and its progress', async t => {
  const { home } = await fixture(t), jobs = await new Jobs(() => {}, home).init();
  t.after(() => jobs.close());
  const finished = [];
  for (const type of ['check', 'pack', 'deploy', 'launch', 'sdk-prepare', 'knowledge', 'platform-prepare', 'device-setup']) {
    const job = jobs.start(type, 'project', async ({ progress }) => { progress(type + ' output'); if (type === 'check') throw new Error('diagnostic'); return type; });
    await jobs.items.find(item => item.id === job.id).promise;
    finished.push(job.id);
  }
  let complete, progress;
  const running = jobs.start('pack', 'project', context => { progress = context.progress; return new Promise(resolve => { complete = resolve; }); });
  t.after(() => complete());
  const activePromise = jobs.items.find(item => item.id === running.id).promise;
  const result = await jobs.delete([finished[0], finished[0], running.id]);
  assert.deepEqual(result, { deletedIds: [finished[0]], skippedRunningIds: [running.id] });
  assert.throws(() => jobs.get(finished[0]), /不存在/);
  assert.equal(jobs.list().length, 8);
  progress('still running');
  assert.equal(jobs.get(running.id).logs.at(-1).message, 'still running');
  const restored = await new Jobs(() => {}, home).init();
  assert.throws(() => restored.get(finished[0]), /不存在/);
  assert.equal(restored.get(running.id).status, 'interrupted');
  assert.equal(restored.get(finished[1]).status, 'succeeded');
  await jobs.delete(finished.slice(1));
  complete('build kept'); await activePromise;
  assert.equal(jobs.get(running.id).status, 'succeeded');
  await jobs.delete([running.id]);
  assert.deepEqual((await new Jobs(() => {}, home).init()).list(), []);
  assert.deepEqual(await jobs.delete([running.id]), { deletedIds: [], skippedRunningIds: [] });
});

test('task deletion requires an explicit bounded selection', async () => {
  const jobs = new Jobs(() => {});
  for (const selection of [undefined, [], 'all', [null], [''], Array(61).fill('id')]) await assert.rejects(jobs.delete(selection), /明确选择/);
});

test('deleted task output is also removed from retained service events', async t => {
  const { home } = await fixture(t), service = await new Workbench(home).init();
  t.after(() => service.close());
  const job = service.jobs.start('knowledge', null, async ({ progress }) => progress('old task output'));
  await service.jobs.items[0].promise;
  assert.ok(service.events.some(event => event.type === 'job' && event.value.id === job.id));
  await service.call('aiui_jobs_delete', { jobIds: [job.id] }, 'MCP');
  assert.ok(!service.status().jobs.some(item => item.id === job.id));
  assert.ok(!service.events.some(event => event.type === 'job' && event.value.id === job.id));
});

test('preview clearing drops buffered old logs, keeps other sessions, and accepts new SDK logs', async t => {
  const { home, project } = await fixture(t), daemon = await startDaemon(home);
  t.after(() => daemon.close());
  const { service } = daemon, imported = await service.projects.import(project);
  const first = service.previews.open(imported.id, service.origin), second = service.previews.open(imported.id, service.origin, { target: '_current' });
  const session = service.previews.get(first.id);
  const postLogs = async entries => {
    const response = await fetch(`${service.origin}/session/${first.id}/log`, { method: 'POST', headers: { 'X-Preview-Key': session.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
    assert.equal(response.status, 200);
  };
  const createdBeforeClear = performance.timeOrigin + performance.now();
  await postLogs([{ level: 'info', message: 'old app log', logGeneration: first.logGeneration, createdAt: createdBeforeClear }]);
  service.previews.log(service.previews.get(second.id), 'info', 'other session');
  const result = await service.call('aiui_preview_logs_clear', { sessionId: first.id }, 'MCP');
  assert.equal(result.deletedCount, 1);
  assert.notEqual(result.logGeneration, first.logGeneration);
  assert.ok(!service.events.some(event => event.type === 'preview-log' && event.value.sessionId === first.id));
  await postLogs([{ level: 'info', message: 'late old batch', logGeneration: first.logGeneration, createdAt: createdBeforeClear }]);
  assert.deepEqual((await service.call('aiui_preview_logs', { sessionId: first.id })).logs, []);
  assert.equal((await service.call('aiui_preview_logs', { sessionId: second.id })).logs[0].message, 'other session');
  await postLogs([{ level: 'info', message: 'new log before generation refresh', logGeneration: first.logGeneration, createdAt: performance.timeOrigin + performance.now() }]);
  assert.equal((await service.call('aiui_preview_logs', { sessionId: first.id })).logs[0].message, 'new log before generation refresh');
  const poll = await fetch(`${service.origin}/session/${first.id}/poll`, { headers: { 'X-Preview-Key': session.key } }).then(response => response.json());
  assert.equal(poll.logGeneration, result.logGeneration);
  await postLogs([{ level: 'info', message: 'new SDK call', logGeneration: poll.logGeneration }]);
  assert.equal((await service.call('aiui_preview_logs', { sessionId: first.id })).logs.at(-1).message, 'new SDK call');
  assert.equal(service.previews.public(session).logCount, 2);
  await assert.rejects(service.call('aiui_preview_logs_clear', { sessionId: 'missing' }), /不存在/);
});

test('service log clearing keeps the active append handle and project records intact', async t => {
  const { home, project } = await fixture(t), service = await new Workbench(home).init();
  t.after(() => service.close());
  const imported = await service.projects.import(project), file = path.join(home, 'service.log');
  const handle = await fs.open(file, 'a');
  t.after(() => handle.close());
  await handle.writeFile('old service log\n');
  const before = await handle.stat();
  assert.equal((await service.call('aiui_service_log_status')).bytes, before.size);
  const cleared = await service.call('aiui_service_log_clear');
  assert.equal(cleared.clearedBytes, before.size);
  assert.equal(cleared.bytes, 0);
  assert.equal((await fs.stat(file)).ino, before.ino);
  await handle.writeFile('new service log\n');
  assert.equal(await fs.readFile(file, 'utf8'), 'new service log\n');
  assert.equal(service.projects.get(imported.id).name, 'Log fixture');
  assert.ok((await fs.readFile(path.join(project, 'index.ink'), 'utf8')).includes('Logs'));
});
