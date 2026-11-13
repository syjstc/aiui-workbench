import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Feedback,feedbackTarget,publicFeedbackText} from '../core/feedback.mjs';
import {Diagnostics} from '../core/diagnostics.mjs';
import {atomicJson,sha} from '../core/util.mjs';
import {Workbench} from '../core/service.mjs';
import {toolCatalog} from '../core/tool-catalog.mjs';
import worker,{FeedbackQueue} from '../services/feedback/worker.mjs';
import {generateKeyPairSync,createHmac} from 'node:crypto';

const repository='syjstc/aiui-workbench',issue={number:12,url:`https://github.com/${repository}/issues/12`};
const input=(n='')=>({kind:'workbench-bug',title:'Workshop preview stops responding '+n,description:'The Workshop preview panel stops responding after reopening the same window. '+n,steps:'Open Workshop, close preview, reopen preview.',diagnosticIds:[]});
async function fixture(t,options={}){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-feedback-test-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const diagnostics=await new Diagnostics(home).init();t.after(()=>diagnostics.close());
  const feedback=await new Feedback(home,diagnostics,options).init();t.after(()=>feedback.close());return {home,diagnostics,feedback};
}

test('feedback follows the active saved update repository and never falls back from a different source',async t=>{
  const f=await fixture(t);assert.equal((await feedbackTarget(f.home)).repository,repository);
  const draft=await f.feedback.prepare(input());
  await atomicJson(path.join(f.home,'app-updates.json'),{source:'github',sources:{github:{repository:'example/alternate'}}});
  assert.equal((await feedbackTarget(f.home)).repository,'example/alternate');
  await assert.rejects(f.feedback.submit({draftId:draft.id,digest:draft.digest}),/仓库已变化/);
  await atomicJson(path.join(f.home,'app-updates.json'),{source:'custom',sources:{custom:{manifestUrl:'https://example.test/update.json'}}});
  assert.equal((await feedbackTarget(f.home)).supported,false);await assert.rejects(f.feedback.prepare(input()),/不会改投/);
});

test('a damaged feedback history preserves original bytes and does not disable Workshop startup',async t=>{
  const f=await fixture(t);await fs.writeFile(f.feedback.file,'{broken history');
  const recovered=await new Feedback(f.home,f.diagnostics).init();assert.deepEqual(recovered.records,[]);
  const backup=(await fs.readdir(f.home)).find(name=>name.startsWith('feedback.json.backup-'));
  assert.equal(await fs.readFile(path.join(f.home,backup),'utf8'),'{broken history');
  assert.equal((await recovered.prepare(input())).stage,'draft');await recovered.close();
});

test('public feedback contains selected Workshop evidence without project data, secrets, paths or mentions',async t=>{
  const f=await fixture(t),privatePath=path.join(os.homedir(),'Documents','private','scene.ink');
  const record=await f.diagnostics.record(new Error('Window failed '+privatePath),{source:'renderer',scope:'workbench',context:{files:['private source'],secret:'hidden'}});
  const draft=await f.feedback.prepare({...input(),description:'The Workshop failed with api_key=private-value and contact test@example.com. Device serial=1234567890123456. @someone ![photo](https://example.test/private.png)',diagnosticIds:[record.id]});
  for(const secret of ['private-value','test@example.com','1234567890123456','@someone','private.png','private source',privatePath])assert.equal(draft.body.includes(secret),false,secret);
  assert.ok(draft.body.includes('[redacted]'));assert.ok(draft.body.includes('renderer'));
  assert.deepEqual(await f.feedback.prepare({...input(),description:'The Workshop failed with api_key=private-value and contact test@example.com. Device serial=1234567890123456. @someone ![photo](https://example.test/private.png)',diagnosticIds:[record.id]}),draft);
  const app=await f.diagnostics.record(new Error('Syntax error in app'),{scope:'project',projectId:'app'});
  await assert.rejects(f.feedback.prepare({...input(),diagnosticIds:[app.id]}),/应用开发报错/);
  await assert.rejects(f.feedback.prepare({...input(),kind:'suggestion',diagnosticIds:[record.id]}),/无需附加/);
  assert.equal(publicFeedbackText('github_pat_'+('x'.repeat(30))).includes('github_pat_'),false);
});

test('only preparation and readback are public MCP tools; no credentials or issue publishing are exposed',async t=>{
  const f=await fixture(t),service=await new Workbench(path.join(f.home,'service')).init();t.after(()=>service.close());
  service.feedback.serviceUrl='';
  assert.deepEqual(toolCatalog().tools.filter(t=>t.name.includes('feedback')).map(t=>t.name).sort(),['aiui_feedback_prepare','aiui_feedback_status']);
  await assert.rejects(service.call('ui_feedback_submit',{draftId:'any',digest:'a'.repeat(64)},'MCP'),/反馈页面/);
  for(const name of ['ui_feedback_delete','ui_feedback_restore'])await assert.rejects(service.call(name,{draftId:'any',digest:'a'.repeat(64)},'MCP'),/反馈页面/);
  const draft=await service.call('aiui_feedback_prepare',input(),'MCP');assert.equal(draft.stage,'draft');
  assert.equal((await service.call('aiui_feedback_status',{},'MCP')).service.configured,false);
});

test('submission uses the reviewed draft once, preserves receipts, and enforces a local quota',async t=>{
  let time=Date.now(),posts=0;
  const f=await fixture(t,{now:()=>time,serviceUrl:'https://feedback.example.test',fetcher:async(_url,opts)=>{if(opts.method==='POST')posts++;return Response.json({stage:'submitted',issue});}});
  const draft=await f.feedback.prepare(input()),args={draftId:draft.id,digest:draft.digest};
  const values=await Promise.all([f.feedback.submit(args),f.feedback.submit(args)]);assert.equal(posts,1);assert.equal(values[0].issue.url,issue.url);
  await f.feedback.submit(args);assert.equal(posts,1);
  await assert.rejects(f.feedback.submit({...args,digest:'b'.repeat(64)}),/草稿已变化/);
  for(let n=1;n<=2;n++){time+=61000;const d=await f.feedback.prepare(input(n));await f.feedback.submit({draftId:d.id,digest:d.digest});}
  time+=61000;const last=await f.feedback.prepare(input(3));await assert.rejects(f.feedback.submit({draftId:last.id,digest:last.digest}),/每天最多三次/);assert.equal(posts,3);
});

test('a lost response or restarted in-flight write stays unknown and is reconciled without another POST',async t=>{
  let posts=0;
  const f=await fixture(t,{serviceUrl:'https://feedback.example.test',fetcher:async(_url,opts)=>{if(opts.method==='POST'){posts++;throw new Error('response lost');}return Response.json({stage:'submitted',issue});}});
  const draft=await f.feedback.prepare(input()),args={draftId:draft.id,digest:draft.digest};
  assert.equal((await f.feedback.submit(args)).stage,'unknown');await assert.rejects(f.feedback.submit(args),/不会重复创建/);
  assert.equal((await f.feedback.reconcile(args)).issue.url,issue.url);assert.equal(posts,1);
  const data=JSON.parse(await fs.readFile(f.feedback.file));data.records[0].stage='submitting';delete data.records[0].issue;await atomicJson(f.feedback.file,data);
  const reopened=await new Feedback(f.home,f.diagnostics).init();assert.equal(reopened.records[0].stage,'unknown');await reopened.close();
});

test('unsubmitted feedback can be deleted and restored locally, including after the update source changes',async t=>{
  const f=await fixture(t,{serviceUrl:''}),draft=await f.feedback.prepare(input()),other=await f.feedback.prepare(input('other'));
  const args={draftId:draft.id,digest:draft.digest};
  await atomicJson(path.join(f.home,'app-updates.json'),{source:'custom'});
  assert.equal((await f.feedback.deleteDraft(args)).deleted,true);
  assert.deepEqual((await f.feedback.status()).records.map(r=>r.id),[other.id]);assert.equal(f.feedback.summary().pending,1);
  await assert.rejects(f.feedback.submit(args),/草稿已删除/);
  await assert.rejects(f.feedback.deleteDraft({...args,digest:'f'.repeat(64)}),/草稿已变化/);
  const reopened=await new Feedback(f.home,f.diagnostics,{serviceUrl:''}).init();t.after(()=>reopened.close());
  assert.deepEqual((await reopened.status()).records.map(r=>r.id),[other.id]);
  assert.equal((await reopened.restoreDraft(args)).deletedAt,undefined);
  assert.equal((await reopened.status()).records.length,2);assert.equal(reopened.records.find(r=>r.id===draft.id).body,draft.body);
});

test('deleting failed feedback keeps submission quota and deleted drafts are not reused',async t=>{
  let time=Date.now();const f=await fixture(t,{now:()=>time,serviceUrl:'https://feedback.example.test',fetcher:async()=>Response.json({error:'invalid'},{status:422})});
  for(let n=0;n<3;n++){
    const draft=await f.feedback.prepare(input(n)),args={draftId:draft.id,digest:draft.digest};
    assert.equal((await f.feedback.submit(args)).stage,'failed');await f.feedback.deleteDraft(args);time+=61000;
  }
  const next=await f.feedback.prepare(input(0));assert.notEqual(next.id,f.feedback.records.find(r=>r.deletedAt)?.id);
  await assert.rejects(f.feedback.submit({draftId:next.id,digest:next.digest}),/每天最多三次/);
});

test('in-flight, unconfirmed and submitted feedback cannot be deleted',async t=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{serviceUrl:'https://feedback.example.test',fetcher:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});
  const draft=await f.feedback.prepare(input()),args={draftId:draft.id,digest:draft.digest},pending=f.feedback.submit(args);await ready;
  await assert.rejects(f.feedback.deleteDraft(args),/正在处理中/);release(Response.json({stage:'submitted',issue}));await pending;
  await assert.rejects(f.feedback.deleteDraft(args),/只能删除未提交/);
  const lost=await fixture(t,{serviceUrl:'https://feedback.example.test',fetcher:async()=>{throw new Error('response lost');}});
  const unknown=await lost.feedback.prepare(input()),unknownArgs={draftId:unknown.id,digest:unknown.digest};assert.equal((await lost.feedback.submit(unknownArgs)).stage,'unknown');
  await assert.rejects(lost.feedback.deleteDraft(unknownArgs),/先核对提交结果/);
});

function edge(){
  let time=Date.now(),stored,queue=Promise.resolve(),posts=0,lost=false;
  const published=[];
  const ctx={storage:{get:async()=>structuredClone(stored),put:async(_key,value)=>{stored=structuredClone(value);}},blockConcurrencyWhile:fn=>{const pending=queue.then(fn,fn);queue=pending.catch(()=>{});return pending;}};
  const env={ALLOWED_REPOSITORIES:repository,RATE_LIMIT_SECRET:'test-private-hash-key',GITHUB_TOKEN:'test-server-only-github-token',NOW:()=>time};
  env.FETCH=async(url,opts={})=>{
    assert.equal(opts.redirect,'manual','Worker upstream calls must never follow redirects or use unsupported error mode');
    assert.ok(url.startsWith('https://api.github.com/repos/'+repository));
    if(opts.method==='POST'){posts++;const content=JSON.parse(opts.body),value={number:12+posts,html_url:`https://github.com/${repository}/issues/${12+posts}`,body:content.body};published.push(value);if(lost)throw new Error('lost response');return Response.json(value,{status:201});}
    if(url.includes('/issues?'))return Response.json(published);
    return Response.json({has_issues:true,archived:false});
  };
  const durable=new FeedbackQueue(ctx,env);env.FEEDBACK_QUEUE={idFromName:()=>1,get:()=>({fetch:r=>durable.fetch(r)})};
  return {env,published,get posts(){return posts;},get stored(){return stored;},advance:()=>{time+=61000;},lose:()=>{lost=true;}};
}
const request=(value,ip='203.0.113.1')=>new Request('https://feedback.example.test/submit',{method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':ip},body:JSON.stringify(value)});
function report(n=0){
  const title='[Workbench bug] Preview panel failed '+n,body='## Workbench problem\n\nThe Workshop preview panel failed after reopening the window. '+n;
  return {requestId:crypto.randomUUID(),kind:'workbench-bug',repository,title,body,fingerprint:sha('report '+n),digest:sha(JSON.stringify([title,body,sha(JSON.stringify(['github',repository]))]))};
}

test('edge service submits without a captcha, limits repositories and deduplicates concurrent public writes',async()=>{
  const e=edge(),value=report();e.env.expectedDigest=value.digest;
  const config=await (await worker.fetch(new Request('https://feedback.example.test/config?repository='+repository),e.env)).json();assert.equal(config.siteKey,undefined);
  assert.equal((await worker.fetch(new Request('https://feedback.example.test/challenge?digest='+value.digest),e.env)).status,404);
  const results=await Promise.all([worker.fetch(request(value),e.env),worker.fetch(request(value),e.env)]);for(const r of results)assert.equal((await r.json()).stage,'submitted');assert.equal(e.posts,1);
  const duplicate={...value,requestId:crypto.randomUUID()};assert.equal((await (await worker.fetch(request(duplicate),e.env)).json()).stage,'duplicate');assert.equal(e.posts,1);
  assert.equal((await worker.fetch(request({...report(),repository:'other/project'}),e.env)).status,403);
  assert.equal((await worker.fetch(request({...report(),title:'[Workbench bug] @someone please respond'}),e.env)).status,422);
  assert.equal(JSON.stringify(e.stored).includes('203.0.113.1'),false);assert.equal(JSON.stringify(e.stored).includes(e.env.GITHUB_TOKEN),false);
});

test('edge quota is persistent and lost GitHub responses reconcile by marker without replay',async()=>{
  const e=edge();
  for(let n=0;n<3;n++){const value=report(n);e.env.expectedDigest=value.digest;assert.equal((await (await worker.fetch(request(value),e.env)).json()).stage,'submitted');e.advance();}
  const fourth=report(4);e.env.expectedDigest=fourth.digest;assert.equal((await worker.fetch(request(fourth),e.env)).status,429);assert.equal(e.posts,3);
  const lost=edge(),value=report();lost.env.expectedDigest=value.digest;lost.lose();
  assert.equal((await (await worker.fetch(request(value),lost.env)).json()).stage,'unknown');assert.equal(lost.posts,1);
  assert.equal((await (await worker.fetch(request(value),lost.env)).json()).stage,'unknown');assert.equal(lost.posts,1);
  const receipt=new Request(`https://feedback.example.test/receipts/${value.requestId}?digest=${value.digest}`);
  assert.equal((await (await worker.fetch(receipt,lost.env)).json()).stage,'submitted');assert.equal(lost.posts,1);
});

test('edge outbound calls preserve the native fetch receiver',async t=>{
  const e=edge(),value=report(),upstream=e.env.FETCH,original=globalThis.fetch;
  delete e.env.FETCH;e.env.expectedDigest=value.digest;
  globalThis.fetch=function(...args){assert.equal(this,globalThis);return upstream(...args);};
  t.after(()=>{globalThis.fetch=original;});
  assert.equal((await (await worker.fetch(request(value),e.env)).json()).stage,'submitted');assert.equal(e.posts,1);
});

test('an upstream redirect is rejected without following it or creating an issue',async()=>{
  const e=edge(),value=report(),requests=[];e.env.expectedDigest=value.digest;
  e.env.FETCH=async(url,options)=>{
    requests.push(url);assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{Location:'https://elsewhere.test/collect'}});
  };
  assert.equal((await worker.fetch(request(value),e.env)).status,503);
  assert.equal(requests.length,1);assert.equal(e.posts,0);assert.equal(e.stored.attempts.length,1);
  assert.equal((await worker.fetch(request(report(1)),e.env)).status,429);assert.equal(requests.length,1);
});

test('the GitHub App token is scoped to the allowlisted repository and issue writes',async()=>{
  const e=edge(),value=report(),requests=[];
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  delete e.env.GITHUB_TOKEN;
  Object.assign(e.env,{GITHUB_APP_ID:'100',GITHUB_INSTALLATION_ID:'200',GITHUB_APP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}).toString(),expectedDigest:value.digest});
  const upstream=e.env.FETCH;e.env.FETCH=async(url,options)=>{
    assert.equal(options.redirect,'manual');
    if(url.includes('/app/installations/')){requests.push(JSON.parse(options.body));assert.match(options.headers.Authorization,/^Bearer [^.]+\.[^.]+\.[^.]+$/);return Response.json({token:'test-installation-token',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{issues:'write',metadata:'read'}});}
    return upstream(url,options);
  };
  assert.equal((await (await worker.fetch(request(value),e.env)).json()).stage,'submitted');
  assert.deepEqual(requests,[{repositories:['aiui-workbench'],permissions:{issues:'write'}}]);
  assert.equal((await worker.fetch(new Request('https://feedback.example.test/deployment-check',{method:'POST'}),e.env)).status,404);
  const stamp=String(e.env.NOW()),signature=createHmac('sha256',e.env.RATE_LIMIT_SECRET).update(stamp).digest('hex');
  const verified=await worker.fetch(new Request('https://feedback.example.test/deployment-check',{method:'POST',headers:{'x-feedback-probe':stamp+':'+signature}}),e.env);
  assert.equal((await verified.json()).issuesWrite,true);assert.equal(e.posts,1);
});
