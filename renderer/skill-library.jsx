import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, Copy, FolderCode, LibraryBig } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkHeadingAnchors } from '../core/document-content.mjs';
import { CodeBlock, MarkdownCode } from './code-block.jsx';
import { t } from './i18n.jsx';
import { StatusLabel } from './status-label.jsx';

const descriptions = {
  'aiui-workshop': '连接 AI、模拟验证、交付及排障的工坊流程。',
  'aiui-dev': '制作 AIUI 页面、组件和应用逻辑。',
  'aiui-debug': '根据运行日志和设备信息定位问题。',
  'aiui-optimize': '分析 AIX 体积，优化图片、音频和打包内容。',
  'aiui-cloud-apis': '在应用内接入 Rokid 官方开放 API。',
  'aiui-cloud-integration': '将服务端 AI 与 Rokid 账号、消息和眼镜通知集成。',
};
const skillPriority = new Map(Object.keys(descriptions).map((name, index) => [name, index]));
const referenceTitles = {
  'references/connection.md': '连接 AI 工具',
  'references/verification.md': '模拟与真机验证',
  'references/simulator-ai.md': 'AI 自动化模拟验证',
  'references/project-lessons.md': '常见问题',
  'references/asset-optimization.md': '素材优化',
  'references/optimization.md': '游戏性能',
};
const skillOrigin = 'https://skill.local';
const fileName = path => path.split('/').at(-1);

async function readSkill(api, skill, path) {
  if (!skill.revision) return api.call('aiui_skill_read', { path });
  let content = '', offset = 0, doc;
  do {
    doc = await api.call('aiui_docs_read', { path, revision: skill.revision, limit: 24000, offset });
    content += doc.content;
    offset = doc.nextOffset;
  } while (offset != null);
  return { ...doc, content };
}

export function SkillLibrary({ api, project, knowledgeRevision, notify }) {
  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState(null);
  const [entry, setEntry] = useState(null);
  const reader = useRef(null);
  const projectId = project?.id;
  useEffect(() => {
    let active = true;
    setIndexError(false);
    api.call('ui_skill_catalog', projectId ? { projectId } : {})
      .then(value => { if (active) setIndex(value); })
      .catch(() => { if (active) setIndexError(true); });
    return () => { active = false; };
  }, [api, projectId, project?.knowledgeRevision, knowledgeRevision, retry]);

  const official = index?.official.toSorted((left, right) =>
    (skillPriority.get(left.name) ?? skillPriority.size) - (skillPriority.get(right.name) ?? skillPriority.size)) ?? [];
  const items = index ? [index.workshop, ...official] : [];
  const skill = items.find(item => item.name === selection?.name);
  const path = skill && (skill.references.includes(selection.path) ? selection.path : skill.path);
  const entryKey = skill && [skill.name, skill.revision || skill.version, path, retry].join(':');
  useEffect(() => {
    if (!skill) return;
    let active = true;
    readSkill(api, skill, path).then(value => {
      if (active) setEntry({ key: entryKey, doc: value });
    }).catch(() => { if (active) setEntry({ key: entryKey, error: true }); });
    return () => { active = false; };
  }, [api, entryKey]);

  const activeEntry = entry?.key === entryKey ? entry : null;
  const doc = activeEntry?.doc;
  useEffect(() => {
    if (!doc || !selection?.fragment) return;
    reader.current?.querySelector('.skill-prose #' + CSS.escape(selection.fragment))?.scrollIntoView({ block: 'start' });
  }, [doc, selection]);

  function choose(item, file, { focus = false, fragment } = {}) {
    setSelection({ name: item.name, path: file || item.path, fragment });
    if (focus) requestAnimationFrame(() => reader.current?.focus({ preventScroll: true }));
  }
  function follow(event, href) {
    event.preventDefault();
    if (!href) return;
    try {
      const target = new URL(href, skillOrigin + '/' + path);
      if (target.origin === skillOrigin) {
        const nextPath = decodeURIComponent(target.pathname.slice(1));
        if (nextPath === skill.path || skill.references.includes(nextPath)) {
          choose(skill, nextPath, { fragment: decodeURIComponent(target.hash.slice(1)) });
          return;
        }
        if (skill.revision) {
          const page = `https://github.com/yodaos-project/AIUI/blob/${skill.revision}${target.pathname}${target.hash}`;
          api.openOfficial(page).catch(error => notify(error.message, true));
        }
      } else if (target.protocol === 'https:') {
        api.openOfficial(target.href).catch(error => notify(error.message, true));
      }
    } catch (error) { notify(error.message, true); }
  }
  function renderItem(item) {
    return <button type="button" key={item.name} className="skill-list-item" aria-pressed={skill?.name === item.name} onClick={() => choose(item, item.path, { focus: true })}>
      <BookOpen size={16}/><span><strong>{item.name}</strong><small>{descriptions[item.name] ? t(descriptions[item.name]) : item.description}</small></span><ChevronRight size={15}/>
    </button>;
  }

  if (indexError) return <div className="skill-message" role="alert">
    <StatusLabel tone="error">{t('Skill 目录暂时无法读取')}</StatusLabel>
    <button className="button" onClick={() => setRetry(value => value + 1)}>{t('重试')}</button>
  </div>;
  if (!index) return <StatusLabel tone="working">{t('正在读取 Skill 目录…')}</StatusLabel>;
  return <div className="skill-library">
    <aside className="skill-list" aria-label={t('Skill 目录')}>
      <h2>{t('工坊内置')}</h2>
      {renderItem(index.workshop)}
      <h2>{t('Rokid 官方')}</h2>
      {official.length ? official.map(renderItem) : <p>{t('官方 Skill 待同步。可以在「官方资料」里同步。')}</p>}
    </aside>
    <section className="skill-reader panel" tabIndex={-1} ref={reader} aria-label={t('Skill 正文')}>
      {!skill ? <div className="skill-placeholder"><LibraryBig size={31}/><h2>{t('选择一个 Skill')}</h2><p>{t('查看使用场景、原始说明和随附的参考资料。')}</p></div> : <>
        <div className="skill-reader-heading">
          <div><h2>{skill.name}</h2><p>{skill.revision
            ? t(skill.revision === project?.knowledgeRevision ? '项目绑定版本 {0}' : '官方资料版本 {0}', { 0: skill.revision.slice(0, 8) })
            : t('工坊内置 · v{0}', { 0: skill.version })}</p></div>
          {doc && <div className="button-row">
            <button className="button" onClick={() => api.copy(doc.content).then(() => notify(t('已复制 Skill 正文'))).catch(error => notify(error.message, true))}><Copy size={14}/>{t('复制正文')}</button>
            {doc.source && <button className="button" onClick={() => api.openOfficial(doc.source).catch(error => notify(error.message, true))}><ArrowUpRight size={14}/>{t('查看官方原文')}</button>}
          </div>}
        </div>
        {!!skill.references.length && <details key={skill.name} className="skill-references">
          <summary><FolderCode size={15}/>{t('正文与参考资料')}<ChevronRight size={15}/></summary>
          <div className="skill-file-list">{[skill.path, ...skill.references].map(file => <button type="button" key={file} aria-current={file === path ? 'page' : undefined} onClick={() => choose(skill, file)}>
            {referenceTitles[file] ? t(referenceTitles[file]) : file.split('/').slice(skill.revision ? 2 : 0).join('/')}
          </button>)}</div>
        </details>}
        {activeEntry?.error ? <div className="skill-message" role="alert"><StatusLabel tone="error">{t('暂时无法读取正文')}</StatusLabel><button className="button" onClick={() => setRetry(value => value + 1)}>{t('重试')}</button></div>
          : !doc ? <StatusLabel tone="working">{t('正在读取正文…')}</StatusLabel> : <div className="doc-prose skill-prose">
            {path !== skill.path && <h3>{referenceTitles[path] ? t(referenceTitles[path]) : fileName(path)}</h3>}
            {path.endsWith('.md') ? <Markdown remarkPlugins={[remarkGfm, remarkHeadingAnchors]} skipHtml components={{
              pre: MarkdownCode,
              a: ({ href, children }) => <a href={href} onClick={event => follow(event, href)}>{children}</a>,
              img: ({ alt }) => <span>{alt}</span>,
            }}>{doc.content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')}</Markdown>
              : <CodeBlock code={doc.content} language={path.split('.').at(-1)}/>}
          </div>}
      </>}
    </section>
  </div>;
}
