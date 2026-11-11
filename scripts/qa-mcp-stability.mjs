import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_VERSION } from '../core/version.mjs';
import { ROOT, atomicJson, readJson, run, sleep } from '../core/util.mjs';
import { packagedPaths } from './packaged-paths.mjs';

const { executablePath, appRoot } = packagedPaths();
const output = path.join(ROOT, 'output/qa/mcp-stability');
const home = path.join(ROOT, '.local', 'mcp stability 中文 & spaces', String(Date.now()));
const env = { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '1', PATH: '' };
delete env.Path;
const original = { command: executablePath, args: [path.join(appRoot, 'mcp/server.mjs')], env: { AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '1' } };
const report = { version: APP_VERSION, executablePath, home, checks: [], systemPathEmpty: true, startedAt: new Date().toISOString() };
const clients = new Set(); let child;
async function check(name, work) { const result = await work(); report.checks.push({ name, passed: true, ...result }); console.log('PASS', name); }
async function until(work) { for (let i = 0; i < 120; i++) { const value = await work(); if (value) return value; await sleep(100); } throw new Error('等待本机服务超时'); }
async function connect(config) {
  const client = new Client({ name: 'packaged-mcp-stability', version: '1.0.0' }); clients.add(client);
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...env, ...config.env } }), { timeout: 20000 });
  return client;
}
async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content.find(content => content.type === 'text').text);
}
async function stopDaemon() {
  const connection = await readJson(path.join(home, 'connection.json'), null);
  if (!connection) return;
  const response = await fetch(connection.origin + '/health', { headers: { Authorization: 'Bearer ' + connection.token }, signal: AbortSignal.timeout(1000) }).catch(() => null);
  if (!response?.ok) return;
  const health = await response.json(); assert.equal(health.pid, connection.pid);
  process.kill(connection.pid, 'SIGTERM');
  await until(async () => !(await readJson(path.join(home, 'connection.json'), null)));
}
await fs.mkdir(output, { recursive: true });
try {
  let direct, stable, saved, names, project;
  await check('original direct app-path JSON starts packaged MCP and service with no system Node', async () => {
    direct = await connect(original);
    const status = await tool(direct, 'aiui_status'); assert.equal(status.version, APP_VERSION);
    names = (await direct.listTools()).tools.map(tool => tool.name); assert.ok(names.includes('aiui_tools_list'));
    return { toolCount: names.length, serviceVersion: status.version };
  });
  await check('running service supplies the exact MCP JSON schemas', async () => {
    const catalog = await tool(direct, 'aiui_tools_list');
    assert.deepEqual((await direct.listTools()).tools, catalog.tools);
    assert.equal(JSON.parse((await direct.readResource({ uri: 'aiui://tools' })).contents[0].text).serviceVersion, APP_VERSION);
    saved = (await tool(direct, 'aiui_mcp_config')).mcpServers['aiui-workbench'];
    assert.notEqual(saved.command, executablePath);
    report.fixedLauncher = saved;
  });
  await check('saved stable configuration cold-starts packaged service after MCP and daemon stop', async () => {
    await direct.close(); clients.delete(direct); await stopDaemon();
    stable = await connect(saved); assert.equal((await tool(stable, 'aiui_status')).version, APP_VERSION);
  });
  await check('original configuration still connects unchanged after the service restarts', async () => {
    direct = await connect(original);
    assert.deepEqual((await direct.listTools()).tools.map(tool => tool.name), names);
  });
  await check('MCP and shared CLI use the same service tools and project registry', async () => {
    const directory = path.join(home, 'sample/agent'); await fs.mkdir(directory, { recursive: true });
    await atomicJson(path.join(directory, 'app.json'), { name: 'MCP stability fixture', version: '1.0.0', pages: ['index'], permissions: [] });
    await fs.writeFile(path.join(directory, 'index.ink'), '<page><text>Stability</text></page>');
    project = await tool(stable, 'aiui_project_import', { directory });
    const cli = await run(executablePath, [path.join(appRoot, 'web/cli.mjs'), 'tools'], { env }); assert.equal(cli.code, 0, cli.output);
    assert.deepEqual(JSON.parse(cli.output).tools.map(tool => tool.name), names);
    const registry = await run(executablePath, [path.join(appRoot, 'web/cli.mjs'), 'call', 'aiui_projects_list'], { env }); assert.equal(registry.code, 0, registry.output);
    assert.ok(JSON.parse(registry.output).projects.some(item => item.id === project.id));
  });
  await check('existing MCP processes reconnect to a replaced daemon without restarting the AI client', async () => {
    const before = await readJson(path.join(home, 'connection.json')); await stopDaemon();
    child = spawn(executablePath, [path.join(appRoot, 'core/daemon.mjs')], { env, stdio: 'ignore' });
    await until(async () => (await readJson(path.join(home, 'connection.json'), null))?.pid === child.pid);
    const status = await tool(stable, 'aiui_status'); assert.equal(status.version, APP_VERSION);
    assert.ok(status.projects.some(item => item.id === project.id));
    assert.ok((await tool(direct, 'aiui_projects_list')).projects.some(item => item.id === project.id));
    const after = await readJson(path.join(home, 'connection.json')); assert.notEqual(after.pid, before.pid); assert.notEqual(after.token, before.token);
    return { serviceReplaced: true };
  });
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  for (const client of clients) await client.close();
  await stopDaemon();
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  report.finishedAt = new Date().toISOString();
  await atomicJson(path.join(output, 'packaged-acceptance.json'), report);
}
