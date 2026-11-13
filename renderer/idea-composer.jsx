import React,{useId,useState} from 'react';
import {ArrowRight,Check,ChevronDown,Copy,Sparkles} from 'lucide-react';
import {getLocale,t} from './i18n.jsx';
import {buildAiPrompt,readIdeaDraft,saveIdeaDraft} from './ai-prompts.mjs';
import {connectionReady} from './ai-connection.mjs';

const presets=[['refine','继续完善'],['recover','检查修复'],['validate','验证打包'],['install','装到眼镜']];
let storage;try{storage=globalThis.localStorage;}catch{}
export function IdeaComposer({project,flow,state,onConnect,api,notify,compact=false}){
  const id=useId(),[idea,setIdea]=useState(()=>readIdeaDraft(storage,project?.id)),[intent,setIntent]=useState(project?'refine':'create'),[copied,setCopied]=useState(false),[saved,setSaved]=useState(()=>idea?true:null);
  const ready=connectionReady(state),prompt=buildAiPrompt({idea,intent,project,flow,features:state?.aiConnection?.features,locale:getLocale()}),canCopy=!!project||!!idea.trim();
  function update(text){setIdea(text);setCopied(false);setSaved(saveIdeaDraft(storage,project?.id,text));}
  async function copy(){if(!ready&&onConnect){onConnect();return;}try{await api.copy(prompt);setCopied(true);notify(t('已复制，粘贴到你的 AI 工具即可'));}catch(error){notify(error.message,true);}}
  return <section className={'idea-composer '+(compact?'compact':'')} aria-labelledby={id+'-title'}>
    <div className="idea-composer-heading"><Sparkles size={18}/><h2 id={id+'-title'}>{t(project?'和 AI 一起完善':'写下你的想法')}</h2><span>{t('可选')}</span></div>
    <p className="idea-composer-intro">{t('可以在这里整理，也可以直接去 AI 工具里描述。')}</p>
    {project&&<div className="idea-presets" role="group" aria-label={t('预置 AI 指令')}>{presets.map(([key,label])=><button type="button" key={key} aria-pressed={intent===key} className={intent===key?'selected':''} onClick={()=>{setIntent(key);setCopied(false);}}>{t(label)}</button>)}</div>}
    <label htmlFor={id+'-idea'}>{t(project?'这次想改什么？':'你想在眼镜上做什么？')}</label>
    <textarea id={id+'-idea'} maxLength={6000} value={idea} placeholder={t(project?'比如：加一个今日目标，完成时给我一个简短提醒。':'比如：做一个呼吸练习应用，用简洁的动画引导节奏，滑动切换练习时长。')} onChange={e=>update(e.target.value)}/>
    {!project&&<div className="idea-examples"><span>{t('试试这些想法')}</span>{[['随手清单','做一个随手清单，滑动选择、单击勾选，自动保存进度。'],['呼吸练习','做一个呼吸练习应用，用简洁的动画引导节奏，滑动切换练习时长。'],['记单词','做一个记单词应用，显示单词和释义，滑动翻卡，记住学习进度。']].map(([label,text])=><button type="button" key={label} onClick={()=>update(t(text))}>{t(label)}</button>)}</div>}
    <div className="idea-draft-status" aria-live="polite">{saved===true?t('想法已保存在这台电脑'):saved===false?t('暂时无法保存，离开前请先复制'):t('填写后会自动整理成 AI 指令')}</div>
    <button type="button" className="button primary idea-copy" disabled={!canCopy||!state} onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>} {t(!ready?'连接 AI 并继续':copied?'已复制指令':'复制给 AI')}<ArrowRight size={15}/></button>
    <p className="idea-copy-help">{t(!ready?'先让 AI 连上工坊。你的想法会一起带过去。':project?'指令会带上当前项目和任务，AI 可以接着做。':'粘贴到已连接工坊的 AI，创建后项目会出现在这里。')}</p>
    {canCopy&&<details className="idea-generated"><summary>{t('查看生成的指令')}<ChevronDown size={14}/></summary><textarea aria-label={t('可发送给 AI 的指令')} value={prompt} readOnly spellCheck={false}/></details>}
  </section>;
}
