import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {PlatformSessionVault,validSession}=createRequire(import.meta.url)('../electron/platform-session.cjs');
const token=exp=>'header.'+Buffer.from(JSON.stringify({accountId:'fixture-account',exp})).toString('base64url')+'.signature';
test('an empty official session vault does not request access to OS encryption',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'official-empty-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const vault=new PlatformSessionVault(home,{isEncryptionAvailable(){assert.fail('An absent session needs no decryption');}});
  assert.equal(await vault.load(),null);
});
test('official session persists only OS-encrypted bytes with private permissions, restores and clears',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'official-session-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);
  const safeStorage={isEncryptionAvailable:()=>true,encryptString(value){const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([cipher.getAuthTag(),encrypted]);},decryptString(value){const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(value.subarray(0,16));return Buffer.concat([decipher.update(value.subarray(16)),decipher.final()]).toString('utf8');}};
  const vault=new PlatformSessionVault(home,safeStorage),valid=token(Math.floor(Date.now()/1000)+3600);
  await vault.save(valid);assert.equal((await fs.readFile(vault.file)).includes(Buffer.from(valid)),false);
  if(process.platform!=='win32')assert.equal((await fs.stat(vault.file)).mode&0o777,0o600);
  const restored=await new PlatformSessionVault(home,safeStorage).load();assert.equal(restored.token,valid);
  await fs.writeFile(vault.file,Buffer.from('tampered'));assert.equal(await vault.load(),null);await assert.rejects(fs.access(vault.file));
  await vault.save(valid);await vault.clear();await assert.rejects(fs.access(vault.file));assert.equal(validSession(token(1)),null);
});
test('Linux plaintext fallback and unavailable OS encryption never persist an official session',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'official-insecure-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  for(const safeStorage of [{isEncryptionAvailable:()=>false},{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text'}]){
    const vault=new PlatformSessionVault(home,safeStorage);await vault.save(token(Math.floor(Date.now()/1000)+3600));assert.equal(await vault.load(),null);await assert.rejects(fs.access(vault.file));
  }
});
test('Rokid tokens without exp use the official cookie expiry, and cannot outlive an explicit JWT expiry',()=>{
  const now=Date.now(),session='header.'+Buffer.from(JSON.stringify({accountId:'fixture',iss:'Rokid',type:'session',timestamp:now})).toString('base64url')+'.signature';
  assert.equal(validSession(session,now),null);assert.equal(validSession(session,now,now+3600000).expiresAt,now+3600000);assert.equal(validSession(session,now,now-1),null);
  assert.equal(validSession(token(Math.floor(now/1000)+60),now,now+3600000).expiresAt,(Math.floor(now/1000)+60)*1000);
});
test('desktop startup checks a restored session without waiting for the official service and clears revoked sign-in',async t=>{
  const {EventEmitter}=await import('node:events');
  const {PlatformLogin}=createRequire(import.meta.url)('../electron/platform-login.cjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'studio-startup-check-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const expires=Math.floor(Date.now()/1000)+3600;
  const cookie={name:'ROKID_ACCOUNT_SESSION',value:token(expires),expirationDate:expires,domain:'aiui.rokid.com',path:'/'};
  const officialCookies=Object.assign(new EventEmitter(),{get:async()=>[cookie]});
  const legacyCookies={get:async()=>[]};
  const session={fromPartition:name=>({cookies:name.startsWith('persist:')?legacyCookies:officialCookies})};
  let revoked=false,releaseCheck,invalidated;
  const checking=new Promise(resolve=>{releaseCheck=resolve;});
  const signedOut=new Promise(resolve=>{invalidated=resolve;});
  const calls=[];
  const client={call:async(name,args)=>{
    calls.push(name);
    if(name==='aiui_platform_agents'){await checking;revoked=true;throw new Error('Session revoked');}
    return {loggedIn:!!args.token&&!revoked,rejected:!!args.token&&revoked};
  }};
  const login=new PlatformLogin({home,session,client,safeStorage:{isEncryptionAvailable:()=>false},
    desktopKey:'d'.repeat(64),getLocale:()=> 'en',onStatus:value=>{if(!value.loggedIn)invalidated();}});
  const renewals=[];
  login.renew=value=>renewals.push(value);
  await login.init();
  t.after(()=>login.close());
  assert.ok(calls.includes('aiui_platform_agents'));
  assert.equal(login.loggedIn,true);
  releaseCheck();
  await signedOut;
  assert.equal(login.loggedIn,false);
  assert.deepEqual(renewals,[cookie.value]);
});
test('legacy official login migrates to a memory partition and only an encrypted cookie snapshot survives restart',async t=>{
  const {EventEmitter}=await import('node:events'),{PlatformLogin}=createRequire(import.meta.url)('../electron/platform-login.cjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'official-migration-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const sessionToken='fixture.'+Buffer.from(JSON.stringify({accountId:'migration-account',timestamp:Date.now(),type:'session'})).toString('base64url')+'.signature',expires=Date.now()/1000+3600,partitions=new Map(),calls=[],cleanup=[];
  const session={fromPartition(name){if(!partitions.has(name)){const cookies=new EventEmitter();cookies.items=[];cookies.get=async query=>cookies.items.filter(c=>!query.name||c.name===query.name);cookies.set=async details=>{cookies.items.push({...details,domain:details.domain||new URL(details.url).hostname,hostOnly:!details.domain,session:!details.expirationDate});};cookies.flushStore=async()=>{};partitions.set(name,{cookies,clearStorageData:async()=>{cookies.items=[];}});}return partitions.get(name);}};
  session.fromPartition('persist:rokid-studio').cookies.items=[{name:'ROKID_ACCOUNT_SESSION',value:sessionToken,domain:'.rokid.com',hostOnly:false,path:'/',secure:true,httpOnly:false,session:false,expirationDate:expires}];
  class Window extends EventEmitter{constructor(options){super();this.options=options;this.webContents={on:()=>{},setWindowOpenHandler:()=>{},getURL:()=>this.url,executeJavaScript:async text=>cleanup.push(text)};}async loadURL(url){this.url=url;}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;this.emit('closed');}}
  const key=crypto.randomBytes(32),safeStorage={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(16),cipher=crypto.createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final()]);},decryptString(bytes){const decipher=crypto.createDecipheriv('aes-256-cbc',key,bytes.subarray(0,16));return Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]).toString();}};
  let gate,entered;const client={call:async(name,args)=>{calls.push({name,args});if(gate&&args.token){entered();await gate;}return {loggedIn:!!args.token};}};
  const login=await new PlatformLogin({home,session,BrowserWindow:Window,safeStorage,client,desktopKey:'b'.repeat(64),getLocale:()=> 'zh-CN'}).init();t.after(()=>login.close());
  assert.equal(login.partition.startsWith('persist:'),false);assert.equal(session.fromPartition('persist:rokid-studio').cookies.items.length,0);assert.equal(cleanup.some(text=>text.includes("removeItem('ROKID_ACCOUNT_SESSION')")),true);
  assert.equal(calls[0].args.token,sessionToken);assert.equal(calls[0].args.expiresAt,expires*1000);assert.equal((await fs.readFile(login.vault.file)).includes(Buffer.from(sessionToken)),false);
  const restored=await new PlatformSessionVault(home,safeStorage).load();assert.equal(restored.token,sessionToken);assert.equal(restored.cookies.length,1);
  login.studio=new Window({});login.renewal=new Window({});const windows=[login.studio,login.renewal];
  let release;gate=new Promise(resolve=>release=resolve);const inFlight=new Promise(resolve=>entered=resolve),sync=login.sync();await inFlight;
  const logout=login.logout();release();await sync;assert.equal((await logout).loggedOut,true);gate=null;
  assert.equal(calls.at(-1).args.token,null);assert.equal(windows.every(window=>window.isDestroyed()),true);
  assert.equal(session.fromPartition(login.partition).cookies.items.length,0);assert.equal(session.fromPartition('persist:rokid-studio').cookies.items.length,0);assert.equal(await login.vault.load(),null);
  const count=calls.length;await login.sync();login.renew('expired-session');assert.equal(calls.length,count);assert.equal(login.renewal,null);
  const notifications=[];
  login.close();const restarted=await new PlatformLogin({home,session,BrowserWindow:Window,safeStorage,client,desktopKey:'c'.repeat(64),getLocale:()=> 'zh-CN',onStatus:value=>notifications.push(value)}).init();t.after(()=>restarted.close());assert.equal(calls.at(-1).args.token,'');
  await restarted.open();const loginWindow=restarted.studio;assert.equal(restarted.awaitingLogin,true);
  await restarted.official.cookies.set({url:'https://aiui.rokid.com/',name:'ROKID_ACCOUNT_SESSION',value:sessionToken,path:'/',expirationDate:expires});await restarted.sync();assert.equal(calls.findLast(c=>c.name==='ui_platform_session').args.token,sessionToken);
  assert.equal(loginWindow.isDestroyed(),true);assert.equal(restarted.studio,null);assert.deepEqual(notifications.at(-1),{loggedIn:true});assert.equal(notifications.some(value=>Object.hasOwn(value,'token')),false);
  await restarted.open();const managementWindow=restarted.studio;assert.equal(restarted.awaitingLogin,false);await restarted.sync();assert.equal(managementWindow.isDestroyed(),false);managementWindow.destroy();
});
test('first sign-in polls Studio storage and keeps the window open until the account read succeeds',async t=>{
  const {EventEmitter}=await import('node:events');
  const {PlatformLogin}=createRequire(import.meta.url)('../electron/platform-login.cjs');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'studio-first-login-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  let stored=null,accountReady=false;
  class Window extends EventEmitter{
    constructor(){super();this.webContents=Object.assign(new EventEmitter(),{
      getURL:()=>this.url,executeJavaScript:async()=>stored,setWindowOpenHandler:()=>{},
    });}
    async loadURL(url){this.url=url;}
    isDestroyed(){return !!this.closed;}
    destroy(){this.closed=true;this.emit('closed');}
  }
  const cookies=Object.assign(new EventEmitter(),{get:async()=>[]});
  const login=await new PlatformLogin({home,session:{fromPartition:()=>({cookies})},BrowserWindow:Window,
    safeStorage:{isEncryptionAvailable:()=>false},getLocale:()=> 'en',desktopKey:'a'.repeat(64),
    client:{call:async(name,args)=>{
      if(name==='ui_platform_session')return {loggedIn:!!args.token};
      assert.equal(name,'aiui_platform_agents');
      if(!accountReady)throw Error('Transient failure');
      return {agents:[]};
    }},
  }).init();
  t.after(()=>login.close());
  await login.open();const window=login.studio;
  stored=token(Math.floor(Date.now()/1000)+600);
  await assert.rejects(login.sync(),/Transient failure/);
  assert.equal(window.isDestroyed(),false);
  accountReady=true;
  const closed=new Promise(resolve=>window.once('closed',resolve));
  let deadline;
  try{await Promise.race([closed,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('First sign-in did not complete')),3500);})]);}
  finally{clearTimeout(deadline);}
  assert.equal(login.loggedIn,true);await login.sync();assert.equal(login.loggedIn,true);
});
