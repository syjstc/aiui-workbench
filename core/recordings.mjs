import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { id, atomicJson, readJson, normalizeEnvironment, redact, ROOT } from './util.mjs';
import {mp4Metadata} from './video-metadata.mjs';

const active=status=>['starting','recording','finalizing'].includes(status);
export class Recordings {
  constructor(workbench) { this.w=workbench;this.items=[];this.processes=new Map();this.locks=new Set(); }
  async init() {
    this.file=path.join(this.w.home,'recordings.json');this.items=(await readJson(this.file,[])).map(r=>active(r.status)?{...r,status:'interrupted',error:'上次服务结束时录制尚未完成'}:r);
    this.timer=setInterval(()=>{for(const r of this.items)if(r.source==='simulator'&&active(r.status)){const s=this.w.previews.sessions.get(r.sessionId);if(!s?.lastSeen||Date.now()-Date.parse(s.lastSeen)>10000){r.status='interrupted';r.error='模拟器连接已断开，录制没有完成';this.changed(r);}}},2000);this.timer.unref();return this;
  }
  get(recordingId) {const r=this.items.find(r=>r.id===recordingId);if(!r)throw new Error('录制记录不存在');return r;}
  status({recordingId}={}) {return recordingId?{...this.get(recordingId)}:{recordings:this.items.map(r=>({...r}))};}
  changed(r) { this.w.emit('recording',{...r});const snapshot=structuredClone(this.items);this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(this.file,snapshot));return this.saving; }
  async start(args,actor='MCP') {
    const {source,durationSeconds=30,fps=24,rotation}=args;
    if(!['simulator','glasses'].includes(source)||!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>120||![15,24,30,60].includes(fps)||rotation!==undefined&&![0,90,180,270].includes(rotation))throw new Error('录制参数无效：时长 1–120 秒，帧率 15/24/30/60');
    let session,serial=args.serial;
    if(source==='simulator'){
      if(args.sessionId&&args.projectId)throw new Error('模拟器录制请提供 sessionId 或 projectId 之一');
      if(args.sessionId)session=this.w.previews.public(this.w.previews.get(args.sessionId));
      else if(args.projectId){await this.w.projects.refresh(args.projectId);session=this.w.previews.open(args.projectId,this.w.origin,{requestedBy:actor});}
      else throw new Error('模拟器录制需要 sessionId 或 projectId');
      await this.w.automation.ready(session.id,this.w.projects.get(session.projectId).revision,{signal:args.signal||new AbortController().signal,progress:()=>{}});
    }else{if(!serial)throw new Error('真机录制需要明确的 serial');await this.w.glasses.ready(serial);}
    const target=source==='simulator'?session.id:serial,key=source+':'+target;
    if(this.locks.has(key)||this.items.some(r=>r.source===source&&(source==='simulator'?r.sessionId===target:r.serial===target)&&active(r.status)))throw new Error('该画面已有录制进行中');
    this.locks.add(key);
    const r={id:id(),source,simulated:source==='simulator',opticalCapture:false,audio:false,status:'starting',durationSeconds,fps,fpsMeaning:source==='simulator'?'sampling-target':'maximum',startedAt:new Date().toISOString(),...(session?{sessionId:session.id,projectId:session.projectId,revision:session.revision,toolchainId:session.toolchainId}:{serial})};
    this.items.unshift(r);this.items=this.items.slice(0,100);await this.changed(r);
    try{
      if(source==='simulator'){
        const value=await this.w.previews.action(session.id,'record_start',{id:r.id,fps,durationSeconds},{signal:args.signal});
        Object.assign(r,{...(active(r.status)?{status:'recording'}:{}),mimeType:value.mimeType,width:value.width,height:value.height,revision:value.revision,runId:value.runId});
      }else await this.startGlasses(r,rotation);
      await this.changed(r);return {...r};
    }catch(error){r.status='failed';r.error=redact(error.message);await this.changed(r);throw error;}
    finally{this.locks.delete(key);}
  }
  async startGlasses(r,rotation) {
    const component=await this.w.mirroring.bundled(),directory=path.join(this.w.home,'recordings');await fs.mkdir(directory,{recursive:true});
    r.path=path.join(directory,`${r.id}.mp4`);r.mimeType='video/mp4';r.rotation=rotation??this.w.mirroring.sessions.get(r.serial)?.rotation??0;
    const adbPath=path.join(ROOT,'vendor/adb',process.platform,process.platform==='win32'?'adb.exe':'adb');
    const env=normalizeEnvironment({...process.env,ADB:adbPath,SCRCPY_SERVER_PATH:component.server,SCRCPY_ICON_PATH:path.join(ROOT,'assets/icon.png'),...(process.platform==='darwin'?{NSUnbufferedIO:'YES'}:{})});
    const argv=['--serial',r.serial,'--no-playback','--no-window','--no-control','--no-audio','--no-clipboard-autosync','--video-codec=h264','--video-bit-rate=4M','--max-size=1280',`--max-fps=${r.fps}`,`--record=${r.path}`,'--record-format=mp4',`--record-orientation=${r.rotation}`,`--time-limit=${r.durationSeconds}`];
    const child=spawn(component.binary,argv,{cwd:component.directory,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let resolve;const done=new Promise(done=>{resolve=done;});this.processes.set(r.id,{child,done});
    const deadline=setTimeout(()=>{r.error='真机录制超过启动或结束时限';child.kill('SIGKILL');},(r.durationSeconds+20)*1000);
    r.output='';const log=chunk=>{r.output=(r.output+redact(chunk.toString())).slice(-12000);if(r.status==='starting'&&/Recording started/i.test(r.output))r.status='recording';const match=r.output.match(/(?:Texture(?:\s*\([^)]*\))?:|Video size:)\s*(\d+)x(\d+)/i);if(match){r.width=+match[1];r.height=+match[2];}this.changed(r);};
    child.stdout.on('data',log);child.stderr.on('data',log);
    child.once('error',error=>{r.error=error.message;r.status='failed';this.changed(r);});
    child.once('close',async code=>{
      try{if(code!==0&&!r.stopping)throw new Error(r.output||`scrcpy exited ${code}`);await this.finalize(r,r.path);}
      catch(error){r.status='failed';r.error=redact(error.message);}
      finally{clearTimeout(deadline);delete r.stopping;this.processes.delete(r.id);await this.changed(r);resolve();}
    });
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  }
  async finalize(r,file,metadata={}) {
    const bytes=await fs.readFile(file);if(bytes.length<100)throw new Error('录制文件为空或不完整');
    const mp4=bytes.toString('ascii',4,8)==='ftyp',webm=bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    if(!mp4&&!webm)throw new Error('录制没有返回有效视频容器');
    const container=mp4?mp4Metadata(bytes):{};
    Object.assign(r,metadata,container,{path:file,status:'completed',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:mp4?'video/mp4':'video/webm',finishedAt:new Date().toISOString()});
    if(r.source==='glasses'&&!r.durationMs)r.durationMs=Date.parse(r.finishedAt)-Date.parse(r.startedAt);
    if(r.projectId){const p=this.w.projects.get(r.projectId);r.stale=p.revision!==r.revision||p.toolchainId!==r.toolchainId;}
  }
  async receive(session,recordingId,req) {
    const r=this.get(recordingId);if(r.source!=='simulator'||r.sessionId!==session.id||!active(r.status))throw new Error('录制上传会话无效');
    const meta=JSON.parse(req.headers['x-recording-metadata']||'{}');
    if(!['video/mp4','video/webm'].some(type=>req.headers['content-type']?.startsWith(type))||!Number.isFinite(meta.durationMs)||meta.durationMs<=0||meta.durationMs>(r.durationSeconds+30)*1000||![meta.width,meta.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||(r.runId&&r.runId!==meta.runId))throw new Error('视频上传格式或运行实例无效');
    const directory=path.join(this.w.home,'recordings');await fs.mkdir(directory,{recursive:true});const file=path.join(directory,`${r.id}.${req.headers['content-type'].startsWith('video/mp4')?'mp4':'webm'}`),partial=file+'.partial';
    r.status='finalizing';await this.changed(r);let handle,size=0;
    try{handle=await fs.open(partial,'wx',0o600);for await(const chunk of req){size+=chunk.length;if(size>64*1024*1024)throw new Error('录制超过 64 MB 限制');await handle.writeFile(chunk);}await handle.close();handle=null;await fs.rename(partial,file);
      await this.finalize(r,file,{width:meta.width,height:meta.height,durationMs:meta.durationMs,stopReason:meta.stopReason,revision:meta.revision,runId:meta.runId});await this.changed(r);return {...r};
    }catch(error){await handle?.close();await fs.rm(partial,{force:true});if(r.status!=='completed')await fs.rm(file,{force:true});r.status='failed';r.error=error.message;await this.changed(r);throw error;}
  }
  async stop({recordingId}) {
    const r=this.get(recordingId);if(!active(r.status))return {...r};
    if(r.source==='simulator')await this.w.previews.action(r.sessionId,'record_stop',{id:r.id});
    else{const p=this.processes.get(r.id);if(p){r.stopping=true;p.child.kill('SIGINT');const timer=setTimeout(()=>p.child.kill('SIGKILL'),5000);try{await p.done;}finally{clearTimeout(timer);}}}
    return {...r};
  }
  async clip(args,actor) {
    if((args.durationSeconds??10)>30)throw new Error('一次短片录制最长 30 秒；更长录制请使用 start/stop');
    const job=this.w.jobs.start('recording',args.projectId||null,async({signal,progress})=>{
      const record=await this.start({...args,durationSeconds:args.durationSeconds??10,signal},actor);progress(`正在录制 ${record.source} · ${record.durationSeconds}s`);
      try{while(active(this.get(record.id).status)){signal.throwIfAborted();await pause(150,undefined,{signal});}}
      finally{if(active(this.get(record.id).status))await this.stop({recordingId:record.id});}
      const result=this.status({recordingId:record.id});if(result.status!=='completed')throw Object.assign(new Error(result.error||'录制未完成'),{result});return result;
    });return this.w.jobs.wait(job.id,args.waitMs??45000);
  }
  async close(){clearInterval(this.timer);for(const r of this.items)if(active(r.status))try{await this.stop({recordingId:r.id});}catch{r.status='interrupted';r.error='服务关闭时未能完成录制';await this.changed(r);}await this.saving;}
}
