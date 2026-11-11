import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';
import {startDaemon} from '../core/daemon.mjs';
import {startWeb} from '../web/server.mjs';
import {poseQuaternion} from '../shared/pose.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webMode=process.env.AIUI_SIMULATOR_WEB==='1';
const home=path.join(root,'.local/simulator-qa',String(Date.now())),output=path.join(root,'output/qa',webMode?'simulator-web':'simulator');
await fs.mkdir(output,{recursive:true});
const report={checks:[],errors:[],simulated:true,deviceAcceptance:false};
const daemon=await startDaemon(home);
const call=(tool,args={})=>daemon.service.call(tool,args,'qa');
const app=await electron.launch({args:[root],cwd:root,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});
let page=await app.firstWindow(),gateway;await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.hide();});
if(webMode){gateway=await startWeb({home,client:{connection:daemon.connection,call}});const next=app.waitForEvent('window');await app.evaluate(async({BrowserWindow},url)=>{const w=new BrowserWindow({show:false,width:1440,height:940,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.webContents.setBackgroundThrottling(false);await w.loadURL(url);},gateway.url);page=await next;}
page.on('pageerror',e=>report.errors.push(e.message));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await pause(100);}throw new Error('等待模拟器状态超时');}
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
let preview;
const state=async()=>call('aiui_preview_state',{sessionId:preview.id});
const act=(action,parameters={})=>call('aiui_preview_action',{sessionId:preview.id,action,parameters});
const logs=async()=> (await call('aiui_preview_logs',{sessionId:preview.id,limit:300})).logs;
async function running(){await page.frameLocator('iframe').locator('#status').waitFor({state:'hidden',timeout:45000});await page.getByRole('button',{name:'鼠标模拟 3DoF',exact:true}).waitFor();await until(async()=>!(await page.getByRole('button',{name:'鼠标模拟 3DoF',exact:true}).isDisabled()));preview=(await call('aiui_status')).previews.find(s=>s.status==='ready');assert.ok(preview);}
async function drag(locator,dx,dy,{shift=false,button=null}={}){
  await page.mouse.move(100,400);await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert.ok(box);
  const x=box.x+box.width/2,y=box.y+box.height/2;
  if(shift)await page.keyboard.down('Shift');await page.mouse.move(x,y);if(button)await page.mouse.down({button});await page.mouse.move(x+dx,y+dy,{steps:12});if(button)await page.mouse.up({button});if(shift)await page.keyboard.up('Shift');
}
async function poseMatches(expected){return until(async()=>{const p=(await state()).state.pose;return Object.entries(expected).every(([k,v])=>Math.abs(p[k]-v)<.6)&&p;});}
const fixture=`<script def>{"navigationBarTitleText":""}</script><script setup>
export default {
 data:{readout:'等待姿态',taps:0},
 onLoad(){this.sensor=null;this.last=0;},
 onShow(){this.sensor=new AbsoluteOrientationSensor({frequency:60});this.sensor.addEventListener('reading',()=>{if(Date.now()-this.last<200)return;this.last=Date.now();const q=Array.from(this.sensor.quaternion);console.info('POSE_PROBE',JSON.stringify({q,taps:this.data.taps}));this.setData({readout:q.map(v=>v.toFixed(3)).join('  ')});});this.sensor.start();},
 onHide(){if(this.sensor)this.sensor.stop();},onUnload(){if(this.sensor)this.sensor.stop();},
 onKeyDown(e){if(['Enter','Backspace'].includes(e.code))e.preventDefault();},
 onKeyUp(e){if(e.code==='Enter'){e.preventDefault();this.tap();}if(e.code==='Backspace'){e.preventDefault();window.close();}},
 tap(){this.setData({taps:this.data.taps+1});console.info('PROBE_TAP',this.data.taps);}
};
</script><page><view class="root" bindtap="tap"><text class="title">3DoF 姿态测试</text><text>移动鼠标，观察姿态传感器</text><text>{{readout}}</text><text>确认次数 {{taps}}</text><text>返回键退出到桌面</text></view></page><style>.root{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#000;color:#b6ef9f;font-size:14px}.title{font-size:26px;}</style>`;
try{
 await page.getByRole('button',{name:'模拟器',exact:true}).click();
 await check('空桌面提供导入入口',async()=>{await page.getByText('桌面还没有应用',{exact:true}).waitFor();});
 let probe;
 await check('桌面自动显示项目库，长列表可滚动',async()=>{
  for(let i=0;i<10;i++){
   const directory=path.join(home,'projects','probe-'+i);await fs.mkdir(path.join(directory,'pages/index'),{recursive:true});
   await fs.writeFile(path.join(directory,'app.json'),JSON.stringify({name:i===9?'姿态测试':'示例应用 '+(i+1),version:'1.0.0',pages:['pages/index/index'],permissions:[]}));
   await fs.writeFile(path.join(directory,'pages/index/index.ink'),fixture);
   const p=await call('aiui_project_import',{directory});if(i===9)probe=p;
  }
  await until(async()=>await page.locator('.launcher-app').count()===10);
  await page.screenshot({path:path.join(output,'01-desktop.png')});
 });
 await check('桌面方向键连发和长按只移动一项，停顿、反向和跨行滚动正常',async()=>{
  const desktop=page.getByRole('region',{name:'模拟器桌面'});await desktop.focus();
  const selection=()=>page.locator('.launcher-app[aria-pressed="true"]').getAttribute('data-project-id');
  const start=await selection();for(let i=0;i<8;i++)await page.keyboard.press(i%2?'ArrowDown':'ArrowRight');
  const first=await selection();assert.notEqual(first,start);
  const ids=await page.locator('.launcher-app').evaluateAll(nodes=>nodes.map(n=>n.dataset.projectId));assert.equal(first,ids[(ids.indexOf(start)+1)%ids.length]);
  await pause(400);await page.keyboard.press('ArrowRight');const second=await selection();assert.equal(second,ids[(ids.indexOf(first)+1)%ids.length]);
  await page.keyboard.press('ArrowLeft');assert.equal(await selection(),first);
  await pause(400);await page.keyboard.down('ArrowRight');for(let i=0;i<15;i++){await page.keyboard.down('ArrowRight');await pause(60);}await page.keyboard.up('ArrowRight');assert.equal(await selection(),second);
  for(let i=0;i<7;i++){await pause(380);await page.keyboard.press('ArrowRight');}
  assert.ok(await page.locator('.launcher-grid').evaluate(node=>node.scrollTop>0));
 });
 await check('桌面点击启动真实 Ink 应用',async()=>{await page.getByRole('button',{name:'运行 姿态测试',exact:true}).click();await running();await page.frameLocator('iframe').locator('#screen').evaluate(node=>{window.pointerEvents=[];for(const type of ['pointerenter','pointerleave','pointermove'])document.addEventListener(type,e=>{window.pointerEvents.push({type,x:e.clientX,y:e.clientY,shift:e.shiftKey,buttons:e.buttons,target:e.target.tagName});window.pointerEvents=window.pointerEvents.slice(-80);},true);});await page.locator('.head-model canvas').evaluate(node=>{window.headEvents=[];for(const type of ['pointerenter','pointermove','pointerdown','pointerup','pointerleave'])node.addEventListener(type,e=>{window.headEvents.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,pose:document.querySelector('[data-axis=yaw]').textContent});},true);});assert.equal(preview.projectId,probe.id);await until(async()=>(await state()).state.sensorSessions===1);});
 const screen=()=>page.frameLocator('iframe').locator('#screen');
 await check('画面内无按键移动同时改变 yaw/pitch，且不误触确认',async()=>{
  await drag(screen(),80,-40);await poseMatches({yaw:20,pitch:10,roll:0});assert.equal((await logs()).filter(l=>l.message.includes('PROBE_TAP')).length,0);
  const q=poseQuaternion({yaw:20,pitch:10,roll:0});await until(async()=>(await logs()).some(l=>{const match=l.message.match(/POSE_PROBE (\{.*\})/);return match&&JSON.parse(match[1]).q.every((v,i)=>Math.abs(v-q[i])<.001);}));
 });
 await check('Shift 移动和右键移动独立控制侧倾',async()=>{await drag(screen(),40,20,{shift:true});await poseMatches({yaw:20,pitch:10,roll:10});await drag(screen(),-20,0,{button:'right'});await poseMatches({yaw:20,pitch:10,roll:5});});
 await check('头部模型可无按键移动控制，应用与角度读数同步',async()=>{await drag(page.locator('.head-model canvas'),40,0);await poseMatches({yaw:30,pitch:10,roll:5});assert.equal(await page.locator('[data-axis="yaw"]').textContent(),'30.0°');await page.screenshot({path:path.join(output,'02-head-model-pose.png')});});
 await check('回正、灵敏度、精确滑条和外部姿态同步',async()=>{
  await page.getByRole('button',{name:'姿态回正',exact:true}).click();await poseMatches({yaw:0,pitch:0,roll:0});
  await page.getByRole('slider',{name:'鼠标灵敏度',exact:true}).fill('0.5');await until(async()=>(await state()).state.mouse.sensitivity===.5);await drag(screen(),40,0);await poseMatches({yaw:20});
  await page.getByRole('slider',{name:'左右转头',exact:true}).fill('-12');await poseMatches({yaw:-12});
  await act('pose',{yaw:8,pitch:-5,roll:12});await until(async()=>await page.getByRole('slider',{name:'左右转头',exact:true}).inputValue()==='8');
 });
 await check('自动演示幅度与周期生效，画面内无按键鼠标可立即接管',async()=>{
  await act('pose',{yaw:0,pitch:0,roll:0});await page.getByRole('button',{name:'演示',exact:true}).click();
  await page.getByRole('button',{name:'组合动作',exact:true}).click();await page.getByRole('slider',{name:'动作幅度',exact:true}).fill('25');await page.getByRole('slider',{name:'演示周期',exact:true}).fill('2');
  await page.getByRole('button',{name:'开始演示',exact:true}).click();await until(async()=>{const s=(await state()).state;return s.motion.enabled&&Math.abs(s.pose.yaw)>3&&Math.abs(s.pose.pitch)>1;});
  await page.screenshot({path:path.join(output,'03-auto-motion.png')});await drag(screen(),20,0);await until(async()=>(await state()).state.motion.enabled===false);await pause(220);const p=(await state()).state.pose;await pause(350);assert.deepEqual((await state()).state.pose,p);
 });
 await check('停止演示保持姿态，手动移动头模同样接管',async()=>{
  await page.getByRole('button',{name:'开始演示',exact:true}).click();await until(async()=>(await state()).state.motion.enabled);
  await drag(page.locator('.head-model canvas'),-30,0);await until(async()=>(await state()).state.motion.enabled===false);
  await page.getByRole('button',{name:'开始演示',exact:true}).click();await page.getByRole('button',{name:'停止演示',exact:true}).click();await until(async()=>(await state()).state.motion.enabled===false);
 });
 await check('关闭 3DoF 后鼠标直接操作应用，开启后单击确认',async()=>{
  const before=(await logs()).filter(l=>l.message.includes('PROBE_TAP')).length;
  await page.getByRole('button',{name:'鼠标模拟 3DoF',exact:true}).click();await until(async()=>(await state()).state.mouse.enabled===false);const p=(await state()).state.pose;
  await screen().click();await until(async()=>(await logs()).filter(l=>l.message.includes('PROBE_TAP')).length===before+1);assert.deepEqual((await state()).state.pose,p);
  await page.getByRole('button',{name:'鼠标模拟 3DoF',exact:true}).click();await until(async()=>(await state()).state.mouse.enabled);await screen().click();await until(async()=>(await logs()).filter(l=>l.message.includes('PROBE_TAP')).length===before+2);
 });
 await check('应用主动退出返回桌面，可以再次启动',async()=>{
  await screen().press('Backspace');await page.getByRole('region',{name:'模拟器桌面'}).waitFor();assert.equal((await state()).status,'closed');
  await page.getByRole('button',{name:'运行 姿态测试',exact:true}).click();await running();await until(async()=>(await state()).state.sensorSessions===1);
 });
 await check('固定回桌面入口停止实例、清理输入和自动演示',async()=>{
  await act('pose_motion',{enabled:true});await page.getByRole('button',{name:'回到桌面',exact:true}).click();await page.getByRole('region',{name:'模拟器桌面'}).waitFor();
  const s=(await state()).state;assert.equal(s.running,false);assert.equal(s.sensorSessions,0);assert.equal(s.motion.enabled,false);assert.equal(s.mouse.dragging,false);
 });
 await check('公开姿态示例可从桌面启动并接收鼠标姿态',async()=>{
  const p=await call('aiui_project_import',{directory:path.resolve(root,'examples/motion-lab')});report.projectRevision=p.revision;
  await page.getByRole('button',{name:'运行 Motion Lab',exact:true}).click();await running();assert.equal(preview.projectId,p.id);
  await act('tap');await drag(screen(),48,-16);await poseMatches({yaw:12,pitch:4});
  await until(async()=>(await logs()).some(l=>l.message.includes('MOTION_READING')));
  await page.screenshot({path:path.join(output,'04-motion-lab.png')});
 });
 await check('最小窗口仍能访问桌面与姿态控制',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().at(-1).setSize(1080,740));await pause(200);
  assert.ok(await page.locator('.simulation-layout').evaluate(n=>n.getBoundingClientRect().right<=window.innerWidth));
  await page.getByRole('button',{name:'回到桌面',exact:true}).click();await page.getByRole('region',{name:'模拟器桌面'}).waitFor();await page.screenshot({path:path.join(output,'05-desktop-compact.png')});
 });
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;try{await page.screenshot({path:path.join(output,'failure.png')});report.headEvents=await page.evaluate(()=>window.headEvents);report.pointerEvents=await page.frameLocator('iframe').locator('#screen').evaluate(()=>window.pointerEvents).catch(()=>[]);report.previews=(await call('aiui_status')).previews;report.logs=preview?await logs():[];}catch{}throw error;}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await app.close();await gateway?.close();await daemon.close();}
