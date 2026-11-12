import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import semver from 'semver';
import {zipSync,unzipSync} from 'fflate';
import { setTimeout as pause } from 'node:timers/promises';
import { atomicJson, readJson, sha, id } from './util.mjs';
import { platformUploadSchema, platformReviewSchema, platformAgentId } from './platform-contract.mjs';
import { PLATFORM_API, businessOK, md5, mediaUrl, codeDraftPath, readMedia, putMedia } from './platform-http.mjs';

const require = createRequire(import.meta.url);
const contentFields = ['agentName','nativeVersion','description','agentPrompt','icon','category','categoryName','prologue','versionLog','permissions','permissionsDesc','needParam','previewMaterials','needUserAgree','jsuiTools','cutParamStr','widgets','filePath','fileMd5','codeFilePath','codeFileMd5','jsuiTitle','jsuiVersion','jsuiPages'];
const content = agent => Object.fromEntries(contentFields.filter(key => agent[key] !== undefined).map(key => [key, agent[key]]));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const fingerprint = value => sha(JSON.stringify(canonical(value)) ?? 'undefined');
const savedMaterialFields=['description','prologue','icon','previewMaterials','permissions','permissionsDesc'];
const publicUpload=({metadata,accountId,...record})=>({...record});
const publicReview=({accountId,...record})=>({...record});
const uncertain = (message, result) => Object.assign(new Error(message), { result });
const runningTypes = ['build','pack','check','platform-prepare','platform-upload','platform-review-prepare','platform-review-submit'];
const underReview=agent=>agent.highestStatus===0||/审核中|checking|reviewing|pending/i.test(agent.displayStatus||'');

export class Platform {
  constructor(workbench, { fetcher = fetch } = {}) { this.w = workbench; this.fetcher = fetcher; this.file = path.join(workbench.home, 'platform.json'); this.session = null; this.active = new Set(); this.reservations = new Set(); this.approvals=new Map();this.rejectedSessions=new Set(); }
  async init() {
    this.state = await readJson(this.file, { uploads: [], reviews: [] });
    this.state.bindings??=[];
    for(const upload of this.state.uploads.filter(item=>item.stage==='verified')){
      const peers=this.state.uploads.filter(item=>item.projectId===upload.projectId&&item.accountId===upload.accountId&&item.stage==='verified');
      if(new Set(peers.map(item=>item.agentId)).size===1&&!this.state.bindings.some(item=>item.projectId===upload.projectId&&item.accountId===upload.accountId))this.state.bindings.push({projectId:upload.projectId,accountId:upload.accountId,agentId:upload.agentId,agentName:upload.agentName,boundAt:upload.verifiedAt||upload.createdAt});
    }
    for (const item of [...this.state.uploads, ...this.state.reviews]) if (['dispatching','submitting'].includes(item.stage)) item.stage = 'unknown';
    return this;
  }
  async save() { const snapshot = structuredClone(this.state); this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => atomicJson(this.file, snapshot)); await this.saving; this.w.emit('platform', this.status()); }
  setSession(token, desktopKey, expiryHint) {
    // Sent only by the native desktop's isolated official-site cookie session.
    // Never persist credentials or return them through status, MCP, or logs.
    if (!token) {
      this.session=null;this.desktopKey=null;this.approvals.clear();
      for(const job of this.w.jobs.list())if(job.status==='running'&&['platform-upload','platform-review-prepare','platform-review-submit'].includes(job.type))this.w.jobs.cancel(job.id);
      const status=this.status();this.w.emit('platform',status);return status;
    }
    if(this.rejectedSessions.has(sha(token))){this.session=null;return {...this.status(),rejected:true};}
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('官方登录会话无效，请重新登录'); }
    const accountId = claims.accountId || claims.account_id;
    const declared=Number(claims.exp),hint=Number(expiryHint),expiries=[...(Number.isFinite(declared)&&declared>0?[declared*1000]:[]),...(Number.isFinite(hint)&&hint>0?[hint]:[])],expiresAt=expiries.length?Math.min(...expiries):0;
    if (typeof accountId !== 'string' || !accountId || expiresAt <= Date.now()) { this.session = null; return this.status(); }
    if (this.session?.token!==token || this.desktopKey!==desktopKey) this.approvals.clear();
    this.session = { token, accountId, expiresAt, syncedAt:Date.now() };
    this.desktopKey=/^[a-f0-9]{64}$/.test(desktopKey||'')?desktopKey:null;
    return this.status();
  }
  status(projectId) {
    const loggedIn = !!this.session && this.session.expiresAt > Date.now() && Date.now()-this.session.syncedAt<45000;
    const belongs=item=>loggedIn&&(!projectId||item.projectId===projectId)&&item.accountId===this.session.accountId;
    return { loggedIn, loginRequired: !loggedIn, loginVia: 'desktop-official-window', studioUrl: 'https://aiui.rokid.com/space',
      binding:loggedIn&&projectId?this.binding(projectId,this.session.accountId):null,
      uploads: (this.state?.uploads || []).filter(belongs).map(publicUpload),
      reviews: (this.state?.reviews || []).filter(belongs).map(publicReview),
      published: false, requiresUserConfirmation: true };
  }
  binding(projectId,accountId){const record=this.state.bindings.find(item=>item.projectId===projectId&&item.accountId===accountId);return record?publicReview(record):null;}
  requireBinding(projectId,agentId,identity){
    const binding=this.binding(projectId,identity.accountId);
    if(!binding)throw new Error('请先在工坊为此应用绑定官方智能体');
    if(binding.agentId!==agentId)throw new Error('目标与应用绑定的官方智能体不一致，已停止操作');
    return binding;
  }
  async bind(input){
    const args=platformUploadSchema.pick({projectId:true,agentId:true}).parse(input),identity=this.identity();
    this.guard(args.projectId,args.agentId);await this.w.projects.refresh(args.projectId);
    const target=await this.target(args.agentId,identity,AbortSignal.timeout(20000));this.current(identity);
    this.guard(args.projectId,args.agentId);
    const record={projectId:args.projectId,accountId:identity.accountId,agentId:target.agentId,agentName:target.agentName,boundAt:new Date().toISOString()};
    this.state.bindings=this.state.bindings.filter(item=>item.projectId!==args.projectId||item.accountId!==identity.accountId);this.state.bindings.push(record);this.approvals.clear();await this.save();return this.status(args.projectId);
  }
  identity() { if (!this.session || this.session.expiresAt <= Date.now() || Date.now()-this.session.syncedAt>=45000) throw new Error('请先在工坊的官方平台窗口登录 Rokid 账号，并保持工坊运行'); return { ...this.session }; }
  current(identity) { if (this.identity().accountId !== identity.accountId || this.session.token !== identity.token) throw new Error('官方账号或登录会话已变化，请重新核对目标后操作'); }
  headers(identity) { this.current(identity); return { Accept: 'application/json', Origin: 'https://aiui.rokid.com', 'X-Account-Token': identity.token, 'X-Account-ID': identity.accountId, 'X-Craft-Region': 'cn' }; }
  async request(endpoint, identity, { body, signal, stream = false } = {}) {
    if(!Object.hasOwn(PLATFORM_API,endpoint))throw new Error('此官方平台操作不受支持');
    this.current(identity);
    const multipart = body instanceof FormData;
    if(endpoint==='save'&&body?.codeFilePath){
      body={...body,codeFilePath:codeDraftPath(body.codeFilePath,body.agentId)};
    }
    const response = await this.fetcher(PLATFORM_API[endpoint], { method: 'POST', redirect: 'error', signal, headers: { ...this.headers(identity), ...!multipart ? { 'Content-Type':'application/json', access_token: identity.token } : {} }, body: multipart ? body : JSON.stringify(body ?? null) });
    this.current(identity);
    if ([401,403].includes(response.status)) { this.rejectedSessions.add(sha(identity.token)); if (this.session?.token === identity.token) this.session = null; throw new Error('官方登录已失效，请重新登录'); }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`官方平台请求失败：HTTP ${response.status}`),{httpStatus:response.status,rejected:response.status>=400&&response.status<500&&response.status!==408}); }
    if (stream) return response;
    let value;try{value=await response.json();}catch{throw new Error('官方平台返回了无效的 JSON，操作结果需要核对');}
    if ([1001,9001,8001,403].includes(value?.code)) { this.rejectedSessions.add(sha(identity.token)); if (this.session?.token === identity.token) this.session = null; throw new Error('官方登录已失效，请重新登录'); }
    const accepted=['agents','sts','review'].includes(endpoint)?value&&[0,1].includes(value.code):businessOK(value);
    if (!accepted) throw new Error('官方平台拒绝了操作，请检查账号、资料和版本');
    if(endpoint==='review'){
      const channel=value.data?.publish_result?.['1024'];
      if(!channel||channel.code!==0)throw new Error('官方平台尚未确认原生智能体提审结果，请核对平台状态');
    }
    return value.data;
  }
  async agents(identity = this.identity(), signal = AbortSignal.timeout(20000)) {
    const agents = [], seen = new Set(); let total;
    for (let pageNum = 1; pageNum <= 100; pageNum++) {
      const data = await this.request('agents', identity, { body: { pageNum, pageSize: 100 }, signal });
      if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('智能体列表格式无效，已停止远端操作');
      if (total !== undefined && total !== data.total) throw new Error('智能体列表正在变化，请刷新后重试');
      total = data.total;
      for (const agent of data.list) {
        if (!platformAgentId.safeParse(agent.agentId).success || seen.has(agent.agentId) || agent.modelVendor !== 'native') {
          if (agent.modelVendor !== 'native' && platformAgentId.safeParse(agent.agentId).success && !seen.has(agent.agentId)) { seen.add(agent.agentId); continue; }
          throw new Error('智能体列表包含缺失或重复身份，已停止远端操作');
        }
        if(agent.codeFilePath)agent.codeFilePath=codeDraftPath(agent.codeFilePath,agent.agentId);
        seen.add(agent.agentId); agents.push(agent);
      }
      if (seen.size >= total) { if (seen.size !== total) throw new Error('智能体总数不一致'); return agents; }
      if (!data.list.length) break;
    }
    throw new Error('智能体列表未完整加载，已停止远端操作');
  }
  async list() { return { agents: (await this.agents()).map(agent => ({ agentId: agent.agentId, ...content(agent), displayStatus: agent.displayStatus, status: agent.status,highestStatus:agent.highestStatus,reviewNativeVersion:agent.reviewNativeVersion,upNativeVersion:agent.upNativeVersion,underReview:underReview(agent),readOnly:true,canDelete:false })), ...this.status() }; }
  async target(agentId, identity, signal) { const target = (await this.agents(identity, signal)).find(agent => agent.agentId === agentId); if (!target) throw new Error('目标智能体不属于当前账号或已被移除'); return target; }
  guard(projectId, agentId) {
    if (this.reservations.has(projectId) || this.active.has(agentId) || this.w.jobs.list().some(job => job.projectId === projectId && job.status === 'running' && runningTypes.includes(job.type))) throw new Error('项目或目标智能体已有构建、上传或提审任务运行');
  }
  async artifact(projectId) {
    const p = await this.w.projects.refresh(projectId), a = p.lastBuild, c = p.lastCheck;
    if (!a || a.revision !== p.revision || a.toolchainId !== p.toolchainId || !c?.passed || c.stale || c.revision !== p.revision || c.toolchainId !== p.toolchainId) throw new Error('请先对当前源码和 SDK 执行检查并打包 AIX');
    const bytes = await fs.readFile(a.path);
    if (sha(bytes) !== a.sha256 || bytes.length !== a.bytes) throw new Error('AIX 文件已变化，请重新构建');
    return { p, a, bytes, md5: md5(bytes) };
  }
  packageTools(bytes, project) {
    const { AixReaderWasm } = require(path.join(path.dirname(this.w.sdk.cliPath(project.toolchainId)), 'pkg/aix_web.js'));
    const reader = new AixReaderWasm(new Uint8Array(bytes));
    try { return reader.get_tools(); } finally { reader.free(); }
  }
  async upload(input) {
    const args=platformUploadSchema.parse(input),identity=this.identity();this.guard(args.projectId,args.agentId);
    this.active.add(args.agentId);this.reservations.add(args.projectId);
    const job=this.w.jobs.start('platform-upload',args.projectId,async context=>{
      let attempt;
      try{
        this.requireBinding(args.projectId,args.agentId,identity);
        const {p,a,bytes,md5:digest}=await this.artifact(args.projectId),signal=AbortSignal.any([context.signal,AbortSignal.timeout(240000)]);
        const target=await this.target(args.agentId,identity,signal);
        if(underReview(target))throw new Error('目标智能体正在审核，暂不修改其草稿');
        const previous=this.state.uploads.find(item=>item.agentId===args.agentId&&item.accountId===identity.accountId&&['dispatching','unknown'].includes(item.stage));
        if(previous&&(!args.resumeUploadId||args.resumeUploadId!==previous.id||previous.projectId!==p.id||previous.sha256!==a.sha256||previous.md5!==digest))throw new Error('上次上传结果待确认，请先核对；显式恢复必须指定同一上传回执和同一 AIX');
        if(previous&&args.version&&args.version!==(previous.requestedVersion||previous.version))throw new Error('恢复时不能改变原上传版本');
        const last=this.state.uploads.find(item=>item.projectId===p.id&&item.accountId===identity.accountId&&item.agentId===args.agentId&&item.md5===digest&&item.stage==='verified');
        const version=args.version||previous?.requestedVersion||previous?.version||(last&&this.matches(last,target)?last.requestedVersion||last.version:semver.inc(target.nativeVersion||'1.0.0','patch'));
        const metadata=previous?.metadata||{agentId:target.agentId,agentName:target.agentName,version,description:args.description||target.description||p.description,iconUrl:mediaUrl(target.icon),category:args.category||target.category,permissions:p.permissions.join(','),tools:this.packageTools(bytes,p)};
        if(!metadata.agentName||!metadata.description||!metadata.category||!metadata.tools.length)throw new Error('目标草稿缺少名称、介绍、图标、分类或入口，请先完善');
        if(previous&&fingerprint(metadata)!==previous.metadataFingerprint)throw new Error('恢复参数与原上传不一致，已停止');
        if(last&&this.matches(last,target)&&fingerprint(metadata)===last.metadataFingerprint)return {...publicUpload(last),reused:true};
        if(previous&&this.matches(previous,target)){await this.verifiedUpload(previous,target,p,a);return {...publicUpload(previous),reconciled:true};}
        if(!version||!semver.valid(target.nativeVersion)||!semver.gt(version,target.nativeVersion))throw new Error('云端版本必须高于目标现有版本');
        attempt=previous||{id:id(),projectId:p.id,accountId:identity.accountId,agentId:target.agentId,agentName:target.agentName,version,requestedVersion:version,previousVersion:target.nativeVersion,localVersion:p.version,sourceRevision:p.revision,toolchainId:p.toolchainId,artifact:a.path,sha256:a.sha256,md5:digest,metadataFingerprint:fingerprint(metadata),stage:'prepared',uploaded:false,submittedForReview:false,published:false,createdAt:new Date().toISOString()};
        attempt.metadata=metadata;attempt.requestedVersion=version;attempt.previousVersion??=target.nativeVersion;attempt.stage='prepared';if(previous)attempt.resumedAt=new Date().toISOString();else this.state.uploads.unshift(attempt);await this.save();
        context.progress('获取官方资源上传凭证');const sts=await this.request('sts',identity,{signal});this.current(identity);
        if(!attempt.packageObject){context.progress('上传 AIX 资源并核对摘要');attempt.packageObject=await putMedia(sts,{bytes,md5:digest,extension:'.aix',mime:'application/octet-stream',type:'package'},{fetcher:this.fetcher,signal});await this.save();}
        if(!attempt.sourceObject){
          const entries=unzipSync(bytes),files=Object.fromEntries(Object.entries(entries).filter(([name])=>name!=='VERSION'&&!name.startsWith('META-INF/')&&!name.endsWith('/')));
          if(!files['app.json'])throw new Error('AIX 缺少应用清单，未保存云端草稿');
          const source=zipSync(files,{level:6}),old=String(target.codeFilePath||'').match(/-cache-v(\d+)-/),revision=(old?Number(old[1]):0)+1;
          if(!Number.isSafeInteger(revision))throw new Error('云端代码草稿版本无效');
          const timestamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),name=`${target.agentId}-cache-v${revision}-${timestamp}-${id().replaceAll('-','').slice(0,10)}.zip`,objectKey=sts.directory.replace(/\/$/,'')+'/cache/'+name;
          context.progress('上传与 AIX 一致的代码草稿');attempt.sourceObject=await putMedia(sts,{bytes:source,md5:md5(source),extension:'.zip',mime:'application/zip',type:'source'},{fetcher:this.fetcher,signal,objectKey});await this.save();
        }
        await this.artifact(p.id);this.current(identity);signal.throwIfAborted();
        const latest=await this.target(target.agentId,identity,signal);
        if(underReview(latest)||fingerprint(content(latest))!==fingerprint(content(target)))throw new Error('云端版本或资料已变化，请重新核对后上传');
        const tools=JSON.stringify(metadata.tools),payload={...content(target),agentId:target.agentId,modelVendor:'native',agentName:metadata.agentName,nativeVersion:version,description:metadata.description,icon:metadata.iconUrl,category:metadata.category,permissions:metadata.permissions,filePath:attempt.packageObject.url,fileMd5:digest,codeFilePath:attempt.sourceObject.objectKey,codeFileMd5:attempt.sourceObject.md5,jsuiTools:tools,cutParamStr:tools,jsuiTitle:p.name,jsuiVersion:p.version,jsuiPages:(p.pages||[]).map(route=>`Page title: , page path: ${route}`).join('\n')};
        attempt.stage='dispatching';await this.save();context.progress('保存云端草稿，不提交审核');let saveError;
        try{await this.request('save',identity,{body:payload,signal});}catch(error){saveError=error;}
        let verified;
        for(let i=0;i<5&&!signal.aborted;i++){try{const remote=await this.target(attempt.agentId,identity,signal);if(this.matches(attempt,remote)&&remote.codeFileMd5?.toLowerCase()===attempt.sourceObject.md5){verified=remote;break;}}catch{break;}if(i<4)await pause(800,undefined,{signal});}
        if(!verified)throw saveError||new Error('云端包或代码草稿尚未确认，请核对上传结果');
        await this.verifiedUpload(attempt,verified,p,a);context.progress('AIX 和代码草稿已上传并核对云端摘要');return publicUpload(attempt);
      }catch(error){
        if(attempt&&attempt.stage!=='verified'){attempt.stage=attempt.stage==='dispatching'&&!error.rejected?'unknown':'failed';attempt.diagnostic=error.httpStatus?`HTTP ${error.httpStatus}`:attempt.stage==='unknown'?'cloud-save-unconfirmed':'resource-or-preflight-failed';await this.save();}
        if(attempt)throw uncertain(attempt.stage==='unknown'?'上传结果待确认；请先核对云端，工坊不会自动重复上传':error.message,publicUpload(attempt));throw error;
      }finally{this.active.delete(args.agentId);this.reservations.delete(args.projectId);}
    });return this.w.jobs.wait(job.id,args.waitMs);
  }
  matches(attempt,remote){const version=remote.nativeVersion===attempt.version||attempt.previousVersion&&semver.valid(remote.nativeVersion)&&semver.valid(attempt.previousVersion)&&semver.gt(remote.nativeVersion,attempt.previousVersion);return remote.agentId===attempt.agentId&&remote.fileMd5?.toLowerCase()===attempt.md5&&version&&remote.agentName===attempt.agentName&&!!remote.filePath;}
  async verifiedUpload(attempt,remote,project,artifact){
    delete attempt.diagnostic;
    Object.assign(attempt,{stage:'verified',uploaded:true,version:remote.nativeVersion,verifiedAt:new Date().toISOString(),cloudStatus:remote.displayStatus||String(remote.status),filePath:mediaUrl(remote.filePath),codeDraftVerified:!!attempt.sourceObject&&remote.codeFileMd5?.toLowerCase()===attempt.sourceObject.md5});
    const current=await this.w.projects.refresh(project.id);attempt.stale=current.revision!==artifact.revision||current.toolchainId!==artifact.toolchainId;current.lastPlatformUpload=publicUpload(attempt);await this.w.projects.save();await this.save();
  }
  async reconcile(projectId) {
    const identity=this.identity();
    for (const attempt of this.state.uploads.filter(item => (!projectId || item.projectId===projectId) && item.accountId===identity.accountId && item.stage==='unknown')) {
      const remote=await this.target(attempt.agentId,identity,AbortSignal.timeout(20000));
      if (this.matches(attempt,remote)&&(!attempt.sourceObject||remote.codeFileMd5?.toLowerCase()===attempt.sourceObject.md5)) { attempt.stage='verified'; attempt.uploaded=true; attempt.version=remote.nativeVersion; attempt.verifiedAt=new Date().toISOString(); attempt.filePath=mediaUrl(remote.filePath);attempt.codeDraftVerified=!!attempt.sourceObject; }
      // A negative read cannot prove a timed-out mutation will never complete.
    }
    for(const draft of this.state.reviews.filter(item=>(!projectId||item.projectId===projectId)&&item.accountId===identity.accountId&&item.stage==='unknown'&&!item.confirmedAt)){
      const upload=this.state.uploads.find(item=>item.id===draft.uploadId&&item.accountId===identity.accountId&&item.stage==='verified');
      if(!upload)continue;
      try{
        const {p,a}=await this.artifact(draft.projectId);
        if(p.revision!==draft.sourceRevision||p.toolchainId!==draft.toolchainId||a.sha256!==draft.sha256)continue;
        const remote=await this.target(draft.agentId,identity,AbortSignal.timeout(20000));
        if(underReview(remote))continue;
        this.finishReviewDraft(draft,remote,upload);
      }catch{/* An unresolved draft stays blocked; reconciliation never writes remotely. */}
    }
    await this.save(); return this.status(projectId);
  }
  finishReviewDraft(draft,saved,upload){
    const expected=draft.content;
    for(const key of savedMaterialFields)if(fingerprint(saved[key])!==fingerprint(expected[key]))throw new Error('提审资料保存结果尚未确认');
    if(!this.matches({...upload,version:saved.nativeVersion},saved)||!semver.valid(saved.nativeVersion)||semver.lt(saved.nativeVersion,draft.version))throw new Error('保存资料期间云端包已变化');
    if(upload.sourceObject&&saved.codeFileMd5?.toLowerCase()!==upload.sourceObject.md5)throw new Error('保存资料期间云端代码草稿已变化');
    draft.localOnlyFields=['versionLog','needParam'].filter(key=>fingerprint(saved[key])!==fingerprint(expected[key]));
    draft.version=saved.nativeVersion;draft.cloudDigest=fingerprint(content(saved));
    draft.content={...content(saved),versionLog:expected.versionLog,needParam:expected.needParam};
    draft.digest=fingerprint({content:draft.content,cloudDigest:draft.cloudDigest});draft.stage='ready';draft.verifiedAt=new Date().toISOString();
  }
  async prepareReview(input) {
    const args=platformReviewSchema.parse(input), identity=this.identity();
    const binding=this.binding(args.projectId,identity.accountId);
    const upload=this.state.uploads.find(item=>item.projectId===args.projectId && item.accountId===identity.accountId && item.stage==='verified'&&item.agentId===binding?.agentId);
    if (!upload) throw new Error('请先上传并核对当前版本的 AIX 草稿');
    this.guard(args.projectId,upload.agentId); this.active.add(upload.agentId); this.reservations.add(args.projectId);
    const job=this.w.jobs.start('platform-review-prepare',args.projectId,async context=>{
      let draft;
      try {
        const signal=AbortSignal.any([context.signal,AbortSignal.timeout(360000)]), {p,a}=await this.artifact(args.projectId);
        if (a.sha256!==upload.sha256 || p.revision!==upload.sourceRevision) throw new Error('当前源码与已上传草稿不同，请重新上传');
        const remote=await this.target(upload.agentId,identity,signal);
        if(underReview(remote))throw new Error('目标智能体正在审核，暂不修改其草稿');
        this.noPreviousSubmission(upload.id,identity.accountId);
        if(this.state.reviews.some(item=>item.agentId===upload.agentId&&item.accountId===identity.accountId&&item.stage==='unknown'))throw new Error('上次提审资料保存结果待确认，请先刷新核对云端；不会自动重复保存');
        if (!this.matches({...upload,version:remote.nativeVersion},remote)||!semver.valid(remote.nativeVersion)||semver.lt(remote.nativeVersion,upload.version)) throw new Error('云端版本已变化，请重新上传或核对');
        if(upload.sourceObject&&remote.codeFileMd5?.toLowerCase()!==upload.sourceObject.md5)throw new Error('云端代码草稿已变化，请先核对');
        const files=args.previewFiles ? await Promise.all(args.previewFiles.map(file=>readMedia(file))) : null;
        if (files && (!files.some(file=>file.type==='image') || !files.some(file=>file.type==='video'))) throw new Error('预览素材至少需要一张图片和一个视频');
        const icon=args.iconFile ? await readMedia(args.iconFile,true) : null;
        const existing=remote.previewMaterials;
        if (!files && (!Array.isArray(existing) || existing.length<3 || existing.length>5 || !existing.some(m=>m.type==='image') || !existing.some(m=>m.type==='video'))) throw new Error('请提供 3–5 个预览文件，至少一张图片和一个视频');
        const permissions=Object.fromEntries(p.permissions.map(name=>{ if (!args.permissionUsage[name]) throw new Error('请为每项权限提供具体用途'); return [name,args.permissionUsage[name]]; }));
        const materials=[]; let iconUrl=mediaUrl(remote.icon);
        if (files || icon) {
          const sts=await this.request('sts',identity,{signal});
          for (const [index,file] of (files||[]).entries()) { this.current(identity); context.progress(`上传预览素材 ${index+1}/${files.length}`); materials.push(await putMedia(sts,file,{fetcher:this.fetcher,signal})); }
          if (icon) { this.current(identity); context.progress('上传应用图标'); iconUrl=(await putMedia(sts,icon,{fetcher:this.fetcher,signal})).url; }
        }
        const payload={...content(remote),agentId:remote.agentId,modelVendor:'native',description:args.description,prologue:args.prologue,versionLog:args.versionLog,icon:iconUrl,permissions:p.permissions.join(','),permissionsDesc:JSON.stringify(permissions),needParam:JSON.stringify(permissions),previewMaterials:(files?materials:existing).map(m=>({type:m.type,url:mediaUrl(m.url)}))};
        draft={id:id(),projectId:p.id,accountId:identity.accountId,agentId:remote.agentId,agentName:remote.agentName,version:remote.nativeVersion,sourceRevision:p.revision,toolchainId:p.toolchainId,sha256:upload.sha256,uploadId:upload.id,stage:'prepared',submittedForReview:false,published:false,createdAt:new Date().toISOString(),materials:materials.map(m=>({...m})),content:content(payload)};
        // Reject stale data before saving; do not overwrite concurrent edits.
        if (fingerprint(content(await this.target(upload.agentId,identity,signal)))!==fingerprint(content(remote))) throw new Error('云端资料已变化，请重新准备');
        await this.artifact(p.id); this.current(identity); signal.throwIfAborted();
        this.state.reviews.unshift(draft); draft.stage='dispatching'; await this.save();
        context.progress('保存提审资料草稿'); await this.request('save',identity,{body:payload,signal});
        const saved=await this.target(remote.agentId,identity,signal);
        this.finishReviewDraft(draft,saved,upload);await this.save();
        context.progress('提审草稿已保存，等待用户确认'); return {...publicReview(draft),requiresUserConfirmation:true};
      } catch(error) { if (draft) { draft.stage=draft.stage==='dispatching'?'unknown':'failed'; await this.save(); } throw error; }
      finally {this.active.delete(upload.agentId);this.reservations.delete(args.projectId);}
    });
    return this.w.jobs.wait(job.id,args.waitMs);
  }
  async requestReview({projectId,draftId}) {
    const draft=this.state.reviews.find(item=>item.id===draftId && item.projectId===projectId),identity=this.identity();
    if (!draft || draft.accountId!==identity.accountId || !['ready','awaiting-user'].includes(draft.stage)) throw new Error('提审草稿不可用或已提交，请重新准备');
    await this.validateReview(draft,identity);
    draft.stage='awaiting-user'; await this.save();
    return {...publicReview(draft),requiresUserConfirmation:true,message:'请用户在工坊核对资料并点击“确认提交审核”。MCP 无法代替用户确认。'};
  }
  async validateReview(draft,identity) {
    this.requireBinding(draft.projectId,draft.agentId,identity);
    this.noPreviousSubmission(draft.uploadId,identity.accountId);
    const {p,a}=await this.artifact(draft.projectId);
    if(p.revision!==draft.sourceRevision || p.toolchainId!==draft.toolchainId || a.sha256!==draft.sha256) throw new Error('源码、SDK 或 AIX 已变化，请重新上传并准备提审草稿');
    const remote=await this.target(draft.agentId,identity,AbortSignal.timeout(20000));
    if(underReview(remote))throw new Error('目标智能体已经在审核，请先核对官方状态');
    const localDigest=draft.cloudDigest?fingerprint({content:draft.content,cloudDigest:draft.cloudDigest}):fingerprint(draft.content);
    if (localDigest!==draft.digest||fingerprint(content(remote))!==(draft.cloudDigest||draft.digest)) throw new Error('本地提审材料或云端包及资料已变化，原确认已失效，请重新准备提审草稿');
  }
  noPreviousSubmission(uploadId,accountId){
    if(this.state.reviews.some(item=>item.uploadId===uploadId&&item.accountId===accountId&&(item.stage==='submitted'||item.stage==='submitting'||item.stage==='unknown'&&item.confirmedAt)))throw new Error('这一上传版本已提交或提交结果待确认，请先核对官方状态');
  }
  requireDesktop(key) {
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)||!this.desktopKey||!timingSafeEqual(Buffer.from(key),Buffer.from(this.desktopKey)))throw new Error('提审确认必须来自工坊的原生确认窗口');
  }
  confirmation(projectId,draftId,desktopKey) {
    this.requireDesktop(desktopKey);
    const identity=this.identity(),draft=this.state.reviews.find(item=>item.id===draftId && item.projectId===projectId && item.accountId===identity.accountId);
    if(!draft || draft.stage!=='awaiting-user') throw new Error('请先通过 MCP 请求提审，或在工坊请求确认');
    const approvalId=id();this.approvals.set(approvalId,{draftId:draft.id,digest:draft.digest,accountId:identity.accountId,expiresAt:Date.now()+5*60000});
    return {...structuredClone(draft),approvalId};
  }
  async submitConfirmed({projectId,draftId,digest,desktopKey,approvalId}) {
    this.requireDesktop(desktopKey);
    const identity=this.identity(),approval=this.approvals.get(approvalId);
    this.approvals.delete(approvalId);
    if(!approval||approval.expiresAt<Date.now()||approval.draftId!==draftId||approval.digest!==digest||approval.accountId!==identity.accountId)throw new Error('原生提审确认已失效，请重新核对并确认');
    const draft=this.state.reviews.find(item=>item.id===draftId&&item.projectId===projectId&&item.accountId===identity.accountId&&item.stage==='awaiting-user');
    if(!draft)throw new Error('提审草稿不可用或已提交');
    if(draft.digest!==digest) throw new Error('提审资料已变化，请重新确认');
    this.guard(projectId,draft.agentId);this.active.add(draft.agentId);this.reservations.add(projectId);
    return this.w.jobs.start('platform-review-submit',projectId,async context=>{
      const record=this.state.reviews.find(item=>item.id===draftId);
      try {
        await this.validateReview(draft,identity); context.signal.throwIfAborted();
        record.stage='submitting';record.confirmedAt=new Date().toISOString();await this.save();
        context.progress('用户已确认，正在提交审核');
        await this.request('review',identity,{body:{botId:draft.agentId,name:draft.agentName,description:draft.content.description,prompt:draft.content.agentPrompt||'',logo:draft.content.icon,needParam:draft.content.needParam||'{}',category:draft.content.category,categoryName:draft.content.categoryName||'',modelVendor:'native',prologue:draft.content.prologue||'',versionLog:draft.content.versionLog,suggestedQuestions:'',suggestedQuestionsShowMode:0,globalImageSize:0},signal:AbortSignal.any([context.signal,AbortSignal.timeout(45000)])});
        record.stage='submitted';record.submittedForReview=true;record.submittedAt=new Date().toISOString();
        try{const remote=await this.target(draft.agentId,identity,AbortSignal.timeout(10000));record.submittedVersion=remote.nativeVersion;record.cloudStatus=remote.displayStatus||String(remote.status);}catch{/* The accepted submission is not replayed if a status read fails. */}
        await this.save();
        context.progress('平台已接受提审请求，后续审核状态请以官方平台为准');return publicReview(record);
      }catch(error){if(record.stage==='submitting'){record.stage='unknown';await this.save();throw uncertain('提审结果待确认，请在官方平台核对；工坊不会自动再次提交',publicReview(record));}throw error;}
      finally{this.active.delete(draft.agentId);this.reservations.delete(projectId);}
    });
  }
}
