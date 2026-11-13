import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {isIP} from 'node:net';
import { spawn } from 'node:child_process';
import { ROOT, atomicJson, readJson, run, normalizeEnvironment } from './util.mjs';

export class AdbTools {
  constructor(home, { root = ROOT, platform = process.platform, arch = process.arch, env = process.env, userHome = os.homedir() } = {}) {
    this.file = path.join(home, 'connection-tools.json');
    Object.assign(this, { root, platform, arch, env, userHome });
  }
  async resolveInfo() {
    const settings = await readJson(this.file, {});
    const binary = this.platform === 'win32' ? 'adb.exe' : 'adb';
    const manifest = await readJson(path.join(this.root, 'vendor/adb/manifest.json'), { platforms: {} });
    const bundled = manifest.platforms[this.platform]?.architectures.includes(this.arch);
    const systemPaths = [
      ...[this.env.ANDROID_HOME, this.env.ANDROID_SDK_ROOT].filter(Boolean).map(dir => path.join(dir, 'platform-tools', binary)),
      path.join(this.userHome, 'Library/Android/sdk/platform-tools', binary),
      path.join(this.env.LOCALAPPDATA || path.join(this.userHome, 'AppData/Local'), 'Android/Sdk/platform-tools', binary),
      path.join(this.userHome, 'Android/Sdk/platform-tools', binary),
      path.join(this.userHome, 'Downloads/platform-tools', binary),
      ...(this.env.PATH || this.env.Path || '').split(this.platform === 'win32' ? ';' : ':').filter(Boolean).map(dir => path.join(dir.replace(/^"(.*)"$/, '$1'), binary)),
      ...(this.platform === 'darwin' ? ['/opt/homebrew/bin/adb', '/usr/local/bin/adb'] : []),
    ];
    const candidates = [
      settings.adbPath && { path: settings.adbPath, source: 'custom' },
      bundled && { path: path.join(this.root, 'vendor/adb', this.platform, binary), source: 'bundled', version: manifest.version },
      ...systemPaths.map(file => ({ path: file, source: 'system' })),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { await fs.access(candidate.path, this.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; } catch {}
    }
    return { path: 'adb', source: 'missing' };
  }
  async resolve() { return (await this.resolveInfo()).path; }
  async configure(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择解压后的 platform-tools 文件夹');
    const binary = this.platform === 'win32' ? 'adb.exe' : 'adb';
    const adbPath = await fs.realpath(path.join(directory, binary)).catch(() => null);
    if (!adbPath) throw new Error(`这个文件夹中没有 ${binary}，请选择包含它的 platform-tools 文件夹。`);
    const result = await run(adbPath, ['version'], { timeout: 5000 });
    if (result.code || !result.output.includes('Android Debug Bridge')) throw new Error('这个文件夹中的 ADB 无法运行，请重新下载 Android 官方工具。');
    await atomicJson(this.file, { adbPath });
    return { configured: true };
  }
  async execute(args, options) { return run(await this.resolve(), args, { env: this.env, ...options }); }
  async connect({address,pairingCode}) {
    const match=typeof address==='string'&&address.match(/^(\[[a-f\d:]+\]|[\d.]+):(\d{1,5})$/i);
    if(!match||!isIP(match[1].replace(/^\[|\]$/g,''))||Number(match[2])<1||Number(match[2])>65535)throw new Error('请输入眼镜显示的 IP:端口，例如 192.168.1.20:5555');
    if(pairingCode!==undefined&&!/^\d{6}$/.test(pairingCode))throw new Error('请输入眼镜显示的六位配对码');
    const result=await this.execute(pairingCode?['pair',address,pairingCode]:['connect',address],{timeout:15000});
    if(result.code||/failed|unable|cannot|error/i.test(result.output))throw new Error('无线 ADB 连接失败：'+result.output);
    return {address,paired:pairingCode!==undefined,output:result.output};
  }
  // Keep stdout separate and byte-for-byte intact for screenshots, NUL-delimited
  // filenames and log exports. The ordinary CLI runner redacts/truncates text.
  async capture(args, { signal, timeout = 30000, maxBytes = 8 * 1024 * 1024, onOutput } = {}) {
    const executable = await this.resolve();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { signal, shell: false, windowsHide: true, env: normalizeEnvironment(this.env), stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      let bytes = 0, stderr = '', failure, settled = false;
      const timer = setTimeout(() => { failure = new Error('眼镜操作超时，请检查数据线与连接状态'); child.kill(); }, timeout);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { failure = new Error('设备返回的数据过多，请缩小读取范围'); child.kill(); return; }
        chunks.push(chunk); onOutput?.(chunk.toString('utf8'));
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-64000); onOutput?.(chunk.toString('utf8')); });
      const finish = (error, code) => {
        if (settled) return; settled = true; clearTimeout(timer);
        error || failure ? reject(error || failure) : resolve({ code, stdout: Buffer.concat(chunks), stderr });
      };
      child.once('error', error => finish(error));
      child.once('close', code => finish(null, code));
    });
  }
  async environment() {
    const executable = await this.resolve();
    return path.isAbsolute(executable) ? { PATH: path.dirname(executable) + (this.platform === 'win32' ? ';' : ':') + (this.env.PATH || this.env.Path || '') } : {};
  }
}
