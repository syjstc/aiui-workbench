import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startDaemon} from '../core/daemon.mjs';
import {ROOT,sleep} from '../core/util.mjs';

const home=path.join(ROOT,'.local/simulator-ai-qa',String(Date.now())),output=path.join(ROOT,'output/qa/simulator-ai');
const manual=process.env.AIUI_AI_QA_MANUAL==='1';
await fs.mkdir(output,{recursive:true});
const report={checks:[],simulated:true,deviceAcceptance:false,inference:manual?'external AI inspects actual image':'fixed transport fixture; not real recognition'};
let daemon,app,mcp,page,preview;
async function until(work,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await work();if(value)return value;await sleep(100);}throw new Error('AI simulator QA timed out');}
async function raw(name,args={}){return mcp.callTool({name,arguments:args},undefined,{timeout:55000});}
const parse=result=>JSON.parse(result.content.find(c=>c.type==='text').text);
async function tool(name,args={}){const result=await raw(name,args);if(result.isError)throw new Error(result.content.find(c=>c.type==='text').text);return parse(result);}
const act=(action,parameters={})=>tool('aiui_preview_action',{sessionId:preview.id,action,parameters});
const configure=options=>tool('aiui_ai_configure',{sessionId:preview.id,...options});
const logs=async()=>(await tool('aiui_preview_logs',{sessionId:preview.id,limit:200})).logs;
const count=async prefix=>(await logs()).filter(l=>l.message.includes(prefix+' ')).length;
async function check(name,work){await work();report.checks.push({name,passed:true});console.log('PASS',name);}

try{
  daemon=await startDaemon(home);await daemon.service.sdk.settings({autoCheck:false});await daemon.service.knowledge.settings({autoUpdate:false});
  app=await electron.launch({args:[ROOT],cwd:ROOT,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});
  page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.hide();w.webContents.setBackgroundThrottling(false);});
  const image=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=480;canvas.height=280;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,480,280);
    c.fillStyle='#167ee6';for(const [x,y] of [[70,65],[180,65],[290,65]]){c.beginPath();c.arc(x,y,26,0,Math.PI*2);c.fill();}
    c.fillStyle='#ef8834';c.fillRect(370,40,50,50);c.fillStyle='#9d48d6';
    for(const [cx,cy] of [[140,190],[320,190]]){c.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2?18:40;const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?c.lineTo(x,y):c.moveTo(x,y);}c.closePath();c.fill();}
    return canvas.toDataURL('image/png');
  });
  const source=`<script def>{"navigationBarTitleText":""}</script><script setup>
export default {
 data:{answer:'AI 自动化链路测试'},onLoad(){this.busy=false;},
 onKeyDown(e){if(['Enter','Space','ArrowUp'].includes(e.code))e.preventDefault();},
 onKeyUp(e){if(['Enter','Space','ArrowUp'].includes(e.code)){e.preventDefault();this.infer(e.code==='Space'?'image':e.code==='ArrowUp'?'stream':'text');}},
 async infer(kind){if(this.busy)return;this.busy=true;let model;try{
  model=await LanguageModel.create();const input=kind==='image'?[{role:'user',content:[{type:'text',text:'图中有几颗星星、几个圆、几个方块？只回复 JSON 对象，键 stars、circles、squares，值为数量。'},{type:'image_url',image_url:{url:${JSON.stringify(image)}}}]}]:'Reply with the short verification result.';
  let answer='';if(kind==='stream'){const stream=model.promptStreaming(input);while(true){const part=await stream.read();if(part.done)break;if(part.value!==undefined)answer+=part.value;}}else answer=await model.prompt(input);
  this.setData({answer});console.info('AI_RESULT',JSON.stringify({kind,answer}));
 }catch(error){this.setData({answer:'请在真机上测试 AI 功能'});console.info('AI_ERROR',JSON.stringify({kind,message:String(error.message||error)}));}finally{if(model)model.destroy();this.busy=false;}}
};
</script><page><view class="root"><text class="title">AI 验证</text><text>{{answer}}</text></view></page><style>.root{width:100%;height:100%;background:#000;color:#b6ef9f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;font-size:20px}.title{font-size:30px}</style>`;
  const directory=path.join(home,'probe');await fs.mkdir(path.join(directory,'pages/index'),{recursive:true});
  await fs.writeFile(path.join(directory,'app.json'),JSON.stringify({name:'AI 验证',version:'1.0.0',engine:'>=0.18.0',pages:['pages/index/index'],permissions:[]}));
  await fs.writeFile(path.join(directory,'pages/index/index.ink'),source);
  const project=await daemon.service.call('aiui_project_import',{directory});
  const config=daemon.service.config().mcpServers['aiui-workbench'];mcp=new Client({name:'simulator-ai-qa',version:'1.0'});
  await mcp.connect(new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...config.env}}));
  await tool('aiui_context_get',{existingSkills:['aiui-dev','aiui-workshop']});
  // This QA drives a single runtime. Stop the desktop renderer before MCP can
  // also open its automatic preview iframe for the same session.
  await page.goto('about:blank');
  preview=await tool('aiui_preview_open',{projectId:project.id});
  const next=app.waitForEvent('window');await app.evaluate(async({BrowserWindow},url)=>{const w=new BrowserWindow({show:false,width:520,height:400,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.webContents.setBackgroundThrottling(false);await w.loadURL(url);},preview.url);page=await next;
  await page.locator('#status').waitFor({state:'hidden',timeout:45000});await until(async()=>(await tool('aiui_preview_state',{sessionId:preview.id})).status==='ready');
  await check('真实 MCP 发现按需读取 Skill 和 AI 接管工具',async()=>{const list=(await mcp.listTools()).tools;for(const name of ['aiui_ai_configure','aiui_ai_wait','aiui_ai_reply','aiui_skill_read'])assert.ok(list.some(t=>t.name===name));assert.match((await tool('aiui_skill_read',{path:'references/simulator-ai.md'})).content,/supportsImages/);});
  await check('默认不启用模型接管，实际 SDK 调用引导真机测试',async()=>{await act('tap');await until(async()=>await count('AI_ERROR')===1);assert.equal((await tool('aiui_preview_state',{sessionId:preview.id})).ai.enabled,false);});
  await check('文字请求经真实 Ink SDK → HTTP → MCP 领取和一次性回填',async()=>{
    await configure({enabled:true,supportsImages:false});await act('tap');const event=await tool('aiui_ai_wait',{sessionId:preview.id,timeoutMs:10000});assert.equal(event.status,'request');
    const idle=await tool('aiui_ai_wait',{sessionId:preview.id,timeoutMs:0});assert.deepEqual(idle,{status:'idle',listenAgain:false});assert.ok(JSON.stringify(idle).length<60);
    await tool('aiui_ai_reply',{sessionId:preview.id,requestId:event.requestId,replyToken:event.replyToken,text:'文字回填通过'});await until(async()=>await count('AI_RESULT')===1);
    assert.equal((await raw('aiui_ai_reply',{sessionId:preview.id,requestId:event.requestId,replyToken:event.replyToken,text:'duplicate'})).isError,true);
  });
  await check('promptStreaming 接收最终增量并继续应用',async()=>{
    await act('key',{code:'ArrowUp'});const event=await tool('aiui_ai_wait',{sessionId:preview.id,timeoutMs:10000});assert.equal(event.status,'request');await tool('aiui_ai_reply',{sessionId:preview.id,requestId:event.requestId,replyToken:event.replyToken,text:'流式传输回填通过'});await until(async()=>await count('AI_RESULT')===2);
  });
  await check('文字 AI 的图片请求明确返回 device-required，不能伪造识图通过',async()=>{
    await act('key',{code:'Space'});const result=await tool('aiui_ai_wait',{sessionId:preview.id,timeoutMs:10000});assert.equal(result.status,'device-required');assert.match(result.instruction,/主动告诉用户/);await until(async()=>await count('AI_ERROR')===2);assert.equal((await tool('aiui_preview_state',{sessionId:preview.id})).ai.pending.length,0);
  });
  await check('多模态请求以 MCP 图片附件交付，真实应用收到 JSON 结果',async()=>{
    await configure({enabled:true,supportsImages:true});await act('key',{code:'Space'});
    const response=await raw('aiui_ai_wait',{sessionId:preview.id,timeoutMs:10000});assert.ok(!response.isError);const event=parse(response),images=response.content.filter(c=>c.type==='image');assert.equal(images.length,1);assert.ok(!JSON.stringify(event).includes(image.split(',')[1]));
    const imageFile=path.join(output,'request-image.png');await fs.writeFile(imageFile,Buffer.from(images[0].data,'base64'));
    let answer='{"stars":2,"circles":3,"squares":1}';
    if(manual){
      const answerFile=path.join(output,'manual-answer.json');await fs.rm(answerFile,{force:true});
      console.log(JSON.stringify({manualInference:true,image:imageFile,question:event.messages[0].content[0].text,answerFile}));
      answer=await until(async()=>{try{return await fs.readFile(answerFile,'utf8');}catch{return null;}},80000);
    }
    assert.deepEqual(JSON.parse(answer),{stars:2,circles:3,squares:1});
    await tool('aiui_ai_reply',{sessionId:preview.id,requestId:event.requestId,replyToken:event.replyToken,text:answer});await until(async()=>await count('AI_RESULT')===3);
    const result=(await logs()).filter(l=>l.message.includes('AI_RESULT ')).at(-1);assert.deepEqual(JSON.parse(JSON.parse(result.message.slice(result.message.indexOf('AI_RESULT ')+'AI_RESULT '.length)).answer),{stars:2,circles:3,squares:1});
    await page.locator('#screen').screenshot({path:path.join(output,'application-result.png')});
  });
  await check('重载取消旧请求，旧回填拒绝且接管自动关闭',async()=>{
    await act('tap');const event=await tool('aiui_ai_wait',{sessionId:preview.id,timeoutMs:10000});await act('reload');
    assert.equal((await raw('aiui_ai_reply',{sessionId:preview.id,requestId:event.requestId,replyToken:event.replyToken,text:'stale result'})).isError,true);
    const status=await tool('aiui_preview_state',{sessionId:preview.id});assert.equal(status.ai.enabled,false);assert.deepEqual(status.ai.pending,[]);await configure({enabled:false});
  });
  report.passed=true;
}catch(error){report.error=error.stack;if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});if(preview&&mcp)report.logs=await logs().catch(()=>[]);throw error;}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await mcp?.close();await app?.close();await daemon?.close();}
