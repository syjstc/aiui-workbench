import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon } from '../core/daemon.mjs';
import { PLATFORM_API, md5 } from '../core/platform-http.mjs';
import { ROOT, sleep } from '../core/util.mjs';

const home=path.join(ROOT,'.local/platform-qa',String(Date.now())),output=path.join(ROOT,'output/qa/platform');
await fs.mkdir(output,{recursive:true});
const report={realPlatform:false,productionUploaded:false,productionSubmitted:false,checks:[]};
let daemon,app,mcp;
const requests=[];
async function until(work){const end=Date.now()+20000;while(Date.now()<end){if(await work())return;await sleep(100);}throw new Error('QA timed out');}
async function tool(name,args={}){const response=await mcp.callTool({name,arguments:args},undefined,{timeout:65000}),value=JSON.parse(response.content.find(c=>c.type==='text').text);if(response.isError)throw new Error(JSON.stringify(value));return value;}
async function launch(){const app=await _electron.launch({args:[ROOT],cwd:ROOT,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});const page=await app.firstWindow();await page.route('https://static.rokidcdn.com/**',async route=>{if(route.request().url().endsWith('.png'))await route.fulfill({contentType:'image/png',body:await fs.readFile(path.join(ROOT,'assets/icon.png'))});else await route.abort();});await page.getByRole('button',{name:'切换到中文',exact:true}).click();return {app,page};}
try{
  daemon=await startDaemon(home);const service=daemon.service;await service.sdk.settings({autoCheck:false});
  const remote={agentId:'fixture-cloud-agent',agentName:'Platform QA',modelVendor:'native',nativeVersion:'1.0.0',description:'Example app',category:'entertainment',icon:'https://static.rokidcdn.com/qa.png',displayStatus:'草稿',filePath:'https://static.rokidcdn.com/qa-old.aix',fileMd5:'old',previewMaterials:[{type:'image',url:'https://static.rokidcdn.com/qa-1.png'},{type:'image',url:'https://static.rokidcdn.com/qa-2.png'},{type:'video',url:'https://static.rokidcdn.com/qa.mp4'}]};
  Object.assign(remote,{agentPrompt:'A QA-only intent description.',prologue:'Official greeting from the fixture.',permissions:'camera',permissionsDesc:JSON.stringify({camera:'Capture a photo for the demo.'})});
  service.platform.fetcher=async(url,options)=>{
    requests.push(url);
    const ok=data=>Response.json({code:0,msg:'success',data});
    if(url===PLATFORM_API.agents)return ok({list:[structuredClone(remote)],total:1});
    if(url===PLATFORM_API.sts)return ok({bucketName:'rokid-test',region:'oss-cn-hangzhou',accessKey:'access',secretKey:'secret',sessionToken:'sts',directory:'platform-qa/',cdnUrl:'https://static.rokidcdn.com/'});
    if(options.method==='PUT'){const bytes=Buffer.from(options.body);assert.equal(bytes[0],80);assert.equal(bytes[1],75);return new Response(null,{headers:{etag:'"'+md5(bytes)+'"'}});}
    if(url===PLATFORM_API.save){Object.assign(remote,JSON.parse(options.body));for(const key of ['versionLog','needParam','jsuiTools','jsuiTitle','jsuiVersion','jsuiPages'])delete remote[key];return ok({agentId:remote.agentId});}
    if(url===PLATFORM_API.review){remote.displayStatus='审核中';return ok({publish_result:{'1024':{code:0,msg:'success'}}});}
    throw new Error('Unexpected endpoint');
  };
  let page;({app,page}=await launch());
  await page.getByRole('button',{name:'构建与上传',exact:true}).click();await page.getByRole('button',{name:'登录官方平台',exact:true}).waitFor();
  await app.evaluate(({session})=>{session.fromPartition('rokid-studio-private').protocol.handle('https',()=>new Response('<h1>Isolated official login fixture</h1>',{headers:{'content-type':'text/html'}}));});
  await page.getByRole('button',{name:'登录官方平台',exact:true}).click();
  await until(()=>app.evaluate(({BrowserWindow,session})=>BrowserWindow.getAllWindows().some(window=>window.webContents.session===session.fromPartition('rokid-studio-private'))));
  report.checks.push('desktop shows upload and sign-in actions');
  const sessionToken='fixture.'+Buffer.from(JSON.stringify({accountId:'platform-qa-account',timestamp:Date.now(),iss:'fixture',type:'session'})).toString('base64url')+'.signature';
  const loginCompletedAt=Date.now();await app.evaluate(async({session},token)=>{await session.fromPartition('rokid-studio-private').cookies.set({url:'https://aiui.rokid.com/',name:'ROKID_ACCOUNT_SESSION',value:encodeURIComponent(token),secure:true,path:'/',expirationDate:Date.now()/1000+3600});},sessionToken);
  // Real IPC synchronizes the isolated official cookie, never a test-only tool.
  await page.getByRole('button',{name:'打开官方平台',exact:true}).waitFor({timeout:2000});report.loginUiSyncMs=Date.now()-loginCompletedAt;
  assert.equal(await app.evaluate(({BrowserWindow,session})=>BrowserWindow.getAllWindows().some(window=>window.webContents.session===session.fromPartition('rokid-studio-private'))),false);
  await page.getByRole('button',{name:'打开官方平台',exact:true}).click();await page.getByRole('button',{name:'刷新登录与云端结果',exact:true}).click();assert.equal(await app.evaluate(({BrowserWindow,session})=>BrowserWindow.getAllWindows().some(window=>window.webContents.session===session.fromPartition('rokid-studio-private'))),true);
  await app.evaluate(({BrowserWindow,session})=>{for(const window of BrowserWindow.getAllWindows())if(window.webContents.session===session.fromPartition('rokid-studio-private'))window.destroy();});report.checks.push('login cookie immediately updates the desktop and closes only the sign-in window; an explicit official management window remains open');
  const config=service.config().mcpServers['aiui-workbench'];mcp=new Client({name:'platform-qa',version:'1.0.0'});await mcp.connect(new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...config.env}}));
  const catalog=await mcp.listTools();for(const name of ['aiui_platform_upload','aiui_platform_review_prepare','aiui_platform_review_request'])assert.ok(catalog.tools.some(t=>t.name===name));assert.equal(catalog.tools.some(t=>t.name.includes('review_submit')||t.name==='ui_platform_session'),false);
  const directory=path.join(home,'example');await fs.cp(path.join(ROOT,'examples/hello-aiui'),directory,{recursive:true});const project=await tool('aiui_project_import',{directory});
  const build=await tool('aiui_project_build',{projectId:project.id});assert.equal(build.status,'succeeded');
  await page.getByRole('button',{name:'设置官方绑定',exact:true}).click();await page.getByRole('combobox',{name:'绑定官方智能体',exact:true}).selectOption(remote.agentId);await page.getByRole('button',{name:'保存官方绑定',exact:true}).click();await until(()=>service.platform.status(project.id).binding?.agentId===remote.agentId);
  assert.equal(await page.getByRole('combobox',{name:'选择应用',exact:true}).count(),1);assert.equal(await page.getByRole('combobox',{name:'上传目标智能体',exact:true}).count(),0);report.checks.push('one application selection and a saved account binding drive build, upload and review');
  const beforeRead=requests.filter(url=>url!==PLATFORM_API.agents).length;
  await page.getByRole('tab',{name:'官网应用',exact:true}).click();await page.getByRole('button',{name:'刷新官方状态',exact:true}).click();await page.getByRole('table').waitFor();
  await until(async()=>await page.locator('.official-app-summary img').evaluate(image=>image.naturalWidth>0));await page.locator('.official-agent-disclosure>summary').first().click();await page.getByText('A QA-only intent description.',{exact:true}).waitFor();await page.getByText('Capture a photo for the demo.',{exact:false}).waitFor();
  await app.evaluate(({clipboard})=>{globalThis.copiedOfficialId=null;clipboard.writeText=value=>{globalThis.copiedOfficialId=value;};});await page.locator('.official-app-summary').getByRole('button',{name:'复制官网 Agent ID '+remote.agentId,exact:true}).click();assert.equal(await app.evaluate(()=>globalThis.copiedOfficialId),remote.agentId);report.checks.push('official Agent IDs are fully visible in highlighted read-only panels and copy exactly');
  assert.equal(await page.getByRole('tabpanel').getByRole('textbox').count(),0);await page.getByRole('button',{name:'查看大图 1',exact:true}).click();await page.getByRole('dialog').waitFor();await until(async()=>await page.getByRole('dialog').getByRole('img').evaluate(image=>image.naturalWidth>0));await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);report.checks.push('official icons, full descriptions, intent, permission purposes and media are read only, and images enlarge without cloud writes');
  assert.equal(await page.getByRole('tabpanel').getByRole('button',{name:/删除|上传|提审|打包/}).count(),0);assert.equal(await page.getByRole('note',{name:'官方平台对接仍为实验功能',exact:true}).count(),1);assert.equal(requests.filter(url=>url!==PLATFORM_API.agents).length,beforeRead);await page.screenshot({path:path.join(output,'official-readonly-zh.png'),fullPage:true});
  await page.getByRole('tab',{name:'打包与上传',exact:true}).click();report.checks.push('official records use a separate read-only tab, with a shared experimental-interface warning and no deletion actions');
  const upload=await tool('aiui_platform_upload',{projectId:project.id,agentId:remote.agentId});assert.equal(upload.status,'succeeded');assert.equal(upload.result.uploaded,true);assert.equal(upload.result.agentName,remote.agentName);report.checks.push('stdio MCP uploads a real official AIX through the shared task service and verifies cloud digest');
  const prepared=await tool('aiui_platform_review_prepare',{projectId:project.id,description:'A reusable example app.',prologue:'Choose an example to begin.',versionLog:'Verified upload and user confirmation workflow.'});assert.equal(prepared.status,'succeeded');
  const requested=await tool('aiui_platform_review_request',{projectId:project.id,draftId:prepared.result.id,confirm:true});assert.equal(requested.requiresUserConfirmation,true);assert.equal(requests.filter(url=>url===PLATFORM_API.review).length,0);
  await page.getByRole('button',{name:'核对完成，确认提交审核',exact:true}).waitFor();await page.screenshot({path:path.join(output,'review-confirmation-zh.png'),fullPage:true});
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});await page.getByRole('button',{name:'核对完成，确认提交审核',exact:true}).click();await sleep(250);assert.equal(requests.filter(url=>url===PLATFORM_API.review).length,0);report.checks.push('MCP confirmation flags and cancelled native dialogs cannot submit review');
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async(_window,options)=>{if(options.defaultId!==0||!options.detail.includes('SHA256:'))throw new Error('Unsafe confirmation');return {response:1};};});
  await page.getByRole('button',{name:'核对完成，确认提交审核',exact:true}).click();await until(()=>service.platform.status(project.id).reviews[0].stage==='submitted');assert.equal(requests.filter(url=>url===PLATFORM_API.review).length,1);assert.equal(service.platform.status(project.id).reviews[0].published,false);report.checks.push('native IPC submits exactly once after a content-bound confirmation, without publishing');
  await page.getByRole('button',{name:'Switch to English',exact:true}).click();await page.getByRole('heading',{name:'Build & upload',exact:true}).waitFor();await page.screenshot({path:path.join(output,'upload-en.png'),fullPage:true});
  const encryption=await app.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text');
  await app.close();app=null;({app,page}=await launch());
  if(encryption){await until(()=>service.platform.status().loggedIn);report.checks.push('desktop restart restores the OS-encrypted official session without another sign-in');}
  const publicResult=JSON.stringify(await tool('aiui_platform_status',{projectId:project.id}));assert.equal(publicResult.includes(sessionToken),false);assert.equal((await fs.readFile(path.join(home,'jobs.json'),'utf8')).includes(sessionToken),false);report.checks.push('MCP results and persisted tasks contain no official session token');
  await page.getByRole('button',{name:'构建与上传',exact:true}).click();await page.getByRole('button',{name:'退出官方账号',exact:true}).click();await until(()=>!service.platform.status().loggedIn);
  assert.equal((await tool('aiui_platform_status',{projectId:project.id})).uploads.length,0);assert.equal((await tool('aiui_platform_status',{projectId:project.id})).reviews.length,0);await assert.rejects(fs.access(path.join(home,'official-session.enc')));
  const forbidden=await mcp.callTool({name:'aiui_platform_upload',arguments:{projectId:project.id,agentId:remote.agentId}});assert.equal(forbidden.isError,true);const beforeWait=requests.length;await sleep(5500);assert.equal(service.platform.status().loggedIn,false);assert.equal(requests.length,beforeWait);
  await app.close();app=null;({app,page}=await launch());assert.equal(service.platform.status().loggedIn,false);report.checks.push('native sign-out clears cookies and encrypted storage, blocks MCP writes and survives heartbeat and restart');
  report.passed=true;report.encryptedSessionPersistence=encryption;report.uploadReceipt=upload.result;report.reviewDraftId=prepared.result.id;console.log(JSON.stringify({passed:true,checks:report.checks,encryptedSessionPersistence:encryption}));
}catch(error){report.passed=false;report.error=error.message;throw error;}
finally{await mcp?.close();await app?.close();await daemon?.close();await fs.writeFile(path.join(output,'integration.json'),JSON.stringify(report,null,2));}
