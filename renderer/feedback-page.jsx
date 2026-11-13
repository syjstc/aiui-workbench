import React,{useEffect,useState,useRef} from 'react';
import {MessageSquare,RefreshCw,ExternalLink,Send,FileText,CheckCircle2,ShieldCheck,Trash2,Undo2} from 'lucide-react';
import {t,translateMessage} from './i18n.jsx';
import './feedback-page.css';

const empty=()=>({kind:'workbench-bug',title:'',description:'',steps:'',expected:'',actual:'',diagnosticIds:[]});
const validate=form=>({title:form.title.trim().length<5?'反馈标题至少需要 5 个字符':'',description:form.description.trim().length<20?'详细描述至少需要 20 个字符':''});
const canDelete=record=>record&&!record.issue&&['draft','failed'].includes(record.stage);
function DeleteDraftDialog({record,busy,error,onClose,onConfirm}){
  const dialog=useRef(null);
  useEffect(()=>{const node=dialog.current;node.showModal();return()=>node.close();},[]);
  return <dialog ref={dialog} className="feedback-delete-dialog" aria-labelledby="feedback-delete-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <h2 id="feedback-delete-title">{t('删除这条未提交反馈？')}</h2><p className="feedback-delete-title">{record.title}</p><p className="subtle">{t('删除后可撤销，不会影响其他反馈或 GitHub issue。')}</p>
    {error&&<p role="alert" className="feedback-error">{translateMessage(error)}</p>}
    <div className="button-row"><button autoFocus className="button" disabled={busy} onClick={onClose}>{t('取消')}</button><button className="button danger" disabled={busy} onClick={onConfirm}><Trash2 size={15}/>{t(busy?'正在删除…':'删除草稿')}</button></div>
  </dialog>;
}
export function FeedbackPage({api}){
  const [state,setState]=useState(null),[form,setForm]=useState(empty),[preview,setPreview]=useState(null);
  const [diagnostics,setDiagnostics]=useState([]),[busy,setBusy]=useState(''),[error,setError]=useState(''),[attempted,setAttempted]=useState(false);
  const [deleteCandidate,setDeleteCandidate]=useState(null),[deleted,setDeleted]=useState(null);
  const previewPanel=useRef(null),titleInput=useRef(null),descriptionInput=useRef(null),undoButton=useRef(null);
  async function refresh(){
    const [data,records]=await Promise.all([api.call('aiui_feedback_status'),api.call('aiui_diagnostics_get',{scope:'workbench',markRead:false,limit:50})]);
    setState(data);setDiagnostics(records.items.filter(r=>!r.projectId&&!r.sessionId&&!r.workflowId));
    return data;
  }
  useEffect(()=>{let alive=true;refresh().catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[]);
  useEffect(()=>{if(preview){previewPanel.current?.scrollIntoView({behavior:'auto',block:'start'});previewPanel.current?.focus({preventScroll:true});}},[preview?.id]);
  useEffect(()=>{if(deleted)undoButton.current?.focus();},[deleted?.id]);
  async function perform(name,action){setBusy(name);setError('');try{return await action();}catch(e){setError(e.message);}finally{setBusy('');}}
  const target=state?.target,targetMatches=!!preview&&preview.target.identity===target?.identity,fieldErrors=attempted?validate(form):{};
  function edit(key,value){setForm(current=>({...current,[key]:value,...(key==='kind'?{diagnosticIds:[]}: {})}));setPreview(null);setError('');}
  function select(record){setPreview(record);setForm(record.input||empty());setAttempted(false);setError('');}
  function prepare(event){event.preventDefault();setAttempted(true);const errors=validate(form);if(errors.title||errors.description){(errors.title?titleInput:descriptionInput).current?.focus();return;}perform('prepare',async()=>{const record=await api.call('aiui_feedback_prepare',form);setPreview(record);await refresh();});}
  async function send(method){await perform(method,async()=>{const record=await api.feedback(method,{draftId:preview.id,digest:preview.digest});setPreview(record);await refresh();});}
  function requestDelete(record){setError('');setDeleteCandidate(record);}
  function remove(){const record=deleteCandidate;perform('delete',async()=>{await api.feedback('delete',{draftId:record.id,digest:record.digest});setState(current=>({...current,records:current.records.filter(r=>r.id!==record.id)}));setDeleteCandidate(null);setDeleted(record);if(preview?.id===record.id){setPreview(null);setForm(empty());setAttempted(false);}});}
  function restore(){const record=deleted;perform('restore',async()=>{const restored=await api.feedback('restore',{draftId:record.id,digest:record.digest});setState(current=>({...current,records:[restored,...current.records.filter(r=>r.id!==restored.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}));setDeleted(null);select(restored);});}
  return <>
    <div className="page-heading"><div><h1>{t('反馈与建议')}</h1><p>{t('反馈工坊自身的问题，或提出你希望改进的功能。')}</p></div><button className="button" disabled={!!busy} onClick={()=>perform('refresh',refresh)}><RefreshCw size={15}/>{t('刷新')}</button></div>
    {deleted&&<div className="feedback-deleted" role="status"><span>{t('已删除未提交反馈')}</span><button ref={undoButton} className="text-button" disabled={!!busy} onClick={restore}><Undo2 size={15}/>{t('撤销删除')}</button></div>}
    <div className="feedback-layout">
      <div className="feedback-editor">
        <section className="panel feedback-target"><MessageSquare size={20}/><div><h2>{t('提交到更新源仓库')}</h2>{target?.supported?<button className="text-button" onClick={()=>perform('open',()=>api.openOfficial(target.url))}>{target.repository}<ExternalLink size={13}/></button>:<p>{target?translateMessage(target.reason):t('正在读取反馈设置…')}</p>}<p className="subtle">{t('跟随设置中已保存的更新源；更换仓库后需要重新预览。')}</p></div></section>
        <form className="panel feedback-form" noValidate onSubmit={prepare}>
          <h2>{t('写反馈')}</h2><p className="muted-copy">{t('直接填写工坊的问题或建议即可，无需连接 AI。应用代码错误、设备未授权等情况，请先在原项目中排查。')}</p>
          <label className="field">{t('反馈类型')}<select aria-label={t('反馈类型')} value={form.kind} onChange={e=>edit('kind',e.target.value)} disabled={!!busy}><option value="workbench-bug">{t('工坊自身问题')}</option><option value="suggestion">{t('功能建议')}</option></select></label>
          <label className="field">{t('反馈标题')}<input ref={titleInput} aria-label={t('反馈标题')} aria-invalid={!!fieldErrors.title} aria-describedby={fieldErrors.title?'feedback-title-error':undefined} value={form.title} maxLength={160} onChange={e=>edit('title',e.target.value)} disabled={!!busy} placeholder={t('简要说明问题或建议（至少 5 个字符）')}/>{fieldErrors.title&&<span id="feedback-title-error" className="feedback-error" role="alert">{t(fieldErrors.title)}</span>}</label>
          <label className="field">{t('详细描述')}<textarea ref={descriptionInput} aria-label={t('详细描述')} aria-invalid={!!fieldErrors.description} aria-describedby={fieldErrors.description?'feedback-description-error':undefined} value={form.description} maxLength={6000} rows={5} onChange={e=>edit('description',e.target.value)} disabled={!!busy} placeholder={t('至少 20 字，描述你遇到的现象或希望怎样改进')}/>{fieldErrors.description&&<span id="feedback-description-error" className="feedback-error" role="alert">{t(fieldErrors.description)}</span>}</label>
          {form.kind==='workbench-bug'&&<details className="feedback-extra"><summary>{t('补充复现步骤与预期（可选）')}</summary>{[['steps','复现步骤'],['expected','期望结果'],['actual','实际结果']].map(([key,label])=><label className="field" key={key}>{t(label)}<textarea rows={2} maxLength={key==='steps'?3000:2000} value={form[key]} onChange={e=>edit(key,e.target.value)} disabled={!!busy}/></label>)}{diagnostics.length>0&&<fieldset className="feedback-diagnostics"><legend>{t('选择相关工坊诊断（最多 5 条）')}</legend>{diagnostics.map(d=><label key={d.id}><input type="checkbox" checked={form.diagnosticIds.includes(d.id)} disabled={!!busy||(!form.diagnosticIds.includes(d.id)&&form.diagnosticIds.length>=5)} onChange={e=>edit('diagnosticIds',e.target.checked?[...form.diagnosticIds,d.id]:form.diagnosticIds.filter(id=>id!==d.id))}/><span>{d.message.slice(0,140)}</span></label>)}</fieldset>}</details>}
          <p className="subtle">{t('预览包含填写内容、基础版本和所选诊断摘要。本机按固定规则隐藏路径、凭据及设备标识，请核对预览；源码与照片不上传。')}</p>
          <button type="submit" className="button primary" disabled={!!busy}><FileText size={15}/>{t(busy==='prepare'?'正在生成预览…':'生成反馈预览')}</button>
        </form>
        {error&&!deleteCandidate&&<p role="alert" className="feedback-error">{translateMessage(error)}</p>}
        {preview&&<section ref={previewPanel} tabIndex={-1} className="panel feedback-preview" aria-label={t('公开内容预览')}>
          <div className="section-heading"><h2>{t('公开内容预览')}</h2><span className="pill">{preview.target.repository}</span></div><h3>{preview.title}</h3><pre>{preview.body.replace(/<!--\s*aiui-workshop-feedback:[\s\S]*?-->/g,'').trim()}</pre>
          {preview.issue?<div className="feedback-success"><CheckCircle2 size={18}/><div><strong>{t(preview.stage==='duplicate'?'已关联相同 issue':'反馈已提交')}</strong><button className="text-button" onClick={()=>perform('open',()=>api.openOfficial(preview.issue.url))}>#{preview.issue.number}<ExternalLink size={13}/></button></div></div>:<>
            {!targetMatches&&<p className="feedback-error">{t('更新源仓库已变化，请重新生成反馈预览')}</p>}
            {preview.error&&<p role="status" className="feedback-error">{translateMessage(preview.error)}</p>}
            <div className="button-row">{preview.stage==='unknown'?<button className="button" disabled={!!busy||!targetMatches||!state?.service.available} onClick={()=>send('reconcile')}><RefreshCw size={15}/>{t('核对提交结果')}</button>:<button className="button primary" disabled={!!busy||!targetMatches||!state?.service.available||preview.stage==='submitting'} onClick={()=>send('submit')}><Send size={15}/>{t(busy==='submit'?'正在提交…':'提交此反馈到 GitHub')}</button>}{canDelete(preview)&&<button className="button" disabled={!!busy} onClick={()=>requestDelete(preview)}><Trash2 size={15}/>{t('删除草稿')}</button>}</div>
            <p className="subtle">{t('点击提交会公开上方内容；相同反馈会去重，每分钟最多一次、每天最多三次。')}</p>
          </>}
        </section>}
      </div>
      <aside className="feedback-side">
        <section className="panel feedback-account"><h2><ShieldCheck size={16}/>{t('统一反馈机器人')}</h2><p className="muted-copy">{t('无需 GitHub 账号或验证码，核对预览后即可提交到当前更新源仓库。')}</p><p className="subtle">{t('仅接受工坊自身问题及用户建议，服务端也会去重和限制提交频率。')}</p>{state&&!state.service.available&&<p className="feedback-error">{state.service.error?translateMessage(state.service.error):t('反馈机器人尚未部署，可以先保存预览')}</p>}</section>
        <section className="panel feedback-history"><h2>{t('反馈记录')}</h2>{state?.records.length?state.records.slice(0,12).map(record=><div className="feedback-record-row" key={record.id}><button className={'feedback-record '+(preview?.id===record.id?'selected':'')} disabled={!!busy} onClick={()=>select(record)}><strong>{record.title}</strong><span>{t(record.issue?'已关联 issue':record.stage==='unknown'?'结果待核对':record.stage==='failed'?'提交未成功':'待提交')} · {record.target.repository}</span></button>{canDelete(record)&&<button className="feedback-delete-button" disabled={!!busy} aria-label={t('删除草稿：{0}',{0:record.title})} title={t('删除草稿')} onClick={()=>requestDelete(record)}><Trash2 size={15}/></button>}</div>):<p className="subtle">{t('尚无反馈。生成的预览和提交结果会保存在这里。')}</p>}</section>
      </aside>
    </div>
    {deleteCandidate&&<DeleteDraftDialog record={deleteCandidate} busy={!!busy} error={error} onClose={()=>{setDeleteCandidate(null);setError('');}} onConfirm={remove}/>}
  </>;
}
