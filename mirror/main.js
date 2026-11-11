import './style.css';
const query=new URLSearchParams(location.search),session=query.get('session'),key=query.get('key');
const canvas=document.querySelector('#screen'),notice=document.querySelector('#status'),context=canvas.getContext('2d');
const abort=new AbortController();let decoder,configuration,codec,waiting=true,width=0,height=0,readOnly=true,frames=0,lastPublish=0,closed=false,pointer=null,lastMove=0;
const pressed=new Set(),keys=new Set(['Enter','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Home']);
async function request(route,value){const result=await fetch(`/mirror/${session}/${route}`,{method:value===undefined?'GET':'POST',headers:{'X-Mirror-Key':key,...(value===undefined?{}:{'Content-Type':'application/json'})},body:value===undefined?undefined:JSON.stringify(value),signal:abort.signal,keepalive:value!==undefined});if(!result.ok)throw new Error((await result.json()).error||'投屏请求失败');return result;}
// The desktop parent uses file:// (an opaque origin); the receiver verifies our
// exact frame, service origin, and session before accepting these display stats.
function publish(error){if(window.parent!==window)window.parent.postMessage({channel:'aiui-mirror-state',sessionId:session,width,height,frames,readOnly,error,ready:frames>0&&!error},'*');}
function failed(error){if(closed)return;notice.hidden=false;notice.textContent=error.message||String(error);publish(notice.textContent);}
function configure(data){
  let next='avc1.42E01E';
  for(let i=0;i<data.length-7;i++){const size=data[i]===0&&data[i+1]===0?(data[i+2]===1?3:data[i+2]===0&&data[i+3]===1?4:0):0;if(size&&(data[i+size]&31)===7){next='avc1.'+[data[i+size+1],data[i+size+2],data[i+size+3]].map(v=>v.toString(16).padStart(2,'0')).join('');break;}}
  configuration=data;waiting=true;
  if(!decoder||decoder.state==='closed'||codec!==next){decoder?.close();codec=next;decoder=new VideoDecoder({output(frame){try{if(canvas.width!==frame.displayWidth||canvas.height!==frame.displayHeight){canvas.width=frame.displayWidth;canvas.height=frame.displayHeight;}context.drawImage(frame,0,0,canvas.width,canvas.height);frames++;notice.hidden=true;if(performance.now()-lastPublish>500){lastPublish=performance.now();publish();}}finally{frame.close();}},error:failed});}
  else decoder.reset();
  decoder.configure({codec:next,optimizeForLatency:true});
}
function packet(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes[0]&128){resetInput();width=view.getUint32(4);height=view.getUint32(8);waiting=true;publish();return;}
  const data=bytes.subarray(12),config=!!(bytes[0]&64),keyframe=!!(bytes[0]&32);
  if(config){configure(data.slice());return;}
  if(!decoder||decoder.state!=='configured'||waiting&&!keyframe)return;
  if(decoder.decodeQueueSize>6){waiting=true;return;}
  waiting=false;
  const payload=keyframe&&configuration?new Uint8Array(configuration.length+data.length):data;
  if(payload!==data){payload.set(configuration);payload.set(data,configuration.length);}
  const timestamp=Number((BigInt(view.getUint32(0)&0x1fffffff)<<32n)|BigInt(view.getUint32(4)));
  decoder.decode(new EncodedVideoChunk({type:keyframe?'key':'delta',timestamp,data:payload}));
}
async function start(){
  if(typeof VideoDecoder!=='function')throw new Error('当前环境不支持内嵌视频解码，请使用独立投屏窗口');
  const state=await (await request('state')).json();readOnly=state.readOnly;
  canvas.classList.toggle('read-only',readOnly);
  const response=await request('stream'),reader=response.body.getReader();let buffer=new Uint8Array(),header=false;
  while(!closed){const {done,value}=await reader.read();if(done)throw new Error('投屏连接已结束');const next=new Uint8Array(buffer.length+value.length);next.set(buffer);next.set(value,buffer.length);buffer=next;
    if(!header){if(buffer.length<4)continue;if(String.fromCharCode(...buffer.subarray(0,4))!=='h264')throw new Error('视频编码不匹配');buffer=buffer.subarray(4);header=true;}
    while(buffer.length>=12){const view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength),length=(buffer[0]&128)?0:view.getUint32(8);if(length>4*1024*1024)throw new Error('视频数据超过限制');if(buffer.length<12+length)break;packet(buffer.subarray(0,12+length));buffer=buffer.slice(12+length);}
  }
}
function send(value){if(readOnly||closed)return;request('input',value).catch(failed);}
function position(event){const box=canvas.getBoundingClientRect(),scale=Math.min(box.width/width,box.height/height);return{x:(event.clientX-box.left-(box.width-width*scale)/2)/scale,y:(event.clientY-box.top-(box.height-height*scale)/2)/scale};}
function resetInput(){if(pointer){send({type:'touch',action:3,...pointer});pointer=null;}for(const code of pressed)send({type:'key',action:1,code});pressed.clear();}
canvas.addEventListener('pointerdown',event=>{if(readOnly||!width||event.button!==0)return;const point=position(event);if(point.x<0||point.y<0||point.x>=width||point.y>=height)return;event.preventDefault();canvas.focus();canvas.setPointerCapture(event.pointerId);pointer=point;send({type:'touch',action:0,...point});});
canvas.addEventListener('pointermove',event=>{if(!pointer||performance.now()-lastMove<16)return;lastMove=performance.now();pointer=position(event);send({type:'touch',action:2,...pointer});});
canvas.addEventListener('pointerup',event=>{if(!pointer)return;send({type:'touch',action:1,...position(event)});pointer=null;});
canvas.addEventListener('pointercancel',resetInput);canvas.addEventListener('blur',resetInput);window.addEventListener('blur',resetInput);
canvas.addEventListener('contextmenu',event=>{event.preventDefault();send({type:'key',action:0,code:'Backspace'});send({type:'key',action:1,code:'Backspace'});});
for(const type of ['keydown','keyup'])canvas.addEventListener(type,event=>{if(readOnly||!keys.has(event.code))return;event.preventDefault();event.stopPropagation();if(type==='keydown'){if(event.repeat||pressed.has(event.code))return;pressed.add(event.code);send({type:'key',action:0,code:event.code});}else if(pressed.delete(event.code))send({type:'key',action:1,code:event.code});});
window.addEventListener('beforeunload',()=>{resetInput();closed=true;abort.abort();if(decoder&&decoder.state!=='closed')decoder.close();});
start().catch(failed);
