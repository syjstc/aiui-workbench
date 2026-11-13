// One-time, local GitHub App manifest flow. Private credentials are written only
// to a mode-0600 temporary file for the subsequent Worker secret upload.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createPrivateKey} from 'node:crypto';
import {feedbackTarget} from '../core/feedback.mjs';
import {homePath,ROOT,atomicJson} from '../core/util.mjs';

const target=await feedbackTarget(homePath());if(!target.supported)throw new Error(target.reason);
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-feedback-github-')),secretFile=path.join(directory,'worker-secrets.json');
const state=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
let base,app,secrets;
const html=(res,content,status=200)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'"});res.end(`<!doctype html><meta charset="utf-8"><title>AIUI Workshop · 反馈机器人</title><style>body{font:16px/1.8 system-ui;max-width:720px;margin:60px auto;padding:20px}button,a{font-size:16px}button{padding:12px 22px}</style>${content}`);};
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
async function appJwt(){
  const seconds=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),body=Buffer.from(JSON.stringify({iat:seconds-60,exp:seconds+540,iss:String(app.id)})).toString('base64url');
  const {sign}=await import('node:crypto');return header+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+body),secrets.GITHUB_APP_PRIVATE_KEY).toString('base64url');
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'||req.headers.host!==new URL(base).host)return html(res,'Invalid local request',403);
    const url=new URL(req.url,base);
    if(url.pathname==='/'&&url.searchParams.get('key')===key){
      const manifest={name:'AIUI Workshop Feedback '+target.repository.split('/')[0],url:'https://github.com/'+target.repository,description:'Submits reviewed AIUI Workshop problems and user suggestions. Issues write only.',hook_attributes:{url:'https://github.com/'+target.repository,active:false},redirect_url:base+'/callback',setup_url:base+'/installed?setup_key='+state,public:false,default_permissions:{issues:'write',metadata:'read'},default_events:[]};
      return html(res,`<h1>配置统一反馈机器人</h1><p>目标：<strong>${escape(target.repository)}</strong></p><p>下一页会创建一个私有 GitHub App，仅申请 <strong>Issues: Read & write</strong> 和必需的仓库基本信息读取权限。随后请只选择上述仓库安装。</p><p>机器人私钥将直接保存到本机临时文件，随后写入 Cloudflare Worker Secret，不进入客户端、聊天或源码仓库。</p><form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button type="submit">前往 GitHub 核对并创建机器人</button></form>`);
    }
    if(url.pathname==='/callback'){
      if(url.searchParams.get('state')!==state||!url.searchParams.get('code'))return html(res,'Invalid GitHub callback',403);
      const response=await fetch('https://api.github.com/app-manifests/'+encodeURIComponent(url.searchParams.get('code'))+'/conversions',{method:'POST',redirect:'error',headers:{Accept:'application/vnd.github+json','User-Agent':'AIUI-Workshop-Feedback-Setup','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('GitHub app registration failed: HTTP '+response.status);
      app=await response.json();if(!Number.isSafeInteger(app.id)||typeof app.pem!=='string'||!/^https:\/\/github\.com\/apps\/[a-z0-9-]+$/.test(app.html_url))throw new Error('Invalid GitHub App registration receipt');
      secrets={GITHUB_APP_ID:String(app.id),GITHUB_APP_PRIVATE_KEY:createPrivateKey(app.pem).export({type:'pkcs8',format:'pem'}).toString()};
      await fs.writeFile(secretFile,JSON.stringify(secrets),{mode:0o600});
      console.log('GitHub App created. Install only on '+target.repository+'. Private key retained locally.');
      return html(res,`<h1>机器人已创建</h1><p>继续安装时请选择 <strong>Only select repositories</strong>，仅勾选 <strong>${escape(target.repository)}</strong>。无需个人账号授权或代码权限。</p><p><a href="${app.html_url}/installations/new">前往 GitHub 选择目标仓库并安装</a></p>`);
    }
    if(url.pathname==='/installed'){
      const installation=url.searchParams.get('installation_id');
      if(url.searchParams.get('setup_key')!==state||!/^\d+$/.test(installation||'')||!app)return html(res,'Invalid installation callback',403);
      const response=await fetch(`https://api.github.com/app/installations/${installation}/access_tokens`,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+await appJwt(),Accept:'application/vnd.github+json','User-Agent':'AIUI-Workshop-Feedback-Setup','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('GitHub installation verification failed: HTTP '+response.status);
      const receipt=await response.json();
      const repositories=await fetch('https://api.github.com/installation/repositories',{redirect:'error',headers:{Authorization:'Bearer '+receipt.token,Accept:'application/vnd.github+json','User-Agent':'AIUI-Workshop-Feedback-Setup','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(20000)}).then(r=>r.json());
      if(receipt.permissions?.issues!=='write'||repositories.total_count!==1||repositories.repositories?.[0]?.full_name.toLowerCase()!==target.repository.toLowerCase())return html(res,'<h1>请收窄机器人权限</h1><p>请在 GitHub 安装设置中仅选择 '+escape(target.repository)+'，然后重新打开本页确认。</p>',409);
      secrets.GITHUB_INSTALLATION_ID=installation;await fs.writeFile(secretFile,JSON.stringify(secrets),{mode:0o600});
      await atomicJson(path.join(ROOT,'output/qa/feedback/github-setup.json'),{ready:true,repository:target.repository,appId:app.id,appUrl:app.html_url,installationId:installation,secretFile});
      html(res,'<h1>机器人授权已完成</h1><p>已核验：仅目标仓库、仅 issue 写入。可以回到 Codex，继续部署 Cloudflare。</p>');
      console.log('READY: restricted GitHub App installation verified. Secret file: '+secretFile);server.close();return;
    }
    return html(res,'Not found',404);
  }catch{html(res,'<h1>配置尚未完成</h1><p>请回到 Codex 查看下一步。敏感凭据没有显示或发送到聊天。</p>',500);console.error('GitHub setup step failed; no credential output.');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8977,'127.0.0.1',resolve);});base='http://127.0.0.1:8977';
console.log('Open the local review page: '+base+'/?key='+key);
console.log('This page prepares a GitHub App with Issues write access to '+target.repository+' only.');
const timer=setTimeout(()=>{console.log('Setup link expired; restart this script to continue.');server.close();},45*60000);timer.unref();
