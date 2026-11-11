import { t, translateMessage } from './i18n.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, ArrowUp, X } from 'lucide-react';

export function WebDirectoryPicker({ api }) {
  const [resolve, setResolve] = useState(null), [listing, setListing] = useState(null), [directory, setDirectory] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const request = useRef(0), current = useRef(null), dialog = useRef(null);
  async function browse(value) {
    const sequence = ++request.current; setLoading(true); setError('');
    try { const result = await api.listDirectories(value); if (request.current === sequence) { setListing(result); setDirectory(result.directory); } }
    catch (e) { if (request.current === sequence) setError(e.message); }
    finally { if (request.current === sequence) setLoading(false); }
  }
  function finish(value) { request.current++; current.current?.(value); current.current = null; setResolve(null); }
  useEffect(() => {
    api.setDirectoryPicker(callback => { current.current?.(null); current.current = callback; setResolve(() => callback); setListing(null); setDirectory(''); browse(); });
    return () => { api.setDirectoryPicker(null); current.current?.(null); };
  }, []);
  useEffect(() => { if (resolve) dialog.current?.focus(); }, [!!resolve]);
  if (!resolve) return null;
  return <div className="modal-backdrop web-picker-backdrop" onClick={() => finish(null)}><div className="modal directory-picker" role="dialog" aria-modal="true" aria-label={t("选择本机目录")} ref={dialog} tabIndex={-1} onClick={e => e.stopPropagation()} onKeyDown={e => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    if (e.key === 'Tab') {
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input')], first = controls[0], last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }}><button className="modal-close" aria-label={t("取消选择目录")} onClick={() => finish(null)}><X size={18}/></button><h2>{t("选择本机目录")}</h2><p className="muted-copy">{t("浏览这台电脑的文件夹，也可以输入绝对路径。")}</p><form className="directory-path" onSubmit={e => { e.preventDefault(); browse(directory); }}><input aria-label={t("目录路径")} value={directory} onChange={e => setDirectory(e.target.value)}/><button className="button" type="submit" disabled={loading}>{t("前往")}</button></form><div className="button-row"><button className="button" disabled={!listing || loading} onClick={() => browse(listing.parent)}><ArrowUp size={15}/>{t(" 上一级")}</button><button className="button" disabled={loading} onClick={() => browse()}>{t("用户目录")}</button></div>{error && <p role="alert" className="update-error">{translateMessage(error)}</p>}<div className="directory-list" aria-busy={loading}>{loading ? <p className="subtle">{t("正在读取目录…")}</p> : listing?.directories.map(item => <button key={item.path} onClick={() => browse(item.path)}><FolderOpen size={17}/>{item.name}</button>)}{!loading && listing && !listing.directories.length && <p className="subtle">{t("此目录没有子文件夹")}</p>}</div><div className="button-row"><button className="button" onClick={() => finish(null)}>{t("取消")}</button><button className="button primary" disabled={!listing || loading || directory !== listing.directory} onClick={() => finish(listing.directory)}>{t("选择此目录")}</button></div></div></div>;
}
