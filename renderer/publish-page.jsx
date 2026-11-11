import React from 'react';
import { AlertCircle, ArrowRight, BookOpen, CheckCircle2, CloudUpload, Copy, ExternalLink, FileCheck2, FolderOpen, LoaderCircle, Package } from 'lucide-react';
import { t, getLocale } from './i18n.jsx';
import { JobHistory } from './job-history.jsx';
import './publish-page.css';

const buildTypes = ['build', 'check', 'pack', 'platform-prepare'];
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

  return <>
    <div className="page-heading"><div><h1>{t('构建与上传')}</h1><p>{t('先在工坊生成本地 AIX，再到官方平台上传、填写资料并提交审核。')}</p></div></div>
    <ol className="publish-progress" aria-label={t('发布流程')}>
      <li><span className={ready ? 'complete' : ''}>{ready ? <CheckCircle2 size={18}/> : '1'}</span><div><strong>{t('本地检查与打包')}</strong><small>{t('在工坊完成')}</small></div><ArrowRight size={15}/></li>
      <li><span>2</span><div><strong>{t('上传到官方平台')}</strong><small>{t('在官方平台完成')}</small></div><ArrowRight size={15}/></li>
      <li><span>3</span><div><strong>{t('填写资料并提审')}</strong><small>{t('在官方平台完成')}</small></div></li>
    </ol>
    <div className="publish-workflow">
      <section className="panel publish-local" aria-label={t('本地检查与打包')}>
        <div className="publish-step-heading"><span className="publish-step-number">1</span><h2>{t('本地检查与打包')}</h2><span className="pill">{t('在工坊完成')}</span></div>
        {project ? <>
          <label className="publish-project-label" htmlFor="publish-project">{t('选择应用')}</label>
          <select id="publish-project" aria-label={t('选择构建项目')} value={project.id} onChange={event => onSelect(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · {item.version}</option>)}</select>
          <div className="button-row publish-build-actions">
            <button className="button primary" disabled={working || unavailable} onClick={() => startJob('aiui_project_build', { projectId: project.id, waitMs: 0 })}>{working ? <LoaderCircle size={15} className="spin"/> : <Package size={15}/>} {t('检查并打包 AIX')}</button>
            <button className="button" disabled={working || unavailable} onClick={() => startJob('aiui_project_check', { projectId: project.id })}><FileCheck2 size={15}/>{t('静态检查')}</button>
          </div>
          <p className="publish-local-note">{t('AIX 是应用包文件。生成后保存在本机，接着按第 2 步上传。')}</p>
          <div className={'publish-build-status ' + (ready ? 'ready' : stale || unavailable || checkFailed ? 'attention' : '')} role="status">
            <StatusIcon size={18} className={working ? 'spin' : ''}/><div><strong>{status}</strong><p>{working ? t('完成后可在下方找到 AIX 文件。') : unavailable ? t('请检查项目目录后重新导入。') : checkFailed ? t('请在构建记录中查看原因，修复后重新检查并打包。') : stale ? t('现有文件来自之前的代码或 SDK，重新打包后再上传。') : ready ? t('下一步：定位这份 AIX，并前往官方平台上传。') : t('点击“检查并打包 AIX”，通过检查后生成文件。')}</p></div>
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
      <section className="panel publish-official" aria-label={t('官方上传与提审引导')}>
        <div className="publish-upload-step">
          <div className="publish-step-heading"><span className="publish-step-number">2</span><h2>{t('上传到官方平台')}</h2><span className="pill">{t('在官方平台完成')}</span></div>
          <ol className="publish-instructions">
            <li>{t('登录 Rokid AIUI Studio。更新应用时打开已有智能体；首次发布时创建智能体。')}</li>
            <li>{t('使用平台的本地 AIX 导入或上传入口，选择第 1 步生成的 application.aix。')}</li>
            <li>{t('等待平台提示上传完成，并核对目标智能体、包内容和云端版本。')}</li>
          </ol>
          <p className="publish-version-note">{t('云端版本由官方平台生成，可能与本地应用版本不同。')}</p>
          <div className="button-row"><button className={'button ' + (ready ? 'primary' : '')} onClick={() => act(() => api.openStudio())}><CloudUpload size={15}/>{t('前往官方平台上传')}<ExternalLink size={13}/></button><button className="text-button" onClick={() => act(() => api.openOfficial(guideUrl))}><BookOpen size={14}/>{t('官方操作指南')}</button></div>
        </div>
        <div className="publish-review-step">
          <div className="publish-step-heading"><span className="publish-step-number">3</span><h2>{t('填写资料并提审')}</h2><span className="pill">{t('在官方平台完成')}</span></div>
          <ol className="publish-instructions">
            <li>{t('上传后在眼镜上验证核心流程，确认当前云端版本可以正常使用。')}</li>
            <li>{t('在“构建与提审”中完善名称、图标、分类、介绍、开场白、权限用途及图片和视频素材，并保存。')}</li>
            <li>{t('通过平台的“提交审核”入口送审，看到“审核中”后等待结果；后续审核与上架状态在平台查看。')}</li>
          </ol>
          <button className="text-button" onClick={() => act(() => api.openOfficial(reviewUrl))}><BookOpen size={14}/>{t('查看官方提审要求')}<ExternalLink size={12}/></button>
        </div>
        <p className="publish-platform-note"><AlertCircle size={15}/>{t('工坊显示本地构建结果。上传、提审和上架进度，请以官方平台页面为准。')}</p>
      </section>
    </div>
    <JobHistory title={t('构建与检查记录')} jobs={jobs.filter(job => buildTypes.includes(job.type))} onCancel={onCancel} onDelete={onDelete} deleting={deleting}/>
  </>;
}
