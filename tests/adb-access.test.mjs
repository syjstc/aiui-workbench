import test from 'node:test';
import assert from 'node:assert/strict';
import { ADB_ACCESS_MARKER, ROKID_ADB_STEP, adbAccessDiagnostic, connectionAdbDiagnostic, probeAdbAccess, withAdbRecovery, parseRokidAdbGate } from '../core/adb-access.mjs';
import { DeviceDiscovery } from '../core/devices.mjs';
import { deviceBlocker } from '../core/development-flow.mjs';
import { connectionGuide } from '../core/connection-guide.mjs';

const device = { serial: 'test-glasses', connection: 'usb', status: 'device' };
const runtimeReady = 'Developer Mode: enabled\nWidget Runtime: ready';
const rokidProperties = enabled => '[ro.product.brand]: [Rokid]\n[ro.product.model]: [RG-glasses]\n[ro.build.version.incremental]: [1.29.013-20261110-150201]\n[persist.vendor.adb]: [' + enabled + ']\n';

test('Rokid vendor operation gate is independent of transport, Android ADB and AIUI developer mode', async () => {
  assert.equal(parseRokidAdbGate(rokidProperties('false')).state, 'disabled');
  assert.equal(parseRokidAdbGate(rokidProperties('true')).state, 'enabled');
  assert.equal(parseRokidAdbGate('[persist.vendor.adb]: [false]').state, 'unknown');
  assert.equal(parseRokidAdbGate(rokidProperties('')).state, 'unknown');
  assert.equal(parseRokidAdbGate('[ro.product.brand]: [Other]\n[persist.vendor.adb]: [false]').state, 'unknown');
  let enabled = true, inspections = 0;
  const discovery = new DeviceDiscovery(async args => {
    if (args[0] !== '--help') inspections++;
    return { code: 0, output: runtimeReady };
  }, async (_command, args) => ({ code: 0, output: args[0] === 'devices' ? 'test-glasses device transport_id:1' : args.at(-1) === 'getprop' ? rokidProperties(String(enabled)) : ADB_ACCESS_MARKER }));
  let d = (await discovery.check()).devices[0];
  assert.equal(d.adbAccess.phoneAdbSwitch, 'on');
  assert.equal(d.inspection.developerMode, 'enabled');
  enabled = false;
  d = (await discovery.check()).devices[0];
  assert.equal(d.status, 'device');
  assert.equal(d.adbAccess.state, 'rokid-adb-disabled');
  assert.equal(d.adbAccess.phoneAdbSwitch, 'off');
  assert.equal(d.adbAccess.rokidAppAdb.property, 'persist.vendor.adb');
  assert.equal(d.inspection, undefined);
  assert.equal(inspections, 1);
  const blocker = deviceBlocker({ adb: true, aix: true, devices: [d] });
  assert.equal(blocker.code, 'rokid-adb-disabled');
  assert.ok(blocker.steps.includes(ROKID_ADB_STEP));
  assert.match(blocker.steps.join(' '), /独立操作开关/);
  enabled = true;
  d = (await discovery.check()).devices[0];
  assert.equal(d.adbAccess.phoneAdbSwitch, 'on');
  assert.equal(d.adbAccess.state, 'available');
  assert.equal(d.inspection.runtimeReady, true);
  assert.equal(inspections, 2);
});

test('missing glasses provide phone switch steps without claiming the switch is off', () => {
  const diagnostic = connectionAdbDiagnostic({ adb: true, devices: [] });
  assert.equal(diagnostic.state, 'missing');
  assert.equal(diagnostic.phoneAdbSwitch, 'unknown');
  assert.match(diagnostic.message, /可能.*眼镜 ADB 调试/);
  assert.ok(diagnostic.recovery.steps.includes(ROKID_ADB_STEP));
  assert.equal(diagnostic.recovery.owner, 'user');
  assert.deepEqual(diagnostic.recovery.recheck, { tool: 'aiui_environment_check', arguments: {} });
  const blocker = deviceBlocker({ adb: true, aix: true, devices: [] });
  assert.equal(blocker.code, 'no-device');
  assert.ok(blocker.steps.includes(ROKID_ADB_STEP));
  assert.equal(connectionAdbDiagnostic({ adb: false, devices: [] }).state, 'tool-unavailable');
});

test('an online ADB listing alone cannot pass the basic command probe, even with exit code zero', async () => {
  for (const [code, output, state] of [
    [0, ADB_ACCESS_MARKER, 'available'],
    [0, 'Permission denied', 'restricted'],
    [1, 'error: closed', 'unavailable'],
    [0, '', 'unavailable'],
    [1, 'error: device unauthorized', 'unauthorized'],
    [1, 'error: device offline', 'offline'],
    [1, "adb: device 'test-glasses' not found", 'missing'],
    [1, 'cannot connect to daemon at tcp:5037: Connection refused', 'tool-unavailable'],
  ]) {
    const diagnostic = await probeAdbAccess(async (_command, args) => {
      if (args.at(-1) === 'getprop') return { code: 0, output: '' };
      assert.deepEqual(args, ['-s', device.serial, 'shell', 'printf', ADB_ACCESS_MARKER]);
      return { code, output };
    }, device);
    assert.equal(diagnostic.state, state);
    assert.equal(diagnostic.phoneAdbSwitch, 'unknown');
  }
  const timedOut = await probeAdbAccess(async () => { throw new Error('timeout'); }, device);
  assert.equal(timedOut.state, 'unavailable');
});

test('fresh access failures invalidate cached runtime readiness and recover on the next check', async () => {
  let access = ADB_ACCESS_MARKER, inspections = 0;
  const discovery = new DeviceDiscovery(async args => {
    if (args[0] === '--help') return { code: 0, output: 'help' };
    inspections++;
    return { code: 0, output: runtimeReady };
  }, async (_command, args) => ({ code: 0, output: args[0] === 'devices' ? 'test-glasses device transport_id:1' : access }));
  assert.equal((await discovery.check()).devices[0].inspection.runtimeReady, true);
  access = 'Permission denied';
  const blocked = (await discovery.check()).devices[0];
  assert.equal(blocked.status, 'device');
  assert.equal(blocked.adbAccess.state, 'restricted');
  assert.equal(blocked.inspection, undefined);
  assert.equal(inspections, 1);
  assert.equal(deviceBlocker({ adb: true, aix: true, devices: [blocked] }).code, 'adb-restricted');
  access = ADB_ACCESS_MARKER;
  const recovered = (await discovery.check()).devices[0];
  assert.equal(recovered.adbAccess.state, 'available');
  assert.equal(recovered.adbAccess.recovery, undefined);
  assert.equal(recovered.inspection.runtimeReady, true);
  assert.equal(inspections, 2);
});

test('authorization and offline states do not issue device commands and preserve transport-specific guidance', async () => {
  for (const status of ['unauthorized', 'offline']) {
    const discovery = new DeviceDiscovery(async () => ({ code: 0, output: 'help' }), async (_command, args) => {
      assert.equal(args[0], 'devices');
      return { code: 0, output: '192.168.1.10:5555 ' + status };
    });
    const d = (await discovery.check()).devices[0];
    assert.equal(d.adbAccess.state, status);
    assert.ok(d.adbAccess.recovery.steps.includes(ROKID_ADB_STEP));
    if (status === 'unauthorized') {
      assert.match(d.adbAccess.message, /无线/);
      assert.doesNotMatch(d.adbAccess.message, /USB/);
    }
  }
});

test('device rejection preserves evidence and separates Android permissions from phone switch state', () => {
  const error = withAdbRecovery(new Error('remote permission denied token=private-value'), { serial: device.serial });
  assert.equal(error.deviceDiagnostic.state, 'restricted');
  assert.equal(error.deviceDiagnostic.phoneAdbSwitch, 'unknown');
  assert.match(error.recovery.steps.join(' '), /Android 权限/);
  assert.ok(!error.deviceDiagnostic.evidence.includes('private-value'));
  assert.equal(withAdbRecovery(error), error);
  assert.equal(error.message.split(ROKID_ADB_STEP).length, 2);
  for (const other of [new Error('application syntax error'), new Error('Device Developer Mode is disabled'), Object.assign(new Error('EACCES: permission denied, open local.apk'), { code: 'EACCES' })]) {
    assert.equal(withAdbRecovery(other, { serial: device.serial }).deviceDiagnostic, undefined);
  }
});

test('connection guidance reports rejected commands and localizes recovery while keeping selected transports separate', async () => {
  const restricted = { ...device, adbAccess: adbAccessDiagnostic('restricted', device) };
  const wireless = { serial: '192.168.1.10:5555', connection: 'wireless', status: 'device', adbAccess: adbAccessDiagnostic('available') };
  const workbench = { environmentCheck: async () => ({ adb: true, devices: [wireless], usbDevices: [restricted] }) };
  const wired = await connectionGuide(workbench, { method: 'usb', locale: 'en', includeImages: false });
  assert.equal(wired.connected, true);
  assert.equal(wired.adbUsable, false);
  assert.equal(wired.diagnostic.state, 'restricted');
  assert.equal(wired.nextAction.owner, 'user');
  assert.match(wired.nextAction.steps.join(' '), /Glasses ADB debugging/);
  assert.doesNotMatch(JSON.stringify(wired), /[\u3400-\u9fff]/);
  const wifi = await connectionGuide(workbench, { method: 'wireless', includeImages: false });
  assert.equal(wifi.adbUsable, true);
  assert.equal(wifi.nextAction.owner, 'ai');
});
