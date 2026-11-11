import {RecordingControls} from './recording-controls.jsx';
import { t, getLocale } from './i18n.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, Camera, ChevronRight, Glasses, HelpCircle, Home, Image, Monitor, MousePointer2, Move3D, Play, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Square } from 'lucide-react';
import { DEFAULT_MOUSE, DEFAULT_MOTION, NEUTRAL_POSE, POSE_AXES, updatePose } from '../shared/pose.mjs';
import { DesktopNavigation } from './desktop-navigation.mjs';
import { ProjectIcon } from './project-icon.jsx';
import { HeadModel } from './head-model.jsx';
import './simulator.css';

const degrees = value => Number(value || 0).toFixed(1) + '°';
function Button({ children, icon: Icon, className = '', ...props }) {
  return <button className={'button ' + className} {...props}>{Icon && <Icon size={15}/>} {children}</button>;
}

export function Simulator({ projects, project, preview, session, onOpen, onHome, onImport, onCapture, capturing, act, choosePhoto }) {
  const frame = useRef(null), home = useRef(onHome);
  const [live, setLive] = useState(null);
  home.current = onHome;
  useEffect(() => {
    setLive(null);
    if (!preview) return;
    function receive(e) {
      if (e.source !== frame.current?.contentWindow || e.origin !== new URL(preview.url).origin ||
          e.data?.channel !== 'aiui-preview-state' || e.data.sessionId !== preview.id) return;
      setLive(e.data);
      if (e.data.status === 'closed') home.current(preview.id);
    }
    // An out-of-process iframe can omit pointerleave when the cursor jumps to
    // the desktop chrome. Any pointer event in the outer document is outside
    // the preview and explicitly clears its previous cursor anchor.
    function outside() {
      const url=new URL(preview.url);
      frame.current?.contentWindow?.postMessage({channel:'aiui-preview-control',sessionId:preview.id,key:url.searchParams.get('key'),action:'mouse_leave'},url.origin);
    }
    window.addEventListener('message', receive);
    document.addEventListener('pointermove',outside,true);
    return () => {window.removeEventListener('message', receive);document.removeEventListener('pointermove',outside,true);};
  }, [preview?.id, preview?.url]);
  function direct(action, parameters = {}) {
    if(action==='pose'||action==='mouse')setLive(previous=>previous?{...previous,state:{...previous.state,...(action==='pose'?{motion:{...previous.state.motion,enabled:false}}:{}),[action]:action==='pose'?updatePose(previous.state.pose,parameters):{...previous.state.mouse,...parameters}}}:previous);
    const url=new URL(preview.url);
    frame.current?.contentWindow?.postMessage({ channel:'aiui-preview-control', sessionId:preview.id, key:url.searchParams.get('key'), action, parameters }, url.origin);
  }
  const current = { ...session, ...(live || {}) }, pose = current.state?.pose || NEUTRAL_POSE;
  const mouse = current.state?.mouse || DEFAULT_MOUSE, ready = live?.status === 'ready';
  const status = { ready:t("预览运行中"), failed:t("加载失败"), closed:t("应用已退出"), detached:t("预览连接中断") }[current.status] || t("正在加载");
  return <div className="simulation-layout">
    <section className="simulation-stage">
      <div className="stage-toolbar">
        <span><span className={'dot ' + (current.status === 'failed' ? 'error' : '')}/>{preview ? status : t("模拟器桌面")}</span>
        <span>Rokid Glasses <span className="stage-divider">/</span> {preview?.width || 480} × {preview?.height || 352}</span>
        {preview ? <Button icon={Home} onClick={() => act('exit')}>{t("回到桌面")}</Button> : <span className="pill">{t("本地应用")}</span>}
      </div>
      {preview && <div className="mouse-toolbar">
        <button className={'mouse-mode ' + (mouse.enabled ? 'active' : '')} aria-label={t("鼠标模拟 3DoF")} aria-pressed={mouse.enabled} disabled={!ready} onClick={() => direct('mouse', {enabled:!mouse.enabled})}><MousePointer2 size={14}/>{t("鼠标 3DoF")}</button>
        <span>{mouse.enabled ? t("移动转头 · Shift 移动侧倾 · 单击确认") : t("鼠标直接操作应用")}</span>
        <button className="pose-reset" aria-label={t("姿态回正")} disabled={!ready} onClick={() => direct('pose', NEUTRAL_POSE)}><RotateCcw size={14}/>{t("回正")}</button>
      </div>}
      <div className="device-mat"><div className="screen-device">
        <div className="device-top"><span/><small>AIUI DISPLAY</small><span/></div>
        <div className="screen-wrap">{preview
          ? <iframe ref={frame} title={t("AIUI 官方运行时")} key={preview.id} src={preview.url} width={preview.width || 480} height={preview.height || 352} allow="autoplay; camera" onLoad={() => direct('sync')}/>
          : <Desktop projects={projects} initialSelected={project?.id} onOpen={onOpen} onImport={onImport}/>}</div>
        <div className="device-bottom"><span>ROKID</span><span>SIMULATION</span></div>
      </div></div>
      {preview && <div className={'pose-readout ' + (mouse.dragging ? 'is-dragging' : '')} aria-label={t("实时头部姿态")}>
        <span><Move3D size={14}/>{pose.connected === false ? t("姿态流已暂停") : mouse.dragging ? t("正在转动头部") : t("头部姿态")}</span>
        <span>{t("转头 ")}<b data-axis="yaw">{degrees(pose.yaw)}</b></span><span>{t("俯仰 ")}<b data-axis="pitch">{degrees(pose.pitch)}</b></span><span>{t("侧倾 ")}<b data-axis="roll">{degrees(pose.roll)}</b></span>
      </div>}
      <div className="stage-foot"><span><ShieldCheck size={13}/>{preview ? t("原项目源码 · ") + (project?.revision?.slice(0,8) || '—') : t("{0} 个本地项目", {0: projects.length})}</span><span>{t("桌面与硬件输入均为模拟")}</span></div>
    </section>
    {preview ? <aside className="simulation-sidebar" aria-label={t('模拟器工具')}><RecordingControls source="simulator" sessionId={preview.id} disabled={!ready} onCapture={onCapture} capturing={capturing}/><SimulationControls act={act} direct={direct} session={current} ready={ready} choosePhoto={choosePhoto}/></aside> : <section className="simulation-controls desktop-help">
      <div className="control-heading"><Glasses size={17}/><strong>{t("从桌面开始")}</strong></div>
      <div className="control-body"><h2>{t("选择应用，即刻运行")}</h2><p>{t("项目库中的 AIUI 应用会自动出现在桌面。点击图标即可启动。")}</p>
        <div className="desktop-help-item"><MousePointer2 size={19}/><span>{t("鼠标选择")}<small>{t("点击图标运行，滚动查看更多")}</small></span></div>
        <div className="desktop-help-item"><ArrowRight size={19}/><span>{t("镜腿 / 键盘导航")}<small>{t("方向键选择 · Enter 运行")}<br/>{t("一次长按只移动一项")}</small></span></div>
        <div className="desktop-help-item"><Home size={19}/><span>{t("随时回到桌面")}<small>{t("应用退出后自动返回，也可点击")}<br/>{t("运行界面的“回到桌面”")}</small></span></div>
        <Button icon={Plus} className="full" onClick={onImport}>{t("导入 AIUI 项目")}</Button>
      </div>
    </section>}
  </div>;
}

function Desktop({projects, initialSelected, onOpen, onImport}) {
  const [selected, setSelected] = useState(initialSelected), navigation = useRef(new DesktopNavigation()), root = useRef(null);
  const available = projects.filter(p => !p.error && p.pages?.length);
  const active = available.some(p => p.id === selected) ? selected : available[0]?.id;
  useEffect(() => {
    root.current?.focus({preventScroll:true});
    const reset = () => navigation.current.reset();
    window.addEventListener('blur', reset);document.addEventListener('visibilitychange', reset);
    return () => { reset();window.removeEventListener('blur', reset);document.removeEventListener('visibilitychange', reset); };
  }, []);
  useEffect(() => { if(active)root.current?.querySelector(`[data-project-id="${active}"]`)?.scrollIntoView({block:'nearest'}); }, [active]);
  function key(e) {
    const step = navigation.current.handle(e.type, e.nativeEvent);
    if (step !== null) {
      e.preventDefault();e.stopPropagation();
      root.current.focus({preventScroll:true});
      if (step && available.length) {
        setSelected(previous=>{const index=available.findIndex(p=>p.id===(previous||active));return available[(index+step+available.length)%available.length].id;});
      }
    } else if (e.code === 'Enter' && e.target === root.current) {
      e.preventDefault();e.stopPropagation();
      if(e.type === 'keyup' && !e.repeat) { const p=available.find(p=>p.id===active);if(p)onOpen(p); }
    }
  }
  return <div className="glasses-desktop" role="region" aria-label={t("模拟器桌面")} tabIndex={0} ref={root} onKeyDown={key} onKeyUp={key} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))navigation.current.reset();}}>
    <div className="desktop-status"><span><Glasses size={15}/> AIUI</span><span>{t("本地应用 · ")}{projects.length}</span></div>
    <div className="desktop-title"><strong>{t("我的应用")}</strong><span>{t("选择一个应用，带到眼前。")}</span></div>
    {projects.length ? <div className="launcher-grid">{projects.map(p => {
      const unavailable = p.error || !p.pages?.length;
      return <button key={p.id} data-project-id={p.id} className={'launcher-app '+(active===p.id?'selected':'')} aria-pressed={active===p.id} aria-label={t("运行 ")+p.name} disabled={!!unavailable} title={unavailable || p.name} onFocus={()=>setSelected(p.id)} onClick={()=>{setSelected(p.id);onOpen(p);}}>
        <span className="launcher-icon"><ProjectIcon project={p} fallback={Monitor} size={27}/></span><strong>{p.name}</strong><small>{unavailable?t("暂不可运行"):p.version}</small>
      </button>;
    })}</div> : <div className="launcher-empty"><Monitor size={32}/><strong>{t("桌面还没有应用")}</strong><span>{t("导入本地 AIUI 项目后即可运行")}</span><button onClick={onImport}><Plus size={14}/>{t("导入项目")}</button></div>}
    <div className="desktop-dock"><span>{t("方向键选择 · Enter 运行")}</span><button aria-label={t("桌面导入项目")} onClick={onImport}><Plus size={14}/>{t(" 添加应用")}</button></div>
  </div>;
}

function SimulationControls({act,direct,session,ready,choosePhoto}) {
  const [tab,setTab]=useState('pose');
  const pose=session.state?.pose||NEUTRAL_POSE,mouse=session.state?.mouse||DEFAULT_MOUSE,motion=session.state?.motion||DEFAULT_MOTION;
  return <section className="simulation-controls">
    <div className="control-heading"><SlidersHorizontal size={16}/><strong>{t("模拟控制")}</strong><span className="pill">{t("模拟输入")}</span></div>
    <HeadModel pose={pose} sensitivity={mouse.sensitivity} ready={ready} motion={motion.enabled} onPose={value=>direct('pose',value)} onInteract={()=>{if(motion.enabled)direct('pose_motion',{enabled:false});}}/>
    <div className="control-tabs">{[['pose',Move3D,t("姿态")],['motion',Play,t("演示")],['input',MousePointer2,t("交互")],['camera',Camera,t("相机")]].map(([key,Icon,label])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}><Icon size={14}/>{label}</button>)}</div>
    {tab==='input'&&<div className="control-body"><p className="control-label">{t("镜腿触控")}</p><button className="temple-tap" disabled={!ready} onClick={()=>act('tap')}><MousePointer2 size={23}/><strong>{t("单击确认")}</strong><kbd>Enter</kbd></button><div className="swipe-pair"><button disabled={!ready} onClick={()=>act('swipe',{direction:'backward'})}><ArrowLeft size={19}/><span>{t("后滑")}</span></button><button disabled={!ready} onClick={()=>act('swipe',{direction:'forward'})}><ArrowRight size={19}/><span>{t("前滑")}</span></button></div><Button disabled={!ready} icon={RotateCcw} className="full" onClick={()=>act('back')}>{t("返回 ")}<kbd>Backspace</kbd></Button><div className="control-divider"/><p className="control-label">{t("固件事件测试")}</p><button disabled={!ready} className="test-action" onClick={()=>act('swipe',{direction:'forward',repeats:8,intervalMs:60,keyupOnly:true,aliases:true})}><Activity size={15}/><span>{t("一次滑动 · 8 条重复事件")}<small>{t("keyup-only / 方向别名交替")}</small></span><ChevronRight size={14}/></button><button disabled={!ready} className="test-action" onClick={()=>act('swipe',{direction:'forward',repeats:22,intervalMs:70})}><Activity size={15}/><span>{t("长滑事件序列")}<small>{t("持续约 1.5 秒")}</small></span><ChevronRight size={14}/></button><div className="control-note"><HelpCircle size={14}/><p>{t("发送原始事件，检验应用是否正确合并。佩戴手感需在眼镜上确认。")}</p></div></div>}
    {tab==='pose'&&<div className="control-body">
      <label className="switch-row mouse-switch"><span>{t("鼠标模拟 3DoF")}<small>{t("移入画面直接移动，无需按下")}</small></span><input aria-label={t("启用鼠标姿态")} type="checkbox" disabled={!ready} checked={mouse.enabled} onChange={e=>direct('mouse',{enabled:e.target.checked})}/></label>
      <label className="axis-control sensitivity"><span>{t("鼠标灵敏度")}<strong>{mouse.sensitivity.toFixed(2)}° / px</strong></span><input aria-label={t("鼠标灵敏度")} type="range" min="0.05" max="1" step="0.05" value={mouse.sensitivity} disabled={!ready} onChange={e=>direct('mouse',{sensitivity:Number(e.target.value)})}/></label>
      <div className="control-divider"/><p className="control-label">{t("精确姿态")}</p>
      {POSE_AXES.map(([key,label,min,max])=><label className="axis-control" key={key}><span>{t(label)}<strong>{degrees(pose[key])}</strong></span><input aria-label={t(label)} type="range" min={min} max={max} step="1" value={pose[key]} disabled={!ready} onChange={e=>direct('pose',{[key]:Number(e.target.value)})}/></label>)}
      <Button disabled={!ready} className="full" icon={RotateCcw} onClick={()=>direct('pose',NEUTRAL_POSE)}>{t("回到中立姿态")}</Button>
      <label className="switch-row"><span>{t("模拟姿态流")}<small>{t("通过官方传感器接口输入")}</small></span><input aria-label={t("模拟姿态流")} type="checkbox" disabled={!ready} checked={pose.connected!==false} onChange={e=>act('pose_stream',{enabled:e.target.checked})}/></label>
      <p className="subtle">{session.state?.sensorSessions||0}{t(" 个传感器订阅 · ")}{session.state?.readings?.orientation||0}{t(" 次读数")}</p>
    </div>}
    {tab==='motion'&&<div className="control-body">
      <p className="control-label">{t("自动演示头部动作")}</p>
      <div className="motion-presets">{[['yaw',t("左右转头")],['pitch',t("抬头点头")],['roll',t("左右侧倾")],['orbit',t("组合动作")]].map(([pattern,label])=><button key={pattern} disabled={!ready} aria-pressed={motion.pattern===pattern} className={motion.pattern===pattern?'active':''} onClick={()=>direct('pose_motion',{pattern})}>{label}</button>)}</div>
      <label className="axis-control"><span>{t("动作幅度")}<strong>{motion.amplitude}°</strong></span><input aria-label={t("动作幅度")} type="range" min="1" max="60" value={motion.amplitude} disabled={!ready} onChange={e=>direct('pose_motion',{amplitude:Number(e.target.value)})}/></label>
      <label className="axis-control"><span>{t("单次周期")}<strong>{(motion.periodMs/1000).toFixed(1)}{t(" 秒")}</strong></span><input aria-label={t("演示周期")} type="range" min="1" max="20" step="0.5" value={motion.periodMs/1000} disabled={!ready} onChange={e=>direct('pose_motion',{periodMs:Number(e.target.value)*1000})}/></label>
      <Button disabled={!ready} className={'full '+(motion.enabled?'':'primary')} icon={motion.enabled?Square:Play} onClick={()=>direct('pose_motion',{enabled:!motion.enabled})}>{motion.enabled?t("停止演示"):t("开始演示")}</Button>
      <div className="control-note"><HelpCircle size={14}/><p>{t("从当前姿态开始循环。在头模或画面内移动鼠标，或调节姿态滑条，即可停止演示并手动接管。")}</p></div>
    </div>}
    {tab==='camera'&&<div className="control-body">
      <p className="control-label">{t("相机来源")}</p>
      <div className="motion-presets">{[['fixture',t("本地照片")],['webcam',t("电脑摄像头")]].map(([source,label])=><button key={source} disabled={!ready} className={(session.state?.camera?.source||'fixture')===source?'active':''} aria-pressed={(session.state?.camera?.source||'fixture')===source} onClick={()=>act('camera_source',{source})}>{label}</button>)}</div>
      {session.state?.camera?.source==='webcam'?<p className="subtle">{t("应用重试取景时打开电脑摄像头。首次使用请允许系统或浏览器的相机权限。")}</p>:<button className="fixture-picker" disabled={!ready} onClick={choosePhoto}><Image size={28}/><strong>{session.state?.camera?.fixture?t("已载入模拟照片"):t("选择一张本地照片")}</strong><small>{t("PNG / JPEG / WebP · 本地使用")}</small></button>}
      <p className="subtle" role="status">{session.state?.camera?.activeStreams?t("{0} 路取景正在运行",{0:session.state.camera.activeStreams}):t("等待应用打开相机")}</p>
      {session.state?.camera?.error&&<p className="camera-error" role="alert">{t(session.state.camera.error)}</p>}
      <label className="switch-row"><span>{t("相机权限")}<small>{t("关闭后测试权限拒绝")}</small></span><input aria-label={t("模拟相机权限")} type="checkbox" disabled={!ready} checked={session.state?.camera?.permission!==false} onChange={e=>act('camera_permission',{allowed:e.target.checked})}/></label>
      <div className="control-note"><HelpCircle size={14}/><p>{t("支持连续取景与抓帧定格。选择来源后，在应用中重试取景；照片作为静态画面连续输入。")}</p></div>
      <p className="subtle">{t("拍照输出当前取景帧的 PNG，不模拟眼镜相机的原始分辨率。")}</p>
    </div>}
  </section>;
}
