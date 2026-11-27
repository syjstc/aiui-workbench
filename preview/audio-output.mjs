export function installAudioOutput(initialMute) {
  let muted = initialMute;
  const levels = new Set();
  const media = new Set();
  const mediaSettings = new WeakMap();
  const outputGains = new WeakMap();
  const collected = new FinalizationRegistry(({ entries, ref }) => entries.delete(ref));

  function remember(entries, value) {
    const ref = new WeakRef(value);
    entries.add(ref);
    collected.register(value, { entries, ref });
  }

  // The SDK uses both HTML media (including detached Audio elements)
  // and Web Audio. Keep the playback timeline and the app's own volume intact.
  const mediaPrototype = HTMLMediaElement.prototype;
  const nativeMute = Object.getOwnPropertyDescriptor(mediaPrototype, 'muted');
  const nativePlay = mediaPrototype.play;
  function trackMedia(element) {
    if (!mediaSettings.has(element)) {
      mediaSettings.set(element, nativeMute.get.call(element));
      remember(media, element);
    }
    if (muted) nativeMute.set.call(element, true);
  }
  Object.defineProperty(mediaPrototype, 'muted', {
    ...nativeMute,
    get() {
      return mediaSettings.get(this) ?? nativeMute.get.call(this);
    },
    set(value) {
      trackMedia(this);
      mediaSettings.set(this, Boolean(value));
      nativeMute.set.call(this, muted || Boolean(value));
    },
  });
  mediaPrototype.play = function (...args) {
    trackMedia(this);
    return nativePlay.apply(this, args);
  };
  window.Audio = new Proxy(window.Audio, {
    construct(target, args, newTarget) {
      const element = Reflect.construct(target, args, newTarget);
      trackMedia(element);
      return element;
    },
  });
  document.addEventListener('play', event => {
    if (event.target instanceof HTMLMediaElement) trackMedia(event.target);
  }, true);

  if (window.AudioContext && window.AudioNode) {
    const { connect, disconnect } = AudioNode.prototype;
    AudioNode.prototype.connect = function (destination, ...ports) {
      const context = this.context;
      if (!(context instanceof AudioContext) || destination !== context.destination) {
        return connect.apply(this, arguments);
      }
      let gain = outputGains.get(context);
      if (!gain) {
        gain = context.createGain();
        gain.gain.value = muted ? 0 : 1;
        connect.call(gain, destination);
        outputGains.set(context, gain);
        remember(levels, gain);
      }
      connect.call(this, gain, ...ports);
      return destination;
    };
    AudioNode.prototype.disconnect = function (destination, ...ports) {
      const gain = outputGains.get(this.context);
      if (gain && destination === this.context.destination) {
        return disconnect.call(this, gain, ...ports);
      }
      return disconnect.apply(this, arguments);
    };
  }

  return function setMuted(value) {
    if (muted === value) return;
    muted = value;
    for (const ref of levels) {
      const gain = ref.deref();
      if (gain) gain.gain.value = muted ? 0 : 1;
    }
    for (const ref of media) {
      const element = ref.deref();
      if (element) nativeMute.set.call(element, muted || mediaSettings.get(element));
    }
  };
}
