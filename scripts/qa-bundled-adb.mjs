import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../core/util.mjs';

const app = path.resolve(process.argv[2] || path.join(ROOT, 'output/desktop-adb/AIUI Workshop-darwin-arm64/AIUI Workshop.app/Contents/Resources/app'));
const manifest = JSON.parse(await fs.readFile(path.join(app, 'vendor/adb/manifest.json'), 'utf8'));
const bundled = path.join(app, 'vendor/adb', process.platform);
for (const [name, expected] of Object.entries(manifest.platforms[process.platform].files)) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(bundled, name))).digest('hex');
  assert.equal(actual, expected, `packaged file: ${name}`);
}
for (const other of ['darwin', 'linux', 'win32'].filter(platform => platform !== process.platform)) {
  assert.equal(await fs.stat(path.join(app, 'vendor/adb', other)).then(() => true, () => false), false, 'desktop packages contain only their target platform');
}
const { Workbench } = await import(pathToFileURL(path.join(app, 'core/service.mjs')).href);
const temp = await fs.mkdtemp(path.join(ROOT, '.local/qa-bundled-adb-'));
// Empty only this verification process's PATH. No user settings or global PATH are changed.
process.env.PATH = '';
delete process.env.ANDROID_HOME;
delete process.env.ANDROID_SDK_ROOT;
const service = await new Workbench(temp).init();
service.adb.userHome = temp;
try {
  const result = await service.call('aiui_environment_check');
  assert.equal(result.adbTool.source, 'bundled');
  assert.equal(result.adbTool.path, path.join(bundled, process.platform === 'win32' ? 'adb.exe' : 'adb'));
  assert.equal(result.adb, true);
  assert.equal(result.aix, true);
  const report = {
    checkedAt: new Date().toISOString(), packageRoot: app,
    cleanEnvironment: { path: '', androidSdkVariables: false, userSdkDirectory: false },
    bundledVersion: result.adbTool.version, adb: result.adb, officialCli: result.aix,
    packageFilesVerified: Object.keys(manifest.platforms[process.platform].files),
    devices: result.devices.map(device => ({ name: device.name, status: device.status, developerMode: device.inspection?.developerMode, runtimeReady: device.inspection?.runtimeReady })),
  };
  const directory = path.join(ROOT, 'output/qa/bundled-adb');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await service.close();
  await fs.rm(temp, { recursive: true, force: true });
}
