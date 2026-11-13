import {id} from './util.mjs';
import {imageMime} from './document-images.mjs';
import {aiImageSize} from './simulator-ai-images.mjs';

const liveStates=new Set(['pending','claimed']);
const deviceError=message=>Object.assign(new Error(message),{deviceRequired:true});
export const AI_DEVICE_HINT='模拟器的 AI 功能请在真机上测试。';

// An in-memory handoff, not an AI worker. Waiting is local, bounded and silent.
// Only an explicit automation lease enables the SDK endpoint.
export class SimulatorAi {
  constructor(previews,emit,{now=Date.now}={}){this.previews=previews;this.emit=emit;this.now=now;this.leases=new Map();this.requests=new Map();this.waiters=new Set();this.issues=new Map();}
  status(sessionId){
    const lease=this.leases.get(sessionId);
    return {enabled:!!lease&&lease.expiresAt>this.now(),mode:lease?'automation':'device',supportsImages:lease?.supportsImages??false,...(lease?{expiresAt:new Date(lease.expiresAt).toISOString(),remainingRequests:lease.remainingRequests,limits:{inputChars:lease.maxInputChars,outputChars:lease.maxOutputChars,images:2,imageBytes:1048576,imageMaxDimension:1024}}:{}),pending:[...this.requests.values()].filter(r=>r.sessionId===sessionId&&liveStates.has(r.status)).map(r=>({requestId:r.id,status:r.status})),...(this.issues.has(sessionId)?{issue:this.issues.get(sessionId)}:{}),hint:AI_DEVICE_HINT};
  }
  configure({sessionId,enabled,supportsImages=false,leaseMs=180000,maxRequests=6,maxInputChars=12000,maxOutputChars=2000}){
    const session=this.previews.get(sessionId);
    this.cancelSession(sessionId,'disabled');
    this.issues.delete(sessionId);
    if(enabled){
      if(session.status!=='ready'||!(session.aiRunId||session.state.runId))throw new Error('请先打开并等待模拟器预览就绪');
      const lease={id:id(),sessionId,runId:session.aiRunId||session.state.runId,revision:session.revision,supportsImages,expiresAt:this.now()+leaseMs,remainingRequests:maxRequests,maxInputChars,maxOutputChars};
      lease.timer=setTimeout(()=>this.cancelSession(sessionId,'expired'),leaseMs);lease.timer.unref?.();this.leases.set(sessionId,lease);
    }
    this.emit('preview-ai',{sessionId,...this.status(sessionId)});return this.status(sessionId);
  }
  run(session,runId){
    if(!runId||typeof runId!=='string'||runId.length>100)throw new Error('模拟器运行标识无效');
    if(session.aiRunId&&session.aiRunId!==runId)this.cancelSession(session.id,'run-changed');
    session.aiRunId=runId;
  }
  active(sessionId){
    const lease=this.leases.get(sessionId),session=this.previews.get(sessionId);
    if(lease&&lease.expiresAt<=this.now())this.cancelSession(sessionId,'expired');
    if(!lease||!this.leases.has(sessionId))throw deviceError(AI_DEVICE_HINT);
    if(lease.runId!==session.aiRunId||lease.revision!==session.revision||['closed','failed'].includes(session.status)){
      this.cancelSession(sessionId,'run-changed');throw deviceError('模拟器会话已改变，请重新开始自动化验证；AI 功能也可在真机测试');
    }
    return lease;
  }
  payload(body,lease){
    if(!body||!Array.isArray(body.messages)||!body.messages.length||body.messages.length>24)throw new Error('AI 请求需要 1–24 条消息');
    const images=[];
    const messages=body.messages.map(message=>{
      if(!['system','user','assistant','tool'].includes(message.role))throw new Error('AI 消息角色无效');
      if(typeof message.content==='string')return {role:message.role,content:message.content,...(message.tool_call_id?{tool_call_id:String(message.tool_call_id)}:{})};
      if(!Array.isArray(message.content)||message.role!=='user')throw new Error('AI 图片消息必须属于 user');
      return {role:message.role,content:message.content.map(part=>{
        if(part.type==='text'&&typeof part.text==='string')return {type:'text',text:part.text};
        if(part.type!=='image_url')throw new Error('此 AI 自动化适配仅支持文字和图片，其他能力请在真机测试');
        if(!lease.supportsImages)throw deviceError('当前 AI 工具未声明图片多模态能力，无法验证识图；请在真机上测试');
        const match=part.image_url?.url?.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
        if(!match)throw deviceError('AI 自动化验证需要本地 PNG/JPEG/WebP 图片；远程图片或其他格式请在真机测试');
        if(images.length>=2||match[2].length>1400000)throw new Error('单次自动化请求最多 2 张图片，每张不超过 1 MB、最长边 1024 像素');
        const data=Buffer.from(match[2],'base64');if(data.length>1024*1024||imageMime(data)!==match[1])throw new Error('AI 图片内容或大小无效');
        const size=aiImageSize(data,match[1]);if(!size||size.some(v=>v<1||v>1024))throw new Error('请将自动化测试图片缩小到最长边 1024 像素以内，或在真机测试');
        const index=images.length;images.push({id:index,mimeType:match[1],width:size[0],height:size[1],data:match[2]});
        return {type:'image_url',image_url:{url:`attachment:${index}`}};
      })};
    });
    const payload={messages,...(body.model?{modelHint:String(body.model)}:{}),...(body.response_format?{responseFormat:body.response_format}:{}),...(body.tools?{tools:body.tools}:{}),...(body.tool_choice?{toolChoice:body.tool_choice}:{})};
    if(JSON.stringify(payload).length>lease.maxInputChars)throw new Error('AI 请求超过自动化输入限制；请缩小验证用例或在真机测试');
    return {...payload,images};
  }
  async request(session,body,{runId,signal}={}){
    signal?.throwIfAborted();const lease=this.active(session.id);
    if(session.state?.network?.online===false)throw new Error('NetworkError: 模拟网络已断开');
    if(runId!==lease.runId)throw new Error('AI 请求来自已失效的模拟器运行');
    if(lease.remainingRequests<=0)throw deviceError('本轮 AI 自动化请求额度已用完，请结束验证；普通使用请在真机测试');
    let payload;try{payload=this.payload(body,lease);}catch(error){
      if(error.deviceRequired){const issue={deviceRequired:true,reason:error.message,instruction:'请主动告诉用户此能力需要在真机测试，不要宣称识图通过。'};this.issues.set(session.id,issue);this.emit('ai-request',{sessionId:session.id,projectId:session.projectId,status:'device-required',...issue});for(const waiter of this.waiters)if(waiter.sessionId===session.id)waiter.finish({status:'device-required',...issue});}
      throw error;
    }
    this.issues.delete(session.id);
    if([...this.requests.values()].filter(r=>r.sessionId===session.id&&liveStates.has(r.status)).length>=2)throw new Error('此预览已有 2 个 AI 请求等待处理');
    const request={id:id(),sessionId:session.id,projectId:session.projectId,runId,revision:session.revision,leaseId:lease.id,status:'pending',payload,maxOutputChars:lease.maxOutputChars,deadline:Math.min(lease.expiresAt,this.now()+90000)};
    lease.remainingRequests--;
    const result=new Promise((resolve,reject)=>{
      request.resolve=resolve;request.reject=reject;
      request.abort=()=>this.finish(request,'cancelled',null,new Error('AI 请求已取消'));
      request.cleanup=()=>signal?.removeEventListener('abort',request.abort);
      request.timer=setTimeout(()=>this.finish(request,'expired',null,deviceError('AI 接管请求超时，请在真机上测试')),Math.max(1,request.deadline-this.now()));request.timer.unref?.();
      this.requests.set(request.id,request);signal?.addEventListener('abort',request.abort,{once:true});
      if(signal?.aborted)request.abort();
    });
    this.emit('ai-request',{sessionId:session.id,projectId:session.projectId,requestId:request.id,status:request.status});
    this.drain();return result;
  }
  claim(sessionId){
    const request=[...this.requests.values()].find(r=>r.sessionId===sessionId&&r.status==='pending');if(!request)return null;
    request.status='claimed';request.replyToken=id()+id();
    return {status:'request',sessionId,projectId:request.projectId,requestId:request.id,runId:request.runId,revision:request.revision,replyToken:request.replyToken,deadline:new Date(request.deadline).toISOString(),maxOutputChars:request.maxOutputChars,...request.payload};
  }
  wait({sessionId,timeoutMs=45000}){
    this.active(sessionId);const issue=this.issues.get(sessionId);if(issue)return {status:'device-required',...issue};const ready=this.claim(sessionId);if(ready)return ready;
    if(!timeoutMs)return {status:'idle',listenAgain:false};
    return new Promise(resolve=>{
      const waiter={sessionId,finish:value=>{clearTimeout(waiter.timer);this.waiters.delete(waiter);resolve(value);}};
      waiter.timer=setTimeout(()=>waiter.finish({status:'idle',listenAgain:false}),timeoutMs);waiter.timer.unref?.();this.waiters.add(waiter);
      this.drain();
    });
  }
  drain(){for(const waiter of this.waiters){const request=this.claim(waiter.sessionId);if(request)waiter.finish(request);}}
  reply({sessionId,requestId,replyToken,text,error,toolCalls}){
    const request=this.requests.get(requestId);
    if(!request||request.sessionId!==sessionId||request.status!=='claimed'||request.replyToken!==replyToken)throw new Error('AI 回填凭据无效，或请求已完成/取消');
    const lease=this.active(sessionId);
    if(lease.id!==request.leaseId||lease.runId!==request.runId||lease.revision!==request.revision||this.now()>=request.deadline)throw new Error('AI 回填已过期，不会写入新会话');
    if(error){this.finish(request,'failed',null,deviceError(error));return {accepted:true,status:'failed',deviceRequired:true};}
    if(typeof text!=='string'||text.length>request.maxOutputChars||!text.trim()&&!toolCalls?.length)throw new Error('AI 回填文本为空或超过输出限制');
    const format=request.payload.responseFormat;
    if(format?.type==='json_object'||format?.type==='json_schema'){
      let parsed;try{parsed=JSON.parse(text);}catch{throw new Error('AI 回填必须是有效 JSON');}
      if(format.type==='json_object'&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)))throw new Error('AI 回填必须是 JSON 对象');
    }
    const calls=toolCalls?.map(call=>{
      if(!request.payload.tools?.some(tool=>tool.function?.name===call.name))throw new Error('AI 回填引用了未声明的应用函数');
      try{JSON.parse(call.arguments);}catch{throw new Error('函数参数必须是 JSON');}
      return {id:call.id||id(),type:'function',function:{name:call.name,arguments:call.arguments}};
    });
    if(calls&&JSON.stringify(calls).length>request.maxOutputChars)throw new Error('AI 函数回填超过输出限制');
    const response={id:request.id,object:'chat.completion',created:Math.floor(this.now()/1000),model:'workbench-active-ai',choices:[{index:0,message:{role:'assistant',content:text,...(calls?.length?{tool_calls:calls}:{})},finish_reason:calls?.length?'tool_calls':'stop'}]};
    this.finish(request,'completed',response);return {accepted:true,status:'completed'};
  }
  finish(request,status,value,error){
    if(!liveStates.has(request.status))return;
    request.status=status;clearTimeout(request.timer);request.cleanup?.();const {resolve,reject}=request;
    delete request.payload;delete request.replyToken;delete request.resolve;delete request.reject;delete request.cleanup;delete request.abort;
    if(error)reject(error);else resolve(value);
    this.emit('ai-request',{sessionId:request.sessionId,projectId:request.projectId,requestId:request.id,status});
    // Keep only small tombstones, never completed prompts/images.
    const ended=[...this.requests.values()].filter(r=>!liveStates.has(r.status));for(const old of ended.slice(0,-80))this.requests.delete(old.id);
    const lease=this.leases.get(request.sessionId);
    if(lease?.remainingRequests===0&&![...this.requests.values()].some(r=>r.sessionId===request.sessionId&&liveStates.has(r.status)))this.cancelSession(request.sessionId,'budget-exhausted');
  }
  cancelSession(sessionId,reason='closed'){
    const lease=this.leases.get(sessionId);clearTimeout(lease?.timer);this.leases.delete(sessionId);
    for(const request of this.requests.values())if(request.sessionId===sessionId)this.finish(request,'cancelled',null,new Error(`AI 自动化接管已结束（${reason}）；需要时请在真机测试`));
    for(const waiter of this.waiters)if(waiter.sessionId===sessionId)waiter.finish({status:'closed',reason});
  }
  hints(sessionId){const issue=this.issues.get(sessionId);if(issue)return {sessionId,...issue};const requests=[...this.requests.values()].filter(r=>r.status==='pending'&&r.sessionId===sessionId);return requests.length?{sessionId,requestId:requests[0].id,pending:requests.length,tool:'aiui_ai_wait'}:null;}
  close(){for(const sessionId of this.leases.keys())this.cancelSession(sessionId,'service-closed');this.requests.clear();this.issues.clear();}
}
