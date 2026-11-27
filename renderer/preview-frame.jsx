import React, { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { t } from './i18n.jsx';

export function PreviewAudioButton({ muted, onToggle }) {
  const Icon = muted ? VolumeX : Volume2;
  return <button type="button" className="button preview-audio-button" aria-label={t('预览静音')}
    aria-pressed={muted} title={t(muted ? '恢复预览声音' : '预览静音')} onClick={onToggle}>
    <Icon size={15} aria-hidden="true"/>{t(muted ? '已静音' : '静音')}
  </button>;
}

export function PreviewFrame({ preview, muted, ref, onLoad, ...props }) {
  const ownRef = useRef(null);
  const frame = ref ?? ownRef;
  // The initial URL carries the preference before an app can start playing.
  // Later toggles go to the existing iframe so the app continues running.
  const [src] = useState(() => {
    const url = new URL(preview.url);
    if (muted) url.searchParams.set('muted', '1');
    return url.href;
  });
  function syncAudio() {
    const url = new URL(src);
    frame.current?.contentWindow?.postMessage({
      channel: 'aiui-preview-control',
      sessionId: preview.id,
      key: url.searchParams.get('key'),
      action: 'audio_mute',
      parameters: { muted },
    }, url.origin);
  }
  useEffect(syncAudio, [src, preview.id, muted]);
  return <iframe {...props} ref={frame} src={src} onLoad={() => { syncAudio(); onLoad?.(); }}/>;
}
