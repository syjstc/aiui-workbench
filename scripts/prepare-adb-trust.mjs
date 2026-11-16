import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { ROOT, run, sha, atomicJson, readJson } from '../core/util.mjs';

export async function prepareAdbTrust() {
  const directory = path.join(ROOT, 'assets/android-debug'), source = path.join(directory, 'AdbTrust.java');
  const sourceHash = sha(await fs.readFile(source)), manifest = await readJson(path.join(directory, 'manifest.json'), null);
  const jar = path.join(directory, 'adb-trust.jar');
  if (manifest?.sourceSha256 === sourceHash && manifest.sha256 === sha(await fs.readFile(jar).catch(() => Buffer.alloc(0)))) {
    await fs.chmod(path.join(directory, 'manifest.json'), 0o644); return;
  }
  const sdkDirectory = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
  const androidJar = path.join(sdkDirectory, 'platforms/android-35/android.jar');
  const d8 = path.join(sdkDirectory, 'build-tools/35.0.0', process.platform === 'win32' ? 'd8.bat' : 'd8');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-adb-trust-build-'));
  try {
    const classes = path.join(temporary, 'classes'), dex = path.join(temporary, 'dex');
    await fs.mkdir(classes); await fs.mkdir(dex);
    const compile = await run('javac', ['--release', '8', '-cp', androidJar, '-d', classes, source]);
    if (compile.code) throw new Error('ADB trust helper compile failed: ' + compile.output);
    const convert = await run(d8, ['--lib', androidJar, '--output', dex, path.join(classes, 'com/aiui/workbench/AdbTrust.class')]);
    if (convert.code) throw new Error('ADB trust helper DEX failed: ' + convert.output);
    const bytes = zipSync({ 'classes.dex': [await fs.readFile(path.join(dex, 'classes.dex')), { mtime: new Date('2020-01-01T00:00:00Z') }] });
    await fs.writeFile(jar, bytes);
    await atomicJson(path.join(directory, 'manifest.json'), { sourceSha256: sourceHash, sha256: sha(bytes), bytes: bytes.length });
    await fs.chmod(path.join(directory, 'manifest.json'), 0o644);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareAdbTrust();
