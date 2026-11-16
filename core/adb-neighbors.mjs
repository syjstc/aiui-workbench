import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { run } from './util.mjs';
import { networkInterfacesByRoute } from './wireless-network.mjs';
import { LEGACY_ADB_PORT } from './adb.mjs';
const ipv4Number = ip => ip.split('.').reduce((value, part) => (value << 8) | Number(part), 0);

export function localIPv4Interfaces(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries || [])
    .filter(entry => !entry.internal && entry.family === 'IPv4')
    .map(entry => ({ name, ...entry })));
}

export function peerAddresses(table, interfaces = localIPv4Interfaces()) {
  const peers = new Set();
  for (const line of table.split(/\r?\n/)) {
    const ip = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
    const mac = line.match(/(?:^|\s)((?:[\da-f]{1,2}[:-]){5}[\da-f]{1,2})(?=\s|$)/i)?.[1];
    if (!mac || !net.isIPv4(ip || '')) continue;
    const octets = mac.split(/[:-]/).map(value => Number.parseInt(value, 16));
    if (octets[0] & 1 || octets.every(n => n === 0)) continue;
    if (Number(ip.split('.')[0]) >= 224 || /^(?:0|127)\./.test(ip) || interfaces.some(entry => entry.address === ip)) continue;
    if (interfaces.some(({ address, netmask }) => netmask !== '0.0.0.0' &&
        (ipv4Number(address) & ipv4Number(netmask)) === (ipv4Number(ip) & ipv4Number(netmask)))) peers.add(ip);
  }
  return [...peers];
}

async function readNeighbors() {
  if (process.platform === 'linux') {
    const table = await fs.readFile('/proc/net/arp', 'utf8').catch(() => '');
    if (table.trim().split('\n').length > 1) return table;
    return (await run('ip', ['-4', 'neigh', 'show'], { timeout: 1500 })).output;
  }
  const windows = process.platform === 'win32';
  return (await run(windows ? 'arp.exe' : '/usr/sbin/arp', [windows ? '-a' : '-an'], { timeout: 1500 })).output;
}

// Stop at the initial ADB protocol response. Never supply a key or send an ADB
// command. A TCP listener alone is not sufficient evidence of an ADB endpoint.
const A_CNXN = 0x4e584e43, A_AUTH = 0x48545541, A_STLS = 0x534c5453;
const banner = Buffer.from('host::\0');
const hello = Buffer.alloc(24 + banner.length);
[A_CNXN, 0x01000000, 4096, banner.length, banner.reduce((a, b) => a + b, 0), (~A_CNXN) >>> 0]
  .forEach((value, index) => hello.writeUInt32LE(value, index * 4));
banner.copy(hello, 24);

export function probeLegacyAdb(host, port = LEGACY_ADB_PORT) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let header = Buffer.alloc(0);
    const finish = found => { clearTimeout(deadline); socket.destroy(); resolve(found); };
    const deadline = setTimeout(() => finish(false), 800);
    socket.once('connect', () => socket.write(hello));
    socket.on('data', data => {
      header = Buffer.concat([header, data.subarray(0, 24 - header.length)]);
      if (header.length !== 24) return;
      const command = header.readUInt32LE(0), arg = header.readUInt32LE(4), length = header.readUInt32LE(12);
      const valid = (command === A_AUTH && arg === 1 && length === 20) ||
        (command === A_CNXN && length > 0 && length <= 4096) || (command === A_STLS && length === 0);
      finish(valid && header.readUInt32LE(20) === (~command >>> 0));
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

// Small on-link IPv4 networks can be searched after an explicit click when
// both service advertisements and the OS neighbor cache are empty. Respect
// each interface's real mask and a total budget on multi-homed workstations.
export function localScanHosts(interfaces, limit = 254, offset = 0) {
  const self = new Set(interfaces.map(entry => entry.address));
  const networks = new Map();
  for (const { address, netmask } of interfaces) {
    if (!net.isIPv4(address) || !net.isIPv4(netmask)) continue;
    const mask = ipv4Number(netmask) >>> 0, size = 0x100000000 - mask;
    if (size < 2 || size > 256 || !Number.isInteger(Math.log2(size))) continue;
    const start = (ipv4Number(address) & mask) >>> 0;
    const key = start + '/' + mask;
    if (networks.has(key)) continue;
    const hosts = [];
    networks.set(key, hosts);
    // /31 is a point-to-point link with two usable addresses.
    for (let i = size === 2 ? 0 : 1; i < size - (size === 2 ? 0 : 1); i++) {
      const value = start + i;
      const host = [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
      if (!self.has(host)) hosts.push(host);
    }
  }
  const ordered = [];
  for (let i = 0; i < 254; i++) for (const hosts of networks.values()) if (hosts[i]) ordered.push(hosts[i]);
  const start = offset % (ordered.length || 1);
  return ordered.slice(start).concat(ordered.slice(0, start)).slice(0, limit);
}

export function createLegacyFinder({ interfaces = networkInterfacesByRoute, neighbors = readNeighbors, probe = probeLegacyAdb, now = Date.now } = {}) {
  let network, lastSeen = [], nextNeighbor = 0, nextSweep = 0;
  return async function find({ active = false } = {}) {
    const adapters = (await interfaces()).filter(e => e.family === 'IPv4');
    const signature = JSON.stringify(adapters.map(e => [e.name, e.address, e.netmask, e.route]));
    if (network !== signature) { network = signature; lastSeen = []; nextNeighbor = 0; nextSweep = 0; }
    const all = peerAddresses(await neighbors().catch(() => ''), adapters);
    const start = nextNeighbor % (all.length || 1);
    const cached = all.slice(start).concat(all.slice(0, start)).slice(0, 32);
    nextNeighbor = (start + cached.length) % (all.length || 1);
    const tested = new Set(), verified = [];
    async function check(hosts) {
      const fresh = hosts.filter(host => !tested.has(host));
      for (const host of fresh) tested.add(host);
      for (let i = 0; i < fresh.length; i += 48) {
        const batch = fresh.slice(i, i + 48);
        const found = await Promise.all(batch.map(host => probe(host)));
        verified.push(...batch.filter((_, index) => found[index]));
      }
    }
    await check([...new Set([...lastSeen.filter(x => now() < x.expires).map(x => x.host), ...cached])]);
    if (active && !verified.length) {
      const primary = adapters.filter(e => e.route === 0);
      // Always cover the real gateway's small subnet on the first click. A
      // rotating cross-adapter budget can otherwise completely skip the glasses.
      await check(localScanHosts(primary));
      if (!verified.length) {
        const rest = adapters.filter(e => !primary.includes(e));
        const segment = localScanHosts(rest, 254, nextSweep);
        nextSweep = (nextSweep + segment.length) >>> 0;
        await check(segment);
      }
    }
    if (network !== signature) return [];
    if (verified.length) lastSeen = verified.slice(0, 32).map(host => ({ host, expires: now() + 90000 }));
    return verified.map(host => ({ host, address: host + ':' + LEGACY_ADB_PORT, type: 'legacy', name: '', source: 'neighbor' }));
  };
}

export const findLegacyPeers = createLegacyFinder();
