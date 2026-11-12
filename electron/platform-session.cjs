const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const SESSION='ROKID_ACCOUNT_SESSION';
const officialDomain=value=>typeof value==='string'&&/(^|\.)rokid\.com$/.test(value.replace(/^\./,''));
function tokenValue(cookie){try{return decodeURIComponent(cookie?.value||'');}catch{return '';}}
function validSession(token,now=Date.now(),expiryHint){
  try{
    const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    if(typeof(claims.accountId||claims.account_id)!=='string')return null;
    const declared=Number(claims.exp),hint=Number(expiryHint);
    const expiries=[...(Number.isFinite(declared)&&declared>0?[declared*1000]:[]),...(Number.isFinite(hint)&&hint>0?[hint]:[])];
    const expiresAt=expiries.length?Math.min(...expiries):0;
    return expiresAt>now?{token,expiresAt}:null;
  }catch{return null;}
}
function officialCookies(cookies){
  return cookies.filter(c=>officialDomain(c.domain)&&/^[A-Za-z0-9_.-]+$/.test(c.name)&&typeof c.value==='string'&&c.value.length<=16384&&typeof c.path==='string'&&c.path.startsWith('/')&&!/[\r\n]/.test(c.path)).slice(0,100).map(c=>Object.fromEntries(['name','value','domain','hostOnly','path','secure','httpOnly','sameSite','expirationDate','session'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]]))).sort((a,b)=>(a.domain+a.path+a.name).localeCompare(b.domain+b.path+b.name));
}
class PlatformSessionVault{
  constructor(home,safeStorage){this.file=path.join(home,'official-session.enc');this.safeStorage=safeStorage;this.queue=Promise.resolve();}
  available(){return this.safeStorage.isEncryptionAvailable()&&this.safeStorage.getSelectedStorageBackend?.()!=='basic_text';}
  async load(){
    if(!this.available())return null;
    try{
      const plaintext=this.safeStorage.decryptString(await fs.readFile(this.file));let record;
      try{record=JSON.parse(plaintext);}catch{record={token:plaintext};}
      const valid=validSession(record.token,Date.now(),record.expiresAt);
      const cookies=officialCookies(Array.isArray(record.cookies)?record.cookies:[]).filter(c=>c.expirationDate?c.expirationDate*1000>Date.now():Number.isFinite(record.savedAt)&&Date.now()-record.savedAt<30*86400000);
      if(!valid&&!cookies.length){await this.clear();return null;}
      return {...(valid||{token:null,expiresAt:null}),cookies};
    }catch(error){if(error.code!=='ENOENT')await this.clear();return null;}
  }
  async save(token,expiresAt,cookies=[]){
    if(!this.available())return this.queue;
    const valid=validSession(token,Date.now(),expiresAt);if(!valid)return this.clear();
    const payload={schemaVersion:2,token,expiresAt:valid.expiresAt,cookies:officialCookies(cookies)};
    const digest=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');if(digest===this.queuedDigest)return this.queue;this.queuedDigest=digest;
    const encrypted=this.safeStorage.encryptString(JSON.stringify({...payload,savedAt:Date.now()}));
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';
      try{await fs.writeFile(temporary,encrypted,{mode:0o600});await fs.rename(temporary,this.file);}
      finally{await fs.rm(temporary,{force:true});}
    });return this.queue;
  }
  async clear(){this.queuedDigest=null;this.queue=this.queue.catch(()=>{}).then(()=>fs.rm(this.file,{force:true}));return this.queue;}
}
module.exports={PlatformSessionVault,validSession,officialCookies,tokenValue,SESSION};
