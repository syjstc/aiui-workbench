import React, { useEffect, useState } from 'react';
import { Copy, CheckCircle2, Hand } from 'lucide-react';
import { t } from './i18n.jsx';
import { CodeBlock } from './code-block.jsx';
import './mcp-capabilities.css';

export function McpCapabilities({ project, notify }) {
  const [catalog, setCatalog] = useState(null);
  useEffect(() => { let live=true; window.workbench.call('aiui_capabilities_get').then(value=>{if(live)setCatalog(value);}).catch(error=>{if(live)notify(error.message,true);});return()=>{live=false;}; }, []);
  function request(capability) {
    const args=JSON.parse(JSON.stringify(capability.example).replaceAll('<projectId>',project?.id||'<projectId>'));
    return JSON.stringify({name:capability.tool,arguments:args},null,2);
  }
  async function copy(capability) { try { await window.workbench.copy(request(capability)); notify(t('能力调用示例已复制')); } catch(error) { notify(error.message,true); } }
  return <section className="mcp-capabilities" aria-label={t('连接后，AI 可以做什么')}>
    <div className="section-heading"><h2>{t('连接后，AI 可以做什么')}</h2></div>
    <p className="muted-copy">{t('把运行、等待与结果核对交给工坊。AI 继续使用自己的编码工具修改同一份源码。')}</p>
    {!catalog?<p className="subtle">{t('正在读取能力…')}</p>:<div className="mcp-capability-grid">{catalog.capabilities.map(capability=><article className={'panel mcp-capability '+(capability.status==='manual'?'manual':'')} key={capability.id} data-capability-id={capability.id}>
      <div className="section-heading"><h3>{t(capability.title)}</h3><span className={'pill '+(capability.status==='available'?'success':'')}>{capability.status==='available'?<CheckCircle2 size={12}/>:<Hand size={12}/>} {capability.status==='available'?t('可调用'):t('需手动完成')}</span></div>
      <p>{t(capability.description)}</p>
      <details><summary><code>{capability.tool}</code><span>{t('查看调用示例')}</span></summary><CodeBlock code={request(capability)} language="json"/><button className="text-button" onClick={()=>copy(capability)}><Copy size={14}/>{t('复制调用示例')}</button>{capability.relatedTools&&<p className="subtle mcp-related">{capability.relatedTools.join(' · ')}</p>}</details>
    </article>)}</div>}
    <p className="subtle">{t('模拟测试默认等待 45 秒并返回截图、日志和报告；任务仍在运行时，AI 可以继续等待。状态与日志断言通过后，仍需查看画面并进行佩戴验收。')}</p>
  </section>;
}
