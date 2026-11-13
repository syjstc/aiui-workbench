import { t, getLocale } from './i18n.jsx';
import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Download, Glasses, LoaderCircle, Play, Plug, ShieldCheck } from 'lucide-react';

export function devicePresentation(environment, device, error) {
  if (error) return { tone: 'warning', title: t("暂时无法读取连接状态"), description: t("正在自动重试。你可以检查数据线是否连接稳固，或稍后重新打开工坊。") };
  if (!environment) return { tone: 'waiting', title: t("正在寻找你的眼镜…"), description: t("连接后会自动检查，无需手动刷新。") };
  if (!environment.adb || !environment.aix) return { tone: 'warning', title: t("连接工具需要准备"), description: !environment.adb ? t("内置连接工具暂时不可用。请确认客户端已完整解压，或打开新手指南第 3 步查看解决方法。") : t("应用安装工具暂时不可用，请重新打开工坊。详细原因可在下方查看。") };
  if (!environment.devices.length) return { tone: 'waiting', title: t("等待连接眼镜"), description: t("用 Rokid 专用数据调试线连接电脑与眼镜，并在手机 App 中打开“眼镜 ADB 调试”。") };
  if (!device) return { tone: 'waiting', title: t("选择要使用的眼镜"), description: t("检测到多台设备，请在下方选择这次要使用的一台。") };
  if (device.status === 'unauthorized') return { tone: 'warning', title: t("等待你允许连接"), description: t("请在眼镜上确认“允许 USB 调试”。确认后，这里会自动进入下一步。") };
  if (device.status !== 'device') return { tone: 'warning', title: t("眼镜连接暂时中断"), description: t("请重新插好数据线，并确认眼镜已开机。恢复连接后会自动继续检测。") };
  const inspection = device.inspection;
  if (!inspection) return { tone: 'waiting', title: t("眼镜已连接，正在检查…"), description: t("正在确认眼镜是否可以运行你的应用。") };
  if (inspection.error || inspection.developerMode === 'unknown') return { tone: 'warning', title: t("已连接，暂未读到眼镜状态"), description: t("请确认连接的是支持 AIUI 的 Rokid 眼镜，并保持眼镜开机。工坊会自动重试。") };
  if (inspection.developerMode === 'disabled') return { tone: 'warning', title: t("还需要开启开发者模式"), description: t("点击下方按钮开启 AIUI 开发者模式。眼镜上的小组件会重新加载，完成后自动继续检查。") };
  if (!inspection.runtimeReady) return { tone: 'waiting', title: t("眼镜正在准备运行环境"), description: t("请稍等片刻，准备好后即可安装应用。如果一直未就绪，可以重新启动眼镜。") };
  return { tone: 'ready', title: t("眼镜已就绪"), description: t("连接、授权和运行环境检查通过，选择一个应用就可以安装。") };
}

export function DevicePanel({ discovery, project, projects, setSelected, startJob, jobs, goToProjects, goToGuide }) {
  const { environment, error, checking } = discovery;
  const [serial, setSerial] = useState(''), [submitting, setSubmitting] = useState(false),[address,setAddress]=useState(''),[pairingCode,setPairingCode]=useState(''),[wirelessMessage,setWirelessMessage]=useState('');
  const devices = environment?.devices || [];
  useEffect(() => {
    setSerial(previous => devices.some(d => d.serial === previous) ? previous : devices.length === 1 ? devices[0].serial : '');
  }, [environment]);
  const device = devices.find(d => d.serial === serial);
  const status = devicePresentation(environment, device, error);
  const ready = status.tone === 'ready';
  const busy = submitting || jobs.some(j => ['deploy', 'launch', 'device-setup'].includes(j.type) && j.status === 'running');
  const connected = device?.status === 'device';
  const developerReady = connected && !error && !device.inspection?.error && device.inspection?.developerMode === 'enabled';
  const steps = [
    [t("连接眼镜"), t("使用数据线连接电脑"), !!device],
    [t("允许连接"), t("在眼镜上确认调试授权"), connected],
    [t("准备完成"), t("自动检查开发者模式"), ready],
  ];
  async function perform(tool) {
    setSubmitting(true);
    try { await startJob(tool, { serial, ...(project ? { projectId: project.id } : {}) }); }
    finally { setSubmitting(false); }
  }
  return <section className="panel device-panel">
    <div className="device-status-top"><span className={`device-status-icon ${status.tone}`}><Glasses size={30}/></span><div className="device-status-copy" role="status" aria-live="polite"><h2>{status.title}</h2><p>{status.description}</p></div><span className="auto-detection">{checking ? <LoaderCircle size={14} className="spin"/> : <span className="dot"/>}{t("自动检测中")}</span></div>
    <ol className="connection-steps">{steps.map(([title, description, complete], i) => <li key={title} className={complete ? 'complete' : ''}><span className="step-number">{complete ? <Check size={15}/> : i + 1}</span><div><strong>{title}</strong><small>{description}</small></div></li>)}</ol>
    {connected && device.inspection?.developerMode === 'disabled' && <div className="device-mode-action"><button className="button primary" disabled={busy || !!error} onClick={() => perform('aiui_device_enable_developer')}><ShieldCheck size={16}/>{t("开启 AIUI 开发者模式")}</button><span>{t("会重新加载眼镜上的小组件")}</span></div>}
    <div className="device-workflow">
      <div className="device-selection"><h3>{t("要使用的眼镜")}</h3>{devices.length > 1 ? <label className="device-field">{t("检测到 ")}{devices.length}{t(" 台设备")}<select aria-label={t("选择眼镜")} value={serial} onChange={e => setSerial(e.target.value)}><option value="">{t("请选择一台眼镜")}</option>{devices.map(d => <option key={d.serial} value={d.serial}>{d.name}{t(" · 尾号 ")}{d.serial.slice(-6)}{d.status === 'unauthorized' ? t(" · 等待授权") : d.status === 'offline' ? t(" · 连接中断") : ''}</option>)}</select></label> : <div className="selected-device"><Glasses size={23}/><div><strong>{device?.name === 'USB 设备' ? t('USB 设备') : device?.name || t("尚未连接")}</strong><span>{device ? t("设备尾号 {0}", {0: device.serial.slice(-6)}) : t("插上数据线后会出现在这里")}</span></div>{connected && <Check size={17}/>}</div>}
      </div>
      <div className="device-install"><h3>{t("选择要安装的应用")}</h3>{projects.length ? <><select aria-label={t("选择部署项目")} value={project?.id || ''} onChange={e => setSelected(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.version}</option>)}</select><div className="button-row"><button className="button primary" disabled={!ready || !project || busy} onClick={() => perform('aiui_device_deploy')}>{busy ? <LoaderCircle className="spin" size={16}/> : <Download size={16}/>}{t("安装到眼镜")}</button><button className="button" disabled={!ready || !project || busy} onClick={() => perform('aiui_device_launch')}><Play size={16}/>{t("在眼镜上打开")}</button></div><p className="device-hint">{ready ? t("首次使用先安装；安装完成后，点击“在眼镜上打开”。") : t("完成上方连接步骤后，即可安装和打开应用。")}</p></> : <div className="device-no-project"><p>{t("先添加一个应用，连接准备好后即可安装。")}</p><button className="button" onClick={goToProjects}><Plug size={15}/>{t("前往项目库")}</button></div>}</div>
    </div>
    <div className="device-guide-link"><div><strong>{t("第一次连接，或一直找不到眼镜？")}</strong><span>{t("专用调试线、手机 ADB 开关、电脑工具，跟着 4 步完成准备。")}</span></div><button className="button" onClick={goToGuide}>{t("打开新手指南")}</button></div>
    <details className="device-details wireless-connection"><summary><Plug size={16}/>{t("无线连接眼镜")}<ChevronDown size={15}/></summary><p>{t("先在眼镜上开启无线调试或按官方指南准备，确认电脑与眼镜在同一网络。输入眼镜显示的地址；需要配对时输入配对地址及六位配对码，配对后再连接调试地址。")}</p><div className="button-row"><input aria-label={t("无线调试地址")} placeholder="192.168.1.20:5555" value={address} onChange={e=>setAddress(e.target.value)}/><input aria-label={t("配对码（可选）")} type="password" placeholder={t("配对码（可选）")} value={pairingCode} maxLength={6} onChange={e=>setPairingCode(e.target.value)}/><button className="button" disabled={submitting||!address} onClick={async()=>{setSubmitting(true);try{await window.workbench.call("aiui_adb_connect",{address,...(pairingCode?{pairingCode}:{})});setPairingCode("");setWirelessMessage(t("连接指令已完成，设备状态会自动更新"));}catch(error){setWirelessMessage(t("连接未完成，AI 可读取诊断；请核对地址、开关和网络"));}finally{setSubmitting(false);}}}>{t("连接")}</button></div>{wirelessMessage&&<p role="status">{wirelessMessage}</p>}<button className="text-button" onClick={()=>window.workbench.openOfficial("https://forum.rokid.com/post/detail/3585")}>{t("查看官方无线连接指南")}</button></details><details className="device-details"><summary><ShieldCheck size={16}/>{t("查看详细信息")}<ChevronDown size={15}/></summary><div className="environment-checks">{[[t("本地运行环境"), environment?.node], [t("应用安装工具"), environment?.aix ? t("可用") : t("待准备")], [t("眼镜连接工具"), environment?.adb ? environment?.adbTool?.source === 'bundled' ? t("客户端内置 · ") + environment.adbTool.version : t("可用") : t("待准备")]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || t("检测中")}</strong></div>)}</div><p className="subtle">{environment?.checkedAt ? t("最近检查：{0} · 开发者模式：{1}", {0: new Date(environment.checkedAt).toLocaleTimeString(getLocale()), 1: developerReady ? t("已开启") : t("尚未确认")}) : t("正在检查环境")}</p>{(device?.inspection?.output || error || environment?.diagnostics?.adb || environment?.diagnostics?.aix) && <pre className="job-output">{device?.inspection?.output || error || [environment.diagnostics.adb, environment.diagnostics.aix].filter(Boolean).join('\n')}</pre>}</details>
  </section>;
}
