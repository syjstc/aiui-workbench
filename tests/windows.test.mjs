import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { normalizeEnvironment, run, safeRelative } from '../core/util.mjs';
import { zipDirectory } from '../scripts/archive.mjs';
import { AdbTools } from '../core/adb.mjs';

test('Windows PATH overrides survive inherited mixed-case environment names', () => {
  const env = normalizeEnvironment({ Path: 'C:\\old', APPDATA: 'C:\\用户', PATH: 'C:\\AIUI Workshop\\vendor\\adb;C:\\Windows', appdata: 'D:\\新数据' }, 'win32');
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH, 'C:\\AIUI Workshop\\vendor\\adb;C:\\Windows');
  assert.equal(env.APPDATA, undefined);
  assert.equal(env.appdata, 'D:\\新数据');
});
test('process arguments with Unicode, spaces and shell metacharacters stay literal', async () => {
  const args = ['项目 name', '& echo injected', '%PATH%', '$HOME', 'quote"value', 'C:\\用户\\My Projects\\'];
  const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), args);
});
test('resource paths reject drive-qualified paths and NTFS alternate streams', () => {
  for (const value of ['C:/private.txt', 'C:private.txt', 'icon.svg:private', '//server/share', 'a\\b']) assert.throws(() => safeRelative(value));
  assert.equal(safeRelative('assets/图标.svg'), 'assets/图标.svg');
});
test('Windows portable archives preserve required hidden files and Unicode folders', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-win-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'AIUI Workshop'), nested = path.join(directory, '中文 assets');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, '.aixignore'), 'private/\n');
  await fs.writeFile(path.join(directory, 'adb.exe'), Buffer.from([77, 90, 0, 255]));
  const archive = path.join(root, 'app.zip'); await zipDirectory(directory, archive);
  const files = unzipSync(await fs.readFile(archive));
  assert.equal(Buffer.from(files['AIUI Workshop/中文 assets/.aixignore']).toString(), 'private/\n');
  assert.deepEqual(Buffer.from(files['AIUI Workshop/adb.exe']), Buffer.from([77, 90, 0, 255]));
});
test('Windows uses the bundled exe and puts it before the inherited Path', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-win-adb-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const adb = new AdbTools(home, { platform: 'win32', arch: 'x64', env: { Path: 'C:\\Windows;D:\\tools' } });
  assert.equal((await adb.resolveInfo()).source, 'bundled');
  assert.ok((await adb.resolve()).endsWith(path.join('win32', 'adb.exe')));
  assert.ok((await adb.environment()).PATH.endsWith(';C:\\Windows;D:\\tools'));
});
