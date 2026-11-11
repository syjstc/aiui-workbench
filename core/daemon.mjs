import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbench } from './service.mjs';
import { APP_VERSION } from './version.mjs';
import { ROOT, homePath, atomicJson, readJson, id, inside, redact } from './util.mjs';

const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.wasm':'application/wasm', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.mp3':'audio/mpeg' };
async function body(req) { let size = 0, parts = []; for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('请求超出大小限制'); parts.push(chunk); } return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}; }
const send = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(data)); };
export async function startDaemon(home = homePath()) {
  const service = await new Workbench(home).init(), token = id() + id();
  const server = http.createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    try {
      const sdkAsset = url.pathname.match(/^\/sdk\/([^/]+)\/(.+)$/);
      if (sdkAsset) {
        if (!['GET','HEAD'].includes(req.method)) return send(res,{error:'Method not allowed'},405);
        const file = await inside(service.sdk.packagePath(sdkAsset[1], 'ink'), decodeURIComponent(sdkAsset[2]));
        res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'public, max-age=31536000, immutable' });
        return res.end(req.method === 'HEAD' ? undefined : await fs.readFile(file));
      }
      if (url.pathname.startsWith('/runtime/')) {
        if (!['GET','HEAD'].includes(req.method)) return send(res,{error:'Method not allowed'},405);
        const file = await inside(path.join(ROOT,'dist'),decodeURIComponent(url.pathname.slice('/runtime/'.length)));
        res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':path.extname(file)==='.html'?'no-store':'public, max-age=3600', 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:" });
        return res.end(await fs.readFile(file));
      }
      const recording=url.pathname.match(/^\/session\/([a-f0-9-]+)\/recording\/([a-f0-9-]+)$/);
      if(recording){if(req.method!=='POST')return send(res,{error:'Method not allowed'},405);const session=service.previews.authorize(recording[1],req.headers['x-preview-key']);return send(res,{result:await service.recordings.receive(session,recording[2],req)});}
      const match = url.pathname.match(/^\/session\/([a-f0-9-]+)\/(bundle|poll|ack|state|log)$/);
      if (match) {
        const s = service.previews.authorize(match[1], req.headers['x-preview-key']);
        if (match[2] === 'bundle') return send(res, { ...await service.projects.bundle(s.projectId), session: service.previews.public(s), cameraFixture: s.fixture });
        if (match[2] === 'poll') { s.lastSeen = new Date().toISOString(); return send(res,{ commands:s.queue.splice(0,30), logGeneration:s.logGeneration, logsClearedAt:s.logsClearedAt || 0 }); }
        const value = await body(req);
        if (match[2] === 'ack') service.previews.acknowledge(s,value);
        if (match[2] === 'state') service.previews.update(s,value);
        if (match[2] === 'log') for (const entry of (value.entries || []).slice(0,80)) service.previews.log(s,entry.level,entry.message,entry.logGeneration ?? null,entry.createdAt,entry);
        return send(res,{ok:true});
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(res,{error:'Unauthorized'},401);
      const origin = req.headers.origin;
      if (origin && origin !== service.origin && origin !== 'null') return send(res,{error:'Invalid origin'},403);
      if (url.pathname === '/health') return send(res,{ok:true,version:APP_VERSION,pid:process.pid,toolDiscovery:'/api/tools'});
      if (url.pathname === '/api/tools' && req.method === 'GET') return send(res,await service.call('aiui_tools_list',{},'MCP-discovery'));
      if (url.pathname === '/api/call' && req.method === 'POST') { const value = await body(req); return send(res,{result:await service.call(value.tool,value.args,value.actor || 'client')}); }
      return send(res,{error:'Not found'},404);
    } catch(e) { send(res,{error:redact(e.message)},400); }
  });
  try { await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); }); }
  catch(error) { await service.close(); throw error; }
  service.origin = `http://127.0.0.1:${server.address().port}`;
  const connection = { origin:service.origin,token,pid:process.pid,version:APP_VERSION,startedAt:new Date().toISOString() };
  await atomicJson(path.join(home,'connection.json'),connection);
  service.sdk.start();
  const close = async () => {
    await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const file = path.join(home, 'connection.json'), current = await readJson(file, null);
    if (current?.token === token && current.origin === connection.origin) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
  return {service,server,connection,close};
}
const canonicalEntry = async file => {
  const resolved = await fs.realpath(file).catch(() => null);
  return process.platform === 'win32' ? resolved?.toLowerCase() : resolved;
};
if (process.argv[1] && (await canonicalEntry(process.argv[1])) === (await canonicalEntry(fileURLToPath(import.meta.url)))) {
  const daemon = await startDaemon();
  process.stderr.write(`AIUI Workbench service: ${daemon.connection.origin}\n`);
  for (const event of ['SIGTERM','SIGINT']) process.once(event,async () => { await daemon.close(); process.exit(0); });
}
