import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { startWeb } from '../web/server.mjs';
import { ROOT, run, id } from '../core/util.mjs';
import { parseDevices } from '../core/devices.mjs';
import { zipSync, unzipSync } from 'fflate';

const home = await fs.mkdtemp(path.join(ROOT, '.local/qa-glasses-'));
const output = path.join(ROOT, 'output/qa/glasses-tools'); await fs.mkdir(output, { recursive: true });
const daemon = await startDaemon(home), service = daemon.service;
const devices = parseDevices((await service.adb.capture(['devices', '-l'])).stdout.toString());
const device = devices.find(item => item.status === 'device');
if (!device || devices.filter(item => item.status === 'device').length !== 1) throw new Error('QA requires exactly one authorized ADB device');
const serial = device.serial, packageName = 'local.aiui.workbench.qa' + id().replaceAll('-', '').slice(0, 8);
const remote = '/sdcard/Download/aiui-workbench-qa-' + id().slice(0, 8);
const report = { startedAt: new Date().toISOString(), home, serialSuffix: serial.slice(-6), checks: [], errors: [], packageName, remote };
let app, browser, web, installed = false, createdFolder = false;
async function check(name, fn) { const result = await fn(); report.checks.push({ name, passed: true }); console.log('PASS', name); return result; }
async function waitFor(read, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('等待操作完成超时'); }
async function waitJob(job) {
  await waitFor(() => { const current = service.jobs.get(job.id); if (current.status === 'failed') throw new Error(current.error); return current.status === 'succeeded'; }, 60000);
  return service.jobs.get(job.id).result;
}
async function exec(command, args) { const result = await run(command, args, { timeout: 30000 }); if (result.code) throw new Error(result.output); }
async function dropFile(page, selector, file) {
  await page.evaluate(() => { let input = document.querySelector('#qa-drop-input'); if (!input) { input = document.createElement('input'); input.id = 'qa-drop-input'; input.type = 'file'; input.hidden = true; document.body.append(input); } });
  await page.locator('#qa-drop-input').setInputFiles(file);
  await page.evaluate(selector => {
    const transfer = new DataTransfer(); transfer.items.add(document.querySelector('#qa-drop-input').files[0]);
    document.querySelector(selector).dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    document.querySelector(selector).dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, selector);
}
try {
  const tools = path.join(process.env.ANDROID_HOME || path.join(process.env.HOME, 'Library/Android/sdk'), 'build-tools/35.0.0');
  const platform = path.join(process.env.ANDROID_HOME || path.join(process.env.HOME, 'Library/Android/sdk'), 'platforms/android-35/android.jar');
  const manifest = path.join(home, 'AndroidManifest.xml'), apk = path.join(home, 'workbench QA.apk'), unsigned = path.join(home, 'unsigned.apk'), keystore = path.join(home, 'qa.keystore');
  await fs.writeFile(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}" android:versionCode="1" android:versionName="1.0"><uses-sdk android:minSdkVersion="23" android:targetSdkVersion="32"/><application android:debuggable="true" android:label="Workbench QA"><activity android:name=".QaActivity" android:exported="true" android:theme="@android:style/Theme.Material.Light.NoActionBar"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>`);
  const source = path.join(home, 'QaActivity.java'), classes = path.join(home, 'classes'), dex = path.join(home, 'dex');
  await fs.mkdir(classes); await fs.mkdir(dex);
  await fs.writeFile(source, `package ${packageName};
import android.app.Activity; import android.os.Bundle; import android.widget.*; import android.util.Log; import android.view.*;
public class QaActivity extends Activity {
 int clicks=0;
 public void onCreate(Bundle saved) { super.onCreate(saved); LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(20,25,20,15);root.setBackgroundColor(0xfffafaf8);
 TextView title=new TextView(this);title.setText("Workbench mouse test");title.setTextColor(0xff222222);title.setTextSize(22);root.addView(title);
 final Button button=new Button(this);button.setText("Click test: 0");button.setOnClickListener(new View.OnClickListener(){public void onClick(View v){clicks++;button.setText("Click test: "+clicks);Log.i("WorkbenchMirrorQA","CLICK="+clicks);}});root.addView(button,new LinearLayout.LayoutParams(-1,90));
 ScrollView scroll=new ScrollView(this);LinearLayout items=new LinearLayout(this);items.setOrientation(1);for(int i=0;i<30;i++){TextView row=new TextView(this);row.setText("Scroll row "+i);row.setTextColor(0xff333333);row.setTextSize(18);row.setPadding(10,18,10,18);row.setBackgroundColor(i%2==0?0xffeeeee8:0xfffafaf8);items.addView(row);}scroll.addView(items);scroll.setOnScrollChangeListener(new View.OnScrollChangeListener(){public void onScrollChange(View v,int x,int y,int oldX,int oldY){Log.i("WorkbenchMirrorQA","SCROLL="+y);}});root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);Log.i("WorkbenchMirrorQA","READY");}
 public boolean onKeyUp(int keyCode,KeyEvent event){Log.i("WorkbenchMirrorQA","KEY="+keyCode);return super.onKeyUp(keyCode,event);}
}`);
  await exec('/usr/bin/javac', ['-source', '8', '-target', '8', '-bootclasspath', platform, '-d', classes, source]);
  const classFiles = [];
  async function collect(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file=path.join(directory,entry.name); if(entry.isDirectory())await collect(file);else if(file.endsWith('.class'))classFiles.push(file); } }
  await collect(classes);
  await exec(path.join(tools, 'd8'), ['--min-api', '23', '--lib', platform, '--output', dex, ...classFiles]);
  await exec(path.join(tools, 'aapt'), ['package', '-f', '-M', manifest, '-I', platform, '-F', unsigned]);
  await fs.writeFile(unsigned, zipSync({ ...unzipSync(await fs.readFile(unsigned)), 'classes.dex': await fs.readFile(path.join(dex, 'classes.dex')) }));
  await exec('/usr/bin/keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'workbench-qa', '-keypass', 'workbench-qa', '-alias', 'qa', '-dname', 'CN=Workbench QA', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-noprompt']);
  await exec(path.join(tools, 'apksigner'), ['sign', '--ks', keystore, '--ks-key-alias', 'qa', '--ks-pass', 'pass:workbench-qa', '--key-pass', 'pass:workbench-qa', '--out', apk, unsigned]);
  const before = await service.glasses.apps({ serial });
  assert.ok(!before.packages.some(item => item.packageName === packageName));

  app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.getByRole('button', { name: '眼镜工具', exact: true }).click();
  await check('实际 Electron 概览展示设备、内存与可用空间', async () => {
    await page.getByRole('heading', { name: '存储空间', exact: true }).waitFor({ timeout: 30000 });
    assert.match(await page.locator('.glasses-metrics').innerText(), /GiB/);
    assert.match(await page.locator('.glasses-info-list').innerText(), /RG-glasses/);
    report.info = await service.glasses.info({ serial });
    await page.screenshot({ path: path.join(output, '01-overview.png') });
  });
  await check('文件列表、隐藏文件、文件名搜索与目录导航', async () => {
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await page.locator('.glasses-file-table tbody tr').first().waitFor();
    await page.getByLabel('显示隐藏文件').check();
    await page.getByLabel('搜索当前目录').fill('bahuang');
    assert.ok(await page.locator('.glasses-file-table tbody tr').count() > 0);
    await page.screenshot({ path: path.join(output, '02-files.png') });
    await page.locator('.glasses-filename').filter({ hasText: 'bahuang-home-011.png' }).click();
    await page.getByRole('dialog').locator('img').waitFor();
    await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
    await page.getByLabel('搜索当前目录').fill('');
    await page.locator('.glasses-places').getByRole('button', { name: '下载', exact: true }).click();
    await page.getByText('这个文件夹是空的', { exact: true }).waitFor();
  });
  await check('第三方应用版本与系统应用保护', async () => {
    await page.getByRole('tab', { name: '应用', exact: true }).click();
    await page.locator('.glasses-app-list button').filter({ hasText: 'local.rokid.localplayer' }).click();
    await page.getByText('安装时间', { exact: true }).waitFor();
    await page.getByRole('button', { name: '卸载应用', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, '03-apps.png') });
    await page.getByLabel('应用类型', { exact: true }).selectOption('system');
    await page.getByLabel('搜索应用包名').fill('com.android.settings');
    await page.locator('.glasses-app-list button').filter({ hasText: /^settings/ }).first().click();
    assert.equal(await page.getByRole('button', { name: '卸载应用', exact: true }).count(), 0);
  });
  await check('通过 APK 选择器在真机安装独立测试应用', async () => {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, apk);
    await page.getByRole('tab', { name: '安装 APK', exact: true }).click();
    await dropFile(page, '.glasses-apk-picker', apk);
    await page.getByText('workbench QA.apk', { exact: true }).waitFor();
    await dropFile(page, '.glasses-apk-picker', apk);
    await waitFor(async () => await page.locator('.glasses-apk-list>div').count() === 1);
    assert.equal(service.jobs.list().filter(job => job.type === 'glasses-install').length, 0, 'dropping an APK queues it without installing automatically');
    await page.screenshot({ path: path.join(output, '04-apk-install.png') });
    await page.getByRole('button', { name: '安装 1 个 APK', exact: true }).click();
    await waitFor(() => service.jobs.list().some(job => job.type === 'glasses-install'));
    await waitJob(service.jobs.list().find(job => job.type === 'glasses-install'));
    installed = true;
    assert.ok((await service.glasses.apps({ serial })).packages.some(item => item.packageName === packageName));
  });
  await check('覆盖安装保留测试应用数据；打开和停止只操作测试包', async () => {
    await service.glasses.shell(serial, ['run-as', packageName, 'sh', '-c', 'mkdir -p files && printf preserved > files/qa-marker']);
    await waitJob(await service.call('aiui_glasses_install', { serial, files: [apk] }));
    assert.equal(await service.glasses.shell(serial, ['run-as', packageName, 'cat', 'files/qa-marker']), 'preserved');
    await waitJob(await service.call('aiui_glasses_app_action', { serial, packageName, action: 'launch' }));
    if (process.env.AIUI_QA_MIRROR_HANDOFF === '1') {
      const mirror = await service.call('aiui_glasses_mirror_start', { serial });
      await fs.writeFile(path.join(output, 'mirror-handoff.json'), JSON.stringify({ home, packageName, serial, mirror }, null, 2));
      console.log('MIRROR_HANDOFF', home);
      await waitFor(async () => fs.access(path.join(home, 'continue-mirror-qa')).then(() => true, () => false), 600000);
      report.mouseLog = await service.glasses.shell(serial, ['logcat', '-d', '-s', 'WorkbenchMirrorQA:I', '*:S']);
      assert.match(report.mouseLog, /CLICK=[1-9]/); assert.match(report.mouseLog, /KEY=(19|20)/);
      report.inputAcceptance = { mouseClick: 'native mirroring window, visible counter changed', keyboard: 'native mirroring window, key-up observed in Android log', drag: 'not verified by native UI automation', adbSwipe: 'separate ADB input validation' };
      await service.call('aiui_glasses_mirror_stop', { serial });
    }
    await waitJob(await service.call('aiui_glasses_app_action', { serial, packageName, action: 'stop' }));
  });
  await check('真机新建目录、特殊文件名导入导出与字节核对', async () => {
    await service.glasses.mkdir({ serial, directory: '/sdcard/Download', name: path.posix.basename(remote) }); createdFolder = true;
    const file = path.join(home, "中文 test ' $(not-run).txt"), contents = Buffer.from('AIUI Workbench transfer verification\n中文内容\ntoken=literal-file-content\n'); await fs.writeFile(file, contents);
    await waitJob(await service.call('aiui_glasses_push', { serial, files: [file], directory: remote }));
    const listing = await service.glasses.files({ serial, path: remote }); assert.equal(listing.entries[0].name, path.basename(file));
    assert.equal((await service.glasses.readFile({ serial, path: listing.entries[0].path })).content, contents.toString());
    const pulled = await waitJob(await service.call('aiui_glasses_pull', { serial, path: listing.entries[0].path }));
    assert.deepEqual(await fs.readFile(pulled.path), contents);
    const duplicate = await service.call('aiui_glasses_push', { serial, files: [file], directory: remote });
    await waitFor(() => service.jobs.get(duplicate.id).status !== 'running');
    assert.equal(service.jobs.get(duplicate.id).status, 'failed');
    assert.match(service.jobs.get(duplicate.id).error, /同名文件/);
    const dropped = path.join(home, 'dragged document.txt'); await fs.writeFile(dropped, 'dropped into the selected folder');
    await page.getByRole('tab', { name: '文件', exact: true }).click();
    await page.locator('.glasses-file-table tbody tr').first().waitFor();
    await page.getByLabel('眼镜目录路径').fill(remote); await page.getByLabel('眼镜目录路径').press('Enter');
    await page.locator('.glasses-filename').filter({ hasText: path.basename(file) }).waitFor();
    const previous = service.jobs.list().filter(job => job.type === 'glasses-push').length;
    await dropFile(page, '.glasses-files', dropped);
    await waitFor(() => service.jobs.list().filter(job => job.type === 'glasses-push').length > previous);
    await waitJob(service.jobs.list().find(job => job.type === 'glasses-push'));
    assert.equal((await service.glasses.readFile({ serial, path: remote + '/dragged document.txt' })).content, 'dropped into the selected folder');
  });
  await check('真实屏幕截图、日志导出和重启确认取消', async () => {
    await page.getByRole('tab', { name: '常用工具', exact: true }).click();
    await page.getByRole('button', { name: '截图', exact: true }).click();
    await page.getByAltText('真实眼镜截图').waitFor();
    await page.getByRole('button', { name: '读取并导出', exact: true }).click();
    await page.locator('.glasses-log-output').waitFor();
    await page.screenshot({ path: path.join(output, '05-utilities.png') });
    await page.getByRole('button', { name: '重启眼镜', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
  });
  await check('客户端使用内置组件打开投屏，停止后设备仍可继续使用', async () => {
    await page.getByRole('tab', { name: '真机投屏', exact: true }).click();
    await page.getByRole('button', { name: '打开真机投屏', exact: true }).click();
    await page.getByText('眼镜正在投屏', { exact: true }).waitFor();
    const session = (await service.call('aiui_glasses_mirror_status', { serial })).session;
    assert.equal(session.status, 'running'); assert.match(session.output, /Texture/);
    await page.screenshot({ path: path.join(output, '08-live-mirroring.png') });
    await page.getByRole('button', { name: '停止投屏', exact: true }).click();
    await page.getByText('把眼镜画面带到电脑上', { exact: true }).waitFor();
  });
  await check('清空数据确认与卸载确认只作用于临时测试应用', async () => {
    await page.getByRole('tab', { name: '应用', exact: true }).click();
    await page.getByLabel('搜索应用包名').fill(packageName);
    await page.locator('.glasses-app-list button').filter({ hasText: packageName }).click();
    await page.getByRole('button', { name: '清空应用数据', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await service.glasses.shell(serial, ['run-as', packageName, 'cat', 'files/qa-marker']), 'preserved');
    await page.getByRole('button', { name: '清空应用数据', exact: true }).click();
    await page.getByRole('button', { name: '确认清空数据', exact: true }).click();
    await waitFor(() => service.jobs.list().some(job => job.type === 'glasses-app' && job.result?.action === 'clear' && job.status === 'succeeded'));
    await page.getByRole('button', { name: '卸载应用', exact: true }).click();
    await page.getByRole('button', { name: '确认卸载', exact: true }).click();
    await waitFor(async () => !(await service.glasses.apps({ serial })).packages.some(item => item.packageName === packageName)); installed = false;
  });
  await check('英文界面在最小桌面尺寸下无横向溢出', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 740));
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.getByRole('heading', { name: 'Storage', exact: true }).waitFor();
    assert.equal(await page.locator('.content').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.screenshot({ path: path.join(output, '06-english-1080.png') });
  });
  await check('Web 版共用设备工具并能流式导入 APK', async () => {
    web = await startWeb({ home }); browser = await chromium.launch({ executablePath: process.env.AIUI_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const webPage = await browser.newPage({ viewport: { width: 1440, height: 940 } }); await webPage.goto(web.url);
    await webPage.getByRole('button', { name: '切换到中文', exact: true }).click();
    await webPage.getByRole('button', { name: '眼镜工具', exact: true }).click();
    await webPage.getByRole('heading', { name: '存储空间', exact: true }).waitFor();
    await webPage.getByRole('tab', { name: '安装 APK', exact: true }).click();
    const fileChooser = webPage.waitForEvent('filechooser');
    await webPage.getByRole('button', { name: '选择 APK 文件', exact: true }).click();
    await (await fileChooser).setFiles(apk);
    await webPage.getByText('workbench QA.apk', { exact: true }).waitFor();
    await webPage.screenshot({ path: path.join(output, '07-web-apk.png') });
    await dropFile(webPage, '.glasses-apk-picker', apk);
    await waitFor(async () => await webPage.locator('.glasses-apk-picker').isEnabled());
    assert.equal(await webPage.locator('.glasses-apk-list>div').count(), 1);
  });
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  if (installed) await service.glasses.appAction({ serial, packageName, action: 'uninstall', confirmPackage: packageName }).catch(error => { report.cleanupError = error.message; });
  if (createdFolder && /^\/sdcard\/Download\/aiui-workbench-qa-[\da-f-]+$/.test(remote)) await service.glasses.shell(serial, ['rm', '-rf', '--', remote]).catch(error => { report.cleanupError = error.message; });
  report.cleanedUp = !(await service.glasses.apps({ serial })).packages.some(item => item.packageName === packageName);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await web?.close(); await app?.close(); await daemon.close();
}
