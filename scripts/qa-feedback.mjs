import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {launchDesktop,closeDesktop} from './desktop-test.mjs';
import {startDaemon} from '../core/daemon.mjs';
import {startWeb} from '../web/server.mjs';
import {ROOT,atomicJson} from '../core/util.mjs';
import worker,{FeedbackQueue} from '../services/feedback/worker.mjs';

const home=await fs.mkdtemp('/tmp/aiui-feedback-ui-'),output=path.join(ROOT,'output/qa/feedback');await fs.mkdir(output,{recursive:true});
const report={checks:[],publicWrites:false,simulatedBot:true,errors:[]};
let daemon,app,browser,web,time=Date.now(),posts=0,stored,queue=Promise.resolve();
const repository='syjstc/aiui-workbench',origin='https://aiui-feedback-qa.example.workers.dev';
const ctx={storage:{get:async()=>structuredClone(stored),put:async(_key,value)=>{stored=structuredClone(value);}},blockConcurrencyWhile:fn=>{const promise=queue.then(fn,fn);queue=promise.catch(()=>{});return promise;}};
const issues=[];
const env={ALLOWED_REPOSITORIES:repository,RATE_LIMIT_SECRET:'test-hash-key',GITHUB_TOKEN:'test-server-only-token',NOW:()=>time,FETCH:async(url,opts={})=>{
  if(opts.method==='POST'){posts++;const payload=JSON.parse(opts.body),issue={number:posts+100,html_url:`https://github.com/${repository}/issues/${posts+100}`,body:payload.body};issues.push(issue);return Response.json(issue,{status:201});}
  if(url.includes('/issues?'))return Response.json(issues);return Response.json({has_issues:true});
}};
const durable=new FeedbackQueue(ctx,env);env.FEEDBACK_QUEUE={idFromName:()=>1,get:()=>({fetch:r=>durable.fetch(r)})};
async function fill(page,kind='workbench-bug'){
  await page.getByLabel('反馈类型',{exact:true}).selectOption(kind);
  await page.getByLabel('反馈标题',{exact:true}).fill(kind==='suggestion'?'希望改进工坊文档搜索体验':'工坊预览在重新打开后没有响应');
  await page.getByLabel('详细描述',{exact:true}).fill('这是用于隔离测试的工坊反馈，描述重新打开预览时的界面现象和预期行为。测试邮箱 qa@example.test，设备 serial=1234567890123456。');
  await page.getByRole('button',{name:'生成反馈预览',exact:true}).click();
  const preview=page.getByRole('region',{name:'公开内容预览'});await preview.waitFor();
  assert.equal((await preview.innerText()).includes('qa@example.test'),false);assert.equal((await preview.innerText()).includes('1234567890123456'),false);
  return preview;
}
try{
  await atomicJson(path.join(home,'app-updates.json'),{source:'github',autoCheck:false,sources:{github:{repository}}});
  daemon=await startDaemon(home);daemon.service.sdk.check=async()=>daemon.service.sdk.status();daemon.service.knowledge.sync=async()=>daemon.service.knowledge.status();
  daemon.service.feedback.serviceUrl=origin;daemon.service.feedback.now=()=>time;
  daemon.service.feedback.fetcher=(url,opts={})=>worker.fetch(new Request(url,opts),env);
  app=await launchDesktop({args:[ROOT],cwd:ROOT,env:{...process.env,AIUI_WORKBENCH_HOME:home,ELECTRON_RUN_AS_NODE:''}});
  const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));
  await page.getByRole('button',{name:'切换到中文',exact:true}).click();
  await page.locator('.sidebar').getByRole('button',{name:'连接 AI 工具',exact:true}).click();
  await page.getByRole('heading',{name:'复制连接指令，发给 AI',exact:true}).waitFor();
  assert.equal(await page.locator('.connect-command blockquote').count(),0);
  assert.equal(await page.getByText('连接 AIUI 工坊，准备好开发环境，然后问我想做什么。',{exact:true}).count(),0);
  const idea='验证完整连接指令并保留已有项目';await page.locator('#setup-idea').fill(idea);
  const originalClipboard=await app.evaluate(({clipboard})=>clipboard.readText());let copiedText;
  try{
    await page.getByRole('button',{name:'复制完整连接指令',exact:true}).click();
    copiedText=await app.evaluate(({clipboard})=>clipboard.readText());
    assert.ok(copiedText.includes(JSON.stringify(daemon.service.config(),null,2)));assert.ok(copiedText.includes(idea));assert.match(copiedText,/setup=true/);
  }finally{await app.evaluate(({clipboard},{original,copied})=>{if(clipboard.readText()===copied)clipboard.writeText(original);},{original:originalClipboard,copied:copiedText});}
  await page.getByRole('button',{name:'已复制，去 AI 工具粘贴',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'connect-copy-zh.png'),fullPage:true});
  await page.getByRole('button',{name:'Switch to English',exact:true}).click();await page.getByRole('heading',{name:'Copy the setup request for your AI',exact:true}).waitFor();
  await page.getByRole('button',{name:'Copied. Paste into your AI tool',exact:true}).waitFor();await page.getByRole('button',{name:'切换到中文',exact:true}).click();
  report.checks.push('connection: button copies full local MCP configuration and optional idea; ambiguous short quote hidden in both languages');
  await page.getByRole('button',{name:'反馈与建议',exact:true}).click();await page.getByRole('heading',{name:'统一反馈机器人',exact:true}).waitFor();
  assert.equal(await page.locator('input[type=password]').count(),0);
  const title=page.getByLabel('反馈标题',{exact:true}),description=page.getByLabel('详细描述',{exact:true}),prepare=page.getByRole('button',{name:'生成反馈预览',exact:true});
  await title.fill('测试');await description.fill('测试'.repeat(25));assert.equal(await prepare.isEnabled(),true);await prepare.click();
  await page.getByText('反馈标题至少需要 5 个字符',{exact:true}).waitFor();assert.equal(await title.evaluate(e=>e===document.activeElement),true);assert.equal(posts,0);
  await page.screenshot({path:path.join(output,'validation-title-zh.png'),fullPage:true});
  await title.fill('工坊反馈按钮无法点击');await description.fill('太短');await prepare.click();
  await page.getByText('详细描述至少需要 20 个字符',{exact:true}).waitFor();assert.equal(await description.evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.getByText('反馈标题至少需要 5 个字符',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Switch to English',exact:true}).click();await page.getByText('Description must contain at least 20 characters',{exact:true}).waitFor();
  await page.getByRole('button',{name:'切换到中文',exact:true}).click();report.checks.push('desktop: invalid short title/description show inline errors and focus the field, with Chinese/English messages');
  const preview=await fill(page),submit=preview.getByRole('button',{name:'提交此反馈到 GitHub',exact:true});
  await page.waitForFunction(()=>!document.querySelector('.feedback-preview button.primary')?.disabled);
  assert.equal(await preview.locator('iframe').count(),0);
  const deleteDialog=page.getByRole('dialog',{name:'删除这条未提交反馈？',exact:true});
  await preview.getByRole('button',{name:'删除草稿',exact:true}).click();await deleteDialog.waitFor();await deleteDialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await preview.isVisible(),true);assert.equal(posts,0);
  await preview.getByRole('button',{name:'删除草稿',exact:true}).click();await deleteDialog.getByRole('button',{name:'删除草稿',exact:true}).click();
  await page.getByText('已删除未提交反馈',{exact:true}).waitFor();assert.equal(await preview.count(),0);assert.equal(posts,0);
  await page.getByRole('button',{name:'撤销删除',exact:true}).click();await preview.waitFor();
  assert.equal((await daemon.service.feedback.status()).records.length,1);
  report.checks.push('desktop: cancel/delete/undo unsubmitted draft without publishing, restoring its original content');
  await page.screenshot({path:path.join(output,'desktop-preview-zh.png'),fullPage:true});
  await submit.click();await preview.getByText('反馈已提交',{exact:true}).waitFor();assert.equal(posts,1);
  assert.equal(await preview.getByRole('button',{name:'删除草稿',exact:true}).count(),0);
  report.checks.push('desktop: sanitized preview, no personal GitHub credentials, no captcha, one bot submission and issue receipt');
  await page.getByRole('button',{name:'Switch to English',exact:true}).click();await page.getByRole('heading',{name:'Feedback & suggestions',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'desktop-submitted-en.png'),fullPage:true});report.checks.push('desktop: English feedback flow renders');
  await page.getByRole('button',{name:'切换到中文',exact:true}).click();time+=61000;
  await fill(page,'suggestion');
  await page.evaluate(()=>window.workbench.updates('settings',{sources:{github:{repository:'example/another-repository'}}}));
  await page.getByRole('button',{name:'刷新',exact:true}).click();await preview.getByText('更新源仓库已变化，请重新生成反馈预览',{exact:true}).waitFor();assert.equal(await submit.isDisabled(),true);assert.equal(posts,1);
  report.checks.push('desktop: changing update repository invalidates an existing preview');
  await page.evaluate(()=>window.workbench.updates('settings',{sources:{github:{repository:'syjstc/aiui-workbench'}}}));
  await closeDesktop(app);app=null;
  web=await startWeb({home,client:{connection:daemon.connection,call:(tool,args,actor)=>daemon.service.call(tool,args,actor)}});
  browser=await chromium.launch({executablePath:process.env.AIUI_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const webPage=await browser.newPage({viewport:{width:1300,height:960}});webPage.on('pageerror',e=>report.errors.push(e.message));
  await webPage.goto(web.url);await webPage.getByRole('button',{name:'切换到中文',exact:true}).click();await webPage.getByRole('button',{name:'反馈与建议',exact:true}).click();
  time+=61000;const suggestion=await fill(webPage,'suggestion');
  await suggestion.getByRole('button',{name:'删除草稿',exact:true}).click();await webPage.getByRole('dialog',{name:'删除这条未提交反馈？',exact:true}).getByRole('button',{name:'删除草稿',exact:true}).click();
  await webPage.getByText('已删除未提交反馈',{exact:true}).waitFor();assert.equal(posts,1);await webPage.getByRole('button',{name:'撤销删除',exact:true}).click();await suggestion.waitFor();
  report.checks.push('web: authenticated delete and undo use the same local draft lifecycle');
  const send=suggestion.getByRole('button',{name:'提交此反馈到 GitHub',exact:true});await webPage.waitForFunction(()=>!document.querySelector('.feedback-preview button.primary')?.disabled);await send.click();await suggestion.getByText('反馈已提交',{exact:true}).waitFor();assert.equal(posts,2);
  await webPage.screenshot({path:path.join(output,'web-submitted-zh.png'),fullPage:true});report.checks.push('web: authenticated local gateway submits through the same bot without GitHub login');
  assert.deepEqual(report.errors,[]);report.passed=true;report.botWrites=posts;
}catch(error){report.error=error.stack;throw error;}
finally{await browser?.close();await web?.close();await closeDesktop(app);await daemon?.close();await atomicJson(path.join(output,'verification.json'),report);await fs.rm(home,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));}
