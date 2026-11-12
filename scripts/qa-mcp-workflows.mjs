import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron, chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../core/daemon.mjs';
import { ROOT, sha, sleep } from '../core/util.mjs';

const exec = promisify(execFile), home=path.join(ROOT,'.local/mcp-workflows-qa',String(Date.now())),output=path.join(ROOT,'output/qa/mcp-workflows');
await fs.mkdir(output,{recursive:true});
const report={startedAt:new Date().toISOString(),home,simulated:true,deviceVerified:false,uploaded:false,checks:[],errors:[]};
let daemon,app,mcp,browser,page,project,calls=0;
async function until(work,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const result=await work();if(result)return result;await sleep(100);}throw new Error('QA condition timed out');}
async function check(name,work){try{await work();report.checks.push({name,passed:true});console.log('PASS',name);}catch(error){report.checks.push({name,passed:false,error:error.message});throw error;}}
async function rawTool(name,args={}){calls++;return mcp.callTool({name,arguments:args},undefined,{timeout:65000});}
async function tool(name,args={}){const response=await rawTool(name,args);const text=response.content.find(c=>c.type==='text')?.text;if(response.isError)throw new Error(text);return JSON.parse(text);}
function parsed(response){return JSON.parse(response.content.find(c=>c.type==='text').text);}
async function cli(name,args={}){const file=path.join(home,'cli-request.json');await fs.writeFile(file,JSON.stringify(args));const result=await exec(process.execPath,[path.join(ROOT,'web/cli.mjs'),'call',name,'--args-file',file],{env:{...process.env,AIUI_WORKBENCH_HOME:home},maxBuffer:4*1024*1024});return JSON.parse(result.stdout);}

const fixture=`<script def>{"navigationBarTitleText":""}</script><script setup>
import wx from 'wx';
import {TempleNavigation,navigationDirection} from '../../lib/temple-navigation.js';
export default {
 data:{choice:0,page:0,mode:'menu',photo:'ready'},
 onLoad(){this.nav=new TempleNavigation();this.lastPose=0;console.info('PROBE_READY');},
 onShow(){this.nav.reset();this.sensor=new AbsoluteOrientationSensor({frequency:30});this.sensor.addEventListener('reading',()=>{if(Date.now()-this.lastPose<350)return;this.lastPose=Date.now();console.info('PROBE_POSE',JSON.stringify(Array.from(this.sensor.quaternion)));});this.sensor.start();},
 onHide(){this.nav.reset();if(this.sensor)this.sensor.stop();},onUnload(){this.nav.reset();if(this.sensor)this.sensor.stop();},
 onKeyDown(e){if(navigationDirection(e.code)){e.preventDefault();this.nav.keyDown(e);}else if(['Enter','Backspace','Space','Escape'].includes(e.code))e.preventDefault();},
 onKeyUp(e){
  if(navigationDirection(e.code)){e.preventDefault();const direction=this.nav.keyUp(e);if(direction){this.setData(this.data.mode==='menu'?{choice:(this.data.choice+direction+3)%3}:{page:Math.max(0,this.data.page+direction)});console.info('PROBE_NAV',JSON.stringify({choice:this.data.choice,page:this.data.page,mode:this.data.mode}));}return;}
  if(e.code==='Enter'){e.preventDefault();this.setData({mode:'pages'});console.info('PROBE_MODE pages');}
  if(e.code==='Backspace'){e.preventDefault();if(this.data.mode==='pages'){this.setData({mode:'menu'});console.info('PROBE_BACK menu');}else window.close();}
  if(e.code==='Space'){e.preventDefault();this.capture();}
  if(e.code==='Escape'){e.preventDefault();console.error('PROBE_INJECTED_ERROR');}
 },
 async capture(){try{const c=wx.media.createCameraContext();const p=await c.takePhoto({quality:'normal'});console.info('PHOTO_OK',p.data.byteLength);this.setData({photo:'photo '+p.data.byteLength});}catch(error){console.info('PHOTO_DENIED',String(error.message||error));this.setData({photo:'permission denied'});}}
};
</script><page><view class="root"><text class="title">MCP + CLI</text><text>真实 Ink 运行时验证</text><text>模式 {{mode}} · 菜单 {{choice}} · 页 {{page}}</text><text>{{photo}}</text><text>方向键切换 · 确认翻页 · 返回菜单</text></view></page><style>.root{width:100%;height:100%;background:#000;color:#b6ef9f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-size:16px}.title{font-size:30px}</style>`;
try{
  daemon=await startDaemon(home);await daemon.service.sdk.settings({autoCheck:false});
  app=await electron.launch({args:[ROOT],cwd:ROOT,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});
  page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'切换到中文',exact:true}).click();
  const config=(await page.evaluate(()=>window.workbench.call('aiui_mcp_config'))).mcpServers['aiui-workbench'];
  mcp=new Client({name:'ai-tool-workflow-qa',version:'1.0.0'});
  await mcp.connect(new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...config.env}}));
  await check('真实 stdio MCP 发现组合工具、能力资源与开发提示',async()=>{
    const definitions=(await mcp.listTools()).tools;report.toolCount=definitions.length;
    for(const name of ['aiui_capabilities_get','aiui_cli_info','aiui_preview_test','aiui_project_build','aiui_job_wait'])assert.ok(definitions.some(t=>t.name===name));
    report.simulationSchemaBytes=JSON.stringify(definitions.find(t=>t.name==='aiui_preview_test').inputSchema).length;assert.ok(report.simulationSchemaBytes<9000);
    const resource=await mcp.readResource({uri:'aiui://capabilities'});assert.equal(JSON.parse(resource.contents[0].text).platform.upload,'cloud-draft');
    assert.match((await mcp.getPrompt({name:'develop-aiui',arguments:{request:'验证交互并打包'}})).messages[0].content.text,/aiui_preview_test/);
  });
  await check('AI 从官方模板创建项目并使用真实目录编写测试应用',async()=>{
    project=await tool('aiui_project_create',{directory:path.join(home,'projects','probe'),name:'MCP CLI 验证'});
    await fs.mkdir(path.join(project.agentPath,'lib'),{recursive:true});
    await fs.copyFile(path.resolve(ROOT,'examples/hello-aiui/lib/temple-navigation.js'),path.join(project.agentPath,'lib/temple-navigation.js'));
    const appFile=path.join(project.agentPath,'app.json'),appJson=JSON.parse(await fs.readFile(appFile,'utf8'));appJson.permissions=['CAMERA'];await fs.writeFile(appFile,JSON.stringify(appJson,null,2));
    await fs.writeFile(path.join(project.agentPath,'pages/index/index.ink'),fixture);
    project=await tool('aiui_project_refresh',{projectId:project.id});report.projectId=project.id;report.revision=project.revision;
    const context=await tool('aiui_context_get',{projectId:project.id});assert.match(context.officialSkill.content,/AIUI Development/);assert.ok(context.capabilities.cli.call);
  });
  let session;
  await check('实测普通逐项调用与一次调用执行同样三个操作',async()=>{
    let start=calls;
    session=await tool('aiui_preview_open',{projectId:project.id});
    await until(async()=>{const s=await tool('aiui_preview_state',{sessionId:session.id});return s.status==='ready'&&s.state.running;});
    for(const [action,parameters]of [['tap',{}],['back',{}],['pose',{yaw:5,pitch:0,roll:0}]])await tool('aiui_preview_action',{sessionId:session.id,action,parameters});
    await rawTool('aiui_preview_capture',{sessionId:session.id});await tool('aiui_preview_logs',{sessionId:session.id});
    const manual=calls-start;start=calls;
    const response=await rawTool('aiui_preview_test',{projectId:project.id,steps:[{action:'tap',expect:{logContains:'PROBE_MODE pages'}},{action:'back',expect:{logContains:'PROBE_BACK menu'}},{action:'pose',parameters:{yaw:5,pitch:0,roll:0},expect:{state:{'pose.yaw':5}}}]});
    assert.ok(!response.isError,response.content.find(c=>c.type==='text')?.text);const result=parsed(response);
    assert.equal(result.status,'succeeded');assert.equal(result.result.passed,true);assert.ok(response.content.some(c=>c.type==='image'));assert.equal(result.result.capture.revision,project.revision);
    report.efficiency={sameOperations:['tap','back','pose'],manualToolCalls:manual,combinedToolCalls:calls-start,includes:'runtime readiness, inputs, actual PNG and logs; combined call also evaluates assertions and writes a report',wallTimeClaim:false};
    report.smoke=result.result;await fs.copyFile(result.result.capture.path,path.join(output,'01-mcp-simulation.png'));
  });
  await check('一次模拟长滑、重复别名、第二滑、反向、翻页返回及 SDK 异常分支',async()=>{
    const response=await rawTool('aiui_preview_test',{projectId:project.id,steps:[
      {name:'长滑只有一项',action:'swipe',parameters:{direction:'forward',repeats:24,intervalMs:65,keyupOnly:true,aliases:true},expect:{logContains:'"choice":1',logCount:{contains:'PROBE_NAV',count:1}}},
      {name:'停顿后的第二滑',action:'swipe',waitMs:400,parameters:{direction:'forward',repeats:8,intervalMs:60,aliases:true},expect:{logContains:'"choice":2',logCount:{contains:'PROBE_NAV',count:1}}},
      {name:'反向操作',action:'swipe',parameters:{direction:'backward',repeats:8,keyupOnly:true,aliases:true},expect:{logContains:'"choice":1',logCount:{contains:'PROBE_NAV',count:1}}},
      {action:'tap',expect:{logContains:'PROBE_MODE pages'}},
      {name:'重复事件只翻一页',action:'swipe',parameters:{direction:'forward',repeats:12,keyupOnly:true,aliases:true},expect:{logContains:'"page":1',logCount:{contains:'PROBE_NAV',count:1}}},
      {action:'back',expect:{logContains:'PROBE_BACK menu'}},
      {action:'pose',parameters:{yaw:12,pitch:-5,roll:3},expect:{state:{'pose.yaw':12,'pose.pitch':-5},logContains:'PROBE_POSE'}},
      {action:'pose_stream',parameters:{enabled:false},settleMs:400,expect:{state:{'pose.connected':false}}},
      {action:'wait',settleMs:600,expect:{logCount:{contains:'PROBE_POSE',count:0}}},
      {action:'pose_stream',parameters:{enabled:true},expect:{state:{'pose.connected':true},logContains:'PROBE_POSE'}},
      {action:'camera_fixture',parameters:{path:path.join(ROOT,'assets/icon.png')},expect:{state:{'camera.fixture':true}}},
      {action:'key',parameters:{code:'Space'},expect:{logContains:'PHOTO_OK',state:{'readings.photos':1}}},
      {action:'camera_permission',parameters:{allowed:false}},
      {action:'key',parameters:{code:'Space'},expect:{logContains:'PHOTO_DENIED',state:{'readings.photos':1}}},
      {action:'network',parameters:{online:false},expect:{state:{'network.online':false}}},
      {action:'battery',parameters:{level:.12,charging:false},expect:{state:{'battery.level':.12}}},
      {action:'focus',parameters:{focused:false},expect:{state:{focused:false,inputEnabled:false}}},
      {action:'focus',parameters:{focused:true},expect:{state:{focused:true,inputEnabled:true}}},
    ]});
    const job=parsed(response);report.interaction=job.result;
    assert.ok(!response.isError,JSON.stringify(job));assert.equal(job.status,'succeeded');assert.equal(job.result.steps.length,18);assert.ok(job.result.assertionsEvaluated>=24);assert.deepEqual(job.result.errors,[]);
    await fs.copyFile(job.result.capture.path,path.join(output,'02-mcp-interactions.png'));
  });
  await check('旧步骤日志不能满足新步骤的断言，失败仍返回报告与 PNG',async()=>{
    const response=await rawTool('aiui_preview_test',{projectId:project.id,steps:[{action:'tap',expect:{logContains:'PROBE_MODE pages'}},{action:'wait',timeoutMs:300,expect:{logContains:'PROBE_MODE pages'}}]});
    const job=parsed(response);assert.equal(response.isError,true);assert.equal(job.status,'failed');assert.equal(job.result.steps[1].passed,false);assert.ok(job.result.path);assert.ok(response.content.some(c=>c.type==='image'));report.assertionFailure=job.result.path;
  });
  await check('应用错误会使自动验收失败，不把成功发出输入当作应用通过',async()=>{
    const response=await rawTool('aiui_preview_test',{projectId:project.id,steps:[{action:'key',parameters:{code:'Escape'}}]});
    const job=parsed(response);assert.equal(job.status,'failed');assert.ok(job.result.errors.some(l=>l.message.includes('PROBE_INJECTED_ERROR')));report.runtimeError=job.result.path;
  });
  let cliInfo;
  await check('AI 可定位内置 CLI，并在 CLI / MCP / 桌面之间共享姿态和日志',async()=>{
    cliInfo=await tool('aiui_cli_info',{projectId:project.id});
    const version=await exec(cliInfo.official.command,[...cliInfo.official.args,'--help'],{env:{...process.env,...cliInfo.shared.env}});assert.match(version.stdout,/AIX package manager/);assert.equal(cliInfo.official.cliVersion,'0.12.0');
    await cli('aiui_preview_action',{sessionId:session.id,action:'pose',parameters:{yaw:-15,pitch:2,roll:0}});
    assert.equal((await tool('aiui_preview_state',{sessionId:session.id})).state.pose.yaw,-15);
    await until(async()=>await page.getByRole('slider',{name:'左右转头',exact:true}).inputValue()==='-15');
    const logs=await cli('aiui_preview_logs',{sessionId:session.id,contains:'PROBE_POSE',limit:3});assert.ok(logs.logs.length);
    const same=await tool('aiui_preview_logs',{sessionId:session.id,contains:'PROBE_POSE',limit:3});assert.equal(same.logGeneration,logs.logGeneration);
    const capture=await cli('aiui_preview_capture',{sessionId:session.id});assert.equal(capture.data,undefined);assert.equal(sha(await fs.readFile(capture.path)),capture.sha256);
    report.cli={officialVersion:cliInfo.official.cliVersion,sharedCommand:cliInfo.shared,syncedLogGeneration:logs.logGeneration,capturePath:capture.path};
  });
  await check('CLI 一次模拟任务会自动切换桌面，MCP 读取到相同最终报告',async()=>{
    await page.getByRole('button',{name:'连接 AI 工具',exact:true}).click();
    const result=await cli('aiui_preview_test',{projectId:project.id,steps:[{action:'tap',expect:{logContains:'PROBE_MODE pages'}}]});
    assert.equal(result.status,'succeeded');const same=await tool('aiui_job_get',{jobId:result.id});assert.equal(same.result.path,result.result.path);
    await page.getByRole('button',{name:'回到桌面',exact:true}).waitFor();assert.ok((await tool('aiui_status')).clients.some(c=>c.name==='CLI'));
  });
  await check('CLI 一次官方检查与打包生成真实 AIX 和 SHA256，任务记录共享到 MCP',async()=>{
    const job=await cli('aiui_project_build',{projectId:project.id});report.build=job.result;
    assert.equal(job.status,'succeeded');assert.equal(job.result.check.passed,true);assert.equal(job.result.uploaded,false);assert.equal(job.result.submittedForReview,false);
    const bytes=await fs.readFile(job.result.artifact.path);assert.equal(bytes[0],80);assert.equal(bytes[1],75);assert.equal(sha(bytes),job.result.sha256);
    assert.equal((await tool('aiui_job_get',{jobId:job.id})).result.artifact.path,job.result.artifact.path);
    await fs.copyFile(job.result.artifact.path,path.join(output,'application.aix'));
  });
  await check('修改后验证最新源码，不复用旧运行实例与旧截图',async()=>{
    await fs.writeFile(path.join(project.agentPath,'pages/index/index.ink'),fixture.replace('PROBE_READY','PROBE_READY_V2'));
    const changed=await tool('aiui_project_refresh',{projectId:project.id});assert.notEqual(changed.revision,project.revision);
    const result=await tool('aiui_preview_test',{projectId:project.id,steps:[{action:'pose',parameters:{yaw:7},expect:{state:{'pose.yaw':7}}}]});
    assert.equal(result.result.revision,changed.revision);assert.equal(result.result.capture.revision,changed.revision);assert.equal(result.result.stale,false);assert.ok(result.result.logs.some(l=>l.message.includes('PROBE_READY_V2')));report.newRevision=changed.revision;
  });
  await check('任务执行期间修改源码会使报告失效',async()=>{
    const job=await tool('aiui_preview_test',{projectId:project.id,waitMs:0,steps:[{action:'wait',waitMs:1800}]});assert.equal(job.status,'running');
    await sleep(300);await fs.appendFile(path.join(project.agentPath,'pages/index/index.ink'),'\n<!-- edit while verifying -->');await tool('aiui_project_refresh',{projectId:project.id});
    const result=parsed(await rawTool('aiui_job_wait',{jobId:job.id}));assert.equal(result.status,'failed');assert.equal(result.result.stale,true);report.staleResult=result.result.path;
  });
  await check('组合任务可以取消，继续等待不会重新执行',async()=>{
    const job=await tool('aiui_preview_test',{projectId:project.id,waitMs:0,steps:[{action:'wait',waitMs:10000}]});
    await tool('aiui_job_cancel',{jobId:job.id});const result=parsed(await rawTool('aiui_job_wait',{jobId:job.id}));assert.equal(result.status,'cancelled');assert.equal(result.id,job.id);
  });
  await check('连接页面展示能力、可复制示例和手动上传边界，中文英文均可用',async()=>{
    await page.getByRole('button',{name:'连接 AI 工具',exact:true}).click();
    await page.getByRole('heading',{name:'连接后，AI 可以做什么',exact:true}).waitFor();await until(async()=>await page.locator('.mcp-capability').count()>=8);
    await page.locator('[data-capability-id="simulate"]').locator('summary').click();assert.match(await page.locator('[data-capability-id="simulate"]').innerText(),/aiui_preview_test/);
    await page.locator('[data-capability-id="simulate"]').getByRole('button',{name:'复制调用示例',exact:true}).click();
    const copied=await app.evaluate(({clipboard})=>clipboard.readText());assert.equal(JSON.parse(copied).arguments.projectId,project.id);
    await page.screenshot({path:path.join(output,'03-connect-capabilities-zh.png'),fullPage:true});
    await page.getByRole('button',{name:'Switch to English',exact:true}).click();
    await page.getByRole('heading',{name:'What AI can do after connecting',exact:true}).waitFor();assert.ok(await page.getByText('Shared progress across CLI and MCP',{exact:true}).count());
    await page.screenshot({path:path.join(output,'04-connect-capabilities-en.png'),fullPage:true});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1080,740));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  });
  await check('组合工具验证公开示例并保持源码不变',async()=>{
    const p=await tool('aiui_project_import',{directory:path.resolve(ROOT,'examples/motion-lab')});
    const result=await tool('aiui_preview_test',{projectId:p.id,steps:[
      {action:'tap',expect:{logContains:'MOTION_ACTIVE'}},
      {action:'pose',parameters:{yaw:12,pitch:4,roll:0},expect:{state:{'pose.yaw':12},logContains:'MOTION_READING'}},
      {action:'pose_stream',parameters:{enabled:false},settleMs:500,expect:{state:{'pose.connected':false}}},
      {action:'pose_stream',parameters:{enabled:true},expect:{logContains:'MOTION_READING'}},
    ]});
    assert.equal(result.status,'succeeded');assert.equal((await tool('aiui_project_refresh',{projectId:p.id})).revision,p.revision);
    report.example={revision:p.revision,report:result.result.path};await fs.copyFile(result.result.capture.path,path.join(output,'05-motion-lab.png'));
  });
  await check('没有桌面或 Web 时也能启动真实浏览器运行时执行 MCP 测试',async()=>{
    await app.close();app=null;
    // Isolate the browser handoff from the user's browser profile. This uses a
    // real Chrome runtime, not a fake acknowledgement of simulator commands.
    daemon.service.automation.openBrowser=async url=>{browser=await chromium.launch({executablePath:process.env.AIUI_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const tab=await browser.newPage();await tab.goto(url);};
    const p=await tool('aiui_project_create',{directory:path.join(home,'projects','browser-only'),name:'Browser-only MCP'});
    const result=await tool('aiui_preview_test',{projectId:p.id,steps:[{action:'pose',parameters:{yaw:9},expect:{state:{'pose.yaw':9}}}]});assert.equal(result.status,'succeeded');assert.equal(result.result.state.sourceUnmodified,true);report.browserOnly={report:result.result.path,handoff:'OS browser opener substituted with isolated headless Chrome; real official Ink and MCP commands'};
  });
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;try{await page?.screenshot({path:path.join(output,'failure.png')});report.previews=daemon?.service.previews.list();}catch{}throw error;}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(report,null,2));await browser?.close();await app?.close();await mcp?.close();await daemon?.close();}
