import { poseQuaternion, rotateHeadVector } from '../shared/pose.mjs';

const channels = [
  ['orientation', 'absoluteOrientation', 60],
  ['accel', 'accelerometer', 50],
  ['gyro', 'gyroscope', 25],
  ['magnetometer', 'magnetometer', 10],
];
const axes = ['x', 'y', 'z', 'w'];

export class SimulatorImu {
  constructor(emit, changed) {
    this.emit = emit;
    this.changed = changed;
    this.sessions = new Map(channels.map(([name]) => [name, new Map()]));
    this.readings = Object.fromEntries(channels.map(([name]) => [name, 0]));
    this.overrides = {};
    this.values = {};
    this.replay = null;
  }

  capabilities() {
    return Object.fromEntries(channels.map(([name, capability, defaultHz]) => {
      const sessions = this.sessions.get(name);
      return [capability, {
        start: request => {
          const frequency = Number.isFinite(request.frequency) && request.frequency > 0 ? request.frequency : defaultHz;
          const session = { request, interval: 1000 / Math.min(frequency, 60), nextAt: null, active: false };
          sessions.set(request.targetId, session);
          console.info(`SDK ${capability}.start`, JSON.stringify(request));
          setTimeout(() => {
            if (sessions.get(request.targetId) !== session) return;
            this.emit(`${capability}.activate`, request);
            session.active = true;
          }, 0);
        },
        stop: ({ targetId, sessionId }) => {
          if (sessions.get(targetId)?.request.sessionId === sessionId) sessions.delete(targetId);
          console.info(`SDK ${capability}.stop`, targetId);
        },
      }];
    }));
  }

  set(values) {
    this.stopReplay();
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete this.overrides[name];
      else this.overrides[name] = value;
    }
  }

  startReplay(frames, now) {
    this.replay = { frames, start: now, sent: 0, total: frames.length, durationMs: frames.at(-1).atMs, status: 'playing' };
  }

  stopReplay() {
    if (this.replay?.status === 'playing') this.finishReplay('stopped');
  }

  finishReplay(status) {
    this.replay.status = status;
    this.replay.frames = null;
    this.changed();
  }

  reset() {
    for (const sessions of this.sessions.values()) sessions.clear();
    this.replay = null;
    this.values = {};
  }

  get driving() {
    return this.replay?.status === 'playing' || Object.keys(this.overrides).length > 0;
  }

  state() {
    const { status, durationMs, sent, total } = this.replay || {};
    return {
      values: { ...this.values }, overrides: { ...this.overrides }, readings: { ...this.readings },
      subscriptions: Object.fromEntries(channels.map(([name]) => [name, this.sessions.get(name).size])),
      replay: status ? { status, durationMs, sent, total } : null,
    };
  }

  tick(pose, now) {
    if (this.replay?.status === 'playing') {
      const replay = this.replay;
      while (replay.sent < replay.total && replay.start + replay.frames[replay.sent].atMs <= now) {
        const { atMs, ...values } = replay.frames[replay.sent++];
        this.sample(values, replay.start + atMs, true, true);
      }
      if (replay.sent === replay.total) this.finishReplay('finished');
      return;
    }

    const orientation = this.overrides.orientation || poseQuaternion(pose);
    const norm = Math.hypot(...orientation);
    const inverse = orientation.map((value, index) => (index === 3 ? value : -value) / norm);
    this.sample({
      orientation, accel: rotateHeadVector([0, 0, 9.81], inverse),
      gyro: [0, 0, 0], magnetometer: rotateHeadVector([0, 25, -40], inverse),
      ...this.overrides,
    }, now, pose.connected, false);
  }

  sample(values, timestamp, orientationEnabled, replaying) {
    Object.assign(this.values, values);
    for (const [name, capability] of channels) {
      const value = values[name];
      if (!value || (name === 'orientation' && orientationEnabled === false)) continue;
      const sessions = this.sessions.get(name);
      for (const session of sessions.values()) {
        if (!session.active || (!replaying && session.nextAt > timestamp)) continue;
        if (!replaying) {
          const due = session.nextAt ?? timestamp;
          session.nextAt = due + (Math.floor((timestamp - due) / session.interval) + 1) * session.interval;
        }
        const vector = Object.fromEntries(value.map((component, index) => [axes[index], component]));
        this.emit(`${capability}.reading`, { ...session.request, ...vector, timestamp });
        this.readings[name]++;
      }
    }
  }
}
