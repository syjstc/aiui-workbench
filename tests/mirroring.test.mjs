import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Mirroring } from '../core/mirroring.mjs';
import { ROOT, run, readJson, sha } from '../core/util.mjs';

async function fixture(t, onSpawn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'vendor/scrcpy/darwin-arm64'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, 'vendor/scrcpy/manifest.json'), JSON.stringify({ version: '5.0.1', platforms: { 'darwin-arm64': { sha256: 'test-only' } } }));
  await fs.writeFile(path.join(directory, 'bundle.json'), JSON.stringify({ version: '5.0.1', sha256: 'test-only' }));
  await fs.mkdir(path.join(directory, 'AIUI Mirror.app/Contents/MacOS'), { recursive: true }); await fs.mkdir(path.join(directory, 'AIUI Mirror.app/Contents/Resources'), { recursive: true });
  await fs.writeFile(path.join(directory, 'AIUI Mirror.app/Contents/MacOS/scrcpy'), '', { mode: 0o755 }); await fs.writeFile(path.join(directory, 'AIUI Mirror.app/Contents/Resources/scrcpy-server'), '');
  await fs.mkdir(path.join(root, 'vendor/adb/darwin'), { recursive: true }); await fs.writeFile(path.join(root, 'vendor/adb/darwin/adb'), '', { mode: 0o755 });
  const children = [], calls = [], manager = new Mirroring({}, { ready: async serial => { if (serial !== 'glasses-1') throw new Error('not authorized'); } }, () => {}, {
    root, platform: 'darwin', arch: 'arm64', env: { PATH: '', ADB: '/evil/adb', SCRCPY_SERVER_PATH: '/evil/server' },
    spawnProcess: (binary, args, options) => {
      const child = new EventEmitter(); child.pid = 1234; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', 0)); };
      calls.push({ binary, args, options }); children.push(child);
      setTimeout(() => onSpawn ? onSpawn(child) : child.stdout.write('INFO: Texture (VideoToolbox): 480x640\n'), 5);
      return child;
    },
  });
  t.after(() => manager.close()); return { root, directory, manager, calls, children };
}
test('mirroring uses only bundled executables and overrides inherited external tool paths', async t => {
  const { manager, calls, root } = await fixture(t);
  const session = await manager.start({ serial: 'glasses-1' });
  assert.equal(session.status, 'running'); assert.equal(session.readOnly, false);
  const call = calls[0];
  assert.equal(call.binary, path.join(root, 'vendor/scrcpy/darwin-arm64/AIUI Mirror.app/Contents/MacOS/scrcpy'));
  assert.equal(call.options.env.PATH, ''); assert.equal(call.options.env.ADB, path.join(root, 'vendor/adb/darwin/adb'));
  assert.equal(call.options.env.SCRCPY_SERVER_PATH, path.join(root, 'vendor/scrcpy/darwin-arm64/AIUI Mirror.app/Contents/Resources/scrcpy-server'));
  assert.equal(call.options.env.NSUnbufferedIO, 'YES');
  assert.ok(call.args.includes('--mouse=sdk')); assert.ok(call.args.includes('--no-key-repeat')); assert.ok(call.args.includes('--no-audio')); assert.ok(call.args.includes('--no-clipboard-autosync'));
  assert.equal(call.options.shell, false);
});
test('overlapping starts coalesce into one window; stopping and reopening tracks actual process exit', async t => {
  const { manager, calls, children } = await fixture(t);
  const first = manager.start({ serial: 'glasses-1' }), second = manager.start({ serial: 'glasses-1' });
  assert.equal(first, second); await first; assert.equal(calls.length, 1);
  await manager.start({ serial: 'glasses-1' }); assert.equal(calls.length, 1);
  const stopped = await manager.stop({ serial: 'glasses-1' }); assert.equal(stopped.status, 'stopped'); assert.equal(children[0].killed, 'SIGTERM');
  await manager.start({ serial: 'glasses-1', readOnly: true, rotation: 90, maxFps: 60 });
  assert.equal(calls.length, 2); assert.ok(calls[1].args.includes('--no-control')); assert.ok(!calls[1].args.includes('--mouse=sdk')); assert.ok(calls[1].args.includes('--display-orientation=90'));
  assert.ok(!calls[1].args.includes('--no-key-repeat'));
});
test('missing bundled components never fall back to Homebrew, PATH or a system installation', async t => {
  const { manager, directory, calls } = await fixture(t);
  await fs.unlink(path.join(directory, 'AIUI Mirror.app/Contents/Resources/scrcpy-server'));
  const status = await manager.status({ serial: 'glasses-1' }); assert.equal(status.available, false);
  await assert.rejects(manager.start({ serial: 'glasses-1' }), /内置投屏/); assert.equal(calls.length, 0);
});
test('unauthorized devices and unsupported options cannot launch a process; startup errors stay visible', async t => {
  const { manager, calls } = await fixture(t, child => { child.stderr.write('ERROR: Cannot connect to device\n'); child.emit('close', 1); });
  await assert.rejects(manager.start({ serial: 'other' }), /not authorized/);
  await assert.rejects(manager.start({ serial: 'glasses-1', maxFps: 240 }), /选项无效/);
  assert.equal(calls.length, 0);
  await assert.rejects(manager.start({ serial: 'glasses-1' }), /Cannot connect/);
  assert.equal((await manager.status({ serial: 'glasses-1' })).session.status, 'failed');
});
test('bundled static releases match their recorded files and run with an empty system PATH', async () => {
  const directory = path.join(ROOT, 'vendor/scrcpy', `${process.platform}-${process.arch}`);
  const receipt = await readJson(path.join(directory, 'bundle.json'));
  for (const [name, digest] of Object.entries(receipt.files)) assert.equal(sha(await fs.readFile(path.join(directory, name))), digest, name);
  const result = await run((await new Mirroring({}, {}).bundled()).binary, ['--version'], { env: { PATH: '' } });
  assert.equal(result.code, 0); assert.match(result.output, /scrcpy 5\.0\.1/);
});
