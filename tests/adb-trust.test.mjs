import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deviceAdbTrust } from '../core/adb-trust.mjs';

test('the bundled helper calls the named device API and cleans its uniquely named file', async () => {
  const calls = [];
  const adb = { execute: async args => {
    calls.push(args);
    return { code: 0, output: args.includes('app_process') ? 'AIUI_ADB_TRUST={"supported":true,"revoked":true,"remainingCount":0}\n' : '' };
  } };
  assert.equal((await deviceAdbTrust(adb, 'GLASSES123', { revoke: true })).revoked, true);
  assert.deepEqual(calls[0].slice(0, 3), ['-s', 'GLASSES123', 'push']);
  assert.match(calls[0][4], /^\/data\/local\/tmp\/aiui-adb-trust-[a-f0-9-]+\.jar$/);
  assert.ok(calls[1].includes('com.aiui.workbench.AdbTrust') && calls[1].includes('revoke'));
  assert.ok(!calls.flat().includes('service'), 'never hard-code Binder transaction numbers');
  assert.deepEqual(calls.at(-1).slice(0, 5), ['-s', 'GLASSES123', 'shell', 'rm', '-f']);
});

test('unsupported APIs and nonempty remaining keys cannot claim authorization was revoked', async () => {
  for (const receipt of [{ supported: false, revoked: false }, { supported: true, revoked: true, remainingCount: 2 }]) {
    const adb = { execute: async args => ({ code: 0, output: args.includes('app_process') ? 'AIUI_ADB_TRUST=' + JSON.stringify(receipt) : '' }) };
    assert.equal((await deviceAdbTrust(adb, 'GLASSES123', { revoke: true })).revoked, false);
  }
});

test('closed ADB sync can revoke through the authenticated shell after verifying the transferred jar', async () => {
  let script;
  const adb = { execute: async (args, options) => {
    if (args.includes('push')) return { code: 1, output: 'adb: error: connect failed: closed' };
    if (args.includes('sh')) {
      script = options.input;
      return { code: 0, output: 'AIUI_ADB_TRUST={"supported":true,"revoked":true,"pairedCount":1,"remainingCount":0}' };
    }
    return { code: 0, output: '' };
  } };
  const result = await deviceAdbTrust(adb, 'QA', { revoke: true });
  assert.equal(result.revoked, true);
  assert.match(script, /base64 -d/); assert.match(script, /sha256sum/);
  assert.ok(script.indexOf('sha256sum') < script.indexOf('app_process'));
});

test('a corrupt helper is rejected before any device operation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-trust-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'assets/android-debug'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets/android-debug/adb-trust.jar'), 'bad jar');
  await fs.writeFile(path.join(root, 'assets/android-debug/manifest.json'), JSON.stringify({ bytes: 7, sha256: 'incorrect' }));
  let calls = 0;
  await assert.rejects(deviceAdbTrust({ root, execute: async () => { calls++; } }, 'GLASSES123', { revoke: true }), /不完整/);
  assert.equal(calls, 0);
});
