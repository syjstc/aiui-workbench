import React from 'react';
import { AlertCircle, AlertTriangle, ArrowRight, BookOpen, CheckCircle2, CloudUpload, Copy, ExternalLink, FileCheck2, FolderOpen, LoaderCircle, Package } from 'lucide-react';
import { t, getLocale } from './i18n.jsx';
import { JobHistory } from './job-history.jsx';
import './publish-page.css';
import { PlatformWorkspace } from './platform-panel.jsx';

const buildTypes = ['build', 'check', 'pack', 'platform-prepare','platform-upload','platform-review-prepare','platform-review-submit'];
const size = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
const short = value => value ? value.slice(0, 8) : '—';
const guideUrl = 'https://js.rokid.com/AIUI/guide/quickstart/quickstart?version=latest';
const reviewUrl = 'https://github.com/yodaos-project/AIUI/blob/main/documentation/0-guide/bundle/publish.md';

export function PublishPage({ api, projects, project, onSelect, onImport, jobs, busy, startJob, onCancel, onDelete, deleting, notify }) {
  const artifact = project?.lastBuild;
  const stale = !!artifact && (artifact.revision !== project.revision || artifact.toolchainId !== project.toolchainId);
  const working = !!project && (['aiui_project_build', 'aiui_project_check'].includes(busy) || jobs.some(job => job.projectId === project.id && job.status === 'running' && [...buildTypes, 'deploy'].includes(job.type)));
  const unavailable = !!project && (project.missing || !!project.error);
  const checkFailed = project?.lastCheck?.revision === project?.revision && project?.lastCheck?.toolchainId === project?.toolchainId && project?.lastCheck?.passed === false;
  const ready = !!artifact && !stale && !working && !unavailable && !checkFailed;
  const status = working ? t('正在检查或打包…') : unavailable ? t('项目源码不可用') : checkFailed ? t('检查未通过') : stale ? t('代码或 SDK 已变化，请重新打包') : artifact ? t('本地包已生成') : t('等待本地打包');
  const StatusIcon = working ? LoaderCircle : ready ? CheckCircle2 : artifact || unavailable || checkFailed ? AlertCircle : Package;
  async function act(work, message) {
    try { await work(); if (message) notify(message); }
    catch (error) { notify(error.message, true); }
  }
  const progress=<ol className="publish-progress" aria-label={t('发布流程')}>
      <li><span className={ready ? 'complete' : ''}>{ready ? <CheckCircle2 size={18}/> : '1'}</span><div><strong>{t('本地检查与打包')}</strong><small>{t('在工坊完成')}</small></div><ArrowRight size={15}/></li>
      <li><span>2</span><div><strong>{t('上传云端草稿')}</strong><small>{t('在工坊完成')}</small></div><ArrowRight size={15}/></li>
      <li><span>3</span><div><strong>{t('用户确认提审')}</strong><small>{t('在工坊完成')}</small></div></li>
    </ol>;
  const history=<><p className="publish-version-note">{t('以下为本机任务日志，清理日志不会删除官网应用。')}</p><JobHistory title={t('本机构建与上传记录')} jobs={jobs.filter(job => buildTypes.includes(job.type))} onCancel={onCancel} onDelete={onDelete} deleting={deleting}/></>;
  return <>
    <div className="page-heading"><div><h1>{t('构建与上传')}</h1><p>{t('在工坊检查、打包并上传草稿，准备提审材料，用户确认后提交审核。')}</p></div></div>
    <aside className="platform-warning" role="note" aria-label={t('官方平台对接仍为实验功能')}><AlertTriangle size={20}/><div><strong>{t('官方平台对接仍为实验功能')}</strong><p>{t('此功能依赖官方 Studio 当前接口，可能随平台更新失效。上传、提审后请核对官网结果；结果不明时请勿重复操作。提审需本人确认，审核通过后的上架规则以官网为准。')}</p></div></aside>
    <PlatformWorkspace api={api} project={project} projects={projects} onSelect={onSelect} ready={ready} working={working} startJob={startJob} notify={notify} progress={progress} history={history}>
      <section className="panel publish-local" aria-label={t('本地检查与打包')}>
        <div className="publish-step-heading"><span className="publish-step-number">1</span><h2>{t('本地检查与打包')}</h2><span className="pill">{t('在工坊完成')}</span></div>
        {project ? <>
          <div className="button-row publish-build-actions">
            <button className="button primary" disabled={working || unavailable} onClick={() => startJob('aiui_project_build', { projectId: project.id, waitMs: 0 })}>{working ? <LoaderCircle size={15} className="spin"/> : <Package size={15}/>} {t('检查并打包 AIX')}</button>
            <button className="button" disabled={working || unavailable} onClick={() => startJob('aiui_project_check', { projectId: project.id })}><FileCheck2 size={15}/>{t('静态检查')}</button>
          </div>
          <p className="publish-local-note">{t('AIX 是应用包文件。生成后保存在本机，接着按第 2 步上传。')}</p>
          <div className={'publish-build-status ' + (ready ? 'ready' : stale || unavailable || checkFailed ? 'attention' : '')} role="status">
            <StatusIcon size={18} className={working ? 'spin' : ''}/><div><strong>{status}</strong><p>{working ? t('完成后可在下方找到 AIX 文件。') : unavailable ? t('请检查项目目录后重新导入。') : checkFailed ? t('请在构建记录中查看原因，修复后重新检查并打包。') : stale ? t('现有文件来自之前的代码或 SDK，重新打包后再上传。') : ready ? t('下一步：上传为所选应用的云端草稿。') : t('点击“检查并打包 AIX”，通过检查后生成文件。')}</p></div>
          </div>
          {artifact && <div className="publish-artifact">
            <div className="publish-artifact-heading"><Package size={19}/><div><strong>application.aix</strong><small>{size(artifact.bytes)} · {stale ? t('需要重新打包') : t('保存在本机')}</small></div></div>
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
        </> : <div className="publish-empty"><Package size={28}/><h3>{t('先导入一个项目')}</h3><p>{t('选择已有应用后，即可检查并生成上传用的 AIX 文件。')}</p><button className="button primary" onClick={onImport}><FolderOpen size={15}/>{t('导入项目')}</button></div>}
      </section>
    </PlatformWorkspace>
  </>;
}
