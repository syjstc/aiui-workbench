import { useEffect, useRef, useState } from 'react';

export function useFileDrop(onFiles, disabled = false) {
  const [dragging, setDragging] = useState(false), depth = useRef(0), pending = useRef(false);
  const reset = () => { depth.current = 0; setDragging(false); };
  useEffect(() => {
    window.addEventListener('dragend', reset); window.addEventListener('blur', reset);
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('blur', reset); };
  }, []);
  const isFile = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  return { dragging, props: {
    onDragEnter: event => { if (!isFile(event)) return; event.preventDefault(); event.stopPropagation(); depth.current++; if (!disabled) setDragging(true); },
    onDragOver: event => { if (!isFile(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; },
    onDragLeave: event => { if (!isFile(event)) return; event.preventDefault(); event.stopPropagation(); if (--depth.current <= 0) reset(); },
    onDrop: async event => {
      if (!isFile(event)) return; event.preventDefault(); event.stopPropagation(); reset();
      const files = Array.from(event.dataTransfer.files);
      if (!files.length || disabled || pending.current) return;
      pending.current = true; try { await onFiles(files); } finally { pending.current = false; }
    },
  } };
}
