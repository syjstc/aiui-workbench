import React,{useEffect,useState} from 'react';
import {ArrowRight,Check,CheckCircle2,Copy,Download,Plug,RefreshCw} from 'lucide-react';
import {getLocale,t} from './i18n.jsx';
import {CodeBlock} from './code-block.jsx';
import {McpCapabilities} from './mcp-capabilities.jsx';
import {readIdeaDraft,saveIdeaDraft} from './ai-prompts.mjs';
import {buildConnectionPrompt,connectionReady} from './ai-connection.mjs';
import './ai-panels.css';

let storage;try{storage=globalThis.localStorage;}catch{}
export function ConnectPage({state,project,copyConfig,notify,go}){
  const[config,setConfig]=useState(null),[idea,setIdea]=useState(()=>readIdeaDraft(storage,project?.id)),[saved,setSaved]=useState(true),[copied,setCopied]=useState(false),[configError,setConfigError]=useState('');
  const ready=connectionReady(state),proof=state?.aiConnection;
  async function loadConfig(){setConfigError('');try{setConfig(await window.workbench.call('aiui_mcp_config'));}catch(e){setConfigError(e.message);}}
  useEffect(()=>{loadConfig();},[]);
  const prompt=buildConnectionPrompt({config,idea,project,serviceVersion:state?.version,locale:getLocale()});
  function updateIdea(value){setIdea(value);setSaved(saveIdeaDraft(storage,project?.id,value));setCopied(false);}
  async function copySetup(){try{await window.workbench.copy(prompt);setCopied(true);notify(t('连接指令已复制，粘贴给你的 AI 即可'));}catch(e){notify(e.message,true);}}
  return <>
    <div className="page-heading"><div><h1>{t('连接 AI 工具')}</h1><p>{t('复制一次，让 AI 准备好，再一起做应用。')}</p></div><span className={'pill '+(ready?'success':'')}>{ready?<><CheckCircle2 size={14}/>{t('AI 已成功读取工坊')}</>:!state?t('正在检查连接'):t('等待 AI 完成连接检查')}</span></div>
    <div className="connect-welcome">
      <section className="connect-command panel"><div className="connect-command-title"><Plug size={22}/><div><h2>{t('把这句话发给你的 AI')}</h2><p>{t('继续使用熟悉的 AI 工具，配置和开发指引交给它准备。')}</p></div></div>
        <blockquote>{t('连接 AIUI 工坊，准备好开发环境，然后问我想做什么。')}</blockquote>
        <label htmlFor="setup-idea">{t(project?'这次想改什么？':'有想法，也可以一起告诉 AI')} <span>{t('可选')}</span></label>
        {project&&<p className="subtle">{t('将继续当前项目：{0}',{0:project.name})}</p>}
        <textarea id="setup-idea" maxLength={6000} value={idea} onChange={e=>updateIdea(e.target.value)} placeholder={t('比如：做一个眼镜上的清单，滑动选择、单击勾选，自动保存。')}/>
        <p className="connect-idea-hint">{t('填了就直接开始制作；留空时，AI 准备好后会问你想做什么。')}</p>
        {!saved&&<p className="connect-copy-warning" role="status">{t('暂时无法保存，离开前请先复制')}</p>}
        <button className="button primary connect-copy-command" disabled={!config||!state} onClick={copySetup}>{copied?<Check size={17}/>:<Copy size={17}/>} {t(copied?'已复制，去 AI 里粘贴':'复制给 AI')}<ArrowRight size={16}/></button>
        {configError&&<div className="connect-copy-warning" role="alert"><p>{t('连接配置暂时未读到，请重新检查。')}</p><button className="text-button" onClick={loadConfig}><RefreshCw size={14}/>{t('重新检查')}</button></div>}
        <p className="connect-idea-hint">{t('指令包含本机连接配置，AI 可以直接使用，不需要你找路径。')}</p>
      </section>
      <section className="connect-expectations" aria-label={t('AI 会自动完成')}><h2>{t('接下来，AI 会帮你准备')}</h2>{[
        ['连接工坊','配置 MCP，并读取当前真实可用的工具。'],
        ['补齐开发指引','检测官方 Skill，缺少才安装；工坊只补流程，不重复。'],
        ['检查环境，开始制作','检查内置工具和眼镜状态；有想法就继续，没有就先问你。'],
      ].map(([title,body],i)=><div className="connect-expectation" key={title}><span className="connect-step-number">{i+1}</span><div><h3>{t(title)}</h3><p>{t(body)}</p></div></div>)}
      <div className={'connect-verification '+(ready?'is-ready':'')} role="status"><CheckCircle2 size={20}/><div><strong>{t(ready?'工坊已收到 AI 的成功调用':'复制配置后，还需要 AI 实际连接')}</strong><p>{t(ready?'连接已验证，可以在 AI 里继续描述想法。':'AI 读取规范成功后，这里会自动确认。')}</p>{proof?.verifiedAt&&!ready&&<p>{t('曾经连接过；请让 AI 重新读取当前工坊。')}</p>}</div></div>
      {ready&&<button className="button" onClick={()=>go(project?'project':'projects')}>{t(project?'回到当前项目':'查看我的项目')}<ArrowRight size={15}/></button>}
      </section>
    </div>
    <p className="connect-client-note">{t('如果 AI 无法修改自己的设置，它会告诉你具体点哪里。部分工具更新连接后需要重新打开聊天；想法会保留。')}</p>
    <details className="connect-advanced"><summary>{t('手动配置与高级选项')}</summary><p className="muted-copy">{t('在 AI 工具设置中添加本地 MCP 服务，粘贴下面的配置。复制配置本身不会显示为连接成功。')}</p><div className="button-row"><button className="button" onClick={copyConfig}><Copy size={16}/>{t('复制 MCP 配置')}</button>{project&&<button className="button" onClick={async()=>{try{await window.workbench.call('aiui_mcp_install_project',{projectId:project.id});notify(t('项目已配置 MCP'));}catch(e){notify(e.message,true);}}}><Download size={15}/>{t('写入当前项目配置')}</button>}</div><CodeBlock code={JSON.stringify(config||{},null,2)} language="json" className="config-code"/><p className="subtle">{t('项目配置适用于支持 .mcp.json 的工具；其他工具使用手动配置。')}</p><dl className="connect-version"><div><dt>{t('工坊服务')}</dt><dd>{state?.version||'—'}</dd></div><div><dt>{t('实际工具数量')}</dt><dd>{proof?.toolCount??'—'}</dd></div><div><dt>{t('本机配置标识')}</dt><dd>{proof?.profileId||'—'}</dd></div><div><dt>Runtime / CLI</dt><dd>{state?.runtime||'—'} / {state?.cliVersion||'—'}</dd></div></dl><details><summary>{t('查看将发给 AI 的完整指令')}</summary><pre className="connect-prompt-preview">{prompt}</pre></details></details>
    <details className="connect-advanced"><summary>{t('查看 AI 可用的全部能力')}</summary><McpCapabilities project={project} notify={notify}/></details>
  </>;
}
