import { run } from './util.mjs';

export function parseDevices(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|unauthorized|offline)\b(.*)$/);
    if (!match) return [];
    const [, serial, status, details] = match;
    return [{ serial, status, name: details.match(/\bmodel:(\S+)/)?.[1].replaceAll('_', ' ') || 'USB 设备', transport: details.match(/\btransport_id:(\S+)/)?.[1] || '', description: line }];
  });
}

export function parseInspection(output) {
  return {
    developerMode: output.match(/^\s*Developer Mode:\s*(enabled|disabled|unknown)\s*$/m)?.[1] || 'unknown',
    runtimeReady: /^\s*Widget Runtime:\s*ready\s*$/m.test(output),
    output,
  };
}

// Poll USB every time, but avoid launching the CLI for every UI refresh.
// Cache only while a device stays connected with the same transport identity.
export class DeviceDiscovery {
  constructor(cli, execute = run, now = Date.now) {
    this.cli = cli;
    this.execute = execute;
    this.now = now;
    this.inspections = new Map();
  }

  check() {
    if (!this.pending) this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }

  async read() {
    const failed = error => ({ code: -1, output: error.message });
    const tools = async () => {
      if (!this.tools || this.now() >= this.tools.expires) {
        const result = await this.cli(['--help'], { timeout: 12000 }).catch(failed);
        this.tools = { result, expires: this.now() + (result.code === 0 ? 60000 : 3000) };
      }
      return this.tools.result;
    };
    const [adb, cli] = await Promise.all([
      this.execute('adb', ['devices', '-l'], { timeout: 10000 }).catch(failed),
      tools(),
    ]);
    const devices = adb.code === 0 ? parseDevices(adb.output) : [];
    for (const [serial, cached] of this.inspections) {
      if (!devices.some(d => d.serial === serial && d.status === 'device' && d.transport === cached.transport)) this.inspections.delete(serial);
    }
    await Promise.all(devices.map(async device => {
      if (device.status !== 'device' || cli.code !== 0) return;
      let cached = this.inspections.get(device.serial);
      if (!cached || this.now() >= cached.expires) {
        const result = await this.cli(['device', '--serial', device.serial], { timeout: 12000 }).catch(failed);
        const inspection = { ...parseInspection(result.output), checkedAt: new Date(this.now()).toISOString(), error: result.code !== 0 };
        const ready = !inspection.error && inspection.developerMode === 'enabled' && inspection.runtimeReady;
        cached = { transport: device.transport, inspection, expires: this.now() + (ready ? 15000 : 3000) };
        this.inspections.set(device.serial, cached);
      }
      device.inspection = cached.inspection;
    }));
    return {
      node: process.version, runtime: '0.19.0', webSdkVersion: '0.19.1',
      aix: cli.code === 0, adb: adb.code === 0, devices,
      checkedAt: new Date(this.now()).toISOString(),
      diagnostics: { adb: adb.code ? adb.output : '', aix: cli.code ? cli.output : '' },
      message: devices.length ? '眼镜连接状态已自动更新' : '请用数据线连接眼镜，连接后会自动识别。',
    };
  }
}
