// Public edge service. GitHub credentials are Worker secrets, never shipped in
// the desktop app. All public writes pass persistent quotas and a serialized queue.
const DAY=86400000,MAX_BYTES=120000;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const marker=key=>`<!-- aiui-workshop-feedback:${key} -->`;
const allowed=env=>String(env.ALLOWED_REPOSITORIES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const ready=env=>!!(env.RATE_LIMIT_SECRET&&(env.GITHUB_TOKEN||(env.GITHUB_APP_ID&&env.GITHUB_INSTALLATION_ID&&env.GITHUB_APP_PRIVATE_KEY)));
const fetcher=env=>env.FETCH||((...args)=>globalThis.fetch(...args));
const now=env=>env.NOW?.()??Date.now();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
async function body(request){
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))fail('JSON required',415);
  if(Number(request.headers.get('content-length'))>MAX_BYTES)fail('Report too large',413);
  const reader=request.body?.getReader();if(!reader)fail('Missing report');let length=0,parts=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES)fail('Report too large',413);parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
function validate(value,env){
  const keys=['requestId','digest','kind','repository','title','body','fingerprint'];
  if(!value||Object.keys(value).some(k=>!keys.includes(k)))fail('Unsupported report fields');
  if(!/^[a-f0-9-]{36}$/.test(value.requestId)||!/^([a-f0-9]{64})$/.test(value.digest)||!/^([a-f0-9]{64})$/.test(value.fingerprint))fail('Invalid report identity');
  if(!['workbench-bug','suggestion'].includes(value.kind)||!allowed(env).includes(value.repository?.toLowerCase()))fail('Repository or report type not allowed',403);
  if(typeof value.title!=='string'||value.title.length<5||value.title.length>200||/[\r\n]/.test(value.title)||typeof value.body!=='string'||value.body.length<40||value.body.length>30000)fail('Invalid report content');
  if(!value.title.startsWith(value.kind==='suggestion'?'[Suggestion] ':'[Workbench bug] '))fail('Invalid report category');
  // Reject obvious private content even if a modified client skips its preview
  // sanitizer. Text may link to documentation, but cannot notify arbitrary users
  // or embed remote pictures through our bot.
  if(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[a-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY|\/(?:Users|home)\/|[A-Za-z]:\\|\b\d{12,20}\b|@[a-z0-9]|!\[|<(?:img|video|iframe)\b)/i.test(value.title+'\n'+value.body))fail('Remove private identifiers, mentions and media before submitting',422);
  return value;
}
function issueLink(repo,value){return Number.isSafeInteger(value?.number)&&value.number>0&&typeof value.html_url==='string'&&value.html_url.toLowerCase()===`https://github.com/${repo}/issues/${value.number}`.toLowerCase()?{number:value.number,url:value.html_url}:null;}
let installation;
async function githubToken(env){
  if(env.GITHUB_TOKEN)return env.GITHUB_TOKEN;
  const cacheKey=[env.GITHUB_APP_ID,env.GITHUB_INSTALLATION_ID,...allowed(env)].join(':');
  if(installation?.key===cacheKey&&installation?.until>now(env))return installation.token;
  let phase='key-import';
  try{
  const encode=value=>btoa(typeof value==='string'?value:String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const seconds=Math.floor(now(env)/1000),header=encode(JSON.stringify({alg:'RS256',typ:'JWT'})),payload=encode(JSON.stringify({iat:seconds-60,exp:seconds+540,iss:String(env.GITHUB_APP_ID)}));
  const pem=env.GITHUB_APP_PRIVATE_KEY.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const data=header+'.'+payload,signature=new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(data)));
  phase='installation-token-request';
  // Workers supports manual/follow, not error. Reject non-2xx below instead of
  // following a redirect that could forward the Authorization header.
  const response=await fetcher(env)(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`,{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+data+'.'+encode(signature),Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'AIUI-Workshop-Feedback','X-GitHub-Api-Version':'2026-03-10'},body:JSON.stringify({repositories:allowed(env).map(repo=>repo.split('/')[1]),permissions:{issues:'write'}}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Object.assign(new Error('Bot authorization unavailable'),{status:503,httpStatus:response.status});phase='installation-token-parse';const value=await response.json();
  if(typeof value.token!=='string'||!Number.isFinite(Date.parse(value.expires_at))||value.permissions?.issues!=='write'||Object.keys(value.permissions).some(p=>!['issues','metadata'].includes(p)))fail('Invalid bot authorization',503);
  installation={key:cacheKey,token:value.token,until:Date.parse(value.expires_at)-60000};return installation.token;
  }catch(error){error.phase=error.phase||phase;throw error;}
}
async function github(env,method,route,data){
  const token=await githubToken(env);
  const response=await fetcher(env)('https://api.github.com'+route,{method,redirect:'manual',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'AIUI-Workshop-Feedback','X-GitHub-Api-Version':'2026-03-10'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Object.assign(new Error('GitHub request rejected'),{phase:'github-api',httpStatus:response.status,definitive:response.status>=400&&response.status<500});return response.json();
}
async function findIssue(env,record){
  for(let page=1;page<=3;page++){
    const issues=await github(env,'GET',`/repos/${record.repository}/issues?state=all&sort=created&direction=desc&per_page=50&page=${page}`);
    if(!Array.isArray(issues))fail('Invalid issue response',502);
    const found=issues.find(i=>!i.pull_request&&i.body?.includes(marker(record.fingerprint))&&issueLink(record.repository,i));
    if(found)return issueLink(record.repository,found);if(issues.length<50)break;
  }
  return null;
}

export class FeedbackQueue {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.pending=Promise.resolve();}
  fetch(request){const response=this.pending.then(async()=>{
    try{return await this.process(request);}catch(error){return json({error:error.status?error.message:'Feedback service temporarily unavailable'},error.status||503);}
  });this.pending=response.then(()=>{},()=>{});return response;}
  async process(request){
    const env=this.env,url=new URL(request.url),time=now(env);
    if(url.pathname==='/verify-installation'&&request.method==='POST'){
      const repository=allowed(env)[0];if(!repository||!env.GITHUB_APP_ID)fail('Installation verification unavailable',503);
      try{const repo=await github(env,'GET','/repos/'+repository);return json({ready:repo.has_issues===true&&!repo.archived&&!repo.disabled,repository,issuesWrite:true});}
      catch(error){const errorCode=/Illegal invocation/i.test(error.message)?'native-receiver':/AbortSignal|signal/i.test(error.message)?'abort-signal':/fetch|network/i.test(error.message)?'network':'other';return json({ready:false,phase:error.phase||'repository-check',httpStatus:error.httpStatus||null,errorType:error.name,errorCode},503);}
    }
    const state=await this.ctx.storage.get('state')||{records:[],attempts:[]};
    state.records=state.records.filter(r=>time-r.createdAt<30*DAY).slice(-500);state.attempts=state.attempts.filter(a=>time-a.at<DAY);
    const receipt=url.pathname.match(/^\/receipts\/([a-f0-9-]{36})$/);
    if(receipt&&request.method==='GET'){
      const record=state.records.find(r=>r.requestId===receipt[1]&&r.digest===url.searchParams.get('digest'));if(!record)fail('Receipt not found',404);
      if(['submitting','unknown'].includes(record.stage)&&(!record.checkedAt||time-record.checkedAt>30000)){
        record.checkedAt=time;record.stage='unknown';
        try{const issue=await findIssue(env,record);if(issue)Object.assign(record,{stage:'submitted',issue});}catch{}
        await this.ctx.storage.put('state',state);
      }
      return json({stage:record.stage==='submitting'?'unknown':record.stage,issue:record.issue||null});
    }
    if(url.pathname!=='/submit'||request.method!=='POST')fail('Not found',404);
    const envelope=await request.json(),value=validate(envelope.report,env),repository=value.repository;
    const targetIdentity=await hash(JSON.stringify(['github',repository.toLowerCase()]));
    if(await hash(JSON.stringify([value.title,value.body,targetIdentity]))!==value.digest)fail('Report changed since preview',409);
    const previous=state.records.find(r=>r.requestId===value.requestId);
    if(previous){if(previous.digest!==value.digest)fail('Report identity conflict',409);return json({stage:previous.stage==='submitting'?'unknown':previous.stage,issue:previous.issue||null});}
    const publicBody=value.body.replace(/<!--\s*aiui-workshop-feedback:[\s\S]*?-->/gi,'').trim();
    const fingerprint=await hash(JSON.stringify([repository.toLowerCase(),value.kind,value.title,publicBody]));
    const duplicate=state.records.find(r=>r.fingerprint===fingerprint&&r.issue);if(duplicate)return json({stage:'duplicate',issue:duplicate.issue});
    const ipKey=await hash(env.RATE_LIMIT_SECRET+'\n'+envelope.ip),ipAttempts=state.attempts.filter(a=>a.ipKey===ipKey);
    if(state.attempts.length>=10||ipAttempts.length>=3||ipAttempts.some(a=>time-a.at<60000))fail('Feedback rate limit reached',429);
    // Reserve quota before any GitHub request, including reads. Invalid or
    // repeated upstream failures must not provide an unlimited API proxy.
    state.attempts.push({ipKey,at:time});await this.ctx.storage.put('state',state);
    const record={requestId:value.requestId,digest:value.digest,repository,fingerprint,createdAt:time,stage:'draft'};
    const existing=await findIssue(env,record);if(existing){Object.assign(record,{stage:'duplicate',issue:existing});state.records.push(record);await this.ctx.storage.put('state',state);return json({stage:record.stage,issue:record.issue});}
    const repo=await github(env,'GET',`/repos/${repository}`);if(repo.has_issues!==true||repo.archived||repo.disabled)fail('Repository does not accept issues',409);
    // Quota and uncertain-write state survive Worker restarts. No POST retry.
    record.stage='submitting';state.records.push(record);await this.ctx.storage.put('state',state);
    try{
      const posted=await github(env,'POST',`/repos/${repository}/issues`,{title:value.title,body:publicBody+'\n\n'+marker(fingerprint)});
      const issue=issueLink(repository,posted);if(!issue)throw new Error('Unverified receipt');Object.assign(record,{stage:'submitted',issue});
    }catch(error){record.stage=error.definitive?'failed':'unknown';}
    await this.ctx.storage.put('state',state);return json({stage:record.stage,issue:record.issue||null});
  }
}

async function verifyDeploymentProbe(env,value){
  if(!/^\d{13}:[a-f0-9]{64}$/.test(value||''))return false;
  const [stamp,signature]=value.split(':');if(Math.abs(now(env)-Number(stamp))>60000)return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.RATE_LIMIT_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g),s=>parseInt(s,16)),new TextEncoder().encode(stamp));
}
export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url);
      if(url.pathname==='/health')return json({schemaVersion:1,ready:ready(env)});
      if(!ready(env))return json({error:'Feedback bot not configured'},503);
      if(url.pathname==='/config'&&request.method==='GET'){
        const repository=url.searchParams.get('repository');if(!allowed(env).includes(repository?.toLowerCase()))return json({error:'Repository not enabled'},403);
        return json({schemaVersion:1,repository});
      }
      const stub=env.FEEDBACK_QUEUE.get(env.FEEDBACK_QUEUE.idFromName('feedback'));
      if(url.pathname==='/deployment-check'&&request.method==='POST'){
        if(!await verifyDeploymentProbe(env,request.headers.get('x-feedback-probe')))return json({error:'Not found'},404);
        return stub.fetch(new Request(url.origin+'/verify-installation',{method:'POST'}));
      }
      if(url.pathname==='/submit'&&request.method==='POST'){
        const report=validate(await body(request),env);
        return stub.fetch(new Request(url.origin+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({report,ip:request.headers.get('cf-connecting-ip')||'unknown'})}));
      }
      if(/^\/receipts\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==='GET')return stub.fetch(request);
      return json({error:'Not found'},404);
    }catch(error){return json({error:error.status?error.message:'Feedback service temporarily unavailable'},error.status||503);}
  }
};
