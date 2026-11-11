import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { startWeb } from '../web/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webMode = process.env.AIUI_SIMULATOR_WEB === '1';
const executablePath = process.env.AIUI_CAMERA_QA_EXECUTABLE;
const home = path.join(root, '.local/camera-qa', String(Date.now()));
const output = path.join(root, 'output/qa', executablePath ? 'camera-packaged' : webMode ? 'camera-web' : 'camera');
await fs.mkdir(output, { recursive: true });
const report = { checks: [], simulated: true, physicalCameraTested: false, deviceAcceptance: false, runtimePolyfills: { imageEncoding: 'image/png', stillPhoto: 'preview-frame' }, systemPhotoEvidence: path.join(root, 'output/qa/camera-system-photo/report.json') };
const packagedRoot = executablePath && path.resolve(path.dirname(executablePath), '../Resources/app');
const startService = packagedRoot ? (await import(pathToFileURL(path.join(packagedRoot, 'core/daemon.mjs')))).startDaemon : startDaemon;
const daemon = await startService(home), call = (tool, args = {}) => daemon.service.call(tool, args, 'camera-qa');
const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: ['--use-fake-device-for-media-stream', ...(executablePath ? [] : [root])], cwd: root, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
let page = await app.firstWindow(), gateway, preview;
await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.showInactive(); });
if (webMode) {
 try {
  gateway = await startWeb({ home, client: { connection: daemon.connection, call } });
  const next = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow, session }, { url, origin, policyPath }) => {
    const window = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    process.getBuiltinModule('module').createRequire(policyPath)(policyPath).installMediaPermissions(session.defaultSession, { getWebContents: () => window.webContents, origin });
    window.webContents.setBackgroundThrottling(false); await window.loadURL(url); window.showInactive();
  }, { url: gateway.url, origin: daemon.connection.origin, policyPath: path.join(root, 'electron/media-permissions.cjs') });
  page = await next;
 } catch (failure) { await app.close().catch(() => {}); await gateway?.close(); await daemon.close(); throw failure; }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 20000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(120); } throw new Error('Camera QA timed out'); }
const logs = async () => (await call('aiui_preview_logs', { sessionId: preview.id, limit: 300 })).logs;
const state = async () => (await call('aiui_preview_state', { sessionId: preview.id })).state;
const act = (action, parameters = {}) => call('aiui_preview_action', { sessionId: preview.id, action, parameters });
async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); console.log('PASS', name); }
async function hasLog(text) { return until(async () => (await logs()).find(log => log.message.includes(text))); }
async function open(project) {
  await page.getByRole('button', { name: '模拟器', exact: true }).click();
  await page.getByRole('button', { name: '运行 ' + project.name, exact: true }).click();
  await page.frameLocator('iframe').locator('#status').waitFor({ state: 'hidden', timeout: 45000 });
  preview = await until(async () => (await call('aiui_status')).previews.find(item => item.projectId === project.id && item.status === 'ready'));
}
const source = `<script def>{"navigationBarTitleText":""}</script><script setup>
export default {
 data:{status:'等待相机',frames:0},
 onLoad(){this.stream=null;this.capture=null;this.busy=false;this.run=0;},
 onHide(){this.stop();},onUnload(){this.stop();},
 onKeyDown(e){if(['Enter','Backspace','ArrowRight','ArrowUp'].includes(e.code))e.preventDefault();},
 onKeyUp(e){if(e.code==='Enter'){e.preventDefault();this.start();}if(e.code==='Backspace'){e.preventDefault();this.stop();}if(e.code==='ArrowRight'){e.preventDefault();this.sample();}if(e.code==='ArrowUp'){e.preventDefault();this.photo();}},
 stop(){if(this.stream)this.stream.getTracks().forEach(track=>track.stop());this.stream=null;this.capture=null;},
 async sample(){const bitmap=await this.capture.grabFrame();try{const canvas=new Canvas(bitmap.width,bitmap.height);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixel=Array.from(ctx.getImageData(bitmap.width/2,bitmap.height/2,1,1).data);console.info('CAMERA_FRAME',JSON.stringify({run:this.run,width:bitmap.width,height:bitmap.height,pixel}));this.setData({frames:this.data.frames+1,status:'连续取景正常'});}finally{bitmap.close();}},
 async photo(){try{const blob=await this.capture.takePhoto({quality:'high',mode:'telephoto',enableSystemPreview:false});const bitmap=await createImageBitmap(blob);try{const canvas=new Canvas(bitmap.width,bitmap.height);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixel=Array.from(ctx.getImageData(bitmap.width/2,bitmap.height/2,1,1).data);console.info('CAMERA_PHOTO',JSON.stringify({run:this.run,type:blob.type,bytes:blob.size,width:bitmap.width,height:bitmap.height,pixel}));}finally{bitmap.close();}}catch(error){console.info('CAMERA_PHOTO_ERROR',JSON.stringify({name:error.name,message:error.message}));}},
 async start(){if(this.busy)return;this.busy=true;this.stop();this.run++;try{this.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:10}}});const track=this.stream.getVideoTracks()[0];this.capture=new ImageCapture(track);await this.sample();console.info('CAMERA_STARTED',this.run);}catch(error){console.info('CAMERA_ERROR',JSON.stringify({run:this.run,name:error.name,message:error.message,stack:error.stack}));this.setData({status:error.message});this.stop();}finally{this.busy=false;}}
};
</script><page><view class="root"><text class="title">相机链路测试</text><text>{{status}}</text><text>已抓取 {{frames}} 帧</text><text>Enter 取景 · 右键抓帧 · 返回释放</text></view></page><style>.root{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;background:#000;color:#b6ef9f;font-size:16px}.title{font-size:26px}</style>`;
try {
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  const directory = path.join(home, 'probe'); await fs.mkdir(path.join(directory, 'pages/index'), { recursive: true });
  await fs.writeFile(path.join(directory, 'app.json'), JSON.stringify({ name: '相机测试', version: '1.0.0', engine: '>=0.18.0', pages: ['pages/index/index'], permissions: ['CAMERA'] }));
  await fs.writeFile(path.join(directory, 'pages/index/index.ink'), source);
  const project = await call('aiui_project_import', { directory }); await open(project);
  const fixtures = {};
  for (const color of ['red', 'lime', 'scene']) {
    const data = await page.evaluate(color => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480; const ctx = canvas.getContext('2d'); ctx.fillStyle = color === 'scene' ? '#eee' : color; ctx.fillRect(0, 0, 640, 480); if(color==='scene'){for(let y=0;y<6;y++)for(let x=0;x<8;x++){ctx.fillStyle=(x+y)%2?'#222':'#ddd';ctx.fillRect(x*80,y*80,80,80);}ctx.fillStyle='#fff';ctx.fillRect(60,160,520,150);ctx.fillStyle='#111';ctx.font='bold 36px sans-serif';ctx.fillText('SIMULATED CAMERA',115,225);ctx.font='24px sans-serif';ctx.fillText('Photo fixture · 640 x 480',165,268);} return canvas.toDataURL('image/png').split(',')[1]; }, color);
    fixtures[color] = path.join(home, color + '.png'); await fs.writeFile(fixtures[color], Buffer.from(data, 'base64'));
  }
  await check('未选择来源时明确提示，不擅自使用电脑摄像头', async () => { await act('tap'); await hasLog('CAMERA_ERROR'); assert.equal((await state()).camera.activeStreams, 0); assert.equal((await state()).camera.source, 'fixture'); assert.match((await state()).camera.error, /选择照片/); });
  await check('照片经真实 Ink getUserMedia / grabFrame 完成连续取景', async () => {
    await act('camera_fixture', { path: fixtures.red }); await act('tap'); await hasLog('CAMERA_STARTED'); for(let i=0;i<3;i++){await act('key',{code:'ArrowRight'});await pause(150);}
    await until(async () => (await logs()).filter(log => log.message.includes('CAMERA_FRAME')).length >= 4);
    const frames = (await logs()).filter(log => log.message.includes('CAMERA_FRAME')).map(log => JSON.parse(log.message.slice(log.message.indexOf('{'))));
    assert.ok(frames.length >= 4); assert.ok(frames.every(frame => frame.width === 640 && frame.height === 480 && frame.pixel[0] > 240 && frame.pixel[1] < 15));
    assert.equal((await state()).camera.activeStreams, 1);
  });
  await check('ImageCapture.takePhoto 输出可解码的 PNG，像素与素材一致', async () => {
    await act('key',{code:'ArrowUp'});const log=await hasLog('CAMERA_PHOTO {');
    const photo=JSON.parse(log.message.slice(log.message.indexOf('{')));
    assert.equal(photo.type,'image/png');assert.equal(photo.width,640);assert.equal(photo.height,480);assert.ok(photo.bytes>0);assert.ok(photo.pixel[0]>240&&photo.pixel[1]<15);
  });
  await check('更换照片后正在运行的流读到新像素', async () => { await act('camera_fixture', { path: fixtures.lime }); await pause(250); await act('key', { code: 'ArrowRight' }); await until(async () => (await logs()).filter(log => log.message.includes('CAMERA_FRAME')).some(log => JSON.parse(log.message.slice(log.message.indexOf('{'))).pixel[1] > 240)); assert.equal((await state()).camera.activeStreams, 1); });
  await check('损坏的照片不会替换当前素材或污染重载恢复', async () => {
    const invalid = path.join(home, 'invalid.png'); await fs.writeFile(invalid, 'not an image');
    await assert.rejects(act('camera_fixture', { path: invalid }));
    assert.equal((await state()).camera.fixture, true); assert.equal((await state()).camera.activeStreams, 1);
  });
  await check('撤销权限结束现有轨道，并拒绝后续取景', async () => { await act('camera_permission', { allowed: false }); assert.equal((await state()).camera.activeStreams, 0); await act('tap'); await until(async () => (await state()).camera.error === '模拟相机权限已拒绝'); await act('camera_permission', { allowed: true }); });
  await check('电脑摄像头来源经 Chromium 测试设备完成连续取景', async () => {
    const cursor=(await logs()).at(-1)?.sequence||0;
    await act('camera_source', { source: 'webcam' }); await act('tap');
    await until(async () => (await logs()).some(log => log.sequence>cursor && log.message.includes('CAMERA_STARTED')));
    assert.equal((await state()).camera.activeStreams, 1); assert.equal((await state()).camera.source, 'webcam');
    await act('key',{code:'ArrowUp'});await until(async () => (await logs()).some(log=>log.sequence>cursor&&log.message.includes('CAMERA_PHOTO {')));
  });
  await check('应用停止轨道释放摄像头，切换来源和重载无残留', async () => {
    await act('back'); await until(async () => (await state()).camera.activeStreams === 0);
    await act('camera_source', { source: 'fixture' }); await act('tap'); await until(async () => (await state()).camera.activeStreams === 1);
    await act('reload'); await until(async () => (await state()).running && (await state()).camera.activeStreams === 0);
    assert.equal((await state()).camera.fixture, true);
    const frame = page.frames().find(frame => frame.url().includes('/runtime/preview/')); await frame.goto(frame.url());
    await until(async () => (await state()).running); await act('tap'); await until(async () => (await state()).camera.activeStreams === 1);
    assert.equal((await state()).camera.fixture, true); await act('exit');
    await page.getByRole('region', { name: '模拟器桌面' }).waitFor(); assert.equal((await state()).camera.activeStreams, 0);
  });
  report.success = true;
} catch (failure) {
  report.error = failure.stack;
  if (preview) { report.state = await state().catch(() => null); report.logs = await logs().catch(() => []); }
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw failure;
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const closeTimer = setTimeout(() => app.process().kill('SIGKILL'), 5000);
  try { await app.close().catch(() => {}); } finally { clearTimeout(closeTimer); await gateway?.close(); await daemon.close(); }
}
