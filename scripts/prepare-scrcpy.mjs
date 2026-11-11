import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { ROOT, readJson, sha, run } from '../core/util.mjs';

const base = path.join(ROOT, 'vendor/scrcpy');
async function checksums(directory) {
  const result = {};
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && name !== 'bundle.json') result[name] = sha(await fs.readFile(path.join(directory, name)));
      else if (entry.isSymbolicLink()) throw new Error('投屏发行包包含符号链接，未写入客户端');
    }
  }
  await walk(); return result;
}
export async function prepareScrcpy(platform = process.platform, arch = process.arch) {
  const manifest = await readJson(path.join(base, 'manifest.json')), key = `${platform}-${arch}`, release = manifest.platforms[key];
  if (!release) throw new Error(`尚未准备 ${key} 的内置投屏组件`);
  const target = path.join(base, key), receipt = await readJson(path.join(target, 'bundle.json'), null);
  if (receipt?.sha256 === release.sha256 && receipt.version === manifest.version && receipt.layoutVersion === 5) {
    const actual = await checksums(target);
    if (Object.keys(actual).length === Object.keys(receipt.files).length && Object.entries(receipt.files).every(([name, digest]) => actual[name] === digest)) return { platform: key, version: manifest.version, directory: target };
  }
  const url = `https://github.com/Genymobile/scrcpy/releases/download/v${manifest.version}/${release.archive}`;
  const cache = path.join(ROOT, '.local/scrcpy-downloads', release.archive);
  let archive = await fs.readFile(cache).catch(() => null);
  if (!archive || sha(archive) !== release.sha256) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`官方投屏组件下载失败：HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
    if (archive.length !== release.bytes || sha(archive) !== release.sha256) throw new Error('投屏组件校验失败');
    await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.writeFile(cache, archive);
  }
  if (archive.length !== release.bytes || sha(archive) !== release.sha256) throw new Error('投屏组件校验失败');
  const temporary = await fs.mkdtemp(path.join(ROOT, '.local/scrcpy-prepare-'));
  try {
    const staging = path.join(temporary, 'bundle'); await fs.mkdir(staging);
    const prefix = release.archive.replace(/\.(?:tar\.gz|zip)$/, '');
    if (release.archive.endsWith('.zip')) {
      for (const [name, bytes] of Object.entries(unzipSync(archive))) {
        const relative = name.replace(new RegExp('^' + prefix + '/'), '');
        if (!relative || relative.endsWith('/')) continue;
        if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('发行包路径无效');
        const destination = path.join(staging, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
      }
    } else {
      const listing = await run('tar', ['-tzf', cache]);
      if (listing.code || listing.output.split('\n').filter(Boolean).some(name => !name.startsWith(prefix + '/') || name.split('/').includes('..'))) throw new Error('发行包路径无效');
      const extracted = await run('tar', ['-xzf', cache, '-C', temporary]); if (extracted.code) throw new Error(extracted.output);
      await fs.cp(path.join(temporary, prefix), staging, { recursive: true });
    }
    const binary = platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
    for (const duplicate of ['adb', 'adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) await fs.rm(path.join(staging, duplicate), { force: true });
    await fs.access(path.join(staging, binary)); await fs.access(path.join(staging, 'scrcpy-server'));
    if (platform !== 'win32') await fs.chmod(path.join(staging, binary), 0o755);
    if (platform === 'darwin') {
      const contents = path.join(staging, 'AIUI Mirror.app/Contents'), executable = path.join(contents, 'MacOS'), resources = path.join(contents, 'Resources');
      await fs.mkdir(executable, { recursive: true }); await fs.mkdir(resources, { recursive: true });
      await fs.rename(path.join(staging, 'scrcpy'), path.join(executable, 'scrcpy'));
      // Apple's code directory must contain executable code only; artwork
      // belongs in Resources so the nested app can be Developer ID signed.
      for (const name of ['scrcpy-server', 'scrcpy.png', 'disconnected.png']) await fs.rename(path.join(staging, name), path.join(resources, name));
      await fs.copyFile(path.join(ROOT, 'assets/app.icns'), path.join(resources, 'app.icns'));
      await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.aiui.workbench.mirror</string><key>CFBundleName</key><string>AIUI Mirror</string><key>CFBundleDisplayName</key><string>AIUI 真机投屏</string><key>CFBundleExecutable</key><string>scrcpy</string><key>CFBundleIconFile</key><string>app.icns</string><key>CFBundleVersion</key><string>${manifest.version}</string><key>CFBundleShortVersionString</key><string>${manifest.version}</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/><key>LSMinimumSystemVersion</key><string>11.0</string></dict></plist>`);
    }
    const files = await checksums(staging);
    await fs.writeFile(path.join(staging, 'bundle.json'), JSON.stringify({ layoutVersion: 5, version: manifest.version, url, sha256: release.sha256, files }, null, 2) + '\n');
    await fs.rm(target, { recursive: true, force: true }); await fs.rename(staging, target);
    return { platform: key, version: manifest.version, directory: target };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--all')) for (const key of Object.keys((await readJson(path.join(base, 'manifest.json'))).platforms)) { const [platform, arch] = key.split('-'); console.log(await prepareScrcpy(platform, arch)); }
  else console.log(await prepareScrcpy());
}
