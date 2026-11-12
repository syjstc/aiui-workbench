import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Knowledge } from '../core/knowledge.mjs';
import { DocumentSearch } from '../core/document-search.mjs';
import { documentNavigation } from '../core/document-navigation.mjs';
import { documentHeadings } from '../core/document-content.mjs';
import { documentImagePath, documentImages } from '../core/document-images.mjs';

const metadata = JSON.parse(await fs.readFile(new URL('../vendor/official/current.json', import.meta.url)));
const bundled = JSON.parse(await fs.readFile(new URL(`../vendor/official/${metadata.revision}/index.json`, import.meta.url)));
const paths = nodes => nodes.flatMap(node => [...(node.path ? [node.path] : []), ...paths(node.children)]);
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=', 'base64');
const old = 'a'.repeat(40), latest = 'b'.repeat(40);
async function fixture(t, { index = [{ path: 'documentation/0-guide/intro.md', title: 'Introduction', content: '# Introduction\n\nOffline guide.' }], fetcher, now } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-doc-library-'));
  const directory = path.join(home, 'knowledge', old);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify(index));
  await fs.writeFile(path.join(home, 'knowledge/current.json'), JSON.stringify({ status: 'ready', revision: old, documents: index.length }));
  const knowledge = await new Knowledge(home, { fetcher, now }).init();
  t.after(async () => { await knowledge.close(); await fs.rm(home, { recursive: true, force: true }); });
  return knowledge;
}

test('the complete official hierarchy retains every document once in either language', () => {
  for (const locale of ['zh-CN', 'en']) for (const sort of ['recommended', 'title', 'path']) {
    const catalog = documentNavigation(bundled, { locale, sort, revision: metadata.revision });
    const all = paths(catalog.tree);
    assert.equal(catalog.total, 468);
    assert.equal(all.length, bundled.length);
    assert.equal(new Set(all).size, bundled.length);
    assert.deepEqual(new Set(all), new Set(bundled.map(doc => doc.path)));
    if (sort === 'recommended') {
      assert.equal(catalog.tree[0].title, locale === 'en' ? 'Guide' : '指南');
      assert.match(all[0], locale === 'en' ? /quickstart\/index.en-US.md$/ : /quickstart\/index.md$/);
      assert.ok(catalog.tree.find(node => node.title === (locale === 'en' ? 'Framework' : '框架')).children.find(node => node.id.endsWith('/open-agent-format')).children.some(node => node.children.length > 2));
    }
  }
  const fallback = documentNavigation(bundled.filter(doc => !doc.path.startsWith('documentation/toc')));
  assert.equal(paths(fallback.tree).length, 466);
});

test('search finds unread documents and code beyond the reader chunk and reports full-corpus totals', () => {
  const index = Array.from({ length: 468 }, (_, i) => ({ path: `documentation/3-api/entry-${i}.md`, title: `Entry ${i}`, content: '# Entry\n' + (i === 467 ? 'padding\n'.repeat(6000) + '\n## Hidden code\n\n```js\nconst value = obscureTailIdentifier();\n```' : 'Unrelated introduction.') }));
  const search = new DocumentSearch(index);
  const result = search.search('OBSCURETAILIDENTIFIER', { limit: 1800, revision: old });
  assert.equal(result.searchedDocuments, 468);
  assert.equal(result.total, 1);
  assert.equal(result.documents[0].path, index[467].path);
  assert.equal(result.documents[0].fragment, '#hidden-code');
  assert.match(result.documents[0].excerpt, /obscureTailIdentifier/);
  assert.equal(search.search('', { limit: 1800 }).documents.length, 468);
  const first = search.search('', { limit: 50 });
  assert.equal(first.total, 468); assert.equal(first.nextOffset, 50);
  assert.equal(search.search('', { offset: 450, limit: 50 }).nextOffset, null);
});

test('Chinese questions find English APIs, multiple concepts must all match, and exact titles rank first', () => {
  const search = new DocumentSearch([
    { path: 'documentation/3-api/capture.en-US.md', title: 'Camera capture', content: '# Camera capture\n\n## Take a picture\nUse navigator.mediaDevices.getUserMedia(), then ImageCapture.takePhoto().' },
    { path: 'documentation/3-api/video.md', title: 'Camera preview', content: '# Camera preview\ngetUserMedia renders a camera stream.' },
    { path: 'documentation/3-api/unrelated.md', title: 'Photos', content: '# Photos\nTakePhoto is explained elsewhere.' },
  ]);
  const result = search.search('如何调用摄像头拍照');
  assert.equal(result.total, 1);
  assert.equal(result.documents[0].title, 'Camera capture');
  assert.ok(result.documents[0].matchedTerms.includes('getusermedia'));
  assert.equal(new DocumentSearch(bundled).search('如何保存用户设置').documents[0].path, 'documentation/4-tutorials/data/persist-settings.md');
});

test('section anchors skip fenced examples and distinguish repeated headings', () => {
  const headings = documentHeadings('# Intro\n\n```md\n## Not a heading\n```\n\n## **Example**\n\n## Example\n\n### Example\n');
  assert.deepEqual(headings.map(item => item.id), ['intro', 'example', 'example-1', 'example-2']);
});

test('all 81 bundled diagram references have original verified bytes for first-launch offline reading', async () => {
  const snapshot = new URL(`../vendor/official/${metadata.revision}/`, import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('images.json', snapshot)));
  const references = new Set(bundled.flatMap(doc => [...documentImages(doc)]));
  assert.equal(references.size, 81);
  for (const relative of references) {
    const entry = manifest.find(item => item.path === relative);
    assert.ok(entry, relative);
    const bytes = await fs.readFile(new URL(relative, snapshot));
    assert.equal(bytes.length, entry.size, relative);
    assert.equal(blob(bytes), entry.sha, relative);
  }
});

test('daily checks persist across restarts, respect manual/weekly settings, and retry failed updates without losing offline docs', async t => {
  let time = 100000000, calls = 0, offline = false;
  const fetcher = async () => { calls++; if (offline) throw new Error('network offline'); return Response.json({ sha: old }); };
  const knowledge = await fixture(t, { fetcher, now: () => time });
  assert.equal(knowledge.status().autoUpdate, true);
  await Promise.all([knowledge.checkIfDue(), knowledge.checkIfDue()]);
  assert.equal(calls, 1);
  assert.equal(knowledge.status().nextCheckAt, new Date(time + 86400000).toISOString());
  await knowledge.checkIfDue(); assert.equal(calls, 1);
  const restored = await new Knowledge(path.dirname(knowledge.dir), { fetcher, now: () => time }).init();
  t.after(() => restored.close());
  await restored.checkIfDue(); assert.equal(calls, 1);
  await knowledge.settings({ autoUpdate: false }); time += 8 * 86400000;
  await knowledge.checkIfDue(); assert.equal(calls, 1);
  await knowledge.settings({ autoUpdate: true, intervalHours: 168 });
  assert.equal(knowledge.status().nextCheckAt, new Date(time + 7 * 86400000).toISOString());
  time += 7 * 86400000; offline = true;
  await assert.rejects(knowledge.checkIfDue(), /network offline/);
  assert.equal(knowledge.status().revision, old);
  assert.match((await knowledge.read('documentation/0-guide/intro.md')).content, /Offline/);
  assert.equal(knowledge.status().nextCheckAt, new Date(time + 3600000).toISOString());
  assert.match(knowledge.status().error, /network offline/);
});

test('verified sync switches snapshots atomically, builds the new search index and caches documentation pictures offline', async t => {
  const sources = new Map([
    ['skills/aiui-dev/SKILL.md', Buffer.from('# AIUI skill')],
    ['skills/aiui-dev/assets/minimal-page.ink', Buffer.from('<page/>')],
    ['documentation/0-guide/bundle/publish.md', Buffer.from('# Publish\n\n![Workflow](../../image/publish/review-workflow.png)\n\n## New behavior\nFreshSnapshotToken')],
    ['documentation/image/publish/review-workflow.png', png],
  ]);
  let downloads = 0;
  const fetcher = async url => {
    if (url.endsWith('/commits/main')) return Response.json({ sha: latest });
    if (url.includes('/git/trees/')) return Response.json({ tree: [...sources].map(([path, bytes]) => ({ path, type: 'blob', size: bytes.length, sha: blob(bytes) })) });
    downloads++;
    const bytes = sources.get(url.split(`/${latest}/`)[1]);
    return new Response(bytes, { status: bytes ? 200 : 404 });
  };
  const knowledge = await fixture(t, { fetcher });
  assert.equal((await knowledge.search('FreshSnapshotToken')).length, 0);
  await knowledge.sync();
  assert.equal(knowledge.status().revision, latest);
  assert.equal((await knowledge.search('FreshSnapshotToken'))[0].fragment, '#new-behavior');
  assert.deepEqual(knowledge.status().images, { total: 1, cached: 1, missing: [] });
  const before = downloads;
  const args = { path: '../../image/publish/review-workflow.png', from: 'documentation/0-guide/bundle/publish.md' };
  const image = await knowledge.image(args);
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  assert.equal(downloads, before);
  const offline = await new Knowledge(path.dirname(knowledge.dir), { fetcher: () => { throw new Error('offline'); } }).init();
  t.after(() => offline.close());
  assert.equal((await offline.image(args)).dataUrl, image.dataUrl);
  await assert.rejects(offline.image({ ...args, path: 'file:///etc/passwd' }), /无效/);
  await assert.rejects(offline.image({ ...args, path: '../../image/unreferenced.png' }), /无效/);
  assert.equal((await knowledge.read('documentation/0-guide/intro.md', old)).revision, old);
});

test('a bad upstream snapshot keeps the current catalog and search, and document image URLs cannot escape the official asset directory', async t => {
  const knowledge = await fixture(t, { fetcher: async url => url.endsWith('/commits/main') ? Response.json({ sha: latest }) : url.includes('/git/trees/') ? Response.json({ tree: [{ path: 'skills/aiui-dev/SKILL.md', type: 'blob', sha: 'c'.repeat(40), size: 3 }] }) : new Response('bad') });
  await assert.rejects(knowledge.sync(), /完整性/);
  assert.equal(knowledge.status().revision, old);
  assert.equal((await knowledge.catalog()).total, 1);
  assert.equal((await knowledge.search('Offline')).length, 1);
  const from = 'documentation/0-guide/bundle/publish.md';
  assert.equal(documentImagePath('../../image/publish/review-workflow.png', from), 'documentation/image/publish/review-workflow.png');
  for (const href of ['../../../../etc/passwd.png', 'https://example.com/a.png', '//127.0.0.1/x.png', 'file:///etc/hosts', '../../image/../../secret.png', '../../image/%2e%2e/secret.png']) assert.equal(documentImagePath(href, from), null, href);
  assert.equal(documentImages(bundled.find(doc => doc.path === from)).size, 2);
});
