import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { httpsUrl, validateManifest, MANIFEST_NAME } from '../core/updates.mjs';

const GITHUB = 'syjstc/aiui-workbench';
const TAG = 'stable';
const ownedAsset = name => /^AIUI-Workbench-(?:latest|\d+\.\d+\.\d+)-(?:darwin|win32|linux)-[\w]+\.(?:zip|dmg|tar\.gz)$/.test(name) || [MANIFEST_NAME, 'SHA256SUMS.txt'].includes(name);
export function cnbUrls(repository) {
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository) || repository.split('/').some(part => ['.', '..'].includes(part))) throw new Error('CNB 仓库格式为组织/仓库');
  const root = `https://cnb.cool/${repository}/-/releases`;
  return { root, base: `${root}/download/${TAG}/`, manifest: `${root}/download/${TAG}/${MANIFEST_NAME}` };
}

export function mirrorPlan(release, manifest, repository) {
  const version = semver.valid(release.tag_name);
  if (release.draft || release.prerelease || !version || semver.prerelease(version)) throw new Error('只同步正式稳定 Release');
  if (!semver.eq(version, manifest.version)) throw new Error('GitHub 清单与 Release 版本不一致');
  const urls = cnbUrls(repository), files = [];
  for (const entry of manifest.files || []) {
    validateManifest(manifest, 'https://github.com/manifest.json', entry.platform, entry.arch);
    const name = decodeURIComponent(new URL(httpsUrl(entry.url, `https://github.com/${GITHUB}/releases/download/${release.tag_name}/`)).pathname.split('/').pop());
    const asset = release.assets.find(asset => asset.name === name);
    if (!asset || asset.size !== entry.size || !name.startsWith(`AIUI-Workbench-${version}-`) || !ownedAsset(name)) throw new Error('Release 缺少清单中的安装包或大小不一致');
    files.push({ name, asset, platform: entry.platform, arch: entry.arch, size: entry.size, sha256: entry.sha256, alias: name.replace(`-${version}-`, '-latest-') });
  }
  if (!files.length) throw new Error('Release 没有安装包');
  // The DMG is for manual installation; the signed, notarized ZIP stays the
  // update package. Never rebuild or modify the released app bundles.
  for (const asset of release.assets) {
    if (!new RegExp(`^AIUI-Workbench-${version.replaceAll('.', '\\.')}-darwin-(arm64|x64)\\.dmg$`).test(asset.name)) continue;
    files.push({ name: asset.name, asset, size: asset.size, sha256: asset.digest?.replace(/^sha256:/, '') || null, alias: asset.name.replace(`-${version}-`, '-latest-') });
  }
  if (new Set(files.map(file => file.name)).size !== files.length) throw new Error('Release 包含重复安装包');
  const mirrored = { ...manifest, releaseUrl: urls.root, files: manifest.files.map(entry => {
    const file = files.find(file => file.platform === entry.platform && file.arch === entry.arch);
    return { ...entry, url: urls.base + encodeURIComponent(file.name) };
  }) };
  return { version, urls, files, manifest: mirrored };
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: (await fs.stat(file)).size };
}

export async function syncCnbRelease({ repository, token, githubToken = '', localDirectory, dryRun = false, fetcher = fetch, log = console.log }) {
  const urls = cnbUrls(repository);
  if (!dryRun && !token) throw new Error('需要 CNB_TOKEN（仅目标下载仓库的 Release 读写权限）');
  const apiBase = `https://api.cnb.cool/${repository}/-/releases`;
  const githubApi = `https://api.github.com/repos/${GITHUB}/releases/latest`;
  const publicRequest = async (url, options = {}) => {
    let current = httpsUrl(url);
    for (let hop = 0; hop < 6; hop++) {
      // Credentials are only sent to their owning API host, never to a signed
      // CDN redirect or an URL taken from a release body.
      const headers = { 'User-Agent': 'AIUI-Workbench-CNB-Mirror', ...(options.headers || {}) };
      if (new URL(current).hostname === 'api.github.com' && githubToken) headers.Authorization = `Bearer ${githubToken}`;
      const response = await fetcher(current, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(30 * 60 * 1000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        current = httpsUrl(response.headers.get('location'), current);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`公开下载失败：HTTP ${response.status}`); }
      return response;
    }
    throw new Error('公开下载跳转次数过多');
  };
  const api = async (suffix = '', method = 'GET', body, { missing = false } = {}) => {
    const response = await fetcher(apiBase + suffix, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`CNB ${method} 失败：HTTP ${response.status}`); }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const release = await (await publicRequest(githubApi, { headers: { Accept: 'application/vnd.github+json' } })).json();
  if (release.draft || release.prerelease || !semver.valid(release.tag_name) || semver.prerelease(semver.valid(release.tag_name))) throw new Error('只同步正式稳定 Release');
  const sourceManifestAsset = release.assets.find(asset => asset.name === MANIFEST_NAME);
  if (!sourceManifestAsset) throw new Error(`GitHub Release 缺少 ${MANIFEST_NAME}`);
  const sourceManifest = await (await publicRequest(githubToken ? sourceManifestAsset.url : sourceManifestAsset.browser_download_url, { headers: { Accept: 'application/octet-stream' } })).json();
  const plan = mirrorPlan(release, sourceManifest, repository);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-cnb-release-'));
  try {
    for (const file of plan.files) {
      const local = localDirectory && path.join(path.resolve(localDirectory), file.name);
      if (local && await fs.stat(local).then(stat => stat.isFile(), () => false)) file.path = local;
      else {
        file.path = path.join(directory, file.name);
        log(`下载 ${file.name}`);
        const response = await publicRequest(githubToken ? file.asset.url : file.asset.browser_download_url, { headers: { Accept: 'application/octet-stream' } });
        const handle = await fs.open(file.path, 'wx');
        try { for await (const chunk of response.body) await handle.writeFile(chunk); } finally { await handle.close(); }
      }
      const actual = await digest(file.path);
      if (actual.size !== file.size || file.sha256 && actual.sha256 !== file.sha256) throw new Error(`安装包校验失败：${file.name}`);
      file.sha256 = actual.sha256;
    }
    const result = { version: plan.version, manifestUrl: urls.manifest, releaseUrl: urls.root, downloads: plan.files.map(file => ({ name: file.alias, url: urls.base + encodeURIComponent(file.alias) })) };
    if (dryRun) { log(JSON.stringify({ ...result, dryRun: true }, null, 2)); return result; }

    // This is a dedicated download repository. Do not delete somebody else's
    // releases to enforce the one-release policy.
    const releases = await api('?page_size=100');
    if (!Array.isArray(releases) || releases.some(item => item.tag_name !== TAG)) throw new Error('请使用只维护 stable Release 的独立 CNB 下载仓库');
    let target = await api(`/tags/${TAG}`, 'GET', undefined, { missing: true });
    if (target?.assets?.some(asset => asset.name === MANIFEST_NAME)) {
      const previous = await (await publicRequest(urls.manifest)).json();
      if (!semver.valid(previous.version) || semver.gt(previous.version, plan.version)) throw new Error('CNB 已有更新的版本，拒绝覆盖或降级');
      if (semver.eq(previous.version, plan.version) && JSON.stringify(previous.files.map(file => [file.platform, file.arch, file.sha256, file.size]).sort()) !== JSON.stringify(plan.manifest.files.map(file => [file.platform, file.arch, file.sha256, file.size]).sort())) throw new Error('同版本安装包摘要已变化，拒绝覆盖');
    }
    if (!target) {
      await api('', 'POST', { tag_name: TAG, target_commitish: 'main', name: `AIUI 工坊 ${plan.version}`, body: sourceManifest.notes || '', draft: false, prerelease: false, make_latest: 'true' });
      target = await api(`/tags/${TAG}`);
    }
    const upload = async (name, file) => {
      log(`上传 ${name}`);
      const { size } = await fs.stat(file);
      const ticket = await api(`/${target.id}/asset-upload-url`, 'POST', { asset_name: name, size, overwrite: true, ttl: 0 });
      const uploadUrl = httpsUrl(ticket.upload_url), verifyUrl = httpsUrl(ticket.verify_url, apiBase + '/');
      if (new URL(verifyUrl).origin !== 'https://api.cnb.cool' || !new URL(verifyUrl).pathname.startsWith(`/${repository}/-/releases/${target.id}/asset-upload-confirmation/`)) throw new Error('CNB 上传确认地址无效');
      const response = await fetcher(uploadUrl, { method: 'PUT', body: createReadStream(file), duplex: 'half', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, signal: AbortSignal.timeout(30 * 60 * 1000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`CNB 上传失败：HTTP ${response.status}`);
      await api(verifyUrl.slice(apiBase.length), 'POST');
    };
    const verify = async (name, expected) => {
      const response = await publicRequest(urls.base + encodeURIComponent(name));
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of response.body) { hash.update(chunk); size += chunk.length; }
      if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(`公开附件校验失败：${name}`);
    };
    // Versioned update packages are staged and checked before publishing the
    // fixed manifest, so clients never read an old hash for a replaced ZIP.
    for (const file of plan.files) { await upload(file.name, file.path); await verify(file.name, file); }
    for (const file of plan.files) { await upload(file.alias, file.path); await verify(file.alias, file); }
    const sums = plan.files.flatMap(file => [file.name, file.alias].map(name => `${file.sha256}  ${name}`)).join('\n') + '\n';
    const sumsPath = path.join(directory, 'SHA256SUMS.txt'); await fs.writeFile(sumsPath, sums); await upload('SHA256SUMS.txt', sumsPath);
    // Check again before committing: a slower, older run cannot roll back the
    // download source after a newer GitHub release has become current.
    const current = await (await publicRequest(githubApi)).json();
    if (current.tag_name !== release.tag_name || current.id !== release.id) throw new Error('GitHub 最新版本已变化，请重新同步');
    const manifestPath = path.join(directory, MANIFEST_NAME); await fs.writeFile(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
    await upload(MANIFEST_NAME, manifestPath);
    const published = await (await publicRequest(urls.manifest)).json();
    if (JSON.stringify(published) !== JSON.stringify(plan.manifest)) throw new Error('CNB 公开清单核对失败');
    await api(`/${target.id}`, 'PATCH', { name: `AIUI 工坊 ${plan.version}`, body: sourceManifest.notes || '', draft: false, prerelease: false, make_latest: 'true' });
    const keep = new Set([...plan.files.flatMap(file => [file.name, file.alias]), MANIFEST_NAME, 'SHA256SUMS.txt']);
    const updated = await api(`/${target.id}`);
    for (const asset of updated.assets || []) {
      if (ownedAsset(asset.name) && !keep.has(asset.name)) await api(`/${target.id}/assets/${asset.id}`, 'DELETE');
    }
    log(JSON.stringify(result, null, 2)); return result;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string' }, 'local-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
    await syncCnbRelease({ repository: values.repo || process.env.CNB_REPOSITORY || '', token: process.env.CNB_TOKEN, githubToken: process.env.GITHUB_TOKEN, localDirectory: values['local-dir'], dryRun: values['dry-run'] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
