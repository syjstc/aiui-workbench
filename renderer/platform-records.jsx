import React, {useEffect,useRef,useState} from 'react';
import {Package,ZoomIn,X} from 'lucide-react';
import {t} from './i18n.jsx';
import {OfficialAgentId} from './platform-agent-id.jsx';

function Icon({agent,large=false}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[agent.icon]);
  return agent.icon&&!failed?<img className={'official-app-icon'+(large?' large':'')} src={agent.icon} alt={t('应用图标 {0}',{0:agent.agentName})} loading="lazy" onError={()=>setFailed(true)}/>:<span className={'official-app-icon fallback'+(large?' large':'')}><Package size={large?28:19}/></span>;
}
function purposes(agent){
  for(const value of [agent.permissionsDesc,agent.needParam]){
    try{const result=typeof value==='string'?JSON.parse(value):value;if(result&&typeof result==='object'&&!Array.isArray(result)&&Object.keys(result).length)return result;}catch{}
  }
  return {};
}
function ImagePreview({image,onClose}){
  const dialog=useRef(null);
  useEffect(()=>{dialog.current.showModal();},[]);
  return <dialog ref={dialog} className="official-image-dialog" aria-label={image.title} onClose={onClose}>
    <header><strong>{image.title}</strong><button className="button" aria-label={t('关闭')} onClick={()=>dialog.current.close()}><X size={16}/>{t('关闭')}</button></header>
    <img src={image.url} alt={image.title}/>
  </dialog>;
}
function AgentContent({agent,onImage,onCopy}){
  const usage=purposes(agent),permissions=Array.isArray(agent.permissions)?agent.permissions.join('、'):agent.permissions;
  return <div className="official-agent-detail">
    <div className="official-agent-profile"><Icon agent={agent} large/><div><strong>{agent.agentName}</strong><p>{agent.categoryName||agent.category||'—'}</p><OfficialAgentId agentId={agent.agentId} onCopy={onCopy}/></div></div>
    <div className="official-agent-content"><section><dl>
      <dt>{t('功能介绍')}</dt><dd>{agent.description||t('官网未返回此内容')}</dd>
      <dt>{t('意图说明')}</dt><dd>{agent.agentPrompt||t('官网未返回此内容')}</dd>
      <dt>{t('开场白')}</dt><dd>{agent.prologue||t('官网未返回此内容')}</dd>
      {agent.versionLog&&<><dt>{t('更新日志')}</dt><dd>{agent.versionLog}</dd></>}
      <dt>{t('权限')}</dt><dd>{agent.permissions==null?t('官网未返回此内容'):permissions||t('无')}</dd>
      {!!Object.keys(usage).length&&<><dt>{t('权限用途')}</dt><dd>{Object.entries(usage).map(([name,value])=><p key={name}><strong>{name}</strong>：{typeof value==='string'?value:JSON.stringify(value)}</p>)}</dd></>}
    </dl><details className="official-digests"><summary>{t('包与代码摘要')}</summary><dl><dt>AIX MD5</dt><dd><code>{agent.fileMd5||'—'}</code></dd><dt>{t('代码草稿 MD5')}</dt><dd><code>{agent.codeFileMd5||'—'}</code></dd></dl></details></section>
    <section className="official-materials"><h3>{t('官方预览素材')}</h3><div className="official-material-grid">{agent.previewMaterials?.map((media,index)=>{
      const title=t('预览素材 {0}',{0:index+1});
      return <figure key={media.url}>{media.type==='video'?<video src={media.url} controls preload="metadata" aria-label={title}/>:<button className="official-image-button" aria-label={t('查看大图 {0}',{0:index+1})} onClick={()=>onImage({url:media.url,title})}><img src={media.url} alt={title} loading="lazy"/><span><ZoomIn size={14}/>{t('查看大图')}</span></button>}<figcaption>{title}</figcaption></figure>;
    })}</div>{!agent.previewMaterials?.length&&<p>{t('官网未返回此内容')}</p>}</section></div>
    <p className="publish-version-note">{t('以上为官网当前返回的内容，只读展示，不从本地草稿补齐。')}</p>
  </div>;
}
export function OfficialRecords({agents,boundAgentId,cloudStatus,onCopy}){
  const [image,setImage]=useState(null);
  return <><div className="platform-record-table"><table><thead><tr><th>{t('应用')}</th><th>{t('云端草稿版本')}</th><th>{t('审核版本')}</th><th>{t('已上架版本')}</th><th>{t('官方状态')}</th></tr></thead><tbody>{agents.map(agent=><React.Fragment key={agent.agentId}>
    <tr className={agent.agentId===boundAgentId?'platform-bound-row':''}><td><div className="official-app-summary"><Icon agent={agent}/><div><strong>{agent.agentName}</strong><OfficialAgentId agentId={agent.agentId} onCopy={onCopy}/><p>{agent.description||'—'}</p></div></div></td><td>{agent.nativeVersion||'—'}</td><td>{agent.reviewNativeVersion||'—'}</td><td>{agent.upNativeVersion||'—'}</td><td>{cloudStatus(agent)}</td></tr>
    <tr><td colSpan={5}><details className="official-agent-disclosure"><summary>{t('查看官方资料')} · {agent.agentName}</summary><AgentContent agent={agent} onImage={setImage} onCopy={onCopy}/></details></td></tr>
  </React.Fragment>)}</tbody></table></div>{image&&<ImagePreview image={image} onClose={()=>setImage(null)}/>}</>;
}
