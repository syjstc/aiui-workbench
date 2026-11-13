import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHmac} from 'node:crypto';
import {ROOT,readJson,atomicJson,homePath,sha} from '../core/util.mjs';
import {feedbackTarget} from '../core/feedback.mjs';

const output=path.join(ROOT,'output/qa/feedback'),config=path.join(ROOT,'services/feedback/wrangler.jsonc');
const registration=await readJson(path.join(output,'github-setup.json'),null);
if(!registration?.ready)throw new Error('Complete the local GitHub App setup first.');
const target=await feedbackTarget(homePath());
if(!target.supported||target.repository.toLowerCase()!==registration.repository.toLowerCase())throw new Error('The update repository changed. Verify the bot installation again.');
const secretFile=registration.secretFile,secrets=await readJson(secretFile);
if(!secrets.GITHUB_APP_ID||!secrets.GITHUB_INSTALLATION_ID||!secrets.GITHUB_APP_PRIVATE_KEY)throw new Error('The restricted GitHub App installation is incomplete.');

const npm=process.platform==='win32'?'npm.cmd':'npm';
function cli(args,{env={},input}={}){
  const result=spawnSync(npm,['exec','--cache',process.env.AIUI_FEEDBACK_NPM_CACHE||path.join(os.tmpdir(),'aiui-feedback-npm-cache'),'--yes','--package=wrangler','--','wrangler',...args],{cwd:ROOT,env:{...process.env,WRANGLER_SEND_METRICS:'false',...env},encoding:'utf8',input,maxBuffer:4*1024*1024});
  if(result.status!==0)throw new Error('Wrangler '+args[0]+' failed. '+(args[0]==='auth'?'Log in to Cloudflare first.':(result.stderr||result.stdout).slice(-3500)));
  return result.stdout;
}
// Capture credentials in memory. Never echo auth output or private API bodies.
let credential;
try{credential=JSON.parse(cli(['auth','token','--json']));}catch{throw new Error('Cloudflare authentication unavailable. Run Wrangler login first.');}
if(!credential.token)throw new Error('Cloudflare OAuth or API token is required.');
async function cf(route,{method='GET',body,allowMissing=false}={}){
  const response=await fetch('https://api.cloudflare.com/client/v4'+route,{method,redirect:'error',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const value=await response.json();if(allowMissing&&response.status===404)return null;
  if(!response.ok||!value.success)throw new Error(`Cloudflare ${method} failed: HTTP ${response.status}; codes ${(value.errors||[]).map(e=>e.code).join(',')}`);return value.result;
}
const accounts=await cf('/accounts');
const account=process.env.CLOUDFLARE_ACCOUNT_ID?accounts.find(a=>a.id===process.env.CLOUDFLARE_ACCOUNT_ID):accounts.length===1?accounts[0]:null;
if(!account)throw new Error('Select CLOUDFLARE_ACCOUNT_ID from: '+accounts.map(a=>a.id+' ('+a.name+')').join(', '));
const prefix='/accounts/'+account.id;
let domain=await cf(prefix+'/workers/subdomain',{allowMissing:true});
if(!domain?.subdomain)domain=await cf(prefix+'/workers/subdomain',{method:'PUT',body:{subdomain:'aiui-workshop-'+sha(account.id).slice(0,8)}});
if(!/^[a-z0-9-]+$/i.test(domain.subdomain))throw new Error('Unverified Workers subdomain.');
const workerConfig=JSON.parse(await fs.readFile(config,'utf8'));
workerConfig.vars.ALLOWED_REPOSITORIES=target.repository;await atomicJson(config,workerConfig);
const serviceUrl=`https://${workerConfig.name}.${domain.subdomain}.workers.dev`,hostname=new URL(serviceUrl).hostname;
console.log('Deploying the feedback Worker to '+hostname+' for '+target.repository);
cli(['deploy','--config',config],{env:{CLOUDFLARE_ACCOUNT_ID:account.id}});
Object.assign(secrets,{RATE_LIMIT_SECRET:secrets.RATE_LIMIT_SECRET||randomBytes(32).toString('hex')});
await fs.writeFile(secretFile,JSON.stringify(secrets),{mode:0o600});
console.log('Uploading bot and rate-limit secrets directly to Worker secret storage.');
cli(['secret','bulk','--config',config],{env:{CLOUDFLARE_ACCOUNT_ID:account.id},input:JSON.stringify(secrets)});
let health;
for(let n=0;n<6;n++){
  try{health=await fetch(serviceUrl+'/health',{signal:AbortSignal.timeout(10000)}).then(r=>r.json());if(health.ready)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
if(!health?.ready)throw new Error('Worker health is not ready. The client service URL has not been changed.');
const publicConfig=await fetch(serviceUrl+'/config?repository='+encodeURIComponent(target.repository),{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
if(publicConfig.repository!==target.repository)throw new Error('Public Worker configuration could not be verified.');
const stamp=String(Date.now()),probe=stamp+':'+createHmac('sha256',secrets.RATE_LIMIT_SECRET).update(stamp).digest('hex');
const botCheck=await fetch(serviceUrl+'/deployment-check',{method:'POST',redirect:'error',headers:{'x-feedback-probe':probe},signal:AbortSignal.timeout(20000)}).then(r=>r.json());
if(!botCheck.ready||!botCheck.issuesWrite||botCheck.repository!==target.repository.toLowerCase())throw new Error('Worker could not verify its restricted GitHub App token. No issue has been created.');
const rejected=await fetch(serviceUrl+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
if(rejected.status!==400)throw new Error('Worker did not reject an invalid report.');
await atomicJson(path.join(ROOT,'assets/feedback.json'),{schemaVersion:1,serviceUrl});
await atomicJson(path.join(output,'deployment.json'),{ready:true,serviceUrl,repository:target.repository,appUrl:registration.appUrl,checks:['health ready','repository verified; no captcha required','Worker GitHub App token and target repository verified without creating an issue','invalid report rejected'],publicIssuesCreated:0,workerSourceSha256:sha(await fs.readFile(path.join(ROOT,'services/feedback/worker.mjs'))),verifiedAt:new Date().toISOString()});
console.log('READY: '+serviceUrl+' — no public issues created during deployment.');
