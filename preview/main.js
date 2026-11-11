let createInkView, satisfiesInkEngine, getInkVersion, getInkBundleVersion;
import { DEFAULT_MOUSE, DEFAULT_MOTION, NEUTRAL_POSE, motionPose, poseQuaternion, updatePose } from '../shared/pose.mjs';
import { bindMousePose } from './mouse-pose.mjs';
import { SimulatorCamera } from './camera.mjs';
import mediaRuntime from './media-runtime.js?raw';
import imageCodecRuntime from './image-codec.js?raw';
import fflateRuntime from '../node_modules/fflate/esm/browser.js?raw';
import { CanvasRecording } from './recording.mjs';
import './style.css';

const query = new URLSearchParams(location.search), sessionId = query.get('session'), key = query.get('key');
const canvas = document.querySelector('#screen'), notice = document.querySelector('#status');
let view, current, dead = false, reloading = false, currentStatus = 'loading', logEntries = [], logGeneration = null, pendingCommands = Promise.resolve(), logFlush = Promise.resolve(), runId = crypto.randomUUID();
let pose = { ...NEUTRAL_POSE, connected: true }, mouse = { ...DEFAULT_MOUSE, dragging:false }, battery = { level:.85, charging:false, chargingTime:0, dischargingTime:28800 };
let poseFrame = 0, posePublishTimer = 0, publishQueue = Promise.resolve(), commandActive = false;
let motion = { ...DEFAULT_MOTION }, motionOrigin = { ...pose }, motionStart = 0;
let networkOnline = true, focused = true, target = '_blank';
const sensorSessions = new Map(), batterySessions = new Map(), readings = { orientation:0, photos:0 };
const camera = new SimulatorCamera({ emit:event, changed:()=>{if(currentStatus==='ready')publish().catch(()=>{});}, onPhoto:()=>readings.photos++ });
const recording = new CanvasRecording(canvas,async(id,blob,metadata)=>{const response=await fetch(`/session/${sessionId}/recording/${id}`,{method:'POST',headers:{'X-Preview-Key':key,'Content-Type':blob.type,'X-Recording-Metadata':JSON.stringify(metadata)},body:blob});const result=await response.json();if(!response.ok)throw new Error(result.error||'视频保存失败');return result.result;},()=>publish().catch(()=>{}));
camera.installBrowserMedia();
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
async function request(route, value) { const r=await fetch(`/session/${sessionId}/${route}`,{ method:value===undefined?'GET':'POST', headers:{'Content-Type':'application/json','X-Preview-Key':key}, body:value===undefined?undefined:JSON.stringify(value) }); const data=await r.json(); if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data; }
for(const level of ['log','info','warn','error','debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const message=args.filter(a=>typeof a!=='string'||!(/^(color:|background:|font-weight:)/.test(a))).map(a=>typeof a==='string'?a.replaceAll('%c',''):a instanceof Error?a.stack:JSON.stringify(a)).join(' ');
    logEntries.push({level,message,logGeneration,createdAt:performance.timeOrigin+performance.now(),runId,revision:current?.project?.revision});logEntries=logEntries.slice(-500);
  };
}
window.addEventListener('error',e=>console.error('RUNTIME_ERROR',e.message));
window.addEventListener('unhandledrejection',e=>console.error('UNHANDLED_REJECTION',String(e.reason?.stack||e.reason)));
function flushLogs() { logFlush=logFlush.catch(()=>{}).then(async()=>{while(logEntries.length){const entries=logEntries.splice(0,80);try{await request('log',{entries});}catch(error){logEntries=[...entries,...logEntries].slice(-500);throw error;}}});return logFlush; }
function state() { return { runId, running:view?.isRunning()||false, rendering:view?.isRendering()||false, inputEnabled:view?.isInputEnabled()||false, recording:recording.state(), focused, target, network:{online:networkOnline}, pose:{...pose}, mouse:{...mouse}, motion:{...motion}, sensorSessions:sensorSessions.size, readings:{...readings}, camera:camera.state(), battery, sdkVersion:current?.session?.webSdkVersion, runtime:view?getInkVersion():null, bundleVersion:view?getInkBundleVersion():null, sourceUnmodified:true, runtimePolyfills:{imageEncoding:'image/png',imageCapturePhoto:'preview-frame'}, capabilities:{temple:'simulated',orientation:'simulated',camera:camera.source==='webcam'?'computer-camera':'photo-fixture-stream',battery:'simulated',bluetooth:'unsupported',languageModel:'not-configured',network:'status-events-only'} }; }
function notifyParent(allowClosed=false) { if(window.parent!==window&&!(currentStatus==='closed'&&(!allowClosed||commandActive)))window.parent.postMessage({channel:'aiui-preview-state',sessionId,status:currentStatus,state:state()},'*'); }
function publish(status=currentStatus) {
  notifyParent();
  const body={status,state:state(),revision:current?.project?.revision};
  publishQueue=publishQueue.catch(()=>{}).then(()=>request('state',body)).then(result=>{if(status==='closed')notifyParent(true);return result;});
  return publishQueue;
}
function changedPose(next) {
  pose=next;
  if(!poseFrame)poseFrame=requestAnimationFrame(()=>{poseFrame=0;notifyParent();});
  if(!posePublishTimer)posePublishTimer=setTimeout(()=>{posePublishTimer=0;publish().catch(()=>{});},100);
}
function manualPose(next) { motion.enabled=false;changedPose(next); }
const mouseInput=bindMousePose(canvas,{
  getPose:()=>pose,getOptions:()=>mouse,ready:()=>currentStatus==='ready'&&!reloading&&view?.isInputEnabled(),
  onPose:manualPose,onDrag:dragging=>{mouse.dragging=dragging;notifyParent();},
  onTap:()=>execute('tap').catch(console.error),onInteract:()=>{motion.enabled=false;view?.notifyUserInteraction();},
});
canvas.classList.toggle('mouse-look',mouse.enabled);
window.addEventListener('message',e=>{
  if(e.source!==window.parent||(e.origin!=='null'&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(e.origin))||e.data?.channel!=='aiui-preview-control'||e.data.sessionId!==sessionId||e.data.key!==key)return;
  const {action,parameters}=e.data;
  if(action==='sync'){notifyParent();return;}
  if(action==='mouse_leave'){mouseInput.cancel();return;}
  if(action==='pose') { if(currentStatus!=='ready')return;try{mouseInput.cancel();manualPose(updatePose(pose,parameters||{}));}catch(error){console.error(error);}return; }
  if(!['mouse','pose_motion'].includes(action))return;
  execute(action,parameters).catch(error=>console.error(error));
});
function failed(error){currentStatus='failed';reloading=false;notice.hidden=false;notice.textContent=error.message;console.error(error);publish('failed').catch(()=>{});}
function event(name,detail) { if(view&&!view.isDestroyed())view.getHostCapabilitiesTarget().dispatchEvent(new CustomEvent(name,{detail})); }
function sensorSample() { if(!pose.connected||reloading||currentStatus!=='ready')return; const [x,y,z,w]=poseQuaternion(pose); for(const request of sensorSessions.values()) {event('absoluteOrientation.reading',{...request,x,y,z,w,timestamp:performance.now()});readings.orientation++;} }
const timer=setInterval(()=>{
  if(motion.enabled&&currentStatus==='ready'&&!reloading){changedPose(motionPose(motionOrigin,motion,performance.now()-motionStart));}
  sensorSample();
},1000/60);
document.addEventListener('visibilitychange',()=>{if(document.hidden){motion.enabled=false;mouseInput.cancel();camera.stopAll();publish().catch(()=>{});}});
function capabilities() {
  return {
    absoluteOrientation: {
      start(req){sensorSessions.set(req.targetId,req);console.info('SDK absoluteOrientation.start',JSON.stringify(req));setTimeout(()=>{event('absoluteOrientation.activate',{...req,timestamp:performance.now()});sensorSample();},0);},
      stop(req){sensorSessions.delete(req.targetId);console.info('SDK absoluteOrientation.stop',req.targetId);},
    },
    battery:{start(req){batterySessions.set(req.targetId,req);return battery;},stop(req){batterySessions.delete(req.targetId);}},
    media:camera.capabilities(),
    geolocation:{async getCurrentPosition(){throw new Error('PositionUnavailableError: 尚未设置模拟定位');},async watchPosition(){throw new Error('PositionUnavailableError: 首版未启用模拟定位轨迹');},clearWatch(){}},
    speech:{async speak(req){console.info('SDK speech.speak',JSON.stringify(req));throw new Error('NotSupportedError: 首版未接入语音合成服务');},cancelSpeak(){}},
  };
}
async function load() {
  await recording.stop('source-reloaded');
  reloading=true;currentStatus='loading';notice.hidden=false;notice.textContent='正在加载官方运行时…';
  motion.enabled=false;mouseInput.cancel();camera.stopAll();sensorSessions.clear();batterySessions.clear();if(view){view.setOnClosed(()=>{});view.destroy();view=null;}
  runId=crypto.randomUUID();
  const restore=!current;
  current=await request('bundle');
  if(restore&&current.cameraFixture)await camera.setFixture(current.cameraFixture);
  logGeneration=current.session.logGeneration;
  if(restore){pose=updatePose(pose,current.session.state?.pose||{});pose.connected=current.session.state?.pose?.connected!==false;mouse={...mouse,...current.session.state?.mouse,dragging:false};canvas.classList.toggle('mouse-look',mouse.enabled);}
  const {session,project}=current;
  if (session.sdkError || !session.sdkUrl) throw new Error(session.sdkError || '项目 SDK 未配置');
  ({ createInkView, satisfiesInkEngine, getInkVersion, getInkBundleVersion } = await import(/* @vite-ignore */ session.sdkUrl));
  canvas.style.width=session.width+'px';canvas.style.height=session.height+'px';canvas.width=session.width;canvas.height=session.height;
  view=await createInkView({width:session.width,height:session.height,layoutMode:'bounded',scaleFactor:1,appFps:60,displayColor:{mode:'monochrome',bits:1},surface:{type:'html-canvas',canvas},permissionChecks:true});
  console.info('INK_RUNTIME_VERSION',JSON.stringify({sdk:session.webSdkVersion,engine:getInkVersion(),bundle:getInkBundleVersion()}));
  if(!satisfiesInkEngine(project.engine))throw new Error(`项目要求 ${project.engine}，当前引擎为 ${getInkVersion()}（Web SDK ${session.webSdkVersion}）`);
  view.setHostCapabilities(capabilities());
  view.setOnMessage(message=>console.info('APP_MESSAGE',JSON.stringify(message)));
  view.setOnClosed(async()=>{currentStatus='closing';await recording.stop('application-closed').catch(console.error);currentStatus='closed';motion.enabled=false;mouseInput.cancel();camera.stopAll();sensorSessions.clear();batterySessions.clear();console.info('APP_CLOSED');publish().catch(()=>{});});
  const files=new Map(current.files.map(f=>[f.path,Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))]));
  const polyfillRoot='__aiui_workbench_media__', encode=new TextEncoder();
  for(const file of ['media-runtime.js','image-codec.js','fflate.js'])if(files.has(`${polyfillRoot}/${file}`))throw new Error('项目占用了模拟器媒体适配目录');
  files.set(`${polyfillRoot}/media-runtime.js`,encode.encode(mediaRuntime));
  files.set(`${polyfillRoot}/image-codec.js`,encode.encode(imageCodecRuntime.replace("from 'fflate'", "from './fflate.js'")));
  files.set(`${polyfillRoot}/fflate.js`,encode.encode(fflateRuntime));
  const originalApp=files.has('app.js')?new TextDecoder().decode(files.get('app.js')):'export default {};';
  files.set('app.js',encode.encode(`import './${polyfillRoot}/media-runtime.js';\n`+originalApp));
  view.openBundle({appId:'workbench.'+project.id,files,initialPage:session.page,hostOptions:{initialTarget:session.target,initialFocus:'focus'}});
  target=session.target;focused=true;view.setTarget(target);view.focus();view.bindDomEvents({canvas});view.startRendering();
  if(!networkOnline)view.dispatchConnectivityEvent('offline');
  notice.hidden=true;reloading=false;currentStatus='ready';await publish();console.info('WORKBENCH_PREVIEW_READY',JSON.stringify({project:project.name,revision:project.revision,target:session.target,sourceUnmodified:true}));
}
async function rawKey(type,code,timestamp) { view.notifyUserInteraction();view.dispatchInput(type,code,timestamp??performance.now()); }
async function execute(action,args={}) {
  if(!['reload','exit','observe','record_stop'].includes(action)&&(!view||view.isDestroyed()))throw new Error('运行时尚未就绪');
  switch(action){
    case 'record_start': view.render();return recording.start({...args,revision:current.project.revision,runId});
    case 'record_stop': return recording.stop('stopped');
    case 'observe': break;
    case 'key': {if(!/^(Enter|Backspace|Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space)$/.test(args.code)||!['keydown','keyup'].includes(args.type||'keyup'))throw new Error('不支持的按键');await rawKey(args.type||'keyup',args.code,args.timestamp);break;}
    case 'tap': await rawKey('keydown','Enter');await wait(25);await rawKey('keyup','Enter');break;
    case 'back': await rawKey('keydown','Backspace');await wait(25);await rawKey('keyup','Backspace');break;
    case 'swipe': {
      const codes=args.direction==='backward'?['ArrowLeft','ArrowUp']:['ArrowRight','ArrowDown'];
      const count=Math.max(1,Math.min(50,args.repeats||1)),interval=Math.max(10,Math.min(500,args.intervalMs||45));
      if(count*interval>8000)throw new Error('单次滑动事件序列不能超过 8 秒');
      const begin=performance.now();
      for(let i=0;i<count;i++){const code=args.aliases?codes[i%2]:codes[0];if(!args.keyupOnly)await rawKey('keydown',code,begin+i*interval);await rawKey('keyup',code,begin+i*interval+1);if(i<count-1)await wait(interval);}
      console.info('SIMULATED_SWIPE',JSON.stringify({direction:args.direction||'forward',rawEvents:count,keyupOnly:!!args.keyupOnly}));break;
    }
    case 'pose': mouseInput.cancel();motion.enabled=false;pose=updatePose(pose,args);sensorSample();break;
    case 'pose_motion': {
      if(args.pattern!==undefined&&!['yaw','pitch','roll','orbit'].includes(args.pattern))throw new Error('不支持的头部动作');
      if(args.amplitude!==undefined&&(!Number.isFinite(args.amplitude)||args.amplitude<1||args.amplitude>60))throw new Error('演示幅度范围为 1–60°');
      if(args.periodMs!==undefined&&(!Number.isFinite(args.periodMs)||args.periodMs<1000||args.periodMs>20000))throw new Error('演示周期范围为 1–20 秒');
      mouseInput.cancel();motion={...motion,...Object.fromEntries(['enabled','pattern','amplitude','periodMs'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]]))};
      motion.enabled=!!motion.enabled;motionOrigin={...pose};motionStart=performance.now();break;
    }
    case 'mouse': {
      if(args.sensitivity!==undefined&&(!Number.isFinite(args.sensitivity)||args.sensitivity<0.05||args.sensitivity>1))throw new Error('鼠标灵敏度范围为 0.05–1°/px');
      mouseInput.cancel();
      if(args.enabled!==undefined)mouse.enabled=!!args.enabled;
      if(args.sensitivity!==undefined)mouse.sensitivity=args.sensitivity;
      canvas.classList.toggle('mouse-look',mouse.enabled);break;
    }
    case 'pose_stream': pose.connected=!!args.enabled;motionOrigin.connected=pose.connected;if(pose.connected)sensorSample();break;
    case 'camera_fixture': await camera.setFixture(args.fixture);console.info('SDK 相机已设置本地模拟照片');break;
    case 'camera_source': camera.setSource(args.source);break;
    case 'camera_permission': camera.setPermission(args.allowed);break;
    case 'battery': battery={...battery,...args,level:Math.max(0,Math.min(1,args.level??battery.level))};for(const req of batterySessions.values())event('battery.statuschange',{targetId:req.targetId,...battery});break;
    case 'focus': focused=args.focused!==false;if(!focused){mouseInput.cancel();view.blur();view.setInputEnabled(false);}else{view.setInputEnabled(true);view.focus();}break;
    case 'network': networkOnline=args.online!==false;view.dispatchConnectivityEvent(networkOnline?'online':'offline');break;
    case 'target': mouseInput.cancel();target=args.target==='_current'?'_current':'_blank';view.setTarget(target);break;
    case 'exit': await recording.stop('application-closed');currentStatus='closed';motion.enabled=false;mouseInput.cancel();camera.stopAll();sensorSessions.clear();batterySessions.clear();if(view){view.setOnClosed(()=>{});view.destroy();view=null;}break;
    case 'capture': {view.render();const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;copy.getContext('2d').drawImage(canvas,0,0);return{dataUrl:copy.toDataURL('image/png'),width:copy.width,height:copy.height,revision:current.project.revision,runId};}
    case 'reload': try{await load();}catch(error){failed(error);throw error;}break;
    case 'scenario': {
      if(!Array.isArray(args.steps)||args.steps.length>100)throw new Error('测试场景需要 1–100 个步骤');
      const deadline=Date.now()+65000,results=[];for(const step of args.steps){if(Date.now()>deadline)throw new Error('场景执行达到时间上限');if(step.action==='scenario')throw new Error('场景不可嵌套');if(step.waitMs)await wait(Math.min(Math.max(0,step.waitMs),10000));results.push({action:step.action,result:await execute(step.action,step.parameters||{})});}return{steps:results,state:state(),simulated:true};
    }
    default:throw new Error('此模拟能力尚未支持：'+action);
  }
  await publish();return state();
}
async function poll(){while(!dead){try{const value=await request('poll');if(value.logGeneration!==logGeneration){logEntries=logEntries.filter(entry=>entry.createdAt>value.logsClearedAt);logGeneration=value.logGeneration;}for(const c of value.commands)pendingCommands=pendingCommands.then(async()=>{commandActive=true;try{await flushLogs();const startedAt=performance.timeOrigin+performance.now(),startedRunId=runId;const result=await execute(c.action,c.args);await flushLogs();await request('ack',{id:c.id,result,startedAt,runId:startedRunId});}catch(e){console.error(e);await flushLogs().catch(()=>{});await request('ack',{id:c.id,error:e.message});}finally{commandActive=false;notifyParent(true);}});}catch(e){if(!dead)notice.textContent='本地服务连接中断';}await wait(90);}}
setInterval(()=>flushLogs().catch(()=>{}),250);
setInterval(()=>{if(view&&!reloading)publish().catch(()=>{});},1000);
window.addEventListener('beforeunload',()=>{dead=true;clearInterval(timer);clearTimeout(posePublishTimer);cancelAnimationFrame(poseFrame);mouseInput.destroy();camera.destroy();sensorSessions.clear();view?.destroy();});
load().catch(failed).finally(poll);
