import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeviceDiscovery, parseDevices, parseInspection } from '../core/devices.mjs';
import { AdbTools } from '../core/adb.mjs';
import { ROOT, run } from '../core/util.mjs';

const ready = 'Device: glasses-1\nDeveloper Mode: enabled\nWidget Runtime: ready\n';
const row = (status = 'device', transport = 1) => `glasses-1\t${status} product:glasses model:RG_glasses transport_id:${transport}\n`;

test('USB discovery handles empty, unauthorized, offline and multiple devices', () => {
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  const devices = parseDevices(`List of devices attached\n${row('unauthorized')}glasses-2 offline\nglasses-3 device model:Rokid_Glasses\n`);
  assert.deepEqual(devices.map(d => d.status), ['unauthorized', 'offline', 'device']);
  assert.equal(devices[0].name, 'RG glasses');
  assert.equal(devices[0].transport, '1');
});

test('unknown or not-ready CLI output cannot be mistaken for a ready device', () => {
  assert.equal(parseInspection(ready).runtimeReady, true);
  assert.equal(parseInspection('Developer Mode: disabled\nWidget Runtime: not ready').runtimeReady, false);
  assert.equal(parseInspection('unrecognized output').developerMode, 'unknown');
});

test('polling observes disconnect/reconnect and authorization without stale ready state', async () => {
  let listing = row(), clock = 0, inspections = 0, toolChecks = 0;
  const cli = async args => { if (args[0] === '--help') { toolChecks++; return { code: 0, output: 'help' }; } inspections++; return { code: 0, output: ready }; };
  const discovery = new DeviceDiscovery(cli, async () => ({ code: 0, output: listing }), () => clock);
  assert.equal((await discovery.check()).devices[0].inspection.developerMode, 'enabled');
  clock += 3000;
  await discovery.check();
  assert.equal(inspections, 1, 'ready devices use a short inspection cache');
  listing = '';
  assert.equal((await discovery.check()).devices.length, 0);
  listing = row('unauthorized');
  assert.equal((await discovery.check()).devices[0].inspection, undefined);
  assert.equal(inspections, 1, 'unauthorized devices are never inspected');
  listing = row('device', 2);
  assert.equal((await discovery.check()).devices[0].inspection.runtimeReady, true);
  assert.equal(inspections, 2, 'reconnection clears the previous inspection');
  listing = row('offline', 2);
  assert.equal((await discovery.check()).devices[0].inspection, undefined);
  assert.equal(toolChecks, 1, 'tool availability is not respawned on every poll');
});

test('overlapping checks coalesce, failed ADB output is not treated as connected', async () => {
  let release, adbCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const discovery = new DeviceDiscovery(async () => ({ code: 0, output: 'help' }), async () => { adbCalls++; await gate; return { code: 1, output: row() }; });
  const first = discovery.check(), second = discovery.check();
  assert.equal(first, second);
  release();
  const result = await first;
  assert.equal(adbCalls, 1);
  assert.equal(result.adb, false);
  assert.deepEqual(result.devices, []);
});

test('non-ready devices are retried and a transport change invalidates a ready cache', async () => {
  let clock = 0, output = 'Developer Mode: disabled\nWidget Runtime: not ready', listing = row(), checks = 0;
  const discovery = new DeviceDiscovery(async args => { if (args[0] === '--help') return { code: 0, output: '' }; checks++; return { code: 0, output }; }, async () => ({ code: 0, output: listing }), () => clock);
  assert.equal((await discovery.check()).devices[0].inspection.developerMode, 'disabled');
  clock = 3001; output = ready;
  assert.equal((await discovery.check()).devices[0].inspection.runtimeReady, true);
  listing = row('device', 2);
  await discovery.check();
  assert.equal(checks, 3);
});

test('failed environment reads recover automatically on the next check', async () => {
  let unavailable = true;
  const discovery = new DeviceDiscovery(async () => ({ code: 0, output: ready }), async () => { if (unavailable) throw new Error('spawn adb ENOENT'); return { code: 0, output: row() }; });
  assert.equal((await discovery.check()).adb, false);
  unavailable = false;
  const recovered = await discovery.check();
  assert.equal(recovered.adb, true);
  assert.equal(recovered.devices[0].inspection.runtimeReady, true);
});

test('selecting an ADB directory validates it and persists it across restarts', { skip: process.platform === 'win32' }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-adb-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const tools = path.join(home, 'tools with spaces'); await fs.mkdir(tools);
  const adb = new AdbTools(home);
  await assert.rejects(adb.configure(tools), /没有 adb/);
  await fs.writeFile(path.join(tools, 'adb'), '#!/bin/sh\nprintf "Android Debug Bridge version 1.0.41\\n"\n', { mode: 0o755 });
  await adb.configure(tools);
  const restored = new AdbTools(home);
  assert.equal(await restored.resolve(), await fs.realpath(path.join(tools, 'adb')));
  assert.ok((await restored.environment()).PATH.startsWith(await fs.realpath(tools) + path.delimiter));
  await fs.writeFile(path.join(tools, 'adb'), '#!/bin/sh\nprintf "not adb\\n"\n', { mode: 0o755 });
  await assert.rejects(adb.configure(tools), /无法运行/);
});

test('bundled ADB works with an empty PATH and no user SDK, including CLI subprocesses', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-clean-adb-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const adb = new AdbTools(home, { env: { PATH: '' }, userHome: home });
  const info = await adb.resolveInfo();
  assert.equal(info.source, 'bundled');
  assert.equal(info.version, '37.0.1');
  assert.ok(info.path.startsWith(path.join(ROOT, 'vendor/adb', process.platform)));
  const result = await adb.execute(['version']);
  assert.equal(result.code, 0);
  assert.match(result.output, /Android Debug Bridge version/);
  assert.match(result.output, /37\.0\.1/);
  const child = await run(process.execPath, ['--input-type=module', '-e', "import {spawnSync} from 'node:child_process';const r=spawnSync('adb',['version'],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.exit(r.status??1)"], { env: await adb.environment() });
  assert.equal(child.code, 0, child.output);
  assert.match(child.output, /37\.0\.1/);
});

test('a removed custom ADB falls back to the bundled copy', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-adb-fallback-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'connection-tools.json'), JSON.stringify({ adbPath: path.join(home, 'removed', 'adb') }));
  const info = await new AdbTools(home, { env: { PATH: '' }, userHome: home }).resolveInfo();
  assert.equal(info.source, 'bundled');
});

test('bundled ADB is never selected for an unsupported architecture', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-adb-arch-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const info = await new AdbTools(home, { platform: 'linux', arch: 'arm64', env: { PATH: '' }, userHome: home }).resolveInfo();
  assert.equal(info.source, 'missing');
});
