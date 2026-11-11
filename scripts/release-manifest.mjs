import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { APP_VERSION } from '../core/version.mjs';
import { httpsUrl, validateManifest } from '../core/updates.mjs';

export async function createManifest({ files, version = APP_VERSION, baseUrl, releaseUrl, notes = '' }) {
  if (!files?.length) throw new Error('至少需要一个安装包');
  const entries = [];
  for (const { platform, arch, file } of files) {
    if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64', 'ia32', 'armv7l'].includes(arch)) throw new Error('安装包平台或架构无效');
    if (entries.some(entry => entry.platform === platform && entry.arch === arch)) throw new Error('同一平台与架构只能指定一个安装包');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
    const size = (await fs.stat(file)).size, name = encodeURIComponent(path.basename(file));
    entries.push({ platform, arch, url: baseUrl ? httpsUrl(name, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') : './' + name, sha256: hash.digest('hex'), size });
  }
  const value = { schemaVersion: 1, version, publishedAt: new Date().toISOString(), notes, ...(releaseUrl ? { releaseUrl: httpsUrl(releaseUrl) } : {}), files: entries };
  for (const file of entries) validateManifest(value, 'https://release.example/workbench-update.json', file.platform, file.arch);
  return value;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { file: { type: 'string', multiple: true }, out: { type: 'string' }, 'base-url': { type: 'string' }, 'release-url': { type: 'string' }, 'notes-file': { type: 'string' }, version: { type: 'string' } } });
    const files = (values.file || []).map(value => { const [platform, arch, ...rest] = value.split(':'); return { platform, arch, file: rest.join(':') }; });
    const manifest = await createManifest({ files, version: values.version || APP_VERSION, baseUrl: values['base-url'], releaseUrl: values['release-url'], notes: values['notes-file'] ? await fs.readFile(values['notes-file'], 'utf8') : '' });
    const output = path.resolve(values.out || 'output/desktop/workbench-update.json'); await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(manifest, null, 2) + '\n'); console.log(output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
