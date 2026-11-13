import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from '../core/client.mjs';
import { ROOT, homePath, inside, id, redact } from '../core/util.mjs';
import { APP_VERSION } from '../core/version.mjs';
import { UI_TOOLS, officialUrl } from '../core/ui-tools.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const send = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function json(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('请求必须使用 JSON');
  let size = 0, parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 15 * 1024 * 1024) throw new Error('请求超过大小限制'); parts.push(chunk); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function openOnHost(value, { reveal = false } = {}) {
  let command, args;
  if (process.platform === 'darwin') { command = 'open'; args = reveal ? ['-R', value] : [value]; }
  else if (process.platform === 'win32') { command = 'explorer.exe'; args = reveal ? ['/select,', value] : [value]; }
  else { command = 'xdg-open'; args = [reveal ? path.dirname(value) : value]; }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(true) : reject(new Error('无法打开系统浏览器或文件管理器')));
  });
}

export async function startWeb({ home = homePath(), port = 0, client, open = openOnHost } = {}) {
  await fs.access(path.join(ROOT, 'dist/renderer/index.html')).catch(() => { throw new Error('Web 界面尚未构建，请先运行 npm run build'); });
  client ||= await connect(home);
  const bootstrapKey = randomBytes(32).toString('hex'), cookieKey = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.headers.host !== new URL(origin).host) return send(res, { error: 'Invalid host' }, 403);
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const foreign = req.headers.origin && req.headers.origin !== origin;
        if (foreign || req.headers['sec-fetch-site'] === 'cross-site' || (req.method !== 'GET' && req.headers.origin !== origin)) return send(res, { error: 'Invalid origin' }, 403);
        if (url.pathname === '/api/session' && req.method === 'POST') {
          const value = await json(req);
          if (!equal(value.key, bootstrapKey)) return send(res, { error: '请通过启动命令给出的完整链接打开工坊' }, 401);
          // Cookie names include the port: localhost cookies otherwise collide across gateways.
          res.setHeader('Set-Cookie', `aiui_web_${server.address().port}=${cookieKey}; HttpOnly; SameSite=Strict; Path=/api/`);
          return send(res, { result: { version: APP_VERSION } });
        }
        const cookie = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`aiui_web_${server.address().port}=`))?.split('=')[1];
        if (!equal(cookie, cookieKey)) return send(res, { error: 'Web 会话已失效，请重新打开启动命令中的完整链接' }, 401);
        if (url.pathname === '/api/health' && req.method === 'GET') return send(res, { result: { version: APP_VERSION } });
        if (url.pathname === '/api/directories' && req.method === 'GET') {
          const requested = url.searchParams.get('path') || os.homedir();
          if (!path.isAbsolute(requested)) throw new Error('请输入这台电脑上的绝对目录路径');
          const directory = await fs.realpath(requested), entries = await fs.readdir(directory, { withFileTypes: true });
          const directories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name, path: path.join(directory, e.name) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
          return send(res, { result: { directory, parent: path.dirname(directory), directories, home: os.homedir() } });
        }
        if (url.pathname === '/api/upload' && req.method === 'POST') {
          if (req.headers['content-type'] !== 'application/octet-stream') throw new Error('文件上传格式无效');
          const name = url.searchParams.get('name'), limit = 2 * 1024 * 1024 * 1024;
          if (!name || /[\/\\\0\r\n]/.test(name) || name === '.' || name === '..' || Buffer.byteLength(name) > 240) throw new Error('文件名称无效');
          if (Number(req.headers['content-length']) > limit) { req.resume(); return send(res, { error: '单个文件不能超过 2 GB' }, 413); }
          const directory = path.join(home, 'web-imports', id()); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const file = path.join(directory, name), partial = path.join(directory, '.upload-part');
          let handle, bytes = 0;
          try {
            handle = await fs.open(partial, 'wx', 0o600);
            for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('单个文件不能超过 2 GB'); await handle.writeFile(chunk); }
            await handle.close(); handle = null; await fs.rename(partial, file);
            return send(res, { result: file });
          } catch (error) { await handle?.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); throw error; }
        }
        if (req.method !== 'POST') return send(res, { error: 'Method not allowed' }, 405);
        const value = await json(req);
        if(url.pathname==='/api/feedback'){
          const operations={submit:'ui_feedback_submit',reconcile:'ui_feedback_reconcile',delete:'ui_feedback_delete',restore:'ui_feedback_restore'};
          const tool=operations[value.method];if(!tool)throw new Error('未知反馈操作');
          const result=await client.call(tool,value.args,'web-feedback');return send(res,{result});
        }
        if (url.pathname === '/api/call') {
          if (!UI_TOOLS.has(value.tool)) throw new Error('未知操作');
          return send(res, { result: await client.call(value.tool, value.args, 'web') });
        }
        if (url.pathname === '/api/photo') {
          if (typeof value.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('照片格式无效');
          const bytes = Buffer.from(value.data, 'base64'); let extension;
          if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = '.png';
          else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = '.jpg';
          else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') extension = '.webp';
          if (!extension || bytes.length > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 照片');
          const dir = path.join(home, 'web-fixtures'); await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, id() + extension); await fs.writeFile(file, bytes, { mode: 0o600 });
          return send(res, { result: file });
        }
        if (url.pathname === '/api/reveal') {
          if (typeof value.path !== 'string' || !path.isAbsolute(value.path)) throw new Error('无效路径');
          await fs.access(value.path); await open(value.path, { reveal: true }); return send(res, { result: true });
        }
        if (url.pathname === '/api/official') { await open(officialUrl(value.url)); return send(res, { result: true }); }
        return send(res, { error: 'Not found' }, 404);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, { error: 'Method not allowed' }, 405);
      if (url.pathname === '/') { res.writeHead(302, { Location: '/renderer/index.html' }); return res.end(); }
      if (url.pathname !== '/renderer/index.html' && !url.pathname.startsWith('/assets/')) return send(res, { error: 'Not found' }, 404);
      const file = await inside(path.join(ROOT, 'dist'), decodeURIComponent(url.pathname.slice(1)));
      // Preview documents run on the core daemon's separate origin and never receive this cookie or the service token.
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.rokidcdn.com https://*.rokid.com https://*.aliyuncs.com; media-src 'self' https://*.rokidcdn.com https://*.rokid.com https://*.aliyuncs.com; frame-src ${client.connection.origin}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : await fs.readFile(file));
    } catch (error) { if (!res.headersSent) send(res, { error: redact(error.message),diagnosticId:error.diagnosticId }, error.code === 'ENOENT' ? 404 : 400); else res.end(); }
  });
  server.requestTimeout = 600000; // Large local APK/media uploads can take longer than 30 seconds.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/renderer/index.html#key=${bootstrapKey}`, client,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
