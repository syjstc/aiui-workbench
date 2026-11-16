import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mirrorPlan, mirrorIsCurrent, syncCnbRelease, cnbUrls } from '../scripts/sync-cnb-release.mjs';
import { sha } from '../core/util.mjs';

const repository = 'official/aiui-downloads', base = `https://api.cnb.cool/${repository}/-/releases`;
const json = value => new Response(JSON.stringify(value));
async function fixture(t, { failUpload, previousVersion = '0.2.0' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-cnb-test-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packages = [
    { platform: 'darwin', arch: 'arm64', ext: 'zip', bytes: Buffer.from('signed macOS ZIP, copied without modification') },
    { platform: 'win32', arch: 'x64', ext: 'zip', bytes: Buffer.from('Windows portable ZIP') },
    { platform: 'darwin', arch: 'arm64', ext: 'dmg', bytes: Buffer.from('notarized macOS disk image') },
  ].map(file => ({ ...file, name: `AIUI-Workbench-0.3.0-${file.platform}-${file.arch}.${file.ext}` }));
  for (const file of packages) await fs.writeFile(path.join(directory, file.name), file.bytes);
  const manifest = { schemaVersion: 1, version: '0.3.0', notes: 'A concise release note', files: packages.filter(file => file.ext === 'zip').map(file => ({ platform: file.platform, arch: file.arch, url: `https://github.example/${file.name}`, sha256: sha(file.bytes), size: file.bytes.length })) };
  const release = { id: 30, tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [{ name: 'workbench-update.json', url: 'https://api.github.com/repos/syjstc/aiui-workbench/releases/assets/31', browser_download_url: 'https://github.example/workbench-update.json' }, ...packages.map(file => ({ name: file.name, size: file.bytes.length, digest: 'sha256:' + sha(file.bytes) }))] };
  const storage = new Map([['workbench-update.json', Buffer.from(JSON.stringify({ ...manifest, version: previousVersion }))], ['AIUI-Workbench-0.2.0-win32-x64.zip', Buffer.from('old package')], ['notes.txt', Buffer.from('unrelated user file')]]);
  const target = { id: 7, tag_name: 'stable', name: `AIUI 工坊 ${previousVersion}`, body: manifest.notes, assets: [] }, operations = [], requests = [], uploads = new Map();
  let nextId = 50;
  const assets = () => [...storage].map(([name, bytes]) => ({ id: name, name, size: bytes.length, hash_algo: 'sha256', hash_value: sha(bytes) }));
  const fetcher = async (url, options = {}) => {
    requests.push({ url, authorization: options.headers?.Authorization });
    const method = options.method || 'GET';
    if (url === 'https://api.github.com/repos/syjstc/aiui-workbench/releases/latest') return json(release);
    if (url === 'https://github.example/workbench-update.json' || url === 'https://api.github.com/repos/syjstc/aiui-workbench/releases/assets/31') return json(manifest);
    if (url.startsWith(cnbUrls(repository).base)) {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop()), bytes = storage.get(name);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(method === 'HEAD' ? null : bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    if (url.startsWith('https://upload.example/')) {
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      if (name === failUpload) return new Response(null, { status: 503 });
      const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
      uploads.set(name, Buffer.concat(chunks)); operations.push('upload:' + name);
      return new Response(null, { status: 200 });
    }
    assert.ok(url.startsWith(base), url); assert.equal(options.headers.Authorization, 'Bearer scoped-cnb-test-token');
    if (url === base + '?page_size=100') return json([target]);
    if (url === base + '/tags/stable' || url === base + '/7' && method === 'GET') return json({ ...target, assets: assets() });
    if (url === base + '/7/asset-upload-url') {
      const body = JSON.parse(options.body); assert.equal(body.overwrite, true); assert.equal(body.ttl, 0);
      const name = encodeURIComponent(body.asset_name);
      return json({ upload_url: 'https://upload.example/' + name, verify_url: `${base}/7/asset-upload-confirmation/${nextId++}/${name}` });
    }
    if (url.includes('/7/asset-upload-confirmation/')) {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop()); storage.set(name, uploads.get(name)); operations.push('confirm:' + name); return json({});
    }
    if (url === base + '/7' && method === 'PATCH') { Object.assign(target, JSON.parse(options.body)); operations.push('publish'); return json({}); }
    if (method === 'DELETE') { const name = url.slice((base + '/7/assets/').length); storage.delete(name); operations.push('delete:' + name); return new Response(null, { status: 204 }); }
    assert.fail(url);
  };
  return { directory, packages, manifest, release, storage, target, assets, operations, requests, fetcher };
}

test('the mirror keeps immutable update filenames and adds fixed public download aliases without changing package bytes', async t => {
  const f = await fixture(t);
  const result = await syncCnbRelease({ repository, token: 'scoped-cnb-test-token', githubToken: 'scoped-github-test-token', localDirectory: f.directory, fetcher: f.fetcher, log() {} });
  assert.equal(result.manifestUrl, cnbUrls(repository).manifest);
  const published = JSON.parse(f.storage.get('workbench-update.json'));
  assert.equal(published.version, '0.3.0'); assert.ok(published.files.every(file => file.url.includes('AIUI-Workbench-0.3.0-')));
  for (const file of f.packages) {
    assert.deepEqual(f.storage.get(file.name), file.bytes);
    assert.deepEqual(f.storage.get(file.name.replace('-0.3.0-', '-latest-')), file.bytes);
  }
  assert.ok(f.operations.indexOf('confirm:workbench-update.json') > f.operations.indexOf('confirm:SHA256SUMS.txt'));
  assert.ok(f.operations.indexOf('delete:AIUI-Workbench-0.2.0-win32-x64.zip') > f.operations.indexOf('publish'));
  assert.equal(f.storage.has('AIUI-Workbench-0.2.0-win32-x64.zip'), false); assert.equal(f.storage.has('notes.txt'), true);
  assert.equal(f.requests.filter(request => !request.url.startsWith('https://api.')).some(request => request.authorization), false);
});

test('a failed staged upload preserves the previous public update manifest and old package', async t => {
  const f = await fixture(t, { failUpload: 'AIUI-Workbench-latest-win32-x64.zip' });
  await assert.rejects(syncCnbRelease({ repository, token: 'scoped-cnb-test-token', localDirectory: f.directory, fetcher: f.fetcher, log() {} }), /上传失败/);
  assert.equal(JSON.parse(f.storage.get('workbench-update.json')).version, '0.2.0');
  assert.equal(f.storage.has('AIUI-Workbench-0.2.0-win32-x64.zip'), true); assert.equal(f.operations.some(op => op.startsWith('delete:')), false);
});

test('corrupt local packages, prereleases and attempts to overwrite a newer CNB version never publish', async t => {
  const f = await fixture(t, { previousVersion: '0.4.0' });
  await assert.rejects(syncCnbRelease({ repository, token: 'scoped-cnb-test-token', localDirectory: f.directory, fetcher: f.fetcher, log() {} }), /更新的版本/);
  assert.deepEqual(f.operations, []);
  f.release.prerelease = true;
  await assert.rejects(syncCnbRelease({ repository, token: 'scoped-cnb-test-token', localDirectory: f.directory, fetcher: f.fetcher, log() {} }), /正式稳定/);
  f.release.prerelease = false;
  f.storage.set('workbench-update.json', Buffer.from(JSON.stringify({ ...f.manifest, version: '0.2.0' })));
  await fs.writeFile(path.join(f.directory, f.packages[0].name), Buffer.from('broken'));
  await assert.rejects(syncCnbRelease({ repository, token: 'scoped-cnb-test-token', localDirectory: f.directory, fetcher: f.fetcher, log() {} }), /校验失败/);
  assert.deepEqual(f.operations, []);
});

test('an identical repeated sync checks all server-side SHA256 values without transferring packages again', async t => {
  const f = await fixture(t);
  const options = { repository, token: 'scoped-cnb-test-token', localDirectory: f.directory, fetcher: f.fetcher, log() {} };
  await syncCnbRelease(options);
  f.operations.length = 0; f.requests.length = 0;
  const current = await syncCnbRelease({ ...options, localDirectory: path.join(f.directory, 'missing-directory') });
  assert.equal(current.unchanged, true); assert.deepEqual(f.operations, []);
  assert.equal(f.requests.some(request => request.url.startsWith('https://upload.example/')), false);
  const plan = mirrorPlan(f.release, f.manifest, repository), published = JSON.parse(f.storage.get('workbench-update.json'));
  const target = { ...f.target, assets: f.assets() };
  assert.equal(mirrorIsCurrent(plan, target, published), true);
  for (const change of [{ hash_value: 'a'.repeat(64) }, { hash_algo: 'md5' }, { size: 1 }]) {
    assert.equal(mirrorIsCurrent(plan, { ...target, assets: [{ ...target.assets[0], ...change }, ...target.assets.slice(1)] }, published), false);
  }
  assert.equal(mirrorIsCurrent(plan, { ...target, assets: [...target.assets, { name: 'AIUI-Workbench-0.1.0-win32-x64.zip' }] }, published), false);
});

test('the public mirror plan rejects an unsafe repository, duplicate platforms and a mismatched source version', async t => {
  const f = await fixture(t);
  assert.throws(() => cnbUrls('org/../repo'), /仓库格式/);
  assert.throws(() => mirrorPlan(f.release, { ...f.manifest, version: '0.4.0' }, repository), /版本不一致/);
  assert.throws(() => mirrorPlan(f.release, { ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] }, repository), /重复/);
});
