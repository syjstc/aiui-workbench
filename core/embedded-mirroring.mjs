import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { id,redact,normalizeEnvironment } from './util.mjs';
import { MirrorPacketParser,mirrorInput } from './mirror-protocol.mjs';

export class EmbeddedMirroring {
  constructor(adb,glasses,bundled,getOrigin,emit=()=>{}){Object.assign(this,{adb,glasses,bundled,getOrigin,emit});this.sessions=new Map();this.starts=new Map();}
  public(s){if(!s)return null;return {id:s.id,serial:s.serial,status:s.status,mode:'embedded',width:s.width,height:s.height,frames:s.frames,maxFps:s.maxFps,rotation:s.rotation,readOnly:s.readOnly,startedAt:s.startedAt,error:s.error,output:s.output,viewers:s.clients.size,url:`${this.getOrigin()}/runtime/mirror/index.html?session=${s.id}&key=${s.key}`};}
  status({serial}={}){return {session:this.public(this.sessions.get(serial)),sessions:[...this.sessions.values()].map(s=>this.public(s))};}
  authorize(sessionId,key){const session=[...this.sessions.values()].find(s=>s.id===sessionId);if(!session||session.key!==key)throw new Error('投屏会话授权无效');return session;}
  start(args){if(this.starts.has(args.serial))return this.starts.get(args.serial);const task=this.startNow(args).finally(()=>this.starts.delete(args.serial));this.starts.set(args.serial,task);return task;}
  async startNow({serial,maxFps=30,rotation=0,readOnly=false}){
    if(![15,30,60].includes(maxFps)||![0,90,180,270].includes(rotation)||typeof readOnly!=='boolean')throw new Error('投屏选项无效');
    await this.glasses.ready(serial);
    const previous=this.sessions.get(serial);if(previous?.status==='running')return this.public(previous);
    const component=await this.bundled();if(component.version!=='5.0.1')throw new Error('内嵌投屏需要匹配的 scrcpy 5.0.1 组件');
    const scid=(randomBytes(4).readUInt32BE()&0x7fffffff).toString(16).padStart(8,'0');
    const remote=`/data/local/tmp/aiui-workbench-scrcpy-${scid}.jar`;
    const s={id:id(),key:id(),scid,serial,status:'starting',startedAt:new Date().toISOString(),maxFps,rotation,readOnly,width:0,height:0,frames:0,clients:new Set(),output:''};this.sessions.set(serial,s);
    let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
    s.resolveReady=resolveReady;s.rejectReady=rejectReady;
    try{
      await this.glasses.adbCommand(serial,['push',component.server,remote],{timeout:15000});
      s.port=Number((await this.glasses.adbCommand(serial,['forward','tcp:0',`localabstract:scrcpy_${scid}`])).stdout.toString().trim());
      if(!Number.isInteger(s.port)||s.port<1||s.port>65535)throw new Error('无法建立投屏数据通道');
      const options=[component.version,`scid=${scid}`,'log_level=warn','audio=false','control=true','clipboard_autosync=false','tunnel_forward=true','send_device_meta=false','send_dummy_byte=true','video_codec=h264','video_bit_rate=4000000','max_size=1280',`max_fps=${maxFps}`,`capture_orientation=${rotation}`,'video_codec_options=i-frame-interval=1','cleanup=true'];
      s.child=spawn(await this.adb.resolve(),['-s',serial,'shell','-T',`CLASSPATH='${remote}' app_process / com.genymobile.scrcpy.Server ${options.join(' ')}`],{env:normalizeEnvironment(process.env),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const log=chunk=>{s.output=(s.output+redact(chunk.toString())).slice(-12000);};s.child.stdout.on('data',log);s.child.stderr.on('data',log);
      s.child.once('error',error=>this.fail(s,error));s.child.once('close',code=>{if(!s.stopping)this.fail(s,new Error(s.output.trim()||`投屏连接已断开 (${code})`));});
      const deadline=Date.now()+12000;
      while(Date.now()<deadline&&!s.video&&s.status==='starting'){
        let socket;
        try{socket=await this.connect(s.port);await this.dummy(socket);s.video=socket;}catch{socket?.destroy();await pause(100);}
      }
      if(!s.video)throw new Error(s.output.trim()||'内嵌投屏连接超时');
      const parser=new MirrorPacketParser(packet=>this.packet(s,packet));
      s.video.on('data',chunk=>{try{parser.push(chunk);}catch(error){this.fail(s,error);}});
      s.video.on('error',error=>{if(!s.stopping)this.fail(s,error);});s.video.on('close',()=>{if(!s.stopping)this.fail(s,new Error('投屏连接已断开'));});
      s.control=await this.connect(s.port);s.control.on('data',()=>{});s.control.on('error',error=>{if(!s.stopping)this.fail(s,error);});s.video.resume();
      const timer=setTimeout(()=>this.fail(s,new Error(s.output.trim()||'等待投屏首帧超时')),12000);
      try{await ready;}finally{clearTimeout(timer);}
      this.idle(s,10000);return this.public(s);
    }catch(error){await this.stop({serial});s.status='failed';s.error=error.message;throw error;}
  }
  connect(port){return new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port});const timer=setTimeout(()=>socket.destroy(new Error('投屏连接超时')),1500);socket.once('connect',()=>{clearTimeout(timer);resolve(socket);});socket.once('error',error=>{clearTimeout(timer);reject(error);});});}
  dummy(socket){return new Promise((resolve,reject)=>{const clean=()=>{clearTimeout(timer);socket.removeListener('data',data);socket.removeListener('close',closed);socket.removeListener('error',error);};const closed=()=>{clean();reject(new Error('投屏尚未监听'));};const error=e=>{clean();reject(e);};const data=chunk=>{socket.pause();clean();if(chunk[0]!==0)return reject(new Error('投屏握手无效'));if(chunk.length>1)socket.unshift(chunk.subarray(1));resolve();};const timer=setTimeout(()=>{clean();reject(new Error('投屏握手超时'));},1200);socket.once('data',data);socket.once('error',error);socket.once('close',closed);});}
  packet(s,packet){
    if(packet.type==='session'){s.width=packet.width;s.height=packet.height;s.metadata=packet.bytes;s.config=null;}
    else if(packet.config)s.config=packet.bytes;
    else{s.frames++;if(s.status==='starting'&&packet.key){s.status='running';s.resolveReady();}}
    for(const client of [...s.clients]){
      if(client.response.writableLength>2*1024*1024){client.response.destroy();s.clients.delete(client);continue;}
      if(packet.type==='session'||packet.config){client.waiting=true;client.response.write(packet.bytes);}
      else if(packet.key||!client.waiting){client.waiting=false;client.response.write(packet.bytes);}
    }
  }
  attach(s,req,res){
    if(s.status!=='running')throw new Error('内嵌投屏尚未运行');
    clearTimeout(s.idleTimer);res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.write(Buffer.from('h264'));if(s.metadata)res.write(s.metadata);if(s.config)res.write(s.config);
    const client={response:res,waiting:true};s.clients.add(client);res.on('close',()=>{s.clients.delete(client);this.idle(s);});
    // A static Android display may produce no more frames. scrcpy 5.0.1's
    // RESET_VIDEO (17) sends fresh metadata/configuration and a keyframe so
    // a newly opened viewer can start without waiting for a screen change.
    s.control.write(Buffer.from([17]));
  }
  input(s,message){if(s.status!=='running'||s.readOnly||!s.control||s.control.destroyed)throw new Error('当前投屏只允许查看');s.control.write(mirrorInput(message,s.width,s.height));return {ok:true};}
  idle(s,ms=3000){clearTimeout(s.idleTimer);if(s.stopping||s.status!=='running'||this.sessions.get(s.serial)!==s)return;if(!s.clients.size)s.idleTimer=setTimeout(()=>{if(!s.clients.size&&!s.stopping&&this.sessions.get(s.serial)===s)this.stop({serial:s.serial}).catch(()=>{});},ms);s.idleTimer?.unref();}
  fail(s,error){if(s.stopping||s.status==='failed')return;s.status='failed';s.error=error.message;s.rejectReady(error);this.emit('glasses-mirror',this.public(s));this.stop({serial:s.serial,preserveError:true}).catch(()=>{});}
  async stop({serial,preserveError=false}){
    const s=this.sessions.get(serial);if(!s||s.stopping)return this.public(s);s.stopping=true;clearTimeout(s.idleTimer);s.rejectReady(new Error('投屏已停止'));
    s.video?.destroy();s.control?.destroy();s.child?.kill('SIGTERM');for(const client of s.clients)client.response.end();s.clients.clear();
    if(s.port)await this.glasses.adbCommand(serial,['forward','--remove',`tcp:${s.port}`],{timeout:5000}).catch(()=>{});
    if(!preserveError)s.status='stopped';return this.public(s);
  }
  async close(){await Promise.all([...this.sessions.keys()].map(serial=>this.stop({serial})));}
}
