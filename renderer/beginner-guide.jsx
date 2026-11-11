import { t, getLocale } from './i18n.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Cable, CheckCircle2, ChevronRight, Download, FolderOpen, Glasses, Laptop, Monitor, Plug, Settings, Smartphone } from 'lucide-react';

const api = window.workbench;
export const guideSources = {
  cable: 'https://x-docs.rokid.com/docs/en/terminal-sdk/getting-started/%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B.html',
  phone: 'https://github.com/yodaos-project/AIUI/blob/main/documentation/image/quickstart/11.png',
  tools: 'https://developer.android.com/tools/releases/platform-tools',
  devices: 'https://js.rokid.com/AIUI/guide/debug-cli_device_debug',
};

export function ConnectionGuide({ environment, notify, go }) {
  const [step, setStep] = useState(0), [selecting, setSelecting] = useState(false);
  const stepNavigation = useRef(), previousStep = useRef(0);
  useEffect(() => { if (previousStep.current !== step) stepNavigation.current?.scrollIntoView({ block: 'start' }); previousStep.current = step; }, [step]);
  const steps = [[t("准备专用线"), Cable], [t("开启眼镜 ADB"), Smartphone], [t("检查电脑工具"), Laptop], [t("连接并安装"), Glasses]];
  const connected = environment?.devices?.some(d => d.status === 'device');
  async function openSource(key) { try { await api.openOfficial(guideSources[key]); } catch (error) { notify(error.message, true); } }
  async function chooseTools() {
    setSelecting(true);
    try {
      const directory = await api.chooseDirectory();
      if (directory) { await api.call('aiui_adb_configure', { directory }); notify(t("连接工具已设置，正在自动识别眼镜")); }
    } catch (error) { notify(error.message, true); }
    finally { setSelecting(false); }
  }
  return <section className="connection-guide panel">
    <div className="guide-intro"><div><span className="guide-kicker">{t("第一次连接 · 跟着这 4 步做")}</span><h2>{t("把应用装到眼镜上")}</h2><p>{t("先准备专用线和手机，电脑上的连接状态会自动更新。")}</p></div><span className="guide-live-status"><span className="dot"/>{connected ? t("已识别到眼镜") : t("正在等待眼镜连接")}</span></div>
    <nav ref={stepNavigation} className="setup-steps" aria-label={t("眼镜连接步骤")}>{steps.map(([title, Icon], i) => <button key={title} aria-current={step === i ? 'step' : undefined} onClick={() => setStep(i)}><span>{i + 1}</span><Icon size={17}/>{title}</button>)}</nav>
    <div className="setup-content" key={step}>
      {step === 0 && <><div className="setup-caption">{t("01 / 准备硬件")}</div><h3>{t("先确认：你拿的是数据调试线")}</h3><p>{t("需要一根")}<strong>{t("适配 Rokid Glasses 的专用数据调试线（ADB 开发线）")}</strong>{t("。连接眼镜的一端必须匹配你的机型，电脑端可按接口选择 USB-A 或 USB-C。")}</p><div className="cable-diagram"><span><Laptop size={32}/>{t("电脑")}</span><div><span className="cable-line"/><Cable size={24}/><strong>{t("Rokid 专用数据调试线")}</strong></div><span><Glasses size={34}/>{t("眼镜")}</span></div><div className="setup-callout"><strong>{t("能充电，不代表能传数据")}</strong><p>{t("普通磁吸充电线、只充电的转接头无法用于 ADB 调试。选购或借用前，请向 Rokid 官方确认这根线支持你的眼镜型号和数据调试。")}</p></div><ul className="setup-checklist"><li><CheckCircle2 size={16}/>{t("眼镜已开机，并有足够电量。")}</li><li><CheckCircle2 size={16}/>{t("手机已安装 Rokid AI App，并与眼镜连接。")}</li><li><CheckCircle2 size={16}/>{t("数据调试线直接接电脑；转接器也需要支持数据传输。")}</li></ul><button className="text-button" onClick={() => openSource('cable')}>{t("查看官方调试线说明")}<ArrowUpRight size={14}/></button></>}
      {step === 1 && <><div className="setup-caption">{t("02 / 在手机上操作")}</div><h3>{t("打开“眼镜 ADB 调试”")}</h3><p>{t("ADB 是电脑和眼镜之间的连接工具。先在")}<strong>{t("手机的 Rokid AI App")}</strong>{t("里允许它连接眼镜。")}</p><ol className="phone-steps"><li><span>1</span><div><strong>{t("打开 Rokid App，进入“主页”")}</strong><p>{t("确认顶部眼镜卡片显示已连接。这里操作的是手机 App。")}</p></div></li><li><span>2</span><div><strong>{t("点眼镜卡片右侧的齿轮 ")}<Settings size={15}/></strong><p>{t("进入“眼镜设置”，向下找到“开发者”（有些版本称为“开发者选项”）。")}</p></div></li><li><span>3</span><div><strong>{t("打开“眼镜 ADB 调试”开关")}</strong><p>{t("若出现确认提示，按提示允许。然后用专用数据调试线连接电脑与眼镜。")}</p></div></li><li><span>4</span><div><strong>{t("如果出现“允许 USB 调试”，在眼镜上确认")}</strong><p>{t("工坊会自动识别授权结果。看不到“开发者”入口时，先确认手机 App 已连接眼镜并更新到可用版本，再对照官方图示。")}</p></div></li></ol><button className="button" onClick={() => openSource('phone')}><Smartphone size={16}/>{t("对照官方设置图")}<ArrowUpRight size={14}/></button></>}
      {step === 2 && <><div className="setup-caption">{t("03 / 在电脑上操作")}</div><h3>{environment?.adb ? environment?.adbTool?.source === 'bundled' ? t("工坊已自带 ADB，无需另外安装") : t("电脑连接工具已准备好") : t("检查电脑连接工具")}</h3>{environment?.adb ? <div className="setup-callout ready"><CheckCircle2 size={21}/><div><strong>{environment?.adbTool?.source === 'bundled' ? t("内置连接工具已就绪，可以直接下一步。") : t("工坊已经找到 ADB，可以直接下一步。")}</strong><p>{t("不需要安装 Android Studio，也不用配置环境变量。工坊会自动使用连接工具。")}</p></div></div> : <><p>{t("桌面安装包已经自带 ADB。若这里仍提示缺少工具，请重新解压完整的工坊安装包；也可以按下面的方法选择外部工具作为备用。")}</p><p>{t("备用工具请使用 Android 官方的 ")}<strong>SDK Platform-Tools</strong>{t("，不需要安装完整 Android Studio。")}</p><ol className="phone-steps"><li><span>1</span><div><strong>{t("打开官方下载页，选择你的电脑系统")}</strong><p>{t("Windows、Mac 和 Linux 对应不同下载按钮。阅读下载页的条款后，由你确认下载。")}</p><button className="button" onClick={() => openSource('tools')}><Download size={15}/>{t("打开 Android 官方下载页")}<ArrowUpRight size={14}/></button></div></li><li><span>2</span><div><strong>{t("解压下载的 ZIP 文件")}</strong><p>{t("得到 platform-tools 文件夹，里面应包含 adb（Windows 为 adb.exe）。不要直接选择 ZIP 压缩包。")}</p></div></li><li><span>3</span><div><strong>{t("让工坊记住这个文件夹")}</strong><p>{t("点击下面的按钮选择 platform-tools，工坊会自动检查和使用它，不用手动设置 PATH。")}</p><button className="button primary" disabled={selecting} onClick={chooseTools}><FolderOpen size={15}/>{selecting ? t("正在检查…") : t("选择已解压的工具文件夹")}</button></div></li></ol></>}<details className="guide-faq"><summary>{t("高级选项：使用其他 ADB")}</summary><p>{t("一般使用工坊内置版本即可。需要使用其他版本时，选择包含 adb 或 adb.exe 的文件夹；工坊会记住这个选择。")}</p><button className="button" disabled={selecting} onClick={chooseTools}><FolderOpen size={15}/>{t("选择工具文件夹")}</button></details></>}
      {step === 3 && <><div className="setup-caption">{t("04 / 回到工坊")}</div><h3>{t("看到“眼镜已就绪”，就可以安装")}</h3><p>{t("打开“连接眼镜”页面，工坊会自动检查 USB 连接、授权和眼镜运行环境。")}</p><ol className="phone-steps"><li><span>1</span><div><strong>{t("在“项目库”添加你的应用")}</strong><p>{t("选择“导入项目”，找到已有应用的文件夹；也可以新建项目，再连接 AI 工具帮你制作。")}</p></div></li><li><span>2</span><div><strong>{t("在“连接眼镜”里选择应用")}</strong><p>{t("只有一台设备时会自动选中。连接多台设备时，请按名称和设备尾号确认目标。")}</p></div></li><li><span>3</span><div><strong>{t("点击“安装到眼镜”")}</strong><p>{t("等待下方任务记录显示完成，再点击“在眼镜上打开”，戴上眼镜检查画面。")}</p></div></li></ol><div className="setup-callout"><strong>{t("ADB 调试和 AIUI 开发者模式是两个检查项")}</strong><p>{t("若连接页提示“还需要开启开发者模式”，可使用页面上的“开启 AIUI 开发者模式”。开启时眼镜上的小组件会重新加载。")}</p></div><button className="button primary" onClick={() => go('devices')}><Glasses size={16}/>{t("前往连接眼镜")}<ArrowRight size={16}/></button></>}
    </div>
    <div className="setup-footer"><span>{t("第 ")}{step + 1}{t(" 步，共 4 步")}</span><div><button className="button" disabled={step === 0} onClick={() => setStep(value => value - 1)}><ArrowLeft size={14}/>{t("上一步")}</button>{step < 3 && <button className="button primary" onClick={() => setStep(value => value + 1)}>{t("下一步")}<ArrowRight size={14}/></button>}</div></div>
    <div className="guide-troubleshooting"><h3>{t("卡住时，先看这里")}</h3>{[
      [t("眼镜能充电，但工坊一直找不到"), t("先确认使用 Rokid 专用数据调试线，而不是普通充电线。再检查手机 App 中的“眼镜 ADB 调试”开关，重新插紧接口，并尝试直接连接电脑的另一个 USB 端口。")],
      [t("一直显示“等待你允许连接”"), t("戴上眼镜，查看是否有“允许 USB 调试”提示并确认；没看到提示时，拔下数据线再连接一次。无需重复点击检测。")],
      [t("显示“连接工具需要准备”"), t("完整的桌面安装包已自带 ADB，无需另外安装。请确认已完整解压客户端，且安全软件没有隔离连接工具；仍有问题时，返回第 3 步选择官方工具作为备用。")],
      [t("Windows 上仍然识别不到设备"), t("在 Windows 设备管理器里查看是否有带黄色感叹号的眼镜设备。若有，按 Rokid 官方驱动说明处理；完成后重新连接。")],
      [t("暂时没有专用调试线"), t("可以先在项目库导入应用，使用电脑上的模拟器预览。真机 USB 安装要等专用线准备好；通过手机更新云端资源包是另一条流程，可在官方资料中查看。")],
    ].map(([title, body]) => <details className="guide-faq" key={title}><summary>{title}<ChevronRight size={15}/></summary><p>{body}</p>{title.startsWith('Windows') && <button className="text-button" onClick={() => api.openOfficial('https://x-docs.rokid.com/docs/en/faq/%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98.html').catch(e => notify(e.message, true))}>{t("查看官方驱动说明")}<ArrowUpRight size={14}/></button>}</details>)}</div>
  </section>;
}

export function BeginnerGuide({ environment, notify, go, importProject }) {
  return <><div className="page-heading"><div><h1>{t("新手指南")}</h1><p>{t("从准备一根线开始，一步一步连接你的眼镜。")}</p></div></div><ConnectionGuide environment={environment} notify={notify} go={go}/><section className="panel simulator-intro"><Monitor size={25}/><div><h2>{t("还没有眼镜，也可以先体验")}</h2><p>{t("导入应用后，在电脑模拟器中查看页面、尝试操作。")}</p></div><button className="button" onClick={importProject}><FolderOpen size={15}/>{t("导入项目")}</button><button className="button" onClick={() => go('connect')}><Plug size={15}/>{t("连接 AI 工具")}</button></section></>;
}
