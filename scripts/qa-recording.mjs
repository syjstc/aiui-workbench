import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {_electron as electron} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startDaemon} from '../core/daemon.mjs';
import {ROOT,sha,sleep} from '../core/util.mjs';
const exec=promisify(execFile),serial=process.argv[2],home=path.join(ROOT,'.local/recording-qa',String(Date.now())),out=path.join(ROOT,'output/qa/recording');
await fs.mkdir(out,{recursive:true});const report={startedAt:new Date().toISOString(),checks:[],errors:[],deviceVerified:false,opticalCapture:false};
let daemon,app,mcp,project,session;
async function call(name,args={}){const result=await mcp.callTool({name,arguments:args},undefined,{timeout:65000});const text=result.content.find(c=>c.type==='text')?.text;if(result.isError){let error;try{error=JSON.parse(text).error;}catch{}throw new Error(error||text);}return JSON.parse(text);}
async function cli(name,args={}){const r=await exec(process.execPath,[path.join(ROOT,'web/cli.mjs'),'call',name,'--args',JSON.stringify(args)],{env:{...process.env,AIUI_WORKBENCH_HOME:home},maxBuffer:2e6});return JSON.parse(r.stdout);}
async function check(name,work){await work();report.checks.push({name,passed:true});console.log('PASS',name);}
async function validate(record,name){assert.equal(record.status,'completed');const bytes=await fs.readFile(record.path);assert.equal(sha(bytes),record.sha256);const result=await exec(process.env.AIUI_QA_FFPROBE || 'ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_name,width,height,nb_read_frames:format=duration','-of','json',record.path]);const info=JSON.parse(result.stdout),video=info.streams[0];assert.ok(video.width>0&&video.height>0);assert.ok(Number(video.nb_read_frames)>=2);await exec(process.env.AIUI_QA_FFMPEG || 'ffmpeg',['-v','error','-i',record.path,'-f','null','-'],{maxBuffer:1e6});const file=path.join(out,name+path.extname(record.path));await fs.copyFile(record.path,file);return {...record,probe:info,artifact:file};}
try{
 daemon=await startDaemon(home);daemon.service.sdk.check=async()=>daemon.service.sdk.status();daemon.service.knowledge.sync=async()=>({revision:daemon.service.knowledge.status().revision});
 app=await electron.launch({args:[ROOT],cwd:ROOT,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));await page.getByRole('button',{name:'切换到中文',exact:true}).click();
 mcp=new Client({name:'recording-qa',version:'1.0.0'});await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'mcp/server.mjs')],env:{...process.env,AIUI_WORKBENCH_HOME:home}}));
 project=await call('aiui_project_import',{directory:path.resolve(ROOT,'examples/motion-lab')});
 await check('一次 MCP 回放公开示例交互并同步录制视频、截图和报告',async()=>{
   const job=await call('aiui_preview_test',{projectId:project.id,record:true,steps:[{action:'tap',expect:{logContains:'MOTION_ACTIVE'},timeoutMs:6000},{action:'pose',waitMs:800,settleMs:600,parameters:{yaw:-12,pitch:3,roll:0}},{action:'pose',waitMs:800,settleMs:600,parameters:{yaw:12,pitch:3,roll:0}},{action:'back',waitMs:500,settleMs:800,expect:{logContains:'MOTION_READY'},timeoutMs:6000}]});
   assert.equal(job.status,'succeeded');session=job.result.sessionId;report.simulator=await validate(job.result.video,'simulator-demo');assert.equal(report.simulator.simulated,true);assert.equal(report.simulator.revision,project.revision);
   await exec(process.env.AIUI_QA_FFMPEG || 'ffmpeg',['-v','error','-y','-i',report.simulator.artifact,'-frames:v','1',path.join(out,'simulator-first-frame.png')]);
 });
 await check('CLI 开始录制、MCP 停止封装，桌面可显示同一记录',async()=>{
   const start=await cli('aiui_record_start',{source:'simulator',sessionId:session,durationSeconds:10});await sleep(1800);assert.equal((await call('aiui_record_status',{recordingId:start.id})).id,start.id);const stop=await call('aiui_record_stop',{recordingId:start.id});report.shared=await validate(stop,'shared-cli-mcp');assert.equal((await cli('aiui_record_status',{recordingId:start.id})).sha256,stop.sha256);
   await page.getByRole('button',{name:'打开视频位置',exact:true}).waitFor();await page.screenshot({path:path.join(out,'recording-controls.png')});
 });
 await check('一次短片工具按时自动停止，静止应用也保留有效时长',async()=>{const job=await call('aiui_record_clip',{source:'simulator',sessionId:session,durationSeconds:2,fps:24});report.timed=await validate(job.result,'timed-simulator');assert.ok(report.timed.durationMs>=1800);assert.ok(Number(report.timed.probe.streams[0].nb_read_frames)>=20);});
 await check('退出应用会先保存视频，原项目源码没有被录制改写',async()=>{
   const r=await call('aiui_record_start',{source:'simulator',sessionId:session,durationSeconds:10});await sleep(1200);await call('aiui_preview_action',{sessionId:session,action:'exit'});const stop=await call('aiui_record_status',{recordingId:r.id});report.exit=await validate(stop,'application-exit');assert.equal((await call('aiui_project_refresh',{projectId:project.id})).revision,project.revision);
 });
 await check('应用自行关闭时先完成视频封装，再卸载模拟画面',async()=>{
   const opened=await call('aiui_preview_test',{projectId:project.id,steps:[]});session=opened.result.sessionId;
   const r=await call('aiui_record_start',{source:'simulator',sessionId:session,durationSeconds:10});await sleep(1200);await call('aiui_preview_action',{sessionId:session,action:'back'});
   for(let i=0;i<30;i++){const value=await call('aiui_record_status',{recordingId:r.id});if(value.status==='completed'){report.appClosed=await validate(value,'app-closed');break;}await sleep(100);}
   assert.equal(report.appClosed?.status,'completed');
 });
 if(serial)await check('真实眼镜与现有投屏并行录制 MP4，完整解码且不接管输入',async()=>{
   const mirror=await call('aiui_glasses_mirror_start',{serial,readOnly:true});assert.equal(mirror.status,'running');
   try{const job=await call('aiui_record_clip',{source:'glasses',serial,durationSeconds:3,fps:24});report.glasses=await validate(job.result,'glasses-screen');assert.equal(report.glasses.simulated,false);assert.equal(report.glasses.audio,false);assert.equal((await call('aiui_glasses_mirror_status',{serial})).session.status,'running');report.deviceVerified=true;}
   finally{await call('aiui_glasses_mirror_stop',{serial});}
 });
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;try{report.recordings=daemon.service.recordings.status();}catch{}throw error;}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(out,'acceptance.json'),JSON.stringify(report,null,2));await mcp?.close();await app?.close();await daemon?.close();}
