import fs from 'node:fs/promises';
import path from 'node:path';
import { id } from './util.mjs';
import { parseDevices } from './devices.mjs';

const MiB = 1024 * 1024;
export const KEY_CODES = { home: 3, back: 4, up: 19, down: 20, left: 21, right: 22, enter: 23, volumeUp: 24, volumeDown: 25, wake: 224, sleep: 223 };
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function devicePath(value = '/sdcard') {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\0\r\n]/.test(value) || value.length > 4096) throw new Error('请输入眼镜上的绝对路径');
  return path.posix.normalize(value);
}
function packageName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(value) || value.length > 256) throw new Error('应用包名无效');
  return value;
}
const number = value => value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function parseProperties(output) {
  return Object.fromEntries(output.split(/\r?\n/).flatMap(line => { const m = line.match(/^\[([^\]]+)\]: \[(.*)\]$/); return m ? [[m[1], m[2]]] : []; }));
}
export function parseStorage(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    return m ? [{ filesystem: m[1], total: Number(m[2]) * 1024, used: Number(m[3]) * 1024, available: Number(m[4]) * 1024, percent: Number(m[5]), mount: m[6] }] : [];
  });
}
export function parseBattery(output) {
  const fields = Object.fromEntries(output.split(/\r?\n/).flatMap(line => { const m = line.trim().match(/^([^:]+):\s*(.*)$/); return m ? [[m[1], m[2]]] : []; }));
  const level = number(fields.level), scale = number(fields.scale);
  return { percent: level !== null && scale > 0 ? Math.round(level / scale * 100) : null, temperature: number(fields.temperature) === null ? null : Number(fields.temperature) / 10, charging: fields.status === '2', plugged: ['AC powered', 'USB powered', 'Wireless powered'].some(key => fields[key] === 'true'), status: number(fields.status) };
}
export function parsePackages(output, thirdPartyOutput = '', disabledOutput = '') {
  const names = text => new Set([...text.matchAll(/^package:([^\s]+)(?:\s|$)/gm)].map(m => m[1]));
  const thirdParty = names(thirdPartyOutput), disabled = names(disabledOutput);
  return output.split(/\r?\n/).flatMap(line => {
    const m = line.match(/^package:([\w.]+)(?:\s+versionCode:(\d+))?/);
    return m ? [{ packageName: m[1], versionCode: m[2] || '', system: !thirdParty.has(m[1]), disabled: disabled.has(m[1]) }] : [];
  }).sort((a, b) => a.packageName.localeCompare(b.packageName));
}
export function parseFileList(output, directory) {
  return output.split('\0').filter(Boolean).map(record => {
    const end = record.indexOf('\n'), metadata = record.slice(0, end).match(/^([a-f\d]+)\|(\d+)\|(\d+)$/i), name = record.slice(end + 1);
    if (end < 0 || !metadata || !name || name.includes('/') || name === '.' || name === '..') throw new Error('无法识别眼镜的文件列表格式');
    const type = parseInt(metadata[1], 16) & 0xf000;
    return { name, path: path.posix.join(directory, name), type: type === 0x4000 ? 'directory' : type === 0xa000 ? 'link' : type === 0x8000 ? 'file' : 'other', bytes: Number(metadata[2]), modifiedAt: new Date(Number(metadata[3]) * 1000).toISOString(), hidden: name.startsWith('.') };
  }).sort((a, b) => (b.type === 'directory') - (a.type === 'directory') || a.name.localeCompare(b.name));
}

export class GlassesTools {
  constructor(home, adb) { this.home = home; this.adb = adb; this.mutations = new Set(); }
  async adbCommand(serial, args, options) {
    const result = await this.adb.capture(['-s', serial, ...args], options);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout.toString('utf8')).trim() || '眼镜操作失败，请检查连接与授权');
    return result;
  }
  async shell(serial, words, options) {
    return (await this.adbCommand(serial, ['shell', '-T', Array.isArray(words) ? words.map(shellQuote).join(' ') : words], options)).stdout.toString('utf8').replaceAll('\r\n', '\n');
  }
  async ready(serial) {
    if (typeof serial !== 'string' || !serial || /[\s\0]/.test(serial) || serial.startsWith('-') || serial.length > 256) throw new Error('请选择明确的目标眼镜');
    const result = await this.adb.capture(['devices', '-l'], { timeout: 10000 });
    if (result.code) throw new Error(result.stderr || '无法读取眼镜连接状态');
    const device = parseDevices(result.stdout.toString('utf8')).find(item => item.serial === serial);
    if (!device) throw new Error('目标眼镜已断开，请重新连接');
    if (device.status === 'unauthorized') throw new Error('请先在眼镜上允许 USB 调试');
    if (device.status !== 'device') throw new Error('目标眼镜离线，请检查数据线');
    return device;
  }
  async exclusive(serial, work) {
    if (this.mutations.has(serial)) throw new Error('这台眼镜仍有操作进行中，请等待完成');
    this.mutations.add(serial);
    try { await this.ready(serial); return await work(); } finally { this.mutations.delete(serial); }
  }
  async info({ serial }) {
    await this.ready(serial);
    const queries = { properties: ['getprop'], storage: ['df', '-k', '/data', '/sdcard'], memory: ['cat', '/proc/meminfo'], battery: ['dumpsys', 'battery'], screen: ['wm', 'size'], density: ['wm', 'density'], uptime: ['cat', '/proc/uptime'], network: ['ip', '-o', '-4', 'addr', 'show', 'scope', 'global'] };
    const warnings = [], values = {};
    await Promise.all(Object.entries(queries).map(async ([key, command]) => {
      try { values[key] = await this.shell(serial, command, { timeout: 15000 }); } catch (error) { warnings.push({ section: key, message: error.message }); }
    }));
    if (Object.keys(values).length === 0) throw new Error(warnings[0]?.message || '无法读取系统信息');
    const props = parseProperties(values.properties || ''), memory = Object.fromEntries([...(values.memory || '').matchAll(/^(\w+):\s+(\d+)\s+kB/gm)].map(m => [m[1], Number(m[2]) * 1024]));
    return { serial, checkedAt: new Date().toISOString(), system: { model: props['ro.product.model'] || '', manufacturer: props['ro.product.manufacturer'] || '', android: props['ro.build.version.release'] || '', api: props['ro.build.version.sdk'] || '', abi: props['ro.product.cpu.abilist'] || props['ro.product.cpu.abi'] || '', build: props['ro.build.display.id'] || '', securityPatch: props['ro.build.version.security_patch'] || '', screen: values.screen?.trim() || '', density: values.density?.trim() || '', uptimeSeconds: number(values.uptime?.trim().split(/\s/)[0]) }, storage: parseStorage(values.storage || ''), memory: { total: memory.MemTotal ?? null, available: memory.MemAvailable ?? null }, battery: parseBattery(values.battery || ''), network: (values.network || '').trim(), warnings };
  }
  async files({ serial, path: requested = '/sdcard' }) {
    const directory = devicePath(requested); await this.ready(serial);
    // NUL terminates each record; only the first newline separates metadata.
    // Spaces, quotes, shell metacharacters and newlines in filenames survive.
    const script = `cd ${shellQuote(directory)} || exit; for item in .[!.]* ..?* *; do [ -e "$item" ] || [ -L "$item" ] || continue; metadata=$(stat -c '%f|%s|%Y' -- "$item") || exit; printf '%s\\n%s\\0' "$metadata" "$item"; done`;
    const output = await this.shell(serial, script, { maxBytes: 8 * MiB });
    return { serial, path: directory, parent: path.posix.dirname(directory), entries: parseFileList(output, directory) };
  }
  async localFile(file, apk = false) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择电脑上的文件');
    const real = await fs.realpath(file), stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error('请选择普通文件');
    if (apk) {
      if (path.extname(real).toLowerCase() !== '.apk') throw new Error('请选择独立 APK 文件，暂不支持 APKS / XAPK 安装包');
      const handle = await fs.open(real, 'r');
      try { const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); if (!header.equals(Buffer.from([80, 75, 3, 4]))) throw new Error('这个文件不是有效的 APK 安装包'); } finally { await handle.close(); }
    }
    return { path: real, bytes: stat.size, name: path.basename(real) };
  }
  async sharedDirectory(serial, requested) {
    const directory = devicePath(requested);
    const canonical = (await this.shell(serial, ['realpath', directory])).trim();
    const root = (await this.shell(serial, ['realpath', '/sdcard'])).trim();
    if (!root.startsWith('/') || (canonical !== root && !canonical.startsWith(root + '/'))) throw new Error('文件写入仅支持眼镜的共享存储目录');
    if ((await this.shell(serial, `[ -d ${shellQuote(canonical)} ] && printf directory`)) !== 'directory') throw new Error('目标不是文件夹');
    return canonical;
  }
  async readFile({ serial, path: requested }) {
    const file = devicePath(requested); await this.ready(serial);
    const metadata = (await this.shell(serial, ['stat', '-c', '%f|%s', '--', file])).trim().match(/^([a-f\d]+)\|(\d+)$/i);
    if (!metadata || (parseInt(metadata[1], 16) & 0xf000) !== 0x8000) throw new Error('请选择普通文件进行预览');
    if (Number(metadata[2]) > 2 * MiB) throw new Error('文件超过 2 MiB，请导出到电脑查看');
    const bytes = (await this.adbCommand(serial, ['exec-out', ['cat', '--', file].map(shellQuote).join(' ')], { maxBytes: 2 * MiB })).stdout;
    let mime;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
    else if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    const result = { serial, path: file, name: path.posix.basename(file), bytes: bytes.length };
    if (mime) return { ...result, type: 'image', mime, data: bytes.toString('base64') };
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('此文件无法直接预览，请导出到电脑查看'); }
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(content)) throw new Error('此文件无法直接预览，请导出到电脑查看');
    return { ...result, type: 'text', content };
  }
  async push({ serial, files, directory = '/sdcard/Download' }, { signal, progress = () => {} } = {}) {
    if (!Array.isArray(files) || !files.length || files.length > 50) throw new Error('请选择 1–50 个文件');
    const sources = await Promise.all(files.map(file => this.localFile(file)));
    if (new Set(sources.map(file => file.name)).size !== sources.length) throw new Error('选中的文件有同名项，请分开导入');
    return this.exclusive(serial, async () => {
      const target = await this.sharedDirectory(serial, directory), results = [];
      for (const file of sources) {
        signal?.throwIfAborted(); const remote = path.posix.join(target, file.name);
        // Never silently overwrite a device file. Users can rename the source.
        const existing = await this.shell(serial, `if [ -e ${shellQuote(remote)} ] || [ -L ${shellQuote(remote)} ]; then printf exists; fi`, { signal });
        if (existing) throw new Error(`眼镜中已有同名文件，请先重命名电脑上的文件：${file.name}`);
        progress(`导入 ${file.name}`);
        await this.adbCommand(serial, ['push', file.path, remote], { signal, timeout: 600000, onOutput: progress });
        results.push({ path: remote, bytes: file.bytes });
      }
      return { serial, files: results };
    });
  }
  async pull({ serial, path: requested, directory }, { signal, progress = () => {} } = {}) {
    const remote = devicePath(requested);
    if (remote === '/' || remote === '/sdcard' || remote === '/storage/emulated/0') throw new Error('请选择具体文件或文件夹，不能直接导出整个存储');
    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new Error('请选择电脑上的保存目录');
    return this.exclusive(serial, async () => {
      const parent = directory ? await fs.realpath(directory) : path.join(this.home, 'glasses-exports');
      await fs.mkdir(parent, { recursive: true });
      // A unique container prevents adb pull from overwriting any local file.
      const destination = await fs.mkdtemp(path.join(parent, 'glasses-'));
      try {
        progress(`导出 ${remote}`);
        await this.adbCommand(serial, ['pull', remote, destination], { signal, timeout: 600000, onOutput: progress });
        return { serial, path: path.join(destination, path.posix.basename(remote)), directory: destination, source: remote };
      } catch (error) { error.message += `\n未完成的文件保存在：${destination}`; throw error; }
    });
  }
  async mkdir({ serial, directory, name }) {
    if (typeof name !== 'string' || !name || /[\/\0\r\n]/.test(name) || name === '.' || name === '..' || name.length > 240) throw new Error('文件夹名称无效');
    return this.exclusive(serial, async () => {
      const parent = await this.sharedDirectory(serial, directory), target = path.posix.join(parent, name);
      await this.shell(serial, ['mkdir', '--', target]); return { serial, path: target };
    });
  }
  async apps({ serial }) {
    await this.ready(serial);
    const [all, user, disabled] = await Promise.all([
      this.shell(serial, ['pm', 'list', 'packages', '--user', '0', '--show-versioncode']),
      this.shell(serial, ['pm', 'list', 'packages', '--user', '0', '-3']),
      this.shell(serial, ['pm', 'list', 'packages', '--user', '0', '-d']),
    ]);
    return { serial, packages: parsePackages(all, user, disabled) };
  }
  async appDetails({ serial, packageName: name }) {
    packageName(name); await this.ready(serial);
    const [output, apkPaths] = await Promise.all([this.shell(serial, ['dumpsys', 'package', name]), this.shell(serial, ['pm', 'path', '--user', '0', name])]);
    if (!apkPaths.trim()) throw new Error('应用已不在眼镜中，请刷新列表');
    return { serial, packageName: name, versionName: output.match(/^\s*versionName=(.*)$/m)?.[1].trim() || '', versionCode: output.match(/^\s*versionCode=(\d+)/m)?.[1] || '', firstInstallTime: output.match(/^\s*firstInstallTime=(.*)$/m)?.[1].trim() || '', lastUpdateTime: output.match(/^\s*lastUpdateTime=(.*)$/m)?.[1].trim() || '', apkPaths: apkPaths.split(/\r?\n/).filter(line => line.startsWith('package:')).map(line => line.slice(8)), output };
  }
  async appAction({ serial, packageName: name, action, confirmPackage }, { signal } = {}) {
    packageName(name);
    if (!['launch', 'stop', 'uninstall', 'clear'].includes(action)) throw new Error('不支持的应用操作');
    if (['uninstall', 'clear'].includes(action) && confirmPackage !== name) throw new Error('请确认目标应用及数据删除操作');
    return this.exclusive(serial, async () => {
      const installed = (await this.apps({ serial })).packages.find(item => item.packageName === name);
      if (!installed) throw new Error('应用已不在眼镜中，请刷新列表');
      if (installed.system && action !== 'launch') throw new Error('系统应用仅支持查看与打开');
      signal?.throwIfAborted();
      let output;
      if (action === 'launch') {
        const activity = (await this.shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', name])).trim().split('\n').find(line => /^[\w.]+\/[\w.$]+$/.test(line.trim()))?.trim();
        if (!activity) throw new Error('这个应用没有可打开的桌面入口');
        output = await this.shell(serial, ['am', 'start', '--user', '0', '-n', activity], { signal });
      } else if (action === 'uninstall') output = (await this.adbCommand(serial, ['uninstall', '--user', '0', name], { signal, timeout: 120000 })).stdout.toString('utf8');
      else output = await this.shell(serial, action === 'clear' ? ['pm', 'clear', '--user', '0', name] : ['am', 'force-stop', '--user', '0', name], { signal });
      if (/Failure|Error:|Exception/i.test(output) || (['clear', 'uninstall'].includes(action) && !/^Success\s*$/m.test(output))) throw new Error(output.trim() || '应用操作未成功');
      return { serial, packageName: name, action, output: output.trim() };
    });
  }
  async install({ serial, files, replace = true }, { signal, progress = () => {} } = {}) {
    if (!Array.isArray(files) || !files.length || files.length > 20 || typeof replace !== 'boolean') throw new Error('请选择 1–20 个独立 APK 文件');
    const apks = await Promise.all(files.map(file => this.localFile(file, true)));
    return this.exclusive(serial, async () => {
      const installed = [];
      for (const [index, apk] of apks.entries()) {
        signal?.throwIfAborted(); progress(`安装 ${index + 1}/${apks.length} · ${apk.name}`);
        const result = await this.adbCommand(serial, ['install', ...(replace ? ['-r'] : []), apk.path], { signal, timeout: 600000, onOutput: progress });
        const output = result.stdout.toString('utf8') + result.stderr;
        if (!/^Success\s*$/m.test(output) || /Failure\s*\[/.test(output)) throw new Error(`${apk.name}\n${output.trim() || '安装未成功'}`);
        installed.push({ name: apk.name, bytes: apk.bytes });
      }
      return { serial, installed, replace };
    });
  }
  async saveArtifact(extension, bytes) {
    const directory = path.join(this.home, 'glasses-exports'); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${id().slice(0, 8)}.${extension}`);
    await fs.writeFile(file, bytes, { mode: 0o600 }); return { path: file, bytes: bytes.length };
  }
  async screenshot({ serial }) {
    await this.ready(serial);
    const result = await this.adbCommand(serial, ['exec-out', 'screencap', '-p'], { maxBytes: 20 * MiB });
    const bytes = result.stdout;
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('眼镜未返回有效截图，当前画面可能不支持截取');
    return { serial, ...await this.saveArtifact('png', bytes), data: bytes.toString('base64'), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  async logs({ serial, lines = 500 }) {
    if (!Number.isInteger(lines) || lines < 100 || lines > 5000) throw new Error('日志行数应在 100–5000 之间');
    await this.ready(serial);
    const result = await this.adbCommand(serial, ['logcat', '-d', '-t', String(lines), '-v', 'threadtime'], { maxBytes: 8 * MiB });
    const output = result.stdout.toString('utf8');
    return { serial, output, lines, ...await this.saveArtifact('txt', result.stdout) };
  }
  async control({ serial, action, confirmSerial }) {
    if (!Object.hasOwn(KEY_CODES, action) && !['settings', 'reboot'].includes(action)) throw new Error('不支持的快捷操作');
    if (action === 'reboot' && confirmSerial !== serial) throw new Error('请确认重启这台眼镜');
    return this.exclusive(serial, async () => {
      const output = action === 'reboot' ? (await this.adbCommand(serial, ['reboot'])).stdout.toString('utf8') : await this.shell(serial, action === 'settings' ? ['am', 'start', '--user', '0', '-a', 'android.settings.SETTINGS'] : ['input', 'keyevent', String(KEY_CODES[action])]);
      if (/Error:|Exception/.test(output)) throw new Error(output.trim());
      return { serial, action, output: output.trim() };
    });
  }
}
