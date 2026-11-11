const direction = code => ['ArrowRight', 'ArrowDown'].includes(code) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(code) ? -1 : 0;

// Desktop DOM timestamps are monotonic event creation times, so queued input
// cannot acquire a new quiet gap merely because drawing delayed its callback.
export class DesktopNavigation {
  constructor() { this.reset(); }
  reset() { this.held = null; this.lastDirection = 0; this.lastAt = -Infinity; }
  handle(type, event) {
    const step = direction(event.code);
    if (!step) return null;
    const at = event.timeStamp;
    const eligible = !event.repeat && (step !== this.lastDirection || at - this.lastAt >= 360);
    let result = 0;
    if (type === 'keydown') {
      if (this.held?.step !== step) this.held = { step, eligible };
    } else {
      result = !event.repeat && (this.held?.step === step ? this.held.eligible : eligible) ? step : 0;
      if (!event.repeat) this.held = null;
    }
    this.lastDirection = step; this.lastAt = at;
    return result;
  }
}
