import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, ClipboardCheck, CloudUpload, ExternalLink, FileText, FolderOpen, Images, Link2, LogOut, RefreshCw, X } from 'lucide-react';
import { t, getLocale, translateMessage } from './i18n.jsx';
import {platformCategories} from '../core/platform-categories.mjs';
import {OfficialRecords, permissionPurposes} from './platform-records.jsx';
import {OfficialAgentId} from './platform-agent-id.jsx';
import {StatusLabel} from './status-label.jsx';

const cloudStatus=agent=>agent.underReview?t('审核中'):agent.displayStatus==='up'?t('已上架'):agent.displayStatus==='draft'?t('草稿'):agent.displayStatus||'—';
const platformMessage=error=>translateMessage(String(error?.message||error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
const materialPaths=value=>value.split('\n').map(line=>line.trim()).filter(Boolean);

function PlatformStep({title, icon:Icon, indicator, children}) {
  return <section className="panel platform-step">
    <header className="platform-step-header">
      <span className="platform-step-icon"><Icon size={19} aria-hidden="true"/></span>
      <h2>{t(title)}</h2>
      {indicator&&<span className="platform-step-state" role="status"><StatusLabel tone={indicator[0]}>{t(indicator[1])}</StatusLabel></span>}
    </header>
    {children}
  </section>;
}

function MaterialText({label, value, onChange, limit}) {
  return <label className="platform-field">
    <span>{t(label)}<small aria-hidden="true">{value.length} / {limit}</small></span>
    <textarea aria-label={t(label)} maxLength={limit} value={value} onChange={event=>onChange(event.target.value)}/>
  </label>;
}

function CategoryField({value,onChange}) {
  return <label className="platform-field">
    <span>{t('应用分类')}</span>
    <select aria-label={t('应用分类')} value={value} onChange={event=>onChange(event.target.value)}>
      <option value="">{t('选择分类')}</option>
      {value&&!Object.hasOwn(platformCategories,value)&&<option value={value}>{value}</option>}
      {Object.entries(platformCategories).map(([key,label])=><option key={key} value={key}>{t(label)}</option>)}
    </select>
  </label>;
}

export function PlatformWorkspace({api,project,ready,working,jobs,startJob,notify,active}){
  const [tab,setTab]=useState('upload');
  const [status,setStatus]=useState(null),[agents,setAgents]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[fetchedAt,setFetchedAt]=useState(null);
  const [checking,setChecking]=useState(true),[checkFailed,setCheckFailed]=useState(false);
  const [bindingOpen,setBindingOpen]=useState(false),[bindingChoice,setBindingChoice]=useState(''),[bindingBusy,setBindingBusy]=useState(false);
  const [creating,setCreating]=useState(false),[newName,setNewName]=useState(project.name),[newCategory,setNewCategory]=useState(''),[newDescription,setNewDescription]=useState(project.description||'');
  const [description,setDescription]=useState(''),[version,setVersion]=useState(''),[category,setCategory]=useState(''),[prologue,setPrologue]=useState(''),[versionLog,setVersionLog]=useState(''),[files,setFiles]=useState('');
  const [permissionEdits,setPermissionEdits]=useState({});
  const [materialsOpen,setMaterialsOpen]=useState(false);
  const [confirming,setConfirming]=useState(false),[loggingOut,setLoggingOut]=useState(false),request=useRef(0),pending=useRef(null);
  const hasAccount=!!status?.loggedIn&&!checkFailed&&!loggingOut;
  const loggedIn=hasAccount&&!checking;
  const binding=status?.binding,agent=agents.find(item=>item.agentId===binding?.agentId);
  const upload=status?.uploads?.find(item=>item.stage==='verified'&&item.agentId===binding?.agentId);
  const draft=status?.reviews?.find(item=>item.agentId===binding?.agentId&&['ready','awaiting-user','submitted','unknown','submitting'].includes(item.stage));
  const staleUpload=upload&&(upload.sourceRevision!==project?.revision||upload.toolchainId!==project?.toolchainId||upload.sha256!==project?.lastBuild?.sha256);
  const staleDraft=draft&&(draft.sourceRevision!==project?.revision||draft.toolchainId!==project?.toolchainId||draft.sha256!==project?.lastBuild?.sha256);
  const running=type=>jobs.some(job=>job.type===type&&job.status==='running');
  const cloudUploading=running('platform-upload')||status?.uploads?.some(item=>item.stage==='dispatching');
  const savingMaterials=running('platform-review-prepare');
  const uploading=working||!loggedIn||bindingBusy||cloudUploading||savingMaterials;
  const readStatus=(reconcile=false)=>api.call('aiui_platform_status',{projectId:project.id,reconcile});
  function applyStatus(next){
    setStatus(next);
    if(next.loggedIn)return;
    setAgents([]);
    setFetchedAt(null);
    setCheckFailed(false);
    setBindingOpen(false);
    setCreating(false);
  }
  async function refresh({reconcile=false,checkSession=false}={}){
    const current=++request.current;
    const isCurrent=()=>current===request.current;
    pending.current=current;
    setLoading(true);
    setError('');
    if(checkSession)setChecking(true);
    try{
      let next=await readStatus();
      if(!isCurrent())return;
      if(next.loggedIn){
        const list=await api.call('aiui_platform_agents');
        if(!isCurrent())return;
        if(list.loggedIn===false)next=await readStatus();
        else if(reconcile){
          try{next=await readStatus(true);}
          catch(error){
            next=await readStatus();
            if(isCurrent()&&next.loggedIn)setError(platformMessage(error));
          }
        }
        if(!isCurrent())return;
        if(next.loggedIn){setAgents(list.agents);setFetchedAt(new Date());}
      }
      applyStatus(next);
      setCheckFailed(false);
    }catch{
      if(!isCurrent())return;
      // A 401/403 from the official list invalidates the shared session.
      // A failed network check, on the other hand, leaves sign-in unknown.
      const latest=await readStatus().catch(()=>null);
      if(!isCurrent())return;
      if(latest?.loggedIn===false)applyStatus(latest);
      else setCheckFailed(true);
    }finally{
      if(isCurrent()){pending.current=null;setLoading(false);setChecking(false);}
    }
  }
  useLayoutEffect(()=>{
    if(!active)return;
    refresh({checkSession:true});
    const unsubscribe=api.onPlatformSession?.(()=>refresh({checkSession:true}));
    return()=>{request.current++;pending.current=null;unsubscribe?.();};
  },[active,project.id]);
  useEffect(()=>{
    if(!active||loggingOut)return;
    let live=true;
    const timer=setInterval(async()=>{
      if(pending.current!==null)return;
      const current=request.current;
      const next=await readStatus().catch(()=>null);
      if(!next||!live||current!==request.current)return;
      if(next.loggedIn&&!status?.loggedIn){if(!checkFailed)refresh({checkSession:true});return;}
      applyStatus(next);
    },2500);
    return()=>{live=false;clearInterval(timer);};
  },[active,project.id,status?.loggedIn,checkFailed,loggingOut]);
  useEffect(()=>{
    setDescription(agent?.description||'');setPrologue(agent?.prologue||'');setCategory(agent?.category||'');setFiles('');setVersionLog('');setPermissionEdits({});
    const parts=(agent?.nativeVersion||'1.0.0').split('.').map(Number);setVersion(`${parts[0]}.${parts[1]}.${parts[2]+1}`);
  },[project.id,agent?.agentId]);
  async function action(work,read=true){try{await work();if(read)await refresh();}catch(e){setError(platformMessage(e));notify(e.message,true);}}
  async function copyAgentId(value){await action(async()=>{await api.copy(value);notify(t('官网 Agent ID 已复制'));},false);}
  async function logout(){
    setLoggingOut(true);request.current++;
    setError('');
    try{
      const next=await api.logoutPlatform();
      request.current++;pending.current=null;
      applyStatus(next);
      setBindingChoice('');
      notify(t('已退出官方账号'));
    }catch(error){await refresh({checkSession:true});setError(platformMessage(error));}
    finally{setLoggingOut(false);setLoading(false);setChecking(false);}
  }
  async function bind(){
    setBindingBusy(true);
    await action(async()=>{await api.call('ui_platform_bind',{projectId:project.id,agentId:bindingChoice});setBindingOpen(false);notify(t('官方智能体绑定已保存'));});
    setBindingBusy(false);
  }
  async function createAgent(){
    setBindingBusy(true);
    try{
      await api.call('aiui_platform_create',{projectId:project.id,agentName:newName,category:newCategory,description:newDescription,retryUnconfirmed:!!status?.pendingCreation});
      setCreating(false);setBindingOpen(false);
      notify(t('官方智能体绑定已保存'));
      await refresh();
    }catch(e){await refresh();setError(platformMessage(e));}
    finally{setBindingBusy(false);}
  }
  async function confirm(){
    if(!draft||!project)return;setConfirming(true);
    await action(async()=>{
      if(draft.stage==='ready')await api.call('aiui_platform_review_request',{projectId:project.id,draftId:draft.id});
      if(!api.confirmReview)throw new Error(t('请在桌面工坊确认提审'));
      const result=await api.confirmReview({projectId:project.id,draftId:draft.id});if(!result.cancelled)notify(t('提审任务已开始，请查看任务记录'));
    });setConfirming(false);
  }
  const accountStatus=checking?['working','正在检查登录状态…']:loggingOut?['working','正在退出官方账号…']:
    checkFailed?['error','无法确认登录状态']:loggedIn?['ready','官方账号已连接']:['idle','未登录官方平台'];
  const uploadStatus=cloudUploading?['working','正在上传草稿…']:staleUpload?['action','需要重新上传']:
    upload?['ready','云端 AIX 已核对']:loggedIn&&agent&&!ready?['idle','等待本地打包']:null;
  const materialsStatus=savingMaterials?['working','正在保存提审草稿…']:
    draft&&!staleDraft&&draft.stage!=='unknown'?['ready','提审草稿已保存']:null;
  const reviewStatus=draft&&(
    draft.stage==='submitted'?['ready','已提交审核']:draft.stage==='submitting'||confirming?['working','正在提交审核…']:
    draft.stage==='unknown'?['action','结果待确认']:staleDraft?['action','需要更新材料']:['action','待核对']);
  const previewFiles=materialPaths(files);
  const validFiles=!previewFiles.length||(previewFiles.length>=3&&previewFiles.length<=5
    &&previewFiles.every(file=>/\.(png|jpe?g|mp4)$/i.test(file))
    &&previewFiles.some(file=>/\.(png|jpe?g)$/i.test(file))&&previewFiles.some(file=>/\.mp4$/i.test(file)));
  const permissions=project.permissions||[];
  const remoteUsage=agent?permissionPurposes(agent):{};
  const permissionUsage=Object.fromEntries(permissions.map(name=>[
    name,Object.hasOwn(permissionEdits,name)?permissionEdits[name]:(typeof remoteUsage[name]==='string'?remoteUsage[name]:''),
  ]));
  const validVersion=/^\d+\.\d+\.\d+$/.test(version.trim());
  function uploadDraft(event){
    event.preventDefault();
    startJob('aiui_platform_upload',{projectId:project.id,agentId:binding.agentId,version:version.trim(),description:description.trim(),category,waitMs:0});
  }
  function saveMaterials(event){
    event.preventDefault();
    startJob('aiui_platform_review_prepare',{
      projectId:project.id,description:description.trim(),prologue:prologue.trim(),versionLog:versionLog.trim(),
      ...(previewFiles.length?{previewFiles}:{}),permissionUsage,waitMs:0,
    });
  }
  async function chooseMaterials(){
    await action(async()=>{
      const chosen=await api.chooseFiles('files');
      if(chosen.length)setFiles(current=>Array.from(new Set([...materialPaths(current),...chosen])).join('\n'));
    },false);
  }
  return <>
    <div className="platform-tabs" role="tablist" aria-label={t('上传与官方记录')}>
      <button role="tab" id="platform-upload-tab" aria-controls="platform-upload-panel" aria-selected={tab==='upload'} onClick={()=>setTab('upload')}>{t('发布操作')}</button>
      <button role="tab" id="platform-official-tab" aria-controls="platform-official-panel" aria-selected={tab==='official'} onClick={()=>setTab('official')}>{t('官网应用')}</button>
    </div>
    <div className="platform-account-controls">
      <span role="status"><StatusLabel tone={accountStatus[0]}>{t(accountStatus[1])}</StatusLabel></span>
      {!checking&&!loggingOut&&<div className="button-row">
        <button className={'button '+(!loggedIn&&!checkFailed?'platform-login-button':'')} onClick={()=>action(()=>api.openStudio())}>
          <ExternalLink size={15}/>{t(loggedIn||checkFailed?'打开官方平台':'登录官方平台')}
        </button>
        {(loggedIn||checkFailed)&&<button className="button platform-refresh-button" disabled={loading} onClick={()=>refresh({reconcile:loggedIn,checkSession:checkFailed})}>
          <RefreshCw size={15} className={loading?'spin':undefined}/>{t(loggedIn?'刷新登录与云端结果':'重新检查')}
        </button>}
        {loggedIn&&api.logoutPlatform&&<button className="button platform-logout-button" onClick={logout}><LogOut size={15}/>{t('退出官方账号')}</button>}
      </div>}
    </div>
    {api.kind!=='desktop'&&!checking&&!hasAccount&&<p className="publish-version-note">{t('Web 和 MCP 使用桌面工坊的官方登录，请保持桌面客户端运行。')}</p>}
    {error&&<p className="platform-error" role="alert"><AlertCircle size={15}/>{error}</p>}
    {tab==='upload'&&<div role="tabpanel" id="platform-upload-panel" aria-labelledby="platform-upload-tab" aria-busy={checking||undefined} inert={checking||undefined}>
      {hasAccount&&<section className="panel platform-destination" aria-label={t('官方发布目标')}>
        <div className="platform-destination-heading">
          <span className="platform-step-icon"><Link2 size={19} aria-hidden="true"/></span>
          <div><h2>{t('官方发布目标')}</h2><p>{binding?.agentName||t('尚未绑定官方智能体')}</p></div>
          <div className="button-row">
            <button className="button" disabled={uploading} aria-expanded={bindingOpen} onClick={()=>{setBindingChoice(binding?.agentId||'');setBindingOpen(!bindingOpen);setCreating(false);}}>{t('设置官方绑定')}</button>
            {!binding&&<button className="button" disabled={uploading} aria-expanded={creating} onClick={()=>{setCreating(!creating);setBindingOpen(false);}}>{t('新建官方智能体')}</button>}
          </div>
        </div>
        {binding&&<OfficialAgentId agentId={binding.agentId} onCopy={copyAgentId}/>}
        {creating&&!binding&&<form className="platform-editor" onSubmit={event=>{event.preventDefault();createAgent();}}>
          <div className="platform-field-grid">
            <label className="platform-field"><span>{t('智能体名称')}</span><input required maxLength={50} value={newName} onChange={event=>setNewName(event.target.value)}/></label>
            <CategoryField value={newCategory} onChange={setNewCategory}/>
          </div>
          <MaterialText label="功能介绍" value={newDescription} limit={500} onChange={setNewDescription}/>
          {status?.pendingCreation&&<p className="platform-step-hint" role="status">{t('请先刷新官方列表。已出现的智能体可直接绑定，列表仍为空时再重试。')}</p>}
          <div className="platform-editor-actions"><button className="button primary" disabled={uploading||!newName.trim()||!newCategory||!newDescription.trim()}>{t(status?.pendingCreation?'核对后重试创建与关联':'创建并关联到当前应用')}</button></div>
        </form>}
        {bindingOpen&&<div className="platform-editor">
          <label className="platform-field"><span>{t('绑定官方智能体')}</span><select aria-label={t('绑定官方智能体')} value={bindingChoice} disabled={bindingBusy} onChange={event=>setBindingChoice(event.target.value)}><option value="">{t('请选择目标，核对名称和 Agent ID')}</option>{agents.map(item=><option key={item.agentId} value={item.agentId}>{item.agentName} · {item.agentId}</option>)}</select></label>
          <div className="platform-editor-actions"><button className="button primary" disabled={!bindingChoice||bindingBusy} onClick={bind}>{t('保存官方绑定')}</button></div>
        </div>}
      </section>}
      <div className="platform-workflow" aria-label={t('官方上传与提审引导')}>
        <PlatformStep icon={CloudUpload} title="上传云端草稿" indicator={hasAccount&&uploadStatus}>
          {!hasAccount||!agent?<p className="platform-step-hint">{t(hasAccount?'请先在页面顶部绑定所选应用的官方智能体。':'登录后即可选择发布目标并上传 AIX。')}</p>:<>
            {upload&&<div className="platform-receipt">
              <CheckCircle2 size={17} aria-hidden="true"/>
              <div><strong>{upload.agentName} · {upload.version}</strong><small>{t('本地版本')} {upload.localVersion} · SHA256 {upload.sha256.slice(0,12)}</small></div>
            </div>}
            {staleUpload&&<p className="platform-step-hint">{t('源码或构建已变化，请重新上传并准备提审草稿。')}</p>}
            <form className="platform-editor" onSubmit={uploadDraft}>
              <div className="platform-field-grid">
                <label className="platform-field"><span>{t('云端草稿版本')}</span><input aria-label={t('云端草稿版本')} placeholder="1.0.1" value={version} aria-invalid={!!version&&!validVersion||undefined} onChange={event=>setVersion(event.target.value)}/>
                  {version&&!validVersion&&<small>{t('版本格式示例 1.0.1')}</small>}
                </label>
                <CategoryField value={category} onChange={setCategory}/>
              </div>
              <MaterialText label="功能介绍" value={description} limit={500} onChange={setDescription}/>
              <div className="platform-editor-actions">
                {!ready&&!working&&<p className="platform-step-hint">{t('请先完成本地打包。')}</p>}
                <button className="button primary" disabled={!ready||uploading||!validVersion||!description.trim()||!category}>{t('上传为草稿')}</button>
              </div>
            </form>
            {status.uploads.filter(item=>item.stage==='unknown'&&item.agentId===binding.agentId).map(item=><div className="platform-recovery" key={item.id}>
              <p className="platform-error"><AlertCircle size={15}/>{t('上传结果待确认，请刷新核对；不会自动重传。')}</p>
              {item.sha256===project.lastBuild?.sha256&&<button className="button" disabled={uploading} onClick={()=>startJob('aiui_platform_upload',{projectId:project.id,agentId:binding.agentId,resumeUploadId:item.id,waitMs:0})}>{t('恢复这次上传')}</button>}
            </div>)}
          </>}
        </PlatformStep>
        <PlatformStep icon={FileText} title="准备提审材料" indicator={hasAccount&&materialsStatus}>
          {hasAccount&&upload&&!staleUpload?<details className="platform-materials" open={materialsOpen} onToggle={event=>setMaterialsOpen(event.currentTarget.open)}>
            <summary>{t('填写或更新提审材料')}<ChevronRight size={16} aria-hidden="true"/></summary>
            <form className="platform-editor" onSubmit={saveMaterials}>
              <div className="platform-field-grid">
                <MaterialText label="功能介绍" value={description} limit={500} onChange={setDescription}/>
                <MaterialText label="开场白" value={prologue} limit={300} onChange={setPrologue}/>
              </div>
              <MaterialText label="更新日志" value={versionLog} limit={1000} onChange={setVersionLog}/>
              {!!permissions.length&&<fieldset className="platform-permissions">
                <legend>{t('权限用途')}</legend>
                <div className="platform-field-grid">{permissions.map(name=><label className="platform-field" key={name}>
                  <span>{name}</span><input maxLength={500} value={permissionUsage[name]} onChange={event=>setPermissionEdits(current=>({...current,[name]:event.target.value}))}/>
                </label>)}</div>
              </fieldset>}
              <div className="platform-media-picker">
                <div className="platform-media-heading">
                  <Images size={20} aria-hidden="true"/>
                  <div><strong>{t('预览素材')}</strong><p>{t('留空时沿用云端素材。替换时选 3–5 个文件，含图片和 MP4。')}</p></div>
                  <button type="button" className="button" disabled={uploading} onClick={chooseMaterials}><FolderOpen size={14}/>{t('选择预览素材')}</button>
                </div>
                {!!previewFiles.length&&<ul className="platform-media-list">{previewFiles.map((file,index)=><li key={file+index}>
                  <span title={file}>{file.split(/[\\/]/).at(-1)}</span>
                  <button type="button" aria-label={t('移除素材 {0}',{0:file.split(/[\\/]/).at(-1)})} onClick={()=>setFiles(previewFiles.filter((_,item)=>item!==index).join('\n'))}><X size={14}/></button>
                </li>)}</ul>}
                {!validFiles&&<p className="platform-error">{t('请选择 3–5 个 PNG、JPG 或 MP4 文件，至少包含一张图片和一个视频。')}</p>}
                <details className="platform-path-entry"><summary>{t('手动输入素材路径')}</summary>
                  <label className="platform-field"><span>{t('预览素材路径，每行一个；留空沿用云端素材')}</span><textarea value={files} onChange={event=>setFiles(event.target.value)}/></label>
                </details>
              </div>
              <div className="platform-editor-actions"><button className="button primary" disabled={uploading||!description.trim()||!prologue.trim()||versionLog.trim().length<5||!validFiles||Object.values(permissionUsage).some(value=>!value.trim())}>{t('上传材料并保存提审草稿')}</button></div>
            </form>
          </details>:<p className="platform-step-hint">{t('云端草稿核对通过后，就可以准备提审材料。')}</p>}
        </PlatformStep>
        <PlatformStep icon={ClipboardCheck} title="核对并提审" indicator={hasAccount&&reviewStatus}>
          {hasAccount&&draft?<div className="platform-review">
            <div className="platform-review-identity"><strong>{draft.agentName}</strong><span className="pill">{draft.version}</span></div>
            <dl className="platform-review-summary">
              {[
                ['功能介绍',draft.content.description],['开场白',draft.content.prologue],
                ['更新日志',draft.content.versionLog],['权限',draft.content.permissions||t('无')],
              ].map(([label,value])=><div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}
              {Object.entries(permissionPurposes(draft.content)).map(([name,value])=><div key={name}><dt>{name}</dt><dd>{typeof value==='string'?value:JSON.stringify(value)}</dd></div>)}
            </dl>
            {!!draft.content.previewMaterials?.length&&<div className="platform-previews">
              {draft.content.previewMaterials.map((media,index)=>media.type==='video'
                ?<video key={media.url} src={media.url} controls preload="metadata" aria-label={t('预览素材 {0}',{0:index+1})}/>
                :<img key={media.url} src={media.url} alt={t('预览素材 {0}',{0:index+1})}/>)}
            </div>}
            <details className="publish-build-details"><summary>{t('核对详情')}</summary>
              <dl><div><dt>Agent ID</dt><dd><code>{draft.agentId}</code></dd></div><div><dt>SHA256</dt><dd className="publish-checksum"><code>{draft.sha256}</code></dd></div></dl>
            </details>
            {!!draft.localOnlyFields?.length&&<p className="platform-step-hint">{t('更新日志和权限用途保存在工坊，确认提审时发送至官方平台。')}</p>}
            {staleDraft&&<p className="platform-error">{t('源码或构建已变化，请重新上传并准备提审草稿。')}</p>}
            {draft.stage==='unknown'&&<p className="platform-error" role="status">{t(draft.confirmedAt?'提审结果待确认，请在官方平台核对':'提审草稿保存结果待确认，请刷新核对')}</p>}
            {['ready','awaiting-user'].includes(draft.stage)&&<div className="platform-editor-actions">
              <p className="platform-step-hint">{t(api.kind==='desktop'?'提审前请核对这次提交的版本和资料。':'请在桌面工坊确认提审')}</p>
              <button className="button primary" disabled={confirming||api.kind!=='desktop'||staleDraft} onClick={confirm}>{t('核对完成，确认提交审核')}</button>
            </div>}
          </div>:<p className="platform-step-hint">{t('保存提审草稿后，在这里核对版本和资料。')}</p>}
        </PlatformStep>
      </div>
    </div>}
    {tab==='official'&&<section className="panel platform-records" role="tabpanel" id="platform-official-panel" aria-labelledby="platform-official-tab" aria-label={t('官方已上传应用，只读')} aria-busy={checking||undefined} inert={checking||undefined}>
      <div className="publish-step-heading"><h2>{t('官方已上传应用，只读')}</h2>{loggedIn&&<button className="button" disabled={loading} onClick={()=>refresh()}><RefreshCw size={14}/>{t('刷新官方状态')}</button>}</div>
      <p className="publish-version-note">{t('查看当前项目的草稿、审核和已上架版本。')}{fetchedAt&&<> · {fetchedAt.toLocaleTimeString(getLocale())}</>}</p>
      {!hasAccount?<p className="publish-version-note">{t('登录后查看项目在官网的版本。')}</p>
        : !binding?<p className="publish-version-note">{t('先在「发布操作」中关联当前项目的官方智能体。')}</p>
        : <OfficialRecords agents={agents.filter(item=>item.agentId===binding.agentId)} boundAgentId={binding.agentId} cloudStatus={cloudStatus} onCopy={copyAgentId}/>}
    </section>}
  </>;
}
