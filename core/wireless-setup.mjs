import { randomUUID } from 'node:crypto';
import { adbAddress } from './adb.mjs';
import { findLegacyPeers } from './adb-neighbors.mjs';

// Connection attempts live only while the user is setting up a device. An
// untrusted legacy transport can remain "unauthorized" until the user accepts
// the system prompt on the glasses, even after adb connect has already returned.
export class WirelessSetup {
  constructor(wireless, { findPeers = findLegacyPeers, now = Date.now } = {}) {
    Object.assign(this, { wireless, findPeers, now });
    this.sessions = new Map();
    this.generation = 0;
  }

  async candidates(active = false) {
    const [devices] = await Promise.all([this.wireless.list(), this.wireless.scan(active)]);
    const advertised = this.wireless.services.filter(s => !(s.type === 'pairing' && s.name.startsWith('studio-')));
    if (devices.some(d => d.connection === 'wireless' && d.status === 'device')) return { services: advertised };
    const peers = await this.findPeers({ active: active && !advertised.length });
    return { services: [...advertised, ...peers.filter(p => !advertised.some(s => s.address === p.address))] };
  }

  cancel(id) {
    if (!id) this.generation++;
    const sessions = id ? [this.sessions.get(id)] : this.sessions.values();
    for (const session of sessions) {
      if (!session) continue;
      clearTimeout(session.timer); this.sessions.delete(session.id);
    }
    return { stage: 'cancelled' };
  }

  async start({ address } = {}) {
    if (!address) {
      const generation = this.generation;
      const { services } = await this.candidates(true);
      if (generation !== this.generation) return { stage: 'cancelled' };
      return { stage: services.length ? 'choose' : 'prepare', services };
    }
    const generation = this.generation;
    address = adbAddress(address).address;
    try { return { stage: 'connected', ...await this.wireless.connect({ address }) }; }
    catch (error) {
      const service = this.wireless.services.find(s => s.address === address);
      const target = { address, serviceName: service?.serviceName };
      const device = this.wireless.deviceFor(target, await this.wireless.list());
      if (generation !== this.generation) return { stage: 'cancelled' };
      if (!/未授权|允许调试/.test(error.message) && device?.status !== 'unauthorized') throw error;
      if (service?.type === 'connect') return { stage: 'needCode' };
      const id = randomUUID();
      if (this.sessions.size >= 12) this.cancel(this.sessions.keys().next().value);
      const session = { ...target, id, retryAt: this.now() + 4000, expiresAt: this.now() + 120000 };
      session.timer = setTimeout(() => this.cancel(id), 120000);
      session.timer.unref(); this.sessions.set(id, session);
      return { stage: 'authorize', id, address };
    }
  }

  async poll(id) {
    const session = this.sessions.get(id);
    if (!session || this.now() >= session.expiresAt) { if (session) this.cancel(id); return { stage: 'expired' }; }
    if (!session.operation) session.operation = this.checkAuthorization(session).finally(() => { session.operation = null; });
    return session.operation;
  }

  async checkAuthorization(session) {
    const { id, address } = session;
    const device = this.wireless.deviceFor(session, await this.wireless.list());
    if (!this.sessions.has(id)) return { stage: 'cancelled' };
    if (!this.wireless.busy && !this.wireless.resetting) {
      if (device?.status === 'device') {
        const service = this.wireless.services.find(s => s.address === address);
        const result = await this.wireless.exclusive(() => this.wireless.confirmOnline(address, service));
        this.cancel(id);
        return { stage: 'connected', ...result };
      }
      if (!device && !session.retried && this.now() >= session.retryAt) {
        session.retried = true;
        try {
          const result = await this.wireless.connect({ address });
          this.cancel(id); return { stage: 'connected', ...result };
        } catch (error) {
          if (!/未授权|允许调试/.test(error.message)) { this.cancel(id); throw error; }
        }
      }
    }
    return { stage: 'authorize', id, address };
  }
}
