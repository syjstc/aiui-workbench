import { t, getLocale, useLocale, translateMessage } from './i18n.jsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronRight, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { MarkdownCode } from './code-block.jsx';
import { documentLink } from '../core/document-links.mjs';
import { documentHeadings, headingId, headingSlugger, plainHeading } from '../core/document-content.mjs';

const api = window.workbench;
const call = (tool, args) => api.call(tool, args);
const headingText = node => typeof node?.value === 'string' ? node.value : (node?.children || []).map(headingText).join('');
function remarkHeadingAnchors({ title, removedTitle }) {
  return tree => {
    const slug = headingSlugger();
    if (removedTitle) slug(plainHeading(title));
    function walk(node) {
      if (node.type === 'heading') node.data = { ...node.data, hProperties: { id: slug(plainHeading(headingText(node))) } };
      for (const child of node.children || []) walk(child);
    }
    walk(tree);
  };
}
const headingComponents = Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(tag => [tag, ({ node, children }) => React.createElement(tag, { id: node.properties.id }, children)]));
const savedSort = () => { try { const value = localStorage.getItem('aiui-doc-sort'); return ['recommended', 'title', 'path'].includes(value) ? value : 'recommended'; } catch { return 'recommended'; } };
function navigationLocations(nodes, parents = [], result = new Map()) {
  for (const node of nodes) {
    const trail = [...parents, node];
    if (node.path) result.set(node.path, trail);
    navigationLocations(node.children, trail, result);
  }
  return result;
}
function Highlight({ text, terms = [] }) {
  const escaped = terms.filter(Boolean).sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return text;
  return text.split(new RegExp(`(${escaped.join('|')})`, 'gi')).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}
function DocumentImage({ src, alt, document, onPreview }) {
  const [image, setImage] = useState(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setImage(null); setError(false);
    call('aiui_docs_image', { path: src, from: document.path, revision: document.revision }).then(result => { if (!cancelled) setImage(result.dataUrl); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [src, document.path, document.revision, attempt]);
  if (error) return <span className="doc-image-status">{t('图片暂未加载')}<button className="text-button" onClick={() => setAttempt(value => value + 1)}>{t('重试')}</button></span>;
  if (!image) return <span className="doc-image-status"><LoaderCircle size={15} className="spin"/>{t('正在读取图片…')}</span>;
  return <span className="doc-image"><button aria-label={t('放大图片 {0}', { 0: alt || t('文档图示') })} onClick={() => onPreview({ src: image, alt })}><img src={image} alt={alt || t('文档图示')} onError={() => setError(true)}/></button></span>;
}
function DocumentTree({ nodes, expanded, selected, onToggle, onOpen }) {
  return <ul className="doc-tree">{nodes.map(node => <li key={node.id} data-node-id={node.id}>
    <div className={'doc-tree-row' + (selected && selected === node.path ? ' selected' : '')}>
      {node.children.length ? <button className="doc-tree-toggle" aria-label={t(expanded.has(node.id) ? '收起 {0}' : '展开 {0}', { 0: node.title })} aria-expanded={expanded.has(node.id)} onClick={() => onToggle(node.id)}><ChevronRight size={14}/></button> : <span className="doc-tree-indent"/>}
      <button className="doc-tree-label" title={node.path || node.title} aria-current={selected === node.path ? 'page' : undefined} onClick={() => node.path ? onOpen(node.path) : onToggle(node.id)}><span>{node.title}</span>{node.children.length > 0 && <small>{node.count}</small>}</button>
    </div>
    {node.children.length > 0 && expanded.has(node.id) && <DocumentTree nodes={node.children} expanded={expanded} selected={selected} onToggle={onToggle} onOpen={onOpen}/>}
  </li>)}</ul>;
}

export function KnowledgePage({ knowledge, running, startJob, notify }) {
  const locale = useLocale();
  const [query, setQuery] = useState(''), [results, setResults] = useState({ documents: [], total: 0 }), [catalog, setCatalog] = useState({ tree: [], documents: [] }), [doc, setDoc] = useState(null);
  const [searching, setSearching] = useState(false), [catalogLoading, setCatalogLoading] = useState(true), [loading, setLoading] = useState(false);
  const [sort, setSort] = useState(savedSort), [expanded, setExpanded] = useState(new Set());
  const [historyState, setHistoryState] = useState({ index: -1, length: 0 }), [fontSize, setFontSize] = useState(16), [previewImage, setPreviewImage] = useState(null);
  const [updateMode, setUpdateMode] = useState('24'), [savingUpdates, setSavingUpdates] = useState(false);
  const reader = useRef(), docList = useRef(), request = useRef(0), listRequest = useRef(0), selected = useRef(null), currentDoc = useRef(null);
  const history = useRef({ entries: [], index: -1 }), readerLocation = useRef(null);
  const syncing = running.filter(job => job.type === 'knowledge'), hasQuery = Boolean(query.trim());
  const locations = useMemo(() => navigationLocations(catalog.tree), [catalog.tree]);
  const headings = useMemo(() => doc ? documentHeadings(doc.content).filter(heading => heading.level === 2 || heading.level === 3) : [], [doc?.content]);
  const trail = locations.get(doc?.path) || [];

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    call('aiui_docs_catalog', { locale, sort, revision: knowledge?.revision }).then(result => {
      if (cancelled) return;
      setCatalog(result);
      const defaults = new Set();
      function walk(nodes) { for (const node of nodes) { if (node.expanded) defaults.add(node.id); walk(node.children); } }
      walk(result.tree);
      setExpanded(defaults);
      const preferred = selected.current && (locale === 'en' ? selected.current.replace(/(?<!\.en-US)\.md$/, '.en-US.md') : selected.current.replace(/\.en-US\.md$/, '.md'));
      if (preferred && preferred !== selected.current && result.documents.some(item => item.path === preferred)) openDocument(preferred, result.revision);
      else if (!selected.current) {
        const first = [...navigationLocations(result.tree).keys()][0];
        if (first) openDocument(first, result.revision);
      }
    }).catch(error => { if (!cancelled) notify(error.message, true); }).finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [locale, sort, knowledge?.revision]);
  useEffect(() => {
    const ancestors = locations.get(doc?.path);
    if (ancestors) setExpanded(previous => new Set([...previous, ...ancestors.map(node => node.id)]));
  }, [locations, doc?.path]);
  useEffect(() => {
    let cancelled = false;
    const current = ++listRequest.current;
    if (!hasQuery) { setSearching(false); setResults({ documents: [], total: 0 }); return; }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await call('aiui_docs_search', { query, sort, locale, limit: 1800, revision: knowledge?.revision });
        if (cancelled || current !== listRequest.current) return;
        setResults(result);
        if (docList.current) docList.current.scrollTop = 0;
      } catch (error) { if (!cancelled) notify(error.message, true); }
      finally { if (!cancelled) setSearching(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, sort, locale, knowledge?.revision]);
  useEffect(() => { try { localStorage.setItem('aiui-doc-sort', sort); } catch {} }, [sort]);
  useEffect(() => { setUpdateMode(knowledge?.autoUpdate === false ? 'manual' : String(knowledge?.intervalHours || 24)); }, [knowledge?.autoUpdate, knowledge?.intervalHours]);
  useEffect(() => () => { request.current++; listRequest.current++; }, []);
  useEffect(() => {
    if (!previewImage) return;
    const close = event => { if (event.key === 'Escape') setPreviewImage(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [previewImage]);

  function rememberPosition() {
    const current = history.current;
    if (current.index >= 0 && currentDoc.current) current.entries[current.index] = { document: currentDoc.current, scrollTop: reader.current?.scrollTop || 0 };
  }
  function displayDocument(value) {
    currentDoc.current = value; selected.current = value.path; setDoc(value);
    setHistoryState({ index: history.current.index, length: history.current.entries.length });
  }
  async function openDocument(path, revision = knowledge?.revision, from) {
    const current = ++request.current;
    selected.current = path; setLoading(true);
    try {
      let result = await call('aiui_docs_read', { path, revision, from, limit: 24000 });
      while (result.nextOffset !== null && result.nextOffset !== undefined) {
        if (current !== request.current) return;
        const next = await call('aiui_docs_read', { path: result.path, revision: result.revision, offset: result.nextOffset, limit: 24000 });
        result = { ...result, nextOffset: next.nextOffset, content: result.content + next.content };
      }
      if (current !== request.current) return;
      rememberPosition();
      const value = { ...result, locationKey: current }, previous = currentDoc.current;
      if (previous?.path === value.path && previous?.revision === value.revision && previous?.fragment === value.fragment) {
        displayDocument({ ...previous, restoreScrollTop: undefined, locationKey: current }); return;
      }
      history.current.entries = history.current.entries.slice(0, history.current.index + 1);
      history.current.entries.push({ document: value, scrollTop: 0 }); history.current.index++;
      displayDocument(value);
    } catch (error) { if (current === request.current) { selected.current = currentDoc.current?.path; notify(error.message, true); } }
    finally { if (current === request.current) setLoading(false); }
  }
  function navigateHistory(step) {
    const target = history.current.index + step, entry = history.current.entries[target];
    if (!entry) return;
    rememberPosition(); history.current.index = target; setLoading(false);
    displayDocument({ ...entry.document, restoreScrollTop: entry.scrollTop, locationKey: ++request.current });
  }
  function scrollToHeading(fragment) {
    let id;
    try { id = decodeURIComponent(fragment.replace(/^#/, '')); } catch { return false; }
    const target = [...(reader.current?.querySelectorAll('[id]') || [])].find(element => element.id === id);
    if (target && reader.current) reader.current.scrollTop += target.getBoundingClientRect().top - reader.current.getBoundingClientRect().top - 26;
    return Boolean(target);
  }
  useEffect(() => {
    if (readerLocation.current !== doc?.locationKey) {
      readerLocation.current = doc?.locationKey;
      if (reader.current) reader.current.scrollTop = doc?.restoreScrollTop ?? 0;
      if (doc?.fragment && doc.restoreScrollTop === undefined) scrollToHeading(doc.fragment);
    }
  }, [doc?.locationKey]);
  async function followLink(event, href) {
    event.preventDefault();
    try {
      if (documentLink(href, doc.path)) await openDocument(href, doc.revision, doc.path);
      else if (href) await api.openOfficial(href);
    } catch (error) { notify(error.message, true); }
  }
  async function changeUpdates(mode) {
    const previous = updateMode; setUpdateMode(mode); setSavingUpdates(true);
    try { await call('aiui_docs_settings', { autoUpdate: mode !== 'manual', ...(mode !== 'manual' ? { intervalHours: Number(mode) } : {}) }); }
    catch (error) { setUpdateMode(previous); notify(error.message, true); }
    finally { setSavingUpdates(false); }
  }
  function toggle(id) { setExpanded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  const firstHeading = doc?.content.match(/^# ([^\n]+)\n/);
  // Status polling must not replace Markdown nodes or refetch every image.
  // Keep renderer component identities stable for this document and language.
  const renderedMarkdown = useMemo(() => doc && <Markdown remarkPlugins={[[remarkHeadingAnchors, { title: firstHeading?.[1], removedTitle: Boolean(firstHeading) }], remarkGfm]} skipHtml components={{ ...headingComponents, pre: MarkdownCode, a: ({ href, children }) => <a href={href} onClick={event => followLink(event, href)}>{children}</a>, img: ({ src, alt }) => <DocumentImage src={src} alt={alt} document={doc} onPreview={setPreviewImage}/> }}>{firstHeading ? doc.content.slice(firstHeading[0].length) : doc.content}</Markdown>, [doc?.content, doc?.path, doc?.revision, locale]);
  return <>
    <div className="page-heading"><div><h1>{t('官方资料')}</h1><p>{t('按官方目录阅读，搜索全部正文与代码示例。')}</p></div><button className="button" disabled={syncing.length > 0 || knowledge?.syncing} onClick={() => startJob('aiui_docs_sync')}><RefreshCw size={16} className={syncing.length || knowledge?.syncing ? 'spin' : ''}/>{syncing.length || knowledge?.syncing ? t('正在同步') : t('同步资料')}</button></div>
    <div className="knowledge-meta"><span><BookOpen size={15}/>{knowledge?.revision ? t('{0} 份资料 · 可离线阅读', { 0: knowledge.documents }) : t('同步后即可离线阅读')}</span><span>{knowledge?.syncedAt && t('更新于 {0}', { 0: new Date(knowledge.syncedAt).toLocaleDateString(getLocale()) })}</span><button className="text-button" onClick={() => api.openOfficial('https://github.com/yodaos-project/AIUI')}>{t('官方来源')}<ArrowUpRight size={14}/></button></div>
    <div className="knowledge-updates"><label>{t('文档更新')}<select aria-label={t('文档自动更新')} value={updateMode} disabled={savingUpdates} onChange={event => changeUpdates(event.target.value)}><option value="24">{t('每天自动更新')}</option><option value="168">{t('每周自动更新')}</option><option value="manual">{t('仅手动更新')}</option></select></label><span title={knowledge?.nextCheckAt ? t('下次检查：{0}', { 0: new Date(knowledge.nextCheckAt).toLocaleString(getLocale()) }) : undefined}>{knowledge?.checkedAt ? t('最近检查：{0}', { 0: new Date(knowledge.checkedAt).toLocaleString(getLocale()) }) : t('启动时检查，保持离线资料可用。')}</span>{knowledge?.error && <span className="doc-update-error" title={knowledge.error}>{t('更新暂未完成，将自动重试。')}</span>}</div>
    {syncing.map(job => <div className="inline-progress" key={job.id}><LoaderCircle size={15} className="spin"/>{translateMessage(job.message)}</div>)}
    <div className="knowledge-layout">
      <aside className="doc-index" aria-label={t('文档目录')}>
        <div className="doc-search">
          <div className="search-box"><Search size={17}/><input aria-label={t('搜索官方资料')} placeholder={t('搜索全部文档、API、示例…')} value={query} onChange={event => setQuery(event.target.value)}/>{hasQuery && <button className="doc-search-clear" aria-label={t('清除文档搜索')} onClick={() => setQuery('')}><X size={14}/></button>}</div>
          <p className="doc-search-scope">{t('全文搜索全部 {0} 份资料，含未打开内容', { 0: knowledge?.documents || catalog.documents.length })}</p>
          <label className="doc-sort"><span>{t('排序')}</span><select aria-label={t('文档排序')} value={sort} onChange={event => setSort(event.target.value)}><option value="recommended">{hasQuery ? t('相关度优先') : t('官方目录顺序')}</option><option value="title">{t('标题（A–Z / 拼音）')}</option><option value="path">{t('文档路径')}</option></select></label>
          <div className="doc-list-label" role="status"><span>{hasQuery ? t('搜索结果') : t('文档目录')}</span><span>{searching || catalogLoading ? t('搜索中…') : t('{0} 篇', { 0: hasQuery ? results.total : catalog.total || 0 })}</span></div>
        </div>
        <div className="doc-list" ref={docList} tabIndex={0} aria-label={t('文档列表')} aria-busy={hasQuery ? searching : catalogLoading}>
          {hasQuery ? results.documents.map(result => <button key={result.path} aria-current={doc?.path === result.path ? 'page' : undefined} className={'doc-result' + (doc?.path === result.path ? ' selected' : '')} title={result.path} disabled={searching} onClick={() => openDocument(result.path + result.fragment, result.revision)}><div><strong><Highlight text={result.title} terms={result.matchedTerms}/></strong><small>{(locations.get(result.path) || []).map(node => node.title).join(' › ') || result.path}</small>{result.heading && <span className="doc-result-heading">{t('命中章节：{0}', { 0: result.heading })}</span>}<p className="doc-result-excerpt"><Highlight text={result.excerpt} terms={result.matchedTerms}/></p></div></button>) : <DocumentTree nodes={catalog.tree} expanded={expanded} selected={doc?.path} onToggle={toggle} onOpen={openDocument}/>}
          {hasQuery && !results.documents.length && <p className="doc-list-empty">{searching ? t('正在查找资料…') : t('没有找到相关资料，试试其他关键词。')}</p>}
          {!hasQuery && !catalog.tree.length && <p className="doc-list-empty">{catalogLoading ? t('正在查找资料…') : t('同步官方资料后，即可在这里阅读。')}</p>}
        </div>
      </aside>
      <article className="doc-reader" aria-busy={loading}>
        <div className="doc-reader-top"><div className="doc-location"><div className="reader-history"><button aria-label={t('返回上一篇文档')} title={t('返回上一处阅读位置')} disabled={historyState.index <= 0} onClick={() => navigateHistory(-1)}><ArrowLeft size={16}/></button><button aria-label={t('前进到下一篇文档')} title={t('前进到下一处阅读位置')} disabled={historyState.index >= historyState.length - 1} onClick={() => navigateHistory(1)}><ArrowRight size={16}/></button></div><BookOpen size={15}/><span>{loading ? t('正在打开文档…') : doc ? t('开发文档') : t('阅读空间')}</span>{doc && <span className="doc-revision">{doc.revision.slice(0, 8)}</span>}</div><div className="reader-actions"><div className="reader-font-size"><button aria-label={t('缩小文档字号')} disabled={fontSize <= 14} onClick={() => setFontSize(size => size - 1)}>A−</button><span>{fontSize}</span><button aria-label={t('放大文档字号')} disabled={fontSize >= 20} onClick={() => setFontSize(size => size + 1)}>A+</button></div>{doc && <button className="text-button" onClick={() => api.openOfficial(doc.source)}>{t('查看原文')}<ArrowUpRight size={14}/></button>}</div></div>
        {trail.length > 0 && <nav className="doc-breadcrumbs" aria-label={t('文档位置')}>{trail.map((node, index) => <React.Fragment key={node.id}>{index > 0 && <ChevronRight size={11}/>}<span>{node.title}</span></React.Fragment>)}</nav>}
        <div className={'doc-reading-area' + (headings.length ? ' has-outline' : '')}>
          <div className="doc-body" ref={reader} tabIndex={0} aria-label={t('文档正文')} style={{ '--doc-font-size': `${fontSize}px` }}>
            {doc ? <div className="doc-prose"><h1 className="doc-title" id={headingId(plainHeading(firstHeading?.[1] || doc.title))}>{doc.title}</h1>{renderedMarkdown}</div> : <div className="empty"><span className="empty-icon"><BookOpen size={28}/></span><h3>{t('从左侧选择一篇文档')}</h3><p>{t('也可以输入关键词，快速找到需要的说明和示例。')}</p></div>}
          </div>
          {headings.length > 0 && <nav className="doc-outline" aria-label={t('本文目录')}><strong>{t('本文目录')}</strong>{headings.map(heading => <button key={heading.id} className={heading.level === 3 ? 'nested' : ''} onClick={() => scrollToHeading('#' + heading.id)}>{heading.title}</button>)}</nav>}
        </div>
      </article>
    </div>
    {previewImage && <div className="doc-image-preview" role="dialog" aria-modal="true" aria-label={t('文档图示')} onClick={() => setPreviewImage(null)}><button autoFocus aria-label={t('关闭图片')} onClick={() => setPreviewImage(null)}><X size={22}/></button><img src={previewImage.src} alt={previewImage.alt || t('文档图示')} onClick={event => event.stopPropagation()}/></div>}
  </>;
}
