import React,{useState} from 'react';
import {Download,RefreshCw,X,ArrowUpRight} from 'lucide-react';
import {t,translateMessage} from './i18n.jsx';
import './update-notice.css';

export function UpdateNotice({api,updates,onUpdate}) {
  const [dismissed,setDismissed]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  if(api.kind==='web'||!updates?.updateAvailable||dismissed===updates.latest?.version)return null;
  const downloading=busy||updates.downloading,percent=updates.progress?.total?Math.min(100,Math.round(updates.progress.received/updates.progress.total*100)):0;
  async function upgrade(){setBusy(true);setError('');try{await api.updates('upgrade');onUpdate(await api.updates('status'));}catch(failure){setError(translateMessage(failure.message));}finally{setBusy(false);}}
  return <section className="app-update-notice" role="status" aria-label={t('工坊版本升级')}>
    <button className="update-notice-dismiss" aria-label={t('暂时关闭升级提示')} disabled={downloading} onClick={()=>setDismissed(updates.latest.version)}><X size={13}/></button>
    <div className="update-notice-title"><span className="dot"/><strong>{t('发现新版本 {0}',{0:updates.latest.version})}</strong></div>
    <p>{updates.canInstall?t('点击下载、校验并重启升级。项目和工作记录会保留。'):t('下载适合当前系统的更新安装包。')}</p>
    {error&&<div className="update-notice-error" role="alert">{error}</div>}
    {updates.downloading&&<progress aria-label={t('安装包下载进度')} value={updates.progress?.received||0} max={updates.progress?.total||1}/>}
    <button className="button primary update-notice-action" disabled={downloading||!updates.latest.file} onClick={upgrade}>{downloading?<RefreshCw size={14} className="spin"/>:<Download size={14}/>} {downloading?t('正在升级 {0}%',{0:percent}):updates.canInstall?t('下载并重启升级'):t('下载更新')}</button>
    <button className="update-notice-release" onClick={()=>api.updates('release').catch(failure=>setError(translateMessage(failure.message)))}>{t('查看发行说明')}<ArrowUpRight size={12}/></button>
  </section>;
}
