import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { ROOT, run, sha, atomicJson, readJson } from '../core/util.mjs';

export async function prepareWirelessHelper() {
  const directory = path.join(ROOT, 'assets/wireless-helper');
  const sources = ['SetupActivity.java', 'SettingsFocus.java'].map(file => path.join(directory, file));
  const xml = path.join(directory, 'AndroidManifest.xml');
  const res = path.join(directory, 'res'), icon = path.join(ROOT, 'assets/app.iconset/icon_128x128.png');
  const inputs = [...sources, xml, path.join(res, 'values/strings.xml'), path.join(res, 'values-zh/strings.xml'), icon, fileURLToPath(import.meta.url)];
  const sourceSha256 = sha(Buffer.concat(await Promise.all(inputs.map(file => fs.readFile(file)))));
  const apk = path.join(directory, 'aiui-wireless-helper.apk'), info = path.join(directory, 'manifest.json');
  const manifest = await readJson(info, null), current = await fs.readFile(apk).catch(() => null);
  if (current && manifest?.certificateSha256 && manifest.sourceSha256 === sourceSha256 && manifest.sha256 === sha(current)) return;
  const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
  const jar = path.join(sdk, 'platforms/android-35/android.jar'), build = path.join(sdk, 'build-tools/35.0.0');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-wireless-helper-'));
  async function command(file, args, options) { const result = await run(file, args, options); if (result.code) throw new Error('Wireless helper build failed: ' + result.output); }
  try {
    const classes = path.join(temporary, 'classes'), dex = path.join(temporary, 'dex');
    await fs.mkdir(classes); await fs.mkdir(dex);
    await command('javac', ['--release', '8', '-cp', jar, '-d', classes, ...sources]);
    const classFiles = await fs.readdir(path.join(classes, 'com/aiui/workbench/wireless'));
    await command(path.join(build, 'd8'), ['--min-api', '26', '--lib', jar, '--output', dex, ...classFiles.map(file => path.join(classes, 'com/aiui/workbench/wireless', file))]);
    const resources = path.join(temporary, 'res');
    await fs.cp(res, resources, { recursive: true });
    await fs.mkdir(path.join(resources, 'drawable-nodpi'));
    await fs.copyFile(icon, path.join(resources, 'drawable-nodpi/ic_launcher.png'));
    const unsigned = path.join(temporary, 'unsigned.apk'), aligned = path.join(temporary, 'aligned.apk');
    const aapt = path.join(build, 'aapt');
    await command(aapt, ['package', '-f', '-0', 'arsc', '-M', xml, '-S', resources, '-I', jar, '-F', unsigned]);
    // Keep aapt's compression choices intact. Android 11+ maps resources.arsc directly from the APK.
    await command(aapt, ['add', unsigned, 'classes.dex'], { cwd: dex });
    await command(path.join(build, 'zipalign'), ['-f', '4', unsigned, aligned]);
    const explicitKey = process.env.AIUI_HELPER_KEYSTORE;
    const keystore = explicitKey || path.join(ROOT, '.local', 'wireless-helper-dev.p12');
    const keyPassword = explicitKey ? 'env:AIUI_HELPER_KEYSTORE_PASSWORD' : 'pass:android';
    if (!explicitKey) {
      await fs.mkdir(path.dirname(keystore), { recursive: true });
      if (!await fs.stat(keystore).catch(() => null)) {
        await command('keytool', ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'helper', '-storepass', 'android', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '36500', '-dname', 'CN=AIUI Wireless Setup']);
        await fs.chmod(keystore, 0o600);
      }
    }
    const signed = path.join(temporary, 'signed.apk');
    await command(path.join(build, 'apksigner'), ['sign', '--v4-signing-enabled', 'false', '--ks', keystore, '--ks-pass', keyPassword, '--out', signed, aligned]);
    const verified = await run(path.join(build, 'apksigner'), ['verify', '--print-certs', signed]);
    const certificateSha256 = verified.output.match(/certificate SHA-256 digest:\s*([a-f0-9]{64})/i)?.[1];
    if (verified.code || !certificateSha256) throw new Error('Could not verify the signed wireless setup APK');
    if (manifest?.certificateSha256 && manifest.certificateSha256 !== certificateSha256) throw new Error('Set AIUI_HELPER_KEYSTORE and AIUI_HELPER_KEYSTORE_PASSWORD to the original signer so existing helper installations can upgrade.');
    const bytes = await fs.readFile(signed);
    await command(path.join(build, 'zipalign'), ['-c', '4', signed]);
    let storedTable = false;
    unzipSync(bytes, { filter(entry) {
      if (entry.name === 'resources.arsc') storedTable = entry.compression === 0 && entry.originalSize > 0;
      return false;
    } });
    if (!storedTable) throw new Error('The signed wireless setup APK must store resources.arsc uncompressed.');
    const version = (await fs.readFile(xml, 'utf8')).match(/android:versionName="(\d+(?:\.\d+)*)"/)?.[1];
    if (!version) throw new Error('Missing wireless setup version in AndroidManifest.xml');
    await fs.copyFile(signed, apk);
    await atomicJson(info, { sourceSha256, sha256: sha(bytes), certificateSha256, bytes: bytes.length, packageName: 'com.aiui.workbench.wireless', version });
    await fs.chmod(info, 0o644);
  } finally { await fs.rm(temporary, { force: true, recursive: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareWirelessHelper();
