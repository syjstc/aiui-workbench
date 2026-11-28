import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Copy, Download, Glasses, Monitor, Plug, RefreshCw, Sparkles } from 'lucide-react';
import { getLocale, t } from './i18n.jsx';
import { CodeBlock } from './code-block.jsx';
import { McpCapabilities } from './mcp-capabilities.jsx';
import { readIdeaDraft, saveIdeaDraft } from './ai-prompts.mjs';
import { buildConnectionPrompt, connectionReady } from './ai-connection.mjs';
import { SkillLibrary } from './skill-library.jsx';
import { StatusLabel } from './status-label.jsx';
import './ai-panels.css';
import './connect-page.css';

const api = window.workbench;
const capabilities = [
  [Sparkles, '创建和修改项目', '从一句想法开始，或继续修改当前项目。'],
  [Monitor, '模拟和排查', '运行应用、测试眼镜输入，读取截图和日志。'],
  [Glasses, '打包和交付', '生成 AIX、安装到已连接的眼镜，或准备上传和提审材料。'],
];
let storage;
try { storage = globalThis.localStorage; } catch {}

export function ConnectPage({ state, serviceError, project, copyConfig, notify, go }) {
  const [section, setSection] = useState('connect');
  const [config, setConfig] = useState(null);
  const [idea, setIdea] = useState(() => readIdeaDraft(storage, project?.id));
  const [withIdea, setWithIdea] = useState(() => !!idea);
  const [saved, setSaved] = useState(true);
  const [copied, setCopied] = useState(false);
  const [configError, setConfigError] = useState(false);
  const ready = !serviceError && connectionReady(state);
  const proof = state?.aiConnection;
  async function loadConfig() {
    setConfigError(false);
    try { setConfig(await api.call('aiui_mcp_config')); }
    catch { setConfigError(true); }
  }
  useEffect(() => { if (section === 'connect' && !config) loadConfig(); }, [section]);
  const prompt = buildConnectionPrompt({ config, idea: withIdea ? idea : '', project, serviceVersion: state?.version, locale: getLocale() });
  function updateIdea(value) {
    setIdea(value);
    setSaved(saveIdeaDraft(storage, project?.id, value));
    setCopied(false);
  }
  async function copySetup() {
    try {
      await api.copy(prompt);
      setCopied(true);
      notify(t('连接指令已复制，粘贴给你的 AI 即可'));
    } catch (error) { notify(error.message, true); }
  }
  return <>
    <div className="page-heading ai-tools-heading">
      <div><h1>{t('连接 AI 工具')}</h1><p>{t('用你熟悉的 AI 创建、调试和交付眼镜应用。')}</p></div>
      <StatusLabel tone={ready ? 'ready' : state || serviceError ? 'idle' : 'working'}>{t(serviceError ? '状态未知' : ready ? '已连接' : state ? '未连接' : '检查中')}</StatusLabel>
    </div>
    <nav className="workspace-tabs ai-tools-tabs" aria-label={t('AI 工具')}>
      <button type="button" aria-current={section === 'connect' ? 'page' : undefined} onClick={() => setSection('connect')}><Plug size={16}/>{t('连接')}</button>
      <button type="button" aria-current={section === 'skills' ? 'page' : undefined} onClick={() => setSection('skills')}><BookOpen size={16}/>{t('Skill 库')}</button>
    </nav>
    {section === 'skills' ? <SkillLibrary api={api} project={project} knowledgeRevision={state?.knowledge?.revision} notify={notify}/> : <>
      <div className="ai-connect-grid">
        <section className="panel ai-connect-command">
          <h2>{t('复制连接指令，发给 AI')}</h2>
          <p>{t('把指令粘贴到 AI 聊天。AI 会配置 MCP、检查开发环境，并按任务读取对应 Skill。')}</p>
          {project && <p className="connect-project-name">{t('将继续当前项目：{0}', { 0: project.name })}</p>}
          <div className="ai-connect-actions">
            <button className="button primary" disabled={!config || !state || serviceError} onClick={copySetup}>{copied ? <Check size={16}/> : <Copy size={16}/>} {t(copied ? '已复制，去 AI 工具粘贴' : '复制完整连接指令')}</button>
            {ready && <button className="button" onClick={() => go(project ? 'project' : 'projects')}>{t(project ? '回到当前项目' : '查看我的项目')}<ArrowRight size={15}/></button>}
          </div>
          <p className="connect-confirmation" role="status">{t(serviceError ? '本地服务未连接' : ready
            ? '工坊已收到 AI 的成功调用。'
            : proof?.verifiedAt ? '此前连接过。请让 AI 重新读取当前工坊。'
              : 'AI 成功读取工坊后，状态会自动更新。')}</p>
          {configError && <div className="connect-copy-warning" role="alert"><p>{t('连接配置暂时未读到，请重新检查。')}</p><button className="text-button" onClick={loadConfig}><RefreshCw size={14}/>{t('重新检查')}</button></div>}
          <div className="ai-connect-idea">
            <label><input type="checkbox" checked={withIdea} onChange={event => { setWithIdea(event.target.checked); setCopied(false); }}/>{t('随指令带上想法')}</label>
            {withIdea && <><textarea aria-label={t(project ? '这次想改什么？' : '有想法，也可以一起告诉 AI')} maxLength={6000} value={idea}
              onChange={event => updateIdea(event.target.value)} placeholder={t('比如：做一个眼镜上的清单，滑动选择、单击勾选，自动保存。')}/>
              {!saved && <p className="connect-copy-warning" role="status">{t('暂时无法保存，离开前请先复制')}</p>}</>}
          </div>
        </section>
        <section className="panel ai-connect-capabilities">
          <h2>{t('可以交给 AI 的事')}</h2>
          <ul>{capabilities.map(([Icon, title, body]) => <li key={title}><Icon size={18}/><div><h3>{t(title)}</h3><p>{t(body)}</p></div></li>)}</ul>
          <button className="text-button" onClick={() => setSection('skills')}>{t('查看内置和官方 Skill')}<ArrowRight size={15}/></button>
        </section>
      </div>
      <details className="connect-advanced">
        <summary>{t('手动配置与高级选项')}</summary>
        <p className="muted-copy">{t('在 AI 工具设置中添加本地 MCP 服务，粘贴下面的配置。复制配置本身不会显示为连接成功。')}</p>
        <div className="button-row">
          <button className="button" disabled={!config} onClick={copyConfig}><Copy size={16}/>{t('复制 MCP 配置')}</button>
          {project && <button className="button" onClick={async () => {
            try { await api.call('aiui_mcp_install_project', { projectId: project.id }); notify(t('项目已配置 MCP')); }
            catch (error) { notify(error.message, true); }
          }}><Download size={15}/>{t('写入当前项目配置')}</button>}
        </div>
        <CodeBlock code={JSON.stringify(config || {}, null, 2)} language="json" className="config-code"/>
        <p className="subtle">{t('项目配置适用于支持 .mcp.json 的工具；其他工具使用手动配置。')}</p>
        <dl className="connect-version"><div><dt>{t('工坊服务')}</dt><dd>{state?.version || '—'}</dd></div><div><dt>{t('实际工具数量')}</dt><dd>{proof?.toolCount ?? '—'}</dd></div><div><dt>{t('本机配置标识')}</dt><dd>{proof?.profileId || '—'}</dd></div><div><dt>Runtime / CLI</dt><dd>{state?.runtime || '—'} / {state?.cliVersion || '—'}</dd></div></dl>
        <details><summary>{t('查看将发给 AI 的完整指令')}</summary><pre className="connect-prompt-preview">{prompt}</pre></details>
      </details>
      <details className="connect-advanced"><summary>{t('查看 AI 可用的全部能力')}</summary><McpCapabilities project={project} notify={notify}/></details>
    </>}
  </>;
}
