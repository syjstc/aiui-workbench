import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import semver from 'semver';
import { ROOT, homePath, readJson, sleep } from './util.mjs';
import { APP_VERSION } from './version.mjs';
import { mcpInstallation,installMcpLauncher } from './mcp-launcher.mjs';
import { legacyToolCatalog } from './tool-catalog.mjs';

const identity = connection => JSON.stringify([connection.origin, connection.token, connection.pid, connection.startedAt]);
async function startupLock(home) {
  const file = path.join(home, 'startup.lock');
  try { return await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let before;
    try { before = await fs.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return fs.open(file, 'wx'); throw error; }
    const owner = await readJson(file, null).catch(() => null), hasOwner = Number.isSafeInteger(owner?.pid) && owner.pid > 1;
    let stale = !hasOwner && Date.now() - before.mtimeMs > 30000;
    if (hasOwner) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') stale = true; }
    }
    if (!stale) throw error;
    let current;
    try { current = await fs.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return fs.open(file, 'wx'); throw error; }
    if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw error;
    await fs.unlink(file);
    return fs.open(file, 'wx');
  }
}
export async function connect(home = homePath(), { autoStart = true, requireCurrentVersion = true } = {}) {
  // Publish the new executable before retiring an old service. An already-open
  // AI client may reconnect during handover; it must bootstrap this release,
  // rather than race the desktop by resurrecting its old bundled daemon.
  if(autoStart&&requireCurrentVersion)await installMcpLauncher(home);
  async function probe() { try { const c = await readJson(path.join(home,'connection.json')); const url=new URL(c.origin);if(url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/')return null;const r = await fetch(c.origin+'/health',{headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(1500)});if(!r.ok)return null;const health=await r.json();return health.ok?{...c,version:health.version,verifiedPid:health.pid}:null; } catch { return null; } }
  let connection = await probe();
  let upgrade;
  async function upgradeRegistered({strict=false}={}){
    const installation=autoStart?await mcpInstallation(home).catch(()=>null):null,targetVersion=strict?APP_VERSION:installation?.version;
    if(!connection||!targetVersion||connection.version===targetVersion)return;
    if(!strict&&(!semver.valid(connection.version)||!semver.valid(targetVersion)||!semver.gt(targetVersion,connection.version)))return;
    if(!autoStart || !semver.valid(connection.version) || semver.gt(connection.version,targetVersion))throw new Error(`本地服务 v${connection.version||'未知'} 与当前工坊 v${targetVersion} 不一致，请使用同版本或更新版本的客户端`);
    const previous=connection;
    try{
    if(!Number.isSafeInteger(previous.pid)||previous.pid<=1||previous.pid!==previous.verifiedPid)throw new Error('旧服务进程无法核实，请先关闭旧版工坊和本地服务');
    // Give a just-closed UI's heartbeat time to expire; never stop active work.
    for(let i=0;i<22;i++){
      const response=await fetch(previous.origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${previous.token}`},body:JSON.stringify({tool:'aiui_status',actor:'version-handover'}),signal:AbortSignal.timeout(3000)});
      const value=await response.json(),status=value.result;
      if(!response.ok||!status)throw new Error('无法确认旧服务是否空闲，请先关闭旧版工坊');
      if(status.jobs?.some(j=>j.status==='running'))throw new Error('旧版工坊仍有运行任务，请等待任务完成并关闭旧版后重试');
      const active=status.clients?.some(c=>['desktop','web'].includes(c.name)&&Date.now()-c.lastSeen<5000)||status.previews?.some(p=>p.lastSeen&&Date.now()-Date.parse(p.lastSeen)<5000);
      if(!active)break;
      if(!strict)throw new Error('旧版工坊界面仍在使用服务，关闭旧版界面后会自动切换新服务');
      if(i===21)throw new Error('旧版工坊或 Web 界面仍在使用本地服务，请关闭旧版界面后重试');
      await sleep(250);
    }
    const current=await probe();
    if(current?.pid===previous.pid){
      process.kill(previous.pid,'SIGTERM');
      for(let i=0;i<80;i++){await sleep(100);if(!(await probe()))break;if(i===79)throw new Error('旧服务尚未退出，请稍后重试');}
    }
    connection=await probe();
    upgrade=null;
    }catch(error){if(strict)throw error;upgrade={registeredVersion:targetVersion,status:'waiting-idle',reason:error.message,nextAction:'等待任务完成并关闭旧版工坊界面，然后重新调用；保留原项目和任务。'};}
  }
  if(requireCurrentVersion&&connection&&connection.version!==APP_VERSION)await upgradeRegistered({strict:true});
  else if(!requireCurrentVersion&&autoStart)await upgradeRegistered();
  async function start() {
    await fs.mkdir(home,{recursive:true});
    let lock;
    try {
      lock = await startupLock(home);
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      const log = await fs.open(path.join(home,'service.log'),'a',0o600);
      let installation;
      try { installation = requireCurrentVersion ? null : await mcpInstallation(home); }
      catch (error) { await log.close(); throw error; }
      const child = spawn(installation?.executable || process.execPath,[path.join(installation?.root || ROOT,'core/daemon.mjs')],{env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore',log.fd,log.fd],detached:true,windowsHide:true});
      try { await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref(); } finally { await log.close(); }
      for (let i=0;i<200;i++) { await sleep(150); connection=await probe(); if(connection)break; }
    } catch(e) { if(e.code!=='EEXIST')throw e; for(let i=0;i<200;i++){await sleep(150);connection=await probe();if(connection)break;} }
    finally { if(lock){await lock.close();await fs.unlink(path.join(home,'startup.lock')).catch(()=>{});} }
  }
  if (!connection && autoStart) await start();
  if(!connection)throw new Error('本地服务未能启动，请打开 AIUI 工坊或检查服务日志');
  if(requireCurrentVersion && connection.version!==APP_VERSION)throw new Error(`本地服务 v${connection.version} 与当前工坊 v${APP_VERSION} 不一致，请关闭旧版后重试`);
  let refreshing, cachedCatalog;
  async function refresh({ autoStart: shouldStart = autoStart } = {}) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const next = await probe();
      if (next) connection = next;
      else if (shouldStart) { connection = null; await start(); }
      else throw new Error('本地服务暂不可用，等待工坊重新连接');
      if(!requireCurrentVersion&&shouldStart&&connection){await upgradeRegistered();if(!connection)await start();}
      if (!connection) throw new Error('本地服务未能启动，请打开 AIUI 工坊或检查服务日志');
      if (requireCurrentVersion && connection.version !== APP_VERSION) throw new Error('本地服务已切换，请使用当前版本的工坊界面');
      return connection;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function call(tool,args={},actor='client') {
    const current = await refresh();
    // A write may have completed before its response was lost. Never replay it
    // automatically after a disconnect; the next call rediscovers the service.
    const r=await fetch(current.origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${current.token}`},body:JSON.stringify({tool,args,actor}),signal:AbortSignal.timeout(120000)});
    const value=await r.json();if(!r.ok||value.error)throw Object.assign(new Error(value.error||`HTTP ${r.status}`),{diagnosticId:value.diagnosticId,sharedDiagnostics:value.sharedDiagnostics});return value.result;
  }
  async function catalog(options = {}) {
    const current = await refresh(options), key = identity(current);
    if (cachedCatalog?.key === key) return cachedCatalog.value;
    const response = await fetch(current.origin+'/api/tools',{headers:{Authorization:`Bearer ${current.token}`},signal:AbortSignal.timeout(5000)});
    let value;
    if (response.status === 404) {
      let capabilities;
      try { const result=await call('aiui_capabilities_get',{},'MCP-discovery');if(Array.isArray(result?.capabilities))capabilities=result; }
      catch (error) { if(!/未知工具|unknown tool/i.test(error.message))throw error; }
      value = legacyToolCatalog(current.version,capabilities);
    } else {
      if (!response.ok) throw new Error(`无法读取服务工具清单：HTTP ${response.status}`);
      value = await response.json();
      if (!Array.isArray(value.tools) || value.tools.some(tool => typeof tool.name !== 'string' || tool.inputSchema?.type !== 'object')) throw new Error('本地服务返回的工具清单无效');
    }
    if(upgrade)value={...value,upgrade};
    cachedCatalog = { key, value };
    return value;
  }
  return {
    get connection(){return connection;},
    call, refresh, catalog,
  };
}
