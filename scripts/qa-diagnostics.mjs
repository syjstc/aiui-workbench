import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../core/daemon.mjs';
import { Workbench } from '../core/service.mjs';
import { ROOT, run } from '../core/util.mjs';

const home=path.join(ROOT,'.local/diagnostics-qa',String(Date.now()));
const output=path.join(ROOT,'output/qa/diagnostics');await fs.mkdir(output,{recursive:true});
const report={home,checks:[],errors:[]};let daemon,app,mcp;
const check=async(name,work)=>{await work();report.checks.push({name,passed:true});console.log('PASS',name);};
try{
  daemon=await startDaemon(home);const w=daemon.service;
  await w.sdk.settings({autoCheck:false});await w.knowledge.settings({autoUpdate:false});
  w.sdk.check=async()=>w.sdk.status();w.knowledge.sync=async()=>w.knowledge.status();
  const a=await w.projects.create({directory:path.join(home,'project-a'),name:'同名应用'},w.knowledge);
  const b=await w.projects.create({directory:path.join(home,'project-b'),name:'同名应用'},w.knowledge);
  const own=await w.captureDiagnostic(new Error('QA project A failure'),{source:'qa',projectId:a.id});
  const other=await w.captureDiagnostic(new Error('QA project B failure'),{source:'qa',projectId:b.id});
  const environment=await w.captureDiagnostic(new Error('QA environment failure'),{source:'startup'});
  app=await electron.launch({args:[ROOT],cwd:ROOT,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});
  const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'切换到中文',exact:true}).click();
  await page.getByRole('button',{name:'日志与记录',exact:true}).click();
  const panel=page.locator('.diagnostic-panel'),row=id=>panel.locator(`[data-diagnostic-id="${id}"]`);
  const refresh=()=>panel.getByRole('button',{name:'刷新',exact:true}).click();
  await check('桌面按项目分开同名问题，展示真实目录，轮询不会标记已读',async()=>{
    await row(own.id).waitFor();await row(other.id).waitFor();await row(environment.id).waitFor();
    assert.match(await row(own.id).innerText(),new RegExp(a.projectPath));assert.match(await row(other.id).innerText(),new RegExp(b.projectPath));
    assert.equal(await panel.getByRole('button',{name:'复制给 AI 继续',exact:true}).count(),0);
    assert.equal(w.diagnostics.get({read:false}).items.length,3);
    await page.screenshot({path:path.join(output,'01-project-scopes.png')});
  });
  mcp=new Client({name:'diagnostics-qa',version:'1.0.0'});
  await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'mcp/server.mjs')],env:{...process.env,AIUI_WORKBENCH_HOME:home}}));
  await check('真实 MCP 自动收到当前项目与公共环境，不读取另一个项目',async()=>{
    const definitions=(await mcp.listTools()).tools;assert.ok(definitions.some(tool=>tool.name==='aiui_diagnostics_mark_read'));
    assert.equal(w.diagnostics.get().unreadCount,3);
    const response=await mcp.callTool({name:'aiui_project_refresh',arguments:{projectId:a.id}});
    const result=JSON.parse(response.content.find(item=>item.type==='text').text);
    assert.deepEqual(new Set(result.sharedDiagnostics.items.map(item=>item.id)),new Set([own.id,environment.id]));
    assert.equal(w.diagnostics.get({projectId:b.id}).unreadCount,1);
    await refresh();await row(own.id).waitFor({state:'detached'});await row(environment.id).waitFor({state:'detached'});await row(other.id).waitFor();
    assert.equal(w.diagnostics.get({diagnosticId:own.id}).items[0].status,'open');
    assert.equal(w.projects.get(a.id).sharedDiagnostics,undefined);
  });
  await check('已读记录可按项目回查，手动已读不误报修复',async()=>{
    await panel.getByLabel('筛选诊断阅读状态').selectOption('read');
    await row(own.id).waitFor();await row(environment.id).waitFor();
    assert.equal(await panel.getByText('AI 已读取',{exact:true}).count(),2);
    await panel.getByLabel('筛选诊断项目').selectOption(a.id);await row(environment.id).waitFor({state:'detached'});
    await row(own.id).waitFor();await page.screenshot({path:path.join(output,'02-read-history.png')});
    await panel.getByLabel('筛选诊断项目').selectOption('all');await panel.getByLabel('筛选诊断阅读状态').selectOption('unread');
    await row(other.id).getByRole('button',{name:'标记已读',exact:true}).click();await row(other.id).waitFor({state:'detached'});
    assert.equal(w.diagnostics.get({diagnosticId:other.id}).items[0].status,'open');
  });
  await check('同类错误再次发生恢复未读，真实共享 CLI 自动读取并收起',async()=>{
    const again=await w.captureDiagnostic(new Error('QA project A failure'),{source:'qa',projectId:a.id});
    assert.equal(again.id,own.id);assert.equal(again.occurrences,2);
    await refresh();await row(own.id).waitFor();
    const cli=await run(process.execPath,[path.join(ROOT,'web/cli.mjs'),'call','aiui_project_refresh','--args',JSON.stringify({projectId:a.id})],{env:{...process.env,AIUI_WORKBENCH_HOME:home}});
    assert.equal(cli.code,0,cli.output);
    assert.deepEqual(JSON.parse(cli.output).sharedDiagnostics.items.map(item=>item.id),[own.id]);
    await refresh();await row(own.id).waitFor({state:'detached'});
    assert.equal(w.diagnostics.get({diagnosticId:own.id}).items[0].readBy,'CLI');
  });
  await check('MCP 报错直接带项目诊断与恢复步骤，并持久化已读状态',async()=>{
    const response=await mcp.callTool({name:'aiui_project_files',arguments:{projectId:a.id,action:'read',paths:['missing.ink']}});
    assert.equal(response.isError,true);const result=JSON.parse(response.content.find(item=>item.type==='text').text);
    const diagnostic=result.sharedDiagnostics.items.find(item=>item.id===result.diagnosticId);
    assert.equal(diagnostic.projectPath,a.projectPath);assert.ok(diagnostic.recovery.steps.length);assert.ok(diagnostic.readAt);
    assert.equal(w.diagnostics.get({status:'open',read:false}).items.length,0);
    await refresh();await panel.getByText('目前没有未读问题。',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'03-auto-hidden.png')});
    const window=await app.browserWindow(page);await window.evaluate(window=>window.setSize(1080,740));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  });
  await check('英文筛选与空状态正确显示',async()=>{
    await page.getByRole('button',{name:'Switch to English',exact:true}).click();
    await panel.getByLabel('Filter diagnostics by project').waitFor();
    await panel.getByText('There are no unread issues.',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'04-en-minimum-window.png')});
  });
  await app.close();app=null;await mcp.close();mcp=null;await daemon.close();daemon=null;
  await check('重启后已读仍隐藏，原始错误和未修复状态仍可回查',async()=>{
    const restored=await new Workbench(home).init();
    try{assert.equal(restored.diagnostics.get({read:false,status:'open'}).items.length,0);assert.equal(restored.diagnostics.get({read:true,status:'open'}).items.length,4);}
    finally{await restored.close();}
  });
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;throw error;}
finally{
  await app?.close();await mcp?.close();await daemon?.close();
  await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));
}
