import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatorCamera } from '../preview/camera.mjs';

function environment(t, getUserMedia) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const devices = { getUserMedia, enumerateDevices: async () => [] };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: devices } });
  const camera = new SimulatorCamera({ emit: () => {} });
  t.after(() => { camera.destroy(); if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  return { camera, devices };
}
function videoStream() {
  const track = new EventTarget();
  Object.assign(track, { id: crypto.randomUUID(), kind: 'video', label: 'Test video', enabled: true, muted: false, readyState: 'live',
    stop() { track.readyState = 'ended'; }, getSettings: () => ({ width: 640, height: 480, frameRate: 10 }) });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}

test('browser media interception never opens a computer camera in fixture mode, and track.stop releases all registry aliases', async t => {
  let nativeCalls = 0; const { track, stream } = videoStream();
  const { camera, devices } = environment(t, async () => { nativeCalls++; return stream; });
  const original = devices.getUserMedia;
  camera.installBrowserMedia();
  await assert.rejects(devices.getUserMedia({ video: true }), { name: 'NotFoundError' });
  assert.equal(nativeCalls, 0);
  camera.setSource('webcam');
  assert.equal(await devices.getUserMedia({ video: true, audio: false }), stream);
  assert.equal(nativeCalls, 1); assert.equal(camera.state().activeStreams, 1);
  const registry = globalThis[Symbol.for('com.rokid.jsui.ink.mediaStreams')];
  registry.set(crypto.randomUUID(), stream); // Ink adds its own runtime stream ID.
  track.stop(); track.stop();
  assert.equal(track.readyState, 'ended'); assert.equal(camera.state().activeStreams, 0);
  assert.equal([...registry.values()].includes(stream), false);
  camera.destroy(); assert.equal(devices.getUserMedia, original);
});

test('a pending camera permission/open cannot leak a stream after switching sources or denying permission', async t => {
  let resolveOpen;
  const { camera } = environment(t, () => new Promise(resolve => { resolveOpen = resolve; }));
  camera.setSource('webcam');
  const { stream, track } = videoStream();
  const opening = camera.getUserMedia({ streamId: crypto.randomUUID(), constraints: { video: {} } });
  camera.setPermission(false); resolveOpen(stream);
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(track.readyState, 'ended'); assert.equal(camera.state().activeStreams, 0);
  camera.setPermission(true);
  const second = videoStream(), pending = camera.getUserMedia({ streamId: crypto.randomUUID(), constraints: { video: {} } });
  camera.setSource('fixture'); resolveOpen(second.stream);
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(second.track.readyState, 'ended');
});

test('denying simulated permission terminates an active native track and blocks another open', async t => {
  let calls = 0; const { stream, track } = videoStream();
  const { camera } = environment(t, async () => { calls++; return stream; });
  camera.setSource('webcam');
  await camera.getUserMedia({ streamId: crypto.randomUUID(), constraints: { video: {} } });
  camera.setPermission(false);
  assert.equal(track.readyState, 'ended'); assert.equal(camera.state().activeStreams, 0);
  await assert.rejects(camera.getUserMedia({ streamId: crypto.randomUUID(), constraints: { video: {} } }), { name: 'NotAllowedError' });
  assert.equal(calls, 1);
});

test('the host takePhoto adapter returns fixture bytes and respects simulated denial', async t => {
  const { camera } = environment(t, async () => { throw new Error('No hardware access'); });
  camera.fixture = { data: btoa('fixture'), mimeType: 'image/png' };
  const photo = await camera.takePhoto({ quality: 'high' });
  assert.equal(new TextDecoder().decode(photo.data), 'fixture'); assert.equal(photo.mimeType, 'image/png');
  camera.setPermission(false); await assert.rejects(camera.takePhoto({}), { name: 'NotAllowedError' });
});
