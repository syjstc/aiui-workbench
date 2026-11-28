import React, { useEffect, useRef, useState } from 'react';
import { Palette, Volume2, VolumeX } from 'lucide-react';
import { t } from './i18n.jsx';

export function PreviewAudioButton({ muted, onToggle }) {
  const Icon = muted ? VolumeX : Volume2;
  return <button type="button" className="button preview-audio-button" aria-label={t('预览静音')}
    aria-pressed={muted} title={t(muted ? '恢复预览声音' : '预览静音')} onClick={onToggle}>
    <Icon size={15} aria-hidden="true"/>{t(muted ? '已静音' : '静音')}
  </button>;
}

export function PreviewDisplayButton({ mode, onToggle }) {
  const color = mode === 'color';
  return <button type="button" className="button preview-display-button" aria-label={t('彩色显示')}
    aria-pressed={color} title={t(color ? '切换为单绿，应用将重新加载' : '切换为彩色，应用将重新加载')} onClick={onToggle}>
    <Palette size={15} aria-hidden="true"/>{t(color ? '彩色' : '单绿')}
  </button>;
}

export function PreviewFrame({ preview, muted, displayMode, ref, onLoad, ...props }) {
  const ownRef = useRef(null);
  const frame = ref ?? ownRef;
  // Initial preferences must reach Ink before the bundle starts.
  const [src] = useState(() => {
    const url = new URL(preview.url);
    if (muted) url.searchParams.set('muted', '1');
    if (displayMode === 'color') url.searchParams.set('display', displayMode);
    return url.href;
  });
  function control(action, parameters) {
    const url = new URL(src);
    frame.current?.contentWindow?.postMessage({
      channel: 'aiui-preview-control',
      sessionId: preview.id,
      key: url.searchParams.get('key'),
      action,
      parameters,
    }, url.origin);
  }
  function syncAudio() { control('audio_mute', { muted }); }
  function syncDisplay() { control('display_mode', { mode: displayMode }); }
  useEffect(syncAudio, [src, preview.id, muted]);
  useEffect(syncDisplay, [src, preview.id, displayMode]);
  return <iframe {...props} ref={frame} src={src} onLoad={() => { syncAudio(); syncDisplay(); onLoad?.(); }}/>;
}
