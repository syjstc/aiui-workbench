import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect } from '../core/client.mjs';
import { installMcpLauncher } from '../core/mcp-launcher.mjs';
import { startDaemon } from '../core/daemon.mjs';
import { ROOT, atomicJson, id, run, sleep } from '../core/util.mjs';

const statusTool = { name: 'aiui_status', description: 'Service status', inputSchema: { type: 'object', properties: {} } };
const futureTool = { name: 'aiui_future_echo', description: 'A tool absent from the bridge build', inputSchema: { type: 'object', properties: { text: { type: 'string' }, futureParameter: { type: 'integer', minimum: 10 } }, required: ['text', 'futureParameter'] } };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-mcp-compatible-')), servers = [], clients = [], closers = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const close of closers) await close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, servers, clients, closers };
}
async function service(f, version, { tools = [statusTool], legacy = false, capabilities = { capabilities: [] }, invoke } = {}) {
  const token = id(), requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + token) { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, version, pid: process.pid }));
    if (req.url === '/api/tools') {
      if (legacy) { res.statusCode = 404; return res.end('{}'); }
      return res.end(JSON.stringify({ schemaVersion: 1, serviceVersion: version, instructions: 'Use live service tools', tools }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    if (await invoke?.(request, req, res)) return;
    const result = request.tool === 'aiui_capabilities_get' ? capabilities : { version, tool: request.tool, args: request.args, jobs: [{ status: 'running' }], clients: [{ name: 'desktop', lastSeen: Date.now() }] };
    res.end(JSON.stringify({ result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); f.servers.push(server);
  const connection = { origin: 'http://127.0.0.1:' + server.address().port, token, pid: process.pid, version, startedAt: new Date().toISOString() };
  await atomicJson(path.join(f.home, 'connection.json'), connection);
  return { server, requests, connection };
}
async function mcp(f, entry = path.join(ROOT, 'mcp/server.mjs')) {
  const client = new Client({ name: 'mcp-compatibility-test', version: '1.0.0' }); f.clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, AIUI_WORKBENCH_HOME: f.home }, stderr: 'pipe' }), { timeout: 10000 });
  return client;
}
async function retainedEntry(f) {
  const retained = path.join(f.home, 'retained app');
  await fs.mkdir(path.join(retained, 'mcp'), { recursive: true });
  await fs.cp(path.join(ROOT, 'core'), path.join(retained, 'core'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'mcp/server.mjs'), path.join(retained, 'mcp/server.mjs'));
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(retained, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await atomicJson(path.join(retained, 'package.json'), { version: '0.0.1', type: 'module' });
  return path.join(retained, 'mcp/server.mjs');
}
async function until(check) { for (let i = 0; i < 60; i++) { if (await check()) return; await sleep(50); } throw new Error('Notification did not arrive'); }

test('MCP reuses older, newer and non-semver services even with active jobs and UI', async t => {
  const f = await fixture(t);
  for (const version of ['0.0.1', '99.0.0', 'development-build']) {
    const live = await service(f, version);
    const client = await connect(f.home, { requireCurrentVersion: false, autoStart: false });
    assert.equal(client.connection.version, version);
    assert.equal((await client.call('aiui_status')).version, version);
    assert.equal(live.server.listening, true);
    assert.equal(live.requests.some(request => request.actor === 'version-handover'), false);
  }
});

test('a retained older MCP entry discovers future tools, parameters and restart notifications', async t => {
  const f = await fixture(t), retained = await retainedEntry(f);
  const first = await service(f, '0.2.0');
  const client = await mcp(f, retained);
  assert.equal(client.getServerVersion().version, '0.0.1');
  assert.deepEqual((await client.listTools()).tools, [statusTool]);
  let notices = 0; client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notices++; });
  const second = await service(f, '99.0.0', { tools: [futureTool, statusTool] });
  first.server.closeAllConnections(); await new Promise(resolve => first.server.close(resolve));
  await until(() => notices > 0);
  assert.deepEqual((await client.listTools()).tools, [futureTool, statusTool]);
  const result = await client.callTool({ name: futureTool.name, arguments: { text: 'unchanged request', futureParameter: 27 } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).args, { text: 'unchanged request', futureParameter: 27 });
  assert.equal(second.requests.filter(request => request.tool === futureTool.name).length, 1);
  const resource = await client.readResource({ uri: 'aiui://tools' });
  assert.equal(JSON.parse(resource.contents[0].text).serviceVersion, '99.0.0');
  const prompt=await client.getPrompt({name:'develop-aiui',arguments:{request:'Verify this app'}});
  assert.match(prompt.messages[0].content.text,/Use live service tools/);assert.doesNotMatch(prompt.messages[0].content.text,/aiui_workflow_start|aiui_project_files/);
});

test('an older retained MCP entry cold-starts the registered current installation', async t => {
  const f = await fixture(t), retained = await retainedEntry(f);
  await installMcpLauncher(f.home);
  f.closers.push(async () => {
    const connection = JSON.parse(await fs.readFile(path.join(f.home, 'connection.json'), 'utf8'));
    process.kill(connection.pid, 'SIGTERM');
    // Windows forcibly terminates SIGTERM targets without running JS cleanup;
    // a stale connection file is valid and will be rejected by discovery.
    for (let i = 0; i < 60; i++) { try { process.kill(connection.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; } await sleep(50); }
    throw new Error('Isolated daemon did not stop');
  });
  const client = await mcp(f, retained), resource = await client.readResource({ uri: 'aiui://tools' });
  const expected = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(client.getServerVersion().version, '0.0.1');
  assert.equal(JSON.parse(resource.contents[0].text).serviceVersion, expected);
});

test('a crashed startup owner does not permanently block MCP cold start', async t => {
  const f = await fixture(t); await atomicJson(path.join(f.home, 'startup.lock'), { pid: 1073741823 });
  const client = await connect(f.home, { requireCurrentVersion: false });
  f.closers.push(async () => {
    process.kill(client.connection.pid, 'SIGTERM');
    for (let i = 0; i < 60; i++) { try { process.kill(client.connection.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; } await sleep(50); }
  });
  assert.ok((await client.catalog()).tools.some(tool => tool.name === 'aiui_tools_list'));
});

test('a retiring daemon cannot remove a replacement service connection', async t => {
  const f = await fixture(t), old = await startDaemon(f.home); let closed = false;
  f.closers.push(() => closed ? undefined : old.close());
  const replacement = await startDaemon(f.home); f.closers.push(() => replacement.close());
  await old.close(); closed = true;
  const saved = JSON.parse(await fs.readFile(path.join(f.home, 'connection.json'), 'utf8'));
  assert.equal(saved.token, replacement.connection.token);
  const client = await connect(f.home, { requireCurrentVersion: false, autoStart: false });
  assert.equal(client.connection.origin, replacement.connection.origin);
});

test('legacy service discovery advertises only service-declared capabilities', async t => {
  const f = await fixture(t);
  await service(f, '0.2.0', { legacy: true, capabilities: { capabilities: [{ tool: 'aiui_projects_list' }] } });
  const client = await mcp(f);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['aiui_capabilities_get', 'aiui_projects_list', 'aiui_status']);
  assert.equal(JSON.parse((await client.readResource({ uri: 'aiui://tools' })).contents[0].text).discovery, 'legacy-capabilities');
});

test('a lost response never replays a write and the next call reconnects', async t => {
  const f = await fixture(t); let writes = 0;
  await service(f, '0.2.0', { invoke: (request, req) => { if (request.tool !== 'write-once') return false; writes++; req.socket.destroy(); return true; } });
  const client = await connect(f.home, { requireCurrentVersion: false });
  await assert.rejects(client.call('write-once', { value: 1 }));
  assert.equal(writes, 1);
  await service(f, '0.4.0');
  assert.equal((await client.call('aiui_status')).version, '0.4.0');
  assert.equal(writes, 1);
});

test('a saved stable configuration survives relocation, spaces, quotes and an empty PATH', async t => {
  if (process.platform === 'win32') return t.skip('POSIX launcher execution');
  const f = await fixture(t), installation = path.join(f.home, "app 中文 ' & $ literal");
  async function install(root, text) {
    await fs.mkdir(path.join(root, 'mcp'), { recursive: true });
    await fs.writeFile(path.join(root, 'mcp/server.mjs'), 'console.log(' + JSON.stringify(text) + ')');
    return (await installMcpLauncher(f.home, { root })).mcpServers['aiui-workbench'];
  }
  const saved = await install(installation, 'first');
  const invoke = () => run(saved.command, saved.args, { env: { ...process.env, ...saved.env, PATH: '' } });
  assert.equal((await invoke()).output.trim(), 'first');
  await fs.rm(installation, { recursive: true });
  await install(path.join(f.home, 'new release'), 'upgraded');
  const result = await invoke(); assert.equal(result.code, 0); assert.equal(result.output.trim(), 'upgraded');
});

test('Windows launcher uses a fixed system runtime and discovers the current installation', async t => {
  const f = await fixture(t), config = (await installMcpLauncher(f.home, { platform: 'win32' })).mcpServers['aiui-workbench'];
  assert.match(config.command, /WindowsPowerShell.*powershell\.exe$/);
  assert.match(config.args.at(-1), /installation\.json/);
  assert.ok(!config.args.includes('-ExecutionPolicy'));
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
});

test('an older launcher registration never replaces a valid newer installation',async t=>{
  const f=await fixture(t);await installMcpLauncher(f.home);
  const file=path.join(f.home,'mcp/installation.json'),previous=JSON.parse(await fs.readFile(file,'utf8'));previous.version='99.0.0';await atomicJson(file,previous);
  await installMcpLauncher(f.home,{root:path.join(f.home,'obsolete-root')});assert.equal(JSON.parse(await fs.readFile(file,'utf8')).version,'99.0.0');assert.equal(JSON.parse(await fs.readFile(file,'utf8')).root,previous.root);
});

for (const runtime of ['Node', 'Electron']) test(`Windows saved launcher exchanges UTF-8 MCP and follows relocation using ${runtime}`, async t => {
  if (process.platform !== 'win32') return t.skip('Windows native stdio transport');
  const f = await fixture(t);
  f.home = path.join(f.home, '用户数据 中文 & spaces'); await fs.mkdir(f.home);
  await service(f, '99.0.0', { tools: [futureTool] });
  const executable = runtime === 'Electron' ? (await import('electron')).default : process.execPath;
  if (runtime === 'Electron') {
    const direct = new Client({ name: 'direct-electron-transport', version: '1.0.0' }); f.clients.push(direct);
    const transport = new StdioClientTransport({ command: executable, args: [path.join(ROOT, 'mcp/server.mjs')], env: { ...process.env, AIUI_WORKBENCH_HOME: f.home, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' });
    transport.stderr.on('data', chunk => console.error('DIRECT ELECTRON STDERR', chunk.toString()));
    await direct.connect(transport, { timeout: 10000 }); assert.deepEqual((await direct.listTools()).tools, [futureTool]); await direct.close();
    console.log('Direct Electron MCP transport passed');
  }
  const saved = (await installMcpLauncher(f.home, { executable })).mcpServers['aiui-workbench'];
  async function invoke(stderr) {
    const client = new Client({ name: 'windows-stable-launcher-test', version: '1.0.0' }); f.clients.push(client);
    const transport = new StdioClientTransport({ ...saved, env: { ...process.env, ...saved.env, PATH: '' }, stderr });
    if (stderr === 'pipe') transport.stderr.on('data', chunk => console.error('LAUNCHER STDERR', chunk.toString()));
    await client.connect(transport, { timeout: 15000 });
    assert.deepEqual((await client.listTools()).tools, [futureTool]);
    const text = '中文照片问题 & literal $ text 🌱'.repeat(1000);
    const result = await client.callTool({ name: futureTool.name, arguments: { text, futureParameter: 27 } });
    assert.equal(JSON.parse(result.content[0].text).args.text, text);
    const version = client.getServerVersion().version; await client.close(); return version;
  }
  for (const stderr of ['pipe', 'inherit']) assert.notEqual(await invoke(stderr), '0.0.1');
  const relocated = await retainedEntry(f);
  await installMcpLauncher(f.home, { root: path.dirname(path.dirname(relocated)), executable });
  for (const stderr of ['pipe', 'inherit']) assert.equal(await invoke(stderr), '0.0.1');
});

test('real service discovery stays authenticated and validates arguments at the service', async t => {
  const f = await fixture(t), daemon = await startDaemon(f.home); f.closers.push(() => daemon.close());
  assert.equal((await fetch(daemon.connection.origin + '/api/tools')).status, 401);
  const response = await fetch(daemon.connection.origin + '/api/tools', { headers: { Authorization: 'Bearer ' + daemon.connection.token } });
  const catalog = await response.json(); assert.ok(catalog.tools.some(tool => tool.name === 'aiui_tools_list'));
  const client = await mcp(f);
  assert.deepEqual((await client.listTools()).tools, catalog.tools);
  const result = await client.callTool({ name: 'aiui_record_start', arguments: { source: 'invalid-source' } });
  assert.equal(result.isError, true);
  assert.equal(daemon.service.recordings.status().recordings.length, 0);
});
