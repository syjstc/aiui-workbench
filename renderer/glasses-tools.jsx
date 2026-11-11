import {RecordingControls} from './recording-controls.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Battery, Camera, Check, ChevronRight, ExternalLink, Clock, Copy, Download, File, FileText, Folder, FolderOpen, FolderPlus, Glasses, HardDrive, Home, Info, LayoutGrid, LoaderCircle, Monitor, MousePointer2, Package, Play, Plus, Power, RefreshCw, Search, Settings2, Smartphone, Square, Terminal, Trash2, Upload, Volume1, Volume2, Wrench, X } from 'lucide-react';
import { getLocale, t, translateMessage } from './i18n.jsx';
import { JobHistory } from './job-history.jsx';
import { useFileDrop } from './file-drop.jsx';
import './glasses-tools.css';

const api = window.workbench;
const basename = file => file.split(/[\\/]/).at(-1);
const size = bytes => bytes == null ? '—' : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const date = value => value ? new Date(value).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const toolJob = job => job.type.startsWith('glasses-');
const tabs = [['overview', Info, '概览'], ['mirror', Monitor, '真机投屏'], ['files', FolderOpen, '文件'], ['apps', LayoutGrid, '应用'], ['utilities', Wrench, '常用工具']];

function Button({ icon: Icon, children, busy, className = '', ...props }) {
  return <button className={`button ${className}`} {...props}>{busy ? <LoaderCircle size={15} className="spin"/> : Icon && <Icon size={15}/>} {children}</button>;
}
function ErrorMessage({ error, retry }) {
  if (!error) return null;
  return <div className="glasses-error" role="alert"><AlertCircle size={17}/><span>{translateMessage(error)}</span>{retry && <button className="text-button" onClick={retry}>{t('重试')}</button>}</div>;
}
function Loading() { return <div className="glasses-loading" role="status"><LoaderCircle size={18} className="spin"/>{t('正在读取眼镜…')}</div>; }
function useTool(tool, args, revision = '', enabled = true) {
  const [data, setData] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), key = JSON.stringify(args);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    if (!enabled) { setData(null); setError(''); setLoading(false); return; }
    setLoading(true); setData(null); setError('');
    try { const value = await api.call(tool, JSON.parse(key)); if (request === sequence.current) setData(value); }
    catch (failure) { if (request === sequence.current) setError(failure.message); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [tool, key, revision, enabled]);
  useEffect(() => { reload(); return () => { sequence.current++; }; }, [reload]);
  return { data, loading, error, reload };
}
function ConfirmDialog({ title, description, target, confirmLabel, onClose, onConfirm }) {
  const ref = useRef(null), [busy, setBusy] = useState(false), [error,setError] = useState('');
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className="glasses-dialog" aria-labelledby="glasses-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === ref.current && !busy) onClose(); }}>
    <div><span className="glasses-dialog-icon"><AlertCircle size={24}/></span><h2 id="glasses-dialog-title">{title}</h2><p>{description}</p><code>{target}</code><ErrorMessage error={error}/><div className="button-row"><Button autoFocus disabled={busy} onClick={onClose}>{t('取消')}</Button><Button className="danger" busy={busy} disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const result=await onConfirm(); if(result===null)throw new Error(t('操作未提交，请重试')); onClose(); } catch(failure){setError(failure.message);} finally { setBusy(false); } }}>{confirmLabel}</Button></div></div>
  </dialog>;
}

function FilePreview({ serial, file, onClose, onExport, busy }) {
  const ref = useRef(null);
  const { data, loading, error } = useTool('aiui_glasses_read_file', { serial, path: file.path });
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className="glasses-dialog glasses-file-preview" aria-labelledby="glasses-file-preview-title" onCancel={event => { event.preventDefault(); onClose(); }}><div className="glasses-section-title"><div><h2 id="glasses-file-preview-title">{file.name}</h2><p>{size(file.bytes)} · {t('只读预览')}</p></div><Button icon={X} aria-label={t('关闭文件预览')} onClick={onClose}/></div><ErrorMessage error={error}/>{loading && <Loading/>}{data?.type === 'image' ? <img alt={file.name} src={`data:${data.mime};base64,${data.data}`}/> : data?.type === 'text' ? <pre>{data.content || t('空文件')}</pre> : null}<div className="button-row"><Button disabled={busy} icon={ArrowDownToLine} onClick={() => onExport(file)}>{t('导出到电脑')}</Button><Button onClick={onClose}>{t('关闭')}</Button></div></dialog>;
}

export function GlassesToolsPage({ discovery, jobs, refresh, notify, onCancel, onDelete, deleting, goToGuide }) {
  const [serial, setSerial] = useState('');
  const devices = discovery.environment?.devices || [], device = devices.find(item => item.serial === serial);
  useEffect(() => { setSerial(previous => devices.some(item => item.serial === previous) ? previous : devices.length === 1 ? devices[0].serial : ''); }, [discovery.environment]);
  const ready = device?.status === 'device' && discovery.environment?.adb && !discovery.error;
  const selectedJobs = jobs.filter(toolJob).filter(job => !serial || job.serial === serial);
  const pending = useRef(new Set());
  useEffect(() => {
    const preventNavigation = event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', preventNavigation); window.addEventListener('drop', preventNavigation);
    return () => { window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); };
  }, []);
  useEffect(() => {
    for (const job of jobs) if (pending.current.has(job.id) && job.status !== 'running') {
      pending.current.delete(job.id);
      if (job.status === 'succeeded') notify(t('眼镜操作已完成'));
      else if (job.status === 'failed') notify(job.error || t('眼镜操作未完成'), true);
    }
  }, [jobs]);
  async function startJob(tool, args) {
    try { const job = await api.call(tool, args); pending.current.add(job.id); await refresh(); return job; }
    catch (error) { notify(error.message, true); return null; }
  }
  return <>
    <div className="page-heading glasses-heading"><div><h1>{t('眼镜工具')}</h1><p>{t('文件、应用和设备状态，常用操作都在这里。')}</p></div><div className="glasses-device-picker"><Glasses size={19}/><label><span>{t('当前眼镜')}</span><select aria-label={t('工具目标眼镜')} value={serial} onChange={event => setSerial(event.target.value)}><option value="">{devices.length ? t('请选择一台眼镜') : t('尚未连接')}</option>{devices.map(item => <option key={item.serial} value={item.serial}>{item.name} · {item.serial.slice(-6)}{item.status !== 'device' ? ' · ' + (item.status === 'unauthorized' ? t('等待授权') : t('离线')) : ''}</option>)}</select></label>{ready && <span className="dot"/>}</div></div>
    {ready ? <ToolWorkspace key={`${device.serial}:${device.transport}`} serial={serial} device={device} jobs={selectedJobs} startJob={startJob} notify={notify}/> : <section className="panel glasses-disconnected"><Glasses size={38}/><h2>{discovery.error ? t('暂时无法读取连接状态') : device?.status === 'unauthorized' ? t('请先允许 USB 调试') : devices.length > 1 && !serial ? t('选择要使用的眼镜') : t('连接眼镜后即可使用工具')}</h2><p>{device?.status === 'unauthorized' ? t('请在眼镜上确认调试授权，完成后会自动连接。') : t('用专用数据调试线连接眼镜，并在手机 App 中打开“眼镜 ADB 调试”。')}</p><Button icon={Info} onClick={goToGuide}>{t('打开新手指南')}</Button><ErrorMessage error={discovery.error}/></section>}
    <JobHistory title={t('眼镜工具记录')} jobs={selectedJobs} onCancel={onCancel} onDelete={onDelete} deleting={deleting} onReveal={file => api.reveal(file).catch(error => notify(error.message, true))}/>
  </>;
}

function ToolWorkspace({ serial, device, jobs, startJob, notify }) {
  const [tab, setTab] = useState('overview');
  const revision = jobs.filter(job => job.status !== 'running').map(job => `${job.id}:${job.status}`).join('|');
  const busy = jobs.some(job => job.status === 'running');
  const common = { serial, revision, notify, busy, startJob };
  return <div className="glasses-workspace">
    <div className="glasses-tabs" role="tablist" aria-label={t('眼镜工具分类')}>{tabs.map(([key, Icon, label]) => <button key={key} id={`glasses-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls="glasses-tab-content" onClick={() => setTab(key)}><Icon size={16}/>{t(label)}</button>)}</div>
    <div id="glasses-tab-content" role="tabpanel" aria-labelledby={`glasses-tab-${tab}`}>
      {tab === 'overview' && <Overview {...common}/>}
      {tab === 'mirror' && <MirrorPane serial={serial} notify={notify}/>}
      {tab === 'files' && <FilesPane {...common}/>}
      {tab === 'apps' && <AppsPane {...common}/>}
      {tab === 'utilities' && <UtilitiesPane {...common} device={device}/>}
    </div>
  </div>;
}

function Meter({ value }) { return <div className="glasses-meter"><span style={{ width: `${Math.min(100, Math.max(0, value || 0))}%` }}/></div>; }
function MirrorPane({serial,notify}) {
  const [status,setStatus]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState('');
  const [maxFps,setMaxFps]=useState(30),[rotation,setRotation]=useState(0),[readOnly,setReadOnly]=useState(false),[live,setLive]=useState(null);
  const [screenshot,setScreenshot]=useState(null),[capturing,setCapturing]=useState(false),frame=useRef(null);
  const active=status?.session?.status==='running'&&pending!=='restart'&&pending!=='stop';
  const changed=active&&(status.session.maxFps!==maxFps||status.session.rotation!==rotation||status.session.readOnly!==readOnly);
  useEffect(()=>{
    let disposed=false,fetching=false;
    async function initialize(){setPending('start');setError('');try{const info=await api.call('aiui_glasses_mirror_embed_status',{serial});if(disposed)return;setStatus(info);if(!info.available)throw new Error(info.error);const session=await api.call('aiui_glasses_mirror_embed_start',{serial,maxFps:30,rotation:0,readOnly:false});if(!disposed){setStatus({...info,session});setMaxFps(session.maxFps);setRotation(session.rotation);setReadOnly(session.readOnly);}}catch(failure){if(!disposed)setError(failure.message);}finally{if(!disposed)setPending('');}}
    async function poll(){if(fetching)return;fetching=true;try{const value=await api.call('aiui_glasses_mirror_embed_status',{serial});if(!disposed)setStatus(value);}catch(failure){if(!disposed)setError(failure.message);}finally{fetching=false;}}
    initialize();const timer=setInterval(poll,1500);return()=>{disposed=true;clearInterval(timer);};
  },[serial]);
  useEffect(()=>{setLive(null);if(!status?.session?.url)return;const origin=new URL(status.session.url).origin;function receive(event){if(event.source!==frame.current?.contentWindow||event.origin!==origin||event.data?.channel!=='aiui-mirror-state'||event.data.sessionId!==status.session.id)return;setLive(event.data);}window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[status?.session?.id,status?.session?.url]);
  async function perform(action){setPending(action);setError('');try{if(action!=='start')await api.call('aiui_glasses_mirror_embed_stop',{serial});if(action!=='stop'){const session=await api.call('aiui_glasses_mirror_embed_start',{serial,maxFps,rotation,readOnly});setStatus(current=>({...current,session}));}else setStatus(current=>({...current,session:{...current?.session,status:'stopped'}}));}catch(failure){setError(failure.message);}finally{setPending('');}}
  async function popout(){try{if(api.openMirror)await api.openMirror(serial);else if(!window.open(status.session.url,'aiui-mirror-'+serial,'width=760,height=650'))throw new Error(t('请允许打开独立投屏窗口'));}catch(failure){notify(failure.message,true);}}
  return <div className="glasses-mirror-layout"><section className="panel glasses-mirror embedded-mirror-panel">
    <div className="glasses-section-title"><div><h2>{t('真机画面')}</h2><p>{t('连接后直接在这里显示，也可以打开独立窗口。')}</p></div><Button icon={ExternalLink} disabled={!active||!!pending} title={t('打开或召回独立投屏窗口')} onClick={popout}>{t('独立窗口')}</Button></div>
    <div className="embedded-mirror-stage">{active?<iframe ref={frame} key={status.session.id} src={status.session.url} title={t('内嵌真机投屏')}/>:<div className="embedded-mirror-empty"><Monitor size={38}/><strong>{pending?t('正在连接眼镜画面…'):t('真机投屏已暂停')}</strong>{!pending&&<Button className="primary" icon={Play} onClick={()=>perform('start')}>{t('开始投屏')}</Button>}</div>}</div>
    <div className="embedded-mirror-footer"><span><span className={'dot '+(!active?'muted':'')}/>{active?(live?.ready?t('画面已连接'):t('正在解码画面…')):t('未在投屏')}{active&&` · ${status.session.width} × ${status.session.height}`}</span><Button busy={!!pending} disabled={!!pending||!active} onClick={()=>perform('stop')}>{t('暂停投屏')}</Button></div>
    <ErrorMessage error={error||(!pending&&active&&live?.error)||status?.session?.error}/>
    <p className="glasses-pane-note">{active&&status.session.readOnly?t('只看画面已开启。点击“独立窗口”可打开或召回窗口。'):t('点击画面操作眼镜，右键返回。点击“独立窗口”可打开或召回窗口。')}</p>
    {screenshot&&<div className="mirror-screenshot"><img alt={t('真实眼镜截图')} src={`data:image/png;base64,${screenshot.data}`}/><Button icon={FolderOpen} onClick={()=>api.reveal(screenshot.path).catch(failure=>notify(failure.message,true))}>{t('打开文件位置')}</Button></div>}
  </section><aside className="glasses-mirror-sidebar" aria-label={t('投屏工具')}><RecordingControls source="glasses" serial={serial} disabled={!status?.available} capturing={capturing} onCapture={async()=>{setCapturing(true);try{setScreenshot(await api.call('aiui_glasses_screenshot',{serial}));notify(t('眼镜截图已保存到电脑'));}catch(failure){notify(failure.message,true);}finally{setCapturing(false);}}}/>
    <section className="mirror-settings"><div className="control-heading"><Settings2 size={16}/><strong>{t('投屏设置')}</strong></div><div className="glasses-mirror-options"><label>{t('帧率上限')}<select aria-label={t('投屏帧率')} value={maxFps} disabled={!!pending} onChange={event=>setMaxFps(Number(event.target.value))}>{[15,30,60].map(value=><option key={value} value={value}>{value} fps</option>)}</select></label><label>{t('画面旋转')}<select aria-label={t('投屏画面旋转')} value={rotation} disabled={!!pending} onChange={event=>setRotation(Number(event.target.value))}>{[0,90,180,270].map(value=><option key={value} value={value}>{value}°</option>)}</select></label><label className="glasses-checkbox"><input type="checkbox" checked={readOnly} disabled={!!pending} onChange={event=>setReadOnly(event.target.checked)}/><span>{t('只看画面，关闭鼠标与键盘控制')}</span></label>{changed&&<Button className="full" disabled={!!pending} onClick={()=>perform('restart')}>{t('应用投屏设置')}</Button>}</div></section>
  </aside></div>;
}
function Overview({ serial, revision }) {
  const { data, loading, error, reload } = useTool('aiui_glasses_info', { serial }, revision);
  const storage = data?.storage?.[0], memory = data?.memory, battery = data?.battery;
  return <>
    <div className="glasses-section-title"><div><h2>{t('设备概览')}</h2><p>{data ? t('更新于 {0}', { 0: date(data.checkedAt) }) : t('读取真实设备信息')}</p></div><Button icon={RefreshCw} busy={loading} disabled={loading} onClick={reload}>{t('刷新')}</Button></div>
    <ErrorMessage error={error} retry={reload}/>{loading && <Loading/>}
    {data && <><div className="glasses-metrics">
      <div><HardDrive size={19}/><span>{t('可用空间')}</span><strong>{size(storage?.available)}</strong><small>{t('总容量 {0}', { 0: size(storage?.total) })}</small></div>
      <div><Battery size={19}/><span>{t('电池电量')}</span><strong>{battery.percent == null ? '—' : `${battery.percent}%`}</strong><small>{battery.charging ? t('充电中') : battery.plugged ? t('已接通电源') : t('使用电池')}{battery.temperature != null && ` · ${battery.temperature} °C`}</small></div>
      <div><Activity size={19}/><span>{t('可用内存')}</span><strong>{size(memory.available)}</strong><small>{t('总内存 {0}', { 0: size(memory.total) })}</small></div>
      <div><Clock size={19}/><span>{t('本次运行')}</span><strong>{data.system.uptimeSeconds == null ? '—' : t('{0} 小时 {1} 分', { 0: Math.floor(data.system.uptimeSeconds / 3600), 1: Math.floor(data.system.uptimeSeconds / 60) % 60 })}</strong><small>{data.system.model || serial}</small></div>
    </div><div className="glasses-overview-grid"><section className="panel"><h2><HardDrive size={17}/>{t('存储空间')}</h2>{storage ? <div className="glasses-storage"><div><strong>{t('内部存储')}</strong><span>{t('已用 {0} / {1}', { 0: size(storage.used), 1: size(storage.total) })}</span></div><Meter value={storage.percent}/><p>{t('剩余 {0} 可用', { 0: size(storage.available) })}</p><p className="subtle">{t('共享文件与应用使用同一块内部存储，容量不重复相加。')}</p></div> : <p className="no-jobs">{t('设备未提供存储信息')}</p>}<div className="glasses-memory"><div><strong>{t('运行内存')}</strong><span>{t('可用 {0} / {1}', { 0: size(memory.available), 1: size(memory.total) })}</span></div><Meter value={memory.total && memory.available != null ? (memory.total - memory.available) / memory.total * 100 : 0}/></div></section>
      <section className="panel"><h2><Smartphone size={17}/>{t('系统信息')}</h2><dl className="glasses-info-list">{[[t('型号'), data.system.model], [t('制造商'), data.system.manufacturer], ['Android', `${data.system.android || '—'} · API ${data.system.api || '—'}`], [t('处理器架构'), data.system.abi], [t('系统版本'), data.system.build], [t('安全补丁'), data.system.securityPatch], [t('屏幕'), data.system.screen], [t('显示密度'), data.system.density], [t('设备序列号'), serial]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl></section></div>
      {data.network && <section className="panel glasses-network"><h2>{t('网络地址')}</h2><pre>{data.network}</pre></section>}
      {!!data.warnings.length && <details className="glasses-warnings"><summary>{t('部分信息暂不可用')}</summary>{data.warnings.map(item => <p key={item.section}>{item.section}: {translateMessage(item.message)}</p>)}</details>}
    </>}
  </>;
}

function FilesPane({ serial, revision, busy, startJob, notify }) {
  const [directory, setDirectory] = useState('/sdcard'), [pathInput, setPathInput] = useState('/sdcard'), [query, setQuery] = useState(''), [hidden, setHidden] = useState(false), [choosing, setChoosing] = useState(false), [newFolder, setNewFolder] = useState(null), [creating, setCreating] = useState(false), [previewFile, setPreviewFile] = useState(null);
  const { data, loading, error, reload } = useTool('aiui_glasses_files', { serial, path: directory }, revision);
  const entries = (data?.entries || []).filter(file => (hidden || !file.hidden) && file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const drop = useFileDrop(async files => {
    setChoosing(true);
    try {
      if (files.length > 50) throw new Error(t('一次最多导入 50 个文件'));
      const paths = await api.importFiles(files, 'files');
      if (paths.length) await startJob('aiui_glasses_push', { serial, files: paths, directory });
    } catch (failure) { notify(failure.message, true); } finally { setChoosing(false); }
  }, busy || loading || !data || choosing);
  function navigate(value) { setDirectory(value); setPathInput(value); setQuery(''); setNewFolder(null); }
  async function importFiles() {
    setChoosing(true);
    try { const files = await api.chooseFiles('files'); if (files.length) await startJob('aiui_glasses_push', { serial, files, directory }); }
    catch (failure) { notify(failure.message, true); } finally { setChoosing(false); }
  }
  async function exportFile(file) {
    setChoosing(true);
    try { const destination = await api.chooseDirectory(); if (destination) await startJob('aiui_glasses_pull', { serial, path: file.path, directory: destination }); }
    catch (failure) { notify(failure.message, true); } finally { setChoosing(false); }
  }
  return <section className={`panel glasses-files ${drop.dragging ? 'file-dragging' : ''}`} {...drop.props}>
    <div className="glasses-section-title"><div><h2>{t('眼镜文件')}</h2><p>{t('浏览共享存储，导入照片、视频和文档，或导出到电脑。')}</p></div><div className="button-row"><Button icon={FolderPlus} disabled={busy || loading || !data || choosing} onClick={() => setNewFolder('')}>{t('新建文件夹')}</Button><Button icon={Upload} disabled={busy || loading || !data || choosing} busy={choosing} onClick={importFiles}>{t('导入文件')}</Button></div></div>
    <div className="glasses-places">{[['/sdcard', '共享存储'], ['/sdcard/Download', '下载'], ['/sdcard/DCIM', '相机'], ['/sdcard/Pictures', '图片'], ['/sdcard/Movies', '视频'], ['/sdcard/Music', '音乐'], ['/sdcard/ScreenRecorder', '录屏']].map(([value, label]) => <button key={value} aria-pressed={directory === value} onClick={() => navigate(value)}><Folder size={14}/>{t(label)}</button>)}</div>
    <div className="glasses-file-drop-hint"><Upload size={15}/>{drop.dragging ? t('松开鼠标，导入到 {0}', { 0: directory }) : t('也可以把文件拖入这里，导入当前目录')}</div>
    <form className="glasses-path" onSubmit={event => { event.preventDefault(); if (pathInput.trim()) navigate(pathInput.trim()); }}><Button icon={ArrowUp} type="button" aria-label={t('上一级目录')} disabled={!data || directory === '/' || loading} onClick={() => navigate(data.parent)}/><input aria-label={t('眼镜目录路径')} value={pathInput} onChange={event => setPathInput(event.target.value)} spellCheck={false}/><Button type="submit" disabled={loading}>{t('前往')}</Button><Button type="button" icon={RefreshCw} aria-label={t('刷新文件列表')} disabled={loading} onClick={reload}/></form>
    <div className="glasses-file-filter"><label className="glasses-search"><Search size={15}/><input aria-label={t('搜索当前目录')} placeholder={t('搜索当前目录')} value={query} onChange={event => setQuery(event.target.value)}/></label><label className="glasses-checkbox"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)}/>{t('显示隐藏文件')}</label><span>{t('{0} 个项目', { 0: entries.length })}</span></div>
    {newFolder !== null && <form className="glasses-new-folder" onSubmit={async event => { event.preventDefault(); setCreating(true); try { await api.call('aiui_glasses_mkdir', { serial, directory, name: newFolder }); setNewFolder(null); await reload(); } catch (failure) { notify(failure.message, true); } finally { setCreating(false); } }}><FolderPlus size={17}/><input autoFocus aria-label={t('新文件夹名称')} placeholder={t('新文件夹名称')} value={newFolder} onChange={event => setNewFolder(event.target.value)}/><Button className="primary" type="submit" disabled={!newFolder.trim() || creating} busy={creating}>{t('创建')}</Button><Button type="button" disabled={creating} onClick={() => setNewFolder(null)}>{t('取消')}</Button></form>}
    <ErrorMessage error={error} retry={reload}/>{loading ? <Loading/> : data && <div className="glasses-table-wrap"><table className="glasses-file-table"><thead><tr><th>{t('名称')}</th><th>{t('大小')}</th><th>{t('修改时间')}</th><th><span className="glasses-sr-only">{t('操作')}</span></th></tr></thead><tbody>{entries.map(file => <tr key={file.path}><td><button className="glasses-filename" disabled={!['file', 'directory'].includes(file.type)} onClick={() => file.type === 'directory' ? navigate(file.path) : setPreviewFile(file)} title={file.name}>{file.type === 'directory' ? <Folder size={18}/> : <File size={18}/>}<span>{file.name}</span>{file.type === 'directory' && <ChevronRight size={14}/>}</button></td><td>{file.type === 'directory' ? t('文件夹') : file.type === 'link' ? t('符号链接') : size(file.bytes)}</td><td>{date(file.modifiedAt)}</td><td>{['directory', 'file'].includes(file.type) && <Button icon={ArrowDownToLine} disabled={busy || choosing} onClick={() => exportFile(file)} aria-label={t('导出 {0}', { 0: file.name })}>{t('导出')}</Button>}</td></tr>)}</tbody></table>{!entries.length && <p className="glasses-table-empty">{query ? t('没有匹配的文件') : t('这个文件夹是空的')}</p>}</div>}
    <p className="glasses-pane-note">{t('文件导入仅支持共享存储，同名文件不会被覆盖。导出结果可在下方记录中打开。')}</p>
    {previewFile && <FilePreview serial={serial} file={previewFile} busy={busy || choosing} onClose={() => setPreviewFile(null)} onExport={exportFile}/>}
  </section>;
}

function AppsPane(props) {
  const [kind,setKind]=useState('apk'),[installing,setInstalling]=useState(false);
  return <div className="installed-apps-workspace">
    <div className="app-type-switch" role="tablist" aria-label={t('应用类型分类')}>{[['apk',Package,'APK 应用'],['aiui',LayoutGrid,'AIUI 应用']].map(([key,Icon,label])=><button key={key} id={`app-kind-${key}`} role="tab" aria-selected={kind===key} aria-controls="installed-apps-content" onClick={()=>setKind(key)}><Icon size={16}/>{t(label)}</button>)}</div>
    <div id="installed-apps-content" role="tabpanel" aria-labelledby={`app-kind-${kind}`}>{kind==='apk'?<ApkAppsPane {...props} onInstall={()=>setInstalling(true)}/>:<AiuiAppsPane {...props}/>}</div>
    {installing&&<InstallDialog {...props} onClose={()=>setInstalling(false)}/>}
  </div>;
}

function InstallDialog({onClose,...props}) {
  const ref=useRef(null);
  useEffect(()=>{ref.current.showModal();},[]);
  return <dialog ref={ref} className="glasses-dialog app-install-dialog" aria-label={t('安装 APK')} onCancel={event=>{event.preventDefault();onClose();}}><Button className="install-dialog-close" icon={X} aria-label={t('关闭安装窗口')} onClick={onClose}/><InstallPane {...props} startJob={async(...args)=>{const job=await props.startJob(...args);if(job)onClose();return job;}}/></dialog>;
}

function InstalledAppIcon({app,large=false}) {
  const [failed,setFailed]=useState(null);
  const name=app.label||app.name||app.packageName?.split('.').at(-1)||'A';
  return <span className={'installed-app-icon '+(large?'large':'')} title={app.iconSource==='local-project'?t('图标来自关联的本地项目'):undefined}>{app.icon&&failed!==app.icon?<img alt="" referrerPolicy="no-referrer" src={app.icon} onError={()=>setFailed(app.icon)}/>:<span aria-hidden="true">{Array.from(name)[0].toLocaleUpperCase()}</span>}</span>;
}
function InstalledAppHeading({app,name,identity,badge,copyLabel,notify}) {
  return <header className="installed-app-heading"><InstalledAppIcon app={app} large/><div className="installed-app-title"><h3>{name}</h3><span className="pill">{badge}</span><div className="installed-app-identity"><code>{identity}</code><button aria-label={copyLabel} title={copyLabel} onClick={()=>api.copy(identity).then(()=>notify(t('已复制应用身份'))).catch(failure=>notify(failure.message,true))}><Copy size={14}/></button></div></div></header>;
}

function AiuiAppsPane({serial,revision,busy,startJob,notify}) {
  const {data,loading,error,reload}=useTool('aiui_glasses_aiui_apps',{serial},revision);
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(''),[confirm,setConfirm]=useState(null),[source,setSource]=useState('all');
  const sources={store:t('商店正式版'),developer:t('开发版'),builtin:t('系统内置'),unverified:t('身份待核实')};
  const apps=(data?.apps||[]).filter(app=>(source==='all'||app.source===source)&&`${app.name} ${app.agentId||''} ${app.version} ${app.description||''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const app=data?.apps.find(item=>item.fileName===selected);
  useEffect(()=>{if(data&&!data.apps.some(item=>item.fileName===selected))setSelected('');},[data,selected]);
  const store=data?.sources?.find(item=>item.source==='store');
  const readOnly=app&&(app.source!=='developer'||!app.removable);
  const permissionNames={CAMERA:t('相机'),GEOLOCATION:t('位置信息'),RECORD_AUDIO:t('麦克风'),INTERNET:t('网络'),STORAGE:t('存储'),BLUETOOTH:t('蓝牙')};
  return <section className="panel glasses-apps"><div className="glasses-section-title"><div><h2>{t('AIUI 应用')}</h2><p>{t('按来源查看可读取的应用信息，正式版与系统内置应用仅供查看。')}</p></div><Button icon={RefreshCw} disabled={loading} busy={loading} onClick={reload}>{t('刷新')}</Button></div>
    <div className="aiui-source-filters" role="group" aria-label={t('AIUI 应用来源')}>{['all','store','developer','builtin'].map(key=><button key={key} aria-pressed={source===key} onClick={()=>{setSource(key);setSelected('');}}>{key==='all'?t('全部'):sources[key]}{key==='store'&&<span>{t('只读')}</span>}{key==='builtin'&&<span>{t('只读')}</span>}</button>)}</div>
    <p className="app-scope-note aiui-read-only-note"><Info size={16}/>{t('商店正式版与系统内置应用只读：工坊不提供删除、卸载或清空数据。开发版可单独卸载。')}</p>
    {store?.status==='unavailable'&&(source==='all'||source==='store')&&<div className="aiui-catalog-unavailable"><strong>{t('商店正式版清单暂不可读取')}</strong><p>{store.reason==='permission-denied'?t('当前眼镜系统未开放正式版清单的读取权限，无法确认数量；这不代表没有安装正式版。'):t('当前眼镜未提供工坊可用的正式版清单接口，无法确认已安装数量。')}</p><small>{t('请在 Rokid App 中查看和管理商店正式版。')}</small></div>}
    {data?.sources?.filter(item=>item.source!=='store'&&item.status==='unavailable'&&(source==='all'||source===item.source)).map(item=><div className="aiui-catalog-unavailable" key={item.source}><strong>{sources[item.source]} · {t('清单暂不可读取')}</strong><p>{translateMessage(item.error)}</p></div>)}
    <div className="glasses-app-toolbar"><label className="glasses-search"><Search size={15}/><input aria-label={t('搜索 AIUI 应用')} placeholder={t('搜索名称、版本或 Agent ID')} value={query} onChange={event=>setQuery(event.target.value)}/></label>{data&&source!=='store'&&<span className="subtle">{t('已读取 {0} 个应用',{0:apps.length})}</span>}</div>
    <ErrorMessage error={error} retry={reload}/>{loading?<Loading/>:data&&<div className="glasses-app-layout"><div className="glasses-app-list" aria-label={t('已安装 AIUI 应用')}>{apps.map(item=><button key={item.fileName} className={selected===item.fileName?'selected':''} aria-pressed={selected===item.fileName} onClick={()=>setSelected(item.fileName)}><InstalledAppIcon app={item}/><span><strong>{item.name}</strong><code>{item.agentId||item.fileName}</code><small>{item.version||t('版本未知')} · {sources[item.source]}{item.source!=='developer'&&' · '+t('只读')}</small></span><ChevronRight size={14}/></button>)}{!apps.length&&<p className="glasses-table-empty">{source==='store'?t('正式版清单不可读取，未显示应用数量'):query?t('没有匹配的应用'):t('此来源没有可展示的应用信息')}</p>}</div>
      <div className="glasses-app-detail">{app?<><InstalledAppHeading app={app} name={app.name} identity={app.agentId||app.fileName} badge={'AIUI · '+sources[app.source]+(readOnly?' · '+t('只读'):'')} copyLabel={t('复制 Agent ID')} notify={notify}/>
        {readOnly&&<div className="aiui-detail-read-only"><Info size={16}/><span><strong>{t('仅供查看，不支持删除')}</strong><small>{t('此处不会卸载应用，也不会清空应用数据。')}</small></span></div>}
        {app.description&&<div className="aiui-app-description"><h4>{t('应用说明')}</h4><p>{app.description}</p></div>}
        <dl className="installed-app-metadata"><div><dt>{t('应用来源')}</dt><dd>{sources[app.source]}</dd></div><div><dt>{t('眼镜版本')}</dt><dd>{app.version||t('版本未知')}</dd></div><div><dt>{t('安装包大小')}</dt><dd>{size(app.bytes)}</dd></div><div><dt>{t('运行时要求')}</dt><dd>Ink {app.engine||'—'}</dd></div>{app.source==='builtin'?<><div><dt>{t('可用状态')}</dt><dd>{t('随系统提供，当前启用状态未核实')}</dd></div><div><dt>{t('系统宿主版本')}</dt><dd>{app.hostVersion||'—'}</dd></div><div><dt>{t('宿主更新时间')}</dt><dd>{app.hostUpdatedAt||'—'}</dd></div></>:<><div><dt>{t('更新时间')}</dt><dd>{date(app.modifiedAt)}</dd></div><div><dt>{t('本地项目')}</dt><dd>{app.localProject?`${app.localProject.name} · ${app.localProject.version}`:t('未关联本地项目')}</dd></div></>}{!!app.permissions?.length&&<div><dt>{t('声明权限')}</dt><dd>{app.permissions.map(value=>permissionNames[value]||value).join(' · ')}</dd></div>}</dl>
        {app.localProject&&app.version!==app.localProject.version&&<p className="app-version-note">{t('眼镜与本地项目版本不同，可在“连接眼镜”中重新安装。')}</p>}
        <details className="glasses-raw installed-app-technical"><summary>{t('技术信息')}</summary><dl className="installed-app-metadata"><div><dt>{t('安装包文件')}</dt><dd>{app.fileName}</dd></div>{app.hostPackage&&<div><dt>{t('宿主包名')}</dt><dd>{app.hostPackage}</dd></div>}{app.checksum&&<div><dt>MD5</dt><dd>{app.checksum}</dd></div>}{app.definitionSha256&&<div><dt>SHA256</dt><dd>{app.definitionSha256}</dd></div>}</dl></details>
        {app.source==='developer'&&app.removable&&<div className="glasses-app-danger"><Button icon={Trash2} disabled={busy} onClick={()=>setConfirm(app)}>{t('卸载开发版本')}</Button></div>}
      </>:<div className="glasses-app-placeholder"><LayoutGrid size={32}/><p>{t('选择 AIUI 应用，查看详细信息')}</p></div>}</div>
    </div>}
    {confirm&&<ConfirmDialog title={t('卸载这个 AIUI 开发版本？')} description={t('将移除这台眼镜上的开发安装包及其本地注册。电脑中的项目文件会保留；云端移除状态需另行确认。')} target={`${confirm.name} · ${confirm.version}\n${confirm.agentId}\n${serial}`} confirmLabel={t('确认卸载开发版本')} onClose={()=>setConfirm(null)} onConfirm={()=>startJob('aiui_glasses_aiui_uninstall',{serial,agentId:confirm.agentId,confirmAgentId:confirm.agentId})}/>}
  </section>;
}

function ApkAppsPane({ serial, revision, busy, startJob, notify, onInstall }) {
  const { data, loading, error, reload } = useTool('aiui_glasses_apps', { serial }, revision);
  const [filter, setFilter] = useState('user'), [query, setQuery] = useState(''), [selected, setSelected] = useState(''), [confirm, setConfirm] = useState(null);
  const details = useTool('aiui_glasses_app_details', { serial, packageName: selected }, revision, !!selected && !!data?.packages.some(item => item.packageName === selected));
  const packages = (data?.packages || []).filter(item => (filter === 'all' || (filter === 'user' ? !item.system : item.system)) && `${item.label||''} ${item.packageName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const app = data?.packages.find(item => item.packageName === selected);
  async function action(value) { return startJob('aiui_glasses_app_action', { serial, packageName: selected, action: value, ...(['clear', 'uninstall'].includes(value) ? { confirmPackage: selected } : {}) }); }
  return <section className="panel glasses-apps"><div className="glasses-section-title"><div><h2>{t('APK 应用')}</h2><p>{t('查看已安装的 APK 应用，打开、停止或管理第三方应用。')}</p></div><div className="button-row"><Button icon={RefreshCw} disabled={loading} busy={loading} onClick={reload}>{t('刷新')}</Button><Button icon={Plus} className="primary" disabled={busy} onClick={onInstall}>{t('安装 APK')}</Button></div></div>
    <div className="glasses-app-toolbar"><label className="glasses-search"><Search size={15}/><input aria-label={t('搜索应用包名')} placeholder={t('搜索名称或包名')} value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label={t('应用类型')} value={filter} onChange={event => setFilter(event.target.value)}><option value="user">{t('第三方应用')}</option><option value="system">{t('系统应用')}</option><option value="all">{t('全部应用')}</option></select><span className="subtle">{t('{0} 个应用', { 0: packages.length })}</span></div>
    <ErrorMessage error={error} retry={reload}/>{loading ? <Loading/> : data && <div className="glasses-app-layout"><div className="glasses-app-list" aria-label={t('已安装应用')}>{packages.map(item => <button key={item.packageName} className={selected === item.packageName ? 'selected' : ''} aria-pressed={selected === item.packageName} onClick={() => setSelected(item.packageName)}><InstalledAppIcon app={item}/><span><strong>{item.label||item.packageName.split('.').at(-1)}</strong><code>{item.packageName}</code><small>versionCode {item.versionCode || '—'}{item.disabled ? ' · ' + t('已停用') : ''}</small></span><ChevronRight size={14}/></button>)}{!packages.length && <p className="glasses-table-empty">{t('没有匹配的应用')}</p>}</div>
      <div className="glasses-app-detail">{app ? <>
        <InstalledAppHeading app={app} name={app.label||app.packageName.split('.').at(-1)} identity={app.packageName} badge={'APK · '+(app.system?t('系统应用'):t('第三方应用'))} copyLabel={t('复制包名')} notify={notify}/>
        <div className="installed-app-actions"><Button icon={Play} className="primary" disabled={busy||app.disabled} onClick={()=>action('launch')}>{t('打开应用')}</Button>{!app.system&&<Button icon={Square} disabled={busy} onClick={()=>action('stop')}>{t('强行停止')}</Button>}</div>
        <ErrorMessage error={details.error}/>{details.loading&&<Loading/>}{details.data&&<>
          <dl className="installed-app-metadata"><div><dt>{t('版本')}</dt><dd>{details.data.versionName||'—'} <span className="metadata-secondary">({details.data.versionCode||app.versionCode})</span></dd></div><div><dt>{t('安装时间')}</dt><dd>{details.data.firstInstallTime||'—'}</dd></div><div><dt>{t('更新时间')}</dt><dd>{details.data.lastUpdateTime||'—'}</dd></div></dl>
          <details className="glasses-raw installed-app-technical"><summary>{t('技术信息')}</summary><div className="installed-app-paths"><strong>{t('APK 路径')}</strong>{details.data.apkPaths.map(file=><code key={file}>{file}</code>)}</div><pre>{details.data.output}</pre></details>
        </>}
        {!app.system&&<div className="glasses-app-danger"><span className="app-management-label">{t('应用管理')}</span><Button icon={Trash2} disabled={busy} onClick={()=>setConfirm('clear')}>{t('清空应用数据')}</Button><Button icon={Trash2} disabled={busy} onClick={()=>setConfirm('uninstall')}>{t('卸载应用')}</Button></div>}
      </> : <div className="glasses-app-placeholder"><Package size={32}/><p>{t('选择应用查看版本和管理操作')}</p></div>}</div>
    </div>}
    {confirm && <ConfirmDialog title={confirm === 'clear' ? t('清空这个应用的数据？') : t('卸载这个应用？')} description={confirm === 'clear' ? t('这会删除应用的登录状态、设置和本地数据，应用本身会保留。') : t('这会从当前眼镜移除应用，并删除它的本地数据。')} target={`${selected} · ${serial.slice(-6)}`} confirmLabel={confirm === 'clear' ? t('确认清空数据') : t('确认卸载')} onClose={() => setConfirm(null)} onConfirm={() => action(confirm)}/>}
  </section>;
}

function InstallPane({ serial, busy, startJob, notify }) {
  const [files, setFiles] = useState([]), [replace, setReplace] = useState(true), [choosing, setChoosing] = useState(false), [submitting, setSubmitting] = useState(false);
  function addFiles(selected) {
    if (selected.some(file => !/\.apk$/i.test(file))) throw new Error(t('请拖入独立 .apk 文件'));
    const combined = [...new Set([...files, ...selected])];
    if (combined.length > 20) throw new Error(t('一次最多安装 20 个 APK'));
    setFiles(combined);
  }
  const drop = useFileDrop(async dropped => {
    setChoosing(true);
    try {
      if (dropped.length > 20) throw new Error(t('一次最多安装 20 个 APK'));
      if (dropped.some(file => !/\.apk$/i.test(file.name))) throw new Error(t('请拖入独立 .apk 文件'));
      addFiles(await api.importFiles(dropped, 'apk'));
    } catch (failure) { notify(failure.message, true); } finally { setChoosing(false); }
  }, busy || choosing || submitting);
  async function choose() {
    setChoosing(true);
    try { const selected = await api.chooseFiles('apk'); if (selected.length) addFiles(selected); }
    catch (failure) { notify(failure.message, true); } finally { setChoosing(false); }
  }
  return <section className="panel glasses-installer"><div className="glasses-section-title"><div><h2>{t('快速安装 APK')}</h2><p>{t('选择电脑上的安装包，直接安装到当前眼镜。')}</p></div><span className="pill">APK</span></div>
    <button className={`glasses-apk-picker ${drop.dragging ? 'file-dragging' : ''}`} {...drop.props} aria-label={t('选择 APK 文件')} onClick={choose} disabled={choosing || submitting || busy}><span>{choosing ? <LoaderCircle size={28} className="spin"/> : <Download size={28}/>}</span><strong>{choosing ? t('正在准备文件…') : drop.dragging ? t('松开鼠标，加入安装列表') : t('拖入 APK 文件，或点击选择')}</strong><small>{t('可多选独立安装包，按顺序逐个安装')}</small></button>
    {!!files.length && <div className="glasses-apk-list">{files.map(file => <div key={file}><Package size={20}/><span><strong>{basename(file)}</strong><code title={file}>{file}</code></span><button aria-label={t('移除安装项 {0}', { 0: basename(file) })} disabled={busy || submitting} onClick={() => setFiles(previous => previous.filter(item => item !== file))}><X size={16}/></button></div>)}<Button icon={Plus} disabled={busy || choosing || submitting || files.length >= 20} onClick={choose}>{t('继续添加')}</Button></div>}
    <label className="glasses-checkbox glasses-replace"><input type="checkbox" checked={replace} disabled={busy || submitting} onChange={event => setReplace(event.target.checked)}/><span><strong>{t('更新已有应用并保留数据')}</strong><small>{t('关闭后，如果眼镜已安装相同包名的应用，安装将失败。')}</small></span></label>
    <div className="glasses-install-footer"><p>{t('支持标准独立 .apk；APKS、XAPK 和拆分 APK 暂不支持。安装错误会显示在任务记录中。')}</p><Button icon={Download} className="primary" busy={submitting} disabled={!files.length || busy || choosing || submitting} onClick={async () => { setSubmitting(true); try { await startJob('aiui_glasses_install', { serial, files, replace }); } finally { setSubmitting(false); } }}>{t('安装 {0} 个 APK', { 0: files.length })}</Button></div>
  </section>;
}

function UtilitiesPane({ serial, device, busy, notify }) {
  const [pending, setPending] = useState(''), [screenshot, setScreenshot] = useState(null), [logs, setLogs] = useState(null), [lines, setLines] = useState(500), [query, setQuery] = useState(''), [confirm, setConfirm] = useState(false);
  async function perform(name, args = {}) {
    setPending(name);
    try { const value = await api.call(name === 'screenshot' ? 'aiui_glasses_screenshot' : name === 'logs' ? 'aiui_glasses_logs' : 'aiui_glasses_control', { serial, ...args }); if (name === 'screenshot') setScreenshot(value); else if (name === 'logs') setLogs(value); else notify(t('操作已发送到眼镜')); return value; }
    catch (failure) { notify(failure.message, true); } finally { setPending(''); }
  }
  const disabled = busy || !!pending;
  const key = (action, Icon, label, className = '') => <Button key={action} className={className} icon={Icon} title={t(label)} aria-label={t(label)} disabled={disabled} onClick={() => perform(action, { action })}>{t(label)}</Button>;
  return <><div className="glasses-utilities-grid"><section className="panel glasses-remote"><div className="glasses-section-title"><div><h2>{t('快捷遥控')}</h2><p>{t('通过数据线操作眼镜，每次点击发送一次按键。')}</p></div><Wrench size={19}/></div><div className="glasses-dpad">{key('up', ArrowUp, '向上', 'key-up')}{key('left', ArrowLeft, '向左', 'key-left')}{key('enter', Check, '确认', 'key-enter')}{key('right', ArrowRight, '向右', 'key-right')}{key('down', ArrowDown, '向下', 'key-down')}</div><div className="glasses-remote-secondary">{key('home', Home, '回到桌面')}{key('back', ArrowLeft, '返回')}{key('volumeDown', Volume1, '音量减')}{key('volumeUp', Volume2, '音量加')}{key('wake', Power, '唤醒屏幕')}{key('sleep', Power, '关闭屏幕')}{key('settings', Settings2, '打开系统设置')}</div><div className="glasses-reboot"><span>{t('眼镜无响应时，可尝试重新启动。')}</span><Button icon={RefreshCw} disabled={disabled} onClick={() => setConfirm(true)}>{t('重启眼镜')}</Button></div></section>
    <section className="panel glasses-capture"><div className="glasses-section-title"><div><h2>{t('眼镜截图')}</h2><p>{t('截取当前真实屏幕并保存到电脑。')}</p></div><Button icon={Camera} disabled={disabled} busy={pending === 'screenshot'} onClick={() => perform('screenshot')}>{t('截图')}</Button></div>{screenshot ? <><div className="glasses-capture-image"><img alt={t('真实眼镜截图')} src={`data:image/png;base64,${screenshot.data}`}/></div><div className="glasses-capture-meta"><span>{screenshot.width} × {screenshot.height} · {size(screenshot.bytes)}</span><Button icon={FolderOpen} onClick={() => api.reveal(screenshot.path).catch(failure => notify(failure.message, true))}>{t('打开文件位置')}</Button></div></> : <div className="glasses-capture-empty"><Camera size={32}/><p>{t('点击截图，查看眼镜当前画面')}</p></div>}</section></div>
    <section className="panel glasses-device-logs"><div className="glasses-section-title"><div><h2><Terminal size={17}/>{t('设备日志')}</h2><p>{t('读取最近的系统日志，同时保存一份 TXT 到电脑。')}</p></div><div className="button-row"><select aria-label={t('设备日志行数')} value={lines} onChange={event => setLines(Number(event.target.value))}>{[100, 500, 1000, 5000].map(value => <option key={value} value={value}>{t('最近 {0} 行', { 0: value })}</option>)}</select><Button icon={FileText} disabled={disabled} busy={pending === 'logs'} onClick={() => perform('logs', { lines })}>{t('读取并导出')}</Button></div></div>{logs && <><div className="glasses-log-toolbar"><label className="glasses-search"><Search size={15}/><input aria-label={t('筛选设备日志')} placeholder={t('筛选设备日志')} value={query} onChange={event => setQuery(event.target.value)}/></label><Button icon={FolderOpen} onClick={() => api.reveal(logs.path).catch(failure => notify(failure.message, true))}>{t('打开日志位置')}</Button></div><pre className="glasses-log-output">{logs.output.split('\n').filter(line => line.toLowerCase().includes(query.toLowerCase())).join('\n') || t('没有匹配的日志')}</pre></>}</section>
    {confirm && <ConfirmDialog title={t('重启当前眼镜？')} description={t('正在运行的眼镜应用会关闭，USB 连接会暂时断开。')} target={`${device.name} · ${serial}`} confirmLabel={t('确认重启')} onClose={() => setConfirm(false)} onConfirm={() => perform('reboot', { action: 'reboot', confirmSerial: serial })}/>}
  </>;
}
