// AIUI promises key codes, but not a physical swipe id or touch-end event.
// Treat a same-direction burst as one navigation action. Refresh the quiet
// window on *every* event, including ignored repeats, so a long swipe cannot
// begin advancing again just because a fixed cooldown expired.
export function navigationDirection(code) {
  if (code === 'ArrowDown' || code === 'ArrowRight') return 1;
  if (code === 'ArrowUp' || code === 'ArrowLeft') return -1;
  return 0;
}

export class TempleNavigation {
  constructor({ now = () => Date.now(), quietMs = 360 } = {}) {
    this.now = now;
    this.quietMs = quietMs;
    this.reset();
  }

  reset() {
    this.held = null;
    this.lastDirection = 0;
    this.lastEventAt = -Infinity;
  }

  excludeBlockedTime(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    // No input callback can run during synchronous rendering. Its wall time
    // therefore cannot prove that the user's swipe ended: the remaining keys
    // may simply be queued behind a costly native Canvas flush. Keep the quiet
    // window at 360 ms of responsive time instead of increasing the threshold.
    if (Number.isFinite(this.lastEventAt)) this.lastEventAt += durationMs;
  }

  keyDown(event) {
    const direction = navigationDirection(event.code);
    if (!direction) return;
    const time = this.now();
    if (this.held?.direction !== direction) {
      this.held = { direction, eligible: event.repeat !== true &&
        (direction !== this.lastDirection || time - this.lastEventAt >= this.quietMs) };
    }
    // A held key acts on release once, regardless of the number of keydowns.
    this.lastDirection = direction;
    this.lastEventAt = time;
  }

  keyUp(event) {
    const direction = navigationDirection(event.code);
    if (!direction) return 0;
    const time = this.now();
    const eligible = event.repeat !== true && (this.held?.direction === direction
      ? this.held.eligible
      : direction !== this.lastDirection || time - this.lastEventAt >= this.quietMs);
    if (event.repeat !== true) this.held = null;
    this.lastDirection = direction;
    this.lastEventAt = time;
    // Opposite directions intentionally start a new action immediately. Hosts
    // with only keyup are supported; separate same-direction gestures need a
    // quiet gap because that host exposes no reliable finger-release boundary.
    return eligible ? direction : 0;
  }
}
