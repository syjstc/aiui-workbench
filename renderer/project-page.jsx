import React,{useEffect,useRef,useState} from 'react';
import {AlertCircle,ArrowLeft,ArrowRight,CheckCircle2,ChevronRight,Copy,FileCheck2,FolderOpen,Glasses,LoaderCircle,Monitor,Package,Play,RefreshCw,Send,Sparkles} from 'lucide-react';
import {getLocale,t,translateMessage} from './i18n.jsx';
import {ProjectIcon} from './project-icon.jsx';
import {IdeaComposer} from './idea-composer.jsx';
import {buildAiPrompt} from './ai-prompts.mjs';
import {connectionReady} from './ai-connection.mjs';
import {JobHistory} from './job-history.jsx';
import './ai-panels.css';
import './project-page.css';

export function ProjectPage({state,project,api,notify,go,onOpenPreview,previewRequest,onCancel,onDelete,deleting}){
  const[flowId,setFlowId]=useState(''),[working,setWorking]=useState(false),[previewError,setPreviewError]=useState(false),opening=useRef(false),openedAt=useRef(Date.now());
  const flows=(state?.workflows||[]).filter(f=>f.projectId===project.id),flow=flows.find(f=>f.id===flowId)||flows[0];
  const previews=(state?.previews||[]).filter(p=>p.projectId===project.id);
  const preview=previews.find(p=>p.id===previewRequest?.id&&p.status!=='closed')||previews.find(p=>p.status!=='closed'&&p.target==='_blank')||previews.find(p=>p.status!=='closed');
  const evidence=flow?.stale?{}:flow?.evidence||{},deviceMode=flow?.verification?.mode==='device';
  const jobs=(state?.jobs||[]).filter(j=>j.projectId===project.id),running=flow?.state==='running',waiting=flow?.state==='waiting-user',needsAi=flow?.state==='needs-ai'||flow?.state==='interrupted';
  const action=(waiting||needsAi)?flow?.nextAction:null;
  const artifact=project.lastBuild,buildCurrent=artifact?.revision===project.revision&&artifact?.toolchainId===project.toolchainId;
  const currentCheck=project.lastCheck?.passed&&!project.lastCheck?.stale&&project.lastCheck?.revision===project.revision;
  const previewVerified=!!evidence.preview||jobs.some(j=>j.type==='preview-test'&&j.status==='succeeded'&&j.result?.passed&&!j.result.stale&&j.result.assertionsEvaluated>0&&j.result.revision===project.revision&&j.result.toolchainId===project.toolchainId);
  async function requestPreview(){if(opening.current)return;opening.current=true;setPreviewError(false);try{await api.call('aiui_preview_open',{projectId:project.id});}catch(error){setPreviewError(true);notify(error.message,true);}finally{opening.current=false;}}
  useEffect(()=>{if(!previews.length&&!project.missing&&!deviceMode)requestPreview();},[project.id,previews.length,project.missing,deviceMode]);
  async function copy(intent,idea=''){if(!connectionReady(state)){go('connect');return;}try{await api.copy(buildAiPrompt({project,flow,intent,idea,features:state?.aiConnection?.features,locale:getLocale()}));notify(t('已复制，粘贴到你的 AI 工具即可'));}catch(error){notify(error.message,true);}}
  async function resume(){setWorking(true);try{await api.call('aiui_workflow_continue',{workflowId:flow.id,waitMs:0});}catch(error){notify(error.message,true);}finally{setWorking(false);}}
  const stages=[
    {icon:Sparkles,title:'想法与制作',description:'把需求交给 AI，继续完善同一个应用。',label:'复制项目指令',action:()=>copy('refine'),status:running?'正在制作':'随时可以继续'},
    {icon:Monitor,title:'预览与验证',description:'看真实模拟画面，让 AI 验证关键操作。',label:'打开完整模拟器',action:()=>onOpenPreview(project),status:evidence.previewSkipped?'改用真机，功能待确认':previewVerified?'已验证交互':'查看应用效果'},
    {icon:FileCheck2,title:'检查与打包',description:'检查当前源码，生成可以安装的应用包。',label:'构建与上传',action:()=>go('publish'),status:buildCurrent?'安装包已就绪':artifact?'代码更新后需重新打包':currentCheck?'源码检查通过':'按需检查与打包'},
    {icon:Glasses,title:'安装与体验',description:'连接眼镜，安装并打开，戴上确认实际体验。',label:'连接眼镜',action:()=>go('devices'),status:evidence.device?.launch?'已安装，待佩戴确认':'准备好后连接眼镜'},
    {icon:Send,title:'发布与分享',description:'准备图标和商店材料，正式提审前由你确认。',label:'管理发布材料',action:()=>go('publish'),status:'按需发布'},
  ];
  return <>
    <button className="text-button project-back" onClick={()=>go('projects')}><ArrowLeft size={15}/>{t('我的项目')}</button>
    <div className="page-heading project-heading"><div className="project-identity"><div className="project-page-icon"><ProjectIcon project={project} fallback={Glasses} size={34}/></div><div><div className="project-title-row"><h1>{project.name}</h1><span className="pill">{project.version}</span></div><p>{project.description||t('你的眼镜应用，可以随时接着完善。')}</p></div></div><div className="heading-actions"><button className="button" onClick={()=>api.reveal(project.agentPath).catch(e=>notify(e.message,true))}><FolderOpen size={15}/>{t('项目文件')}</button><button className="button" onClick={()=>go('publish')}><Package size={15}/>{t('构建与上传')}</button></div></div>
    {action&&<section className={'project-attention '+(waiting?'needs-user':'')} role="status"><AlertCircle size={20}/><div><strong>{translateMessage(action.title)}</strong>{waiting?<ol>{action.steps?.map((s,i)=><li key={i}>{translateMessage(s)}</li>)}</ol>:<p>{t('问题已记录，AI 可以读取原因并继续修复。')}</p>}</div><div className="project-attention-actions">{waiting?<><button className="button primary" disabled={working||running} onClick={resume}><RefreshCw size={15}/>{t('重新检查并继续')}</button>{action.view&&<button className="text-button" onClick={()=>go(action.view)}>{t('查看操作指引')}<ArrowRight size={14}/></button>}</>:<button className="button" onClick={()=>copy('recover')}><Copy size={15}/>{t('复制给 AI 继续')}</button>}</div></section>}
    <div className="project-workspace">
      <section className="project-preview-panel" aria-label={t('应用预览')}>
        <div className="project-preview-toolbar"><h2><Monitor size={17}/>{t('应用预览')}</h2>{running?<span className="project-working"><LoaderCircle size={13} className="spin"/>{t('AI 正在制作')}</span>:<span>{t('同一份项目，最新的效果')}</span>}</div>
        <div className="project-preview-stage">
          {deviceMode?<div className="project-preview-empty"><Glasses size={32}/><h3>{t('这项能力改用眼镜验证')}</h3><p>{t('电脑尚未验证实际功能。安装后，AI 会读取真机画面和日志，你可以戴上眼镜确认效果。')}</p><details><summary>{t('查看原因')}</summary><p>{flow.verification.reason}</p></details></div>:preview?<><iframe title={t('当前应用的真实模拟画面')} src={preview.url} allow="camera" style={{width:preview.width||480,height:preview.height||352}}/>{preview.status==='failed'&&preview.failedAt>openedAt.current&&<div className="project-preview-error"><AlertCircle size={28}/><h3>{t('预览遇到问题，AI 可以继续处理')}</h3><p>{t('问题已记录，AI 可以读取原因并继续修复。')}</p><button className="button" onClick={()=>copy('recover')}><Copy size={15}/>{t('复制给 AI 继续')}</button></div>}</>:<div className="project-preview-empty"><Monitor size={32}/><h3>{t(project.missing?'项目文件暂时不可用':previewError?'预览暂时未打开':'准备应用画面')}</h3><p>{t(project.missing?'可以检查项目文件位置，或让 AI 读取诊断继续处理。':'在 AI 里修改这个项目，效果会同步到这里。')}</p><button className="button" disabled={project.missing} onClick={requestPreview}><Play size={15}/>{t('打开预览')}</button></div>}
        </div>
        <div className="project-preview-footer"><span>{t('电脑模拟画面 · 佩戴体验需真机确认')}</span><button className="text-button" onClick={()=>onOpenPreview(project)}>{t('打开完整模拟器')}<ArrowRight size={14}/></button></div>
        {artifact&&<div className={'project-package '+(!buildCurrent?'is-stale':'')}>{buildCurrent?<FileCheck2 size={19}/>:<AlertCircle size={19}/>}<div><strong>{t(buildCurrent?'安装包已生成':'安装包需要更新')}</strong><small>{t(buildCurrent?'当前源码已打包，准备好后可安装到眼镜。':'源码或 SDK 已变化，使用前请重新验证打包。')}</small></div><button className="text-button" onClick={()=>api.reveal(artifact.path).catch(e=>notify(e.message,true))}>{t('打开文件位置')}<ChevronRight size={14}/></button></div>}
      </section>
      <IdeaComposer key={project.id} project={project} flow={flow} state={state} onConnect={()=>go('connect')} api={api} notify={notify} compact/>
    </div>
    <details className="project-lifecycle"><summary><div><h2>{t('项目完整流程')}</h2><p>{t('从想法到发布，所有步骤都在这个项目里。需要时展开查看。')}</p></div><ChevronRight size={17}/></summary><div className="project-lifecycle-rows">{stages.map(stage=>{const Icon=stage.icon;return <section className="project-lifecycle-row" key={stage.title}><span className="project-lifecycle-icon"><Icon size={19}/></span><div><h3>{t(stage.title)}<span>{t(stage.status)}</span></h3><p>{t(stage.description)}</p></div><button className="button" onClick={stage.action}>{t(stage.label)}<ArrowRight size={14}/></button></section>;})}</div>
      {flow&&<details className="project-flow-details"><summary>{t('查看 AI 制作任务与证据')}</summary>{flows.length>1&&<label className="field">{t('选择制作任务')}<select value={flow.id} onChange={e=>setFlowId(e.target.value)}>{flows.map(f=><option value={f.id} key={f.id}>{f.request.slice(0,45)} · {new Date(f.createdAt).toLocaleDateString(getLocale())}</option>)}</select></label>}<p>{flow.request}</p><p>{translateMessage(flow.message)}</p><pre>{JSON.stringify({workflowId:flow.id,state:flow.state,stage:flow.stage,revision:flow.revision,stale:flow.stale,previewReport:evidence.preview?.path,artifact:artifact?.path,deviceVerified:false,wornAcceptance:'pending'},null,2)}</pre></details>}
    </details>
    <details className="project-records"><summary><span>{t('这个项目的任务记录')} <small>{jobs.length}</small></span><ChevronRight size={16}/></summary><JobHistory title={t('项目任务记录')} jobs={jobs} onCancel={onCancel} onDelete={onDelete} deleting={deleting}/></details>
  </>;
}
