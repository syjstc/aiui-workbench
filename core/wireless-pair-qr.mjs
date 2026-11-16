import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import qrcode from 'qrcode-generator';

// Android's Wireless debugging scanner advertises the exact service name from
// WIFI:T:ADB. Only that service may consume this session's temporary secret.
export class WirelessPairQr {
  constructor(wireless, { now = Date.now, lifetime = 120000 } = {}) {
    Object.assign(this, { wireless, now, lifetime });
    this.sessions = new Map();
  }
  start() {
    if (this.sessions.size >= 6) this.cancel(this.sessions.keys().next().value);
    const id = randomUUID(), name = 'studio-' + randomBytes(5).toString('hex');
    const password = String(randomInt(10_000_000_000)).padStart(10, '0');
    const qr = qrcode(0, 'M');
    qr.addData(`WIFI:T:ADB;S:${name};P:${password};;`); qr.make();
    const session = { id, name, password, expiresAt: this.now() + this.lifetime, stage: 'waiting', qrDataUrl: qr.createDataURL(6, 24) };
    session.timer = setTimeout(() => this.cancel(id), this.lifetime); session.timer.unref();
    this.sessions.set(id, session);
    return this.public(session);
  }
  public(session) {
    return { id: session.id, stage: session.stage, expiresAt: session.expiresAt, ...(session.stage === 'waiting' ? { qrDataUrl: session.qrDataUrl } : {}), ...session.result };
  }
  cancel(id) {
    for (const session of id ? [this.sessions.get(id)] : this.sessions.values()) {
      if (!session) continue;
      clearTimeout(session.timer); session.password = ''; session.qrDataUrl = ''; this.sessions.delete(session.id);
    }
    return { stage: 'cancelled' };
  }
  async status(id) {
    const session = this.sessions.get(id);
    if (!session) return { stage: 'expired' };
    if (this.now() >= session.expiresAt) { this.cancel(id); return { stage: 'expired' }; }
    if (!session.operation && session.stage === 'waiting') {
      session.operation = this.check(session).finally(() => { session.operation = null; });
    }
    await session.operation;
    if (!this.sessions.has(id)) return { stage: 'expired' };
    return this.public(session);
  }
  async check(session) {
    const wireless = this.wireless;
    if (wireless.busy || wireless.resetting) return;
    await wireless.scan(true);
    if (!this.sessions.has(session.id) || this.now() >= session.expiresAt) return;
    if (wireless.mdns.available === false) {
      session.result = { message: '当前网络无法发现扫码配对，请改用六位配对码。' }; return;
    }
    const matches = wireless.services.filter(s => s.type === 'pairing' && s.name === session.name);
    const endpoints = new Map(matches.map(s => [s.address, s]));
    if (endpoints.size !== 1 || wireless.busy || wireless.resetting) return;
    const service = [...endpoints.values()][0];
    try {
      session.result = await wireless.connect({ address: service.address }, () => {
        if (!this.sessions.has(session.id) || this.now() >= session.expiresAt) throw new Error('二维码已过期');
        return wireless.adb.pairQr(service.address, session.password);
      });
      session.stage = session.result.connected ? 'connected' : 'paired';
    } catch {
      session.stage = 'failed';
      session.result = { connected: false, message: '二维码配对未完成，请重新生成后再扫描，或改用六位配对码。' };
    }
    session.password = ''; session.qrDataUrl = '';
  }
}
