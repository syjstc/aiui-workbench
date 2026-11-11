import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GlassesTools, parseBattery, parseFileList, parsePackages, parseProperties, parseStorage, shellQuote } from '../core/glasses.mjs';
import { AdbTools } from '../core/adb.mjs';
import { Workbench } from '../core/service.mjs';
import { UI_TOOLS } from '../core/ui-tools.mjs';

const serial = 'glasses-1';
const response = (output = '', code = 0, stderr = '') => ({ stdout: Buffer.isBuffer(output) ? output : Buffer.from(output), code, stderr });
async function fixture(t, handler = () => response()) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'glasses-tools-test-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const calls = [], adb = { capture: async (args, options) => {
    calls.push(args); options?.signal?.throwIfAborted();
    return args[0] === 'devices' ? response(`List of devices attached\n${serial} device model:RG_glasses transport_id:1\n`) : handler(args, options);
  } };
  return { home, calls, adb, tools: new GlassesTools(home, adb) };
}
const command = args => args.at(-1);

test('device information parsers preserve units and never fabricate unavailable battery values', () => {
  assert.deepEqual(parseProperties('[ro.product.model]: [RG-glasses]\n[ro.build.version.release]: [12]\n'), { 'ro.product.model': 'RG-glasses', 'ro.build.version.release': '12' });
  assert.deepEqual(parseBattery('level: 50\nscale: 100\ntemperature: 235\nstatus: 2\nUSB powered: true'), { percent: 50, temperature: 23.5, charging: true, plugged: true, status: 2 });
  assert.equal(parseBattery('').percent, null); assert.equal(parseBattery('').temperature, null);
  const disk = parseStorage('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/fuse 2000 400 1600 20% /storage/emulated\n')[0];
  assert.equal(disk.total, 2048000); assert.equal(disk.available, 1638400); assert.equal(disk.percent, 20);
});
test('NUL-delimited listings preserve spaces, quotes, Unicode, newlines and symlink types', () => {
  const files = parseFileList("81b0|42|1700000000\n你好 ' $(touch nope).txt\0a1ff|10|1700000001\nlink\0" + '41ed|4096|1700000000\nfolder\0' + '81b0|3|1700000000\nline\nbreak\0', '/sdcard');
  assert.equal(files[0].type, 'directory');
  assert.equal(files.find(file => file.type === 'link').name, 'link');
  assert.ok(files.some(file => file.path === "/sdcard/你好 ' $(touch nope).txt"));
  assert.ok(files.some(file => file.name === 'line\nbreak'));
  assert.throws(() => parseFileList('bad\nfile\0', '/sdcard'), /列表格式/);
  assert.equal(shellQuote("a'b; $(id)"), "'a'\\''b; $(id)'");
});
test('package classification uses explicit third-party and disabled lists', () => {
  const packages = parsePackages('package:com.android.settings versionCode:32\npackage:local.test.app versionCode:42\n', 'package:local.test.app\n', 'package:local.test.app\n');
  assert.equal(packages[0].system, true); assert.equal(packages[1].system, false); assert.equal(packages[1].disabled, true); assert.equal(packages[1].versionCode, '42');
});
test('every device command requires a selected, authorized, still-connected serial', async t => {
  const { tools, calls, adb } = await fixture(t);
  await assert.rejects(tools.info({ serial: '' }), /明确/);
  await assert.rejects(tools.control({ serial: '-d', action: 'home' }), /明确/);
  for (const [status, message] of [['unauthorized', /允许 USB/], ['offline', /离线/], ['', /断开/]]) {
    adb.capture = async () => response(status ? `${serial} ${status}\n` : '');
    await assert.rejects(tools.control({ serial, action: 'home' }), message);
  }
  assert.equal(calls.length, 0);
});
test('partial information failure stays explicit while other device sections remain readable', async t => {
  const { tools } = await fixture(t, args => {
    if (command(args) === "'getprop'") return response('[ro.product.model]: [RG-glasses]\n');
    if (command(args).includes('meminfo')) return response('MemTotal: 2048 kB\nMemAvailable: 1024 kB\n');
    return response('', 1, 'Permission denied');
  });
  const info = await tools.info({ serial });
  assert.equal(info.system.model, 'RG-glasses'); assert.equal(info.memory.available, 1024 * 1024);
  assert.equal(info.battery.percent, null); assert.equal(info.storage.length, 0); assert.equal(info.warnings.length, 6);
});
test('binary ADB capture separates stderr and preserves raw bytes, including credential-like file contents', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-capture-test-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const adb = new AdbTools(home); adb.resolve = async () => process.execPath;
  const bytes = Buffer.from([137, 80, 78, 71, 0, 13, 10, 255]);
  const result = await adb.capture(['-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}));process.stderr.write('diagnostic')`]);
  assert.deepEqual(result.stdout, bytes); assert.equal(result.stderr, 'diagnostic');
  const text = await adb.capture(['-e', "process.stdout.write('token=filename\\0password=example')"]);
  assert.equal(text.stdout.toString(), 'token=filename\0password=example');
  await assert.rejects(adb.capture(['-e', "process.stdout.write('x'.repeat(20000))"], { maxBytes: 100 }), /数据过多/);
  const controller = new AbortController();
  const pending = adb.capture(['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50); await assert.rejects(pending, { name: 'AbortError' });
});
test('APK installation preserves data by default, handles paths with spaces and stops on false-success failures', async t => {
  let installs = 0;
  const { tools, home, calls } = await fixture(t, args => args[2] === 'install' ? response(++installs === 1 ? 'Performing Streamed Install\nSuccess\n' : 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n') : response());
  const files = await Promise.all(['first app.apk', 'second.apk', 'never.apk'].map(async name => { const file = path.join(home, name); await fs.writeFile(file, Buffer.from([80, 75, 3, 4, 1, 2])); return file; }));
  await assert.rejects(tools.install({ serial, files }), /UPDATE_INCOMPATIBLE/);
  const invoked = calls.filter(args => args[2] === 'install');
  assert.equal(invoked.length, 2); assert.deepEqual(invoked[0], ['-s', serial, 'install', '-r', files[0]]);
  installs = 0;
  await tools.install({ serial, files: [files[0]], replace: false });
  assert.deepEqual(calls.at(-1), ['-s', serial, 'install', files[0]]);
  const invalid = path.join(home, 'invalid.apk'); await fs.writeFile(invalid, 'not an apk');
  await assert.rejects(tools.install({ serial, files: [invalid] }), /有效的 APK/);
});
test('system app mutations, unconfirmed removal and unsupported input cannot reach ADB mutation commands', async t => {
  const { tools, calls } = await fixture(t, args => {
    if (command(args).includes("'list' 'packages'")) return response(command(args).includes("'-3'") || command(args).includes("'-d'") ? '' : 'package:com.android.settings versionCode:32\n');
    return response();
  });
  await assert.rejects(tools.appAction({ serial, packageName: 'com.android.settings', action: 'uninstall' }), /确认/);
  await assert.rejects(tools.appAction({ serial, packageName: 'com.android.settings', action: 'uninstall', confirmPackage: 'com.android.settings' }), /系统应用/);
  await assert.rejects(tools.appAction({ serial, packageName: 'app;reboot', action: 'launch' }), /包名无效/);
  await assert.rejects(tools.control({ serial, action: 'reboot' }), /确认重启/);
  await assert.rejects(tools.control({ serial, action: 'shell' }), /不支持/);
  assert.ok(!calls.some(args => args[2] === 'uninstall' || args[2] === 'reboot'));
});
test('application launch resolves an actual launcher; applications without a launcher fail explicitly', async t => {
  let activity = 'local.test.app/.MainActivity\n';
  const { tools, calls } = await fixture(t, args => {
    const script = command(args);
    if (script.includes("'list' 'packages'")) return response(script.includes("'-d'") ? '' : 'package:local.test.app versionCode:1\n');
    if (script.includes("'resolve-activity'")) return response(activity);
    return response('Starting: Intent\n');
  });
  await tools.appAction({ serial, packageName: 'local.test.app', action: 'launch' });
  assert.ok(calls.some(args => command(args).includes("'am' 'start' '--user' '0' '-n' 'local.test.app/.MainActivity'")));
  activity = 'No activity found\n';
  await assert.rejects(tools.appAction({ serial, packageName: 'local.test.app', action: 'launch' }), /桌面入口/);
});
test('file imports reject canonical paths outside shared storage and refuse overwrites', async t => {
  let canonical = '/system/etc', exists = false;
  const { tools, home, calls } = await fixture(t, args => {
    const script = command(args);
    if (script === "'realpath' '/sdcard'") return response('/storage/emulated/0\n');
    if (script.startsWith("'realpath'")) return response(canonical + '\n');
    if (script.startsWith('[ -d ')) return response('directory');
    if (script.startsWith('if [ -e ')) return response(exists ? 'exists' : '');
    return response();
  });
  const file = path.join(home, "a ' $(no).txt"); await fs.writeFile(file, 'hello');
  await assert.rejects(tools.push({ serial, files: [file], directory: '/sdcard/escape' }), /共享存储/);
  canonical = '/storage/emulated/0/Download'; exists = true;
  await assert.rejects(tools.push({ serial, files: [file] }), /同名文件/);
  assert.ok(!calls.some(args => args[2] === 'push'));
  exists = false;
  await tools.push({ serial, files: [file] });
  assert.deepEqual(calls.at(-1), ['-s', serial, 'push', file, "/storage/emulated/0/Download/a ' $(no).txt"]);
});
test('export creates a new container and never overwrites a preexisting computer file', async t => {
  const { tools, home } = await fixture(t, async args => { if (args[2] === 'pull') await fs.writeFile(path.join(args[4], 'data.txt'), 'device'); return response('pulled'); });
  await fs.writeFile(path.join(home, 'data.txt'), 'original');
  const first = await tools.pull({ serial, path: '/sdcard/data.txt', directory: home });
  const second = await tools.pull({ serial, path: '/sdcard/data.txt', directory: home });
  assert.notEqual(first.path, second.path); assert.equal(await fs.readFile(path.join(home, 'data.txt'), 'utf8'), 'original');
  assert.equal(await fs.readFile(first.path, 'utf8'), 'device');
  await assert.rejects(tools.pull({ serial, path: '/sdcard' }), /整个存储/);
});
test('concurrent mutations on one device are rejected and cancellation releases the device lock', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { tools } = await fixture(t, async () => { await gate; return response(); });
  const first = tools.control({ serial, action: 'home' });
  await assert.rejects(tools.control({ serial, action: 'back' }), /操作进行中/);
  release(); await first;
  await tools.control({ serial, action: 'back' });
});
test('screenshot files retain PNG bytes; invalid images are never reported as successful captures', async t => {
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(480, 16); png.writeUInt32BE(640, 20);
  let image = png;
  const { tools } = await fixture(t, () => response(image));
  const result = await tools.screenshot({ serial });
  assert.equal(result.width, 480); assert.equal(result.height, 640); assert.deepEqual(await fs.readFile(result.path), png);
  image = Buffer.from('Permission denied'); await assert.rejects(tools.screenshot({ serial }), /有效截图/);
});
test('file previews preserve text and image bytes, reject binary data and refuse oversized reads before transfer', async t => {
  let bytes = Buffer.from('你好\npassword=literal-text\n'), length = bytes.length;
  const { tools, calls } = await fixture(t, args => args[2] === 'exec-out' ? response(bytes) : response(`81b0|${length}\n`));
  const text = await tools.readFile({ serial, path: "/sdcard/it's.txt" });
  assert.equal(text.content, bytes.toString());
  assert.deepEqual(calls.at(-1), ['-s', serial, 'exec-out', "'cat' '--' '/sdcard/it'\\''s.txt'"]);
  bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]); length = bytes.length;
  const png = await tools.readFile({ serial, path: '/sdcard/test.png' }); assert.equal(png.mime, 'image/png'); assert.deepEqual(Buffer.from(png.data, 'base64'), bytes);
  bytes = Buffer.from([0, 1, 2]); length = bytes.length; await assert.rejects(tools.readFile({ serial, path: '/sdcard/test.bin' }), /无法直接预览/);
  length = 3 * 1024 * 1024; const before = calls.filter(args => args[2] === 'exec-out').length;
  await assert.rejects(tools.readFile({ serial, path: '/sdcard/large.txt' }), /超过 2 MiB/);
  assert.equal(calls.filter(args => args[2] === 'exec-out').length, before);
});
test('UI and core share the glasses operations, with per-device persistent job metadata', async t => {
  const { home } = await fixture(t); const workbench = await new Workbench(home).init(); t.after(() => workbench.close());
  workbench.glasses.install = async () => ({ serial, installed: ['test.apk'] });
  const job = await workbench.call('aiui_glasses_install', { serial, files: ['test.apk'] });
  await workbench.jobs.items.find(item => item.id === job.id).promise;
  assert.equal(workbench.jobs.get(job.id).serial, serial); assert.equal(workbench.jobs.get(job.id).status, 'succeeded');
  for (const tool of ['info', 'files', 'mkdir', 'pull', 'push', 'apps', 'app_details', 'app_action', 'install', 'screenshot', 'logs', 'control']) assert.ok(UI_TOOLS.has('aiui_glasses_' + tool));
});
