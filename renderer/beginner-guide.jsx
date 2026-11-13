import { t, getLocale } from './i18n.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
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
    <div className="setup-callout"><strong>{t("也可以使用无线连接")}</strong><p>{t("官方无线方案可减少对专用线的依赖。先按官方说明准备眼镜，再在连接页使用内置 ADB 连接。")}</p><button className="text-button" onClick={()=>api.openOfficial("https://forum.rokid.com/post/detail/3585").catch(e=>notify(e.message,true))}>{t("查看官方无线连接指南")}<ArrowUpRight size={14}/></button></div>
    <div className="setup-footer"><span>{t("第 ")}{step + 1}{t(" 步，共 4 步")}</span><div><button className="button" disabled={step === 0} onClick={() => setStep(value => value - 1)}><ArrowLeft size={14}/>{t("上一步")}</button>{step < 3 && <button className="button primary" onClick={() => setStep(value => value + 1)}>{t("下一步")}<ArrowRight size={14}/></button>}</div></div>
    <div className="guide-troubleshooting"><h3>{t("卡住时，先看这里")}</h3>{[
      [t("眼镜能充电，但工坊一直找不到"), t("先确认使用 Rokid 专用数据调试线，而不是普通充电线。再检查手机 App 中的“眼镜 ADB 调试”开关，重新插紧接口，并尝试直接连接电脑的另一个 USB 端口。")],
      [t("一直显示“等待你允许连接”"), t("戴上眼镜，查看是否有“允许 USB 调试”提示并确认；没看到提示时，拔下数据线再连接一次。无需重复点击检测。")],
      [t("显示“连接工具需要准备”"), t("完整的桌面安装包已自带 ADB，无需另外安装。请确认已完整解压客户端，且安全软件没有隔离连接工具；仍有问题时，返回第 3 步选择官方工具作为备用。")],
      [t("Windows 上仍然识别不到设备"), t("在 Windows 设备管理器里查看是否有带黄色感叹号的眼镜设备。若有，按 Rokid 官方驱动说明处理；完成后重新连接。")],
      [t("暂时没有专用调试线"), t("可以先使用模拟器，也可以查看官方无线 ADB 方案。无线连接需要对应机型和固件支持、眼镜端准备及同一网络；完成后可在连接页输入无线地址。")],
    ].map(([title, body]) => <details className="guide-faq" key={title}><summary>{title}<ChevronRight size={15}/></summary><p>{body}</p>{title.startsWith('Windows') && <button className="text-button" onClick={() => api.openOfficial('https://x-docs.rokid.com/docs/en/faq/%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98.html').catch(e => notify(e.message, true))}>{t("查看官方驱动说明")}<ArrowUpRight size={14}/></button>}</details>)}</div>
  </section>;
}

export function BeginnerGuide({ environment, notify, go, importProject }) {
  const [tab,setTab]=useState('start'),id=useId(),tabButtons=useRef([]);
  const tabs=[['start','开始使用'],['develop','和 AI 开发'],['preview','预览与验证'],['device','装到眼镜'],['publish','发布应用'],['help','遇到问题']];
  function navigateTabs(event,index){let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();setTab(tabs[next][0]);tabButtons.current[next]?.focus();}
  const lessons={
    start:{title:'从一句想法，到第一个眼镜应用',intro:'你负责想法和体验，AI 负责制作；工坊把项目、预览、安装和问题反馈放在一起。',rows:[['先把工坊交给 AI','打开“连接 AI 工具”，复制一条指令。AI 会配置连接、检查 Skill 和环境；需要你点设置时，会说明具体位置。'],['有想法就一起填写','首次连接指令里可以附上想法，准备好后直接制作。留空也没关系，AI 会主动问你想做什么。'],['打开项目，看见应用','AI 创建的项目会出现在“我的项目”。打开后可以看效果、继续提要求，再装到眼镜体验。']],action:'连接 AI 工具',view:'connect'},
    develop:{title:'像描述需求一样，和 AI 做应用',intro:'可以在熟悉的 AI 工具里直接说，也可以用项目页的想法框整理成指令。',rows:[['说清用途、操作和想保留的数据','例如：“做一个喝水提醒，滑动选择，单击记录，记住今天喝了几次。”不需要自己指定框架或命令。'],['AI 读取规范，修改真实项目','官方 Skill 负责开发规则，工坊补充执行流程。已有项目会继续使用同一份源码，不必每次重新创建。'],['看着效果，继续调整','打开项目查看最新画面，然后告诉 AI：“字大一点”“加一个今日目标”。项目页也有继续完善、修复、验证和安装的预置指令。'],['只在需要你时停下来','代码和构建问题先交给 AI；连接、授权等操作会明确告诉你。完成后说“继续”，接着原任务走。']],action:'查看我的项目',view:'projects'},
    preview:{title:'先在电脑试，再确认眼镜体验',intro:'预览、检查、打包是开发流程的一部分。AI 会合并执行并返回证据，你不用逐项点工具。',rows:[['打开项目，尝试关键操作','在项目页看实时效果，或打开完整模拟器，试单击、返回、滑动、头部姿态和相机等功能。'],['让 AI 验证实际功能','不只检查能否打开，还要验证记录有没有保存、菜单是否移动正确。AI 会检查应用行为、截图和运行日志。'],['修改以后，重新验证打包','源码或 SDK 变化后，旧的验证和安装包可能失效。让 AI 按当前版本重测，再生成新的安装包。'],['真机能力，留到眼镜确认','模拟器不具备所有语音、模型和硬件能力。AI 会说明限制并改用真机；模拟通过不代表佩戴效果已经通过。']],action:'打开模拟器',view:'simulator'},
    publish:{title:'准备好以后，再决定是否发布',intro:'本地做出应用、安装体验和正式上架是不同的步骤，你可以在任意合适的位置停下。',rows:[['先完成核心体验','确认关键功能、长滑只执行一次、返回操作和数据保存。实际佩戴后再判断文字、响应和使用感受。'],['让 AI 准备发布材料','可以让 AI 检查安装包、图标、截图和应用介绍，再到“构建与上传”核对平台账号和应用绑定。'],['先保存草稿，再由你确认','AI 可以准备并上传草稿；正式提审需要你在工坊核对并确认，审核和发布状态以官方平台为准。']],action:'构建与上传',view:'publish'},
    help:{title:'卡住时，让 AI 知道发生了什么',intro:'工坊会把预览、任务和界面的问题反馈给 AI。通常不需要你复制整段日志。',rows:[['AI 连不上工坊','先打开工坊；已打开但没有响应时重启。让 AI 再读一次工坊，必要时刷新 MCP 连接。连接页保留了可复制的完整指令。'],['AI 说没有某个工具','检查工坊是否有更新，重新打开当前版本并刷新 AI 连接。部分客户端需要新聊天才能看到新工具；继续原项目，不重建应用。'],['眼镜未连接或未授权','到“装到眼镜”查看 ADB、调试授权和数据线步骤。完成后告诉 AI“继续”，或在项目页重新检查并继续。'],['网络或平台暂时不可用','让 AI 读取具体错误，区分网络、登录和服务状态。只处理它指出的必要操作；恢复后接着同一任务，不重复创建或上传。']],action:'连接检查与恢复',view:'connect'},
  },lesson=lessons[tab];
  return <><div className="page-heading"><div><h1>{t('新手指南')}</h1><p>{t('从连接 AI 到做出应用，按你现在需要的部分查看。')}</p></div></div>
    <div className="guide-tabs" role="tablist" aria-label={t('新手指南模块')}>{tabs.map(([key,label],index)=><button key={key} ref={node=>{tabButtons.current[index]=node;}} role="tab" id={id+'-'+key} aria-selected={tab===key} aria-controls={id+'-panel'} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={event=>navigateTabs(event,index)}>{t(label)}</button>)}</div>
    <div role="tabpanel" id={id+'-panel'} aria-labelledby={id+'-'+tab} tabIndex={0} className="guide-tab-panel">
      {tab==='device'?<ConnectionGuide environment={environment} notify={notify} go={go}/>:<section className="panel guide-lesson"><div className="guide-lesson-heading"><h2>{t(lesson.title)}</h2><p>{t(lesson.intro)}</p></div><ol className="guide-lesson-rows">{lesson.rows.map(([title,body],index)=><li key={title}><span>{index+1}</span><div><h3>{t(title)}</h3><p>{t(body)}</p></div></li>)}</ol><button className="button primary" onClick={()=>go(lesson.view)}>{t(lesson.action)}<ArrowRight size={16}/></button>{tab==='help'&&<button className="button guide-secondary-action" onClick={()=>go('logs')}>{t('查看问题与记录')}</button>}</section>}
      {tab==='start'&&<section className="panel simulator-intro"><Monitor size={25}/><div><h2>{t('还没有眼镜，也可以先体验')}</h2><p>{t('先让 AI 做出应用，在模拟器中尝试；准备好以后再连接眼镜。')}</p></div><button className="button" onClick={importProject}><FolderOpen size={15}/>{t('导入项目')}</button></section>}
    </div>
  </>;
}
