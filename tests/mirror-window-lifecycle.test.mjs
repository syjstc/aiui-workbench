import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createMirrorWindowLifecycle } = createRequire(import.meta.url)('../electron/mirror-window-lifecycle.cjs');

function viewer(sessionId) {
  return { sessionId, window: { closed: 0, isDestroyed() { return this.closed > 0; }, close() { this.closed++; } } };
}
function fixture(t, getSession) {
  const windows = new Map(), lifecycle = createMirrorWindowLifecycle({ windows, getSession });
  t.after(() => lifecycle.dispose()); return { windows, lifecycle };
}
test('ending a session closes its extra window and leaves other glasses alone', t => {
  const { windows, lifecycle } = fixture(t, async () => null), ended = viewer('ended'), other = viewer('other');
  windows.set('glasses-1', ended); windows.set('glasses-2', other); lifecycle.changed();
  assert.equal(lifecycle.close('glasses-1', 'ended'), true);
  assert.equal(ended.window.closed, 1); assert.equal(windows.has('glasses-1'), false);
  assert.equal(other.window.closed, 0); assert.equal(windows.get('glasses-2'), other);
  assert.equal(lifecycle.close('glasses-1', 'ended'), false);
  const reopened = viewer('reopened'); windows.set('glasses-1', reopened);
  assert.equal(lifecycle.close('glasses-1', 'ended'), false); assert.equal(reopened.window.closed, 0);
});
test('externally stopped, failed, missing and replaced sessions close their viewers', async t => {
  const sessions = new Map([
    ['stopped', { id: 'stopped', status: 'stopped' }],
    ['failed', { id: 'failed', status: 'failed' }],
    ['missing', null], ['replaced', { id: 'new-session', status: 'running' }],
    ['running', { id: 'running', status: 'running' }],
  ]);
  const { windows, lifecycle } = fixture(t, async serial => sessions.get(serial));
  const entries = new Map([...sessions.keys()].map(serial => [serial, viewer(serial)]));
  for (const [serial, entry] of entries) windows.set(serial, entry);
  lifecycle.changed(); await lifecycle.sync();
  for (const [serial, entry] of entries) assert.equal(entry.window.closed, serial === 'running' ? 0 : 1, serial);
  assert.deepEqual([...windows.keys()], ['running']);
});
test('a transient status error and a late old status response preserve the current viewer', async t => {
  let resolveStatus, calls = 0, reject = false;
  const { windows, lifecycle } = fixture(t, async () => { calls++; if (reject) throw new Error('Temporary service error'); return new Promise(resolve => { resolveStatus = resolve; }); });
  const old = viewer('old'); windows.set('glasses', old); lifecycle.changed();
  const checking = lifecycle.sync(); await lifecycle.sync(); assert.equal(calls, 1);
  const current = viewer('current'); windows.set('glasses', current);
  resolveStatus({ id: 'old', status: 'stopped' }); await checking;
  assert.equal(current.window.closed, 0); assert.equal(windows.get('glasses'), current);
  const rechecking = lifecycle.sync(); current.sessionId = 'reloaded';
  resolveStatus({ id: 'current', status: 'stopped' }); await rechecking;
  assert.equal(current.window.closed, 0, 'a reloaded viewer ignores its previous session status');
  reject = true; await lifecycle.sync(); assert.equal(current.window.closed, 0);
  lifecycle.dispose(); await lifecycle.sync(); assert.equal(calls, 3);
});
