import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TempleNavigation, navigationDirection } from '../examples/hello-aiui/lib/temple-navigation.js';

async function page() {
  const source = await fs.readFile(new URL('../examples/hello-aiui/pages/index/index.ink', import.meta.url), 'utf8');
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/m, '').replace('export default', 'return');
  const instance = new Function('TempleNavigation', 'navigationDirection', script)(TempleNavigation, navigationDirection);
  instance.data = structuredClone(instance.data); instance.setData = patch => Object.assign(instance.data, patch);
  instance.onLoad(); let time = 0; instance.nav.now = () => time;
  function send(type, code, { after = 0, repeat = false } = {}) {
    time += after; let consumed = false;
    instance[type]({ code, repeat, preventDefault() { consumed = true; } }); return consumed;
  }
  return { instance, send };
}

test('public Page merges long keyup-only bursts and aliases, then accepts a separate swipe and reversal', async () => {
  const { instance: p, send } = await page();
  for (let i = 0; i < 30; i++) assert.equal(send('onKeyUp', i % 2 ? 'ArrowRight' : 'ArrowDown', { after: 65 }), true);
  assert.equal(p.data.choice, 1);
  send('onKeyUp', 'ArrowRight', { after: 400 }); assert.equal(p.data.choice, 2);
  send('onKeyUp', 'ArrowLeft', { after: 1 }); assert.equal(p.data.choice, 1);
  assert.equal(send('onKeyUp', 'VolumeUp'), false);
});

test('public Page holds auto-repeat until release and consumes merged paging events and back', async () => {
  const { instance: p, send } = await page();
  send('onKeyDown', 'ArrowRight');
  for (let i = 0; i < 25; i++) send('onKeyDown', 'ArrowDown', { after: 60, repeat: true });
  assert.equal(p.data.choice, 0);
  send('onKeyUp', 'ArrowRight'); assert.equal(p.data.choice, 1);
  send('onKeyUp', 'Enter'); assert.equal(p.data.mode, 'pages');
  // The tail of the same physical gesture cannot turn a page on entry.
  send('onKeyUp', 'ArrowDown', { after: 50 }); assert.equal(p.data.page, 0);
  for (let i = 0; i < 8; i++) send('onKeyUp', 'ArrowDown', { after: i ? 60 : 400 });
  assert.equal(p.data.page, 1);
  assert.equal(send('onKeyUp', 'Backspace'), true); assert.equal(p.data.mode, 'menu');
  p.onHide(); p.onShow(); send('onKeyUp', 'ArrowRight'); assert.equal(p.data.choice, 2);
});

test('synchronous rendering stalls do not turn queued repeats into another swipe', () => {
  let now = 0; const nav = new TempleNavigation({ now: () => now });
  assert.equal(nav.keyUp({ code: 'ArrowRight' }), 1);
  now += 1400; nav.excludeBlockedTime(1400);
  assert.equal(nav.keyUp({ code: 'ArrowDown' }), 0);
  now += 400; assert.equal(nav.keyUp({ code: 'ArrowRight' }), 1);
});
