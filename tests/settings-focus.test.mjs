import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { SettingsFocus } from '../core/settings-focus.mjs';

test('interactive owners share one Settings session and a restart waits for the old connection', async () => {
  const focus = new SettingsFocus({});
  const sessions = [];
  focus.run = async (serial, session) => {
    sessions.push(session);
    await new Promise(resolve => { session.finish = resolve; });
  };
  const glasses = { name: 'RG glasses', serial: 'RG', status: 'device' };
  focus.acquire({ ...glasses, status: 'unauthorized' });
  focus.acquire({ ...glasses, name: 'Android phone' });
  assert.equal(focus.sessions.size, 0);
  const first = focus.acquire(glasses), second = focus.acquire(glasses);
  await setImmediate();
  assert.equal(sessions.length, 1);
  first(); first();
  assert.equal(sessions[0].abort.signal.aborted, false);
  second();
  assert.ok(sessions[0].abort.signal.aborted);
  const next = focus.acquire(glasses);
  await setImmediate();
  assert.equal(sessions.length, 1);
  sessions[0].finish();
  await setImmediate();
  assert.equal(sessions.length, 2);
  next(); sessions[1].finish();
  await focus.close();
  assert.equal(focus.sessions.size, 0);
});
