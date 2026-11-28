import { t, getLocale } from './i18n.jsx';
import React, { useEffect, useId, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Download, Glasses, LoaderCircle, Play, ShieldCheck } from 'lucide-react';
import { StatusLabel } from './status-label.jsx';
import { WirelessConnection } from './wireless-connection.jsx';
import { ConnectionMethodTabs, useConnectionMethod, WiredConnection } from './connection-methods.jsx';

export function devicePresentation(environment, device, error) {
  if (error) return { tone: 'warning', title: t("暂时无法读取连接状态"), description: t("正在自动重试。请检查无线网络或数据线连接，保持眼镜开机。") };
  if (!environment) return { tone: 'waiting', title: t("正在寻找你的眼镜…"), description: t("连接后会自动检查，无需手动刷新。") };
  if (!environment.adb || !environment.aix) return { tone: 'warning', title: t("连接工具需要准备"), description: !environment.adb ? t("内置连接工具暂时不可用。请确认客户端已完整解压，或打开新手指南第 3 步查看解决方法。") : t("应用安装工具暂时不可用，请重新打开工坊。详细原因可在下方查看。") };
  if (!environment.devices.length) return { tone: 'waiting', title: t("等待连接眼镜"), description: t("未找到眼镜时，请先在手机 Rokid AI 的眼镜设置 → 开发者中检查「眼镜 ADB 调试」，再按下方步骤连接。") };
  if (!device) return { tone: 'waiting', title: t("选择要使用的眼镜"), description: t("检测到多台设备，请在下方选择这次要使用的一台。") };
  if (device.status === 'unauthorized') return { tone: 'warning', title: t("等待你允许连接"), description: t("请在眼镜上允许调试连接；使用无线配对的固件请完成配对。确认后会自动继续检查。") };
  if (device.status !== 'device') return { tone: 'warning', title: t("眼镜连接暂时中断"), description: device.connection === 'wireless' ? t("请保持眼镜开机并连接同一 Wi-Fi。已记住的设备会自动重连，下方会显示恢复提示。") : t("请重新插好数据线，并确认眼镜已开机。恢复连接后会自动继续检测。") };
  if (device.adbAccess && device.adbAccess.state !== 'available') return { tone: 'warning', title: t(device.adbAccess.recovery?.title || '请检查眼镜 ADB 调试与连接'), description: t(device.adbAccess.message) };
  const inspection = device.inspection;
  if (!inspection) return { tone: 'waiting', title: t("眼镜已连接，正在检查…"), description: t("正在确认眼镜是否可以运行你的应用。") };
  if (inspection.error || inspection.developerMode === 'unknown') return { tone: 'warning', title: t("已连接，暂未读到眼镜状态"), description: t("请确认连接的是支持 AIUI 的 Rokid 眼镜，并保持眼镜开机。工坊会自动重试。") };
  if (inspection.developerMode === 'disabled') return { tone: 'warning', title: t("还需要开启开发者模式"), description: t("点击下方按钮开启 AIUI 开发者模式。眼镜上的小组件会重新加载，完成后自动继续检查。") };
  if (!inspection.runtimeReady) return { tone: 'waiting', title: t("眼镜正在准备运行环境"), description: t("请稍等片刻，准备好后即可安装应用。如果一直未就绪，可以重新启动眼镜。") };
  return { tone: 'ready', title: t("眼镜已就绪"), description: t("连接、授权和运行环境检查通过。") };
}

export function DevicePanel({ discovery, project, startJob, jobs, goToGuide }) {
  const { environment, error, checking } = discovery;
  const id = useId();
  const [serial, setSerial] = useState(''), [submitting, setSubmitting] = useState(false);
  const usbDevices = environment?.usbDevices || environment?.devices?.filter(d => d.connection === 'usb') || [];
  const wirelessDevices = environment?.devices?.filter(d => d.connection === 'wireless') || [];
  const usbConnected = usbDevices.some(item => item.status === 'device');
  const wirelessConnected = wirelessDevices.some(item => item.status === 'device');
  const [method, setMethod] = useConnectionMethod(usbConnected && !wirelessConnected ? 'usb' : 'wireless');
  const devices = method === 'usb' ? usbDevices : wirelessDevices;
  useEffect(() => {
    setSerial(previous => devices.some(d => d.serial === previous) ? previous : devices.length === 1 ? devices[0].serial : '');
  }, [environment, method]);
  const device = devices.find(d => d.serial === serial);
  const status = devicePresentation(environment ? { ...environment, devices } : environment, device, error);
  const ready = status.tone === 'ready';
  const busy = submitting || jobs.some(j => j.serial === serial && ['deploy', 'launch', 'device-setup'].includes(j.type) && j.status === 'running');
  const canInstall = ready && project && !project.missing && !project.error && !busy;
  const connected = device?.status === 'device';
  const developerReady = connected && !error && !device.inspection?.error && device.inspection?.developerMode === 'enabled';
  async function perform(tool) {
    setSubmitting(true);
    try { await startJob(tool, { serial, ...(project && tool !== 'aiui_device_enable_developer' ? { projectId: project.id } : {}) }); }
    finally { setSubmitting(false); }
  }
  return <section className="panel device-panel">
    <div className="device-status-top"><span className={`device-status-icon ${status.tone}`}><Glasses size={30}/></span><div className="device-status-copy" role="status" aria-live="polite"><h2>{status.title}</h2><p>{status.description}</p></div><StatusLabel tone={ready ? 'ready' : status.tone === 'warning' ? 'action' : checking ? 'working' : 'idle'}>{t(ready ? '可用' : status.tone === 'warning' ? '待处理' : checking ? '检查中' : '待连接')}</StatusLabel></div>
    <div className="device-connection-methods"><ConnectionMethodTabs method={method} onChange={setMethod} id={id} wirelessConnected={wirelessConnected} usbConnected={usbConnected}/>
      <div role="tabpanel" id={id + '-panel-' + method} aria-labelledby={id + '-tab-' + method}>
        {method === 'wireless' ? <WirelessConnection discovery={discovery} busy={busy} serial={serial} onConnected={setSerial} onReset={() => setSerial('')}/> : <WiredConnection devices={usbDevices}/>}
      </div>
    </div>
    {connected && device.inspection?.developerMode === 'disabled' && <div className="device-mode-action"><button className="button primary" disabled={busy || !!error} onClick={() => perform('aiui_device_enable_developer')}><ShieldCheck size={16}/>{t("开启 AIUI 开发者模式")}</button><span>{t("会重新加载眼镜上的小组件")}</span></div>}
    <div className={"device-workflow " + (!project || !devices.length ? "device-workflow-single" : "")}>
      {!!devices.length && <div className="device-selection"><h3>{t("要使用的眼镜")}</h3>{devices.length > 1 ? <label className="device-field">{t("检测到 ")}{devices.length}{t(" 台设备")}<select aria-label={t("选择眼镜")} value={serial} onChange={e => setSerial(e.target.value)}><option value="">{t("请选择一台眼镜")}</option>{devices.map(d => <option key={d.serial} value={d.serial}>{d.name}{' · '}{d.connection === 'wireless' ? t("无线连接") : t("数据线连接")}{t(" · 尾号 ")}{d.serial.slice(-6)}{d.status === 'unauthorized' ? t(" · 等待授权") : d.status === 'offline' ? t(" · 连接中断") : ''}</option>)}</select></label> : <div className="selected-device"><Glasses size={23}/><div><strong>{device?.name === 'USB 设备' ? t('USB 设备') : device?.name || t("尚未连接")}</strong><span>{device ? (device.connection === 'wireless' ? t("无线连接") : t("数据线连接")) + ' · ' + t("设备尾号 {0}", {0: device.serial.slice(-6)}) : t("无线连接或插线后会出现在这里")}</span></div>{connected && <Check size={17}/>}</div>}
      </div>}
      {project && <div className="device-install">
        <h3>{t('安装当前项目')}</h3>
        <p className="device-hint">{project.name} · {project.version}</p>
        <div className="button-row">
          <button className="button primary" disabled={!canInstall} onClick={() => perform('aiui_device_deploy')}>{busy ? <LoaderCircle className="spin" size={16}/> : <Download size={16}/>} {t('安装到眼镜')}</button>
          <button className="button" disabled={!canInstall} onClick={() => perform('aiui_device_launch')}><Play size={16}/>{t('在眼镜上打开')}</button>
        </div>
        <p className="device-hint">{t(project.missing || project.error ? '源码需要检查' : ready ? '首次使用先安装；安装完成后，点击“在眼镜上打开”。' : '完成上方连接步骤后，即可安装和打开应用。')}</p>
      </div>}
    </div>
    {connected && <details className="device-details"><summary>{t('眼镜使用提示')}<ChevronDown size={15}/></summary>
      <div className="device-usage-grid">
        <div><strong>{t('安装其他 APK')}</strong><p>{t('将 APK 下载到手机，打开 Rokid AI → 工具箱 → 眼镜应用管理 → 安装新应用，选择这个文件。')}</p></div>
        <div><strong>{t('用手机操作眼镜')}</strong><p>{t('Rokid AI → 工具箱 → 遥控器：滑动选中，点击确认，返回键退回。也可以用眼镜镜腿操作。')}</p></div>
      </div><p className="wireless-note">{t(method === 'usb' ? '使用期间保持数据线连接，工坊会自动检测断开和恢复。' : '下次保持眼镜开机、连同一 Wi-Fi 并开启无线调试，工坊会尝试自动重连。')}</p>
    </details>}
    <div className="device-guide-link"><div><strong>{t("第一次连接，或一直找不到眼镜？")}</strong><span>{t("无线连接、调试授权和数据线准备，按需要查看。")}</span></div><button className="button" onClick={goToGuide}>{t("打开新手指南")}</button></div>
    <details className="device-details"><summary><ShieldCheck size={16}/>{t("查看详细信息")}<ChevronDown size={15}/></summary><div className="environment-checks">{[[t("本地运行环境"), environment?.node], [t("应用安装工具"), environment?.aix ? t("可用") : t("待准备")], [t("眼镜连接工具"), environment?.adb ? environment?.adbTool?.source === 'bundled' ? t("客户端内置 · ") + environment.adbTool.version : t("可用") : t("待准备")]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || t("检测中")}</strong></div>)}</div><p className="subtle">{environment?.checkedAt ? t("最近检查：{0} · 开发者模式：{1}", {0: new Date(environment.checkedAt).toLocaleTimeString(getLocale()), 1: developerReady ? t("已开启") : t("尚未确认")}) : t("正在检查环境")}</p>{(device?.inspection?.output || error || environment?.diagnostics?.adb || environment?.diagnostics?.aix) && <pre className="job-output">{device?.inspection?.output || error || [environment.diagnostics.adb, environment.diagnostics.aix].filter(Boolean).join('\n')}</pre>}</details>
  </section>;
}
