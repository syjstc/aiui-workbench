export class CanvasRecording {
  constructor(canvas, upload, changed=()=>{}) { Object.assign(this,{canvas,upload,changed});this.current=null; }
  state() { const c=this.current;return c?{id:c.id,status:c.recorder.state,mimeType:c.mimeType,fps:c.fps,startedAt:c.startedAt}:null; }
  start({id,fps=24,durationSeconds=30,revision,runId}) {
    if(this.current)throw new Error('模拟器已有录制进行中');
    if(!globalThis.MediaRecorder || !this.canvas.captureStream)throw new Error('当前浏览器不支持画面录制');
    const mimeType=['video/mp4;codecs=avc1.42001E','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
    if(!mimeType)throw new Error('当前浏览器没有可用的视频编码器');
    const stream=this.canvas.captureStream(0),recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:4000000});
    const c={id,fps,mimeType,stream,recorder,chunks:[],bytes:0,revision,runId,startedAt:Date.now(),width:this.canvas.width,height:this.canvas.height};
    c.done=new Promise((resolve,reject)=>{c.resolve=resolve;c.reject=reject;});c.done.catch(()=>{});this.current=c;
    const clean=()=>{clearTimeout(c.timer);clearInterval(c.frameTimer);for(const track of stream.getTracks())track.stop();if(this.current===c)this.current=null;this.changed();};
    recorder.addEventListener('dataavailable',event=>{if(event.data.size){c.chunks.push(event.data);c.bytes+=event.data.size;if(c.bytes>64*1024*1024){c.reason='size-limit';recorder.stop();}}});
    recorder.addEventListener('error',event=>{clean();c.reject(new Error(event.error?.message||'录制编码失败'));});
    recorder.addEventListener('stop',async()=>{
      try{const blob=new Blob(c.chunks,{type:mimeType});if(!blob.size)throw new Error('录制未产生视频画面');const result=await this.upload(c.id,blob,{mimeType,width:c.width,height:c.height,fps,revision,runId,durationMs:Date.now()-c.startedAt,stopReason:c.reason||'stopped'});c.resolve(result);}
      catch(error){c.reject(error);}finally{clean();}
    });
    try{recorder.start(500);const track=stream.getVideoTracks()[0];track.requestFrame();c.frameTimer=setInterval(()=>track.requestFrame(),1000/fps);}catch(error){clean();throw error;}
    c.timer=setTimeout(()=>this.stop('duration-limit').catch(console.error),durationSeconds*1000);this.changed();return {...this.state(),width:c.width,height:c.height,revision,runId};
  }
  async stop(reason='stopped') { const c=this.current;if(!c)return null;c.reason=reason;if(c.recorder.state!=='inactive')c.recorder.stop();return c.done; }
}
