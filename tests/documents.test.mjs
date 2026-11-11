import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Knowledge } from '../core/knowledge.mjs';
import { documentCatalog, documentLink, resolveDocumentLink } from '../core/document-links.mjs';

const metadata = JSON.parse(await fs.readFile(new URL('../vendor/official/current.json', import.meta.url)));
const index = JSON.parse(await fs.readFile(new URL(`../vendor/official/${metadata.revision}/index.json`, import.meta.url)));
const catalog = documentCatalog(index);
const from = 'documentation/0-guide/basic/ai/llm.md';
const knowledge = new Knowledge(path.join(os.tmpdir(), 'aiui-bundled-doc-link-tests'));
knowledge.meta = metadata;

test('every public documentation link in the bundled official snapshot resolves offline', () => {
  let count = 0;
  for (const doc of index) for (const match of doc.content.matchAll(/(?<!!)\]\((\/AIUI[^\s)]+)/g)) {
    const target = resolveDocumentLink(documentLink(match[1], doc.path), catalog);
    assert.ok(target, `${doc.path}: ${match[1]}`);
    assert.ok(index.some(item => item.path === target.path));
    count++;
  }
  assert.ok(count > 700);
});

test('guide, API, relative, absolute and GitHub links retain the current snapshot and fragments', async () => {
  const cases = [
    ['/AIUI/guide/basic-ai-asr', 'documentation/0-guide/basic/ai/asr.md'],
    ['/AIUI/guide/basic-ai-tts', 'documentation/0-guide/basic/ai/tts.md'],
    ['/AIUI/api/ai-language-model#使用工具-tools', 'documentation/3-api/ai/language-model.md'],
    ['https://js.rokid.com/AIUI/guide/basic-ai-tts', 'documentation/0-guide/basic/ai/tts.md'],
    ['//yodaos-project.github.io/AIUI/components/view', 'documentation/2-components/view.md'],
    ['https://github.com/yodaos-project/AIUI/blob/main/documentation/0-guide/basic/ai/tts.md', 'documentation/0-guide/basic/ai/tts.md'],
    ['https://raw.githubusercontent.com/jsar-project/AIUI/main/documentation/0-guide/basic/ai/tts.md', 'documentation/0-guide/basic/ai/tts.md'],
    ['./tts.md#基本用法', 'documentation/0-guide/basic/ai/tts.md'],
    ['#注意事项', from],
    ['/AIUI/guide/bundle/cli', 'documentation/0-guide/bundle/cli.md'],
  ];
  for (const [href, expected] of cases) {
    const doc = await knowledge.read(href, metadata.revision, from);
    assert.equal(doc.path, expected, href);
    assert.equal(doc.revision, metadata.revision);
    assert.match(doc.source, new RegExp(`/blob/${metadata.revision}/`));
    if (href.includes('#')) assert.equal(decodeURIComponent(doc.fragment), href.slice(href.indexOf('#')));
  }
  assert.equal((await knowledge.read('/AIUI/guide/basic-ai-tts', metadata.revision, from.replace('.md', '.en-US.md'))).path, 'documentation/0-guide/basic/ai/tts.en-US.md');
  assert.equal((await knowledge.read('/AIUI/guide/basic-ai-tts?lang=zh-CN', metadata.revision, from.replace('.md', '.en-US.md'))).path, 'documentation/0-guide/basic/ai/tts.md');
  assert.equal((await knowledge.read('./tts.md', metadata.revision, from.replace('.md', '.en-US.md'))).path, 'documentation/0-guide/basic/ai/tts.md');
});

test('external destinations cannot masquerade as a local official document, and missing pages stay local', async () => {
  for (const href of ['https://example.com/AIUI/guide/basic-ai-tts', 'https://js.rokid.com.evil.test/AIUI/guide/basic-ai-tts', 'https://user@js.rokid.com/AIUI/guide/basic-ai-tts', 'https://js.rokid.com:8080/AIUI/guide/basic-ai-tts', 'javascript:alert(1)', 'file:///etc/hosts', 'https://github.com/other/AIUI/blob/main/documentation/0-guide/basic/ai/tts.md']) assert.equal(documentLink(href, from), null, href);
  assert.equal(documentLink('https://github.com/yodaos-project/AIUI', from), null);
  await assert.rejects(knowledge.read('/AIUI/guide/missing-document', metadata.revision, from), /没有此文档/);
  await assert.rejects(knowledge.read('../secret'), /无效/);
});

test('recommended order follows the official TOC, explicit sorts and pagination cover the entire snapshot', async () => {
  assert.deepEqual((await knowledge.search('', { limit: 6 })).map(doc => doc.path), [
    'documentation/0-guide/quickstart/index.md',
    'documentation/0-guide/quickstart/intro.md',
    'documentation/0-guide/quickstart/quickstart.md',
    'documentation/0-guide/quickstart/first-chat.md',
    'documentation/0-guide/quickstart/first-immersive.md',
    'documentation/0-guide/quickstart/ai-dev.md',
  ]);
  assert.deepEqual((await knowledge.search('', { locale: 'en', limit: 3 })).map(doc => doc.path), [
    'documentation/0-guide/quickstart/index.en-US.md',
    'documentation/0-guide/quickstart/intro.en-US.md',
    'documentation/0-guide/quickstart/quickstart.en-US.md',
  ]);
  const recommended = await knowledge.search('LanguageModel', { limit: 50 });
  for (let i = 1; i < recommended.length; i++) assert.ok(recommended[i - 1].score >= recommended[i].score);
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  for (const sort of ['recommended', 'title', 'path']) {
    const all = [];
    for (let offset = 0; offset < index.length; offset += 50) all.push(...await knowledge.search('', { sort, offset, limit: 50 }));
    assert.equal(all.length, index.length);
    assert.equal(new Set(all.map(doc => doc.path)).size, index.length);
    if (sort !== 'recommended') for (const language of [false, true]) {
      const localized = all.filter(doc => doc.path.includes('.en-US.') === language);
      for (let i = 1; i < localized.length; i++) assert.ok(collator.compare(localized[i - 1][sort === 'title' ? 'title' : 'path'], localized[i][sort === 'title' ? 'title' : 'path']) <= 0);
    }
  }
});

test('link resolution and ordering use the requested snapshot rather than current TOC metadata', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-doc-revisions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const saved = new Knowledge(home), old = 'a'.repeat(40), current = 'b'.repeat(40);
  for (const [revision, page] of [[old, 'first'], [current, 'second']]) {
    const directory = path.join(home, 'knowledge', revision);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify([
      { path: 'documentation/toc.json', title: 'toc', content: JSON.stringify([{ id: '0-guide', slug: 'guide', children: [{ id: 'intro', docPath: `0-guide/${page}.md` }] }]) },
      { path: `documentation/0-guide/${page}.md`, title: page, content: `# ${page}` },
    ]));
  }
  saved.meta.revision = current;
  assert.equal((await saved.read('/AIUI/guide/intro', old)).path, 'documentation/0-guide/first.md');
  assert.equal((await saved.read('/AIUI/guide/intro')).path, 'documentation/0-guide/second.md');
  assert.equal((await saved.search('', { revision: old }))[0].title, 'first');
});
