const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const platformDesktopKey=require('node:crypto').randomBytes(32).toString('hex');
const {PlatformLogin}=require('./platform-login.cjs');
const {spawn}=require('node:child_process');
const ROOT = path.resolve(__dirname,'..');
const home = process.env.AIUI_WORKBENCH_HOME || path.join(app.getPath('appData'),'AIUI Workbench');
process.env.AIUI_WORKBENCH_HOME = home;
app.setName('AIUI 工坊');
app.setPath('userData',path.join(home,'desktop-profile'));
let mainWindow, client, studio;
const mirrorWindows=new Map();
const mirrorWindowLifecycle=require('./mirror-window-lifecycle.cjs').createMirrorWindowLifecycle({windows:mirrorWindows,getSession:async serial=>(await client.call('aiui_glasses_mirror_embed_status',{serial},'desktop')).session});
let allowed, updates, upgradeTask, quittingForUpgrade=false;
let desktopLocale = 'zh-CN';
let platformLogin;
const syncPlatformSession=()=>platformLogin.sync();
function handle(channel,handler){ipcMain.handle(channel,async(event,...args)=>{try{return await handler(event,...args);}catch(error){if(!error.diagnosticId&&event.sender===mainWindow?.webContents)await client?.call('aiui_diagnostics_report',{source:channel,message:error.message,stack:error.stack},'desktop').catch(()=>{});throw error;}});}
function trusted(event) { if(event.sender!==mainWindow?.webContents || event.senderFrame!==mainWindow?.webContents.mainFrame)throw new Error('无效的桌面调用来源'); }
async function connectService(){
  // core/client sets Node-only mode on its service child. Setting it on the
  // desktop can race Chromium utility startup, especially on Windows.
  const {connect}=await import('../core/client.mjs');client=await connect(home);
}
function studioWindow(){return platformLogin.open();}
app.whenReady().then(async()=>{
  desktopLocale = /^zh(?:-|$)/i.test(app.getLocale()) ? 'zh-CN' : 'en';
  await connectService();
  platformLogin=await new PlatformLogin({home,session,BrowserWindow,safeStorage,client,desktopKey:platformDesktopKey,getLocale:()=>desktopLocale,onStatus:status=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('workbench:platform-session',status);}}).init();
  app.on('before-quit',()=>platformLogin.close());
  ({UI_TOOLS:allowed}=await import('../core/ui-tools.mjs'));
  const {AppUpdates}=await import('../core/updates.mjs');
  updates=await new AppUpdates(home).init();
  mainWindow=new BrowserWindow({width:1440,height:940,minWidth:1080,minHeight:740,title:'AIUI 工坊',backgroundColor:'#ffffff',icon:path.join(ROOT,'assets/icon.png'),...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:21,y:23}}:{titleBarStyle:'default',autoHideMenuBar:true}),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWindow.webContents.on('render-process-gone',(_event,details)=>{client.call('aiui_diagnostics_report',{source:'renderer-process',message:JSON.stringify(details)},'desktop').catch(()=>{});});
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file://'))event.preventDefault();});
  require('./media-permissions.cjs').installMediaPermissions(session.defaultSession, { getWebContents:()=>mainWindow?.webContents, origin:client.connection.origin });
  handle('workbench:call',async(event,tool,args)=>{trusted(event);if(!allowed.has(tool))throw new Error('未知操作');if(tool.startsWith('aiui_platform_'))await syncPlatformSession();const result=await client.call(tool,args,'desktop');if(tool==='aiui_glasses_mirror_embed_stop')mirrorWindowLifecycle.close(args.serial,result?.id);return result;});
  const confirmingReviews=new Set();
  handle('workbench:review-confirm',async(event,args)=>{
    trusted(event);await syncPlatformSession();
    const draft=await client.call('ui_platform_review_confirmation',{...args,desktopKey:platformDesktopKey},'desktop-confirmation');
    if(confirmingReviews.has(draft.id))throw new Error('此提审确认窗口已打开');
    confirmingReviews.add(draft.id);
    try{
      const en=desktopLocale==='en';
      const choice=await dialog.showMessageBox(mainWindow,{type:'question',buttons:en?['Cancel','Submit for review']:['取消','提交审核'],defaultId:0,cancelId:0,noLink:true,title:en?'Confirm review submission':'确认提交审核',message:`${draft.agentName} · ${draft.version}`,detail:(en?'Submit this reviewed draft to Rokid?\n':'将已核对的草稿提交 Rokid 审核？\n')+`Agent ID: ${draft.agentId}\nSHA256: ${draft.sha256}\n\n${draft.content.description}\n\n${draft.content.versionLog}\n\n`+(en?'Confirm this version and its materials are ready for public release. Review and store availability follow the official platform\'s rules.':'请确认此版本与材料可公开发布后再提交。审核通过后的上架规则以官方平台为准。')});
      if(choice.response!==1)return{cancelled:true,draftId:draft.id};
      return await client.call('ui_platform_review_submit',{projectId:draft.projectId,draftId:draft.id,digest:draft.digest,approvalId:draft.approvalId,desktopKey:platformDesktopKey},'desktop-confirmation');
    }finally{confirmingReviews.delete(draft.id);}
  });
  handle('workbench:project-remove',async(event,args)=>{
    trusted(event);
    const intent=await client.call('ui_project_removal_begin',args,'desktop');
    let trashed=false;
    try {
      if(intent.operation==='delete'){await shell.trashItem(intent.path);trashed=true;}
      return await client.call('ui_project_removal_commit',{intentId:intent.id},'desktop');
    } catch(error) {
      await client.call('ui_project_removal_cancel',{intentId:intent.id},'desktop').catch(()=>{});
      if(trashed)throw new Error('项目文件已移到系统废纸篓或回收站，但列表未能更新，请再次解绑此项目');
      throw error;
    }
  });
  handle('workbench:locale',async(event,locale)=>{trusted(event);if(!['zh-CN','en'].includes(locale))throw new Error('Unsupported language');desktopLocale=locale;platformLogin.studio?.setTitle(locale==='en'?'Rokid Official Platform':'Rokid 官方平台');return true;});
  handle('workbench:updates',async(event,method,args)=>{
    trusted(event);
    if(method==='status')return {...updates.status(),canInstall:process.platform==='darwin'&&app.isPackaged,installing:!!upgradeTask};
    if(upgradeTask)throw new Error('正在准备升级，请稍候');
    if(method==='upgrade'){
      upgradeTask=(async()=>{
        let prepared;
        try {
        const ensureIdle=async()=>{const status=await client.call('aiui_status',{},'desktop');if(status.jobs?.some(job=>job.status==='running')||status.recordings?.some(record=>['starting','recording','finalizing'].includes(record.status)))throw new Error('请先结束正在运行的任务或录制，再升级工坊');};
        await ensureIdle();
        const downloaded=updates.downloaded?.version===updates.latest?.version?updates.downloaded:await updates.download();
        if(process.platform!=='darwin'||!app.isPackaged){shell.showItemInFolder(downloaded.path);return {manualInstall:true};}
        const {prepareMacUpdate}=await import('../core/update-install.mjs');
        const target=path.resolve(path.dirname(app.getPath('exe')),'../..');
        prepared=await prepareMacUpdate({home,downloaded,target,pid:process.pid});
        await ensureIdle();
        const installer=spawn('/bin/sh',[prepared.script,...prepared.args],{detached:true,stdio:'ignore',windowsHide:true});
        await new Promise((resolve,reject)=>{installer.once('spawn',resolve);installer.once('error',reject);});installer.unref();
        quittingForUpgrade=true;setTimeout(()=>app.quit(),200);return {restarting:true,version:prepared.version};
        } catch(error) {await prepared?.cancel().catch(()=>{});throw error;}
      })().finally(()=>{if(!quittingForUpgrade)upgradeTask=null;});
      return upgradeTask;
    }
    if(method==='settings')return updates.settings(args);
    if(method==='check')return updates.check();
    if(method==='download')return updates.download();
    if(method==='reveal'){if(!updates.downloaded)throw new Error('请先下载并校验安装包');shell.showItemInFolder(updates.downloaded.path);return true;}
    if(method==='release'){if(!updates.latest?.releaseUrl)throw new Error('没有可打开的发行页面');await shell.openExternal(updates.latest.releaseUrl);return true;}
    throw new Error('未知更新操作');
  });
  handle('workbench:choose',async(event,kind)=>{trusted(event);const options=kind==='photo'?{properties:['openFile'],filters:[{name:desktopLocale==='en'?'Photos':'照片',extensions:['png','jpg','jpeg','webp']}]}:{properties:['openDirectory','createDirectory']};const result=await dialog.showOpenDialog(mainWindow,options);return result.canceled?null:result.filePaths[0];});
  handle('workbench:choose-files',async(event,kind)=>{trusted(event);if(!['apk','files'].includes(kind))throw new Error('无效的文件类型');const result=await dialog.showOpenDialog(mainWindow,{properties:['openFile','multiSelections'],...(kind==='apk'?{filters:[{name:'Android APK',extensions:['apk']}]}:{})});return result.canceled?[]:result.filePaths;});
  handle('workbench:clipboard',async(event,text)=>{trusted(event);clipboard.writeText(String(text));return true;});
  handle('workbench:reveal',async(event,file)=>{trusted(event);if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('无效路径');shell.showItemInFolder(file);return true;});
  handle('workbench:external',async(event,url)=>{trusted(event);if(!/^https:\/\/(?:github\.com|forum\.rokid\.com|js\.rokid\.com|yodaos-project\.github\.io|jsar-project\.github\.io|modelcontextprotocol\.io|developer\.android\.com|global\.rokid\.com|x-docs\.rokid\.com)\//.test(url))throw new Error('仅支持打开已知官方资料来源');await shell.openExternal(url);});
  handle('workbench:studio',async event=>{trusted(event);await studioWindow();return true;});
  handle('workbench:platform-logout',async event=>{trusted(event);return platformLogin.logout();});
  handle('workbench:mirror-window',async(event,serial)=>{
    trusted(event);
    const {session}=await client.call('aiui_glasses_mirror_embed_status',{serial},'desktop');
    if(session?.status!=='running')throw new Error('请先连接内嵌真机投屏');
    const existing=mirrorWindows.get(serial);
    if(existing&&!existing.window.isDestroyed()){
      if(existing.sessionId!==session.id){existing.sessionId=session.id;await existing.window.loadURL(session.url);}
      if(existing.window.isMinimized())existing.window.restore();existing.window.show();existing.window.focus();return {focused:true};
    }
    const window=new BrowserWindow({width:760,height:650,minWidth:360,minHeight:300,title:`AIUI · ${serial.slice(-6)}`,backgroundColor:'#0b0d0c',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
    const entry={window,sessionId:session.id};mirrorWindows.set(serial,entry);mirrorWindowLifecycle.changed();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==client.connection.origin)event.preventDefault();});
    window.on('closed',()=>{if(mirrorWindows.get(serial)===entry)mirrorWindows.delete(serial);mirrorWindowLifecycle.changed();});
    await window.loadURL(session.url);return {opened:true};
  });
  await mainWindow.loadFile(path.join(ROOT,'dist/renderer/index.html'));
  if(process.platform==='darwin'&&app.isPackaged){const {finishMacUpdate}=await import('../core/update-install.mjs');await finishMacUpdate(home,{target:path.resolve(path.dirname(app.getPath('exe')),'../..'),version:updates.version}).catch(()=>{});}
  mainWindow.on('focus',()=>{if(updates.data.autoCheck&&Date.now()-Date.parse(updates.data.attemptedAt||0)>5*60000)updates.check().catch(()=>{});});
  updates.start();
  client.call('aiui_docs_sync',{},'desktop').catch(()=>{});
  mainWindow.on('closed',()=>{mainWindow=null;});
}).catch(async error=>{
  let message=error.message;
  try {
    const {redact}=await import('../core/util.mjs');
    const diagnostic=redact(error.stack||message);
    fs.mkdirSync(home,{recursive:true});
    fs.appendFileSync(path.join(home,'service.log'),'Desktop startup failure: '+diagnostic+'\n',{mode:0o600});
    console.error('AIUI desktop startup failure:',diagnostic);
  } catch {}
  try { const {translateMessage}=await import('../shared/i18n.mjs');message=translateMessage(message,desktopLocale); } catch {}
  dialog.showErrorBox(desktopLocale==='en'?'AIUI Workshop failed to start':'AIUI 工坊启动失败',message+(desktopLocale==='en'?'\n\nLocal service log: ':'\n\n本地服务日志：')+path.join(home,'service.log'));app.quit();
});
app.on('window-all-closed',()=>app.quit());
app.on('activate',()=>mainWindow?.show());

app.on('before-quit',()=>{mirrorWindowLifecycle.dispose();updates?.close();});
