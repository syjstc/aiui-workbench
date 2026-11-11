import { t, getLocale, translateMessage } from './i18n.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { JobHistory, jobLabels } from './job-history.jsx';

const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function LogsPage({ projects, previews, jobs, onCancel, onDelete, deleting, onClearPreview, clearingPreview, notify }) {
  const [type, setType] = useState('all'), [serviceLog, setServiceLog] = useState(null), [error, setError] = useState(''), [clearing, setClearing] = useState(false);
  const request = useRef(0), clearingService = useRef(false);
  async function loadServiceLog() {
    if (clearingService.current) return;
    const current = ++request.current;
    try { const info = await window.workbench.call('aiui_service_log_status'); if (current === request.current) { setServiceLog(info); setError(''); } }
    catch (error) { if (current === request.current) setError(error.message); }
  }
  useEffect(() => { loadServiceLog(); const timer = setInterval(loadServiceLog, 3000); return () => { clearInterval(timer); request.current++; }; }, []);
  async function clearServiceLog() {
    clearingService.current = true; setClearing(true); request.current++;
    try { const info = await window.workbench.call('aiui_service_log_clear'); setServiceLog(info); setError(''); notify(t("服务日志已清空，新日志会继续写入")); }
    catch (error) { notify(error.message, true); }
    finally { clearingService.current = false; setClearing(false); }
  }
  return <>
    <div className="page-heading"><div><h1>{t("日志与记录")}</h1><p>{t("查看运行状态与任务结果，管理本机的日志和记录。")}</p></div></div>
    <div className="log-overview">
    <section className="panel preview-log-history" aria-label={t("模拟器运行日志")}><div className="section-heading"><h2><Terminal size={17}/>{t("模拟器运行日志")}</h2><span className="subtle">{t("按预览会话清理")}</span></div>
      {previews.length ? previews.map(preview => <div className="log-session-row" key={preview.id}><div><strong>{projects.find(project => project.id === preview.projectId)?.name || t("预览会话")}</strong><small>{preview.page} · {preview.target === '_current' ? t("卡片") : t("全屏")} · {preview.logCount}{t(" 条日志")}</small></div><button className="button" aria-label={t("清空") + (projects.find(project => project.id === preview.projectId)?.name || t("预览会话")) + t("运行日志")} disabled={!!clearingPreview} onClick={() => onClearPreview(preview.id)}><Trash2 size={14}/>{clearingPreview === preview.id ? t("正在清空…") : t("清空日志")}</button></div>) : <p className="no-jobs">{t("打开模拟预览后，可在这里清理应用日志与 SDK 调用记录。")}</p>}
    </section>
    <section className="panel service-log-panel" aria-label={t("本地服务日志")}><div className="section-heading"><h2><FileText size={17}/>{t("本地服务日志")}</h2><button className="text-button" aria-label={t("刷新服务日志大小")} onClick={loadServiceLog} disabled={clearing}><RefreshCw size={14}/>{t("刷新")}</button></div><div className="service-log-body"><div><p>{translateMessage(error) || (serviceLog ? t("当前大小 {0}", {0: size(serviceLog.bytes)}) : t("正在读取…"))}</p>{serviceLog && <p className="service-log-path">{serviceLog.path}</p>}</div><button className="button" disabled={clearing || !serviceLog || !!error} onClick={clearServiceLog}><Trash2 size={14}/>{clearing ? t("正在清空…") : t("清空服务日志")}</button></div></section>
    </div>
    <JobHistory title={type === 'all' ? t("全部任务记录") : t(jobLabels[type]) + t("记录")} jobs={jobs.filter(job => type === 'all' || job.type === type)} onCancel={onCancel} onDelete={onDelete} deleting={deleting} toolbar={<div className="log-filter"><label>{t("任务类型")}<select aria-label={t("筛选任务类型")} value={type} onChange={event => setType(event.target.value)}><option value="all">{t("全部任务")}</option>{Object.entries(jobLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><span className="subtle">{t("运行中的任务可在结束后清理")}</span></div>}/>
  </>;
}
