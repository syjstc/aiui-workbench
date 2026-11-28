import { t, getLocale, setLocale, useLocale, translateMessage } from './i18n.jsx';
import './themes.css';
import './theme.mjs';
import './web-bridge.mjs';
import {SettingsPage} from './settings-page.jsx';
import {WebDirectoryPicker} from './web-directory-picker.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SdkPage} from './sdk-page.jsx';
import {BeginnerGuide} from './beginner-guide.jsx';
import {KnowledgePage} from './knowledge-page.jsx';
import {DevicePanel} from './device-panel.jsx';
import {GlassesToolsPage} from './glasses-tools.jsx';
import {useDeviceDiscovery} from './use-device-discovery.js';
import {JobHistory} from './job-history.jsx';
import {LogsPage} from './logs-page.jsx';
import {AlertCircle, ArrowRight, ArrowUpRight, BookOpen, CheckCircle2, ChevronRight, CloudUpload, FolderOpen, Glasses, Globe2, HelpCircle, LayoutGrid, Link2, LoaderCircle, MessageSquare, Monitor, MoreHorizontal, Orbit, Package, PanelsTopLeft, Plug, Plus, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, X} from 'lucide-react';
import './style.css';
import './workspace.css';
import {Simulator} from './simulator.jsx';
import {ProjectIcon} from './project-icon.jsx';
import {PackageSize} from './package-size.jsx';
import {ProjectRemovalDialog} from './project-removal-dialog.jsx';
import {PublishPage} from './publish-page.jsx';
import {ProjectPage} from './project-page.jsx';
import {IdeaComposer} from './idea-composer.jsx';
import {ConnectPage} from './connect-page.jsx';
import {connectionReady} from './ai-connection.mjs';
import {UpdateNotice} from './update-notice.jsx';
import {FeedbackPage} from './feedback-page.jsx';
import {StatusLabel} from './status-label.jsx';
import appIcon from '../assets/branding/icon-64.png';

const api=window.workbench;
const reportUiError=(error,source)=>api.call('aiui_diagnostics_report',{source,message:String(error?.message||error),stack:error?.stack}).catch(()=>{});
window.addEventListener('error',e=>reportUiError(e.error||e.message,'renderer'));
window.addEventListener('unhandledrejection',e=>reportUiError(e.reason,'renderer-promise'));
const call=(tool,args={})=>api.call(tool,args);
const short=s=>s?s.slice(0,8):'—';
const projectViews=[
 ['project', LayoutGrid, '概览'], ['simulator', Monitor, '模拟器'],
 ['publish', CloudUpload, '构建与上传'], ['install', Glasses, '安装到眼镜'],
];
const workspaceTools=[
 ['connect', Plug, '连接 AI 工具'], ['devices', Glasses, '连接眼镜'], ['knowledge', BookOpen, '官方资料'],
 ['sdk', Package, 'SDK 更新'], ['logs', Terminal, '日志与记录'],
];
const workspaceHelp=[['guide', HelpCircle, '新手指南'], ['feedback', MessageSquare, '反馈与建议'], ['settings', Settings2, '设置']];
const isProjectView=view=>projectViews.some(([key])=>key===view);
const titleFor=view=>[...workspaceTools,...workspaceHelp].find(([key])=>key===view)?.[2] || (view==='glasses'?'眼镜工具':'我的项目');
function sdkStatus(sdk) {
 const id='workspace-sdk-status';
 if(sdk?.operation||sdk?.checking)return <StatusLabel id={id} tone="working">{t(sdk.operation?'处理中':'检查中')}</StatusLabel>;
 if(sdk?.updateAvailable)return <StatusLabel id={id} tone="action">{t('可更新')}</StatusLabel>;
 if(sdk?.error)return <StatusLabel id={id} tone="error">{t('检查失败')}</StatusLabel>;
 return sdk?.checkedAt?<StatusLabel id={id} tone="ready">{t('已是最新')}</StatusLabel>:<StatusLabel id={id}>{t('待检查')}</StatusLabel>;
}
function Pill({children,tone=''}){return <span className={'pill '+tone}>{children}</span>}
function Empty({icon:Icon,title,children}){return <div className="empty"><span className="empty-icon"><Icon size={30}/></span><h3>{title}</h3><p>{children}</p></div>}
function Button({children,icon:Icon,className='',busy,...props}){return <button className={'button '+className} {...props}>{busy?<LoaderCircle size={15} className="spin"/>:Icon&&<Icon size={15}/>} {children}</button>}
function App(){
 const locale=useLocale();
 useEffect(()=>{document.documentElement.lang=locale;document.title=t('AIUI 工坊');api.setLocale?.(locale).catch(()=>{});},[locale]);
 const [previewMuted,setPreviewMuted]=useState(()=>{try{return localStorage.getItem('aiui-preview-muted')==='true';}catch{return false;}});
 useEffect(()=>{try{localStorage.setItem('aiui-preview-muted',String(previewMuted));}catch{}},[previewMuted]);
 const togglePreviewMute=()=>setPreviewMuted(muted=>!muted);
 const [previewDisplayMode,setPreviewDisplayMode]=useState(()=>{try{return localStorage.getItem('aiui-preview-display')==='color'?'color':'monochrome';}catch{return 'monochrome';}});
 useEffect(()=>{try{localStorage.setItem('aiui-preview-display',previewDisplayMode);}catch{}},[previewDisplayMode]);
 const togglePreviewDisplay=()=>setPreviewDisplayMode(mode=>mode==='color'?'monochrome':'color');
 const[state,setState]=useState(null),[route,setRoute]=useState({view:'projects'}),[previewRequest,setPreview]=useState(null),[previewOpening,setPreviewOpening]=useState(false),[toast,setToast]=useState(null),[modal,setModal]=useState(null),[busy,setBusy]=useState(''),[logs,setLogs]=useState([]);
 const [workspace,setWorkspace]=useState(null);
 const[appUpdates,setAppUpdates]=useState(null),[projectMenu,setProjectMenu]=useState(null),[showIdea,setShowIdea]=useState(false);
 const[serviceError,setServiceError]=useState(false);
 const {view,projectId:selected}=route;
 const previewLoad=useRef(null);
 useEffect(()=>{const close=event=>{if(!event.target.closest('.project-actions'))setProjectMenu(null);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
 useEffect(()=>{if(api.kind==='web'||!api.updates)return;let mounted=true;const poll=()=>api.updates('status').then(value=>{if(mounted)setAppUpdates(value);}).catch(()=>{});poll();const timer=setInterval(poll,2000);return()=>{mounted=false;clearInterval(timer);};},[]);
 const[deletingJobs,setDeletingJobs]=useState(false),[clearingPreview,setClearingPreview]=useState(null);
 const discovery=useDeviceDiscovery(api,['devices','guide','glasses','install'].includes(view)),environment=discovery.environment;
 const contentRef=useRef(),projectContentRef=useRef();
 useEffect(()=>{if(contentRef.current)contentRef.current.scrollTop=0;},[view,selected]);
 const toastTimer=useRef(), lastRequest=useRef(Date.now()), stateRequest=useRef(0);
 const projects=state?.projects||[],project=projects.find(p=>p.id===selected);
 const workspaceProject=projects.find(p=>p.id===workspace?.projectId),workspaceView=workspace?.view;
 const showingProject=isProjectView(view)&&!!workspaceProject;
 useEffect(()=>{if(projectContentRef.current)projectContentRef.current.scrollTop=0;},[workspace?.projectId,workspaceView]);
 const preview=workspaceView==='simulator'&&workspaceProject&&previewRequest?.projectId===workspaceProject.id?previewRequest:null;
 const session=state?.previews?.find(s=>s.id===preview?.id&&s.requestedAt>=preview.requestedAt);
 const jobs=state?.jobs||[],running=jobs.filter(j=>j.status==='running');
 const projectJobs=workspaceProject?jobs.filter(job=>job.projectId===workspaceProject.id):[];
 function notify(message,error=false){setToast({message:error?t('遇到问题，诊断已记录供 AI 处理'):translateMessage(message),error});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),6000);}
 async function refresh(){
  const request=++stateRequest.current;
  try{
   const value=await call('aiui_status');
   if(request===stateRequest.current){setState(value);setServiceError(false);}
   return value;
  }catch(error){
   if(request===stateRequest.current)setServiceError(true);
   throw error;
  }
 }
 useEffect(()=>{refresh().catch(e=>notify(e.message,true));const timer=setInterval(()=>refresh().catch(()=>{}),1300);return()=>clearInterval(timer);},[]);
 useEffect(()=>api.onPlatformSession?.(()=>refresh().catch(()=>{})),[]);
 // Check on every UI launch, including when the shared service is already running.
 // This runs alongside the initial status load; the service coalesces in-flight checks.
 useEffect(()=>{call('aiui_sdk_check').catch(()=>{});},[]);
 useEffect(()=>{setLogs([]);if(!preview)return;let cancelled=false,fetching=false;async function readLogs(){if(fetching)return;fetching=true;try{const value=await call('aiui_preview_logs',{sessionId:preview.id,limit:14});if(!cancelled&&(!session?.logGeneration||value.logGeneration===session.logGeneration))setLogs(value.logs);}catch{}finally{fetching=false;}}readLogs();const timer=setInterval(readLogs,1400);return()=>{cancelled=true;clearInterval(timer);};},[preview?.id,session?.logGeneration]);
 useEffect(()=>{
  const request=(state?.previews||[]).filter(s=>s.status!=='closed'&&['MCP','CLI','workflow'].includes(s.requestedBy)&&s.requestedAt>lastRequest.current).sort((a,b)=>b.requestedAt-a.requestedAt)[0];
  if(request?.url){
   lastRequest.current=request.requestedAt;
   previewLoad.current=null;
   setPreviewOpening(false);
   moveTo('simulator',request.projectId);
   setPreview(request);
  }
 },[state?.previews]);
 const reviewNotice=useRef(new Set());
 useEffect(()=>{const draft=state?.platform?.reviews?.find(item=>item.stage==='awaiting-user'&&!reviewNotice.current.has(item.id)&&projects.some(p=>p.id===item.projectId));if(draft){reviewNotice.current.add(draft.id);chooseView('publish',draft.projectId);notify(t('提审草稿已就绪，请核对并确认'));}},[state?.platform?.reviews]);
 async function perform(name,fn){setBusy(name);try{const result=await fn();await refresh();return result;}catch(e){notify(e.message,true);}finally{setBusy('');}}
 async function importProject(){
  const p=await perform('import',async()=>{const directory=await api.chooseDirectory();if(directory)return call('aiui_project_import',{directory});});
  if(p){openProject(p);notify(t("项目已加入，正在监听源码变化"));}
 }
 function openProject(p){if(p)chooseView('project',p.id);}
 async function openPreview(p){
  if(p.missing||p.error||!p.pages?.length||previewLoad.current)return;
  const request=previewLoad.current={};
  setPreviewOpening(true);
  try{
   const value=await call('aiui_preview_open',{projectId:p.id});
   if(previewLoad.current===request){setPreview(value);setLogs([]);}
  }catch(error){if(previewLoad.current===request)notify(error.message,true);}
  finally{if(previewLoad.current===request){previewLoad.current=null;setPreviewOpening(false);}}
 }
 async function act(action,parameters={}){if(!preview)return;try{return await call('aiui_preview_action',{sessionId:preview.id,action,parameters});}catch(e){notify(e.message,true);}}
 async function startJob(tool,args={}){return perform(tool,async()=>{const j=await call(tool,args);notify(t("任务已开始，可在任务记录中查看进度"));return j;});}
 async function copyConfig(){try{const value=await call('aiui_mcp_config');await api.copy(JSON.stringify(value,null,2));notify(t("MCP 配置已复制"));}catch(e){notify(e.message,true);}}
 async function capture(){await perform('capture',async()=>{const result=await call('aiui_preview_capture',{sessionId:preview.id});notify(t("模拟截图已保存到本机"));setModal({type:'capture',...result});});}
 async function deleteJobs(jobIds){setDeletingJobs(true);try{const result=await call('aiui_jobs_delete',{jobIds});await refresh();notify(result.deletedIds.length?t("已删除 {0} 条任务记录{1}", {0: result.deletedIds.length, 1: result.skippedRunningIds.length?t("，运行中的任务已保留"):''}):t("没有可删除的已结束记录"));}catch(error){notify(error.message,true);}finally{setDeletingJobs(false);}}
 async function clearPreviewLogs(sessionId){setClearingPreview(sessionId);try{const result=await call('aiui_preview_logs_clear',{sessionId});setState(current=>current&&({...current,previews:current.previews.map(item=>item.id===sessionId?{...item,logCount:0,logGeneration:result.logGeneration}:item)}));await refresh();notify(t("运行日志已清空，新日志会继续记录"));}catch(error){notify(error.message,true);}finally{setClearingPreview(null);}}
 async function cancelJob(jobId){try{await call('aiui_job_cancel',{jobId});await refresh();}catch(error){notify(error.message,true);}}
 function moveTo(view,projectId){
  const projectView=isProjectView(view)&&!!projectId;
  if(isProjectView(view)&&!projectId)view='projects';
  if(view==='projects'||(projectView&&(workspace?.projectId!==projectId||workspaceView!==view))){
   previewLoad.current=null;
   setPreviewOpening(false);
  }
  if(view==='projects')setWorkspace(null);
  else if(projectView)setWorkspace({view,projectId});
  const contextual=isProjectView(view)||view==='connect'||view==='guide';
  setRoute({view,projectId:contextual?projectId:undefined});
 }
 function chooseView(v,projectId){
  // A UI poll may deliver a preview request after the user has already moved
  // elsewhere. Manual navigation consumes older requests; a new CLI/MCP
  // request still opens its simulator normally.
  lastRequest.current=Math.max(lastRequest.current,Date.now());
  moveTo(v,projectId);
 }
 function openProjectView(next){
  if(!project||next===view)return;
  const destination=next==='devices'?'install':next;
  chooseView(destination,project.id);
  if(destination==='simulator'&&previewRequest?.projectId!==project.id)openPreview(project);
 }
 useEffect(()=>{
  if(state&&workspace&&!workspaceProject){
   if(isProjectView(view))chooseView('projects');
   else {
    setWorkspace(null);
    previewLoad.current=null;
    setPreviewOpening(false);
   }
  }
  if(state&&selected&&!project&&!isProjectView(view))setRoute({view});
  if(state&&previewRequest&&!projects.some(p=>p.id===previewRequest.projectId))setPreview(null);
 },[state,view,selected,workspace,previewRequest]);
 function navItem([key,Icon,title],status){
  const active=view===key||(key==='projects'&&isProjectView(view))||(key==='devices'&&view==='glasses');
  return <button key={key} aria-label={t(title)} aria-describedby={status?'workspace-'+key+'-status':undefined} aria-current={active?'page':undefined} className={'nav-item '+(active?'active':'')} onClick={()=>key==='projects'&&workspaceProject?chooseView(workspaceView,workspaceProject.id):chooseView(key)}>
   <Icon size={17}/><span>{t(key==='devices'?'眼镜':title)}</span>{status}
  </button>;
 }
 return <div className={"app-shell runtime-"+(api.kind||"desktop")+" platform-"+(api.platform||'web')}>
  <aside className="sidebar workspace-sidebar">
   <div className="window-controls-space"/>
   <div className="brand"><div className="brand-mark"><img src={appIcon} alt=""/></div><strong>{t("AIUI 工坊")}</strong></div>
   <div className="sidebar-navigation">
    <nav aria-label={t('项目导航')}>
     {navItem(['projects',PanelsTopLeft,'我的项目'])}
     {workspaceProject&&<div className="sidebar-project-context">
      <span id="sidebar-project-page">{t(projectViews.find(([key])=>key===workspaceView)[2])}</span>
      <select aria-label={t('切换项目')} aria-describedby="sidebar-project-page" title={workspaceProject.name} value={workspaceProject.id} onChange={event=>{
       if(event.target.value)openProject(projects.find(p=>p.id===event.target.value));
       else chooseView('projects');
      }}>
       <option value="">{t('查看全部项目')}</option>
       {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
     </div>}
    </nav>
    <div className="navigation-group workspace-tools">
     <p className="nav-label">{t('工坊工具')}</p>
     <nav aria-label={t('工坊工具')}>{workspaceTools.map(item=>navItem(item,item[0]==='connect'
       ? <StatusLabel id="workspace-connect-status" tone={!state&&!serviceError?'working':!serviceError&&connectionReady(state)?'ready':'idle'}>{t(serviceError?'状态未知':!state?'检查中':connectionReady(state)?'已连接':'未连接')}</StatusLabel>
       : item[0]==='sdk'?(serviceError?<StatusLabel id="workspace-sdk-status">{t('状态未知')}</StatusLabel>:sdkStatus(state?.sdk)):null))}</nav>
    </div>
   </div>
   <div className="sidebar-bottom">
    <UpdateNotice api={api} updates={appUpdates} onUpdate={setAppUpdates}/>
    <nav aria-label={t('帮助与设置')}>{workspaceHelp.map(item=>navItem(item,item[0]==='settings'&&appUpdates?.updateAvailable
      ?<StatusLabel id="workspace-settings-status" tone="action">{t('可更新')}</StatusLabel>:null))}</nav>
   </div>
  </aside>
  <div className="main-shell">
   <header className="topbar">
    <div className="breadcrumb">{project?<><button type="button" aria-label={t('返回项目列表')} onClick={()=>chooseView('projects')}>{t('我的项目')}</button><ChevronRight size={12}/><strong title={project.name}>{project.name}</strong>{!isProjectView(view)&&<><ChevronRight size={12}/><span>{t(titleFor(view))}</span></>}</>:<strong>{t(titleFor(view))}</strong>}</div>
    <div className="topbar-right">
     <div className="language-switcher" role="group" aria-label="Language / 语言" title="Language / 语言"><Globe2 size={17} aria-hidden="true"/><button type="button" lang="zh-CN" aria-label="切换到中文" aria-pressed={locale==='zh-CN'} onClick={()=>setLocale('zh-CN')}>中文</button><button type="button" lang="en" aria-label="Switch to English" aria-pressed={locale==='en'} onClick={()=>setLocale('en')}>EN</button></div>
     <StatusLabel tone={serviceError?'error':state?'ready':'working'}>{t(serviceError?'本地服务未连接':state?'本地服务已连接':'正在连接本地服务')}</StatusLabel>
    </div>
   </header>
   {!showingProject&&<main ref={contentRef} className={'content view-'+view}>
   {view==='feedback'&&<FeedbackPage api={api}/>}
   {view==='projects'&&<>
    <div className="page-heading project-library-heading">
     <div><h1>{t("我的项目")}</h1><p>{t('选择一个项目，开始制作、模拟或安装。')}</p></div>
     <div className="heading-actions"><Button icon={Sparkles} aria-expanded={showIdea} onClick={()=>setShowIdea(!showIdea)}>{t(showIdea?'收起想法':'写下想法')}</Button><Button icon={FolderOpen} onClick={importProject} busy={busy==='import'}>{t("导入项目")}</Button><Button className="primary" icon={Plus} onClick={()=>setModal({type:'create'})}>{t("新建项目")}</Button></div>
    </div>
    {showIdea&&<div className="project-new-idea"><IdeaComposer state={state} onConnect={()=>chooseView('connect')} api={api} notify={notify}/></div>}
    {projects.length?<div className="project-grid">{projects.map((p,i)=>
      <article className="project-card" key={p.id}>
       <button className="project-card-main" onClick={()=>openProject(p)}>
        <div className="project-card-top"><div className={'project-icon color-'+i%4}><ProjectIcon project={p} fallback={Orbit} size={27}/></div><ArrowUpRight size={17} className="card-arrow"/></div>
        <h3>{p.name}</h3>
        {p.description&&<p>{p.description}</p>}
        <div className="card-tags"><Pill>{p.version}</Pill><span>{t('{0} 个页面',{0:p.pages.length})}</span></div>
       </button>
       <div className="project-card-bottom">
        {p.missing||p.error?<StatusLabel tone="error">{t(p.missing?'项目文件缺失':'源码需要检查')}</StatusLabel>:<PackageSize project={p}/>}
        <div className="project-actions">
         <button aria-label={t("打开文件位置 ")+p.name} onClick={()=>api.reveal(p.agentPath).catch(e=>notify(e.message,true))}><FolderOpen size={15}/></button>
         <button aria-label={t("项目操作 ")+p.name} aria-haspopup="menu" aria-expanded={projectMenu===p.id} onClick={()=>setProjectMenu(projectMenu===p.id?null:p.id)}><MoreHorizontal size={16}/></button>
         {projectMenu===p.id&&<div className="project-action-menu" role="menu" aria-label={t("项目操作 ")+p.name} onKeyDown={event=>{if(event.key==='Escape')setProjectMenu(null);}}>
          <button role="menuitem" onClick={()=>{setProjectMenu(null);setModal({type:'remove-project',project:p,operation:'detach'});}}><Link2 size={14}/>{t("解绑项目")}</button>
          <button role="menuitem" className="danger" disabled={api.kind!=='desktop'||p.missing} title={api.kind!=='desktop'?t("请在桌面客户端删除项目，文件将移到系统废纸篓或回收站"):undefined} onClick={()=>{setProjectMenu(null);setModal({type:'remove-project',project:p,operation:'delete'});}}><Trash2 size={14}/>{t("删除项目和文件…")}</button>
         </div>}
        </div>
       </div>
      </article>)}</div>:<Empty icon={PanelsTopLeft} title={t(state?'还没有项目':'正在载入项目…')}>{state&&t('新建一个应用，或导入已有的 AIUI 项目目录。')}</Empty>}
   </>}
   {view==='knowledge'&&<KnowledgePage knowledge={state?.knowledge} running={running} startJob={startJob} notify={notify}/>}
   {view==='settings'&&<SettingsPage api={api} updates={appUpdates} onUpdates={setAppUpdates} notify={notify}/>}
   {view==='sdk'&&<SdkPage sdk={state?.sdk} projects={projects} jobs={jobs} refresh={refresh} notify={notify} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs}/>}
   {view==='logs'&&<LogsPage projects={projects} previews={state?.previews||[]} jobs={jobs} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs} onClearPreview={clearPreviewLogs} clearingPreview={clearingPreview} notify={notify} go={chooseView} onOpenProject={openProject}/>}
   {view==='connect'&&<ConnectPage key={project?.id||'new'} state={state} serviceError={serviceError} project={project} copyConfig={copyConfig} notify={notify} go={v=>chooseView(v,isProjectView(v)?project?.id:undefined)}/>}
   {view==='guide'&&<BeginnerGuide environment={environment} importProject={importProject} go={v=>project?openProjectView(v):chooseView(v)} notify={notify}/>}
   {view==='devices'&&<div className="page-heading glasses-root-heading"><div><h1>{t('眼镜')}</h1><p>{t('连接、投屏及管理眼镜上的应用和文件。')}</p></div></div>}
   {['devices','glasses'].includes(view)&&<nav className="workspace-tabs device-workspace-tabs" aria-label={t('眼镜')}>
     <button aria-current={view==='devices'?'page':undefined} onClick={()=>chooseView('devices')}><Glasses size={17}/>{t('连接')}</button>
     <button aria-current={view==='glasses'?'page':undefined} onClick={()=>chooseView('glasses')}><Settings2 size={17}/>{t('眼镜工具')}</button>
   </nav>}
   {view==='devices'&&<DevicePanel key="connections" discovery={discovery} startJob={startJob} jobs={jobs} goToGuide={()=>chooseView('guide')}/>}
   {view==='glasses'&&<GlassesToolsPage discovery={discovery} jobs={jobs} refresh={refresh} notify={notify} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs} goToGuide={()=>chooseView('guide')}/>}
   </main>}
   {workspaceProject&&<main ref={projectContentRef} className={'content view-'+workspaceView} hidden={!showingProject}>
    <ProjectHeader project={workspaceProject} view={workspaceView} navigate={openProjectView}
     onReveal={()=>api.reveal(workspaceProject.agentPath).catch(e=>notify(e.message,true))}/>
    {workspaceView==='project'&&<ProjectPage key={workspaceProject.id} state={state} project={workspaceProject} jobs={projectJobs} api={api} notify={notify} go={openProjectView} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs}/>}
    {workspaceView==='simulator'&&<>
     <Simulator key={workspaceProject.id} active={showingProject} project={workspaceProject} preview={preview} session={session} opening={previewOpening} onCapture={capture} capturing={busy==='capture'} onOpen={()=>openPreview(workspaceProject)} onHome={id=>{setPreview(current=>current?.id===id?null:current);setLogs([]);}} act={act} choosePhoto={async()=>{try{const file=await api.choosePhoto();if(file)await act('camera_fixture',{path:file});}catch(error){notify(error.message,true);}}} previewMuted={previewMuted} onTogglePreviewMute={togglePreviewMute} previewDisplayMode={previewDisplayMode} onTogglePreviewDisplay={togglePreviewDisplay}/>
     {preview&&<details className="console panel project-console">
      <summary><Terminal size={15}/>{t('运行日志')}<small>{session?.logCount||0}</small></summary>
      <div className="console-actions"><Button icon={Trash2} disabled={!!clearingPreview} onClick={()=>clearPreviewLogs(preview.id)}>{clearingPreview===preview.id?t("正在清空…"):t("清空运行日志")}</Button></div>
      <div className="console-entries">{logs.length?logs.map(l=><div className={'log-line '+l.level} key={l.sequence}><time>{new Date(l.at).toLocaleTimeString(getLocale())}</time><span>{l.message}</span></div>):<p className="subtle">{t("正在等待应用日志…")}</p>}</div>
     </details>}
    </>}
    {workspaceView==='install'&&<>
      <DevicePanel key={workspaceProject.id} discovery={discovery} project={workspaceProject} startJob={startJob} jobs={jobs} goToGuide={()=>chooseView('guide',workspaceProject.id)}/>
      <JobHistory title={t("安装与打开记录")} jobs={projectJobs.filter(j=>['deploy','launch'].includes(j.type))} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs}/>
    </>}
    {workspaceView==='publish'&&<PublishPage key={workspaceProject.id} active={showingProject} api={api} project={workspaceProject} jobs={projectJobs} busy={busy} startJob={startJob} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs} notify={notify} pendingReview={state?.platform?.reviews?.some(item=>item.projectId===workspaceProject.id&&item.stage==='awaiting-user')}/>}
   </main>}
   <footer className="statusbar"><span><ShieldCheck size={11}/>{t(" 项目保存在本机 ")}<span className="statusbar-divider">·</span> v{__APP_VERSION__}</span><span>{running.length?<><LoaderCircle size={11} className="spin"/> {translateMessage(running[0].message).slice(0,90)}</>:<>Ink SDK {state?.webSdkVersion||'—'}</>}</span></footer>
  </div>
  {api.kind==='web'&&<WebDirectoryPicker api={api}/>}
  {toast&&<div role="status" className={'toast '+(toast.error?'error':'')}>{toast.error?<AlertCircle size={18}/>:<CheckCircle2 size={18}/>}<span>{toast.message}</span>{toast.error&&<button className="text-button" onClick={()=>{chooseView('logs');setToast(null);}}>{t('查看诊断')}</button>}<button aria-label={t("关闭提示")} onClick={()=>setToast(null)}><X size={15}/></button></div>}
  {modal&&<div className="modal-backdrop" onClick={()=>{if(busy!=='remove-project')setModal(null);}}><div className="modal" role="dialog" aria-modal="true" aria-label={t("确认项目操作")} onClick={e=>e.stopPropagation()}><button className="modal-close" aria-label={t("关闭弹窗")} disabled={busy==='remove-project'} onClick={()=>setModal(null)}><X size={18}/></button>{modal.type==='remove-project'?<ProjectRemovalDialog project={modal.project} operation={modal.operation} onClose={()=>setModal(null)} onWorking={value=>setBusy(value?'remove-project':'')} onRemoved={result=>{setModal(null);refresh().catch(error=>notify(error.message,true));notify(result.operation==='delete'?t("项目文件已移到系统废纸篓或回收站，并从工坊移除"):t("项目已解绑，本地文件已保留"));}}/>:modal.type==='create'?<CreateProject onClose={()=>setModal(null)} onCreated={async p=>{await refresh();setModal(null);openProject(p);}} notify={notify} knowledge={state?.knowledge}/>:<><p className="eyebrow">SIMULATED CAPTURE</p><h2>{t("已保存当前预览画面")}</h2><img className="capture-image" src={'data:image/png;base64,'+modal.data}/><p className="subtle">{t("模拟截图 · 源码 ")}{short(modal.revision)} · {modal.width} × {modal.height}</p><Button icon={FolderOpen} onClick={()=>api.reveal(modal.path)}>{t("打开文件位置")}</Button></>}</div></div>}
 </div>;
}
function ProjectHeader({project,view,navigate,onReveal}){
 return <header className="project-workspace-header">
  <div className="project-identity">
   <div className="project-page-icon"><ProjectIcon project={project} fallback={Glasses} size={28}/></div>
   <div><div className="project-title-row"><h1>{project.name}</h1><Pill>{project.version}</Pill></div>
    {project.description&&view==='project'&&<p>{project.description}</p>}
   </div>
   <div className="project-header-actions"><Button icon={FolderOpen} onClick={onReveal}>{t('项目文件')}</Button></div>
  </div>
  <nav className="workspace-tabs" aria-label={t('当前项目')}>
   {projectViews.map(([key,Icon,title])=><button key={key} aria-current={view===key?'page':undefined} onClick={()=>navigate(key)}><Icon size={17}/>{t(title)}</button>)}
  </nav>
 </header>;
}
function CreateProject({onCreated,notify,knowledge}){const[name,setName]=useState(t("我的 AIUI 应用")),[parent,setParent]=useState(''),[folder,setFolder]=useState('my-aiui-app'),[busy,setBusy]=useState(false);return <><p className="eyebrow">NEW LOCAL PROJECT</p><h2>{t("创建一个 AIUI 项目")}</h2><p className="muted-copy">{t("使用官方全屏 Page 模板，自动加入项目库。")}</p><label className="field">{t("应用名称")}<input autoFocus value={name} onChange={e=>setName(e.target.value)}/></label><label className="field">{t("项目文件夹名")}<input value={folder} onChange={e=>setFolder(e.target.value)}/></label><label className="field">{t("保存位置")}<div className="folder-field"><input value={parent} readOnly placeholder={t("选择父目录")}/><Button icon={FolderOpen} onClick={async()=>setParent(await api.chooseDirectory()||parent)}>{t("选择")}</Button></div></label><p className="subtle">{knowledge?.revision?t("官方模板版本 ")+short(knowledge.revision):t("创建前需先在“官方资料”同步官方模板。")}</p><Button className="primary full" icon={Plus} busy={busy} disabled={busy||!parent||!name.trim()||!folder.match(/^[\w\-\u4e00-\u9fff]+$/)||!knowledge?.revision} onClick={async()=>{setBusy(true);try{const p=await call('aiui_project_create',{directory:parent+'/'+folder,name:name.trim(),locale:getLocale()});await onCreated(p);}catch(e){notify(e.message,true);}finally{setBusy(false);}}}>{t("创建并打开项目")}</Button></>}

createRoot(document.getElementById('root')).render(<App/>);
