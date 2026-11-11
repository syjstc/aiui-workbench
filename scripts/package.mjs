import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { APP_INFO } from '../core/version.mjs';
import { ROOT, run } from '../core/util.mjs';
import { createManifest } from './release-manifest.mjs';
import { prepareAdb } from './prepare-adb.mjs';
import { prepareScrcpy } from './prepare-scrcpy.mjs';
import { prepareWindowsIcon } from './prepare-icon.mjs';
import { zipDirectory } from './archive.mjs';
import { signMac } from './sign-mac.mjs';
import { generateLicenses } from './third-party-licenses.mjs';

const { values } = parseArgs({ options: { platform: { type: 'string' }, arch: { type: 'string' }, out: { type: 'string' }, sign: { type: 'boolean', default: false } } });
const platform = values.platform || process.platform;
const arch = values.arch || (platform === 'win32' ? 'x64' : process.arch);
const output = path.resolve(ROOT, values.out || process.env.AIUI_PACKAGE_OUTPUT || 'output/desktop');
const tmpdir = path.join(ROOT, '.local', 'packager-' + process.pid);
if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('Build the macOS package on macOS.');
if (values.sign && (platform !== 'darwin' || !process.env.MACOS_SIGN_IDENTITY?.startsWith('Developer ID Application:'))) throw new Error('--sign requires macOS and MACOS_SIGN_IDENTITY with a Developer ID Application certificate.');
await generateLicenses();
await prepareAdb(platform, arch);
await prepareScrcpy(platform, arch);
const icon = platform === 'win32' ? await prepareWindowsIcon() : path.join(ROOT, 'assets/app.icns');
await fs.mkdir(tmpdir, { recursive: true });
try {
  const paths = await packager({
    dir: ROOT, tmpdir, out: output, name: 'AIUI Workshop', executableName: 'AIUI Workshop',
    appBundleId: 'local.aiui.workbench', appCategoryType: 'public.app-category.developer-tools',
    appVersion: APP_INFO.version, electronVersion: APP_INFO.devDependencies.electron,
    electronZipDir: process.env.AIUI_ELECTRON_ZIP_DIR,
    platform, arch, icon, overwrite: true, asar: false, prune: true,
    win32metadata: { ProductName: 'AIUI Workshop', FileDescription: 'AIUI Workshop', CompanyName: 'AIUI Workbench' },
    ignore: [/^\/(?:\.local|output|tests|scripts|renderer|preview|mirror|examples|\.git|\.github|\.agents|\.codex)(?:\/|$)/, /(?:^|\/)\.env(?:\.|$)/, /\.(?:p8|p12|pfx|keychain-db)$/, /(?:^|\/)\.DS_Store$/, /\.log$/, /package-lock\.json$/, /vite\.config\.mjs$/, /^\/docs\/screenshots(?:\/|$)/, /^\/assets\/branding\/previous-icon\.png$/, ...['darwin', 'linux', 'win32'].filter(p => p !== platform).map(p => new RegExp(`^/vendor/adb/${p}(?:/|$)`)), ...['darwin-arm64','darwin-x64','linux-x64','win32-x64'].filter(key => key !== `${platform}-${arch}`).map(key => new RegExp(`^/vendor/scrcpy/${key}(?:/|$)`))],
    extendInfo: { CFBundleDisplayName: 'AIUI 工坊', NSCameraUsageDescription: '在模拟器中使用电脑摄像头，测试 AIUI 应用的实时取景与拍照。', NSHumanReadableCopyright: 'AIUI Workbench. Includes official AIUI and Ink components with their original notices.' },
  });
  for (const directory of paths) {
    console.log(directory);
    const source = await run('git', ['rev-parse', 'HEAD']).catch(() => ({ code: 1 }));
    const appRoot = platform === 'darwin' ? path.join(directory, 'AIUI Workshop.app/Contents/Resources/app') : path.join(directory, 'resources/app');
    await fs.writeFile(path.join(appRoot, 'build-info.json'), JSON.stringify({ version: APP_INFO.version, platform, arch, sourceCommit: source.code === 0 ? source.output.trim() : null, builtAt: new Date().toISOString() }, null, 2) + '\n');
    if (values.sign) await signMac(path.join(directory, 'AIUI Workshop.app'));
    const extension = platform === 'linux' ? '.tar.gz' : '.zip';
    const archive = path.join(output, `AIUI-Workbench-${APP_INFO.version}-${platform}-${arch}${extension}`);
    let result;
    if (platform === 'darwin') result = await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(directory, 'AIUI Workshop.app'), archive], { timeout: 300000 });
    else if (platform === 'linux') result = await run('tar', ['-czf', archive, '-C', path.dirname(directory), path.basename(directory)], { timeout: 300000 });
    else await zipDirectory(directory, archive);
    if (result?.code) throw new Error('Archive failed: ' + result.output);
    const manifest = await createManifest({ files: [{ platform, arch, file: archive }] });
    // Keep each target's manifest even when several packages share an output folder.
    await fs.writeFile(path.join(output, `workbench-update-${platform}-${arch}.json`), JSON.stringify(manifest, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'workbench-update.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(archive);
  }
} finally { await fs.rm(tmpdir, { recursive: true, force: true }); }
