import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const homePath = () => path.resolve(process.env.AIUI_WORKBENCH_HOME || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/AIUI Workbench') : process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), 'AIUI Workbench') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'AIUI Workbench')));
export const id = () => randomUUID();
export const sha = value => createHash('sha256').update(value).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; } }
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${id()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').includes('..')) throw new Error('无效的项目资源路径');
  return value;
}
export async function inside(root, relative) {
  safeRelative(relative);
  const resolved = await fs.realpath(path.join(root, relative));
  const base = await fs.realpath(root);
  const relativePath = path.relative(base, resolved);
  if (!relativePath || relativePath === '..' || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) throw new Error('资源路径超出项目目录');
  return resolved;
}
export function redact(value) { return String(value).replace(/(Bearer\s+)[\w.\-]+/gi, '$1[已隐藏]').replace(/((?:token|password|cookie|authorization)["']?\s*[:=]\s*)[^\s,}]+/gi, '$1[已隐藏]'); }
// Windows treats environment names case-insensitively. Keep the final override,
// so an inherited `Path` cannot shadow the PATH containing the bundled ADB.
export function normalizeEnvironment(env, platform = process.platform) {
  if (platform !== 'win32') return { ...env };
  const result = {}, keys = new Map();
  for (const [key, value] of Object.entries(env)) {
    const name = key.toUpperCase();
    if (keys.has(name)) delete result[keys.get(name)];
    keys.set(name, key); result[key] = value;
  }
  return result;
}
export async function run(command, args, { cwd = ROOT, signal, onOutput, timeout = 120000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, shell: false, windowsHide: true, env: normalizeEnvironment({ ...env, FORCE_COLOR: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('操作超时')); }, timeout);
    const finish = (error, code) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ code, output }); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { const text = redact(chunk.toString()); output = (output + text).slice(-64000); onOutput?.(text); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, code));
  });
}
