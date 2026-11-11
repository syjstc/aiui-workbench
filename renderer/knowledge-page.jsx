import { t, getLocale, useLocale, translateMessage } from './i18n.jsx';
import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronRight, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { MarkdownCode } from './code-block.jsx';
import { documentLink } from '../core/document-links.mjs';

const api = window.workbench;
const call = (tool, args) => api.call(tool, args);
const headingText = node => node?.type === 'text' ? node.value : (node?.children || []).map(headingText).join('');
const headingId = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
const headingComponents = Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(tag => [tag, ({ node, children }) => React.createElement(tag, { id: headingId(headingText(node)) }, children)]));
const savedSort = () => { try { const value = localStorage.getItem('aiui-doc-sort'); return ['recommended', 'title', 'path'].includes(value) ? value : 'recommended'; } catch { return 'recommended'; } };

export function KnowledgePage({ knowledge, running, startJob, notify }) {
  const locale = useLocale();
  const [query, setQuery] = useState(''), [docs, setDocs] = useState([]), [doc, setDoc] = useState(null);
  const [searching, setSearching] = useState(true), [loading, setLoading] = useState(false), [appending, setAppending] = useState(false);
  const [sort, setSort] = useState(savedSort), [hasMoreDocs, setHasMoreDocs] = useState(false), [loadingDocs, setLoadingDocs] = useState(false);
  const [historyState, setHistoryState] = useState({ index: -1, length: 0 });
  const [fontSize, setFontSize] = useState(16);
  const reader = useRef(), docList = useRef(), request = useRef(0), listRequest = useRef(0), selected = useRef(null), currentDoc = useRef(null);
  const history = useRef({ entries: [], index: -1 }), readerLocation = useRef(null);
  const syncing = running.filter(j => j.type === 'knowledge');

  useEffect(() => {
    let cancelled = false;
    const current = ++listRequest.current;
    setSearching(true);
    setLoadingDocs(false);
    const timer = setTimeout(async () => {
      try {
        const result = await call('aiui_docs_search', { query, sort, locale, limit: 50, revision: knowledge?.revision });
        if (cancelled || current !== listRequest.current) return;
        setDocs(result.documents);
        setHasMoreDocs(result.documents.length === 50);
        if (docList.current) docList.current.scrollTop = 0;
        if (!selected.current && result.documents.length) openDocument(result.documents[0].path);
        else if (selected.current) {
          const preferred = locale === 'en' ? selected.current.replace(/(?<!\.en-US)\.md$/, '.en-US.md') : selected.current.replace(/\.en-US\.md$/, '.md');
          if (preferred !== selected.current && result.documents.some(d => d.path === preferred)) openDocument(preferred);
        }
      } catch (error) { if (!cancelled) notify(error.message, true); }
      finally { if (!cancelled) setSearching(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, sort, locale, knowledge?.revision]);
  useEffect(() => { try { localStorage.setItem('aiui-doc-sort', sort); } catch {} }, [sort]);
  useEffect(() => () => { request.current++; listRequest.current++; }, []);

  function rememberPosition() {
    const current = history.current;
    if (current.index >= 0 && currentDoc.current) current.entries[current.index] = { document: currentDoc.current, scrollTop: reader.current?.scrollTop || 0 };
  }
  function displayDocument(value) {
    currentDoc.current = value;
    selected.current = value.path;
    setDoc(value);
    setHistoryState({ index: history.current.index, length: history.current.entries.length });
  }
  async function openDocument(path, revision, from) {
    const current = ++request.current;
    selected.current = path;
    setLoading(true);
    setAppending(false);
    try {
      const result = await call('aiui_docs_read', { path, revision, from, limit: 24000 });
      if (current !== request.current) return;
      rememberPosition();
      const value = { ...result, locationKey: current };
      const previous = currentDoc.current;
      selected.current = value.path;
      if (previous?.path === value.path && previous?.revision === value.revision && previous?.fragment === value.fragment) {
        displayDocument({ ...previous, restoreScrollTop: undefined, locationKey: current });
        return;
      }
      history.current.entries = history.current.entries.slice(0, history.current.index + 1);
      history.current.entries.push({ document: value, scrollTop: 0 });
      history.current.index++;
      displayDocument(value);
    } catch (error) { if (current === request.current) { selected.current = currentDoc.current?.path; notify(error.message, true); } }
    finally { if (current === request.current) setLoading(false); }
  }
  function navigateHistory(step) {
    const target = history.current.index + step, entry = history.current.entries[target];
    if (!entry) return;
    rememberPosition();
    history.current.index = target;
    setLoading(false);
    setAppending(false);
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
    }
    if (doc?.fragment && doc.restoreScrollTop === undefined && !scrollToHeading(doc.fragment) && doc.nextOffset && !appending) loadMore();
  }, [doc?.locationKey, doc?.content]);
  async function loadMore() {
    if (appending) return;
    const current = request.current;
    setAppending(true);
    try {
      const next = await call('aiui_docs_read', { path: doc.path, offset: doc.nextOffset, revision: doc.revision, limit: 24000 });
      if (current === request.current) {
        const value = { ...currentDoc.current, ...next, fragment: currentDoc.current.fragment, content: currentDoc.current.content + next.content };
        currentDoc.current = value;
        setDoc(value);
      }
    } catch (error) { if (current === request.current) notify(error.message, true); }
    finally { if (current === request.current) setAppending(false); }
  }
  async function loadMoreDocuments() {
    if (searching || loadingDocs) return;
    const current = listRequest.current;
    setLoadingDocs(true);
    try {
      const result = await call('aiui_docs_search', { query, sort, locale, offset: docs.length, limit: 50, revision: knowledge?.revision });
      if (current !== listRequest.current) return;
      setDocs(previous => [...previous, ...result.documents]);
      setHasMoreDocs(result.documents.length === 50);
    } catch (error) { if (current === listRequest.current) notify(error.message, true); }
    finally { if (current === listRequest.current) setLoadingDocs(false); }
  }
  async function followLink(event, href) {
    event.preventDefault();
    try {
      if (documentLink(href, doc.path)) await openDocument(href, doc.revision, doc.path);
      else if (href) await api.openOfficial(href);
    } catch (error) { notify(error.message, true); }
  }
  return <>
    <div className="page-heading"><div><h1>{t("官方资料")}</h1><p>{t("阅读开发指南、查找接口与代码示例。")}</p></div><button className="button" disabled={syncing.length > 0} onClick={() => startJob('aiui_docs_sync')}><RefreshCw size={16} className={syncing.length ? 'spin' : ''}/>{syncing.length ? t("正在同步") : t("同步资料")}</button></div>
    <div className="knowledge-meta"><span><BookOpen size={15}/>{knowledge?.revision ? t("{0} 份资料 · 可离线阅读", {0: knowledge.documents}) : t("同步后即可离线阅读")}</span><span>{knowledge?.syncedAt && t("更新于 {0}", {0: new Date(knowledge.syncedAt).toLocaleDateString(getLocale())})}</span><button className="text-button" onClick={() => api.openOfficial('https://github.com/yodaos-project/AIUI')}>{t("官方来源")}<ArrowUpRight size={14}/></button></div>
    {syncing.map(j => <div className="inline-progress" key={j.id}><LoaderCircle size={15} className="spin"/>{translateMessage(j.message)}</div>)}
    <div className="knowledge-layout">
      <aside className="doc-index" aria-label={t("文档目录")}>
        <div className="doc-search">
          <div className="search-box"><Search size={17}/><input aria-label={t("搜索官方资料")} placeholder={t("搜索文档、API…")} value={query} onChange={e => setQuery(e.target.value)}/></div>
          <label className="doc-sort"><span>{t("排序")}</span><select aria-label={t("文档排序")} value={sort} onChange={e => setSort(e.target.value)}><option value="recommended">{query.trim() ? t("相关度优先") : t("官方目录顺序")}</option><option value="title">{t("标题（A–Z / 拼音）")}</option><option value="path">{t("文档路径")}</option></select></label>
          <div className="doc-list-label"><span>{query ? t("搜索结果") : t("文档与示例")}</span><span>{searching ? t("搜索中…") : t("{0}{1} 篇", {0: docs.length, 1: hasMoreDocs ? '+' : ''})}</span></div>
        </div>
        <div className="doc-list" ref={docList} tabIndex={0} aria-label={t("文档列表")}>
          {docs.map(d => <button key={d.path} aria-current={doc?.path === d.path ? 'page' : undefined} className={doc?.path === d.path ? 'selected' : ''} title={d.path} onClick={() => openDocument(d.path, d.revision)}><div><strong>{d.title}</strong><small>{d.path.replace(/^documentation\//, '').replace(/\.md$/, '')}</small></div><ChevronRight size={14}/></button>)}
          {hasMoreDocs && <button className="doc-list-more" disabled={searching || loadingDocs} onClick={loadMoreDocuments}>{loadingDocs && <LoaderCircle size={14} className="spin"/>}{loadingDocs ? t("正在加载…") : t("加载更多文档")}</button>}
          {!docs.length && <p className="doc-list-empty">{searching ? t("正在查找资料…") : knowledge?.revision ? t("没有找到相关资料，试试其他关键词。") : t("同步官方资料后，即可在这里阅读。")}</p>}
        </div>
      </aside>
      <article className="doc-reader" aria-busy={loading}>
        <div className="doc-reader-top"><div className="doc-location"><div className="reader-history"><button aria-label={t("返回上一篇文档")} title={t("返回上一处阅读位置")} disabled={historyState.index <= 0} onClick={() => navigateHistory(-1)}><ArrowLeft size={16}/></button><button aria-label={t("前进到下一篇文档")} title={t("前进到下一处阅读位置")} disabled={historyState.index >= historyState.length - 1} onClick={() => navigateHistory(1)}><ArrowRight size={16}/></button></div><BookOpen size={15}/><span>{loading ? t("正在打开文档…") : doc ? t("开发文档") : t("阅读空间")}</span>{doc && <span className="doc-revision">{doc.revision.slice(0, 8)}</span>}</div><div className="reader-actions"><div className="reader-font-size"><button aria-label={t("缩小文档字号")} disabled={fontSize <= 14} onClick={() => setFontSize(size => size - 1)}>A−</button><span>{fontSize}</span><button aria-label={t("放大文档字号")} disabled={fontSize >= 20} onClick={() => setFontSize(size => size + 1)}>A+</button></div>{doc && <button className="text-button" onClick={() => api.openOfficial(doc.source)}>{t("查看原文")}<ArrowUpRight size={14}/></button>}</div></div>
        <div className="doc-body" ref={reader} tabIndex={0} aria-label={t("文档正文")} style={{ '--doc-font-size': `${fontSize}px` }}>
          {doc ? <div className="doc-prose"><h1 className="doc-title" id={headingId(doc.title)}>{doc.title}</h1><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ ...headingComponents, pre: MarkdownCode, a: ({ href, children }) => <a href={href} onClick={e => followLink(e, href)}>{children}</a>, img: () => <span className="doc-image-note">{t("图示请查看官方原文")}</span> }}>{doc.content.replace(/^# [^\n]+\n/, '')}</Markdown>{doc.nextOffset && <button className="button doc-load-more" disabled={appending} onClick={loadMore}>{appending && <LoaderCircle size={15} className="spin"/>}{appending ? t("正在读取…") : t("继续读取文档")}</button>}</div> : <div className="empty"><span className="empty-icon"><BookOpen size={28}/></span><h3>{t("从左侧选择一篇文档")}</h3><p>{t("也可以输入关键词，快速找到需要的说明和示例。")}</p></div>}
        </div>
      </article>
    </div>
  </>;
}
