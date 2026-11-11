import React,{useEffect,useState} from 'react';
import {Video,Square,FolderOpen} from 'lucide-react';
import {t} from './i18n.jsx';
import './recording-controls.css';
export function RecordingControls({source,sessionId,serial,disabled=false}) {
  const [items,setItems]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[seconds,setSeconds]=useState(30);
  const api=window.workbench;
  async function refresh(){const result=await api.call('aiui_record_status');setItems(result.recordings.filter(r=>r.source===source&&(source==='simulator'?r.sessionId===sessionId:r.serial===serial)));}
  useEffect(()=>{let live=true;const poll=()=>api.call('aiui_record_status').then(result=>{if(live)setItems(result.recordings.filter(r=>r.source===source&&(source==='simulator'?r.sessionId===sessionId:r.serial===serial)));}).catch(()=>{});poll();const timer=setInterval(poll,1000);return()=>{live=false;clearInterval(timer);};},[source,sessionId,serial]);
  const latest=items[0],active=latest&&['starting','recording','finalizing'].includes(latest.status);
  async function act(){setBusy(true);setError('');try{if(active)await api.call('aiui_record_stop',{recordingId:latest.id});else await api.call('aiui_record_start',{source,...(source==='simulator'?{sessionId}:{serial}),durationSeconds:seconds,fps:24});await refresh();}catch(error){setError(error.message);}finally{setBusy(false);}}
  return <div className="recording-controls" aria-label={t('画面录制')}><div className="recording-buttons"><Video size={16}/><span>{active?t('正在录制…'):t('画面录制')}</span><select aria-label={t('录制时长')} value={seconds} disabled={active||busy} onChange={e=>setSeconds(Number(e.target.value))}>{[10,30,60,120].map(v=><option key={v} value={v}>{v}s</option>)}</select><button className="button" disabled={busy||(!active&&disabled)} onClick={act}>{active?<Square size={13}/>:<Video size={13}/>} {active?t('停止并保存'):t('开始录制')}</button>{latest?.status==='completed'&&<button className="text-button" onClick={()=>api.reveal(latest.path).catch(e=>setError(e.message))}><FolderOpen size={13}/>{t('打开视频位置')}</button>}</div>{error&&<p className="recording-error" role="alert">{error}</p>}{!error&&latest&&['failed','interrupted'].includes(latest.status)&&<p className="recording-error">{latest.error}</p>}<small>{t('只录应用画面，无声音；文件保存在电脑。模拟画面与真机屏幕录制会明确标记来源。')}</small></div>;
}
