import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { AdbTools, adbAddress } from '../core/adb.mjs';
import { WirelessDebugging, parseMdns, wifiAddress } from '../core/wireless.mjs';
import { createServer } from 'node:net';
import { gatewayAdapters } from '../core/wireless-network.mjs';
import { WirelessHelperShare } from '../core/wireless-helper-share.mjs';
import { WirelessSetup } from '../core/wireless-setup.mjs';
import { WirelessPairQr } from '../core/wireless-pair-qr.mjs';
import { connectionGuide } from '../core/connection-guide.mjs';
import { createLegacyFinder, localScanHosts, peerAddresses, probeLegacyAdb } from '../core/adb-neighbors.mjs';
import { parseDevices } from '../core/devices.mjs';
import { Workbench } from '../core/service.mjs';
import { toolCatalog } from '../core/tool-catalog.mjs';
import { UI_TOOLS } from '../core/ui-tools.mjs';
import { recoveryFor } from '../core/diagnostics.mjs';

const ip = '192.168.1.24', address = ip + ':40123';
const service = (type = 'connect', port = 40123, name = 'adb-GLASSES123-abc') => name + '\t_adb-tls-' + type + '._tcp.\t' + ip + ':' + port + '\n';
const row = (serial = address, status = 'device') => serial + '\t' + status + ' model:RG_glasses transport_id:1\n';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-wireless-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const state = { clock: 100000, listing: '', mdns: service(), online: true, identity: 'GLASSES123', connectError: '', pairError: '', calls: [], wifi: '3: wlan0    inet ' + ip + '/24 brd 192.168.1.255 scope global wlan0\n' };
  const adb = new AdbTools(home);
  adb.execute = async (args, options) => {
    state.calls.push([...args]);
    if (args[0] === 'pair') state.pairInput = options?.input;
    if (args[0] === 'server-status') return { code: state.legacy ? 1 : 0, output: state.legacy ? 'error: unknown host service' : 'version: "37.0.1"\n' };
    if (args[0] === 'kill-server') { state.legacy = false; return { code: 0, output: '' }; }
    if (args[0] === 'start-server') return { code: 0, output: '' };
    if (args[0] === 'mdns') return { code: state.mdnsError ? 1 : 0, output: state.mdnsError || 'List of discovered mdns services\n' + state.mdns };
    if (args[0] === 'devices') return { code: 0, output: 'List of devices attached\n' + state.listing };
    if (args[0] === 'pair') return { code: 0, output: state.pairError || 'Successfully paired to ' + args[1] + ' [guid=adb-test]' };
    if (args[0] === 'connect') {
      if (state.connectError) return { code: 0, output: state.connectError };
      if (state.online) state.listing += row(state.alias || args[1]);
      return { code: 0, output: 'connected to ' + args[1] };
    }
    if (args[0] === 'disconnect') {
      if (state.disconnectError) return { code: 1, output: state.disconnectError };
      state.listing = state.listing.split('\n').filter(line => line.split(/\s/)[0] !== args[1]).join('\n');
      return { code: 0, output: 'disconnected ' + args[1] };
    }
    if (args[2] === 'reconnect') { state.listing = row(args[1], 'unauthorized'); return { code: 0, output: 'reconnecting' }; }
    if (args[2] === 'tcpip') return { code: 0, output: 'restarting in TCP mode port: 5555\n' };
    if (args[3] === 'ip') return { code: 0, output: state.wifi };
    if (args[3] === 'getprop') return { code: 0, output: state.identity + '\n' };
    throw new Error('Unexpected fake command: ' + JSON.stringify(args));
  };
  const wireless = new WirelessDebugging(home, adb, { now: () => state.clock, wait: async () => {}, trust: async (_adb, serial, options) => {
    state.trustCalls = [...(state.trustCalls || []), { serial, ...options }];
    return state.trustReceipt || { supported: true, revoked: true, remainingCount: 0, pairedCount: state.pairedAfterReset ?? 0 };
  } });
  t.after(() => wireless.close());
  return { home, adb, wireless, state };
}

test('wireless endpoints and mDNS cover IPv4, IPv6, duplicates and malformed advertisements', () => {
  assert.equal(adbAddress(' 192.168.1.24:05555 ').address, ip + ':5555');
  assert.equal(adbAddress('[2001:DB8::2]:5555').address, '[2001:db8::2]:5555');
  for (const value of ['-s other', '192.168.1.2:0', '192.168.1.2:65536', '256.1.1.1:5555', 'localhost:5555']) assert.throws(() => adbAddress(value), /IP:端口/);
  const services = parseMdns(service() + service() + service('pairing', 37123) + 'bad _adb._tcp 999.0.0.1:5555\nold _adb._tcp 192.168.1.30:5555\nv6 _adb-tls-connect._tcp [2001:db8::2]:5555');
  assert.equal(services.length, 4);
  assert.deepEqual(services.map(service => service.type), ['connect', 'pairing', 'legacy', 'connect']);
  assert.equal(services[0].serviceName, 'adb-GLASSES123-abc._adb-tls-connect._tcp');
  assert.equal(parseDevices(row('adb-test._adb-tls-connect._tcp'))[0].connection, 'wireless');
  assert.equal(parseDevices(row('[2001:db8::2]:5555'))[0].connection, 'wireless');
  assert.equal(parseDevices(row('USB123'))[0].connection, 'usb');
});

test('Wi-Fi selection excludes Bluetooth, VPN and loopback even when they appear first', () => {
  assert.equal(wifiAddress('1: lo inet 127.0.0.1/8\n2: bnep0 inet 192.168.44.1/24\n3: tun0 inet 10.0.0.2/24\n4: wlan0 inet 192.168.1.24/24\n'), ip);
  assert.equal(wifiAddress('2: bnep0 inet 192.168.44.1/24'), null);
});

test('pairing discovers the separate debug port, verifies online and never persists the code', async t => {
  const { wireless, state, home } = await fixture(t);
  const result = await wireless.connect({ address: ip + ':37123', pairingCode: '483926' });
  assert.equal(result.paired, true);
  assert.equal(result.connected, true);
  assert.equal(result.address, address);
  assert.ok(state.calls.some(args => args[0] === 'pair' && args[1].endsWith(':37123')));
  assert.ok(state.calls.some(args => args[0] === 'connect' && args[1].endsWith(':40123')));
  const saved = await fs.readFile(path.join(home, 'wireless-devices.json'), 'utf8');
  assert.ok(!saved.includes('483926'));
  assert.ok(!saved.includes('37123'));
  assert.equal(JSON.parse(saved).devices[0].identity, 'GLASSES123');
});

test('pairing without discovery stays pending and can later connect without repeating the code', async t => {
  const { wireless, state } = await fixture(t);
  state.mdns = '';
  const paired = await wireless.connect({ address: ip + ':37123', pairingCode: '483926' });
  assert.equal(paired.paired, true);
  assert.equal(paired.connected, false);
  assert.equal(paired.nextStep, 'connect');
  assert.ok(!state.calls.some(args => args[0] === 'connect'));
  state.mdns = service();
  await wireless.check([], { refresh: true });
  await wireless.reconnecting;
  assert.equal(wireless.records[0].address, address);
  assert.equal(state.calls.filter(args => args[0] === 'pair').length, 1);
});

test('manual pairing supports networks without mDNS and refuses a reused pairing port', async t => {
  const { wireless, state } = await fixture(t);
  state.mdnsError = 'unknown command mdns';
  const paired = await wireless.connect({ address: ip + ':37123', pairingCode: '483926', connectAddress: address });
  assert.equal(paired.connected, true);
  await assert.rejects(wireless.connect({ address, pairingCode: '483926', connectAddress: address }), /端口不同/);
});

test('manual connection after pending pairing replaces the pending record without duplicates', async t => {
  const { wireless, state } = await fixture(t);
  state.mdns = '';
  await wireless.connect({ address: ip + ':37123', pairingCode: '483926' });
  const pendingId = wireless.records[0].id;
  await wireless.connect({ address });
  assert.equal(wireless.records.length, 1);
  assert.equal(wireless.records[0].id, pendingId);
  assert.equal(wireless.records[0].kind, 'tls');
});

test('pair success followed by an unavailable debug port is reported as paired but not connected', async t => {
  const { wireless, state } = await fixture(t);
  state.connectError = 'failed to connect: Connection refused';
  const result = await wireless.connect({ address: ip + ':37123', pairingCode: '483926' });
  assert.equal(result.paired, true);
  assert.equal(result.connected, false);
  assert.match(result.message, /配对已完成/);
  assert.equal(wireless.records[0].address, null);
  assert.equal(wireless.records[0].lastConnectedAt, null);
  state.connectError = '';
  await wireless.check([], { refresh: true });
  await wireless.reconnecting;
  assert.equal(wireless.records[0].address, address);
});

test('ambiguous pairing discoveries never connect to an arbitrary endpoint', async t => {
  const { wireless, state } = await fixture(t);
  state.mdns += service('connect', 40222, 'adb-OTHER-def');
  const result = await wireless.connect({ address: ip + ':37123', pairingCode: '483926' });
  assert.equal(result.connected, false);
  assert.ok(!state.calls.some(args => args[0] === 'connect'));
});

test('a successful connect receipt with offline or unauthorized state cannot claim success', async t => {
  const { wireless, state } = await fixture(t);
  state.online = false;
  await assert.rejects(wireless.connect({ address }), /网络找到眼镜/);
  assert.equal(wireless.records.length, 0);
  state.listing = row(address, 'unauthorized');
  await assert.rejects(wireless.connect({ address }), /尚未授权/);
});

test('zero-exit ADB errors and expired pairing codes have useful messages without leaking the code', async t => {
  const { wireless, state, home } = await fixture(t);
  state.pairError = 'error: wrong pairing code 483926';
  await assert.rejects(wireless.connect({ address: ip + ':37123', pairingCode: '483926' }), error => /配对未完成/.test(error.message) && !error.message.includes('483926'));
  await assert.rejects(fs.access(path.join(home, 'wireless-devices.json')));
  state.connectError = 'failed to connect: Connection refused';
  await assert.rejects(wireless.connect({ address }), /当前连接端口/);
  assert.equal(recoveryFor('配对未完成').view, 'devices');
});

test('saved devices survive restart and reconnect to a newly advertised port with backoff', async t => {
  const { wireless, state, home, adb } = await fixture(t);
  await wireless.connect({ address });
  const restored = new WirelessDebugging(home, adb, { now: () => state.clock, wait: async () => {} });
  t.after(() => restored.close());
  state.mdns = service('connect', 42222); state.listing = ''; state.connectError = 'failed to connect: Connection refused';
  await restored.check([], { refresh: true });
  await restored.reconnecting;
  const first = state.calls.filter(args => args[0] === 'connect').length;
  await restored.check([]);
  assert.equal(state.calls.filter(args => args[0] === 'connect').length, first);
  assert.equal(restored.snapshot([]).saved[0].status, 'disconnected');
  state.clock += 6001; state.connectError = '';
  await restored.check([], { refresh: true });
  await restored.reconnecting;
  assert.equal(restored.records[0].address, ip + ':42222');
  assert.equal(restored.snapshot(parseDevices(state.listing)).saved[0].status, 'connected');
});

test('auto-reconnection rejects a different device at the remembered IP address', async t => {
  const { wireless, state } = await fixture(t);
  await wireless.connect({ address });
  state.identity = 'OTHER_DEVICE'; state.listing = '';
  await wireless.check([], { refresh: true });
  await wireless.reconnecting;
  assert.ok(state.calls.some(args => args[0] === 'disconnect'));
  assert.match(wireless.snapshot([]).saved[0].error, /身份不一致/);
  assert.equal(wireless.records[0].identity, 'GLASSES123');
  const count = state.calls.length; state.clock += 60000;
  await wireless.check([]);
  assert.equal(state.calls.slice(count).filter(args => args[0] === 'connect').length, 0);
});

test('mDNS aliases are verified and a rotating suffix follows only the saved hardware identity', async t => {
  const { wireless, state } = await fixture(t);
  state.alias = 'adb-GLASSES123-abc._adb-tls-connect._tcp';
  await wireless.connect({ address });
  state.mdns = service('connect', 42222, 'adb-GLASSES123-new') + service('connect', 42223, 'adb-OTHER-xyz');
  state.alias = 'adb-GLASSES123-new._adb-tls-connect._tcp'; state.listing = '';
  await wireless.check([], { refresh: true });
  await wireless.reconnecting;
  assert.equal(wireless.records[0].address, ip + ':42222');
});

test('USB switch checks Wi-Fi before mutations, verifies the hardware and only then allows unplugging', async t => {
  const { wireless, state } = await fixture(t);
  state.listing = row('GLASSES123');
  state.wifi = '1: lo inet 127.0.0.1/8\n2: bnep0 inet 192.168.44.1/24\n';
  const pending = await wireless.enable({ serial: 'GLASSES123' });
  assert.equal(pending.connected, false);
  assert.equal(pending.nextStep, 'wifi');
  assert.ok(!state.calls.some(args => args[2] === 'tcpip'));
  state.wifi = '3: wlan0 inet ' + ip + '/24';
  const ready = await wireless.enable({ serial: 'GLASSES123' });
  assert.equal(ready.connected, true);
  assert.equal(ready.address, ip + ':5555');
  assert.equal(wireless.records[0].identity, 'GLASSES123');
  assert.ok(state.calls.some(args => args[2] === 'tcpip' && args[3] === '5555'));
});

test('forgetting a record stops Workbench retries without interrupting a live connection', async t => {
  const { wireless, state } = await fixture(t);
  const result = await wireless.connect({ address });
  await wireless.saved({ recordId: result.recordId, action: 'forget' });
  assert.equal(wireless.records.length, 0);
  const count = state.calls.length; state.listing = '';
  await wireless.check([], { refresh: true });
  assert.ok(!state.calls.slice(count).some(args => ['connect', 'disconnect'].includes(args[0])));
});

test('discovery does not connect unfamiliar devices and manual operations cannot race a connection', async t => {
  const { wireless, state, adb } = await fixture(t);
  const snapshot = await wireless.check([], { refresh: true });
  assert.equal(snapshot.services.length, 1);
  assert.ok(!state.calls.some(args => args[0] === 'connect'));
  let release;
  const execute = adb.execute;
  adb.execute = async args => { if (args[0] === 'connect') await new Promise(resolve => { release = resolve; }); return execute(args); };
  const first = wireless.connect({ address });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(wireless.connect({ address }), /正在连接/);
  release(); await first;
});

test('legacy server detection offers a restart without silently disrupting ADB', async t => {
  const { wireless, state } = await fixture(t);
  state.legacy = true;
  const status = await wireless.check([], { refresh: true });
  assert.equal(status.server.state, 'legacy');
  assert.ok(!state.calls.some(args => args[0] === 'kill-server'));
  const result = await wireless.restart();
  assert.equal(result.restarted, true);
  assert.equal(wireless.server.state, 'ready');
  assert.ok(state.calls.some(args => args[0] === 'kill-server'));
});

test('reset clears saved records and attempts, disconnecting only owned wireless transports', async t => {
  const { wireless, state, home, adb } = await fixture(t);
  await wireless.connect({ address });
  const unrelated = '192.168.2.20:5555';
  state.listing += row('USB123') + row(unrelated);
  wireless.attempts.set(wireless.records[0].id, { failures: 2, error: 'old failure' });
  const preserved = path.join(home, 'projects.json');
  await fs.writeFile(preserved, 'keep projects');
  const result = await wireless.reset();
  assert.equal(result.cleared, true); assert.equal(result.disconnected, true);
  assert.equal(result.systemTrustRetained, true);
  assert.equal(result.clearedCount, 1);
  assert.deepEqual(wireless.records, []);
  assert.equal(wireless.attempts.size, 0);
  assert.equal(state.trustCalls, undefined, 'ordinary reset never revokes system authorization');
  assert.deepEqual(state.calls.filter(args => args[0] === 'disconnect'), [['disconnect', address]]);
  assert.ok(state.listing.includes(unrelated) && state.listing.includes('USB123'));
  assert.equal(await fs.readFile(preserved, 'utf8'), 'keep projects');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'wireless-devices.json'), 'utf8')).devices, []);
  const restored = new WirelessDebugging(home, adb);
  t.after(() => restored.close());
  const count = state.calls.filter(args => args[0] === 'connect').length;
  await restored.check(parseDevices(state.listing), { refresh: true });
  assert.equal(state.calls.filter(args => args[0] === 'connect').length, count, 'empty records stay empty after restart even when mDNS advertises devices');
});

test('reset waits for an in-flight connection and prevents its saved record from reappearing', async t => {
  const { wireless, state, adb } = await fixture(t);
  const execute = adb.execute;
  let release;
  adb.execute = async args => { if (args[0] === 'connect') await new Promise(resolve => { release = resolve; }); return execute(args); };
  const connect = wireless.connect({ address });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const reset = wireless.reset();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(wireless.connect({ address }), /正在连接/);
  await wireless.check([], { refresh: true });
  release(); await connect;
  assert.equal((await reset).cleared, true);
  assert.deepEqual(wireless.records, []);
  assert.ok(!state.listing.includes(address));
});

test('a failed disconnect reports partial completion while clearing records and stopping retries', async t => {
  const { wireless, state } = await fixture(t);
  await wireless.connect({ address });
  state.disconnectError = 'unable to disconnect';
  const result = await wireless.reset();
  assert.equal(result.cleared, true);
  assert.equal(result.disconnected, false);
  assert.deepEqual(wireless.records, []);
  assert.match(result.message, /未能确认/);
});

test('full reset verifies zero keys over the matching USB transport without reauthorizing the host', async t => {
  const { wireless, state } = await fixture(t);
  await wireless.connect({ address });
  state.listing += row('GLASSES123');
  const result = await wireless.reset({ revokeAuthorization: true, serial: address });
  assert.equal(result.authorizationRevoked, true);
  assert.equal(result.requiresDeviceAction, false);
  assert.equal(result.systemTrustRetained, false);
  assert.deepEqual(state.trustCalls, [{ serial: 'GLASSES123', revoke: true }, { serial: 'GLASSES123', revoke: false }]);
  assert.ok(!state.calls.some(args => args[2] === 'reconnect'));
  assert.equal(result.requiresUsbUnplug, true);
  assert.equal(wireless.records.length, 0);
});

test('a USB key that reappears after the operating system acknowledged clearing needs device action', async t => {
  const { wireless, state } = await fixture(t);
  state.listing = row('GLASSES123'); state.pairedAfterReset = 1;
  const result = await wireless.reset({ revokeAuthorization: true, serial: 'GLASSES123' });
  assert.equal(result.authorizationRevoked, false);
  assert.equal(result.requiresDeviceAction, true);
  assert.equal(result.requiresUsbUnplug, true);
});

test('unsupported or offline device revocation stays explicitly incomplete after local clearing', async t => {
  const { wireless, state } = await fixture(t);
  await wireless.connect({ address });
  state.trustReceipt = { supported: false, revoked: false };
  const unsupported = await wireless.reset({ revokeAuthorization: true, serial: address });
  assert.equal(unsupported.cleared, true);
  assert.equal(unsupported.authorizationRevoked, false);
  assert.equal(unsupported.requiresDeviceAction, true);
  state.listing = '';
  const offline = await wireless.reset({ revokeAuthorization: true, serial: address });
  assert.equal(offline.requiresDeviceAction, true);
});

test('full reset will not revoke a different device that reused the saved address', async t => {
  const { wireless, state } = await fixture(t);
  await wireless.connect({ address });
  state.identity = 'ANOTHER_DEVICE';
  await assert.rejects(wireless.reset({ revokeAuthorization: true, serial: address }), /尚未撤销/);
  assert.equal(state.trustCalls, undefined);
  assert.equal(wireless.records.length, 1);
});

test('reset preserves records if persistence fails before disconnecting or revoking', async t => {
  const { wireless, state } = await fixture(t);
  await wireless.connect({ address });
  wireless.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(wireless.reset({ revokeAuthorization: true, serial: address }), /disk unavailable/);
  assert.equal(wireless.records.length, 1);
  assert.ok(!state.calls.some(args => args[0] === 'disconnect'));
  assert.equal(state.trustCalls, undefined);
});

test('ADB restart refuses to interrupt running jobs, mirroring or recording', async t => {
  const { home, wireless } = await fixture(t);
  const workbench = new Workbench(home);
  workbench.wireless = wireless;
  let restarts = 0; wireless.restart = async () => { restarts++; return { restarted: true }; };
  workbench.jobs.list = () => [{ status: 'running' }];
  await assert.rejects(workbench.dispatch('aiui_adb_restart'), /先结束/);
  workbench.jobs.list = () => [];
  workbench.mirroring = { sessions: new Map([['test', { status: 'running' }]]), embedded: { sessions: new Map() } };
  await assert.rejects(workbench.dispatch('aiui_adb_restart'), /先结束/);
  workbench.mirroring.sessions.clear();
  workbench.recordings = { status: () => ({ recordings: [{ status: 'recording' }] }) };
  await assert.rejects(workbench.dispatch('aiui_adb_restart'), /先结束/);
  workbench.recordings.status = () => ({ recordings: [] });
  assert.equal((await workbench.dispatch('aiui_adb_restart')).restarted, true);
  assert.equal(restarts, 1);
});

test('shared desktop, Web and MCP contracts expose wireless tools and environment status', async t => {
  const { home, wireless, adb } = await fixture(t);
  const workbench = new Workbench(home);
  workbench.wireless = wireless; workbench.adb = adb;
  workbench.runtimeInfo = () => ({ runtime: 'test' });
  workbench.devices.check = async () => ({ adb: true, aix: true, devices: [] });
  const catalog = toolCatalog();
  for (const name of ['aiui_connection_guide', 'aiui_adb_pair_qr', 'aiui_adb_connect', 'aiui_adb_discover', 'aiui_adb_wireless_enable', 'aiui_adb_saved', 'aiui_adb_restart', 'aiui_adb_reset']) {
    assert.ok(UI_TOOLS.has(name));
    assert.ok(catalog.tools.some(tool => tool.name === name));
  }
  assert.ok(catalog.tools.find(tool => tool.name === 'aiui_adb_connect').inputSchema.properties.connectAddress);
  assert.equal((await workbench.dispatch('aiui_adb_discover')).services.length, 1);
  assert.ok((await workbench.dispatch('aiui_environment_check')).wireless);
  await wireless.connect({ address });
  workbench.devices.check = async () => ({ adb: true, aix: true, devices: parseDevices(row('GLASSES123') + row(address)) });
  const environment = await workbench.dispatch('aiui_environment_check');
  assert.equal(environment.devices.length, 1, 'USB and verified wireless transports of one glasses are shown as one device');
  assert.equal(environment.devices[0].connection, 'wireless');
  assert.equal(environment.usbDevices.length, 1, 'USB handoff remains available');
});

test('first-use discovery adapts to actual interface masks, neighbor table formats and overlapping adapters', () => {
  const interfaces = [
    { address: '10.47.0.33', netmask: '255.255.255.248' },
    { address: '172.31.114.51', netmask: '255.255.255.254' },
    { address: '10.47.0.34', netmask: '255.255.255.248' },
  ];
  const peers = peerAddresses([
    '? (10.47.0.35) at 2:a:bc:1:2:ff on wifi0 ifscope [ethernet]',
    '10.47.0.36 0x1 0x2 a2:00:01:02:ff:01 * net0',
    '    172.31.114.50     d0-12-8e-5c-89-f0    dynamic',
    '172.31.114.10 dev eth1 lladdr 02:ab:cd:ef:00:01 REACHABLE',
    '10.47.0.34 0x1 0x2 a2:00:01:02:ff:01 * net0',
    '10.47.0.37 01:00:5e:00:00:aa',
    '10.47.0.39 (incomplete)',
  ].join('\n'), interfaces);
  assert.deepEqual(peers, ['10.47.0.35', '10.47.0.36', '172.31.114.50']);
  assert.deepEqual(localScanHosts(interfaces), ['10.47.0.35', '172.31.114.50', '10.47.0.36', '10.47.0.37', '10.47.0.38']);
  assert.deepEqual(localScanHosts([{ address: '10.4.1.2', netmask: '255.255.0.0' }]), []);
  assert.equal(adbAddress('[fe80::AB%Hotspot1]:37893').address, '[fe80::ab%Hotspot1]:37893');
  assert.equal(parseDevices(row('[fe80::ab%Hotspot1]:37893'))[0].connection, 'wireless');
  assert.equal(wifiAddress('9: custom0 inet6 2001:db8::2/64 scope global', 'custom0'), '2001:db8::2');
});

test('a listening HTTP port is not an ADB endpoint and a split AUTH reply requires no public key', async () => {
  async function check(response) {
    let received = Buffer.alloc(0);
    const server = createServer(socket => {
      socket.on('error', () => {});
      socket.on('data', data => {
        received = Buffer.concat([received, data]);
        if (received.length === 31) { socket.write(response.subarray(0, 7)); setImmediate(() => socket.end(response.subarray(7))); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const found = await probeLegacyAdb('127.0.0.1', server.address().port);
      assert.equal(received.length, 31);
      assert.equal(received.subarray(0, 4).toString(), 'CNXN');
      return found;
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  const auth = Buffer.alloc(44);
  auth.write('AUTH'); auth.writeUInt32LE(1, 4); auth.writeUInt32LE(20, 12);
  auth.writeUInt32LE((~auth.readUInt32LE(0)) >>> 0, 20);
  assert.equal(await check(auth), true);
  assert.equal(await check(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')), false);
  auth[20] ^= 1; assert.equal(await check(auth), false);
});

test('choosing a target, expiring, and resetting an unapproved first connection never authorizes a different device', async t => {
  const { wireless, state } = await fixture(t);
  state.mdns = '';
  const peers = [address, '172.16.2.8:5555'].map(address => ({ address, host: address.split(':')[0], type: 'legacy', name: '', source: 'neighbor' }));
  const activeSearches = [];
  const setup = new WirelessSetup(wireless, { findPeers: async ({ active }) => { activeSearches.push(active); return peers; }, now: () => state.clock });
  t.after(() => setup.cancel());
  assert.equal((await setup.start()).stage, 'choose');
  assert.deepEqual(activeSearches, [true]); assert.ok(!state.calls.some(a => a[0] === 'connect'));
  state.listing = row(address, 'unauthorized'); state.connectError = 'failed to authenticate';
  const waiting = await setup.start({ address });
  assert.equal(waiting.stage, 'authorize');
  state.listing += row(peers[1].address);
  assert.equal((await setup.poll(waiting.id)).stage, 'authorize'); assert.equal(wireless.records.length, 0);
  state.clock += 130000;
  assert.equal((await setup.poll(waiting.id)).stage, 'expired');
  const again = await setup.start({ address });
  setup.cancel(); await wireless.reset({});
  assert.equal((await setup.poll(again.id)).stage, 'expired');
  assert.ok(state.calls.some(a => a[0] === 'disconnect' && a[1] === address));
  assert.ok(state.listing.includes(peers[1].address));
  assert.equal(wireless.records.length, 0);
});

test('no mDNS or cached endpoints leads to phone setup; an unauthenticated TLS endpoint requests a code', async t => {
  const { wireless, state } = await fixture(t);
  const setup = new WirelessSetup(wireless, { findPeers: async () => [] });
  state.mdnsError = 'unknown command mdns';
  assert.deepEqual(await setup.start(), { stage: 'prepare', services: [] });
  state.mdnsError = ''; state.mdns = service(); state.connectError = 'failed to authenticate';
  await wireless.scan(true);
  assert.equal((await setup.start({ address })).stage, 'needCode');
  assert.ok(!state.calls.some(a => a[0] === 'pair'));
});

test('the phone URL and scope search prioritize an on-link gateway rather than the first VPN or VM', () => {
  assert.deepEqual(gatewayAdapters('darwin', 'default link#43 UCSg tun9\ndefault 172.20.10.1 UGScIg radio9\ndefault link#12 UCSIg bridge9'), ['radio9']);
  assert.deepEqual(gatewayAdapters('linux', 'wifi7 00000000 010A14AC 0003 0 0 25\nvm0 00000000 00000000 0001 0 0 0'), ['wifi7']);
  assert.deepEqual(gatewayAdapters('win32', '0.0.0.0 0.0.0.0 10.10.0.1 10.10.0.5 400\n0.0.0.0 0.0.0.0 172.20.10.1 172.20.10.8 15'), ['172.20.10.8', '10.10.0.5']);
});

test('a fresh scan finds a quiet glasses with an empty ARP table behind several virtual adapters and keeps verifying it', async () => {
  const adapters = [
    { name: 'virtual-a', address: '10.23.8.1', route: -1 },
    { name: 'actual-wifi', address: '172.20.10.8', route: 0 },
    { name: 'virtual-b', address: '10.25.8.1', route: -1 },
  ].map(e => ({ ...e, family: 'IPv4', netmask: '255.255.255.0' }));
  let activeHost = '172.20.10.210';
  const visited = [];
  const find = createLegacyFinder({ interfaces: async () => adapters, neighbors: async () => '', probe: async host => { visited.push(host); return host === activeHost; } });
  assert.deepEqual(await find(), []);
  assert.deepEqual((await find({ active: true })).map(x => x.host), [activeHost]);
  assert.ok(visited.every(host => host.startsWith('172.20.10.')));
  visited.length = 0;
  assert.deepEqual((await find()).map(x => x.host), [activeHost]); assert.deepEqual(visited, [activeHost]);
  activeHost = '10.60.1.9';
  adapters[1].address = '10.60.1.8';
  visited.length = 0;
  assert.deepEqual(await find(), []); assert.deepEqual(visited, []);
  assert.deepEqual((await find({ active: true })).map(x => x.host), [activeHost]);
});

test('scanning for a single endpoint is read-only until the caller requests its connection', async t => {
  const { wireless, state } = await fixture(t); state.mdns = '';
  const setup = new WirelessSetup(wireless, { findPeers: async () => [{ address, type: 'legacy', name: '', source: 'neighbor' }] });
  await setup.candidates(); assert.ok(!state.calls.some(args => args[0] === 'connect'));
  const found = await setup.start();
  assert.equal(found.stage, 'choose'); assert.equal(found.services.length, 1);
  assert.ok(!state.calls.some(args => args[0] === 'connect'));
  const result = await setup.start({ address: found.services[0].address });
  assert.equal(result.connected, true); assert.equal(result.address, address);
  assert.deepEqual(state.calls.filter(args => args[0] === 'connect').map(args => args[1]), [address]);
});

test('the signed helper shipped to phones stores its resource table for Android 11 and later', async () => {
  const bytes = await fs.readFile(new URL('../assets/wireless-helper/aiui-wireless-helper.apk', import.meta.url));
  let table;
  unzipSync(bytes, { filter(entry) {
    if (entry.name === 'resources.arsc') table = entry;
    return false;
  } });
  assert.ok(table?.originalSize > 0);
  assert.equal(table.compression, 0);
});

test('the bundled helper uses the system tile details without scrolling Settings away from D-pad focus', async () => {
  const apk = await fs.readFile(new URL('../assets/wireless-helper/aiui-wireless-helper.apk', import.meta.url));
  const { 'classes.dex': classes, 'AndroidManifest.xml': manifest } = unzipSync(apk, {
    filter: entry => entry.name === 'classes.dex' || entry.name === 'AndroidManifest.xml',
  });
  const dex = Buffer.from(classes);
  assert.ok(dex.includes('android.service.quicksettings.action.QS_TILE_PREFERENCES'));
  assert.ok(!dex.includes(':settings:fragment_args_key'));
  assert.ok(dex.includes('isSetupFlow'));
  for (const encoding of ['utf8', 'utf16le']) {
    assert.ok(!Buffer.from(manifest).includes(Buffer.from('android.permission.BIND_ACCESSIBILITY_SERVICE', encoding)));
  }
});

test('simultaneous phone download links are independent and serve the named release', async t => {
  const shares = new WirelessHelperShare({ interfaces: () => [{ address: '127.0.0.1' }], lifetime: 3000 });
  t.after(() => shares.stop());
  const [one, two] = await Promise.all([shares.start(), shares.start()]);
  assert.notEqual(one.urls[0], two.urls[0]);
  const url = two.urls[0];
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(shares.status(two.id).stage, 'waiting');
  assert.equal((await fetch(url + 'other.apk')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 404);
  const page = await fetch(url, { headers: { 'Accept-Language': 'en-US' } });
  const html = await page.text();
  assert.match(html, /Install Wireless Setup on your glasses/); assert.equal(shares.status(two.id).stage, 'opened');
  assert.match(two.downloadName, /^aiui-wireless-helper-\d+(?:\.\d+)+\.apk$/);
  assert.ok(html.includes('href="' + two.downloadName + '" download="' + two.downloadName + '"'));
  const apk = await fetch(url + two.downloadName);
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(apk.headers.get('content-disposition'), 'attachment; filename="' + two.downloadName + '"');
  assert.deepEqual(Buffer.from(await apk.arrayBuffer()), await fs.readFile(two.file));
  assert.equal(shares.status(two.id).stage, 'sent');
  assert.equal((await fetch(url + 'aiui-wireless-helper.apk', { method: 'HEAD' })).status, 200);
  shares.stop(one.id); assert.equal(shares.status(one.id).stage, 'expired'); assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  shares.stop(two.id); assert.equal(shares.status(two.id).stage, 'expired');
});

async function pairingResult(qr,id) {
  for(let attempt=0;attempt<100;attempt++){
    const status=await qr.status(id);
    if(status.stage!=='pairing')return status;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('Pairing did not finish');
}

test('QR pairing ignores other sessions, pairs the exact advertised name once and verifies online without storing its secret', async t => {
  const { wireless, state, home } = await fixture(t);
  const qr = new WirelessPairQr(wireless, { now: () => state.clock });
  t.after(() => qr.cancel());
  const first = qr.start(), second = qr.start();
  const session = qr.sessions.get(first.id), password = session.password;
  assert.match(first.qrDataUrl, /^data:image\/gif;base64,/);
  assert.notEqual(first.qrDataUrl, second.qrDataUrl);
  state.mdns += service('pairing', 37123, 'studio-other-session');
  assert.equal((await qr.status(first.id)).stage, 'waiting');
  assert.equal(state.calls.filter(args => args[0] === 'pair').length, 0);
  state.mdns += service('pairing', 38123, session.name);
  const [a, b] = await Promise.all([qr.status(first.id), qr.status(first.id)]);
  assert.equal(a.stage, 'pairing'); assert.equal(b.stage, 'pairing');
  const final=await pairingResult(qr,first.id);
  assert.equal(final.connected,true);assert.equal(final.address, address);
  assert.equal(state.calls.filter(args => args[0] === 'pair').length, 1);
  assert.deepEqual(state.calls.find(args => args[0] === 'pair'), ['pair', ip + ':38123']);
  assert.equal(state.pairInput, password + '\n');
  assert.equal(session.password, ''); assert.equal(a.qrDataUrl, undefined);
  assert.ok(!JSON.stringify(a).includes(password));
  assert.ok(!(await fs.readFile(path.join(home, 'wireless-devices.json'), 'utf8')).includes(password));
  assert.equal((await qr.status(second.id)).stage, 'waiting');
});

test('QR cancellation, expiry and ambiguous advertisements cannot authorize another endpoint', async t => {
  const { wireless, state } = await fixture(t);
  const qr = new WirelessPairQr(wireless, { now: () => state.clock, lifetime: 5000 });
  t.after(() => qr.cancel());
  const first = qr.start(), second = qr.start();
  const session = qr.sessions.get(first.id);
  state.mdns = service('pairing', 37123, session.name) + service('pairing', 38123, session.name);
  assert.equal((await qr.status(first.id)).stage, 'waiting');
  qr.cancel(first.id); assert.equal(session.password, '');
  assert.equal((await qr.status(first.id)).stage, 'expired');
  assert.equal((await qr.status()).stage, 'expired');
  assert.equal(qr.sessions.has(second.id), true);
  state.clock += 6000;
  assert.equal((await qr.status(second.id)).stage, 'expired');
  assert.equal(qr.sessions.size, 0);
  assert.equal(state.calls.filter(args => args[0] === 'pair').length, 0);
});

test('a cancelled QR discovery cannot start pairing when a delayed scan finishes', async t => {
  const { wireless, state } = await fixture(t);
  const qr = new WirelessPairQr(wireless);
  t.after(() => qr.cancel());
  const first = qr.start(), session = qr.sessions.get(first.id);
  let release;
  wireless.scan = async () => { await new Promise(resolve => { release = resolve; }); wireless.services = parseMdns(service('pairing', 37123, session.name)); };
  const waiting = qr.status(first.id);
  qr.cancel(first.id); release();
  assert.equal((await waiting).stage, 'expired');
  assert.equal(state.calls.filter(args => args[0] === 'pair').length, 0);
});

test('QR pairing distinguishes pending transport, terminal failures and discovery limitations', async t => {
  const { wireless, state } = await fixture(t);
  const qr = new WirelessPairQr(wireless);
  t.after(() => qr.cancel());
  let first = qr.start(), session = qr.sessions.get(first.id);
  state.mdns = service('pairing', 37123, session.name);
  let result = await pairingResult(qr,first.id);
  assert.equal(result.stage, 'paired'); assert.equal(result.paired, true); assert.equal(result.connected, false);
  assert.equal(result.nextStep, 'connect'); assert.equal(result.qrDataUrl, undefined);
  first = qr.start(); session = qr.sessions.get(first.id);
  state.mdns = service('pairing', 37123, session.name); state.pairError = 'error: wrong code ' + session.password;
  result = await pairingResult(qr,first.id);
  assert.equal(result.stage, 'failed'); assert.equal(session.password, ''); assert.equal(result.qrDataUrl, undefined);
  first = qr.start(); state.mdnsError = 'mdns unavailable';
  result = await qr.status(first.id);
  assert.equal(result.stage, 'waiting'); assert.match(result.message, /六位/);
});

test('phone download language follows Workshop rather than the phone and can switch while the code stays open', async t => {
  const shares = new WirelessHelperShare({ interfaces: () => [{ address: '127.0.0.1' }] });
  t.after(() => shares.stop());
  const share = await shares.start({ locale: 'zh-CN' });
  let html = await (await fetch(share.urls[0], { headers: { 'Accept-Language': 'en-US' } })).text();
  assert.match(html, /lang="zh-CN"/); assert.match(html, /遥控器/);
  shares.status(share.id, 'en');
  html = await (await fetch(share.urls[0], { headers: { 'Accept-Language': 'zh-CN' } })).text();
  assert.match(html, /lang="en"/); assert.doesNotMatch(html, /[\u3400-\u9fff]/);
  assert.match(html, /Install new app/); assert.match(html, /Remote control/);
  assert.match(html, /Back on your computer/);
});

test('AI connection guidance reports current transport, localizes every step and can return a phone download image', async t => {
  const shares = new WirelessHelperShare({ interfaces: () => [{ address: '127.0.0.1' }] });
  t.after(() => shares.stop());
  let devices = [];
  const workbench = { environmentCheck: async () => ({ devices }), wirelessHelper: shares };
  for (const step of ['overview', 'install', 'pair', 'ready']) {
    const guide = await connectionGuide(workbench, { step, locale: 'en', includeImages: false });
    assert.equal(guide.connected, false); assert.equal(guide.nextAction.owner, 'user');
    assert.doesNotMatch(JSON.stringify(guide), /[\u3400-\u9fff]/);
    assert.ok(guide.steps.length >= 3);
  }
  const guide = await connectionGuide(workbench, { step: 'install', locale: 'en', shareHelper: true, includeImages: false });
  assert.match(guide.helper.urls[0], /^http:/);
  assert.equal(guide.images[0].mimeType, 'image/gif');
  const html = await (await fetch(guide.helper.urls[0], { headers: { 'Accept-Language': 'zh-CN' } })).text();
  assert.match(html, /lang="en"/);
  devices = [{ serial: address, status: 'device', connection: 'wireless' }];
  assert.equal((await connectionGuide(workbench)).connected, true);
});

test('connection guidance keeps wired and wireless transport status separate, including deduplicated USB devices', async () => {
  const wireless = { serial: address, status: 'device', connection: 'wireless' };
  const usb = { serial: 'USB123', status: 'unauthorized', connection: 'usb' };
  const workbench = { environmentCheck: async () => ({ devices: [wireless], usbDevices: [usb] }) };
  const wifi = await connectionGuide(workbench, { method: 'wireless', includeImages: false });
  const wired = await connectionGuide(workbench, { method: 'usb', locale: 'en', includeImages: false });
  assert.equal(wifi.connected, true); assert.equal(wired.connected, false);
  assert.deepEqual(wired.devices.map(d => d.serial), ['USB123']);
  assert.deepEqual(wired.availableMethods, ['wireless', 'usb']);
  assert.doesNotMatch(JSON.stringify(wired), /[\u3400-\u9fff]/);
  usb.status = 'device';
  assert.equal((await connectionGuide(workbench, { method: 'usb', includeImages: false })).connected, true);
});

test('QR discovery uses the exact Bonjour instance when ADB misses the pairing advertisement', async t => {
  const { wireless, state } = await fixture(t);
  let requested;
  const qr = new WirelessPairQr(wireless, {resolveService: async name => { requested=name; return ip+':38200'; }});
  t.after(()=>qr.cancel());
  const session=qr.start();
  assert.equal((await qr.status(session.id)).stage,'pairing');
  assert.equal(requested,qr.sessions.get(session.id).name);
  assert.equal((await pairingResult(qr,session.id)).connected,true);
  assert.deepEqual(state.calls.filter(args=>args[0]==='pair'),[['pair',ip+':38200']]);
});
