import React, { useEffect, useRef, useState } from 'react';
import { CloudUpload, ExternalLink, RefreshCw, FolderOpen, CheckCircle2, AlertCircle, LogOut } from 'lucide-react';
import { t, getLocale } from './i18n.jsx';
import {OfficialRecords} from './platform-records.jsx';
import {OfficialAgentId} from './platform-agent-id.jsx';

const cloudStatus=agent=>agent.underReview?t('审核中'):agent.displayStatus==='up'?t('已上架'):agent.displayStatus==='draft'?t('草稿'):agent.displayStatus||'—';

export function PlatformWorkspace({api,project,projects,onSelect,ready,working,startJob,notify,children,progress,history}){
  const [tab,setTab]=useState('upload');
  const [status,setStatus]=useState(null),[agents,setAgents]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[fetchedAt,setFetchedAt]=useState(null);
  const [bindingOpen,setBindingOpen]=useState(false),[bindingChoice,setBindingChoice]=useState(''),[bindingBusy,setBindingBusy]=useState(false);
  const [description,setDescription]=useState(''),[version,setVersion]=useState(''),[category,setCategory]=useState(''),[prologue,setPrologue]=useState(''),[versionLog,setVersionLog]=useState(''),[files,setFiles]=useState('');
  const [confirming,setConfirming]=useState(false),[loggingOut,setLoggingOut]=useState(false),request=useRef(0);
  const binding=status?.binding,agent=agents.find(item=>item.agentId===binding?.agentId);
  const upload=status?.uploads.find(item=>item.stage==='verified'&&item.agentId===binding?.agentId);
  const draft=status?.reviews.find(item=>item.agentId===binding?.agentId&&['ready','awaiting-user','submitted','unknown','submitting'].includes(item.stage));
  const staleUpload=upload&&(upload.sourceRevision!==project?.revision||upload.toolchainId!==project?.toolchainId||upload.sha256!==project?.lastBuild?.sha256);
  const staleDraft=draft&&(draft.sourceRevision!==project?.revision||draft.toolchainId!==project?.toolchainId||draft.sha256!==project?.lastBuild?.sha256);
  const uploading=working||loggingOut||bindingBusy||status?.uploads.some(item=>item.stage==='dispatching');
  async function refresh(reconcile=false){
    const current=++request.current;setLoading(true);setError('');
    try{
      const next=await api.call('aiui_platform_status',{projectId:project?.id,reconcile});
      const list=next.loggedIn?(await api.call('aiui_platform_agents')).agents:[];
      if(current!==request.current)return;
      setStatus(next);setAgents(list);setFetchedAt(next.loggedIn?new Date():null);
    }catch(e){if(current===request.current)setError(e.message);}
    finally{if(current===request.current)setLoading(false);}
  }
  useEffect(()=>{
    let live=true;setStatus(null);setAgents([]);setBindingOpen(false);setBindingChoice('');setFiles('');setVersionLog('');refresh();
    const timer=setInterval(()=>{const current=request.current;api.call('aiui_platform_status',{projectId:project?.id}).then(value=>{if(live&&current===request.current){setStatus(value);if(!value.loggedIn)setAgents([]);}}).catch(()=>{});},2500);
    const unsubscribe=api.onPlatformSession?.(()=>refresh());
    return()=>{live=false;request.current++;clearInterval(timer);unsubscribe?.();};
  },[project?.id]);
  useEffect(()=>{if(status?.loggedIn)refresh();},[status?.loggedIn]);
  useEffect(()=>{
    setDescription(agent?.description||'');setPrologue(agent?.prologue||'');setCategory(agent?.category||'');setFiles('');setVersionLog('');
    const parts=(agent?.nativeVersion||'1.0.0').split('.').map(Number);setVersion(`${parts[0]}.${parts[1]}.${parts[2]+1}`);
  },[project?.id,agent?.agentId,status?.loggedIn]);
  async function action(work){try{await work();await refresh();}catch(e){setError(e.message);notify(e.message,true);}}
  async function copyAgentId(value){try{await api.copy(value);notify(t('官网 Agent ID 已复制'));}catch(e){notify(e.message,true);}}
  async function logout(){
    setLoggingOut(true);request.current++;
    await action(async()=>{await api.logoutPlatform();setAgents([]);setStatus(null);setBindingOpen(false);setBindingChoice('');notify(t('已退出官方账号'));});
    setLoggingOut(false);
  }
  async function bind(){
    setBindingBusy(true);
    await action(async()=>{await api.call('ui_platform_bind',{projectId:project.id,agentId:bindingChoice});setBindingOpen(false);notify(t('官方智能体绑定已保存'));});
    setBindingBusy(false);
  }
  async function confirm(){
    if(!draft||!project)return;setConfirming(true);
    await action(async()=>{
      if(draft.stage==='ready')await api.call('aiui_platform_review_request',{projectId:project.id,draftId:draft.id});
      if(!api.confirmReview)throw new Error(t('请在桌面工坊确认提审'));
      const result=await api.confirmReview({projectId:project.id,draftId:draft.id});if(!result.cancelled)notify(t('提审任务已开始，请查看任务记录'));
    });setConfirming(false);
  }
  return <>
    <div className="platform-tabs" role="tablist" aria-label={t('上传与官方记录')}>
      <button role="tab" id="platform-upload-tab" aria-controls="platform-upload-panel" aria-selected={tab==='upload'} onClick={()=>setTab('upload')}>{t('打包与上传')}</button>
      <button role="tab" id="platform-official-tab" aria-controls="platform-official-panel" aria-selected={tab==='official'} onClick={()=>setTab('official')}>{t('官网应用')}</button>
    </div>
    <div className="button-row platform-account-controls"><button className="button platform-login-button" disabled={loggingOut} onClick={()=>action(()=>api.openStudio())}><ExternalLink size={16}/>{status?.loggedIn?t('打开官方平台'):t('登录官方平台')}</button><button className="button platform-refresh-button" disabled={loading||loggingOut} onClick={()=>refresh(true)}><RefreshCw size={16}/>{t('刷新登录与云端结果')}</button>{api.logoutPlatform&&<button className="button platform-logout-button" disabled={loggingOut} onClick={logout}><LogOut size={16}/>{t('退出官方账号')}</button>}<span className={'pill '+(status?.loggedIn?'success':'')}>{status?.loggedIn?t('官方账号已连接'):t('等待官方登录')}</span></div>
    {api.kind!=='desktop'&&<p className="publish-version-note">{t('Web 和 MCP 使用桌面工坊的官方登录，请保持桌面客户端运行。')}</p>}
    {error&&<p className="platform-error" role="alert"><AlertCircle size={15}/>{error}</p>}
    {tab==='upload'&&<div role="tabpanel" id="platform-upload-panel" aria-labelledby="platform-upload-tab">
    <section className="panel publish-selection" aria-label={t('当前应用与官方账号')}>
      <div className="platform-application">
        <label className="field">{t('选择应用')}<select aria-label={t('选择应用')} disabled={working||loggingOut||bindingBusy} value={project?.id||''} onChange={event=>onSelect(event.target.value)}>{!project&&<option value="">{t('先导入一个项目')}</option>}{projects.map(item=><option key={item.id} value={item.id}>{item.name} · {item.version}</option>)}</select></label>
        <div className="platform-binding"><strong>{t('共用官方目标')}</strong><span>{binding?.agentName||t('尚未绑定官方智能体')}</span>{binding&&<OfficialAgentId agentId={binding.agentId} onCopy={copyAgentId}/>} {status?.loggedIn&&project&&<button className="text-button" disabled={uploading} onClick={()=>{setBindingChoice(binding?.agentId||'');setBindingOpen(!bindingOpen);}}>{t('设置官方绑定')}</button>}</div>
      </div>
      <p className="publish-version-note">{t('本地构建、上传和提审共用所选应用及官方绑定，不能在各板块另选目标。')}</p>
      {bindingOpen&&<div className="platform-binding-setup"><label className="field">{t('绑定官方智能体')}<select aria-label={t('绑定官方智能体')} value={bindingChoice} disabled={bindingBusy} onChange={event=>setBindingChoice(event.target.value)}><option value="">{t('请选择目标，核对名称和 Agent ID')}</option>{agents.map(item=><option key={item.agentId} value={item.agentId}>{item.agentName} · {item.agentId}</option>)}</select></label><p className="publish-version-note">{t('绑定会保存到当前账号与本地应用。更改绑定后，原目标的提审确认失效。')}</p><button className="button" disabled={!bindingChoice||bindingBusy} onClick={bind}>{t('保存官方绑定')}</button></div>}
    </section>
    {progress}
    <div className="publish-workflow">{children}<section className="panel publish-official" aria-label={t('官方上传与提审引导')}>
      <div className="publish-upload-step">
        <div className="publish-step-heading"><span className="publish-step-number">2</span><h2>{t('上传云端草稿')}</h2><span className="pill">{t('在工坊完成')}</span></div>
        <p className="publish-version-note">{t('登录一次，AI 即可通过 MCP 上传 AIX 和提审材料。上传后核对云端包，再由用户确认提审。')}</p>
        {agent&&<div className="platform-target"><strong>{agent.agentName}</strong><OfficialAgentId agentId={agent.agentId} onCopy={copyAgentId}/><span>{cloudStatus(agent)}</span></div>}
        {status?.loggedIn&&!agent&&<p className="platform-error">{t('请先在页面顶部绑定所选应用的官方智能体。')}</p>}
        {agent&&<div className="platform-form">
          <div className="platform-two-fields"><label className="field">{t('云端草稿版本')}<input aria-label={t('云端草稿版本')} value={version} onChange={e=>setVersion(e.target.value)}/></label><label className="field">{t('应用分类')}<input value={category} onChange={e=>setCategory(e.target.value)}/></label></div>
          <label className="field">{t('功能介绍')}<textarea maxLength={500} value={description} onChange={e=>setDescription(e.target.value)}/></label>
          <button className="button primary" disabled={!project||!ready||uploading||!version||!description||!category} onClick={()=>startJob('aiui_platform_upload',{projectId:project.id,agentId:binding.agentId,version,description,category,waitMs:0})}><CloudUpload size={15}/>{t('上传为草稿')}</button>
        </div>}
        {upload&&<div className={'publish-build-status '+(staleUpload?'attention':'ready')} role="status"><CheckCircle2 size={18}/><div><strong>{t('云端 AIX 已核对')} · {upload.agentName} · {upload.version}</strong><p>{t('本地版本')} {upload.localVersion} · SHA256 {upload.sha256.slice(0,12)}</p>{staleUpload&&<p>{t('源码或构建已变化，请重新上传并准备提审草稿。')}</p>}</div></div>}
        {status?.uploads.filter(item=>item.stage==='unknown'&&item.agentId===binding?.agentId).map(item=><div key={item.id}><p className="platform-error">{t('上传结果待确认，请刷新核对；不会自动重传。')}</p>{item.sha256===project?.lastBuild?.sha256&&<button className="button" disabled={uploading} onClick={()=>startJob('aiui_platform_upload',{projectId:project.id,agentId:binding.agentId,resumeUploadId:item.id,waitMs:0})}>{t('恢复这次上传')}</button>}</div>)}
      </div>
      <div className="publish-review-step">
        <div className="publish-step-heading"><span className="publish-step-number">3</span><h2>{t('提审草稿与用户确认')}</h2><span className="pill">{t('确认后提交')}</span></div>
        <p className="publish-version-note">{t('AI 准备介绍、开场白、更新日志、图标和预览素材，工坊上传并保存草稿。MCP 请求提审后，用户在这里核对并确认。')}</p>
        {upload&&<details className="platform-form"><summary>{t('填写或更新提审材料')}</summary>
          <label className="field">{t('功能介绍')}<textarea maxLength={500} value={description} onChange={e=>setDescription(e.target.value)}/></label>
          <label className="field">{t('开场白')}<textarea maxLength={300} value={prologue} onChange={e=>setPrologue(e.target.value)}/></label>
          <label className="field">{t('更新日志')}<textarea maxLength={1000} value={versionLog} onChange={e=>setVersionLog(e.target.value)}/></label>
          <label className="field">{t('预览素材路径，每行一个；留空沿用云端素材')}<textarea value={files} onChange={e=>setFiles(e.target.value)}/></label>
          <div className="button-row"><button className="button" onClick={()=>action(async()=>setFiles((await api.chooseFiles('files')).join('\n')))}><FolderOpen size={14}/>{t('选择预览素材')}</button><button className="button" disabled={uploading||!description||!prologue||versionLog.trim().length<5} onClick={()=>startJob('aiui_platform_review_prepare',{projectId:project.id,description,prologue,versionLog,...files.trim()?{previewFiles:files.split('\n').map(s=>s.trim()).filter(Boolean)}:{},waitMs:0})}>{t('上传材料并保存提审草稿')}</button></div>
        </details>}
        {draft&&<div className="platform-review-card"><strong>{draft.agentName} · {draft.version}</strong><code>{draft.agentId}</code>
          <dl><dt>{t('功能介绍')}</dt><dd>{draft.content.description}</dd><dt>{t('开场白')}</dt><dd>{draft.content.prologue}</dd><dt>{t('更新日志')}</dt><dd>{draft.content.versionLog}</dd><dt>{t('权限')}</dt><dd>{draft.content.permissions||t('无')}</dd></dl>
          <div className="platform-previews">{draft.content.previewMaterials?.map((media,index)=>media.type==='video'?<video key={media.url} src={media.url} controls aria-label={t('预览素材 {0}',{0:index+1})}/>:<img key={media.url} src={media.url} alt={t('预览素材 {0}',{0:index+1})}/>)}</div>
          <p className="publish-version-note">SHA256 {draft.sha256}</p>
          {!!draft.localOnlyFields?.length&&<p className="publish-version-note">{t('更新日志和权限用途保存在工坊，确认提审时发送至官方平台。')}</p>}
          {staleDraft&&<p className="platform-error">{t('源码或构建已变化，请重新上传并准备提审草稿。')}</p>}
          {['ready','awaiting-user'].includes(draft.stage)?<button className="button primary" disabled={confirming||api.kind!=='desktop'||staleDraft||!status?.loggedIn} onClick={confirm}>{t('核对完成，确认提交审核')}</button>:<p role="status">{draft.stage==='submitted'?t('平台已接受提审请求'):draft.stage==='unknown'?t(draft.confirmedAt?'提审结果待确认，请在官方平台核对':'提审草稿保存结果待确认，请刷新核对'):t('正在提交审核…')}</p>}
        </div>}
        <p className="publish-platform-note"><AlertCircle size={15}/>{t('上传和保存材料不会提交审核。确认版本与材料可公开发布后再提审，审核及上架规则以官方平台为准。')}</p>
      </div>
    </section></div>
    {history}
    </div>}
    {tab==='official'&&<section className="panel platform-records" role="tabpanel" id="platform-official-panel" aria-labelledby="platform-official-tab" aria-label={t('官方已上传应用，只读')}>
      <div className="publish-step-heading"><h2>{t('官方已上传应用，只读')}</h2><button className="button" disabled={loading||loggingOut} onClick={()=>refresh()}><RefreshCw size={14}/>{t('刷新官方状态')}</button></div>
      <p className="publish-version-note">{t('直接读取官方的草稿、审核和已上架版本。删除只能在官网手动操作，工坊和 MCP 不提供云端删除功能。')}{fetchedAt&&<> · {fetchedAt.toLocaleTimeString(getLocale())}</>}</p>
      {!status?.loggedIn?<p className="publish-version-note">{t('等待官方登录')}</p>:<OfficialRecords agents={agents} boundAgentId={binding?.agentId} cloudStatus={cloudStatus} onCopy={copyAgentId}/>}
    </section>}
  </>;
}
