import { t, useLocale } from './i18n.jsx';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import latex from 'highlight.js/lib/languages/latex';

for (const [name, grammar] of Object.entries({ javascript, typescript, json, xml, css, bash, markdown, rust, latex })) hljs.registerLanguage(name, grammar);
hljs.registerAliases(['ink'], { languageName: 'xml' });
const labels = { javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript', json: 'JSON', html: 'HTML', xml: 'XML', ink: 'Ink', css: 'CSS', bash: 'Shell', sh: 'Shell', shell: 'Shell', markdown: 'Markdown', md: 'Markdown', rust: 'Rust', latex: 'LaTeX' };

export const CodeBlock = memo(function CodeBlock({ code, language = '', className = '' }) {
  useLocale();
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const highlighted = useMemo(() => {
    if (!hljs.getLanguage(language)) return null;
    try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { return null; }
  }, [code, language]);
  async function copy() {
    try { await window.workbench.copy(code); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setCopied(false); setFailed(false); }, 2000);
  }
  return <div className={`code-block ${className}`}>
    <div className="code-toolbar"><span>{labels[language] || t("纯文本")}</span><button onClick={copy} aria-label={t("复制代码")}>{copied ? <Check size={14}/> : <Copy size={14}/>}<span role="status">{copied ? t("已复制") : failed ? t("复制失败，请重试") : t("复制")}</span></button></div>
    <pre>{highlighted === null ? <code>{code}</code> : <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }}/>}</pre>
  </div>;
});

export function MarkdownCode({ children }) {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement(child)) return <pre>{children}</pre>;
  const language = /language-([\w-]+)/.exec(child.props.className || '')?.[1]?.toLowerCase() || '';
  return <CodeBlock code={String(child.props.children || '').replace(/\n$/, '')} language={language}/>;
}
