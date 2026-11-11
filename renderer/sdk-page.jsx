import { t, getLocale, translateMessage } from './i18n.jsx';
import React, { useState } from 'react';
import { RefreshCw, Download, Package, ShieldCheck, RotateCcw, ExternalLink, LoaderCircle, AlertCircle, CheckCircle2 } from 'lucide-react';
import './sdk-page.css';
import { JobHistory } from './job-history.jsx';

const time = value => value ? new Date(value).toLocaleString(getLocale()) : t("尚未检查");
const version = release => release ? `SDK ${release.versions.ink} · CLI ${release.versions.cli}` : t("版本不可用");

export function SdkPage({ sdk, projects, jobs, refresh, notify, onCancel, onDelete, deleting }) {
  const [busy, setBusy] = useState(''), [selected, setSelected] = useState('');
  if (!sdk) return <p>{t("正在读取 SDK 状态…")}</p>;
  const job = jobs.find(j => j.type === 'sdk-prepare' && j.status === 'running');
  const working = !!busy || !!sdk.operation || !!job;
  const report = sdk.report, target = selected || sdk.active.id;
  async function perform(tool, args, message) {
    setBusy(tool);
    try { const result = await window.workbench.call(tool, args); await refresh(); if (message) notify(message); return result; }
    catch (error) { notify(error.message, true); }
    finally { setBusy(''); }
  }
  const inspect = releaseId => perform('aiui_sdk_prepare', releaseId ? { releaseId } : {}, t("已开始检查，结果会显示在本页"));
  return <>
    <div className="page-heading"><div><h1>{t("SDK 更新")}</h1><p>{t("检查官方稳定版本，先验证兼容性，再选择何时启用。")}</p></div><button className="button primary" disabled={working || sdk.checking} onClick={() => perform('aiui_sdk_check')}><RefreshCw size={16} className={sdk.checking || busy === 'aiui_sdk_check' ? 'spin' : ''}/>{sdk.checking ? t("正在检查…") : t("检查更新")}</button></div>
    <section className="panel sdk-current"><div className="section-heading"><h2><Package size={18}/>{t(" 当前默认版本")}</h2><span className="pill">{sdk.active.bundled ? t("随客户端内置") : t("已下载")}</span></div>
      <div className="sdk-version-grid"><div><span>Ink Web SDK</span><strong>{sdk.active.versions.ink}</strong></div><div><span>{t("实际引擎")}</span><strong>{sdk.active.runtime}</strong></div><div><span>AIX CLI</span><strong>{sdk.active.versions.cli}</strong></div></div>
      <p className="subtle">{t("新建和新导入的项目使用默认版本；已有项目保留各自绑定的版本。")}</p>
      {sdk.canRollback && <button className="button" disabled={working} onClick={() => perform('aiui_sdk_rollback', {}, t("默认版本已回退，项目继续使用各自的版本"))}><RotateCcw size={15}/>{t("回退默认版本")}</button>}
    </section>
    <section className="panel sdk-schedule"><div><h2>{t("检查安排")}</h2><p>{t("每次打开工坊时立即在后台检查；持续运行时按以下频率检查。发现新版后由你选择安装。")}</p><span className="subtle">{t("最近成功检查：")}{time(sdk.checkedAt)}{sdk.autoCheck && sdk.nextCheckAt ? t(" · 下次定期检查：{0}", {0: time(sdk.nextCheckAt)}) : ''}</span></div><label>{t("运行期间的频率")}<select aria-label={t("SDK 检查频率")} value={sdk.autoCheck ? String(sdk.intervalHours) : 'off'} disabled={working} onChange={e => perform('aiui_sdk_settings', { autoCheck: e.target.value !== 'off', ...(e.target.value !== 'off' ? { intervalHours: Number(e.target.value) } : {}) })}><option value="24">{t("每天")}</option><option value="168">{t("每周")}</option><option value="off">{t("仅打开时检查")}</option></select></label></section>
    {sdk.error && <div className="sdk-notice warning" role="status"><AlertCircle size={20}/><div><strong>{translateMessage(sdk.error)}</strong><p>{t("已安装的版本可以继续使用。")}{sdk.autoCheck ? t("稍后会自动重试，也可以手动检查。") : t("恢复联网后可重新打开工坊或手动检查。")}</p></div></div>}
    {sdk.candidate ? <section className="sdk-notice update"><Download size={22}/><div><h2>{t("发现官方新版本")}</h2><p>SDK {sdk.active.versions.ink} → {sdk.candidate.packages.ink.version} · CLI {sdk.active.versions.cli} → {sdk.candidate.packages.cli.version}</p><p>{t("下载后会逐项检查项目的引擎要求与源码。现有项目可继续使用原版本。")}</p></div><button className="button primary" disabled={working} onClick={() => inspect()}><Download size={16}/>{t("下载并检查兼容性")}</button></section> : sdk.checkedAt && !sdk.error && <div className="sdk-notice"><CheckCircle2 size={20}/><span>{t("当前默认版本已是官方最新稳定版。")}</span></div>}
    <section className="panel sdk-installed"><div className="section-heading"><h2>{t("已安装版本")}</h2><button className="text-button" onClick={() => window.workbench.openOfficial('https://github.com/jsar-project/ink/releases').catch(e => notify(e.message, true))}>{t("官方更新记录 ")}<ExternalLink size={14}/></button></div><div className="button-row"><select aria-label={t("选择兼容性检查版本")} value={target} disabled={working} onChange={e => setSelected(e.target.value)}>{sdk.installed.map(release => <option key={release.id} value={release.id}>{version(release)}{release.id === sdk.active.id ? t("（默认）") : ''}</option>)}</select><button className="button" disabled={working} onClick={() => inspect(target)}><ShieldCheck size={16}/>{t("检查项目兼容性")}</button></div><p className="subtle">{t("保留旧版本便于回退。项目如需回退，选择旧版、重新检查，再切换该项目。")}</p></section>
    {job && <div className="inline-progress" role="status"><LoaderCircle size={18} className="spin"/>{translateMessage(job.message)}<button className="text-button" onClick={() => perform('aiui_job_cancel', { jobId: job.id })}>{t("取消")}</button></div>}
    {report && <section className="panel sdk-report"><div className="section-heading"><div><h2>{t("项目兼容性报告")}</h2><p className="subtle">SDK {report.versions.ink}{t(" · 实际引擎 ")}{report.runtime} · CLI {report.versions.cli} · {time(report.checkedAt)}</p></div>{report.releaseId !== sdk.active.id && <button className="button primary" disabled={working || report.stale} onClick={() => perform('aiui_sdk_activate', { releaseId: report.releaseId, reportId: report.id }, t("默认 SDK 已更新，现有项目保持原版本"))}>{t("设为默认版本")}</button>}</div>
      {report.stale && <p className="sdk-stale" role="status">{t("项目源码或版本设置已有变化，请重新检查后再启用或迁移。")}</p>}
      {report.projects.length ? <div className="sdk-table-wrap"><table className="sdk-table"><thead><tr><th>{t("项目 / 当前版本")}</th><th>{t("引擎要求")}</th><th>{t("检查结果")}</th><th>{t("操作")}</th></tr></thead><tbody>{report.projects.map(row => { const p = projects.find(p => p.id === row.projectId), current = sdk.installed.find(r => r.id === p?.toolchainId); return <tr key={row.projectId}><td><strong>{row.name}</strong><small>{version(current)}</small></td><td><code>{row.engine || t("未声明")}</code></td><td><span className={'pill ' + (row.status === 'compatible' ? 'success' : 'red')}>{row.status === 'compatible' ? t("基础检查通过") : row.status === 'needs-declaration' ? t("需声明引擎") : t("暂不兼容")}</span><p>{translateMessage(row.message)}</p>{row.diagnostics && <details><summary>{t("查看诊断")}</summary><pre>{row.diagnostics}</pre></details>}</td><td>{p?.toolchainId === report.releaseId ? <span className="subtle">{t("正在使用")}</span> : <button className="button" disabled={working || report.stale || row.status !== 'compatible'} onClick={() => perform('aiui_sdk_project_use', { projectId: row.projectId, releaseId: report.releaseId, reportId: report.id }, t("项目版本已切换，请重新预览并完成真机验证"))}>{t("切换到此版本")}</button>}</td></tr>; })}</tbody></table></div> : <p className="subtle">{t("项目库为空，可将此版本设为新项目默认版本。")}</p>}
      <p className="sdk-scope"><ShieldCheck size={16}/>{t("引擎要求与静态检查通过，仍需验证运行效果、镜腿手势和眼镜上的实际体验。")}</p>
    </section>}
    <JobHistory title={t("SDK 检查记录")} jobs={jobs.filter(j => j.type === 'sdk-prepare')} onCancel={onCancel} onDelete={onDelete} deleting={deleting}/>
  </>;
}
