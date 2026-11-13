import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from '../core/client.mjs';
import { APP_VERSION } from '../core/version.mjs';
import { readJson, sleep } from '../core/util.mjs';
import {installMcpLauncher} from '../core/mcp-launcher.mjs';

async function previousService(t, version, mode = 'idle') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-handover-'));
  const entry = path.join(home, 'previous.cjs');
  await fs.writeFile(entry, `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const home=${JSON.stringify(home)},token='test-only-service-token',version=${JSON.stringify(version)},mode=${JSON.stringify(mode)};
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.headers.authorization!=='Bearer '+token){res.statusCode=401;return res.end('{}');}if(req.url==='/health')return res.end(JSON.stringify({ok:true,version,pid:process.pid}));res.end(JSON.stringify({result:{version,jobs:mode==='job'?[{status:'running'}]:[],clients:mode==='ui'?[{name:'desktop',lastSeen:Date.now()}]:[],previews:[]}}));});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(home,'connection.json'),JSON.stringify({origin:'http://127.0.0.1:'+server.address().port,pid:process.pid,token,version})));
process.on('SIGTERM',()=>{try{fs.unlinkSync(path.join(home,'connection.json'));}catch{}server.close(()=>process.exit(0));});`);
  const child = spawn(process.execPath, [entry], { stdio: 'ignore' });
  t.after(async () => {
    const connection = await readJson(path.join(home, 'connection.json'), null);
    for (const pid of new Set([child.pid, connection?.pid].filter(Boolean))) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await sleep(150); await fs.rm(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 60; i++) { if (await readJson(path.join(home, 'connection.json'), null)) return { home, child }; await sleep(50); }
  throw new Error('旧服务测试夹具未启动');
}
test('a verified idle old daemon is replaced automatically without deleting user data', async t => {
  const { home, child } = await previousService(t, '0.1.0'); await fs.writeFile(path.join(home, 'user-record.txt'), 'kept');
  const client = await connect(home); assert.equal(client.connection.version, APP_VERSION); assert.notEqual(client.connection.pid, child.pid);
  assert.equal((await client.call('aiui_status')).version, APP_VERSION); assert.equal(await fs.readFile(path.join(home, 'user-record.txt'), 'utf8'), 'kept');
});
test('a running task prevents version handover and the old process stays alive', async t => {
  const { home, child } = await previousService(t, '0.1.0', 'job');
  await assert.rejects(connect(home), /仍有运行任务/); assert.equal(child.exitCode, null);
});
test('an active desktop heartbeat prevents version handover', async t => {
  const { home, child } = await previousService(t, '0.1.0', 'ui');
  await assert.rejects(connect(home), /仍在使用本地服务/); assert.equal(child.exitCode, null);
});
test('same versions reuse the daemon, and a newer daemon is never downgraded', async t => {
  const current = await previousService(t, APP_VERSION); assert.equal((await connect(current.home)).connection.pid, current.child.pid);
  const newer = await previousService(t, '99.0.0'); await assert.rejects(connect(newer.home), /同版本或更新版本/); assert.equal(newer.child.exitCode, null);
});
test('MCP automatically hands an idle old daemon to the registered new installation',async t=>{
  const {home,child}=await previousService(t,'0.1.0');await installMcpLauncher(home);
  const client=await connect(home,{requireCurrentVersion:false});assert.equal(client.connection.version,APP_VERSION);assert.notEqual(client.connection.pid,child.pid);assert.equal((await client.catalog()).tools.some(tool=>tool.name==='aiui_workflow_start'),true);
});
test('automatic MCP upgrade waits for active work without terminating the old service',async t=>{
  const {home,child}=await previousService(t,'0.1.0','job');await installMcpLauncher(home);
  const client=await connect(home,{requireCurrentVersion:false});assert.equal(client.connection.pid,child.pid);assert.equal((await client.call('aiui_status')).version,'0.1.0');assert.equal(child.exitCode,null);
});
