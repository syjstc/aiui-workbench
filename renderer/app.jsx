import { t, getLocale, setLocale, useLocale, translateMessage } from './i18n.jsx';
import './themes.css';
import './theme.mjs';
import './web-bridge.mjs';
import {SettingsPage} from './settings-page.jsx';
import {WebDirectoryPicker} from './web-directory-picker.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CodeBlock} from './code-block.jsx';
import {SdkPage} from './sdk-page.jsx';
import {BeginnerGuide} from './beginner-guide.jsx';
import {KnowledgePage} from './knowledge-page.jsx';
import {DevicePanel} from './device-panel.jsx';
import {GlassesToolsPage} from './glasses-tools.jsx';
import {useDeviceDiscovery} from './use-device-discovery.js';
import {JobList,JobHistory} from './job-history.jsx';
import {LogsPage} from './logs-page.jsx';
import {Box,PanelsTopLeft,Monitor,BookOpen,Glasses,Plug,CloudUpload,Plus,FolderOpen,ArrowUpRight,ArrowLeft,ArrowRight,ChevronRight,Check,CheckCircle2,AlertCircle,RefreshCw,Search,Play,MousePointer2,Move3D,Camera,Terminal,Copy,ExternalLink,MoreHorizontal,Orbit,Gamepad2,Wifi,ShieldCheck,Activity,X,Square,LoaderCircle,FileCheck2,Package,SlidersHorizontal,Link2,Download,Settings2,Radio,Image,Power,RotateCcw,HelpCircle,Trash2,Globe2,Sparkles} from 'lucide-react';
import './style.css';
import {Simulator} from './simulator.jsx';
import {ProjectIcon} from './project-icon.jsx';
import {McpCapabilities} from './mcp-capabilities.jsx';
import {ProjectRemovalDialog} from './project-removal-dialog.jsx';
import {PublishPage} from './publish-page.jsx';
import {ProjectPage} from './project-page.jsx';
import {IdeaComposer} from './idea-composer.jsx';
import {ConnectPage} from './connect-page.jsx';
import {connectionReady} from './ai-connection.mjs';
import {UpdateNotice} from './update-notice.jsx';
import appIcon from '../assets/branding/icon-64.png';

const api=window.workbench;
const reportUiError=(error,source)=>api.call('aiui_diagnostics_report',{source,message:String(error?.message||error),stack:error?.stack}).catch(()=>{});
window.addEventListener('error',e=>reportUiError(e.error||e.message,'renderer'));
window.addEventListener('unhandledrejection',e=>reportUiError(e.reason,'renderer-promise'));
const call=(tool,args={})=>api.call(tool,args);
const short=s=>s?s.slice(0,8):'—';
const time=s=>s?new Date(s).toLocaleString(getLocale(),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):t("尚未运行");
const formatSize=n=>n>1024*1024?(n/1024/1024).toFixed(1)+' MB':Math.round((n||0)/1024)+' KB';
const navigationGroups=[
 ['应用开发',[['projects',PanelsTopLeft,'我的项目'],['simulator',Monitor,'模拟器'],['publish',CloudUpload,'构建与上传']]],
 ['眼镜管理',[['devices',Glasses,'连接眼镜'],['glasses',SlidersHorizontal,'眼镜工具']]],
 ['资源与工具',[['knowledge',BookOpen,'官方资料'],['connect',Plug,'连接 AI 工具'],['sdk',Package,'SDK 更新'],['logs',Terminal,'日志与记录']]],
];
const navigation=navigationGroups.flatMap(([,items])=>items);
function Pill({children,tone=''}){return <span className={'pill '+tone}>{children}</span>}
function Empty({icon:Icon=Box,title,children,action}){return <div className="empty"><span className="empty-icon"><Icon size={30}/></span><h3>{title}</h3><p>{children}</p>{action}</div>}
function Button({children,icon:Icon,className='',busy,...props}){return <button className={'button '+className} {...props}>{busy?<LoaderCircle size={15} className="spin"/>:Icon&&<Icon size={15}/>} {children}</button>}
function App(){
 const locale=useLocale();
 useEffect(()=>{document.documentElement.lang=locale;document.title=t('AIUI 工坊');api.setLocale?.(locale).catch(()=>{});},[locale]);
 const[state,setState]=useState(null),[view,setView]=useState('projects'),[selected,setSelected]=useState(null),[preview,setPreview]=useState(null),[toast,setToast]=useState(null),[modal,setModal]=useState(null),[busy,setBusy]=useState(''),[logs,setLogs]=useState([]);
 const[appUpdates,setAppUpdates]=useState(null),[projectMenu,setProjectMenu]=useState(null),[showIdea,setShowIdea]=useState(false),[connectProject,setConnectProject]=useState(null);
 useEffect(()=>{const close=event=>{if(!event.target.closest('.project-actions'))setProjectMenu(null);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
 useEffect(()=>{if(api.kind==='web'||!api.updates)return;let mounted=true;const poll=()=>api.updates('status').then(value=>{if(mounted)setAppUpdates(value);}).catch(()=>{});poll();const timer=setInterval(poll,2000);return()=>{mounted=false;clearInterval(timer);};},[]);
 const[deletingJobs,setDeletingJobs]=useState(false),[clearingPreview,setClearingPreview]=useState(null);
 const discovery=useDeviceDiscovery(api,view==='devices'||view==='guide'||view==='glasses'),environment=discovery.environment;
 const contentRef=useRef();
 useEffect(()=>{if(contentRef.current)contentRef.current.scrollTop=0;},[view]);
 const toastTimer=useRef(), lastRequest=useRef(Date.now()), sdkNotice=useRef(null), stateRequest=useRef(0);
 const initialRoute=useRef(false);
 useEffect(()=>{if(state&&!initialRoute.current){initialRoute.current=true;if(!state.aiConnection?.verifiedAt&&!state.projects.length)setView('connect');}},[state]);
 const projects=state?.projects||[],project=projects.find(p=>p.id===selected),session=state?.previews?.find(s=>s.id===preview?.id),jobs=state?.jobs||[],running=jobs.filter(j=>j.status==='running');
 function notify(message,error=false){setToast({message:error?t('遇到问题，诊断已记录供 AI 处理'):translateMessage(message),error});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),6000);}
 async function refresh(){const request=++stateRequest.current,value=await call('aiui_status');if(request===stateRequest.current)setState(value);return value;}
 useEffect(()=>{refresh().catch(e=>notify(e.message,true));const timer=setInterval(()=>refresh().catch(()=>{}),1300);return()=>clearInterval(timer);},[]);
 useEffect(()=>api.onPlatformSession?.(()=>refresh().catch(()=>{})),[]);
 // Check on every UI launch, including when the shared service is already running.
 // This runs alongside the initial status load; the service coalesces in-flight checks.
 useEffect(()=>{call('aiui_sdk_check').catch(()=>{});},[]);
 useEffect(()=>{setLogs([]);if(!preview)return;let cancelled=false,fetching=false;async function readLogs(){if(fetching)return;fetching=true;try{const value=await call('aiui_preview_logs',{sessionId:preview.id,limit:14});if(!cancelled&&(!session?.logGeneration||value.logGeneration===session.logGeneration))setLogs(value.logs);}catch{}finally{fetching=false;}}readLogs();const timer=setInterval(readLogs,1400);return()=>{cancelled=true;clearInterval(timer);};},[preview?.id,session?.logGeneration]);
 useEffect(()=>{const request=[...(state?.previews||[])].filter(s=>['MCP','CLI','workflow'].includes(s.requestedBy)&&s.requestedAt>lastRequest.current).sort((a,b)=>b.requestedAt-a.requestedAt)[0];if(request?.url){lastRequest.current=request.requestedAt;setPreview(request);setSelected(request.projectId);setView(current=>current==='simulator'&&preview?.projectId===request.projectId?'simulator':'project');}},[state?.previews]);
 const reviewNotice=useRef(new Set());
 useEffect(()=>{const draft=state?.platform?.reviews?.find(item=>item.stage==='awaiting-user'&&!reviewNotice.current.has(item.id));if(draft){reviewNotice.current.add(draft.id);setSelected(draft.projectId);setView('publish');notify(t('提审草稿已就绪，请核对并确认'));}},[state?.platform?.reviews]);
 useEffect(()=>{const candidate=state?.sdk?.candidate;if(candidate&&sdkNotice.current!==candidate.id){sdkNotice.current=candidate.id;notify(t("发现官方 SDK / CLI 新版本，可在「SDK 更新」检查兼容性后启用"));}},[state?.sdk?.candidate?.id]);
 async function perform(name,fn){setBusy(name);try{const result=await fn();await refresh();return result;}catch(e){notify(e.message,true);}finally{setBusy('');}}
 async function importProject(){await perform('import',async()=>{const directory=await api.chooseDirectory();if(!directory)return;const p=await call('aiui_project_import',{directory});openProject(p);notify(t("项目已加入，正在监听源码变化"));});}
 function openProject(p){if(!p)return;setSelected(p.id);chooseView('project');}
 async function openPreview(p=project){if(!p){setView('projects');notify(t("先从项目库选择一个项目"));return;}await perform('preview',async()=>{const value=await call('aiui_preview_open',{projectId:p.id});setPreview(value);setSelected(p.id);setView('simulator');setLogs([]);});}
 async function act(action,parameters={}){if(!preview)return;try{return await call('aiui_preview_action',{sessionId:preview.id,action,parameters});}catch(e){notify(e.message,true);}}
 async function startJob(tool,args={}){return perform(tool,async()=>{const j=await call(tool,args);notify(t("任务已开始，可在任务记录中查看进度"));return j;});}
 async function copyConfig(){try{const value=await call('aiui_mcp_config');await api.copy(JSON.stringify(value,null,2));notify(t("MCP 配置已复制"));}catch(e){notify(e.message,true);}}
 async function capture(){await perform('capture',async()=>{const result=await call('aiui_preview_capture',{sessionId:preview.id});notify(t("模拟截图已保存到本机"));setModal({type:'capture',...result});});}
 async function deleteJobs(jobIds){setDeletingJobs(true);try{const result=await call('aiui_jobs_delete',{jobIds});await refresh();notify(result.deletedIds.length?t("已删除 {0} 条任务记录{1}", {0: result.deletedIds.length, 1: result.skippedRunningIds.length?t("，运行中的任务已保留"):''}):t("没有可删除的已结束记录"));}catch(error){notify(error.message,true);}finally{setDeletingJobs(false);}}
 async function clearPreviewLogs(sessionId){setClearingPreview(sessionId);try{const result=await call('aiui_preview_logs_clear',{sessionId});setState(current=>current&&({...current,previews:current.previews.map(item=>item.id===sessionId?{...item,logCount:0,logGeneration:result.logGeneration}:item)}));await refresh();notify(t("运行日志已清空，新日志会继续记录"));}catch(error){notify(error.message,true);}finally{setClearingPreview(null);}}
 async function cancelJob(jobId){try{await call('aiui_job_cancel',{jobId});await refresh();}catch(error){notify(error.message,true);}}
 function chooseView(v){
  // A UI poll may deliver a preview request after the user has already moved
  // elsewhere. Manual navigation consumes older requests; a new CLI/MCP
  // request still opens its simulator normally.
  lastRequest.current=Math.max(lastRequest.current,Date.now());if(v==='connect')setConnectProject(null);setView(v);
 }
 function openAiSetup(p){chooseView('connect');setConnectProject(p||null);}
 useEffect(()=>{if(state&&selected&&!projects.some(p=>p.id===selected)){setSelected(null);setPreview(null);if(['simulator','project'].includes(view))setView('projects');}},[state,selected]);
 const activeProject=project||projects[0];
 return <div className={"app-shell runtime-"+(api.kind||"desktop")+" platform-"+(api.platform||'web')}>
  <aside className="sidebar">
   <div className="window-controls-space"/>
   <div className="brand"><div className="brand-mark"><img src={appIcon} alt=""/></div><div><strong>{t("AIUI 工坊")}</strong><small>{t("应用开发工作台")}</small></div></div>
   <div className="workspace-tag"><FolderOpen size={15}/><span>{t("本地工作空间")}</span><span className="workspace-badge">{t("本机")}</span></div>
   <div className="sidebar-navigation">
   {navigationGroups.map(([label,items])=><div className="navigation-group" key={label}><p className="nav-label">{t(label)}</p><nav aria-label={t(label)}>{items.map(([key,Icon,title])=><button key={key} aria-label={t(title)} aria-current={view===key||(view==='project'&&key==='projects')?'page':undefined} className={'nav-item '+(view===key||(view==='project'&&key==='projects')?'active':'')} onClick={()=>key==='connect'?openAiSetup():chooseView(key)}><Icon size={17}/><span>{t(title)}</span>{key==='projects'&&<em>{projects.length}</em>}{key==='connect'&&connectionReady(state)&&<span className="dot"/>}{key==='sdk'&&state?.sdk?.updateAvailable&&<em>{t('新版')}</em>}</button>)}</nav></div>)}</div>
   <div className="sidebar-bottom">
   <UpdateNotice api={api} updates={appUpdates} onUpdate={setAppUpdates}/>
   <button aria-label={t("新手指南")} aria-current={view==='guide'?'page':undefined} className={'nav-item '+(view==='guide'?'active':'')} onClick={()=>chooseView('guide')}><HelpCircle size={17}/><span>{t("新手指南")}</span></button>
   <button aria-label={t("设置")} aria-current={view==='settings'?'page':undefined} className={'nav-item '+(view==='settings'?'active':'')} onClick={()=>chooseView('settings')}><Settings2 size={17}/><span>{t("设置")}</span>{appUpdates?.updateAvailable&&<em>{t("新版")}</em>}</button>
   <div className="knowledge-status"><BookOpen size={14}/><div><strong>{state?.knowledge?.revision?t("{0} 份资料可离线阅读", {0: state.knowledge.documents}):t("官方资料待同步")}</strong></div><button aria-label={t("同步官方资料")} title={t("同步官方资料")} onClick={()=>startJob('aiui_docs_sync')}><RefreshCw size={13} className={running.some(j=>j.type==='knowledge')?'spin':''}/></button></div></div>
  </aside>
  <div className="main-shell">
   <header className="topbar"><div className="breadcrumb">{t("工作空间 ")}<ChevronRight size={12}/><strong>{view==='project'?t('我的项目'):t([...navigation,['connect',null,'连接 AI 工具'],['guide',null,'新手指南'],['sdk',null,'SDK 更新'],['logs',null,'日志与记录'],['settings',null,'设置']].find(n=>n[0]===view)?.[2] || '')}</strong>{['simulator','project'].includes(view)&&project&&<><ChevronRight size={12}/><span>{project.name}</span></>}</div><div className="topbar-right"><div className="language-switcher" role="group" aria-label="Language / 语言" title="Language / 语言"><Globe2 size={17} aria-hidden="true"/><button type="button" lang="zh-CN" aria-label="切换到中文" aria-pressed={locale==='zh-CN'} onClick={()=>setLocale('zh-CN')}>中文</button><button type="button" lang="en" aria-label="Switch to English" aria-pressed={locale==='en'} onClick={()=>setLocale('en')}>EN</button></div><span className="service-state"><span className={'dot '+(!state?'muted':'')}/>{state?t("本地服务已连接"):t("正在连接本地服务")}</span></div></header>
   <main ref={contentRef} className={'content view-'+view}>
   {view==='project'&&project&&<ProjectPage key={project.id} state={state} project={project} api={api} notify={notify} go={v=>v==='connect'?openAiSetup(project):chooseView(v)} onOpenPreview={openPreview} previewRequest={preview} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs}/>}
   {view==='projects'&&<>
    <div className="page-heading"><div><h1>{t("我的项目")}</h1><p>{t("打开一个项目，看看效果，或继续和 AI 完善想法。")}</p></div><div className="heading-actions"><Button icon={FolderOpen} onClick={importProject} busy={busy==='import'}>{t("导入项目")}</Button><Button className="primary" icon={Plus} onClick={()=>setModal({type:'create'})}>{t("新建项目")}</Button></div></div>
    <section className="project-idea-launcher"><Sparkles size={25}/><div><h2>{t('有个新想法？')}</h2><p>{t('写下来，整理成可以发给 AI 的指令。也可以直接在 AI 工具里开始。')}</p></div><button className="button" aria-expanded={showIdea} onClick={()=>setShowIdea(!showIdea)}>{showIdea?<X size={15}/>:<Plus size={15}/>} {t(showIdea?'收起想法':'写下想法')}</button></section>
    {state&&!connectionReady(state)&&<div className="project-connect-notice"><Plug size={21}/><div><strong>{t('先让 AI 连上工坊')}</strong><p>{t('复制一条指令，AI 帮你准备连接、开发指引和环境。想法也可以一起带上。')}</p></div><button className="button primary" onClick={()=>openAiSetup()}>{t('让 AI 准备好')}<ArrowRight size={15}/></button></div>}
    {showIdea&&<div className="project-new-idea"><IdeaComposer state={state} onConnect={()=>openAiSetup()} api={api} notify={notify}/></div>}
    <div className="section-heading"><h2>{t("最近项目 ")}<span>{projects.length}</span></h2><span className="subtle"><Radio size={13}/>{t(" 自动监听文件变化")}</span></div>
    {projects.length?<div className="project-grid">{projects.map((p,i)=><article className="project-card" key={p.id}><button className="project-card-main" onClick={()=>openProject(p)}><div className="project-card-top"><div className={'project-icon color-'+i%4}><ProjectIcon project={p} fallback={p.name.includes('战')?Gamepad2:Orbit} size={30}/></div><ArrowUpRight size={17} className="card-arrow"/></div><h3>{p.name}</h3><p>{p.description||t("打开项目，查看应用并继续制作。")}</p><div className="card-tags"><Pill>{p.version}</Pill><span>{p.pages.length}{t(" 个页面")}</span><span>{formatSize(p.size)}</span></div></button><div className="project-card-bottom"><span><span className={'dot '+(p.error?'error':'')}/>{p.error?t("源码需要检查"):p.lastCheck?.stale?t("代码已更新"):p.lastCheck?.passed?t("静态检查通过"):t("已连接本地目录")}</span><div className="project-actions"><button aria-label={t("预览应用 ")+p.name} onClick={()=>openPreview(p)}><Play size={15}/></button><button aria-label={t("打开文件位置 ")+p.name} onClick={()=>api.reveal(p.agentPath)}><FolderOpen size={15}/></button><button aria-label={t("项目操作 ")+p.name} aria-haspopup="menu" aria-expanded={projectMenu===p.id} onClick={()=>setProjectMenu(projectMenu===p.id?null:p.id)}><MoreHorizontal size={16}/></button>{projectMenu===p.id&&<div className="project-action-menu" role="menu" aria-label={t("项目操作 ")+p.name} onKeyDown={event=>{if(event.key==='Escape')setProjectMenu(null);}}><button role="menuitem" onClick={()=>{setProjectMenu(null);setModal({type:'remove-project',project:p,operation:'detach'});}}><Link2 size={14}/>{t("解绑项目")}</button><button role="menuitem" className="danger" disabled={api.kind!=='desktop'||p.missing} title={api.kind!=='desktop'?t("请在桌面客户端删除项目，文件将移到系统废纸篓或回收站"):undefined} onClick={()=>{setProjectMenu(null);setModal({type:'remove-project',project:p,operation:'delete'});}}><Trash2 size={14}/>{t("删除项目和文件…")}</button></div>}</div></div></article>)}<button className="add-project-card" onClick={importProject}><span><Plus size={23}/></span><strong>{t("连接已有项目")}</strong><small>{t("选中目录，即可开始同步")}</small></button></div>:<Empty icon={PanelsTopLeft} title={t("你的第一个 AIUI 项目，从这里开始")} action={<Button className="primary" icon={FolderOpen} onClick={importProject}>{t("导入本地项目")}</Button>}>{t("已有源码可以直接导入，也可以让 AI 使用官方模板创建项目。")}</Empty>}
    <div className="project-library-note"><span>{t('在 AI 里创建的应用，会自动出现在项目列表。')}</span><div className="button-row"><button className="text-button" onClick={()=>chooseView('connect')}>{t('连接 AI 工具')}<ArrowRight size={14}/></button><button className="text-button" onClick={()=>chooseView('guide')}>{t('新手指南')}<ChevronRight size={14}/></button></div></div>
   </>}
   {view==='simulator'&&<>
    <div className="simulator-heading"><div><h1>{preview&&project?project.name:t("模拟器桌面")}{preview&&project&&<Pill>{project.version}</Pill>}</h1><p className="project-path">{preview&&project?project.agentPath:t("选择本地 AIUI 应用，运行后可随时回到桌面。")}</p></div><div className="heading-actions">{preview&&project?<><Button icon={ArrowLeft} onClick={()=>openProject(project)}>{t("项目概览")}</Button><Button icon={FileCheck2} onClick={()=>startJob('aiui_project_check',{projectId:project.id})}>{t("检查源码")}</Button><Button icon={RefreshCw} onClick={()=>act('reload')}>{t("重新加载")}</Button></>:<Button icon={FolderOpen} onClick={importProject}>{t("导入项目")}</Button>}</div></div>
    <Simulator projects={projects} project={project} preview={preview} session={session} onCapture={capture} capturing={busy==='capture'} onOpen={openPreview} onHome={id=>{setPreview(current=>current?.id===id?null:current);setLogs([]);}} onImport={importProject} act={act} choosePhoto={async()=>{const file=await api.choosePhoto();if(file)await act('camera_fixture',{path:file});}}/>
    {preview&&<section className="console panel"><div className="section-heading"><h2><Terminal size={15}/>{t(" 运行日志 ")}<span>{session?.logCount||0}</span></h2><div className="button-row"><span className="subtle">{t("来自当前预览会话")}</span><Button icon={Trash2} disabled={!!clearingPreview} onClick={()=>clearPreviewLogs(preview.id)}>{clearingPreview===preview.id?t("正在清空…"):t("清空运行日志")}</Button></div></div><div className="console-entries">{logs.length?logs.map((l,i)=><div className={'log-line '+l.level} key={i}><time>{new Date(l.at).toLocaleTimeString(getLocale())}</time><span>{l.message}</span></div>):<p className="subtle">{t("正在等待应用日志…")}</p>}</div></section>}
   </>}
   {view==='knowledge'&&<KnowledgePage knowledge={state?.knowledge} running={running} startJob={startJob} notify={notify}/>}
   {view==='settings'&&<SettingsPage api={api} updates={appUpdates} onUpdates={setAppUpdates} notify={notify}/>}
   {view==='sdk'&&<SdkPage sdk={state?.sdk} projects={projects} jobs={jobs} refresh={refresh} notify={notify} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs}/>}
   {view==='logs'&&<LogsPage projects={projects} previews={state?.previews||[]} jobs={jobs} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs} onClearPreview={clearPreviewLogs} clearingPreview={clearingPreview} notify={notify} go={chooseView} onOpenProject={openProject}/>}
   {view==='connect'&&<ConnectPage key={connectProject?.id||'new'} state={state} project={connectProject} copyConfig={copyConfig} notify={notify} go={v=>{if(v==='project'&&connectProject)setSelected(connectProject.id);chooseView(v);}}/>}
   {view==='guide'&&<BeginnerGuide environment={environment} importProject={importProject} go={chooseView} notify={notify}/>}
   {view==='devices'&&<><div className="page-heading"><div><h1>{t("连接眼镜")}</h1><p>{t("插上数据线，自动检查连接。准备好后，把应用安装到眼镜。")}</p></div></div><DevicePanel discovery={discovery} project={activeProject} projects={projects} setSelected={setSelected} startJob={startJob} jobs={jobs} goToProjects={()=>setView('projects')} goToGuide={()=>setView('guide')}/><JobHistory title={t("安装与打开记录")} jobs={jobs.filter(j=>['deploy','launch','device-setup'].includes(j.type))} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs}/></>}
   {view==='glasses'&&<GlassesToolsPage discovery={discovery} jobs={jobs} refresh={refresh} notify={notify} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs} goToGuide={()=>setView('guide')}/>}
   {view==='publish'&&<PublishPage api={api} projects={projects} project={activeProject} onSelect={setSelected} onImport={importProject} jobs={jobs} busy={busy} startJob={startJob} onCancel={cancelJob} onDelete={deleteJobs} deleting={deletingJobs} notify={notify}/>}
   </main>
   <footer className="statusbar"><span><ShieldCheck size={11}/>{t(" 项目保存在本机 ")}<span className="statusbar-divider">·</span> v{__APP_VERSION__}</span><span>{running.length?<><LoaderCircle size={11} className="spin"/> {translateMessage(running[0].message).slice(0,90)}</>:<>Ink SDK {state?.webSdkVersion||'—'}</>}</span></footer>
  </div>
  {api.kind==='web'&&<WebDirectoryPicker api={api}/>}
  {toast&&<div role="status" className={'toast '+(toast.error?'error':'')}>{toast.error?<AlertCircle size={18}/>:<CheckCircle2 size={18}/>}<span>{toast.message}</span>{toast.error&&<button className="text-button" onClick={()=>{setView('logs');setToast(null);}}>{t('查看诊断')}</button>}<button aria-label={t("关闭提示")} onClick={()=>setToast(null)}><X size={15}/></button></div>}
  {modal&&<div className="modal-backdrop" onClick={()=>{if(busy!=='remove-project')setModal(null);}}><div className="modal" role="dialog" aria-modal="true" aria-label={t("确认项目操作")} onClick={e=>e.stopPropagation()}><button className="modal-close" aria-label={t("关闭弹窗")} disabled={busy==='remove-project'} onClick={()=>setModal(null)}><X size={18}/></button>{modal.type==='remove-project'?<ProjectRemovalDialog project={modal.project} operation={modal.operation} onClose={()=>setModal(null)} onWorking={value=>setBusy(value?'remove-project':'')} onRemoved={result=>{setModal(null);refresh().catch(error=>notify(error.message,true));notify(result.operation==='delete'?t("项目文件已移到系统废纸篓或回收站，并从工坊移除"):t("项目已解绑，本地文件已保留"));}}/>:modal.type==='create'?<CreateProject onClose={()=>setModal(null)} onCreated={p=>{setModal(null);setSelected(p.id);refresh();openProject(p);}} notify={notify} knowledge={state?.knowledge}/>:<><p className="eyebrow">SIMULATED CAPTURE</p><h2>{t("已保存当前预览画面")}</h2><img className="capture-image" src={'data:image/png;base64,'+modal.data}/><p className="subtle">{t("模拟截图 · 源码 ")}{short(modal.revision)} · {modal.width} × {modal.height}</p><Button icon={FolderOpen} onClick={()=>api.reveal(modal.path)}>{t("打开文件位置")}</Button></>}</div></div>}
 </div>;
}
function CreateProject({onCreated,notify,knowledge}){const[name,setName]=useState(t("我的 AIUI 应用")),[parent,setParent]=useState(''),[folder,setFolder]=useState('my-aiui-app'),[busy,setBusy]=useState(false);return <><p className="eyebrow">NEW LOCAL PROJECT</p><h2>{t("创建一个 AIUI 项目")}</h2><p className="muted-copy">{t("使用官方全屏 Page 模板，自动加入项目库。")}</p><label className="field">{t("应用名称")}<input autoFocus value={name} onChange={e=>setName(e.target.value)}/></label><label className="field">{t("项目文件夹名")}<input value={folder} onChange={e=>setFolder(e.target.value)}/></label><label className="field">{t("保存位置")}<div className="folder-field"><input value={parent} readOnly placeholder={t("选择父目录")}/><Button icon={FolderOpen} onClick={async()=>setParent(await api.chooseDirectory()||parent)}>{t("选择")}</Button></div></label><p className="subtle">{knowledge?.revision?t("官方模板版本 ")+short(knowledge.revision):t("创建前需先在“官方资料”同步官方模板。")}</p><Button className="primary full" icon={Plus} busy={busy} disabled={busy||!parent||!name.trim()||!folder.match(/^[\w\-\u4e00-\u9fff]+$/)||!knowledge?.revision} onClick={async()=>{setBusy(true);try{const p=await call('aiui_project_create',{directory:parent+'/'+folder,name:name.trim(),locale:getLocale()});onCreated(p);}catch(e){notify(e.message,true);}finally{setBusy(false);}}}>{t("创建并打开项目")}</Button></>}

createRoot(document.getElementById('root')).render(<App/>);
