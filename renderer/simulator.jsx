import { RecordingControls } from './recording-controls.jsx';
import { t } from './i18n.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, Camera, ChevronRight, Glasses, HelpCircle, Home, Image, Monitor, MousePointer2, Move3D, Play, RotateCcw, Square, Timer, Video } from 'lucide-react';
import { DEFAULT_MOUSE, DEFAULT_MOTION, NEUTRAL_POSE, POSE_AXES, updatePose } from '../shared/pose.mjs';
import { ProjectIcon } from './project-icon.jsx';
import { PreviewAudioButton, PreviewDisplayButton, PreviewFrame } from './preview-frame.jsx';
import { HeadModel } from './head-model.jsx';
import { ImuControls } from './imu-controls.jsx';
import { StatusLabel } from './status-label.jsx';
import './simulator.css';

const degrees = value => Number(value || 0).toFixed(1) + '°';
const controls = [['temple', MousePointer2, '镜腿'], ['head', Move3D, '头部动作'], ['camera', Camera, '相机']];
const statuses = {
  ready: ['ready', '应用运行中'], failed: ['error', '加载失败'], detached: ['action', '预览连接中断'],
};

function Button({ children, icon: Icon, className = '', ...props }) {
  return <button className={'button ' + className} {...props}>{Icon && <Icon size={15}/>} {children}</button>;
}

export function Simulator({ active = true, project, preview, session, opening, onOpen, onHome, onCapture, capturing, act, choosePhoto, previewMuted, onTogglePreviewMute, previewDisplayMode, onTogglePreviewDisplay }) {
  const frame = useRef(null);
  const home = useRef(onHome);
  const stage = useRef(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [live, setLive] = useState(null);
  home.current = onHome;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setLive(null);
    if (!preview) return;
    function receive(e) {
      if (e.source !== frame.current?.contentWindow || e.origin !== new URL(preview.url).origin ||
          e.data?.channel !== 'aiui-preview-state' || e.data.sessionId !== preview.id) return;
      setLive(e.data);
      if (e.data.status === 'closed') home.current(preview.id);
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [preview?.id, preview?.url]);
  useEffect(() => {
    if (!preview) return;
    // An out-of-process iframe can omit pointerleave when the cursor jumps to
    // the desktop chrome or when the workspace is hidden.
    function outside() {
      const url=new URL(preview.url);
      frame.current?.contentWindow?.postMessage({channel:'aiui-preview-control',sessionId:preview.id,key:url.searchParams.get('key'),action:'mouse_leave'},url.origin);
    }
    if (!active) { outside(); return; }
    document.addEventListener('pointermove',outside,true);
    return () => document.removeEventListener('pointermove',outside,true);
  }, [active, preview?.id, preview?.url]);
  function direct(action, parameters = {}) {
    if(action==='pose'||action==='mouse')setLive(previous=>previous?{...previous,state:{...previous.state,...(action==='pose'?{motion:{...previous.state.motion,enabled:false}}:{}),[action]:action==='pose'?updatePose(previous.state.pose,parameters):{...previous.state.mouse,...parameters}}}:previous);
    if(!preview)return;
    const url=new URL(preview.url);
    frame.current?.contentWindow?.postMessage({ channel:'aiui-preview-control', sessionId:preview.id, key:url.searchParams.get('key'), action, parameters }, url.origin);
  }
  const current = { ...preview, ...session, ...live };
  const ready = live?.sessionId === preview?.id && live?.status === 'ready';
  const [tone, label] = preview ? statuses[live?.status || (session?.status === 'detached' ? 'detached' : 'waiting')] || ['working', '正在启动应用…']
    : opening ? ['working', '正在启动应用…'] : ['idle', '应用未运行'];
  const width = preview?.width || 480;
  const height = preview?.height || 352;
  const zoom = stageWidth ? Math.min(1, stageWidth / (width + 24)) : 1;
  const unavailable = !!(project.missing || project.error || !project.pages?.length);
  return <div className="simulation-layout">
    <section className="simulation-stage" aria-label={t('模拟画面')}>
      <div className="stage-toolbar">
        <div className="stage-title"><Monitor size={17}/><h2>{t('眼镜画面')}</h2></div>
        <div className="stage-toolbar-actions">
          <PreviewDisplayButton mode={previewDisplayMode} onToggle={onTogglePreviewDisplay}/>
          <PreviewAudioButton muted={previewMuted} onToggle={onTogglePreviewMute}/>
          {preview && <Button icon={RotateCcw} onClick={() => act('reload')}>{t('重新加载')}</Button>}
        </div>
      </div>
      <div className="device-mat" ref={stage}>
        <div className="screen-device" style={{zoom}}>
          <div className="device-top"><small>ROKID GLASSES</small></div>
          <div className="screen-wrap">
            {preview
              ? <PreviewFrame ref={frame} key={preview.url} title={t('AIUI 官方运行时')} preview={preview} muted={previewMuted} displayMode={previewDisplayMode} width={width} height={height} allow="autoplay; camera" onLoad={() => direct('sync')}/>
              : <div className="simulator-standby" style={{width, height}} aria-label={t('模拟器桌面')} role="region">
                  <ProjectIcon project={project} fallback={Glasses} size={35}/>
                  <strong>{project.name}</strong>
                  <Button icon={Play} className="primary" disabled={unavailable || opening} onClick={onOpen}>{t(opening ? '正在启动应用…' : '运行应用')}</Button>
                  {unavailable && <small>{t(project.missing ? '项目文件缺失' : '源码需要检查')}</small>}
                </div>}
          </div>
          <div className="device-bottom" aria-hidden="true"/>
        </div>
      </div>
      <div className="stage-foot">
        <div className="stage-runtime-info"><StatusLabel tone={tone}>{t(label)}</StatusLabel><span>{width} × {height}</span></div>
        {preview && <div className="stage-toolbar-actions">
          <Button className="mouse-mode" icon={MousePointer2} aria-label={t('鼠标模拟 3DoF')} aria-pressed={(current.state?.mouse || DEFAULT_MOUSE).enabled} disabled={!ready}
            onClick={() => direct('mouse', {enabled:!(current.state?.mouse || DEFAULT_MOUSE).enabled})}>{t('鼠标转头')}</Button>
          <Button icon={Camera} disabled={!ready || capturing} onClick={onCapture}>{t('保存截图')}</Button>
          <Button icon={Home} disabled={!ready} onClick={() => act('exit')}>{t('回到桌面')}</Button>
        </div>}
      </div>
      {preview && <details className="simulator-record">
        <summary><Video size={15}/>{t('录制画面')}<ChevronRight size={15}/></summary>
        <RecordingControls source="simulator" sessionId={preview.id} disabled={!ready} compact/>
      </details>}
      <div className="simulator-ai-note" role="note"><HelpCircle size={14}/><span>{t(current.ai?.enabled
        ? 'AI 自动化验证中 · 由当前 AI 工具临时处理'
        : '电脑模拟 · 佩戴体验及眼镜的 AI 能力请在真机验证。')}</span></div>
    </section>
    <SimulationControls act={act} direct={direct} session={current} ready={ready} choosePhoto={choosePhoto}/>
  </div>;
}

function SimulationControls({ act, direct, session, ready, choosePhoto }) {
  const [tab, setTab] = useState('temple');
  return <aside className="simulation-controls" aria-label={t('操作眼镜')}>
    <div className="control-heading"><Glasses size={19}/><h2>{t('操作眼镜')}</h2></div>
    <div className="glasses-input-tabs" role="group" aria-label={t('眼镜操作方式')}>
      {controls.map(([key, Icon, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}><Icon size={15}/>{t(label)}</button>)}
    </div>
    <div hidden={tab !== 'temple'}><TempleControls act={act} ready={ready}/></div>
    <div hidden={tab !== 'head'}><HeadControls act={act} direct={direct} session={session} ready={ready}/></div>
    {tab === 'camera' && <CameraControls act={act} session={session} ready={ready} choosePhoto={choosePhoto}/>}
  </aside>;
}

function TempleControls({ act, ready }) {
  const [durationMs, setDurationMs] = useState(1500);
  const [busy, setBusy] = useState('');
  const disabled = !ready || !!busy;
  async function send(action, parameters) {
    if (disabled) return;
    setBusy(action);
    try { await act(action, parameters); }
    finally { setBusy(''); }
  }
  return <div className="control-body temple-controls">
    <div className="temple-pad" role="group" aria-label={t('镜腿触控')}>
      <button disabled={disabled} onClick={() => send('swipe', {direction:'backward'})}><ArrowLeft size={20}/>{t('后滑')}</button>
      <button className="temple-confirm" disabled={disabled} onClick={() => send('tap')}><MousePointer2 size={19}/>{t('点按确认')}</button>
      <button disabled={disabled} onClick={() => send('swipe', {direction:'forward'})}><ArrowRight size={20}/>{t('前滑')}</button>
    </div>
    <div className="temple-secondary">
      <Button disabled={disabled} icon={Timer} onClick={() => send('longpress', {durationMs})}>{t(busy === 'longpress' ? '正在长按…' : '长按镜腿')}</Button>
      <Button disabled={disabled} icon={RotateCcw} onClick={() => send('back')}>{t('返回')}</Button>
    </div>
    <p className="subtle">{t('在画面内也可以用方向键滑动、Enter 确认、退格键返回。')}</p>
    <details className="sim-input-detail">
      <summary>{t('长按设置与事件测试')}<ChevronRight size={15}/></summary>
      <label className="axis-control longpress-duration"><span>{t('长按时长')}<strong>{(durationMs / 1000).toFixed(1)}{t(' 秒')}</strong></span>
        <input aria-label={t('长按时长')} type="range" min="0.5" max="5" step="0.1" value={durationMs / 1000} disabled={disabled} onChange={e => setDurationMs(Math.round(Number(e.target.value) * 1000))}/>
      </label>
      <button disabled={disabled} className="test-action" onClick={() => send('swipe', {direction:'forward',repeats:8,intervalMs:60,keyupOnly:true,aliases:true})}><Activity size={15}/><span>{t('一次滑动 · 8 条重复事件')}<small>{t('keyup-only / 方向别名交替')}</small></span><ChevronRight size={14}/></button>
      <button disabled={disabled} className="test-action" onClick={() => send('swipe', {direction:'forward',repeats:22,intervalMs:70})}><Activity size={15}/><span>{t('长滑事件序列')}<small>{t('持续约 1.5 秒')}</small></span><ChevronRight size={14}/></button>
    </details>
  </div>;
}

function HeadControls({ act, direct, session, ready }) {
  const [showImu, setShowImu] = useState(false);
  const imuHeading = useRef(null), imuButton = useRef(null);
  function openImu(enabled) {
    setShowImu(enabled);
    requestAnimationFrame(() => (enabled ? imuHeading : imuButton).current?.focus({ preventScroll: true }));
  }
  const pose = session.state?.pose || NEUTRAL_POSE;
  const mouse = session.state?.mouse || DEFAULT_MOUSE;
  const motion = session.state?.motion || DEFAULT_MOTION;
  return <>
    <div hidden={showImu}>
      <HeadModel pose={pose} sensitivity={mouse.sensitivity} ready={ready} motion={motion.enabled}
        onPose={value => direct('pose', value)} onInteract={() => { if (motion.enabled) direct('pose_motion', {enabled:false}); }}/>
      <div className="control-body head-controls">
        <div className="head-quick-actions">
          <Button icon={RotateCcw} aria-label={t('姿态回正')} disabled={!ready} onClick={() => direct('pose', NEUTRAL_POSE)}>{t('回正')}</Button>
          <Button ref={imuButton} icon={Activity} onClick={() => openImu(true)}>{t('IMU 调试')}</Button>
          {pose.connected === false && <StatusLabel tone="action">{t('姿态流已暂停')}</StatusLabel>}
        </div>
        <div className="head-readout" aria-label={t('实时头部姿态')}>{POSE_AXES.map(([key,label]) => <div key={key}><span>{t(label)}</span><b data-axis={key}>{degrees(pose[key])}</b></div>)}</div>
        <details className="sim-input-detail">
          <summary>{t('精确姿态')}<ChevronRight size={15}/></summary>
        <label className="axis-control sensitivity"><span>{t("鼠标灵敏度")}<strong>{mouse.sensitivity.toFixed(2)}° / px</strong></span><input aria-label={t("鼠标灵敏度")} type="range" min="0.05" max="1" step="0.05" value={mouse.sensitivity} disabled={!ready} onChange={e=>direct('mouse',{sensitivity:Number(e.target.value)})}/></label>
        {POSE_AXES.map(([key,label,min,max])=><label className="axis-control" key={key}><span>{t(label)}<strong>{degrees(pose[key])}</strong></span><input aria-label={t(label)} type="range" min={min} max={max} step="1" value={pose[key]} disabled={!ready} onChange={e=>direct('pose',{[key]:Number(e.target.value)})}/></label>)}
        <label className="switch-row"><span>{t("模拟姿态流")}<small>{t("通过官方传感器接口输入")}</small></span><input aria-label={t("模拟姿态流")} type="checkbox" disabled={!ready} checked={pose.connected!==false} onChange={e=>act('pose_stream',{enabled:e.target.checked})}/></label>
        <p className="subtle">{session.state?.sensorSessions||0}{t(" 个传感器订阅 · ")}{session.state?.readings?.orientation||0}{t(" 次读数")}</p>
        </details>
        <details className="sim-input-detail">
          <summary>{t('自动演示头部动作')}<ChevronRight size={15}/></summary>
        <div className="motion-presets">{[['yaw',t("左右转头")],['pitch',t("抬头点头")],['roll',t("左右侧倾")],['orbit',t("组合动作")]].map(([pattern,label])=><button key={pattern} disabled={!ready} aria-pressed={motion.pattern===pattern} className={motion.pattern===pattern?'active':''} onClick={()=>direct('pose_motion',{pattern})}>{label}</button>)}</div>
        <label className="axis-control"><span>{t("动作幅度")}<strong>{motion.amplitude}°</strong></span><input aria-label={t("动作幅度")} type="range" min="1" max="60" value={motion.amplitude} disabled={!ready} onChange={e=>direct('pose_motion',{amplitude:Number(e.target.value)})}/></label>
        <label className="axis-control"><span>{t("单次周期")}<strong>{(motion.periodMs/1000).toFixed(1)}{t(" 秒")}</strong></span><input aria-label={t("演示周期")} type="range" min="1" max="20" step="0.5" value={motion.periodMs/1000} disabled={!ready} onChange={e=>direct('pose_motion',{periodMs:Number(e.target.value)*1000})}/></label>
        <Button disabled={!ready} className={'full '+(motion.enabled?'':'primary')} icon={motion.enabled?Square:Play} onClick={()=>direct('pose_motion',{enabled:!motion.enabled})}>{motion.enabled?t("停止演示"):t("开始演示")}</Button>
        <div className="control-note"><HelpCircle size={14}/><p>{t("从当前姿态开始循环。在头模或画面内移动鼠标，或调节姿态滑条，即可停止演示并手动接管。")}</p></div>
        </details>
      </div>
    </div>
    <div className="control-body imu-pane" hidden={!showImu}>
      <div className="imu-pane-heading"><h3 ref={imuHeading} tabIndex={-1}>{t('IMU 调试')}</h3><button type="button" className="text-button" onClick={() => openImu(false)}><ArrowLeft size={14}/>{t('返回头部动作')}</button></div>
      <ImuControls imu={session.state?.imu} ready={ready} act={act}/>
    </div>
  </>;
}

function CameraControls({ act, session, ready, choosePhoto }) {
  return <div className="control-body">
      <p className="control-label">{t("相机来源")}</p>
      <div className="motion-presets">{[['fixture',t("本地照片")],['webcam',t("电脑摄像头")]].map(([source,label])=><button key={source} disabled={!ready} className={(session.state?.camera?.source||'fixture')===source?'active':''} aria-pressed={(session.state?.camera?.source||'fixture')===source} onClick={()=>act('camera_source',{source})}>{label}</button>)}</div>
      {session.state?.camera?.source==='webcam'?<p className="subtle">{t("应用重试取景时打开电脑摄像头。首次使用请允许系统或浏览器的相机权限。")}</p>:<button className="fixture-picker" disabled={!ready} onClick={choosePhoto}><Image size={28}/><strong>{session.state?.camera?.fixture?t("已载入模拟照片"):t("选择一张本地照片")}</strong><small>{t("PNG / JPEG / WebP · 本地使用")}</small></button>}
      <p className="subtle" role="status">{session.state?.camera?.activeStreams?t("{0} 路取景正在运行",{0:session.state.camera.activeStreams}):t("等待应用打开相机")}</p>
      {session.state?.camera?.error&&<p className="camera-error" role="alert">{t(session.state.camera.error)}</p>}
      <label className="switch-row"><span>{t("相机权限")}<small>{t("关闭后测试权限拒绝")}</small></span><input aria-label={t("模拟相机权限")} type="checkbox" disabled={!ready} checked={session.state?.camera?.permission!==false} onChange={e=>act('camera_permission',{allowed:e.target.checked})}/></label>
      <div className="control-note"><HelpCircle size={14}/><p>{t("支持连续取景与抓帧定格。选择来源后，在应用中重试取景；照片作为静态画面连续输入。")}</p></div>
      <p className="subtle">{t("拍照输出当前取景帧的 PNG，不模拟眼镜相机的原始分辨率。")}</p>
    </div>;
}
