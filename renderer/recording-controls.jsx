import React,{useEffect,useState} from 'react';
import {Video,Square,FolderOpen,Camera,LoaderCircle} from 'lucide-react';
import {t} from './i18n.jsx';
import './recording-controls.css';
export function RecordingControls({source,sessionId,serial,disabled=false,onCapture,capturing=false}) {
  const [items,setItems]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[seconds,setSeconds]=useState(30);
  const api=window.workbench;
  async function refresh(){const result=await api.call('aiui_record_status');setItems(result.recordings.filter(r=>r.source===source&&(source==='simulator'?r.sessionId===sessionId:r.serial===serial)));}
  useEffect(()=>{let live=true;const poll=()=>api.call('aiui_record_status').then(result=>{if(live)setItems(result.recordings.filter(r=>r.source===source&&(source==='simulator'?r.sessionId===sessionId:r.serial===serial)));}).catch(()=>{});poll();const timer=setInterval(poll,1000);return()=>{live=false;clearInterval(timer);};},[source,sessionId,serial]);
  const latest=items[0],active=latest&&['starting','recording','finalizing'].includes(latest.status);
  async function act(){setBusy(true);setError('');try{if(active)await api.call('aiui_record_stop',{recordingId:latest.id});else await api.call('aiui_record_start',{source,...(source==='simulator'?{sessionId}:{serial}),durationSeconds:seconds,fps:24});await refresh();}catch(error){setError(error.message);}finally{setBusy(false);}}
  return <section className="recording-controls" aria-label={t('截图与录制')}><div className="control-heading"><Video size={16}/><strong>{t('截图与录制')}</strong><span className="pill">{source==='simulator'?t('模拟画面'):t('真机屏幕')}</span></div><div className="recording-body">
    {onCapture&&<button className="button full" disabled={disabled||capturing} onClick={onCapture}>{capturing?<LoaderCircle size={14} className="spin"/>:<Camera size={14}/>} {t('保存截图')}</button>}
    <label className="recording-duration"><span>{t('录制时长')}</span><select aria-label={t('录制时长')} value={seconds} disabled={active||busy} onChange={e=>setSeconds(Number(e.target.value))}>{[10,30,60,120].map(v=><option key={v} value={v}>{v}s</option>)}</select></label>
    <button className={'button full '+(active?'':'primary')} disabled={busy||latest?.status==='finalizing'||(!active&&disabled)} onClick={act}>{busy||latest?.status==='finalizing'?<LoaderCircle size={14} className="spin"/>:active?<Square size={14}/>:<Video size={14}/>} {latest?.status==='finalizing'?t('正在保存视频…'):active?t('停止并保存'):t('开始录制')}</button>
    {active&&<p className="recording-status" role="status"><span className="dot"/>{latest.status==='finalizing'?t('正在保存视频…'):t('正在录制…')}</p>}
    {latest?.status==='completed'&&<button className="text-button recording-result" onClick={()=>api.reveal(latest.path).catch(e=>setError(e.message))}><FolderOpen size={13}/>{t('打开视频位置')}</button>}
    {error&&<p className="recording-error" role="alert">{error}</p>}{!error&&latest&&['failed','interrupted'].includes(latest.status)&&<p className="recording-error">{latest.error}</p>}
    <small>{t('无声录制，保存在电脑，并标记画面来源。')}</small>
  </div></section>;
}
