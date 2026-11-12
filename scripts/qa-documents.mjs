import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, _electron as electron } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { startWeb } from '../web/server.mjs';
import { ROOT, atomicJson, sleep } from '../core/util.mjs';

const packaged = process.argv.includes('--packaged');
const desktop = packaged || process.argv.includes('--desktop');
const home = path.join(ROOT, '.local/documents-qa', `${Date.now()}-${process.pid}`);
const output = path.join(ROOT, 'output/qa/documents');
await fs.mkdir(output, { recursive: true });
const report = { mode: packaged ? 'packaged' : desktop ? 'desktop' : 'web', home, checks: [], errors: [], external: [], startedAt: new Date().toISOString() };
let daemon, web, browser, app, page;
const guide = 'documentation/0-guide/basic/ai/llm.md';
const longApi = 'documentation/3-api/ai/language-model.md';
const publish = 'documentation/0-guide/bundle/publish.md';
const readPaths = [];
async function until(work, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await work()) return; await sleep(80); }
  throw new Error('Documentation UI verification timed out');
}
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
const titles = () => page.locator('.doc-result').evaluateAll(buttons => buttons.map(button => button.title));
const title = () => page.locator('.doc-title').textContent();
async function ready(pathname) {
  const document = await daemon.service.knowledge.read(pathname);
  await until(async () => await title() === document.title && await page.locator('.doc-reader').getAttribute('aria-busy') === 'false');
}
async function openGuide() {
  await search('大语言模型');
  await page.locator(`.doc-list button[title="${guide}"]`).waitFor();
  await page.locator(`.doc-list button[title="${guide}"]`).click();
  await ready(guide);
}
async function search(query) {
  const sort = await page.getByLabel('文档排序', { exact: true }).inputValue();
  const expected = (await daemon.service.knowledge.search(query, { sort, limit: 1800 })).map(doc => doc.path);
  await page.getByLabel('搜索官方资料', { exact: true }).fill(query);
  await until(async () => await page.getByLabel('文档列表', { exact: true }).getAttribute('aria-busy') === 'false' && JSON.stringify(await titles()) === JSON.stringify(expected));
}
try {
  daemon = await startDaemon(home);
  daemon.service.knowledge.sync = async () => daemon.service.knowledge.status();
  daemon.service.sdk.check = async () => daemon.service.sdk.status();
  const baseIndex = daemon.service.knowledge.index.bind(daemon.service.knowledge);
  const indexed = (await baseIndex()).map(doc => doc.path === longApi ? { ...doc, content: doc.content + '\n\n' + '长文分页检查。\n\n'.repeat(5000) + '\n\n## QA Long Tail\n\nqaUnopenedTailToken 长文定位终点。' } : doc);
  daemon.service.knowledge.index = async (revision = daemon.service.knowledge.meta.revision) => revision === daemon.service.knowledge.meta.revision ? indexed : baseIndex(revision);
  // Exercise long fragments, missing documents and delayed responses without
  // changing the bundled snapshot or the user's cached documentation.
  const read = daemon.service.knowledge.read.bind(daemon.service.knowledge);
  let delayed = false;
  daemon.service.knowledge.read = async (...args) => {
    if (delayed && String(args[0]).includes('basic-ai-tts')) await sleep(500);
    const doc = await read(...args);
    readPaths.push(doc.path);
    if (doc.path === guide) doc.content += '\n\n[页内定位](#基本用法) · [长文末尾](/AIUI/api/ai-language-model#qa-long-tail) · [未同步文档](/AIUI/guide/qa-missing)';
    return doc;
  };
  if (desktop) {
    app = await electron.launch({ ...(packaged ? { executablePath: process.env.AIUI_QA_EXECUTABLE || path.join(ROOT, 'output/desktop/AIUI Workshop-darwin-arm64/AIUI Workshop.app/Contents/MacOS/AIUI Workshop') } : {}), args: packaged ? [] : [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
    page = await app.firstWindow();
    await app.evaluate(({ shell }) => { globalThis.documentationExternal = []; shell.openExternal = async url => { globalThis.documentationExternal.push(url); return true; }; });
  } else {
    web = await startWeb({ home, open: async url => { report.external.push(url); } });
    browser = await chromium.launch({ executablePath: process.env.AIUI_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    await page.goto(web.url);
  }
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('.sidebar').waitFor();
  await page.evaluate(() => { localStorage.setItem('aiui-workbench.locale', 'zh-CN'); localStorage.removeItem('aiui-doc-sort'); });
  await page.reload();
  await page.getByRole('button', { name: '官方资料', exact: true }).click();
  const originalUrl = page.url();
  await check('the entire official catalog is available immediately with nested sections and no manual pagination', async () => {
    await ready('documentation/0-guide/quickstart/index.md');
    const catalog = await daemon.service.knowledge.catalog();
    assert.equal(catalog.total, 468);
    const roots = page.locator('.doc-list>.doc-tree>li>.doc-tree-row .doc-tree-label>span');
    assert.deepEqual(await roots.allTextContents(), catalog.tree.map(node => node.title));
    const framework = page.locator('li[data-node-id="zh/1-framework"]>.doc-tree-row .doc-tree-toggle');
    await framework.click();
    const pageToggle = page.locator('li[data-node-id="zh/1-framework/open-agent-format/page"]>.doc-tree-row .doc-tree-toggle');
    if (await pageToggle.getAttribute('aria-expanded') !== 'true') await pageToggle.click();
    await page.locator('.doc-tree-label[title="documentation/1-framework/open-agent-format/page-lifecycle.md"]').waitFor();
    assert.equal(await page.getByRole('button', { name: '加载更多文档', exact: true }).count(), 0);
    assert.match(await page.locator('.doc-search-scope').textContent(), /468/);
    await page.screenshot({ path: path.join(output, `${report.mode}-reading-order.png`) });
  });
  await check('title and path sorting include the full hierarchy and preserve the open document', async () => {
    const selected = await title();
    for (const sort of ['title', 'path']) {
      await page.getByLabel('文档排序', { exact: true }).selectOption(sort);
      const catalog = await daemon.service.knowledge.catalog({ sort });
      await until(async () => JSON.stringify(await page.locator('.doc-list>.doc-tree>li>.doc-tree-row .doc-tree-label>span').allTextContents()) === JSON.stringify(catalog.tree.map(node => node.title)));
      assert.equal(await title(), selected);
    }
  });
  await check('the selected order survives reload and search retains relevance ordering', async () => {
    await page.reload();
    await page.getByRole('button', { name: '官方资料', exact: true }).click();
    assert.equal(await page.getByLabel('文档排序', { exact: true }).inputValue(), 'path');
    await page.getByLabel('文档排序', { exact: true }).selectOption('recommended');
    await openGuide();
    const expected = (await daemon.service.knowledge.search('大语言模型', { limit: 1800 })).map(doc => doc.path);
    assert.deepEqual(await titles(), expected);
  });
  await check('full-text search finds an unopened long-document tail and opens its exact section without Load more', async () => {
    assert.ok(!readPaths.includes(longApi));
    await search('qaUnopenedTailToken');
    assert.deepEqual(await titles(), [longApi]);
    assert.ok(!readPaths.includes(longApi));
    await page.locator('.doc-result mark').filter({ hasText: 'qaUnopenedTailToken' }).waitFor();
    await page.locator('.doc-result').click();
    await ready(longApi);
    await page.locator('.doc-body #qa-long-tail').waitFor({ state: 'visible' });
    assert.ok(await page.locator('.doc-body').evaluate(element => element.scrollTop) > 10000);
    assert.equal(await page.getByRole('button', { name: '继续读取文档', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, `${report.mode}-full-text-search.png`) });
  });
  await check('daily/weekly/manual document update settings persist across reloads', async () => {
    const setting = page.getByLabel('文档自动更新', { exact: true });
    assert.equal(await setting.inputValue(), '24');
    await setting.selectOption('168');
    await until(() => daemon.service.knowledge.status().intervalHours === 168);
    await page.reload();
    await page.getByRole('button', { name: '官方资料', exact: true }).click();
    await until(async () => await page.getByLabel('文档自动更新', { exact: true }).inputValue() === '168');
    await page.getByLabel('文档自动更新', { exact: true }).selectOption('manual');
    await until(() => !daemon.service.knowledge.status().autoUpdate);
    await page.getByLabel('文档自动更新', { exact: true }).selectOption('24');
    await until(() => daemon.service.knowledge.status().autoUpdate && daemon.service.knowledge.status().intervalHours === 24);
  });
  await check('the real submission workflow diagrams render from the offline bundle and enlarge in the reader', async () => {
    daemon.service.knowledge.fetcher = () => { throw new Error('offline image verification'); };
    await search('提审');
    await page.locator(`.doc-result[title="${publish}"]`).click();
    await ready(publish);
    await until(async () => await page.locator('.doc-image img').count() === 2 && await page.locator('.doc-image img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
    const originalImage = await page.locator('.doc-image img').first().elementHandle();
    await sleep(1500);
    assert.ok(await originalImage.evaluate(element => element.isConnected), 'Service polling must preserve image and link nodes');
    const workflow = page.locator('.doc-image>button').first();
    await workflow.click();
    await page.getByRole('dialog', { name: '文档图示', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `${report.mode}-workflow-image.png`) });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '文档图示', exact: true }).waitFor({ state: 'hidden' });
  });
  await check('the screenshot speech links and API reference open internally, with back/forward restoring scroll', async () => {
    await openGuide();
    const body = page.locator('.doc-body');
    const asr = body.getByRole('link', { name: '语音识别', exact: true });
    await asr.scrollIntoViewIfNeeded();
    const position = await body.evaluate(element => element.scrollTop);
    await asr.click();
    await ready('documentation/0-guide/basic/ai/asr.md');
    await page.getByRole('button', { name: '返回上一篇文档', exact: true }).click();
    await ready(guide);
    assert.ok(Math.abs(await body.evaluate(element => element.scrollTop) - position) <= 2);
    await page.getByRole('button', { name: '前进到下一篇文档', exact: true }).click();
    await ready('documentation/0-guide/basic/ai/asr.md');
    await body.getByRole('link', { name: '语音播报', exact: true }).click();
    await ready('documentation/0-guide/basic/ai/tts.md');
    await body.getByRole('link', { name: '大语言模型', exact: true }).click();
    await ready(guide);
    await body.getByRole('link', { name: '大语言模型 (API 参考)', exact: true }).click();
    await ready('documentation/3-api/ai/language-model.md');
    assert.equal(page.url(), originalUrl);
    assert.equal(page.context().pages().length, 1);
  });
  await check('same-page fragments and long-document fragments locate headings without moving the outer page', async () => {
    await openGuide();
    const body = page.locator('.doc-body');
    await body.getByRole('link', { name: '页内定位', exact: true }).click();
    await until(async () => Math.abs(await body.locator('#基本用法').evaluate(element => element.getBoundingClientRect().top) - await body.evaluate(element => element.getBoundingClientRect().top) - 26) <= 2);
    await body.getByRole('link', { name: '长文末尾', exact: true }).click();
    await body.locator('#qa-long-tail').waitFor();
    assert.ok(await body.evaluate(element => element.scrollTop) > 10000);
    assert.equal(await page.locator('.content').evaluate(element => element.scrollTop), 0);
  });
  await check('missing local documents keep the current page and delayed clicks cannot replace a newer selection', async () => {
    await openGuide();
    await page.locator('.doc-body').getByRole('link', { name: '未同步文档', exact: true }).click();
    await page.locator('.toast').filter({ hasText: '资料尚未同步或该版本没有此文档，请先同步官方资料' }).waitFor();
    assert.equal(await title(), '大语言模型');
    delayed = true;
    await page.locator('.doc-body').getByRole('link', { name: '语音播报', exact: true }).click();
    await page.locator('.doc-body').getByRole('link', { name: '语音识别', exact: true }).click();
    await ready('documentation/0-guide/basic/ai/asr.md');
    await sleep(650);
    assert.equal(await title(), '语音识别');
    delayed = false;
  });
  await check('only an explicit View original click opens the official source', async () => {
    if (desktop) report.external = await app.evaluate(() => globalThis.documentationExternal);
    assert.deepEqual(report.external, []);
    await page.getByRole('button', { name: '查看原文', exact: true }).click();
    if (desktop) report.external = await app.evaluate(() => globalThis.documentationExternal);
    await until(() => report.external.length === 1);
    assert.match(report.external[0], /github\.com\/yodaos-project\/AIUI\/blob\/[a-f0-9]{40}\/documentation\//);
  });
  await page.setViewportSize({ width: 1080, height: 740 });
  await openGuide();
  const closeToast = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await closeToast.isVisible()) await closeToast.click();
  await page.locator('.doc-body').getByRole('link', { name: '语音播报', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${report.mode}-internal-links-1080.png`) });
  assert.deepEqual(report.errors, []);
} finally {
  if (app) await app.close();
  if (browser) await browser.close();
  if (web) await web.close();
  if (daemon) await daemon.close();
  report.finishedAt = new Date().toISOString();
  await atomicJson(path.join(output, `${report.mode}-verification.json`), report);
}
