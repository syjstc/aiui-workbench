import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Unplug, Trash2 } from 'lucide-react';
import { t, translateMessage } from './i18n.jsx';

export function ProjectRemovalDialog({ project, operation, onClose, onWorking, onRemoved }) {
  const [step, setStep] = useState(1), [name, setName] = useState(''), [acknowledged, setAcknowledged] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const input = useRef(null), first = useRef(null), deleting = operation === 'delete';
  useEffect(() => { (step === 2 ? input : first).current?.focus(); }, [step]);
  useEffect(() => { const escape = event => { if (event.key === 'Escape' && !pending) onClose(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [pending, onClose]);
  async function confirm(event) {
    event.preventDefault();
    if (step !== 2 || name !== project.name || !acknowledged || pending) return;
    setPending(true); onWorking(true); setError('');
    try {
      const result = await window.workbench.removeProject({ projectId: project.id, operation, confirmationName: name, confirmationPath: project.projectPath, expectedRevision: project.revision, acknowledged: true });
      onRemoved(result);
    } catch (failure) { setError(translateMessage(failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))); }
    finally { setPending(false); onWorking(false); }
  }
  return <form className="project-removal-dialog" onSubmit={confirm}>
    <span className="removal-symbol"><AlertTriangle size={25}/></span>
    <p className="eyebrow">{t('谨慎操作')} · {step} / 2</p>
    <h2>{deleting ? t('删除项目及本地文件') : t('解绑项目')}</h2>
    <div className="removal-target"><strong>{project.name}</strong><code>{project.projectPath}</code></div>
    <div className="removal-warning" role="alert">{deleting
      ? t('整个项目文件夹及其中的所有文件将移到系统废纸篓或回收站，并从工坊移除。请确认路径中没有需要保留的其他文件。')
      : t('项目将从工坊列表移除，并停止源码监听和模拟预览。磁盘上的源码、素材及项目文件会全部保留，可随时重新导入。')}</div>
    {step === 1 ? <>
      <p className="subtle">{t('请先核对上方项目名称和完整路径，再继续第二次确认。')}</p>
      <div className="removal-actions"><button type="button" className="button" onClick={onClose}>{t('取消')}</button><button ref={first} type="button" className="button removal-continue" onClick={() => setStep(2)}>{t('继续确认')}</button></div>
    </> : <>
      <label className="field"><span>{t('输入完整项目名以确认')}</span><input ref={input} aria-label={t('输入完整项目名以确认')} value={name} onChange={event => setName(event.target.value)} autoComplete="off" disabled={pending}/></label>
      <label className="removal-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={pending}/><span>{deleting ? t('我已核对完整路径，确认将此项目文件夹及全部内容移到废纸篓或回收站') : t('我已核对完整路径，确认仅从工坊解绑此项目')}</span></label>
      {error && <p className="removal-error" role="alert">{error}</p>}
      <div className="removal-actions"><button type="button" className="button" disabled={pending} onClick={onClose}>{t('取消')}</button><button type="submit" className="button removal-confirm" disabled={pending || name !== project.name || !acknowledged}>{deleting ? <Trash2 size={15}/> : <Unplug size={15}/>} {pending ? t('正在处理…') : deleting ? t('确认删除项目和文件') : t('确认解绑项目')}</button></div>
    </>}
  </form>;
}
