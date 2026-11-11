import { dragPose } from '../shared/pose.mjs';

// The first point on entry anchors the cursor. Subsequent motion controls the
// head without holding a button; leaving never carries a delta into re-entry.
export function bindMousePose(canvas, { getPose, getOptions, ready, onPose, onDrag, onTap, onInteract }) {
  let pointer = null, pressed = null, localPose = null, active = false, idleTimer = 0;
  const listeners = [];
  const listen = (target, name, handler) => {
    target.addEventListener(name, handler, true);
    listeners.push(() => target.removeEventListener(name, handler, true));
  };
  const consume = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  const enabled = e => getOptions().enabled && e.pointerType !== 'touch';
  function resting() {
    clearTimeout(idleTimer);
    localPose = null;
    if (active) { active = false; onDrag(false); }
  }
  function cancel() { pointer = null; pressed = null; resting(); }
  const anchor = e => { pointer = { id:e.pointerId, x:e.clientX, y:e.clientY }; };
  listen(canvas, 'pointerenter', e => { if (enabled(e)) anchor(e); });
  listen(canvas, 'pointerleave', cancel);
  listen(document, 'pointermove', e => { if(e.target!==canvas)cancel(); });
  listen(canvas, 'pointermove', e => {
    if (!enabled(e) || !ready()) { cancel(); return; }
    consume(e);
    if (!pointer || pointer.id !== e.pointerId) { anchor(e); return; }
    const dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
    anchor(e);
    if (!dx && !dy) return;
    if (pressed) pressed.distance += Math.hypot(dx,dy);
    if (!active) { active=true;onInteract();onDrag(true); }
    // Keep this movement's accumulator independent of asynchronous UI / iframe
    // snapshots. An older sensor acknowledgement must not erase recent deltas.
    localPose=dragPose(localPose||getPose(),dx,dy,getOptions().sensitivity,e.shiftKey||!!(e.buttons&2));
    onPose(localPose);
    clearTimeout(idleTimer);idleTimer=setTimeout(resting,140);
  });
  listen(canvas, 'pointerdown', e => {
    if (!enabled(e) || !ready() || ![0,2].includes(e.button)) return;
    consume(e);anchor(e);
    pressed={id:e.pointerId,button:e.button,distance:0};
    canvas.focus({preventScroll:true});onInteract();
  });
  listen(canvas, 'pointerup', e => {
    if (!enabled(e)) return;
    consume(e);
    const tap=pressed?.id===e.pointerId&&pressed.button===0&&pressed.distance<3&&!e.shiftKey;
    pressed=null;
    if (tap&&ready()) onTap();
  });
  listen(canvas, 'pointercancel', e => { if(enabled(e))consume(e);cancel(); });
  listen(canvas, 'contextmenu', e => { if(getOptions().enabled)consume(e); });
  listen(canvas, 'click', e => { if(getOptions().enabled)consume(e); });
  listen(window, 'blur', cancel);
  listen(document, 'visibilitychange', () => { if(document.hidden)cancel(); });
  return {cancel,destroy(){cancel();listeners.forEach(remove=>remove());}};
}
