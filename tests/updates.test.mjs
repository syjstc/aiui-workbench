import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppUpdates, validateManifest } from '../core/updates.mjs';
import { atomicJson, sha } from '../core/util.mjs';
import { createManifest } from '../scripts/release-manifest.mjs';

const bytes = Buffer.from('integration update artifact');
const manifest = (version = '0.3.0') => ({ schemaVersion: 1, version, notes: '新版说明', releaseUrl: 'https://release.example/notes', files: [{ platform: 'darwin', arch: 'arm64', url: './app.zip', sha256: sha(bytes), size: bytes.length }] });
const json = value => new Response(JSON.stringify(value));
async function manager(t, fetcher, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-updates-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const updates = await new AppUpdates(home, { fetcher, version: '0.2.0', platform: 'darwin', arch: 'arm64', ...options }).init(); t.after(() => updates.close());
  return updates;
}
const custom = updates => updates.settings({ source: 'custom', sources: { custom: { manifestUrl: 'https://release.example/workbench-update.json' } } });

test('packaged repository defaults remain editable, survive restart and can be restored without resetting other preferences',async t=>{
  const updates=await manager(t,()=>assert.fail('settings do not fetch'));
  const defaults=updates.status().defaults;assert.equal(defaults.sources.github.repository,'syjstc/aiui-workbench');
  await updates.settings({sources:{github:{repository:'example/custom'}},autoCheck:false,intervalHours:168});
  const reopened=await new AppUpdates(updates.home).init();t.after(()=>reopened.close());assert.equal(reopened.status().sources.github.repository,'example/custom');
  await reopened.settings({sources:{github:{repository:reopened.status().defaults.sources.github.repository}}});
  assert.equal(reopened.status().sources.github.repository,'syjstc/aiui-workbench');assert.equal(reopened.status().autoCheck,false);assert.equal(reopened.status().intervalHours,168);
});

test('an explicitly unconfigured update source makes no network request or latest-version claim', async t => {
  let requests = 0; const updates = await manager(t, () => { requests++; throw new Error('unexpected request'); });
  await updates.settings({ sources: { github: { repository: '' } } });
  updates.start(); const status = await updates.check();
  assert.equal(requests, 0); assert.equal(status.configured, false); assert.equal(status.checkedAt, undefined); assert.equal(status.latest, null);
});
test('GitHub latest release resolves a version-matched manifest, follows HTTPS CDN redirects, verifies download bytes', async t => {
  const requests = [], updates = await manager(t, async url => {
    requests.push(url);
    if (url.endsWith('/releases/latest')) return json({ tag_name: 'v0.3.0', assets: [{ name: 'workbench-update.json', browser_download_url: 'https://github.com/test/repo/releases/download/v0.3.0/workbench-update.json' }] });
    if (url.endsWith('/workbench-update.json') && url.includes('github.com')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/workbench-update.json' } });
    if (url.endsWith('/workbench-update.json')) return json(manifest());
    if (url.endsWith('/app.zip')) return new Response(bytes); throw new Error(url);
  });
  await updates.settings({ sources: { github: { repository: 'https://github.com/test/repo' } } });
  const checked = await updates.check(); assert.equal(checked.checking, false); assert.equal(checked.updateAvailable, true);
  const [a, b] = await Promise.all([updates.download(), updates.download()]); assert.equal(a.path, b.path);
  assert.deepEqual(await fs.readFile(a.path), bytes); assert.equal(a.sha256, sha(bytes));
  assert.equal(requests.filter(url => url.endsWith('/app.zip')).length, 1);
});
test('switching to a domestic feed clears previous results and preserves each source across restart', async t => {
  const updates = await manager(t, async () => json(manifest()));
  await custom(updates); await updates.check(); await updates.download().catch(() => {});
  assert.ok(updates.latest); await updates.settings({ source: 'cnb', sources: { cnb: { manifestUrl: 'https://cnb.example/workbench-update.json' } } });
  assert.equal(updates.latest, null); assert.equal(updates.downloaded, null); assert.equal(updates.status().checkedAt, undefined);
  const next = await new AppUpdates(updates.home).init(); t.after(() => next.close());
  assert.equal(next.status().source, 'cnb'); assert.equal(next.status().sources.custom.manifestUrl, 'https://release.example/workbench-update.json');
  assert.equal(next.status().autoCheck, true);
});
test('checksum failure removes partial downloads and never exposes an installer', async t => {
  const updates = await manager(t, async url => url.endsWith('.json') ? json(manifest()) : new Response(Buffer.alloc(bytes.length, 9)));
  await custom(updates); await updates.check(); await assert.rejects(updates.download(), /校验失败/);
  assert.equal(updates.downloaded, null); assert.deepEqual(await fs.readdir(path.join(updates.home, 'updates/0.3.0')), []);
});
test('a failed refresh clears an earlier update; older versions are never offered for installation', async t => {
  let value = manifest(); const updates = await manager(t, async () => value ? json(value) : new Response('unavailable', { status: 503 }));
  await custom(updates); await updates.check(); assert.equal(updates.status().updateAvailable, true);
  value = null; await updates.check(); assert.equal(updates.latest, null); assert.match(updates.status().error, /503/);
  value = manifest('0.1.0'); await updates.check(); assert.equal(updates.status().updateAvailable, false); await assert.rejects(updates.download(), /没有/);
});
test('missing platform, prereleases, mismatched GitHub tags and insecure addresses fail safely', async t => {
  const updates = await manager(t, async url => url.endsWith('/latest') ? json({ tag_name: 'v0.4.0', assets: [{ name: 'workbench-update.json', browser_download_url: 'https://release.example/workbench-update.json' }] }) : json(manifest()));
  await updates.settings({ sources: { github: { repository: 'test/repo' } } }); await updates.check(); assert.match(updates.status().error, /版本号不一致/);
  await assert.rejects(updates.settings({ source: 'custom', sources: { custom: { manifestUrl: 'http://release.example/test' } } }), /HTTPS/);
  await assert.rejects(updates.settings({ source: 'custom', sources: { custom: { manifestUrl: 'https://user:password@release.example/test' } } }), /HTTPS/);
  assert.equal(validateManifest(manifest(), 'https://release.example/manifest.json', 'win32', 'x64').file, null);
  assert.throws(() => validateManifest(manifest('0.3.0-beta.1'), 'https://release.example/manifest.json', 'darwin', 'arm64'), /稳定/);
  const empty = manifest(); delete empty.files[0].url; assert.throws(() => validateManifest(empty, 'https://release.example/manifest.json', 'darwin', 'arm64'), /不能为空/);
  const unsafe = manifest(); unsafe.files[0].url = 'https://release.example/a%2fb.zip'; assert.throws(() => validateManifest(unsafe, 'https://release.example/m.json', 'darwin', 'arm64'), /文件名/);
});
test('redirects cannot downgrade HTTPS and source changes cannot race a check', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const updates = await manager(t, async () => { await pending; return new Response(null, { status: 302, headers: { location: 'http://release.example/data' } }); });
  await custom(updates); const checking = updates.check(); await assert.rejects(updates.settings({ source: 'cnb' }), /正在检查/);
  release(); await checking; assert.match(updates.status().error, /HTTPS/);
});
test('automatic startup checking respects disabled preferences and serialized release metadata round-trips', async t => {
  let count = 0; const updates = await manager(t, async () => { count++; return json(manifest()); }); await custom(updates);
  await updates.settings({ autoCheck: false }); updates.start(); assert.equal(count, 0); clearInterval(updates.timer);
  await updates.settings({ autoCheck: true }); updates.start(); await updates.checking; assert.equal(count, 1);
  const file = path.join(updates.home, 'AIUI App.zip'); await fs.writeFile(file, bytes);
  const value = await createManifest({ version: '0.3.0', files: [{ platform: 'darwin', arch: 'arm64', file }] });
  assert.equal(validateManifest(value, 'https://release.example/workbench-update.json', 'darwin', 'arm64').file.sha256, sha(bytes));
  assert.equal(value.files[0].url, './AIUI%20App.zip');
});
