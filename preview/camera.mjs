// Ink's browser ImageCapture backend resolves real MediaStreams through this
// registry (also used by the official browser media adapter in Ink 0.19.1).
const registryKey = Symbol.for('com.rokid.jsui.ink.mediaStreams');
function registry() {
  if (!(globalThis[registryKey] instanceof Map)) globalThis[registryKey] = new Map();
  return globalThis[registryKey];
}
const error = (name, message) => new DOMException(message, name);
const stop = stream => stream?.getTracks().forEach(track => track.stop());

export class SimulatorCamera {
  constructor({ emit, changed = () => {}, onPhoto = () => {} }) {
    this.emit = emit; this.changed = changed; this.onPhoto = onPhoto;
    this.source = 'fixture'; this.permission = true; this.fixture = null;
    this.image = null; this.streams = new Map(); this.generation = 0; this.lastError = null;
    const devices = navigator.mediaDevices;
    this.nativeDevices = devices && { getUserMedia: devices.getUserMedia.bind(devices), enumerateDevices: devices.enumerateDevices.bind(devices) };
    this.NativeImageCapture = globalThis.ImageCapture;
  }
  state() {
    return { source: this.source, fixture: !!this.fixture, permission: this.permission,
      previewStream: 'supported', activeStreams: this.streams.size, error: this.lastError };
  }
  assertAllowed(generation = this.generation) {
    if (generation !== this.generation) throw error('AbortError', '相机操作已取消，请重试取景');
    if (!this.permission) throw error('NotAllowedError', '模拟相机权限已拒绝');
  }
  async setFixture(fixture) {
    const generation = this.generation;
    const bytes = Uint8Array.from(atob(fixture.data), c => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: fixture.mimeType }));
    if (generation !== this.generation) { image.close(); throw error('AbortError', '相机操作已取消，请重试取景'); }
    if (this.source !== 'fixture') this.stopAll();
    const previous = this.image;
    this.source = 'fixture'; this.fixture = fixture; this.image = image; this.lastError = null;
    for (const entry of this.streams.values()) entry.draw?.();
    previous?.close(); this.changed();
  }
  setSource(source) {
    if (!['fixture', 'webcam'].includes(source)) throw new Error('不支持的相机来源');
    if (source !== this.source) this.stopAll();
    this.source = source; this.lastError = null; this.changed();
  }
  setPermission(allowed) {
    if (!allowed) this.stopAll();
    this.permission = !!allowed; this.lastError = null; this.changed();
  }
  fail(failure) {
    const webcamErrors = { NotAllowedError: '电脑摄像头权限未获准，请检查系统或浏览器设置', NotFoundError: '没有找到电脑摄像头，请连接后重试', NotReadableError: '电脑摄像头暂不可用，请关闭其他占用相机的应用后重试' };
    this.lastError = this.source === 'webcam' && this.permission ? webcamErrors[failure.name] || failure.message : failure.message;
    this.changed(); throw failure;
  }
  async getUserMedia(request) {
    console.info('SDK media.getUserMedia', JSON.stringify(request));
    const generation = this.generation;
    let stream, entry;
    try {
      this.assertAllowed(generation);
      if (request.constraints?.audio || !request.constraints?.video)
        throw error('NotSupportedError', '模拟相机仅支持视频，请关闭音频请求');
      if (this.streams.has(request.streamId)) throw error('InvalidStateError', '相机流已存在');
      if (this.source === 'fixture') {
        if (!this.image) throw error('NotFoundError', '请在相机面板选择照片，或切换到电脑摄像头');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1920 / Math.max(this.image.width, this.image.height));
        canvas.width = Math.max(1, Math.round(this.image.width * scale));
        canvas.height = Math.max(1, Math.round(this.image.height * scale));
        const context = canvas.getContext('2d');
        const draw = () => {
          // Keep existing tracks alive when the user selects a different photo.
          const fit = Math.min(canvas.width / this.image.width, canvas.height / this.image.height);
          const width = this.image.width * fit, height = this.image.height * fit;
          context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(this.image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        };
        draw();
        const fps = Math.max(1, Math.min(30, Number(request.constraints.video.frameRate) || 10));
        stream = canvas.captureStream(fps);
        entry = { stream, canvas, draw, timer: setInterval(draw, 1000 / fps) };
      } else {
        if (!this.nativeDevices?.getUserMedia) throw error('NotSupportedError', '当前浏览器无法使用电脑摄像头');
        stream = await this.nativeDevices.getUserMedia({ audio: false, video: request.constraints.video });
        entry = { stream };
      }
      this.assertAllowed(generation);
      const tracks = stream.getVideoTracks();
      if (!tracks.length || tracks.some(track => track.readyState === 'ended')) throw error('NotReadableError', '摄像头没有可用画面');
      this.streams.set(request.streamId, entry); registry().set(request.streamId, stream);
      entry.stops = new Map(tracks.map(track => [track.id, track.stop.bind(track)])); entry.stopped = new Set();
      for (const track of tracks) {
        // Ink 0.19 also uses a direct browser-media path. Observe its native
        // track.stop() calls as well as the host-capability stop requests.
        track.stop = () => this.stopTrack({ streamId: request.streamId, trackId: track.id });
        track.addEventListener('ended', () => this.stopTrack({ streamId: request.streamId, trackId: track.id }), { once: true });
        for (const type of ['mute', 'unmute']) track.addEventListener(type, () => this.emit(`media.mediaTrack${type === 'mute' ? 'Muted' : 'Unmuted'}`, { targetId: track.id, streamId: request.streamId, trackId: track.id }));
      }
      this.lastError = null; this.changed();
      return { streamId: request.streamId, tracks: tracks.map(track => ({ trackId: track.id, kind: 'video',
        label: this.source === 'fixture' ? '本地照片（模拟取景）' : track.label || '电脑摄像头',
        enabled: track.enabled, muted: track.muted, settings: { ...track.getSettings(), deviceId: this.source === 'fixture' ? 'fixture-camera' : track.getSettings().deviceId } })) };
    } catch (failure) {
      clearInterval(entry?.timer); stop(stream);
      if (generation !== this.generation) throw error('AbortError', '相机操作已取消，请重试取景');
      return this.fail(failure);
    }
  }
  stopTrack({ streamId, trackId }) {
    const entry = this.streams.get(streamId), track = entry?.stream.getTracks().find(item => item.id === trackId);
    if (!track || entry.stopped.has(trackId)) return;
    entry.stopped.add(trackId);
    const aliases = [...registry()].filter(([, stream]) => stream === entry.stream).map(([id]) => id);
    entry.stops.get(trackId)();
    if (entry.stream.getTracks().every(item => item.readyState === 'ended')) {
      clearInterval(entry.timer); entry.video?.pause();
      if (entry.video) entry.video.srcObject = null;
      this.streams.delete(streamId);
      for (const [id, stream] of registry()) if (stream === entry.stream) registry().delete(id);
    }
    for (const id of aliases.length ? aliases : [streamId]) this.emit('media.mediaTrackEnded', { targetId: trackId, streamId: id, trackId });
    this.changed();
  }
  stopAll() {
    this.generation++;
    for (const [streamId, entry] of this.streams) for (const track of entry.stream.getTracks()) this.stopTrack({ streamId, trackId: track.id });
  }
  async takePhoto(request) {
    console.info('SDK media.takePhoto', JSON.stringify(request));
    const generation = this.generation;
    let temporary = null;
    try {
      this.assertAllowed(generation);
      let result;
      if (this.source === 'fixture') {
        if (!this.fixture) throw error('NotFoundError', '请在相机面板选择照片，或切换到电脑摄像头');
        result = { data: Uint8Array.from(atob(this.fixture.data), c => c.charCodeAt(0)), mimeType: this.fixture.mimeType };
      } else {
        let entry = [...this.streams.values()].find(item => item.stream.getVideoTracks().some(track => track.readyState === 'live'));
        if (!entry) {
          const streamId = crypto.randomUUID();
          await this.getUserMedia({ streamId, constraints: { video: {} } });
          temporary = streamId; entry = this.streams.get(streamId);
        }
        this.assertAllowed(generation);
        const video = entry.video ||= document.createElement('video');
        video.muted = true; video.playsInline = true; video.srcObject = entry.stream;
        await video.play(); this.assertAllowed(generation);
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        if (!canvas.width || !canvas.height) throw error('NotReadableError', '摄像头没有可用画面');
        canvas.getContext('2d').drawImage(video, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
        if (!blob) throw error('NotReadableError', '摄像头照片编码失败');
        result = { data: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
      }
      this.assertAllowed(generation); this.onPhoto(); this.lastError = null; this.changed(); return result;
    } catch (failure) {
      if (generation !== this.generation) throw error('AbortError', '相机操作已取消，请重试取景');
      return this.fail(failure);
    } finally {
      const entry = this.streams.get(temporary);
      if (entry) for (const track of entry.stream.getTracks()) this.stopTrack({ streamId: temporary, trackId: track.id });
    }
  }
  async enumerateDevices() {
    if (this.source === 'fixture') return [{ deviceId: 'fixture-camera', kind: 'videoinput', label: '本地照片（模拟取景）' }];
    return (await this.nativeDevices.enumerateDevices()).filter(device => device.kind === 'videoinput').map(device => ({ deviceId: device.deviceId, kind: device.kind, label: device.label, groupId: device.groupId }));
  }
  entryFor(track) {
    return [...this.streams.values()].find(entry => entry.stream.getVideoTracks().includes(track));
  }
  async grabFrame(track) {
    const generation = this.generation, entry = this.entryFor(track);
    this.assertAllowed(generation);
    if (!entry || track.readyState === 'ended') throw error('InvalidStateError', '相机轨道已结束，请重试取景');
    let bitmap;
    if (entry.canvas) bitmap = await createImageBitmap(entry.canvas);
    else if (this.NativeImageCapture) {
      entry.capture ||= new this.NativeImageCapture(track);
      bitmap = await entry.capture.grabFrame();
    } else {
      const video = entry.video ||= document.createElement('video');
      video.muted = true; video.playsInline = true;
      if (video.srcObject !== entry.stream) video.srcObject = entry.stream;
      await video.play(); this.assertAllowed(generation);
      bitmap = await createImageBitmap(video);
    }
    try { this.assertAllowed(generation); if (!this.entryFor(track)) throw error('InvalidStateError', '相机轨道已结束，请重试取景'); }
    catch (failure) { bitmap.close(); throw failure; }
    return bitmap;
  }
  installBrowserMedia() {
    const devices = navigator.mediaDevices;
    if (!devices) return;
    const originals = new Map(['getUserMedia', 'enumerateDevices'].map(name => [name, Object.getOwnPropertyDescriptor(devices, name)]));
    Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: async constraints => {
      const streamId = crypto.randomUUID();
      await this.getUserMedia({ streamId, constraints: { audio: constraints?.audio || undefined, video: constraints?.video === true ? {} : constraints?.video || undefined } });
      const entry = this.streams.get(streamId);
      if (!entry) throw error('AbortError', '相机操作已取消，请重试取景');
      return entry.stream;
    } });
    Object.defineProperty(devices, 'enumerateDevices', { configurable: true, value: () => this.enumerateDevices() });
    const camera = this, originalCapture = Object.getOwnPropertyDescriptor(globalThis, 'ImageCapture');
    // A still-photo canvas may not produce a new native captureStream frame
    // while its document is occluded. Snapshot that canvas directly instead.
    Object.defineProperty(globalThis, 'ImageCapture', { configurable: true, writable: true, value: class {
      constructor(track) { if (!camera.entryFor(track)) throw error('InvalidStateError', '相机轨道已结束，请重试取景'); this.track = track; }
      grabFrame() { return camera.grabFrame(this.track); }
      async takePhoto(settings = {}) {
        if (!camera.entryFor(this.track) || this.track.readyState === 'ended') throw error('InvalidStateError', '相机轨道已结束，请重试取景');
        const result = await camera.takePhoto(settings); return new Blob([result.data], { type: result.mimeType });
      }
    } });
    this.restoreBrowserMedia = () => {
      for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(devices, name, descriptor); else delete devices[name];
      if (originalCapture) Object.defineProperty(globalThis, 'ImageCapture', originalCapture); else delete globalThis.ImageCapture;
    };
  }
  capabilities() {
    return Object.fromEntries(['getUserMedia', 'stopMediaTrack', 'takePhoto', 'enumerateDevices'].map(name => [name,
      (name === 'stopMediaTrack' ? this.stopTrack : this[name]).bind(this)]));
  }
  destroy() { this.stopAll(); this.restoreBrowserMedia?.(); this.image?.close(); this.image = null; this.fixture = null; }
}
