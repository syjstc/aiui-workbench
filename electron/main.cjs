const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname,'..');
const home = process.env.AIUI_WORKBENCH_HOME || path.join(app.getPath('appData'),'AIUI Workbench');
process.env.AIUI_WORKBENCH_HOME = home;
app.setName('AIUI 工坊');
app.setPath('userData',path.join(home,'desktop-profile'));
let mainWindow, client, studio;
let allowed, updates;
let desktopLocale = 'zh-CN';
function trusted(event) { if(event.sender!==mainWindow?.webContents || event.senderFrame!==mainWindow?.webContents.mainFrame)throw new Error('无效的桌面调用来源'); }
async function connectService(){
  // Electron's executable can also run the Node-only MCP/service entry points.
  const previous = process.env.ELECTRON_RUN_AS_NODE;process.env.ELECTRON_RUN_AS_NODE='1';
  try { const {connect}=await import('../core/client.mjs');client=await connect(home); }
  finally { if(previous===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=previous; }
}
function studioWindow(){
  if(studio&&!studio.isDestroyed()){studio.focus();return;}
  studio=new BrowserWindow({width:1240,height:850,title:desktopLocale==='en'?'Rokid Official Platform':'Rokid 官方平台',webPreferences:{partition:'persist:rokid-studio',nodeIntegration:false,contextIsolation:true,sandbox:true}});
  studio.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\/[^/]*rokid\.com(?:\/|$)/i.test(url)){studio.loadURL(url);return{action:'deny'};}return{action:'deny'};});
  studio.loadURL('https://aiui.rokid.com/space');
}
app.whenReady().then(async()=>{
  desktopLocale = /^zh(?:-|$)/i.test(app.getLocale()) ? 'zh-CN' : 'en';
  await connectService();
  ({UI_TOOLS:allowed}=await import('../core/ui-tools.mjs'));
  const {AppUpdates}=await import('../core/updates.mjs');
  updates=await new AppUpdates(home).init();
  mainWindow=new BrowserWindow({width:1440,height:940,minWidth:1080,minHeight:740,title:'AIUI 工坊',backgroundColor:'#ffffff',icon:path.join(ROOT,'assets/icon.png'),...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:21,y:23}}:{titleBarStyle:'default',autoHideMenuBar:true}),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file://'))event.preventDefault();});
  require('./media-permissions.cjs').installMediaPermissions(session.defaultSession, { getWebContents:()=>mainWindow?.webContents, origin:client.connection.origin });
  ipcMain.handle('workbench:call',async(event,tool,args)=>{trusted(event);if(!allowed.has(tool))throw new Error('未知操作');return client.call(tool,args,'desktop');});
  ipcMain.handle('workbench:project-remove',async(event,args)=>{
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
  ipcMain.handle('workbench:locale',async(event,locale)=>{trusted(event);if(!['zh-CN','en'].includes(locale))throw new Error('Unsupported language');desktopLocale=locale;studio?.setTitle(locale==='en'?'Rokid Official Platform':'Rokid 官方平台');return true;});
  ipcMain.handle('workbench:updates',async(event,method,args)=>{
    trusted(event);
    if(method==='status')return updates.status();
    if(method==='settings')return updates.settings(args);
    if(method==='check')return updates.check();
    if(method==='download')return updates.download();
    if(method==='reveal'){if(!updates.downloaded)throw new Error('请先下载并校验安装包');shell.showItemInFolder(updates.downloaded.path);return true;}
    if(method==='release'){if(!updates.latest?.releaseUrl)throw new Error('没有可打开的发行页面');await shell.openExternal(updates.latest.releaseUrl);return true;}
    throw new Error('未知更新操作');
  });
  ipcMain.handle('workbench:choose',async(event,kind)=>{trusted(event);const options=kind==='photo'?{properties:['openFile'],filters:[{name:desktopLocale==='en'?'Photos':'照片',extensions:['png','jpg','jpeg','webp']}]}:{properties:['openDirectory','createDirectory']};const result=await dialog.showOpenDialog(mainWindow,options);return result.canceled?null:result.filePaths[0];});
  ipcMain.handle('workbench:choose-files',async(event,kind)=>{trusted(event);if(!['apk','files'].includes(kind))throw new Error('无效的文件类型');const result=await dialog.showOpenDialog(mainWindow,{properties:['openFile','multiSelections'],...(kind==='apk'?{filters:[{name:'Android APK',extensions:['apk']}]}:{})});return result.canceled?[]:result.filePaths;});
  ipcMain.handle('workbench:clipboard',async(event,text)=>{trusted(event);clipboard.writeText(String(text));return true;});
  ipcMain.handle('workbench:reveal',async(event,file)=>{trusted(event);if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('无效路径');shell.showItemInFolder(file);return true;});
  ipcMain.handle('workbench:external',async(event,url)=>{trusted(event);if(!/^https:\/\/(?:github\.com|js\.rokid\.com|yodaos-project\.github\.io|jsar-project\.github\.io|modelcontextprotocol\.io|developer\.android\.com|global\.rokid\.com|x-docs\.rokid\.com)\//.test(url))throw new Error('仅支持打开已知官方资料来源');await shell.openExternal(url);});
  ipcMain.handle('workbench:studio',event=>{trusted(event);studioWindow();return true;});
  await mainWindow.loadFile(path.join(ROOT,'dist/renderer/index.html'));
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

app.on('before-quit',()=>{updates?.close();});
