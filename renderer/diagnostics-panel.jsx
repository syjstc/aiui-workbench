import React,{useEffect,useRef,useState} from 'react';
import {AlertCircle,ArrowRight,Check,RefreshCw} from 'lucide-react';
import {t,translateMessage} from './i18n.jsx';

export function DiagnosticsPanel({notify,projects=[],go,onOpenProject}){
  const[data,setData]=useState({items:[]}),[loading,setLoading]=useState(false),[filter,setFilter]=useState('all'),[visibility,setVisibility]=useState('unread');
  const request=useRef(0),query=useRef();query.current={filter,visibility};
  async function refresh(){
    const current=++request.current,{filter,visibility}=query.current;setLoading(true);
    const scope=['workbench','unassigned'].includes(filter)?{scope:filter}:filter==='all'?{}:{projectId:filter};
    try{const value=await window.workbench.call('aiui_diagnostics_get',{...scope,status:'open',...(visibility==='all'?{}:{read:visibility==='read'}),limit:100});if(current===request.current)setData(value);}
    catch(error){if(current===request.current)notify(error.message,true);}
    finally{if(current===request.current)setLoading(false);}
  }
  useEffect(()=>{refresh();const timer=setInterval(refresh,4000);return()=>{request.current++;clearInterval(timer);};},[filter,visibility]);
  const grouped=new Map();
  for(const d of data.items.slice().reverse()){
    const key=JSON.stringify([d.scope,d.projectId,d.projectPath,d.workflowId,!!d.readAt,d.recovery.owner,d.recovery.category,d.recovery.title,d.recovery.steps]);
    if(!grouped.has(key))grouped.set(key,{...d,records:[]});grouped.get(key).records.push(d);
  }
  const groups=[...grouped.values()].sort((a,b)=>(a.recovery.owner==='user'?0:1)-(b.recovery.owner==='user'?0:1)||b.sequence-a.sequence);
  return <section className="panel diagnostic-panel">
    <div className="section-heading"><h2><AlertCircle size={17}/>{t('共享诊断')}<span>{t('未读 {0}',{0:data.unreadCount||0})}</span></h2><button className="text-button" onClick={refresh} disabled={loading}><RefreshCw size={14}/>{t('刷新')}</button></div>
    <p className="muted-copy">{t('AI 调用工坊工具时，会自动读取对应项目的问题；读过后从这里收起，无需复制日志。已读不代表已修复。')}</p>
    <div className="diagnostic-filters">
      <select aria-label={t('筛选诊断项目')} value={filter} onChange={e=>setFilter(e.target.value)}>
        <option value="all">{t('全部项目与公共环境')}</option><option value="workbench">{t('工坊 / 公共环境')}</option><option value="unassigned">{t('未关联项目')}</option>
        {projects.map(project=><option key={project.id} value={project.id}>{project.name} · {project.id.slice(0,8)}</option>)}
      </select>
      <select aria-label={t('筛选诊断阅读状态')} value={visibility} onChange={e=>setVisibility(e.target.value)}><option value="unread">{t('只看未读')}</option><option value="read">{t('已读未修复')}</option><option value="all">{t('全部未解决')}</option></select>
    </div>
    {!groups.length?<p className="no-jobs">{t(visibility==='unread'?'目前没有未读问题。':'目前没有符合条件的诊断。')}</p>:groups.map(d=>{const project=projects.find(p=>p.id===d.projectId);return <article key={d.id} className="diagnostic-row" data-diagnostic-id={d.id} data-project-id={d.projectId||''}>
      <div className="diagnostic-project">
        {d.projectId?(project&&onOpenProject?<button className="text-button" onClick={()=>onOpenProject(project)}>{project.name}<ArrowRight size={13}/></button>:<strong>{d.projectName||t('项目 {0}（已移除或不可用）',{0:d.projectId.slice(0,8)})}</strong>):<strong>{t(d.scope==='workbench'?'工坊 / 公共环境':'未关联项目')}</strong>}
        <span className="pill">{d.readAt?<><Check size={12}/>{t(d.readBy==='MCP'||d.readBy==='CLI'?'AI 已读取':'已读')}</>:t('未读')}</span>
      </div>
      {(project?.projectPath||d.projectPath)&&<p className="diagnostic-project-path">{project?.projectPath||d.projectPath}</p>}
      {d.scope==='unassigned'&&<p>{t('归属尚未确认，AI 会先核实来源，不会直接修改其他项目。')}</p>}
      <div className="diagnostic-row-heading"><strong>{translateMessage(d.recovery.title)}</strong><span className="pill">{t(d.recovery.owner==='user'?'需要你的操作':'交给 AI 处理')}</span></div>
      <p>{[t('关联记录 {0} 条',{0:d.records.length}),d.workflowId&&t('任务 {0}',{0:d.workflowId.slice(0,8)})].filter(Boolean).join(' · ')}</p>
      <ol>{d.recovery.steps.map((s,i)=><li key={i}>{translateMessage(s)}</li>)}</ol>
      <div className="button-row">
        {d.recovery.owner==='user'&&d.recovery.view&&go&&<button className="button" onClick={()=>go(d.recovery.view)}>{t('查看操作指引')}<ArrowRight size={14}/></button>}
        {!d.readAt&&<button className="text-button" onClick={async()=>{try{await window.workbench.call('aiui_diagnostics_mark_read',{diagnosticIds:d.records.map(r=>r.id)});await refresh();}catch(e){notify(e.message,true);}}}><Check size={14}/>{t('标记已读')}</button>}
      </div>
      <details><summary>{t('查看技术详情')}</summary>{d.records.map(r=><pre key={r.id}>{[r.message,r.stack,JSON.stringify({id:r.id,scope:r.scope,tool:r.tool,projectId:r.projectId,projectName:r.projectName,projectPath:r.projectPath,sessionId:r.sessionId,jobId:r.jobId,workflowId:r.workflowId,revision:r.revision,readAt:r.readAt,readBy:r.readBy,association:r.association,relatedProjectIds:r.relatedProjectIds,context:r.context,details:r.details},null,2)].filter(Boolean).join('\n\n')}</pre>)}<button className="text-button" onClick={async()=>{try{await window.workbench.call('aiui_diagnostics_resolve',{diagnosticIds:d.records.map(r=>r.id),note:'User confirmed the problem is fixed'});await refresh();}catch(e){notify(e.message,true);}}}>{t('标记已处理')}<ArrowRight size={14}/></button></details>
    </article>})}
    {data.hasMore&&<p className="muted-copy">{t('还有更多诊断，请按项目筛选查看。')}</p>}
  </section>;
}
