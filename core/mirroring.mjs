import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, readJson, redact, normalizeEnvironment, id } from './util.mjs';

export class Mirroring {
  constructor(adb, glasses, emit = () => {}, { root = ROOT, platform = process.platform, arch = process.arch, env = process.env, spawnProcess = spawn } = {}) {
    Object.assign(this, { adb, glasses, emit, root, platform, arch, env, spawnProcess }); this.sessions = new Map(); this.starts = new Map();
  }
  async bundled() {
    const manifest = await readJson(path.join(this.root, 'vendor/scrcpy/manifest.json'), null), key = `${this.platform}-${this.arch}`;
    const directory = path.join(this.root, 'vendor/scrcpy', key), binary = path.join(directory, this.platform === 'darwin' ? 'AIUI Mirror.app/Contents/MacOS/scrcpy' : this.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'), server = path.join(directory, this.platform === 'darwin' ? 'AIUI Mirror.app/Contents/Resources/scrcpy-server' : 'scrcpy-server');
    const receipt = await readJson(path.join(directory, 'bundle.json'), null);
    if (!manifest?.platforms[key] || receipt?.sha256 !== manifest.platforms[key].sha256 || receipt.version !== manifest.version) throw new Error('内置投屏组件不完整，请使用完整客户端');
    await fs.access(binary, this.platform === 'win32' ? constants.F_OK : constants.X_OK).catch(() => { throw new Error('内置投屏程序不可用，请使用完整客户端'); });
    await fs.access(server).catch(() => { throw new Error('内置投屏组件不完整，请使用完整客户端'); });
    return { source: 'bundled', version: manifest.version, binary, server, directory };
  }
  public(session) {
    if (!session) return null;
    const { child, starting, completion, ...result } = session; return { ...result };
  }
  async status({ serial } = {}) {
    let component;
    try { component = { available: true, ...await this.bundled() }; } catch (error) { component = { available: false, source: 'bundled', error: error.message }; }
    return { ...component, session: this.public(this.sessions.get(serial)), sessions: [...this.sessions.values()].map(session => this.public(session)) };
  }
  start(args) {
    if (this.starts.has(args.serial)) return this.starts.get(args.serial);
    const promise = this.startNow(args).finally(() => this.starts.delete(args.serial));
    this.starts.set(args.serial, promise); return promise;
  }
  async startNow({ serial, maxFps = 30, rotation = 0, readOnly = false }) {
    if (![15, 30, 60].includes(maxFps) || ![0, 90, 180, 270].includes(rotation) || typeof readOnly !== 'boolean') throw new Error('投屏选项无效');
    await this.glasses.ready(serial);
    const previous = this.sessions.get(serial);
    if (previous?.starting) return previous.starting;
    if (previous?.status === 'running') return this.public(previous);
    const component = await this.bundled(), adbPath = path.join(this.root, 'vendor/adb', this.platform, this.platform === 'win32' ? 'adb.exe' : 'adb');
    await fs.access(adbPath, this.platform === 'win32' ? constants.F_OK : constants.X_OK).catch(() => { throw new Error('投屏需要完整客户端中的内置 ADB'); });
    // Explicit absolute paths override inherited ADB/SCRCPY_SERVER_PATH. A clean
    // computer never needs PATH, Homebrew, Android Studio, or a separate install.
    const env = normalizeEnvironment({ ...this.env, ...(this.platform === 'darwin' ? { NSUnbufferedIO: 'YES' } : {}), ADB: adbPath, SCRCPY_SERVER_PATH: component.server, SCRCPY_ICON_PATH: path.join(this.root, 'assets/icon.png') }, this.platform);
    const args = ['--serial', serial, '--window-title', `AIUI · ${serial.slice(-6)}`, '--no-audio', '--no-clipboard-autosync', '--video-codec=h264', '--video-bit-rate=4M', '--max-size=1280', `--max-fps=${maxFps}`, `--display-orientation=${rotation}`, '--window-width=720', '--window-height=540', ...(readOnly ? ['--no-control'] : ['--mouse=sdk', '--keyboard=sdk', '--no-key-repeat'])];
    const session = { id: id(), serial, status: 'starting', startedAt: new Date().toISOString(), maxFps, rotation, readOnly, componentVersion: component.version, output: '' };
    // Reserve the device before spawning: overlapping start requests share one process.
    this.sessions.set(serial, session);
    let finish, ready, failed;
    session.completion = new Promise(resolve => { finish = resolve; });
    session.starting = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    session.starting.catch(() => {});
    let timer;
    const publish = () => this.emit('glasses-mirror', this.public(session));
    const fail = error => { if (session.status === 'starting') { session.status = 'failed'; session.error = error.message; failed(error); } };
    try {
      session.child = this.spawnProcess(component.binary, args, { cwd: component.directory, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      session.pid = session.child.pid;
      const output = chunk => {
        session.output = (session.output + redact(chunk.toString('utf8'))).slice(-20000);
        if (session.status === 'starting' && /(?:Texture(?:\s*\([^)]*\))?:|Video size:)/i.test(session.output)) { session.status = 'running'; clearTimeout(timer); ready(this.public(session)); }
        publish();
      };
      session.child.stdout.on('data', output); session.child.stderr.on('data', output);
      session.child.once('error', error => { fail(error); clearTimeout(timer); session.status = 'failed'; session.error = error.message; finish(); publish(); });
      session.child.once('close', code => {
        clearTimeout(timer); session.exitCode = code; session.finishedAt = new Date().toISOString();
        fail(new Error(session.output.trim() || '投屏未能启动，请检查眼镜连接'));
        if (session.status !== 'failed') session.status = session.stopping || code === 0 ? 'stopped' : 'failed';
        if (session.status === 'failed' && !session.error) session.error = session.output.trim() || '投屏连接已断开';
        delete session.starting; finish(); publish();
      });
      timer = setTimeout(() => { fail(new Error(session.output.trim() || '投屏启动超时，请检查眼镜是否开机')); session.child.kill(); publish(); }, 20000);
      publish(); return await session.starting;
    } catch (error) { fail(error); throw error; }
  }
  async stop({ serial }) {
    const session = this.sessions.get(serial);
    if (!session || !['starting', 'running'].includes(session.status)) return this.public(session);
    session.stopping = true; session.child.kill('SIGTERM');
    const timer = setTimeout(() => session.child.kill('SIGKILL'), 2500);
    try { await session.completion; } finally { clearTimeout(timer); }
    return this.public(session);
  }
  async close() { await Promise.all([...this.sessions.keys()].map(serial => this.stop({ serial }))); }
}
