import { t, getLocale, translateMessage } from './i18n.jsx';
import React, { useEffect, useState } from 'react';
import { Download, FolderOpen, RefreshCw, ExternalLink, Settings2, CheckCircle2 } from 'lucide-react';
import { CodeBlock } from './code-block.jsx';
import { AppearancePanel } from './appearance-panel.jsx';
import './settings-page.css';
import updateDefaults from '../assets/updates.json';

const labels = { github: 'GitHub Releases', cnb: 'CNB 国内发行源', gitee: 'Gitee 发行源', custom: '自定义 HTTPS 源' };
const settings = value => ({ source: value.source, sources: structuredClone(value.sources), autoCheck: value.autoCheck, intervalHours: value.intervalHours });
const date = value => value ? new Date(value).toLocaleString(getLocale()) : t("尚未成功检查");
export function SettingsPage({ api, updates, onUpdates, notify }) {
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState('');
  useEffect(() => { if (updates && !draft) setDraft(settings(updates)); }, [updates, draft]);
  const web = api.kind === 'web';
  if (web) return <><div className="page-heading"><div><h1>{t("设置")}</h1><p>{t("AIUI 工坊 Web 与桌面版共用本机的项目、预览和 MCP 服务。")}</p></div><span className="pill">Web v{__APP_VERSION__}</span></div><AppearancePanel/><section className="panel app-update-panel"><h2>{t("启动与升级 Web 版")}</h2><p className="muted-copy">{t("源码目录执行 ")}<code>npm run web</code>{t("，会构建界面、自动启动本地服务并打开浏览器。关闭终端中的 Web 命令会关闭浏览器入口，共享服务继续供桌面和 MCP 使用。")}</p><CodeBlock code={t("npm run web\n\n# 指定端口，手动打开浏览器\nnpm run web -- --port 3100 --no-open")} language="bash"/><p className="subtle">{t("npm 包发布后，可用 npx aiui-workbench@latest 启动最新版；已安装的包可通过 npm 更新。桌面客户端的更新源在桌面版设置中管理。")}</p></section></>;
  const dirty = draft && updates && JSON.stringify(draft) !== JSON.stringify(settings(updates));
  const working = !!busy || updates?.checking || updates?.downloading || updates?.installing;
  const defaultRepository = updates?.defaults?.sources?.github?.repository || updateDefaults.sources.github.repository;
  async function act(method, args, success) {
    setBusy(method);
    try { const result = await api.updates(method, args); onUpdates(await api.updates('status')); if (success) notify(success); return result; }
    catch (error) { notify(translateMessage(error.message), true); }
    finally { setBusy(''); }
  }
  return <><div className="page-heading"><div><h1>{t("设置")}</h1><p>{t("管理桌面客户端的版本检查、安装包下载和更新来源。")}</p></div><span className="pill">{t("桌面 v")}{__APP_VERSION__}</span></div><AppearancePanel/>{!draft || !updates ? <p className="subtle">{t("正在读取更新设置…")}</p> : <>
    <section className="panel app-update-panel"><div className="section-heading"><h2><Settings2 size={17}/>{t(" 客户端更新")}</h2><span className="pill">{updates.platform} · {updates.arch}</span></div>
      <div className="update-preference"><label><input type="checkbox" checked={draft.autoCheck} disabled={working} onChange={e => setDraft({ ...draft, autoCheck: e.target.checked })}/>{t(" 启动时自动检查更新")}</label><select aria-label={t("后台检查频率")} value={draft.intervalHours} disabled={working || !draft.autoCheck} onChange={e => setDraft({ ...draft, intervalHours: Number(e.target.value) })}><option value={24}>{t("每天检查")}</option><option value={168}>{t("每周检查")}</option></select></div>
      <label className="field">{t("更新源")}<select aria-label={t("客户端更新源")} disabled={working} value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value })}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label>
      {draft.source === 'github' ? <div className="field"><div className="field-title-row"><label htmlFor="update-repository">{t("GitHub 仓库")}</label><button className="text-button" disabled={working||draft.sources.github.repository===defaultRepository} onClick={()=>setDraft({...draft,sources:{...draft.sources,github:{repository:defaultRepository}}})}>{t('恢复默认')}</button></div><input id="update-repository" aria-label={t("GitHub 更新仓库")} placeholder={defaultRepository} disabled={working} value={draft.sources.github.repository} onChange={e => setDraft({ ...draft, sources: { ...draft.sources, github: { repository: e.target.value } } })}/><small className="field-help">{t('默认仓库：{0}',{0:defaultRepository})}</small></div> : <label className="field">{t("更新清单地址")}<input aria-label={t("更新清单地址")} type="url" placeholder="https://…/workbench-update.json" disabled={working} value={draft.sources[draft.source].manifestUrl} onChange={e => setDraft({ ...draft, sources: { ...draft.sources, [draft.source]: { manifestUrl: e.target.value } } })}/></label>}
      <p className="subtle">{draft.source === 'github' ? t("读取公开仓库的最新稳定发行版。发布者需附带工坊更新清单和安装包。") : t("填写发布者提供的公开 HTTPS 清单直链，安装包可以托管在发行平台或对象存储中。")}{t(" 各来源地址会分别保留。")}</p>
      <div className="button-row"><button className="button primary" disabled={working || !dirty} onClick={async () => { const result = await act('settings', draft, t("更新设置已保存")); if (result) setDraft(settings(result)); }}>{t("保存更新设置")}</button><button className="button" disabled={working || dirty || !updates.configured} onClick={() => act('check')}><RefreshCw size={15} className={updates.checking ? 'spin' : ''}/>{updates.checking ? t("正在检查…") : t("立即检查更新")}</button></div>
      {dirty && <p className="subtle">{t("保存设置后，可使用所选来源检查更新。")}</p>}
      {!updates.configured && <p className="update-notice">{t("尚未配置发布源。填写正式仓库或发布者提供的清单地址后即可检查更新。")}</p>}
      <dl className="update-details"><div><dt>{t("当前版本")}</dt><dd>{updates.version}</dd></div><div><dt>{t("上次成功检查")}</dt><dd>{date(updates.checkedAt)}</dd></div><div><dt>{t("当前来源")}</dt><dd>{t(labels[updates.source])}</dd></div></dl>
      {updates.error && <p role="alert" className="update-error">{translateMessage(updates.error)}</p>}
      {updates.latest && !updates.error && <div className="update-result"><div className="section-heading"><h2><CheckCircle2 size={17}/>{updates.updateAvailable ? t("发现新版本 {0}", {0: updates.latest.version}) : t("当前已是最新版本")}</h2>{updates.latest.releaseUrl && <button className="button" onClick={() => act('release')}><ExternalLink size={14}/>{t(" 发行页面")}</button>}</div>{updates.latest.notes && <p className="update-notes">{updates.latest.notes}</p>}
        {updates.updateAvailable && (updates.latest.file ? <><p className="subtle">{updates.latest.file.name} · {(updates.latest.file.size / 1024 / 1024).toFixed(1)} MB</p>{updates.downloading && <><progress aria-label={t("安装包下载进度")} value={updates.progress?.received || 0} max={updates.progress?.total || 1}/><p className="subtle">{t("已下载 ")}{Math.round((updates.progress?.received || 0) / updates.latest.file.size * 100)}%</p></>}{updates.downloaded ? <div className="button-row"><span className="subtle">{t("SHA256 校验通过")}</span><button className="button primary" onClick={() => act('reveal')}><FolderOpen size={15}/>{t(" 显示安装包")}</button></div> : <button className="button primary" disabled={working || dirty} onClick={() => act('download', undefined, t("安装包已下载并通过 SHA256 校验，可在文件管理器中打开安装。"))}><Download size={15}/>{updates.downloading ? t("正在下载并校验…") : t("下载新版本安装包")}</button>}</> : <p className="update-notice">{t("该版本尚未提供当前系统与架构的安装包。")}</p>)}
      </div>}
    </section><section className="panel app-update-panel"><h2>{t("安装与项目数据")}</h2><p className="muted-copy">{t("工坊会自动检查版本，下载由你发起。安装包通过校验后，在文件管理器中打开并完成安装。项目和工作记录保存在独立的数据目录中。")}</p><p className="subtle">{t("也可以从源码目录运行 npm run web，在浏览器中使用工坊。")}</p></section>
  </>}</>;
}
