import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startWeb } from '../web/server.mjs';
import { startDaemon } from '../core/daemon.mjs';
import { atomicJson } from '../core/util.mjs';

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-web-test-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const daemon = await startDaemon(home); t.after(() => daemon.close());
  const opened = [], web = await startWeb({ home, open: async (...args) => { opened.push(args); } }); t.after(() => web.close());
  const key = new URLSearchParams(new URL(web.url).hash.slice(1)).get('key');
  const post = (route, data, headers = {}) => fetch(web.origin + '/api/' + route, { method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const login = await post('session', { key }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { home, daemon, web, opened, key, cookie, post: (route, data, headers) => post(route, data, { Cookie: cookie, ...headers }) };
}
test('Web entry is separate from preview, authenticated and rejects cross-site requests and hostile Host headers', async t => {
  const { web, daemon, key, cookie, post } = await setup(t);
  assert.notEqual(web.origin, daemon.connection.origin);
  const page = await fetch(web.origin + '/renderer/index.html'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text(); assert.ok(!html.includes(key)); assert.ok(!html.includes(daemon.connection.token));
  assert.equal((await fetch(web.origin + '/api/health')).status, 401);
  assert.equal((await post('session', { key: 'wrong' })).status, 401);
  assert.equal((await post('call', { tool: 'aiui_status' }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await fetch(web.origin + '/api/health', { headers: { Cookie: cookie, Origin: daemon.connection.origin } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => { const request = http.get(web.origin + '/api/health', { headers: { Cookie: cookie, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(hostileHost, 403);
  assert.equal((await post('call', { tool: 'arbitrary' })).status, 400);
});
test('Web and MCP/core reuse the same project registry, directory picker and local photos', async t => {
  const { home, daemon, web, post, cookie, opened } = await setup(t);
  const directory = path.join(home, 'project/agent'); await fs.mkdir(path.join(directory, 'pages'), { recursive: true });
  await atomicJson(path.join(directory, 'app.json'), { name: 'Web imported', version: '1.0.0', pages: ['pages/index'] });
  await fs.writeFile(path.join(directory, 'pages/index.ink'), '<page><text>hello</text></page>');
  const response = await post('call', { tool: 'aiui_project_import', args: { directory } }); assert.equal(response.status, 200);
  const project = (await response.json()).result; assert.equal(daemon.service.projects.list()[0].id, project.id);
  const listing = await fetch(web.origin + '/api/directories?path=' + encodeURIComponent(home), { headers: { Cookie: cookie } });
  assert.ok((await listing.json()).result.directories.some(item => item.name === 'project'));
  const bytes = await fs.readFile(new URL('../assets/icon.png', import.meta.url));
  const photo = await post('photo', { data: bytes.toString('base64') }); assert.equal(photo.status, 200);
  const file = (await photo.json()).result; assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await post('photo', { data: Buffer.from('fake image').toString('base64') })).status, 400);
  assert.equal((await post('official', { url: 'file:///etc/hosts' })).status, 400);
  assert.equal((await post('official', { url: 'https://aiui.rokid.com/space' })).status, 200); assert.equal(opened[0][0], 'https://aiui.rokid.com/space');
  assert.equal((await post('reveal', { path: file })).status, 200); assert.equal(opened[1][1].reveal, true);
});

test('binary file upload streams APK-sized inputs, preserves names and rejects unauthenticated or unsafe writes', async t => {
  const { web, post, cookie, home } = await setup(t);
  const bytes = Buffer.alloc(17 * 1024 * 1024, 42), name = "安装 test's.apk";
  const upload = (value, headers = {}) => fetch(web.origin + '/api/upload?name=' + encodeURIComponent(value), { method: 'POST', headers: { Origin: web.origin, Cookie: cookie, 'Content-Type': 'application/octet-stream', ...headers }, body: bytes });
  assert.equal((await upload(name, { Cookie: '' })).status, 401);
  assert.equal((await upload('../escape.apk')).status, 400);
  assert.equal((await upload(name, { Origin: 'https://evil.example' })).status, 403);
  const first = await upload(name); assert.equal(first.status, 200);
  const file = (await first.json()).result;
  assert.equal(path.basename(file), name); assert.ok(file.startsWith(path.join(home, 'web-imports') + path.sep));
  assert.deepEqual(await fs.readFile(file), bytes);
  const second = await upload(name); const another = (await second.json()).result;
  assert.notEqual(file, another);
  const forbidden = await post('call', { tool: 'aiui_glasses_shell', args: { command: 'reboot' } }); assert.equal(forbidden.status, 400);
});
