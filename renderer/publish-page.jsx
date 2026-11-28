import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Copy, FileCheck2, FolderOpen, LoaderCircle, Package } from 'lucide-react';
import { t, getLocale } from './i18n.jsx';
import { JobHistory } from './job-history.jsx';
import { PackageSize } from './package-size.jsx';
import { StatusLabel } from './status-label.jsx';
import './publish-page.css';
import { PlatformWorkspace } from './platform-panel.jsx';

const buildTypes = ['build', 'check', 'pack', 'platform-prepare','platform-upload','platform-review-prepare','platform-review-submit'];
const short = value => value ? value.slice(0, 8) : '—';

export function PublishPage({ api, project, jobs, busy, startJob, onCancel, onDelete, deleting, notify, pendingReview, active = true }) {
  const [platformExpanded, setPlatformExpanded] = useState(false);
  const platform = useRef(null);
  useEffect(() => {
    if (pendingReview) {
      platform.current.open = true;
      setPlatformExpanded(true);
    }
  }, [pendingReview]);
  const artifact = project?.lastBuild;
  const stale = !!artifact && (artifact.revision !== project.revision || artifact.toolchainId !== project.toolchainId);
  const working = !!project && (['aiui_project_build', 'aiui_project_check'].includes(busy) || jobs.some(job => job.projectId === project.id && job.status === 'running' && [...buildTypes, 'deploy'].includes(job.type)));
  const unavailable = !!project && (project.missing || !!project.error);
  const checkFailed = project?.lastCheck?.revision === project?.revision && project?.lastCheck?.toolchainId === project?.toolchainId && project?.lastCheck?.passed === false;
  const ready = !!artifact && !stale && !working && !unavailable && !checkFailed;
  const status = working ? t('正在检查或打包…') : unavailable ? t('项目源码不可用') : checkFailed ? t('检查未通过') : stale ? t('代码或 SDK 已变化，请重新打包') : artifact ? t('本地包已生成') : t('等待本地打包');
  const tone = working ? 'working' : unavailable || checkFailed ? 'error' : stale ? 'action' : ready ? 'ready' : 'idle';
  async function act(work, message) {
    try { await work(); if (message) notify(message); }
    catch (error) { notify(error.message, true); }
  }
  return <>
    <section className="panel publish-local project-build" aria-labelledby="project-build-title">
      <div className="publish-step-heading"><Package size={20}/><h2 id="project-build-title">{t('本地检查与打包')}</h2><StatusLabel tone={tone}>{status}</StatusLabel></div>
      <div className="button-row publish-build-actions">
        <button className="button primary" disabled={working || unavailable} onClick={() => startJob('aiui_project_build', { projectId: project.id, waitMs: 0 })}>{working ? <LoaderCircle size={15} className="spin"/> : <Package size={15}/>} {t('检查并打包 AIX')}</button>
        <button className="button" disabled={working || unavailable} onClick={() => startJob('aiui_project_check', { projectId: project.id })}><FileCheck2 size={15}/>{t('静态检查')}</button>
      </div>
      <p className="publish-local-note">{t('生成的 AIX 保存在电脑。需要发布时，再上传到官方平台。')}</p>
      {artifact && <div className="publish-artifact">
        <div className="publish-artifact-heading"><Package size={19}/><div><strong>application.aix</strong><small><PackageSize project={project}/></small></div></div>
        <div className="button-row">
          <button className="button" onClick={() => act(() => api.reveal(artifact.path))}><FolderOpen size={15}/>{t('定位 AIX 文件')}</button>
          <button className="button" onClick={() => act(() => api.copy(artifact.path), t('AIX 文件路径已复制'))}><Copy size={14}/>{t('复制文件路径')}</button>
        </div>
      </div>}
      <details className="publish-build-details"><summary>{t('构建详情')}</summary><dl>
        <div><dt>{t('源代码指纹')}</dt><dd title={project.revision}><code>{short(project.revision)}</code></dd></div>
        <div><dt>{t('Ink 引擎版本要求')}</dt><dd><code>{project.engine}</code></dd></div>
        {artifact && <><div><dt>{t('打包时间')}</dt><dd>{new Date(artifact.at).toLocaleString(getLocale())}</dd></div><div><dt>{t('包对应的代码指纹')}</dt><dd title={artifact.revision}><code>{short(artifact.revision)}</code></dd></div><div><dt>SHA256</dt><dd><code className="publish-checksum">{artifact.sha256}</code></dd></div></>}
      </dl><p>{t('代码指纹用于区分源码内容，SHA256 用于核对包文件。')}</p></details>
    </section>
    <details className="project-disclosure publish-platform-disclosure" ref={platform} onToggle={event=>setPlatformExpanded(event.currentTarget.open)}>
      <summary>{t('上传与提审')}<ChevronRight size={16}/></summary>
      <aside className="platform-warning" role="note" aria-label={t('官方平台对接仍为实验功能')}><AlertTriangle size={19}/><div><strong>{t('官方平台对接仍为实验功能')}</strong><p>{t('此功能依赖官方 Studio 当前接口，可能随平台更新失效。上传、提审后请核对官网结果；结果不明时请勿重复操作。提审需本人确认，审核通过后的上架规则以官网为准。')}</p></div></aside>
      <PlatformWorkspace active={active&&platformExpanded} api={api} project={project} ready={ready} working={working} jobs={jobs} startJob={startJob} notify={notify}/>
    </details>
    <details className="project-disclosure">
      <summary>{t('本机构建与上传记录')}<ChevronRight size={16}/></summary>
      <JobHistory title={t('项目任务记录')} jobs={jobs.filter(job=>buildTypes.includes(job.type))} onCancel={onCancel} onDelete={onDelete} deleting={deleting}/>
    </details>
  </>;
}
