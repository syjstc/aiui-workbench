import { t, getLocale, translateMessage } from './i18n.jsx';
import React, { useState } from 'react';
import { AlertCircle, Check, ChevronDown, FolderOpen, LoaderCircle, Trash2 } from 'lucide-react';

export const jobLabels = { recording:'录制短片', 'preview-test': '模拟测试', build: '检查并打包', 'sdk-prepare': 'SDK 兼容性检查', knowledge: '同步官方资料', check: '官方源码检查', pack: '构建 AIX', deploy: '安装到眼镜', launch: '启动眼镜页面', 'device-setup': '准备眼镜环境', 'platform-prepare': '准备平台导入', 'glasses-pull': '导出眼镜文件', 'glasses-push': '导入眼镜文件', 'glasses-install': '安装 APK', 'glasses-app': '管理眼镜应用' };
const time = value => value ? new Date(value).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t("尚未运行");
function description(job) {
  const diagnostics = job.result?.diagnostics?.diagnostics;
  if (job.status === 'succeeded' && job.type === 'check' && Array.isArray(diagnostics)) return diagnostics.length ? t("检查通过 · {0} 条诊断提示", {0: diagnostics.length}) : t("检查通过，未发现问题");
  return translateMessage(job.error || job.message);
}

export function JobList({ jobs, onCancel, onDelete, deleting, onReveal }) {
  const [expanded, setExpanded] = useState(null);
  if (!jobs.length) return <p className="no-jobs">{t("暂无任务记录。")}</p>;
  return <div className="job-list">{jobs.map(job => <div className="job-item" key={job.id} data-job-id={job.id}>
    <div className="job-row"><button className="job-summary" aria-expanded={expanded === job.id} onClick={() => setExpanded(expanded === job.id ? null : job.id)}>
      <span className={'job-icon ' + job.status}>{job.status === 'running' ? <LoaderCircle size={17} className="spin"/> : job.status === 'succeeded' ? <Check size={17}/> : <AlertCircle size={17}/>}</span>
      <div><strong>{t(jobLabels[job.type] || job.type)}</strong><small>{description(job)}</small></div>
      <span className="job-time">{time(job.startedAt)}</span><span className={'pill job-status ' + (job.status === 'failed' ? 'red' : job.status === 'succeeded' ? 'success' : '')}>{({ running: t("进行中"), succeeded: t("已完成"), failed: t("未通过"), cancelled: t("已取消"), interrupted: t("已中断") })[job.status]}</span><ChevronDown size={13} className="job-expand"/>
    </button>{onReveal && job.status === 'succeeded' && job.result?.path && <button className="job-open-result" aria-label={t('打开导出文件位置')} onClick={() => onReveal(job.result.path)}><FolderOpen size={14}/>{t('打开文件位置')}</button>}{job.status === 'running' ? <button className="text-button job-action" onClick={() => onCancel(job.id)}>{t("取消")}</button> : <button className="job-action delete-record" aria-label={t("删除") + t(jobLabels[job.type] || job.type) + t("记录")} title={t("删除这条任务记录和日志")} disabled={deleting} onClick={() => onDelete([job.id])}><Trash2 size={15}/></button>}</div>
    {expanded === job.id && <pre className="job-output">{[job.logs.map(log => log.message).join('\n'), job.error, job.result && JSON.stringify(job.result, null, 2)].filter(Boolean).join('\n') || t("此任务没有输出日志。")}</pre>}
  </div>)}</div>;
}

export function JobHistory({ title, jobs, onCancel, onDelete, deleting, toolbar, onReveal }) {
  const completed = jobs.filter(job => job.status !== 'running');
  return <section className="panel job-history" aria-label={title}>
    <div className="section-heading"><h2>{title}<span>{jobs.length}</span></h2><button className="text-button clear-records" disabled={deleting || !completed.length} onClick={() => onDelete(completed.map(job => job.id))}><Trash2 size={14}/>{t("清空已结束记录")}</button></div>
    {toolbar && <div className="job-toolbar">{toolbar}</div>}
    <JobList jobs={jobs} onCancel={onCancel} onDelete={onDelete} deleting={deleting} onReveal={onReveal}/>
  </section>;
}
