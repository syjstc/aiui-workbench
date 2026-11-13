import test from 'node:test';
import assert from 'node:assert/strict';
import {SimulatorAi} from '../core/simulator-ai.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const textRequest={messages:[{role:'user',content:'Reply with a short answer.'}]};
const imageRequest={messages:[{role:'user',content:[{type:'text',text:'Describe the image.'},{type:'image_url',image_url:{url:'data:image/png;base64,'+png}}]}]};
function fixture(t){
  let time=10000;const events=[],sessions=new Map(['a','b'].map(id=>[id,{id,projectId:'project-'+id,revision:'revision-'+id,status:'ready',aiRunId:'run-'+id,state:{runId:'run-'+id}}]));
  const ai=new SimulatorAi({get:id=>{const s=sessions.get(id);if(!s)throw new Error('missing session');return s;}},(type,value)=>events.push({type,value}),{now:()=>time});
  t.after(()=>ai.close());
  const enable=(id='a',options={})=>ai.configure({sessionId:id,enabled:true,...options});
  const request=(body=textRequest,id='a',options={})=>ai.request(sessions.get(id),body,{runId:'run-'+id,...options});
  return {ai,events,sessions,enable,request,advance:ms=>time+=ms};
}

test('AI is off by default and local waits deliver one request only once without copying prompts into events',async t=>{
  const f=fixture(t);await assert.rejects(f.request(),/真机/);f.enable();
  const waiting=f.ai.wait({sessionId:'a',timeoutMs:1000}),response=f.request();
  const event=await waiting;assert.equal(event.status,'request');assert.equal(event.messages[0].content,textRequest.messages[0].content);
  assert.deepEqual(f.ai.wait({sessionId:'a',timeoutMs:0}),{status:'idle',listenAgain:false});
  assert.equal(JSON.stringify(f.events).includes(textRequest.messages[0].content),false);
  assert.throws(()=>f.ai.reply({...event,replyToken:'wrong',text:'hello'}),/凭据/);
  f.ai.reply({...event,text:'hello'});assert.equal((await response).choices[0].message.content,'hello');
  assert.throws(()=>f.ai.reply({...event,text:'second reply'}),/凭据/);
  assert.equal(f.ai.requests.get(event.requestId).payload,undefined);
});

test('a text-only AI cannot claim image inference and receives an explicit device-test handoff',async t=>{
  const f=fixture(t);f.enable();
  const wait=f.ai.wait({sessionId:'a',timeoutMs:1000});
  await assert.rejects(f.request(imageRequest),error=>error.deviceRequired&&/图片多模态/.test(error.message));
  const event=await wait;assert.equal(event.status,'device-required');assert.match(event.instruction,/主动告诉用户/);
  assert.equal(f.ai.status('a').pending.length,0);assert.equal(f.ai.status('a').remainingRequests,6);
  assert.equal(f.ai.hints('a').deviceRequired,true);
  f.enable('a',{supportsImages:true});const response=f.request(imageRequest),image=f.ai.wait({sessionId:'a',timeoutMs:0});
  assert.equal(image.images[0].data,png);assert.equal(image.messages[0].content[1].image_url.url,'attachment:0');
  f.ai.reply({...image,text:'A small fixture.'});await response;
});

test('session isolation, run changes and source changes prevent stale replies from reaching another application',async t=>{
  const f=fixture(t);f.enable();f.enable('b');
  const response=f.request(),rejected=assert.rejects(response,/接管已结束/),event=f.ai.wait({sessionId:'a',timeoutMs:0});
  assert.deepEqual(f.ai.wait({sessionId:'b',timeoutMs:0}),{status:'idle',listenAgain:false});
  assert.throws(()=>f.ai.reply({...event,sessionId:'b',text:'wrong project'}),/凭据/);
  f.ai.run(f.sessions.get('a'),'new-run');await rejected;
  assert.throws(()=>f.ai.reply({...event,text:'old result'}),/凭据/);assert.equal(f.ai.status('a').enabled,false);
  f.enable('b');const next=f.request(textRequest,'b'),changed=assert.rejects(next,/接管已结束/),claim=f.ai.wait({sessionId:'b',timeoutMs:0});
  f.sessions.get('b').revision='changed';assert.throws(()=>f.ai.reply({...claim,text:'old source'}),/会话已改变/);await changed;
});

test('abort, lease expiry and budget exhaustion cancel work; idle replies stay compact',async t=>{
  const f=fixture(t);f.enable();const controller=new AbortController(),response=f.request(textRequest,'a',{signal:controller.signal}),aborted=assert.rejects(response,/取消/);controller.abort();await aborted;
  const idle=await f.ai.wait({sessionId:'a',timeoutMs:10});assert.ok(JSON.stringify(idle).length<60);assert.equal(idle.listenAgain,false);
  const next=f.request(),expired=assert.rejects(next,/接管已结束/);f.advance(180001);assert.throws(()=>f.ai.wait({sessionId:'a',timeoutMs:0}),/真机/);await expired;
  f.enable('a',{maxRequests:1});const last=f.request(),claim=f.ai.wait({sessionId:'a',timeoutMs:0});f.ai.reply({...claim,text:'done'});await last;
  assert.equal(f.ai.status('a').enabled,false);await assert.rejects(f.request(),/真机/);
});

test('input and output limits and JSON constraints reject excess without silent truncation',async t=>{
  const f=fixture(t);f.enable('a',{maxInputChars:100,maxOutputChars:20});
  await assert.rejects(f.request({messages:[{role:'user',content:'x'.repeat(101)}]}),/输入限制/);
  f.enable('a',{maxOutputChars:20});const response=f.request({...textRequest,response_format:{type:'json_object'}}),claim=f.ai.wait({sessionId:'a',timeoutMs:0});
  assert.throws(()=>f.ai.reply({...claim,text:'x'.repeat(21)}),/输出限制/);
  assert.throws(()=>f.ai.reply({...claim,text:'not json'}),/有效 JSON/);
  assert.throws(()=>f.ai.reply({...claim,text:'[]'}),/JSON 对象/);
  f.ai.reply({...claim,text:'{"answer":1}'});assert.equal((await response).choices[0].message.content,'{"answer":1}');
});

test('oversized images and offline requests stop before an AI event is created',async t=>{
  const f=fixture(t);f.enable('a',{supportsImages:true});
  const bytes=Buffer.from(png,'base64');bytes.writeUInt32BE(2048,16);
  const large={messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64')}}]}]};
  await assert.rejects(f.request(large),/1024 像素/);assert.equal(f.ai.status('a').remainingRequests,6);
  f.sessions.get('a').state.network={online:false};await assert.rejects(f.request(),/模拟网络已断开/);assert.deepEqual(f.ai.status('a').pending,[]);
});
