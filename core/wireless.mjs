import path from 'node:path';
import { isIP } from 'node:net';
import { adbAddress, LEGACY_ADB_PORT } from './adb.mjs';
import { parseDevices } from './devices.mjs';
import { atomicJson, readJson, id, sleep } from './util.mjs';
import { deviceAdbTrust } from './adb-trust.mjs';

const serviceKey = value => value?.replace(/\.$/, '');
export function parseMdns(output) {
  const services = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(_adb(?:-tls-pairing|-tls-connect)?\._tcp)\.?\s+(\S+)$/);
    if (!match) continue;
    try {
      const { address, host } = adbAddress(match[3]);
      const type = match[2].includes('pairing') ? 'pairing' : match[2].includes('tls') ? 'connect' : 'legacy';
      const name = serviceKey(match[1]).replace(/\._adb.*$/, '');
      services.set(name + ':' + type + ':' + address, { name, serviceName: name + '.' + match[2], type, address, host });
    } catch {}
  }
  return [...services.values()];
}

export function wifiAddress(output, interfaceName = '') {
  // Prefer the interface Android actually identifies as Wi-Fi. A missing
  // property on older firmware still allows conventional wlan/wifi interfaces.
  const candidates = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\d+:\s+([^\s@]+)(?:@\S+)?\s+.*?\binet(6)?\s+([a-f\d:.]+)\//i);
    if (!match) continue;
    const [, name, ipv6, host] = match;
    if (name !== interfaceName && !/^(?:wlan|wifi)[\w.-]*$/.test(name)) continue;
    if (ipv6 ? isIP(host) !== 6 || !/\bscope global\b/.test(line) : isIP(host) !== 4 || /^(?:0|127|169\.254)\./.test(host)) continue;
    if (name === interfaceName) return host;
    candidates.push(host);
  }
  return candidates[0] || null;
}

export function wirelessProblem(error, pairing = false) {
  const message = String(error?.message || error);
  if (/六位|IP:端口/.test(message)) return message;
  if (/身份不一致|无法核对/.test(message)) return message;
  if (/unauthorized|authentication|failed to authenticate/i.test(message)) return '无线连接尚未授权。请在眼镜上允许调试；使用配对码的固件请重新打开配对窗口，输入新的六位配对码。';
  if (pairing && /wrong|pair|protocol|failed|closed/i.test(message)) return '配对未完成。请保持眼镜的配对窗口打开，重新输入当前配对地址和六位配对码；配对端口与连接端口不同。';
  if (/ECONNREFUSED|refused|10061/i.test(message)) return '眼镜没有接受无线连接。请重新开启无线调试并核对当前连接端口；通过数据线准备的设备重启后可能需要再插线开启一次。';
  if (/timeout|超时|unreachable|no route|10060/i.test(message)) return '暂时无法通过网络找到眼镜。请让电脑和眼镜连接同一 Wi-Fi 或热点，保持眼镜开机；避免访客网络，并检查 VPN、防火墙及系统的本地网络权限。';
  if (/ENOENT|not found|unknown command.*mdns/i.test(message)) return '无线连接工具不可用。请使用完整的工坊安装包，或在新手指南中选择 Android 官方 platform-tools 文件夹。';
  return '无线连接未完成。请确认眼镜已开启无线调试，电脑与眼镜在同一网络，并使用当前显示的连接地址；需要配对时先完成配对。';
}

export class WirelessDebugging {
  constructor(home, adb, { now = Date.now, wait = sleep, trust = deviceAdbTrust } = {}) {
    this.file = path.join(home, 'wireless-devices.json');
    Object.assign(this, { adb, now, wait, trust });
    this.records = [];
    this.services = [];
    this.mdns = { available: null };
    this.server = { state: 'unknown' };
    this.attempts = new Map();
    this.pendingTransports = new Set();
    this.lastScan = -Infinity;
    this.busy = false;
  }
  init() {
    if (!this.initializing) this.initializing = (async () => {
      const saved = await readJson(this.file, { devices: [] });
      // Whitelist persisted fields: pairing codes and command output never
      // enter this journal, including after a failed command.
      this.records = (Array.isArray(saved.devices) ? saved.devices : []).slice(0, 20).flatMap(record => {
        try {
          if (!record || typeof record.id !== 'string' || !['tls', 'tcpip'].includes(record.kind)) return [];
          const address = record.address ? adbAddress(record.address).address : null;
          const host = address ? adbAddress(address).host : record.host;
          if (!isIP(host)) return [];
          return [{ id: record.id, address, host, kind: record.kind, identity: record.identity || '', serviceName: record.serviceName || '', name: record.name || '', lastConnectedAt: record.lastConnectedAt || null }];
        } catch { return []; }
      });
      return this;
    })();
    return this.initializing;
  }
  save() {
    const value = { devices: structuredClone(this.records) };
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => atomicJson(this.file, value));
    return this.saving;
  }
  async list() {
    const result = await this.adb.execute(['devices', '-l'], { timeout: 5000 });
    if (result.code) throw new Error(result.output);
    return parseDevices(result.output);
  }
  async scan(force = false) {
    if (this.scanning) return this.scanning;
    if (!force && this.now() - this.lastScan < 5000) return;
    this.lastScan = this.now();
    this.scanning = (async () => {
      await this.inspectServer(force);
      try {
        const result = await this.adb.execute(['mdns', 'services'], { timeout: 4000 });
        if (result.code || /unknown|not supported|error|failed/i.test(result.output)) throw new Error(result.output);
        this.services = parseMdns(result.output);
        this.mdns = { available: true };
      } catch {
        this.services = [];
        this.mdns = { available: false, message: '当前网络未能自动发现设备，仍可手动输入眼镜显示的地址连接。' };
      }
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async inspectServer(force = false) {
    if (!force && this.now() < (this.serverExpires || 0)) return;
    this.serverExpires = this.now() + 30000;
    try {
      const result = await this.adb.execute(['server-status'], { timeout: 3000 });
      this.server = result.code === 0 && /version:/.test(result.output)
        ? { state: 'ready', version: result.output.match(/version:\s*"([^"]+)"/)?.[1] || '' }
        : /unknown host service|unknown command/i.test(result.output)
          ? { state: 'legacy', message: '检测到旧版 ADB 后台，可能影响无线连接。请先结束其他工具的调试、投屏或录制，再点击“重启连接工具”后重试。' }
          : { state: 'unknown' };
    } catch { this.server = { state: 'unknown' }; }
  }
  async restart() {
    await this.init();
    return this.exclusive(async () => {
      await this.scanning;
      const stopped = await this.adb.execute(['kill-server'], { timeout: 6000 });
      if (stopped.code) throw new Error('连接工具未能停止，请先结束其他调试工具后重试。');
      const started = await this.adb.execute(['start-server'], { timeout: 10000 });
      if (started.code) throw new Error('连接工具未能重新启动，请检查系统权限后重试。');
      this.attempts.clear();
      await this.scan(true);
      return { restarted: true, message: '连接工具已重启，正在重新查找眼镜。已记住的无线设备会自动重连；首次使用请再点击连接。' };
    });
  }
  deviceFor(record, devices) {
    return devices.find(device => device.connection === 'wireless' &&
      (device.serial === record.address || serviceKey(device.serial) === serviceKey(record.serviceName)));
  }
  serviceFor(record) {
    if (record.serviceName) {
      const exact = this.services.filter(service => service.type !== 'pairing' && serviceKey(service.serviceName) === serviceKey(record.serviceName));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return exact.find(service => service.address === record.address) || null;
      // A reboot can rotate the mDNS suffix. Match the saved hardware serial,
      // never another device merely advertising the same model.
      if (record.identity) {
        const sameDevice = this.services.filter(service => service.type !== 'pairing' && service.name.startsWith('adb-' + record.identity + '-'));
        if (sameDevice.length === 1) return sameDevice[0];
      }
      return null;
    }
    // Only immediately after explicit pairing may the host associate one TLS
    // service with the pair endpoint's host. Reject ambiguous discoveries.
    if (!record.address && record.kind === 'tls') {
      const matches = this.services.filter(service => service.type === 'connect' && service.host === record.host);
      return matches.length === 1 ? matches[0] : null;
    }
    return this.services.find(service => service.type !== 'pairing' && service.address === record.address) || null;
  }
  snapshot(devices) {
    return {
      mdns: this.mdns, server: this.server, services: this.services, busy: this.busy,
      saved: this.records.map(record => {
        const device = this.deviceFor(record, devices), attempt = this.attempts.get(record.id);
        return { ...record, status: device?.status === 'device' ? 'connected' : attempt?.running ? 'reconnecting' : !record.address ? 'paired' : 'disconnected', error: attempt?.error || '', retryAt: attempt?.retryAt || null };
      }),
    };
  }
  async check(devices, { refresh = false, reconnect = true } = {}) {
    await this.init();
    await this.scan(refresh);
    if (reconnect && !this.busy && !this.resetting && !this.closed) {
      const record = this.records.find(record => this.deviceFor(record, devices)?.status !== 'device' &&
        !this.attempts.get(record.id)?.blocked && this.now() >= (this.attempts.get(record.id)?.retryAt || 0) &&
        (this.serviceFor(record) || record.address));
      if (record) this.reconnecting = this.reconnect(record).catch(() => {});
    }
    return this.snapshot(devices);
  }
  async status({ refresh = true } = {}) {
    const devices = await this.list();
    return this.check(devices, { refresh });
  }
  async exclusive(work) {
    if (this.busy || this.resetting) throw new Error('正在连接眼镜，请等待当前连接完成后再试。');
    if (this.closed) throw new Error('工坊正在关闭，请重新打开后连接。');
    this.busy = true;
    const operation = (async () => work())();
    this.operation = operation;
    try { return await operation; } finally { if (this.operation === operation) this.operation = null; this.busy = false; }
  }
  async reset({ revokeAuthorization = false, serial } = {}) {
    await this.init();
    if (this.resetting) return this.resetting;
    if (this.closed) throw new Error('工坊正在关闭，请重新打开后连接。');
    this.resetting = this.clearConnections({ revokeAuthorization, serial }).finally(() => { this.resetting = null; });
    return this.resetting;
  }
  async revokeDeviceTrust(serial, verifyUsb) {
    try {
      const result = await this.trust(this.adb, serial, { revoke: true });
      if (result.revoked !== true || !verifyUsb) return result.revoked === true;
      await this.wait(300);
      const after = await this.trust(this.adb, serial, { revoke: false });
      return after.supported === true && after.pairedCount === 0;
    } catch { return false; }
  }
  async clearConnections({ revokeAuthorization, serial }) {
    // A queued connection may still be verifying or writing its receipt. Wait
    // for it before clearing; the reset flag prevents new automatic retries.
    await this.operation?.catch(() => {});
    await this.scanning;
    this.busy = true;
    try {
      const previous = this.records;
      let devices = [], listFailed = false;
      try { devices = await this.list(); } catch { listFailed = true; }
      const selected = devices.find(device => device.serial === serial && device.status === 'device');
      const expected = previous.find(record => record.identity && (record.identity === selected?.serial || this.deviceFor(record, devices)?.serial === selected?.serial));
      if (revokeAuthorization && selected && expected) {
        const identity = await this.adb.execute(['-s', selected.serial, 'shell', 'getprop', 'ro.serialno'], { timeout: 5000 });
        if (identity.code || identity.output.trim() !== expected.identity) throw new Error('无法核对所选眼镜身份，尚未撤销授权。请确认目标眼镜后重试。');
      }
      const targets = new Set(previous.map(record => record.address).filter(Boolean));
      for (const record of previous) {
        const service = this.serviceFor(record);
        if (service) targets.add(service.address);
        const device = this.deviceFor(record, devices);
        if (device) targets.add(device.serial);
      }
      for (const endpoint of this.pendingTransports) {
        if (listFailed || devices.some(d => d.connection === 'wireless' && d.serial === endpoint)) targets.add(endpoint);
      }
      if (revokeAuthorization && selected?.connection === 'wireless') targets.add(selected.serial);
      this.records = [];
      try { await this.save(); }
      catch (error) { this.records = previous; throw error; }
      this.attempts.clear(); this.pendingTransports.clear();
      this.services = [];
      this.lastScan = -Infinity;
      const usb = revokeAuthorization && selected && (selected.connection === 'usb' ? selected :
        devices.find(device => device.connection === 'usb' && device.status === 'device' && device.serial === expected?.identity));
      // The last wireless transport must revoke before it disconnects. With USB
      // available, disconnect Wi-Fi first so no old Wi-Fi session can save its key again.
      let authorizationRevoked = false;
      if (revokeAuthorization && selected && !usb) authorizationRevoked = await this.revokeDeviceTrust(selected.serial, false);
      // Disconnect only transports owned by saved Workshop records. Never
      // issue the global "adb disconnect" or touch USB / unrelated devices.
      let disconnectFailed = false;
      for (const target of targets) {
        try {
          const result = await this.adb.execute(['disconnect', target], { timeout: 3000 });
          if (result.code && !/no such device|not connected|not found/i.test(result.output)) disconnectFailed = true;
        } catch { disconnectFailed = true; }
      }
      // Reconnecting USB here can immediately put its key back in the device keystore.
      if (usb) authorizationRevoked = await this.revokeDeviceTrust(usb.serial, true);
      try {
        devices = await this.list();
        listFailed = false;
        if (previous.some(record => this.deviceFor(record, devices)?.status === 'device') ||
          (revokeAuthorization && selected?.connection === 'wireless' && devices.some(device => device.serial === selected.serial && device.status === 'device'))) disconnectFailed = true;
      } catch { listFailed = true; }
      const disconnected = !disconnectFailed && !listFailed;
      const requiresUsbUnplug = Boolean(usb && devices.some(device => device.serial === usb.serial));
      return {
        cleared: true, disconnected, clearedCount: previous.length, authorizationRevoked, requiresUsbUnplug,
        requiresDeviceAction: revokeAuthorization && !authorizationRevoked,
        systemTrustRetained: !authorizationRevoked,
        wireless: this.snapshot(devices),
        message: authorizationRevoked && requiresUsbUnplug
          ? '眼镜已确认调试授权为零。请拔下数据线，再点击「一键连接眼镜」重走首次无线连接。'
          : revokeAuthorization && authorizationRevoked
          ? '工坊无线记录已清空，所选眼镜的全部 ADB 调试授权已撤销。下次连接需重新授权或配对。请自行从首次连接流程开始，工坊不会自动连接。'
          : revokeAuthorization
          ? '工坊无线记录已清空，但未能自动撤销眼镜授权。请在眼镜端忘记这台电脑或撤销 ADB 调试授权，再重新连接。'
          : disconnected
          ? '工坊无线连接记录已清空，已断开已记住眼镜的无线连接。现在可以重新连接。眼镜的 Wi-Fi、调试开关和系统授权保留。'
          : '工坊无线连接记录已清空，自动重连已停止，但未能确认所有无线连接已断开。系统仍记住配对时可能自动连接；完整重走配对需在眼镜端忘记这台电脑。',
      };
    } finally { this.busy = false; }
  }
  async verify(address, { identity = '', serviceName = '' } = {}) {
    let device;
    for (let attempt = 0; attempt < 4; attempt++) {
      const devices = await this.list();
      device = this.deviceFor({ address, serviceName }, devices);
      if (device?.status === 'device') break;
      if (device?.status === 'unauthorized') throw new Error('unauthorized');
      if (attempt < 3) await this.wait(400);
    }
    if (device?.status !== 'device') throw new Error('无线连接超时，ADB 尚未确认眼镜在线');
    const result = await this.adb.execute(['-s', device.serial, 'shell', 'getprop', 'ro.serialno'], { timeout: 5000 });
    const actualIdentity = result.code === 0 ? result.output.trim() : '';
    if (identity && (!actualIdentity || actualIdentity !== identity)) {
      await this.adb.execute(['disconnect', address], { timeout: 5000 }).catch(() => {});
      throw new Error(actualIdentity ? '无线设备身份不一致，已停止自动重连。请确认眼镜地址后重新连接。' : '无法核对无线设备身份。请保持眼镜开机，确认调试授权后重新连接。');
    }
    return { device, identity: actualIdentity };
  }
  async remember(address, verified, service, previous) {
    const host = adbAddress(address).host;
    const existing = previous || this.records.find(record => (verified.identity && record.identity === verified.identity) || record.address === address) ||
      this.records.find(record => !record.address && record.host === host);
    const record = {
      id: existing?.id || id(), address, host,
      kind: service?.type === 'connect' || existing?.kind === 'tls' ? 'tls' : 'tcpip',
      identity: verified.identity, serviceName: service?.serviceName || existing?.serviceName || '',
      name: verified.device.name, lastConnectedAt: new Date(this.now()).toISOString(),
    };
    this.records = [record, ...this.records.filter(item => item.id !== record.id && (!record.identity || item.identity !== record.identity))].slice(0, 20);
    this.attempts.delete(record.id);
    await this.save();
    return record;
  }
  async establish(address, service, previous) {
    try {
      await this.adb.connect({ address });
      return await this.confirmOnline(address, service, previous);
    } catch (error) {
      if (/unauthorized|authentication|authenticate|未授权/i.test(error.message)) {
        this.pendingTransports.add(address);
        if (this.pendingTransports.size > 20) this.pendingTransports.delete(this.pendingTransports.values().next().value);
      }
      throw error;
    }
  }
  async confirmOnline(address, service, previous) {
    const verified = await this.verify(address, { identity: previous?.identity, serviceName: service?.serviceName || previous?.serviceName });
    const record = await this.remember(address, verified, service, previous);
    this.pendingTransports.delete(address);
    return { connected: true, address, serial: verified.device.serial, recordId: record.id, message: '无线连接已确认。' };
  }
  async connect({ address, pairingCode, connectAddress }, qrPair) {
    address = adbAddress(address).address;
    if (connectAddress) connectAddress = adbAddress(connectAddress).address;
    if (pairingCode !== undefined && !/^\d{6}$/.test(pairingCode)) throw new Error('请输入眼镜显示的六位配对码');
    if (pairingCode && connectAddress === address) throw new Error('配对端口与连接端口不同，请填写无线调试主页显示的连接地址。');
    await this.init();
    return this.exclusive(async () => {
      let paired = false;
      try {
        if (pairingCode || qrPair) {
          if (qrPair) await qrPair();
          else await this.adb.connect({ address, pairingCode });
          paired = true;
        }
        await this.scan(true);
        if (!paired) {
          const service = this.services.find(service => service.address === address);
          if (service?.type === 'pairing') throw new Error('这是配对地址，请先输入六位配对码完成配对。');
          return await this.establish(address, service);
        }
        const host = adbAddress(address).host;
        const services = this.services.filter(service => service.type === 'connect' && service.host === host);
        const service = connectAddress ? services.find(service => service.address === connectAddress) : services.length === 1 ? services[0] : null;
        const target = connectAddress || service?.address;
        let connectionError;
        if (target) {
          try { return { ...await this.establish(target, service), paired: true }; }
          catch (error) {
            connectionError = wirelessProblem(error);
          }
        }
        const previous = this.records.find(record => !record.address && record.host === host);
        if (!previous) {
          this.records.unshift({ id: id(), address: null, host, kind: 'tls', identity: '', serviceName: '', name: '', lastConnectedAt: null });
          this.records = this.records.slice(0, 20);
          await this.save();
        }
        if (connectionError) return { paired: true, connected: false, nextStep: 'connect', message: '配对已完成，调试连接尚未就绪。' + connectionError };
        return { paired: true, connected: false, nextStep: 'connect', message: '配对已完成，正在寻找调试连接。若没有自动连上，请返回眼镜的无线调试主页，输入“IP 地址和端口”；不要继续使用配对窗口的端口。' };
      } catch (error) {
        if (/这是配对地址/.test(error.message)) throw error;
        throw new Error(wirelessProblem(error, !!pairingCode && !paired));
      }
    });
  }
  async reconnect(record) {
    return this.exclusive(async () => {
      const previous = this.attempts.get(record.id) || { failures: 0 };
      this.attempts.set(record.id, { ...previous, running: true });
      try {
        const service = this.serviceFor(record), address = service?.address || record.address;
        return await this.establish(address, service, record);
      } catch (error) {
        const failures = previous.failures + 1;
        this.attempts.set(record.id, { failures, running: false, retryAt: this.now() + Math.min(30000, 3000 * 2 ** Math.min(failures, 4)), blocked: /身份不一致/.test(error.message), error: wirelessProblem(error) });
        throw new Error(wirelessProblem(error));
      }
    });
  }
  async saved({ recordId, action }) {
    await this.init();
    const record = this.records.find(record => record.id === recordId);
    if (!record) throw new Error('这条无线设备记录已不存在，请重新连接。');
    if (action === 'reconnect') {
      await this.scan(true);
      return this.reconnect(record);
    }
    if (action !== 'forget') throw new Error('无线设备操作无效');
    return this.exclusive(async () => {
      this.records = this.records.filter(item => item.id !== recordId);
      this.attempts.delete(recordId);
      await this.save();
      return { forgotten: true };
    });
  }
  async enable({ serial }) {
    await this.init();
    return this.exclusive(async () => {
      const device = (await this.list()).find(device => device.serial === serial);
      if (!device || device.connection !== 'usb' || device.status !== 'device') throw new Error('请先用数据线连接眼镜并允许调试，再一键切换无线。');
      const addresses = await this.adb.execute(['-s', serial, 'shell', 'ip', '-o', '-4', 'addr', 'show'], { timeout: 5000 });
      const property = await this.adb.execute(['-s', serial, 'shell', 'getprop', 'wifi.interface'], { timeout: 3000 }).catch(() => null);
      const interfaceName = property?.code === 0 ? property.output.trim() : '';
      let host = addresses.code === 0 ? wifiAddress(addresses.output, interfaceName) : null;
      if (!host) {
        const v6 = await this.adb.execute(['-s', serial, 'shell', 'ip', '-o', '-6', 'addr', 'show', 'scope', 'global'], { timeout: 5000 }).catch(() => null);
        if (v6?.code === 0) host = wifiAddress(v6.output, interfaceName);
      }
      if (!host) return {
        connected: false, nextStep: 'wifi',
        message: '眼镜尚未连接 Wi-Fi。请先让眼镜与电脑连接同一 Wi-Fi 或热点，再点击“一键切换无线”。手机能上网或已通过蓝牙连接眼镜，并不代表眼镜已连接 Wi-Fi。',
      };
      // Learn the hardware identity before restarting adbd. A successful tcpip
      // receipt alone is never permission to tell the user to unplug USB.
      const identity = await this.adb.execute(['-s', serial, 'shell', 'getprop', 'ro.serialno'], { timeout: 5000 });
      if (identity.code || !identity.output.trim()) throw new Error('无法核对眼镜身份，请确认调试授权后重试。');
      const configured = await this.adb.execute(['-s', serial, 'shell', 'getprop', 'service.adb.tcp.port'], { timeout: 3000 }).catch(() => null);
      const port = Number(configured?.output.trim());
      const tcpPort = configured?.code === 0 && Number.isInteger(port) && port > 0 && port <= 65535 ? port : LEGACY_ADB_PORT;
      const address = (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + tcpPort;
      const result = await this.adb.execute(['-s', serial, 'tcpip', String(tcpPort)], { timeout: 8000 });
      if (result.code || Number(result.output.match(/restarting in TCP mode port:\s*(\d+)/i)?.[1]) !== tcpPort) throw new Error('眼镜未能开启无线调试。请保持数据线连接，并确认当前固件支持 ADB 网络调试。');
      let failure;
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.wait(800);
        try {
          const result = await this.establish(address, null, { id: this.records.find(record => record.identity === identity.output.trim())?.id || id(), identity: identity.output.trim(), kind: 'tcpip' });
          return { ...result, message: '无线连接已确认，可以拔下数据线；安装、日志、文件和投屏均可继续使用。' };
        }
        catch (error) { failure = error; if (/身份不一致/.test(error.message)) break; }
      }
      throw new Error(wirelessProblem(failure));
    });
  }
  async close() {
    this.closed = true;
    await this.resetting;
    await this.reconnecting;
    await this.scanning;
    await this.saving;
  }
}
