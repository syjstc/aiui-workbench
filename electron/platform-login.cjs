const crypto=require('node:crypto');
const {PlatformSessionVault,validSession,officialCookies,tokenValue,SESSION}=require('./platform-session.cjs');
class PlatformLogin{
  constructor({home,session,BrowserWindow,safeStorage,client,desktopKey,getLocale,onStatus}){Object.assign(this,{session,BrowserWindow,client,desktopKey,getLocale,onStatus});this.vault=new PlatformSessionVault(home,safeStorage);this.partition='rokid-studio-private';this.renewed=new Set();this.graceUntil=0;this.authEpoch=0;}
  notifySession(active,token=''){
    this.loggedIn=active;const identity=active?crypto.createHash('sha256').update(token).digest('hex'):'';
    if(identity!==this.notifiedIdentity){this.notifiedIdentity=identity;this.onStatus?.({loggedIn:active});}
  }
  async init(){
    this.official=this.session.fromPartition(this.partition,{cache:false});let saved=await this.vault.load();
    // Migrate the prior browser profile once, retaining the user's fresh login.
    const legacy=this.session.fromPartition('persist:rokid-studio'),previous=officialCookies(await legacy.cookies.get({}));
    const auth=previous.find(c=>c.name===SESSION),valid=validSession(tokenValue(auth),Date.now(),auth?.expirationDate*1000);
    if(valid){
      const useLegacy=!saved?.token||saved.token===valid.token;
      let cleaner,timer;
      try{
        cleaner=new this.BrowserWindow({show:false,webPreferences:{partition:'persist:rokid-studio',nodeIntegration:false,contextIsolation:true,sandbox:true}});cleaner.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        await Promise.race([cleaner.loadURL('https://aiui.rokid.com/'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Legacy cleanup timed out')),15000);})]);
        if(new URL(cleaner.webContents.getURL()).hostname==='aiui.rokid.com')await cleaner.webContents.executeJavaScript("localStorage.removeItem('ROKID_ACCOUNT_SESSION');localStorage.removeItem('CRAFT_ACCOUNT_INFO');");
        const updated=officialCookies(await legacy.cookies.get({})),current=updated.find(c=>c.name===SESSION),fresh=validSession(tokenValue(current),Date.now(),current?.expirationDate*1000)||valid;
        if(useLegacy){await this.vault.save(fresh.token,fresh.expiresAt,updated);saved={...fresh,cookies:updated};}
        await legacy.clearStorageData({storages:['cookies']});await legacy.cookies.flushStore();
      }catch{
        // An offline migration still preserves this login in encrypted storage.
        if(useLegacy){await this.vault.save(valid.token,valid.expiresAt,previous);saved={...valid,cookies:previous};}
      }finally{clearTimeout(timer);if(cleaner&&!cleaner.isDestroyed())cleaner.destroy();}
    }
    if(saved){
      for(const cookie of saved.cookies||[]){
        const host=cookie.domain.replace(/^\./,''),details={url:'https://'+host+cookie.path,name:cookie.name,value:cookie.value,path:cookie.path,secure:true,httpOnly:!!cookie.httpOnly,sameSite:cookie.sameSite||'unspecified',...cookie.hostOnly?{}:{domain:cookie.domain},...cookie.expirationDate?{expirationDate:cookie.expirationDate}:{}};
        await this.official.cookies.set(details);
      }
      if(saved.token&&!(await this.official.cookies.get({url:'https://aiui.rokid.com/',name:SESSION})).length)await this.official.cookies.set({url:'https://aiui.rokid.com/',name:SESSION,value:encodeURIComponent(saved.token),secure:true,path:'/',sameSite:'no_restriction',expirationDate:saved.expiresAt/1000});
      if(!saved.token&&saved.cookies?.length){this.graceUntil=Date.now()+30000;this.renew('restore-official-sso');}
    }
    await this.sync();this.timer=setInterval(()=>this.sync().catch(()=>{}),5000);this.timer.unref();
    this.official.cookies.on('changed',(_event,cookie,cause,removed)=>{
      if(!/(^|\.)rokid\.com$/.test(cookie.domain.replace(/^\./,'')))return;
      if(this.logoutTask||this.userLoggedOut)return;
      if(cookie.name===SESSION&&removed&&cause==='explicit'){this.logout().catch(()=>{});return;}
      if(cookie.name===SESSION&&!removed)this.userLoggedOut=false;
      if(cookie.name===SESSION&&removed&&cause==='expired')this.renew(tokenValue(cookie));
      this.sync().catch(()=>{});
    });return this;
  }
  async sync(){
    if(this.userLoggedOut||this.logoutTask)return;
    if(this.syncing){this.resync=true;return this.syncing;}
    const epoch=this.authEpoch;
    this.syncing=(async()=>{
      const cookies=await this.official.cookies.get({url:'https://aiui.rokid.com/',name:SESSION}),cookie=cookies[0],token=tokenValue(cookie),expiresAt=cookie?.expirationDate*1000;
      if(epoch!==this.authEpoch||this.userLoggedOut)return;
      const result=await this.client.call('ui_platform_session',{token,expiresAt,desktopKey:this.desktopKey},'desktop-session'),valid=validSession(token,Date.now(),expiresAt);
      if(epoch!==this.authEpoch||this.userLoggedOut)return;
      if(token&&result.rejected){await this.vault.clear();this.renew(token);}
      else if(valid){await this.vault.save(token,valid.expiresAt,await this.official.cookies.get({}));if(valid.expiresAt-Date.now()<5*60000)this.renew(token);}
      else if(Date.now()>this.graceUntil&&!this.renewal)await this.vault.clear();
      if(epoch!==this.authEpoch||this.userLoggedOut)return;
      const active=!!valid&&!!result.loggedIn&&!result.rejected;this.notifySession(active,token);
      if(active&&this.awaitingLogin&&this.studio&&!this.studio.isDestroyed()){
        const window=this.studio;this.studio=null;this.awaitingLogin=false;window.destroy();
      }
    })();
    try{await this.syncing;}finally{this.syncing=null;if(this.resync){this.resync=false;this.sync().catch(()=>{});}}
  }
  async logout(){
    if(this.logoutTask)return this.logoutTask;
    this.userLoggedOut=true;this.authEpoch++;this.graceUntil=0;this.resync=false;
    this.awaitingLogin=false;
    for(const window of [this.renewal,this.studio])if(window&&!window.isDestroyed())window.destroy();
    this.renewal=null;this.studio=null;
    const pending=this.syncing,legacy=this.session.fromPartition('persist:rokid-studio');
    this.logoutTask=(async()=>{
      // Revoke immediately, then once more after any earlier heartbeat settles.
      // A late sync must not restore the session or recreate its encrypted file.
      await Promise.allSettled([pending,this.client.call('ui_platform_session',{token:null,desktopKey:this.desktopKey},'desktop-session')]);
      const cleanup=await Promise.allSettled([this.vault.clear(),this.official.clearStorageData(),legacy.clearStorageData()]);
      await legacy.cookies.flushStore();
      const status=await this.client.call('ui_platform_session',{token:null,desktopKey:this.desktopKey},'desktop-session');
      this.notifySession(false);
      if(cleanup.some(result=>result.status==='rejected'))throw new Error('官方账号已停用，但登录缓存未完全清理，请再次退出');
      return {...status,loggedOut:true};
    })();
    try{return await this.logoutTask;}finally{this.logoutTask=null;}
  }
  renew(token){
    const marker=crypto.createHash('sha256').update(token).digest('hex');if(this.userLoggedOut||this.renewal||this.renewed.has(marker))return;this.renewed.add(marker);
    const window=new this.BrowserWindow({show:false,webPreferences:{partition:this.partition,nodeIntegration:false,contextIsolation:true,sandbox:true}});this.renewal=window;
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{try{const u=new URL(url);if(u.protocol!=='https:'||!['aiui.rokid.com','account-web.rokid.com','account-center.rokid.com'].includes(u.hostname))event.preventDefault();}catch{event.preventDefault();}});
    const timer=setTimeout(()=>{if(!window.isDestroyed())window.destroy();},30000);timer.unref();window.on('closed',()=>{clearTimeout(timer);if(this.renewal===window)this.renewal=null;});window.loadURL('https://aiui.rokid.com/space').catch(()=>{});
  }
  async open(){
    if(this.logoutTask)await this.logoutTask;
    this.userLoggedOut=false;this.renewed.clear();
    await this.sync();
    if(this.studio&&!this.studio.isDestroyed()){this.studio.show();this.studio.focus();return;}
    this.studio=new this.BrowserWindow({width:1240,height:850,title:this.getLocale()==='en'?'Rokid Official Platform':'Rokid 官方平台',webPreferences:{partition:this.partition,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    this.awaitingLogin=!this.loggedIn;const window=this.studio;
    window.on('closed',()=>{if(this.studio===window){this.studio=null;this.awaitingLogin=false;}});
    this.studio.webContents.on('will-navigate',(event,url)=>{try{const u=new URL(url);if(u.protocol!=='https:'||!['aiui.rokid.com','account-web.rokid.com','account-center.rokid.com'].includes(u.hostname))event.preventDefault();}catch{event.preventDefault();}});
    this.studio.webContents.setWindowOpenHandler(({url})=>{try{const u=new URL(url);if(u.protocol==='https:'&&['aiui.rokid.com','account-web.rokid.com','account-center.rokid.com'].includes(u.hostname))this.studio.loadURL(url);}catch{}return{action:'deny'};});this.studio.loadURL('https://aiui.rokid.com/space');
  }
  close(){clearInterval(this.timer);if(this.renewal&&!this.renewal.isDestroyed())this.renewal.destroy();}
}
module.exports={PlatformLogin};
