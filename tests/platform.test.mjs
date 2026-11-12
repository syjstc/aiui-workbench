import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync} from 'fflate';
import { Platform } from '../core/platform.mjs';
import { Jobs } from '../core/jobs.mjs';
import { sha } from '../core/util.mjs';
import { PLATFORM_API, md5, putMedia, codeDraftPath } from '../core/platform-http.mjs';
import { toolCatalog } from '../core/tool-catalog.mjs';
import { Workbench } from '../core/service.mjs';
import semver from 'semver';

function token(accountId='test-account') { return 'test.'+Buffer.from(JSON.stringify({accountId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature'; }
const success=data=>Response.json({code:0,msg:'success',data});
async function fixture(t) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'platform-test-')),bytes=Buffer.from(zipSync({'app.json':Buffer.from('{"name":"Fixture","pages":["index"]}'),'index.ink':Buffer.from('<page/>')})),file=path.join(home,'application.aix');await fs.writeFile(file,bytes);
  const project={id:'project-1',name:'Local temporary name',version:'0.5.6',permissions:[],revision:'source1',toolchainId:'sdk1',lastBuild:{path:file,sha256:sha(bytes),bytes:bytes.length,revision:'source1',toolchainId:'sdk1'},lastCheck:{passed:true,revision:'source1',toolchainId:'sdk1'}};
  const remote={agentId:'cloud-agent-123',agentName:'来捉我吧',modelVendor:'native',nativeVersion:'1.0.2',description:'Game',icon:'https://static.rokidcdn.com/icon.png',category:'entertainment',displayStatus:'草稿',fileMd5:'old',filePath:'https://static.rokidcdn.com/old.aix',previewMaterials:[{type:'image',url:'https://static.rokidcdn.com/a.png'},{type:'image',url:'https://static.rokidcdn.com/b.png'},{type:'video',url:'https://static.rokidcdn.com/c.mp4'}]};
  const requests=[],jobs=await new Jobs(()=>{},home).init(),w={home,jobs,emit:()=>{},projects:{refresh:async()=>project,save:async()=>{}},sdk:{}};
  let behavior='normal';
  const fetcher=async(url,options)=>{
    requests.push({url,options});
    if(url===PLATFORM_API.agents)return success({list:[structuredClone(remote)],total:1});
    if(url===PLATFORM_API.sts)return success({bucketName:'rokid-test',region:'oss-cn-hangzhou',accessKey:'access',secretKey:'secret',sessionToken:'sts',directory:'test-user/',cdnUrl:'https://static.rokidcdn.com/'});
    if(options.method==='PUT')return new Response(null,{headers:{etag:'"'+md5(options.body)+'"'}});
    if(url===PLATFORM_API.save){
      if(behavior==='disconnect')throw new Error('socket lost');
      const next=semver.inc(remote.nativeVersion,'patch');
      Object.assign(remote,JSON.parse(options.body));
      for(const key of ['versionLog','needParam','jsuiTools','jsuiTitle','jsuiVersion','jsuiPages'])delete remote[key];
      if(behavior==='source-changed-on-save')remote.codeFileMd5='another-source';
      if(behavior==='increment-on-save')remote.nativeVersion=next;
      if(behavior==='lost-response')throw new Error('response lost after write');
      return success({agentId:remote.agentId});
    }
    if(url===PLATFORM_API.review){remote.displayStatus='审核中';return success({publish_result:{'1024':{code:0,msg:'success'}}});}
    throw new Error('Unexpected URL '+url);
  };
  const platform=await new Platform(w,{fetcher}).init();w.platform=platform;platform.setSession(token(),'a'.repeat(64));platform.packageTools=()=>[{type:'function',target:'_blank',function:{name:'pages/game/index',parameters:{}}}];
  await platform.bind({projectId:project.id,agentId:remote.agentId});
  t.after(async()=>{await jobs.close();await fs.rm(home,{recursive:true,force:true});});
  return{platform,w,project,remote,requests,bytes,setBehavior:value=>behavior=value};
}
const desktopKey='a'.repeat(64);
const uploadArgs={projectId:'project-1',agentId:'cloud-agent-123'};

test('AIX upload preserves the selected cloud name, verifies actual bytes, and never calls review',async t=>{
  const f=await fixture(t),job=await f.platform.upload(uploadArgs);
  assert.equal(job.status,'succeeded');assert.equal(job.result.uploaded,true);assert.equal(job.result.agentName,'来捉我吧');assert.equal(job.result.version,'1.0.3');assert.equal(job.result.localVersion,'0.5.6');
  assert.equal(job.result.md5,md5(f.bytes));assert.equal(job.result.submittedForReview,false);assert.equal(job.result.published,false);
  assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.review).length,0);
  const duplicate=await f.platform.upload(uploadArgs);assert.equal(duplicate.result.reused,true);assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.save).length,1);
  assert.equal(JSON.stringify(f.platform.status()).includes(token()),false);assert.equal((await fs.readFile(f.platform.file,'utf8')).includes(token()),false);
});
test('stale source, modified package and a foreign target all stop before the upload',async t=>{
  const f=await fixture(t);f.project.revision='source2';assert.equal((await f.platform.upload(uploadArgs)).status,'failed');f.project.revision='source1';
  await fs.writeFile(f.project.lastBuild.path,'changed');assert.equal((await f.platform.upload(uploadArgs)).status,'failed');await fs.writeFile(f.project.lastBuild.path,f.bytes);
  assert.equal((await f.platform.upload({...uploadArgs,agentId:'foreign-agent-123'})).status,'failed');assert.equal(f.requests.some(r=>r.url===PLATFORM_API.save),false);
});
test('a lost upload response reconciles by cloud MD5 without replaying the write',async t=>{
  const f=await fixture(t);f.setBehavior('lost-response');const job=await f.platform.upload(uploadArgs);
  assert.equal(job.status,'succeeded');assert.equal(job.result.stage,'verified');assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.save).length,1);
});
test('unknown upload outcome survives restart and blocks automatic retry',async t=>{
  const f=await fixture(t);f.setBehavior('disconnect');const job=await f.platform.upload(uploadArgs);
  assert.equal(job.status,'failed');assert.equal(job.result.stage,'unknown');
  const restarted=await new Platform(f.w,{fetcher:f.platform.fetcher}).init();restarted.setSession(token(),desktopKey);restarted.packageTools=f.platform.packageTools;
  assert.equal((await restarted.upload(uploadArgs)).status,'failed');assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.save).length,1);
  f.remote.fileMd5=job.result.md5;f.remote.nativeVersion=job.result.version;f.remote.codeFileMd5=job.result.sourceObject.md5;f.remote.filePath=job.result.packageObject.url;assert.equal((await restarted.reconcile(f.project.id)).uploads[0].stage,'verified');
});
test('two simultaneous requests cannot upload the same agent twice',async t=>{
  const f=await fixture(t),first=f.platform.upload({...uploadArgs,waitMs:0});
  await assert.rejects(f.platform.upload(uploadArgs),/已有/);const job=await first;await f.w.jobs.wait(job.id,2000);assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.save).length,1);
});
test('explicit recovery is bound to the same receipt and package and reuses verified OSS objects',async t=>{
  const f=await fixture(t);f.setBehavior('disconnect');const first=await f.platform.upload(uploadArgs);assert.equal(first.result.stage,'unknown');
  const puts=f.requests.filter(r=>r.options.method==='PUT').length;assert.equal(puts,2);
  const wrong=await f.platform.upload({...uploadArgs,resumeUploadId:'another-upload'});assert.equal(wrong.status,'failed');
  f.setBehavior('normal');const resumed=await f.platform.upload({...uploadArgs,resumeUploadId:first.result.id});assert.equal(resumed.status,'succeeded');assert.equal(resumed.result.id,first.result.id);assert.equal(resumed.result.codeDraftVerified,true);assert.equal(f.requests.filter(r=>r.options.method==='PUT').length,puts);
});
test('platform-generated metadata versions remain separate from local package versions',async t=>{
  const f=await fixture(t);f.setBehavior('increment-on-save');const uploaded=await f.platform.upload(uploadArgs);assert.equal(uploaded.result.version,'1.0.3');
  const prepared=await f.platform.prepareReview({projectId:f.project.id,description:'Game',prologue:'Start here',versionLog:'Startup decoding experiment'});assert.equal(prepared.status,'succeeded');assert.equal(prepared.result.version,'1.0.4');assert.equal(f.remote.fileMd5,uploaded.result.md5);
});
test('official checking codes and highest review status protect an in-review package from upload',async t=>{
  const f=await fixture(t);
  for(const status of ['checking','up_checking','checking_down']){f.remote.displayStatus=status;assert.equal((await f.platform.upload(uploadArgs)).status,'failed');}
  f.remote.displayStatus='up';f.remote.highestStatus=0;assert.equal((await f.platform.upload(uploadArgs)).status,'failed');assert.equal(f.requests.some(r=>r.url===PLATFORM_API.save),false);
});
test('review materials save as draft; MCP request cannot submit; native confirmation is bound to content',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);
  const prepared=await f.platform.prepareReview({projectId:f.project.id,description:'Updated game description',prologue:'来星庭捕捉精灵',versionLog:'优化素材解码，启动性能待真机验证'});
  assert.equal(prepared.status,'succeeded');assert.equal(prepared.result.stage,'ready');
  assert.equal(JSON.parse(f.requests.filter(r=>r.url===PLATFORM_API.save).at(-1).options.body).permissionsDesc,'{}');
  const requested=await f.platform.requestReview({projectId:f.project.id,draftId:prepared.result.id,confirm:true});assert.equal(requested.stage,'awaiting-user');assert.equal(requested.requiresUserConfirmation,true);
  assert.equal(f.requests.some(r=>r.url===PLATFORM_API.review),false);
  const draft=f.platform.confirmation(f.project.id,requested.id,desktopKey);
  await assert.rejects(f.platform.submitConfirmed({projectId:f.project.id,draftId:draft.id,digest:'different',desktopKey,approvalId:draft.approvalId}),/已失效/);
  const fresh=f.platform.confirmation(f.project.id,requested.id,desktopKey);
  const job=await f.platform.submitConfirmed({projectId:f.project.id,draftId:draft.id,digest:draft.digest,desktopKey,approvalId:fresh.approvalId}),done=await f.w.jobs.wait(job.id,2000);
  assert.equal(done.result.submittedForReview,true);assert.equal(done.result.published,false);assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.review).length,1);
  await assert.rejects(f.platform.submitConfirmed({projectId:f.project.id,draftId:draft.id,digest:draft.digest,desktopKey,approvalId:fresh.approvalId}));
});
test('a concurrent cloud edit invalidates the prepared user confirmation',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);
  const job=await f.platform.prepareReview({projectId:f.project.id,description:'Game',prologue:'Start here',versionLog:'Startup decoding experiment'});
  f.remote.description='Edited by another browser';await assert.rejects(f.platform.requestReview({projectId:f.project.id,draftId:job.result.id}),/已变化/);assert.equal(f.requests.some(r=>r.url===PLATFORM_API.review),false);
});
test('a source-draft change during material save cannot become a confirmable review',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);f.setBehavior('source-changed-on-save');
  const job=await f.platform.prepareReview({projectId:f.project.id,description:'Game',prologue:'Start here',versionLog:'Startup decoding experiment'});
  assert.equal(job.status,'failed');assert.match(job.error,/代码草稿已变化/);assert.equal(f.platform.status().reviews[0].stage,'unknown');
  await assert.rejects(f.platform.requestReview({projectId:f.project.id,draftId:f.platform.status().reviews[0].id}),/不可用/);assert.equal(f.requests.some(r=>r.url===PLATFORM_API.review),false);
});
test('a lost material-save response reconciles without another save and binds local-only release notes',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);f.setBehavior('lost-response');
  const args={projectId:f.project.id,description:'Game',prologue:'Start here',versionLog:'Startup decoding experiment'},job=await f.platform.prepareReview(args);assert.equal(job.status,'failed');
  const saves=f.requests.filter(r=>r.url===PLATFORM_API.save).length;
  assert.equal((await f.platform.prepareReview(args)).status,'failed');assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.save).length,saves);
  const status=await f.platform.reconcile(f.project.id),draft=status.reviews[0];assert.equal(draft.stage,'ready');assert.deepEqual(draft.localOnlyFields,['versionLog','needParam']);assert.equal(draft.content.versionLog,args.versionLog);assert.equal(f.requests.filter(r=>r.url===PLATFORM_API.save).length,saves);
  await f.platform.requestReview({projectId:f.project.id,draftId:draft.id});f.platform.state.reviews[0].content.versionLog='Changed locally';
  await assert.rejects(f.platform.requestReview({projectId:f.project.id,draftId:draft.id}),/已变化/);assert.equal(f.requests.some(r=>r.url===PLATFORM_API.review),false);
});
test('rotating official source download signatures do not leak or invalidate review confirmation',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);
  const key=f.remote.codeFilePath;
  f.remote.codeFilePath='https://rokid-test.oss-cn-hangzhou.aliyuncs.com/'+key+'?Expires=1&Signature=first-secret';
  const listed=await f.platform.list();assert.equal(listed.agents[0].codeFilePath,key);assert.equal(JSON.stringify(listed).includes('first-secret'),false);
  const job=await f.platform.prepareReview({projectId:f.project.id,description:'Game',prologue:'Start here',versionLog:'Startup decoding experiment'});assert.equal(job.status,'succeeded');
  f.remote.codeFilePath='https://rokid-test.oss-cn-hangzhou.aliyuncs.com/'+key+'?Expires=2&Signature=second-secret';
  const requested=await f.platform.requestReview({projectId:f.project.id,draftId:job.result.id});assert.equal(requested.stage,'awaiting-user');assert.equal(JSON.stringify(requested).includes('secret'),false);
  for(const value of ['https://attacker.test/'+key+'?Signature=evil','https://user:pass@rokid-test.oss-cn-hangzhou.aliyuncs.com/'+key,key.replace(f.remote.agentId,'another-agent')])assert.throws(()=>codeDraftPath(value,f.remote.agentId));
});
test('session changes stop a mutation and public discovery exposes no confirmation bypass',async t=>{
  const f=await fixture(t),identity=f.platform.identity();f.platform.setSession(token('other-account'));assert.throws(()=>f.platform.current(identity),/已变化/);
  const catalog=toolCatalog();assert.equal(catalog.tools.some(t=>t.name.startsWith('ui_platform_')),false);assert.equal(catalog.tools.some(t=>t.name==='aiui_platform_review_submit'),false);
  const request=catalog.tools.find(t=>t.name==='aiui_platform_review_request');assert.equal(Object.hasOwn(request.inputSchema.properties,'confirm'),false);
  await assert.rejects(Workbench.prototype.call.call({...f.w,clients:new Map()},'ui_platform_review_submit',{},'MCP'),/桌面用户确认/);
  await assert.rejects(Workbench.prototype.call.call({...f.w,clients:new Map()},'ui_platform_review_submit',{projectId:f.project.id,draftId:'forged',digest:'forged'},'desktop-confirmation'),/原生确认窗口/);
  f.platform.session.syncedAt=Date.now()-46000;assert.equal(f.platform.status().loggedIn,false);assert.throws(()=>f.platform.identity(),/保持工坊运行/);
});
test('official timestamp tokens authenticate with their cookie expiry without inventing an exp claim',async t=>{
  const f=await fixture(t),official='fixture.'+Buffer.from(JSON.stringify({accountId:'test-account',timestamp:Date.now(),type:'session'})).toString('base64url')+'.signature';
  assert.equal(f.platform.setSession(official,desktopKey).loggedIn,false);assert.equal(f.platform.setSession(official,desktopKey,Date.now()+3600000).loggedIn,true);
});
test('sign-out revokes approval and running platform jobs, hides account records and preserves saved drafts',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);f.platform.approvals.set('pending',{accountId:'test-account'});
  const job=f.w.jobs.start('platform-review-prepare',f.project.id,async({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));
  const loggedOut=f.platform.setSession(null);assert.equal(loggedOut.loggedIn,false);assert.deepEqual(loggedOut.uploads,[]);assert.deepEqual(loggedOut.reviews,[]);assert.equal(f.platform.approvals.size,0);assert.equal((await f.w.jobs.wait(job.id,1000)).status,'cancelled');
  await assert.rejects(f.platform.upload(uploadArgs),/登录/);assert.equal(f.platform.state.uploads[0].stage,'verified');f.platform.setSession(token(),desktopKey);assert.equal(f.platform.status().uploads[0].stage,'verified');
});
test('all mutations share one account-bound official target and MCP cannot change the binding',async t=>{
  const f=await fixture(t);assert.equal(f.platform.status(f.project.id).binding.agentId,f.remote.agentId);
  const wrong=await f.platform.upload({...uploadArgs,agentId:'another-cloud-agent'});assert.equal(wrong.status,'failed');assert.match(wrong.error,/不一致/);assert.equal(f.requests.some(r=>r.url===PLATFORM_API.sts),false);
  await assert.rejects(Workbench.prototype.call.call({...f.w,clients:new Map()},'ui_platform_bind',uploadArgs,'MCP'),/只能在工坊/);
});
test('legacy verified receipts restore only an unambiguous official binding',async t=>{
  const f=await fixture(t);await f.platform.upload(uploadArgs);f.platform.state.bindings=[];await f.platform.save();
  const migrated=await new Platform(f.w,{fetcher:f.platform.fetcher}).init();migrated.setSession(token(),desktopKey);assert.equal(migrated.status(f.project.id).binding.agentId,f.remote.agentId);
  migrated.state.bindings=[];migrated.state.uploads.push({...migrated.state.uploads[0],id:'another-receipt',agentId:'another-cloud-agent'});await migrated.save();
  const ambiguous=await new Platform(f.w,{fetcher:f.platform.fetcher}).init();ambiguous.setSession(token(),desktopKey);assert.equal(ambiguous.status(f.project.id).binding,null);
});
test('official listing is read-only and no cloud deletion endpoint or MCP operation is available',async t=>{
  const f=await fixture(t),listed=await f.platform.list();assert.equal(listed.agents[0].readOnly,true);assert.equal(listed.agents[0].canDelete,false);
  const before=f.requests.length;await assert.rejects(f.platform.request('delete',f.platform.identity(),{body:{agentId:f.remote.agentId}}),/不受支持/);assert.equal(f.requests.length,before);
  assert.equal(toolCatalog().tools.some(tool=>/^aiui_platform_.*(?:delete|remove|edit|bind)/.test(tool.name)),false);
});
test('media upload signs only the official scoped OSS destination and verifies the ETag',async()=>{
  const media={bytes:Buffer.from('media'),md5:md5(Buffer.from('media')),extension:'.png',mime:'image/png',type:'image'};
  const sts={bucketName:'rokid-test',region:'oss-cn-hangzhou',accessKey:'access',secretKey:'secret',sessionToken:'sts',directory:'test-user/',cdnUrl:'https://static.rokidcdn.com/'};
  const result=await putMedia(sts,media,{fetcher:async(url,options)=>{assert.match(url,/^https:\/\/rokid-test\.oss-cn-hangzhou\.aliyuncs\.com\/test-user\/workbench-/);assert.match(options.headers.Authorization,/^OSS access:/);assert.equal(options.headers['x-oss-security-token'],'sts');return new Response(null,{headers:{etag:'"'+media.md5+'"'}});}});
  assert.match(result.url,/static\.rokidcdn\.com/);assert.equal(JSON.stringify(result).includes('secret'),false);
  await assert.rejects(putMedia({...sts,cdnUrl:'https://attacker.test/'},media),/不可信/);
});
