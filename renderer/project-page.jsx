import React, { useState } from 'react';
import { AlertCircle, ArrowRight, ChevronRight, Copy, Glasses, Monitor, Package, Play, RefreshCw } from 'lucide-react';
import { getLocale, t, translateMessage } from './i18n.jsx';
import { PackageSize } from './package-size.jsx';
import { IdeaComposer } from './idea-composer.jsx';
import { buildAiPrompt } from './ai-prompts.mjs';
import { connectionReady } from './ai-connection.mjs';
import { JobHistory } from './job-history.jsx';
import { StatusLabel } from './status-label.jsx';
import './ai-panels.css';
import './project-page.css';

export function ProjectPage({ state, project, jobs, api, notify, go, onCancel, onDelete, deleting }) {
  const [flowId, setFlowId] = useState('');
  const [working, setWorking] = useState(false);
  const flows = (state?.workflows || []).filter(item => item.projectId === project.id);
  const flow = flows.find(item => item.id === flowId) || flows[0];
  const evidence = flow?.stale ? {} : flow?.evidence || {};
  const deviceMode = flow?.verification?.mode === 'device';
  const waiting = flow?.state === 'waiting-user';
  const action = (waiting || ['needs-ai', 'interrupted'].includes(flow?.state)) ? flow?.nextAction : null;
  const previewVerified = !!evidence.preview || jobs.some(job => job.type === 'preview-test' && job.status === 'succeeded'
    && job.result?.passed && !job.result.stale && job.result.assertionsEvaluated > 0
    && job.result.revision === project.revision && job.result.toolchainId === project.toolchainId);
  const blocked = project.missing || !!project.error || !project.pages?.length;
  const lastInstall = project.lastDeploy;
  const currentInstall = lastInstall?.at && lastInstall.revision === project.revision;
  async function recover() {
    if (!connectionReady(state)) { go('connect'); return; }
    try {
      await api.copy(buildAiPrompt({ project, flow, intent: 'recover', features: state?.aiConnection?.features, locale: getLocale() }));
      notify(t('已复制，粘贴到你的 AI 工具即可'));
    } catch (error) { notify(error.message, true); }
  }
  async function resume() {
    setWorking(true);
    try { await api.call('aiui_workflow_continue', { workflowId: flow.id, waitMs: 0 }); }
    catch (error) { notify(error.message, true); }
    finally { setWorking(false); }
  }
  return <>
    {action && <section className={'project-attention ' + (waiting ? 'needs-user' : '')} role="status">
      <AlertCircle size={20}/><div><strong>{translateMessage(action.title)}</strong>
        {waiting ? <ol>{action.steps?.map(step => <li key={step}>{translateMessage(step)}</li>)}</ol> : <p>{t('问题已记录，AI 可以读取原因并继续修复。')}</p>}
      </div>
      <div className="project-attention-actions">
        {waiting ? <><button className="button primary" disabled={working} onClick={resume}><RefreshCw size={15}/>{t('重新检查并继续')}</button>
          {action.view && <button className="text-button" onClick={() => go(action.view)}>{t('查看操作指引')}<ArrowRight size={14}/></button>}</>
          : <button className="button" onClick={recover}><Copy size={15}/>{t('复制给 AI 继续')}</button>}
      </div>
    </section>}
    <div className="project-workspace">
      <section className="panel project-delivery">
        <div className="project-delivery-title"><h2>{t('调试与交付')}</h2>
          {flow?.state === 'running' && <StatusLabel tone="working">{t('AI 正在制作')}</StatusLabel>}
        </div>
        <div className="project-delivery-row">
          <Monitor size={20}/><div><h3>{t('电脑模拟')}</h3>
            <p>{t(deviceMode ? '此任务需要在眼镜上验证。' : '在电脑上试用当前项目，测试镜腿、头部动作和相机。')}</p></div>
          {previewVerified && !deviceMode && <StatusLabel tone="ready">{t('已验证交互')}</StatusLabel>}
        </div>
        <div className="project-delivery-row">
          <Package size={20}/><div><h3>{t('本地应用包')}</h3><PackageSize project={project}/></div>
        </div>
        <div className="project-delivery-row">
          <Glasses size={20}/><div><h3>{t('眼镜安装')}</h3>
            <p>{lastInstall?.at ? t('最近安装于 {0}', { 0: new Date(lastInstall.at).toLocaleString(getLocale()) }) : t('尚无安装记录')}</p></div>
          {lastInstall?.at && !currentInstall && <StatusLabel tone="action">{t('源码已更新')}</StatusLabel>}
        </div>
        <div className="project-delivery-actions">
          <button className="button primary" disabled={blocked} onClick={() => go('simulator')}><Play size={16}/>{t('运行项目')}</button>
          {blocked && <StatusLabel tone="error">{t(project.missing ? '项目文件缺失' : '源码需要检查')}</StatusLabel>}
        </div>
      </section>
      <IdeaComposer project={project} flow={flow} state={state} onConnect={() => go('connect')} api={api} notify={notify} compact/>
    </div>
    {flow && <details className="project-flow-details project-disclosure">
      <summary>{t('查看 AI 制作任务与证据')}<ChevronRight size={16}/></summary>
      {flows.length > 1 && <label className="field">{t('选择制作任务')}<select value={flow.id} onChange={event => setFlowId(event.target.value)}>
        {flows.map(item => <option value={item.id} key={item.id}>{item.request.slice(0, 45)} · {new Date(item.createdAt).toLocaleDateString(getLocale())}</option>)}
      </select></label>}
      <p>{flow.request}</p><p>{translateMessage(flow.message)}</p>
      <pre>{JSON.stringify({ workflowId: flow.id, state: flow.state, stage: flow.stage, revision: flow.revision, stale: flow.stale, previewReport: evidence.preview?.path, artifact: project.lastBuild?.path, deviceVerified: false, wornAcceptance: 'pending' }, null, 2)}</pre>
    </details>}
    <details className="project-records project-disclosure">
      <summary><span>{t('这个项目的任务记录')} <small>{jobs.length}</small></span><ChevronRight size={16}/></summary>
      <JobHistory title={t('项目任务记录')} jobs={jobs} onCancel={onCancel} onDelete={onDelete} deleting={deleting}/>
    </details>
  </>;
}
