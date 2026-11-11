import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { ROOT } from '../core/util.mjs';

const directory = path.join(ROOT, 'vendor/adb');
const hash = value => createHash('sha256').update(value).digest('hex');

export async function prepareAdb(platform = process.platform, arch = process.arch) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const release = manifest.platforms[platform];
  if (!release?.architectures.includes(arch)) throw new Error(`尚未准备 ${platform}/${arch} 的内置 ADB，不能生成缺少连接工具的安装包。`);
  const target = path.join(directory, platform);
  const valid = await Promise.all(Object.entries(release.files).map(async ([name, checksum]) => hash(await fs.readFile(path.join(target, name)).catch(() => Buffer.alloc(0))) === checksum));
  if (valid.every(Boolean)) return { platform, version: manifest.version, directory: target };

  const cache = path.join(ROOT, '.local/adb-downloads', path.basename(new URL(release.url).pathname));
  let archive = await fs.readFile(cache).catch(() => null);
  if (!archive || hash(archive) !== release.sha256) {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error(`官方 ADB 下载失败：HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (archive.length !== release.size || hash(archive) !== release.sha256) throw new Error('官方 ADB 下载校验失败，未写入安装包。');
  const files = unzipSync(archive, { filter: entry => Object.hasOwn(release.files, entry.name.replace(/^platform-tools\//, '')) });
  for (const [name, checksum] of Object.entries(release.files)) {
    const content = files[`platform-tools/${name}`];
    if (!content || hash(content) !== checksum) throw new Error(`ADB 文件校验失败：${name}`);
  }
  await fs.mkdir(target, { recursive: true });
  for (const name of Object.keys(release.files)) {
    const file = path.join(target, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, files[`platform-tools/${name}`], { mode: name === 'adb' ? 0o755 : 0o644 });
    if (name === 'adb') await fs.chmod(file, 0o755);
  }
  return { platform, version: manifest.version, directory: target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--all')) {
    for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'x64']]) console.log(await prepareAdb(platform, arch));
  } else console.log(await prepareAdb());
}
