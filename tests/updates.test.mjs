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
  const updates = await new AppUpdates(home, { fetcher, version: '0.2.0', platform: 'darwin', arch: 'arm64', defaults: { source: 'github' }, ...options }).init(); t.after(() => updates.close());
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

const automaticDefaults = { source: 'auto', sources: { cnb: { manifestUrl: 'https://cnb.example/stable/workbench-update.json' }, github: { repository: 'official/workbench' } } };
const githubRelease = version => ({ tag_name: `v${version}`, assets: [{ name: 'workbench-update.json', browser_download_url: 'https://github.example/workbench-update.json' }] });
const automaticFetcher = ({ cnbVersion = '0.3.0', githubVersion = '0.3.0', download = () => new Response(bytes) } = {}) => async (url, options) => {
  if (url.endsWith('/releases/latest')) return json(githubRelease(githubVersion));
  if (url.endsWith('.json')) return json(manifest(url.includes('cnb.example') ? cnbVersion : githubVersion));
  return download(url, options);
};

test('fresh installs default to automatic official sources, while an existing manual choice and disabled checks survive', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-updates-migrate-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const fresh = await new AppUpdates(home).init(); t.after(() => fresh.close());
  assert.equal(fresh.status().source, 'auto');
  await atomicJson(fresh.file, { source: 'cnb', autoCheck: false, intervalHours: 168, sources: { cnb: { manifestUrl: 'https://example.test/my-feed.json' } } });
  const existing = await new AppUpdates(home).init(); t.after(() => existing.close());
  assert.equal(existing.status().source, 'cnb'); assert.equal(existing.status().autoCheck, false); assert.equal(existing.status().intervalHours, 168);
  assert.equal(existing.status().sources.cnb.manifestUrl, 'https://example.test/my-feed.json');
});

test('automatic checks prefer CNB for equal versions but never hide a newer stable GitHub release behind a lagging mirror', async t => {
  const updates = await manager(t, automaticFetcher(), { defaults: automaticDefaults });
  await updates.check(); assert.equal(updates.status().activeSource, 'cnb');
  updates.fetcher = automaticFetcher({ githubVersion: '0.4.0' });
  await updates.check(); assert.equal(updates.latest.version, '0.4.0'); assert.equal(updates.status().activeSource, 'github');
  assert.equal(updates.status().source, 'auto');
});

test('automatic download switches to identical backup bytes after a partial network failure and remembers the actual download source', async t => {
  const requested = [];
  const updates = await manager(t, automaticFetcher({ download: url => {
    requested.push(url);
    if (url.includes('cnb.example')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.error(new Error('connection lost')); } }));
    return new Response(bytes);
  } }), { defaults: automaticDefaults });
  await updates.check(); const downloaded = await updates.download();
  assert.equal(requested.length, 2); assert.equal(downloaded.source, 'github'); assert.equal(updates.status().activeSource, 'github');
  assert.equal(updates.status().source, 'auto'); assert.deepEqual(await fs.readFile(downloaded.path), bytes);
  assert.equal((await fs.readdir(path.dirname(downloaded.path))).some(file => file.endsWith('.part')), false);
  const reopened = await new AppUpdates(updates.home, { defaults: automaticDefaults, fetcher: automaticFetcher() }).init(); t.after(() => reopened.close());
  assert.equal(reopened.status().lastDownloadSource, 'github'); assert.equal(reopened.status().lastDownloadVersion, '0.3.0');
  await reopened.check(); assert.equal(reopened.status().activeSource, 'github');
});

test('an unavailable metadata source and a stalled package do not prevent using the healthy official source', async t => {
  const hold = setTimeout(() => {}, 5000); t.after(() => clearTimeout(hold));
  const pending = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const healthy = automaticFetcher();
  const updates = await manager(t, (url, options) => url.includes('cnb.example') ? pending(url, options) : healthy(url, options), { defaults: automaticDefaults, checkTimeout: 15, downloadIdleTimeout: 15 });
  await updates.check(); assert.equal(updates.status().activeSource, 'github'); assert.ok(updates.status().sourceResults.find(result => result.source === 'cnb').error);
  updates.fetcher = automaticFetcher({ download: (url, options) => url.includes('cnb.example') ? pending(url, options) : new Response(bytes) });
  await updates.check(); assert.equal(updates.status().activeSource, 'cnb');
  assert.equal((await updates.download()).source, 'github');
});

test('automatic failover never substitutes an older version or different package hash', async t => {
  const requested = [];
  const fallback = automaticFetcher({ download: url => { requested.push(url); return new Response(null, { status: 503 }); } });
  const updates = await manager(t, async (url, options) => {
    if (url === 'https://github.example/workbench-update.json') { const value = manifest(); value.files[0].sha256 = 'a'.repeat(64); return json(value); }
    return fallback(url, options);
  }, { defaults: automaticDefaults });
  await updates.check(); await assert.rejects(updates.download(), /503/); assert.equal(requested.length, 1); assert.equal(updates.downloaded, null);
  requested.length = 0; updates.fetcher = automaticFetcher({ githubVersion: '0.2.9', download: url => { requested.push(url); return new Response(null, { status: 404 }); } });
  await updates.check(); await assert.rejects(updates.download(), /404/); assert.equal(requested.length, 1);
});

test('manual source selection never fails over and automatic mode does not mix in user-edited repositories', async t => {
  const requested = [], healthy = automaticFetcher();
  const updates = await manager(t, (url, options) => { requested.push(url); return healthy(url, options); }, { defaults: automaticDefaults });
  await updates.settings({ sources: { github: { repository: 'another/project' }, cnb: { manifestUrl: 'https://another.test/feed.json' } } });
  await updates.check(); assert.ok(requested.includes('https://api.github.com/repos/official/workbench/releases/latest'));
  assert.equal(requested.some(url => url.includes('another')), false);
  await updates.settings({ source: 'cnb', sources: { cnb: automaticDefaults.sources.cnb } });
  requested.length = 0; updates.fetcher = async url => { requested.push(url); return url.endsWith('.json') ? json(manifest()) : new Response(null, { status: 503 }); };
  await updates.check(); await assert.rejects(updates.download(), /503/);
  assert.equal(requested.some(url => url.includes('github')), false); assert.equal(updates.status().source, 'cnb');
});

test('unavailable official sources clear stale results while manual errors keep their translatable message', async t => {
  const updates = await manager(t, automaticFetcher(), { defaults: automaticDefaults });
  await updates.check(); assert.equal(updates.status().updateAvailable, true);
  updates.fetcher = async () => new Response(null, { status: 503 });
  const failed = await updates.check();
  assert.equal(failed.latest, null); assert.equal(failed.updateAvailable, false);
  assert.equal(failed.error, '官方更新源暂时不可用，请稍后重试或手动选择更新源');
  assert.ok(failed.sourceResults.every(result => result.error.includes('HTTP 503')));
  await updates.settings({ source: 'cnb' });
  assert.equal((await updates.check()).error, '更新源请求失败：HTTP 503');
});
