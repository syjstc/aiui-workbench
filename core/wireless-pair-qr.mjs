import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import qrcode from 'qrcode-generator';

// Android's Wireless debugging scanner advertises the exact service name from
// WIFI:T:ADB. Only that service may consume this session's temporary secret.
export class WirelessPairQr {
  constructor(wireless, { now = Date.now, lifetime = 120000, resolveService } = {}) {
    Object.assign(this, { wireless, now, lifetime, resolveService });
    this.sessions = new Map();
  }
  start() {
    if (this.sessions.size >= 6) this.cancel(this.sessions.keys().next().value);
    const id = randomUUID(), name = 'studio-' + randomBytes(5).toString('hex');
    const password = String(randomInt(10_000_000_000)).padStart(10, '0');
    const qr = qrcode(0, 'M');
    qr.addData(`WIFI:T:ADB;S:${name};P:${password};;`); qr.make();
    const session = { id, name, password, controller: new AbortController(), expiresAt: this.now() + this.lifetime, stage: 'waiting', qrDataUrl: qr.createDataURL(10, 40) };
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
      clearTimeout(session.timer); session.controller.abort(); session.password = ''; session.qrDataUrl = ''; this.sessions.delete(session.id);
    }
    return { stage: 'cancelled' };
  }
  async status(id) {
    const session = this.sessions.get(id);
    if (!session) return { stage: 'expired' };
    if (session.stage === 'waiting' && this.now() >= session.expiresAt) { this.cancel(id); return { stage: 'expired' }; }
    if (!session.operation && session.stage === 'waiting') {
      session.operation = this.check(session).finally(() => { session.operation = null; });
    }
    if (session.stage === 'waiting') await session.operation;
    if (!this.sessions.has(id)) return { stage: 'expired' };
    return this.public(session);
  }
  async check(session) {
    const wireless = this.wireless;
    if (wireless.busy || wireless.resetting) return;
    await wireless.scan(true);
    if (!this.sessions.has(session.id) || this.now() >= session.expiresAt) return;
    const matches = wireless.services.filter(s => s.type === 'pairing' && s.name === session.name);
    const endpoints = new Set(matches.map(s => s.address));
    if (endpoints.size > 1) return;
    const address = endpoints.size ? [...endpoints][0] : await this.resolveService?.(session.name, session.controller.signal);
    if (!this.sessions.has(session.id) || this.now() >= session.expiresAt) return;
    if (!address) {
      session.result = wireless.mdns.available === false
        ? { message: '当前网络无法发现扫码配对，请改用六位配对码。' }
        : this.now() >= session.expiresAt - this.lifetime + 12000
          ? { message: '电脑尚未收到这张码的配对广播。请让眼镜与电脑连到同一 Wi-Fi，靠近屏幕重新对准，或切换六位码。' } : {};
      return;
    }
    if (wireless.busy || wireless.resetting) return;
    session.stage = 'pairing';
    delete session.result;
    // Give an in-progress handshake its own deadline in adb. The QR timeout
    // applies to discovering the scan, including the last second of validity.
    clearTimeout(session.timer);
    this.pair(session, address).finally(() => {
      if (this.sessions.has(session.id)) {
        session.timer = setTimeout(() => this.cancel(session.id), this.lifetime);
        session.timer.unref();
      }
    });
  }
  async pair(session, address) {
    const wireless = this.wireless;
    try {
      session.result = await wireless.connect({ address }, () => {
        if (session.controller.signal.aborted) throw new Error('二维码已取消');
        return wireless.adb.pairQr(address, session.password, session.controller.signal);
      });
      session.stage = session.result.connected ? 'connected' : 'paired';
    } catch {
      session.stage = 'failed';
      session.result = { connected: false, message: '二维码配对未完成，请重新生成后再扫描，或改用六位配对码。' };
    }
    session.password = ''; session.qrDataUrl = '';
  }
}
