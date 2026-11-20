import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright';
import { startDaemon } from '../core/daemon.mjs';
import { startWeb } from '../web/server.mjs';
import { parseDevices } from '../core/devices.mjs';
import { ROOT } from '../core/util.mjs';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-wireless-ui-'));
const output = process.env.AIUI_QA_OUTPUT || path.join(ROOT, 'output/qa/wireless');
await fs.mkdir(output, { recursive: true });
const daemon = await startDaemon(home), service = daemon.service;
await service.knowledge.settings({ autoUpdate: false });
const ip = '192.168.1.24', address = ip + ':40123';
const ready = { developerMode: 'enabled', runtimeReady: true };
const state = { devices: '', mdns: '', peers: [], pairError: '', wifi: '', legacy: true, calls: [] };
service.wirelessSetup.findPeers = async ({ active }) => {
  if (active && state.scanGate) await state.scanGate();
  return active && state.uncached ? state.uncached : state.peers;
};
service.wirelessHelper.interfaces = () => [{ address: '127.0.0.1' }];
const pairingService = 'adb-QA123-abc _adb-tls-pairing._tcp ' + ip + ':37123';
const connectService = 'adb-QA123-def _adb-tls-connect._tcp ' + address;
async function connectionMethod(page, method) {
  await page.locator('.device-connection-methods .connection-method-tabs').getByRole('tab').nth(method === 'usb' ? 1 : 0).click();
}
async function advanced(page) {
  const details = page.locator('.wireless-advanced');
  if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
}
service.wireless.trust = async (_adb, serial, options) => {
  state.trustCalls = [...(state.trustCalls || []), { serial, ...options }];
  return { supported: true, revoked: true, remainingCount: 0 };
};
const row = serial => serial + ' device model:RG_glasses transport_id:1\n';
service.adb.execute = async args => {
  state.calls.push([...args]);
  if (args[0] === 'server-status') return { code: state.legacy ? 1 : 0, output: state.legacy ? 'error: unknown host service' : 'version: "37.0.1"\n' };
  if (args[0] === 'kill-server') { state.legacy = false; return { code: 0, output: '' }; }
  if (args[0] === 'start-server') return { code: 0, output: '' };
  if (args[0] === 'mdns') return { code: 0, output: 'List of discovered mdns services\n' + state.mdns };
  if (args[0] === 'devices') return { code: 0, output: 'List of devices attached\n' + state.devices };
  if (args[0] === 'pair') return { code: 0, output: state.pairError || 'Successfully paired to ' + args[1] };
  if (args[0] === 'connect' && state.awaitingApproval) { state.devices = args[1] + ' unauthorized transport_id:1'; return { code: 0, output: 'failed to authenticate to ' + args[1] }; }
  if (args[0] === 'connect') { state.devices = row(args[1]); return { code: 0, output: 'connected to ' + args[1] }; }
  if (args[0] === 'disconnect') { state.devices = state.devices.split('\n').filter(line => line.split(/\s/)[0] !== args[1]).join('\n'); return { code: 0, output: 'disconnected ' + args[1] }; }
  if (args[2] === 'tcpip') return { code: 0, output: 'restarting in TCP mode port: 5555' };
  if (args[3] === 'getprop') return { code: 0, output: 'QA123' };
  if (args[3] === 'ip') return { code: 0, output: state.wifi };
  throw new Error('Unexpected fake ADB command: ' + JSON.stringify(args));
};
service.devices.check = async () => ({ adb: true, aix: true, node: process.version, devices: parseDevices(state.devices).map(device => ({ ...device, inspection: ready })), checkedAt: new Date().toISOString() });
// Simulated transport responses exercise the real service and UI, without
// changing any connected glasses or confusing these checks with hardware QA.
const report = { simulatedTransport: true, deviceActionsPerformed: false, checks: [], errors: [] };
let app, browser, web;
async function check(name, work) { await work(); report.checks.push(name); console.log('PASS', name); }
async function refresh(page) { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); }
async function until(read) { const end = Date.now() + 10000; while (Date.now() < end) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out waiting for state'); }
async function englishOnly(page) {
  const text = await page.locator('.wireless-connection').innerText();
  assert.ok(!/[\u3400-\u9fff]/.test(text), text);
}
try {
  app = await electron.launch({ args: [ROOT], cwd: ROOT, env: { ...process.env, AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
  await check('an older ADB server is detected and repaired with one explicit button', async () => {
    await page.getByRole('heading', { name: '电脑的连接工具需要重启' }).waitFor();
    for (const job of service.jobs.list().filter(job => job.status === 'running')) {
      console.log('Stopping isolated background job', job.type);
      service.jobs.cancel(job.id);
    }
    await page.getByRole('button', { name: '重启连接工具', exact: true }).click();
    try { await page.locator('.wireless-result').filter({ hasText: '连接工具已重启' }).waitFor({ timeout: 10000 }); }
    catch { throw new Error('Repair result: ' + (await page.locator('.wireless-result').allInnerTexts()).join(' | ')); }
    assert.ok(state.calls.some(args => args[0] === 'kill-server'));
    assert.equal(service.wireless.server.state, 'ready');
  });
  await check('first use offers one Wi-Fi action, without a camera or a settings requirement', async () => {
    await page.locator('.sidebar').getByRole('button', { name: '新手指南', exact: true }).click();
    await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
    await page.getByRole('button', { name: '一键连接眼镜', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '一键清空', exact: true }).count(), 0);
    assert.equal(await page.locator('.wireless-next-action .button.primary:visible').count(), 1);
    assert.doesNotMatch(await page.locator('.wireless-next-action').innerText(), /扫码|二维码|开发者选项/);
    await page.locator('.wireless-connection').screenshot({ path: path.join(output, 'first-use.png') });
    await page.getByRole('button', { name: '用手机安装无线助手', exact: true }).click();
    await page.getByRole('img', { name: '用手机扫码打开无线助手下载页' }).waitFor();
    await page.locator('.wireless-connection').screenshot({ path: path.join(output, 'phone-installer.png') });
    const manager = service.wirelessHelper;
    const share = [...manager.sessions.values()][0];
    const origin = 'http://127.0.0.1:' + share.servers[0].address().port;
    const phoneURL = origin + '/' + share.id + '/';
    assert.equal((await fetch(phoneURL, { method: 'HEAD' })).status, 200);
    assert.equal(manager.status(share.id).stage, 'waiting');
    browser ||= await chromium.launch({ executablePath: process.env.AIUI_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'zh-CN', acceptDownloads: true });
    await phone.goto(phoneURL);
    await phone.getByRole('heading', { name: '把无线助手装到眼镜上' }).waitFor();
    await page.getByText('下载页已打开，请在手机上点「下载 APK」。').waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-download-page.png') });
    const [download] = await Promise.all([phone.waitForEvent('download'), phone.getByRole('link', { name: '下载 APK' }).click()]);
    const release = JSON.parse(await fs.readFile(path.join(ROOT, 'assets/wireless-helper/manifest.json'), 'utf8'));
    assert.equal(download.suggestedFilename(), 'aiui-wireless-helper-' + release.version + '.apk');
    assert.deepEqual(await fs.readFile(await download.path()), await fs.readFile(path.join(ROOT, 'assets/wireless-helper/aiui-wireless-helper.apk')));
    await page.getByRole('heading', { name: '安装包已发送，请在 Rokid AI 中安装' }).waitFor();
    assert.equal((await fetch(origin + '/api/status')).status, 404);
    await phone.close();
    await page.getByRole('button', { name: '输入眼镜上的六位配对码', exact: true }).click();
    await page.locator('.wireless-guided-pair').getByLabel('配对地址', { exact: true }).waitFor();
    assert.equal(manager.sessions.has(share.id), false);
    await page.locator('.sidebar').getByRole('button', { name: '新手指南', exact: true }).click();
    await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
    await page.getByRole('button', { name: '一键连接眼镜', exact: true }).click();
    await page.getByRole('img', { name: '用手机扫码打开无线助手下载页' }).waitFor();
  });
  await check('a newly online wireless transport dismisses the phone guide without asking for a code', async () => {
    state.devices = row(address);
    await refresh(page);
    await page.getByRole('heading', { name: '眼镜已通过 Wi-Fi 连接', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '输入眼镜上的六位配对码', exact: true }).count(), 0);
    await until(() => service.wirelessHelper.sessions.size === 0);
    state.devices = '';
    await refresh(page);
    await page.getByRole('button', { name: '一键连接眼镜', exact: true }).waitFor();
  });
  await check('one click connects one new endpoint only while the setup page is still open', async () => {
    const target = '10.36.18.47:5555';
    state.uncached = [{ address: target, host: '10.36.18.47', type: 'legacy', name: '', source: 'neighbor' }];
    const guide = page.locator('.sidebar').getByRole('button', { name: '新手指南', exact: true });
    const connect = page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true });
    const start = page.getByRole('button', { name: '一键连接眼镜', exact: true });
    let finishScan;
    state.scanGate = () => new Promise(resolve => { finishScan = resolve; });
    await guide.click(); await connect.click(); await start.click();
    await until(() => finishScan);
    await guide.click(); state.scanGate = null; finishScan();
    await connect.click(); await start.click();
    await page.getByRole('heading', { name: '眼镜已通过 Wi-Fi 连接', exact: true }).waitFor();
    assert.deepEqual(state.calls.filter(args => args[0] === 'connect').map(args => args[1]), [target]);
    state.uncached = null;
    await advanced(page);
    await page.getByRole('button', { name: '一键清空', exact: true }).click();
    await start.waitFor();
  });
  await check('two uncached candidates on another subnet need a choice; approval proceeds without a second click', async () => {
    const callsBefore = state.calls.length;
    const first = '10.63.19.73:47181', target = '172.26.15.82:5555';
    state.uncached = [first, target].map(address => ({ address, host: address.split(':')[0], type: 'legacy', name: '', source: 'neighbor' }));
    // These selected targets would enter the OS neighbor cache during a probe.
    state.peers = [];
    await page.locator('.sidebar').getByRole('button', { name: '新手指南', exact: true }).click();
    await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
    await page.getByRole('button', { name: '一键连接眼镜', exact: true }).click();
    state.peers = state.uncached;
    const selected = page.locator('.wireless-next-action .wireless-device').filter({ hasText: target });
    await selected.waitFor();
    assert.equal(service.wirelessHelper.sessions.size, 0);
    assert.ok(!state.calls.slice(callsBefore).some(args => args[0] === 'connect'));
    state.awaitingApproval = true;
    await selected.getByRole('button', { name: '一键连接眼镜' }).click();
    await page.getByRole('heading', { name: '戴上眼镜，点“允许调试”' }).waitFor();
    assert.equal(service.wireless.records.length, 0);
    state.awaitingApproval = false;
    state.devices = row(target);
    await page.getByRole('heading', { name: '眼镜已通过 Wi-Fi 连接', exact: true }).waitFor();
    assert.deepEqual(state.calls.slice(callsBefore).filter(a => a[0] === 'connect').map(a => a[1]), [target]);
    assert.equal(service.wireless.records[0].address, target);
    state.peers = []; state.uncached = null;
    state.mdns = pairingService + '\n' + connectService;
    await advanced(page);
    await page.getByRole('button', { name: '一键清空', exact: true }).click();
    await page.getByRole('heading', { name: '输入眼镜上的六位配对码' }).waitFor();
    await page.locator('.wireless-connection').screenshot({ path: path.join(output, 'pairing.png') });
  });
  await check('one pairing action connects the separate port and clears the secret', async () => {
    await page.getByLabel('六位配对码', { exact: true }).fill('483926');
    await page.getByRole('button', { name: '配对并连接', exact: true }).click();
    await page.locator('.wireless-result').filter({ hasText: '无线连接已确认' }).waitFor();
    await advanced(page);
    await page.getByRole('button', { name: '使用配对码', exact: true }).click();
    assert.equal(await page.getByLabel('六位配对码', { exact: true }).inputValue(), '');
    await page.locator('.wireless-saved').getByText('无线已连接', { exact: false }).waitFor();
    assert.ok(state.calls.some(args => args[0] === 'connect' && args[1] === address));
  });
  await check('an expired code shows actionable recovery without an IPC wrapper or secret', async () => {
    await advanced(page);
    state.pairError = 'error: wrong pairing code 483926';
    await page.getByLabel('六位配对码', { exact: true }).fill('483926');
    await page.getByRole('button', { name: '配对并连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '配对未完成' }).waitFor();
    const error = await page.locator('.wireless-result').innerText();
    assert.ok(!error.includes('483926') && !error.includes('workbench:call'));
    assert.equal(await page.getByLabel('六位配对码', { exact: true }).inputValue(), '');
    state.pairError = '';
  });
  await check('pairing without mDNS asks for the connection address and a direct connection completes it', async () => {
    state.mdns = ''; state.devices = ''; service.wireless.records = [];
    await page.getByLabel('六位配对码', { exact: true }).fill('483926');
    await page.getByRole('button', { name: '配对并连接', exact: true }).click();
    await page.getByLabel('无线调试地址', { exact: true }).waitFor();
    await page.locator('.wireless-result').filter({ hasText: '配对已完成，正在寻找调试连接' }).waitFor();
    await page.getByLabel('无线调试地址', { exact: true }).fill(address);
    await page.locator('.wireless-content').getByRole('button', { name: '连接眼镜', exact: true }).click();
    await page.getByRole('heading', { name: '眼镜已通过 Wi-Fi 连接', exact: true }).waitFor();
  });
  await check('USB handoff requests Wi-Fi before enabling TCP and verifies before allowing unplug', async () => {
    state.devices = row('QA123');
    service.wireless.records = [];
    await refresh(page);
    await page.getByRole('heading', { name: '把已连接的眼镜切换到无线', exact: true }).waitFor();
    await page.getByRole('button', { name: '用手机安装无线助手', exact: true }).click();
    await page.getByRole('img', { name: '用手机扫码打开无线助手下载页' }).waitFor();
    await page.locator('.sidebar').getByRole('button', { name: '新手指南', exact: true }).click();
    await page.locator('.sidebar').getByRole('button', { name: '连接眼镜', exact: true }).click();
    await advanced(page);
    await page.getByRole('button', { name: '插一次线准备', exact: true }).click();
    const button = page.getByRole('button', { name: '一键切换无线', exact: true });
    await button.click();
    await page.locator('.wireless-result').filter({ hasText: '眼镜尚未连接 Wi-Fi' }).waitFor();
    assert.ok(!state.calls.some(args => args[2] === 'tcpip'));
    state.wifi = '3: wlan0 inet ' + ip + '/24';
    await button.click();
    await page.locator('.wireless-result').filter({ hasText: '无线连接已确认' }).waitFor();
    await page.getByRole('heading', { name: '眼镜已就绪', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'connected.png'), fullPage: true });
  });
  await check('all wireless paths and the revised beginner guide work in English at a compact width', async () => {
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await advanced(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1080, 800));
    for (const name of ['Discover devices', 'Pair with a code', 'Enter an address', 'Set up once over USB']) {
      await page.getByRole('button', { name, exact: true }).click();
      await englishOnly(page);
    }
    await page.screenshot({ path: path.join(output, 'compact-english.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.sidebar').getByRole('button', { name: 'Getting started', exact: true }).click();
    await page.getByRole('tab', { name: 'Install on glasses', exact: true }).click();
    await page.getByRole('heading', { name: 'Install apps on glasses over Wi-Fi', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Wired connection', exact: true }).click();
    assert.equal(await page.locator('.setup-steps button').count(), 4);
  });
  await check('the authenticated Web client uses the same wireless records and tools', async () => {
    web = await startWeb({ home, open: async () => {} });
    browser ||= await chromium.launch({ executablePath: process.env.AIUI_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const webPage = await browser.newPage();
    webPage.on('pageerror', error => report.errors.push(error.message));
    await webPage.goto(web.url);
    await webPage.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await webPage.locator('.sidebar').getByRole('button', { name: 'Connect glasses', exact: true }).click();
    await webPage.getByRole('heading', { name: 'Glasses connected over Wi-Fi' }).waitFor();
    await advanced(webPage);
    await webPage.locator('.wireless-saved').getByText('Connected over Wi-Fi', { exact: false }).waitFor();
    await englishOnly(webPage);
    await check('one clear action resets the form and cannot be overwritten by an older environment read', async () => {
      await until(() => webPage.getByRole('button', { name: 'Clear all', exact: true }).isEnabled());
      const environmentCheck = service.environmentCheck.bind(service);
      let release, stall = true;
      service.environmentCheck = async () => {
        const snapshot = await environmentCheck();
        if (stall) { stall = false; await new Promise(resolve => { release = resolve; }); }
        return snapshot;
      };
      await refresh(webPage);
      await until(() => release);
      await webPage.getByRole('button', { name: 'Clear all', exact: true }).click();
      await webPage.locator('.wireless-result').filter({ hasText: 'Workshop Wi-Fi records are cleared' }).waitFor();
      release();
      await webPage.getByRole('heading', { name: 'Waiting for glasses', exact: true }).waitFor();
      assert.equal(await webPage.locator('.wireless-saved').count(), 0);
      assert.equal(state.trustCalls, undefined);
      await advanced(webPage);
      await webPage.getByRole('button', { name: 'Enter an address', exact: true }).click();
      assert.equal(await webPage.getByLabel('Wireless debugging address', { exact: true }).inputValue(), '');
      service.environmentCheck = environmentCheck;
    });
    await check('full reset revokes the selected glasses authorization and returns to first connection', async () => {
      await webPage.getByLabel('Wireless debugging address', { exact: true }).fill(ip + ':5555');
      await webPage.locator('.wireless-content').getByRole('button', { name: 'Connect glasses', exact: true }).click();
      await webPage.getByRole('heading', { name: 'Glasses connected over Wi-Fi' }).waitFor();
      await advanced(webPage);
      await webPage.locator('.wireless-saved').getByText('Connected over Wi-Fi', { exact: false }).waitFor();
      await webPage.getByRole('button', { name: 'Pair with a code', exact: true }).click();
      await webPage.getByLabel('Pairing address', { exact: true }).fill(ip + ':37123');
      await webPage.getByLabel('Six-digit pairing code', { exact: true }).fill('483926');
      await webPage.getByRole('checkbox', { name: 'Start pairing from scratch: also revoke ADB authorization on the selected glasses', exact: true }).check();
      await webPage.getByRole('button', { name: 'Clear all', exact: true }).click();
      await webPage.locator('.wireless-result').filter({ hasText: 'all ADB authorization on the selected glasses has been revoked' }).waitFor();
      await webPage.getByRole('heading', { name: 'Waiting for glasses', exact: true }).waitFor();
      assert.equal(await webPage.locator('.wireless-saved').count(), 0);
      assert.deepEqual(state.trustCalls, [{ serial: ip + ':5555', revoke: true }]);
      await advanced(webPage);
      await webPage.getByRole('button', { name: 'Pair with a code', exact: true }).click();
      assert.equal(await webPage.getByLabel('Pairing address', { exact: true }).inputValue(), '');
      assert.equal(await webPage.getByLabel('Six-digit pairing code', { exact: true }).inputValue(), '');
      await englishOnly(webPage);
      await webPage.screenshot({ path: path.join(output, 'cleared-english.png'), fullPage: true });
    });
  });
  await check('guided QR pairing expires, cancels on exit and verifies the matching scan before showing usage steps', async () => {
    await service.call('aiui_project_create', { directory: path.join(home, 'guide-example'), name: 'Example app' });
    const guideShot = async (locale, step, target) => {
      if (['overview', 'usb'].includes(step)) target = page.locator('.device-connection-methods');
      // Expand the scrolling content only for an unclipped documentation capture.
      // Mask the temporary download code so examples never contain an expired link.
      const style = await page.addStyleTag({ content: '.app-shell{height:auto!important;overflow:visible!important}.main-shell{height:auto!important}.content{overflow:visible!important;flex:none!important}.statusbar,.toast{display:none!important}' });
      try {
        await page.locator('.content').evaluate(el => { el.scrollTop = 0; });
        const options = step === 'install' ? { mask: [page.locator('.wireless-qr')], maskColor: '#ececea' } : {};
        await target.screenshot({ ...options, path: path.join(output, locale + '-' + step + '.png') });
        if (process.argv.includes('--update-guides')) {
          const directory = path.join(ROOT, 'assets/connection-guide', locale);
          await fs.mkdir(directory, { recursive: true });
          await target.screenshot({ ...options, path: path.join(directory, step + '.png') });
        }
      } finally { await style.evaluate(el => el.remove()); }
    };
    for (const locale of ['zh-CN', 'en']) {
      await service.wireless.reset({}); state.devices = ''; state.mdns = '';
      await page.getByRole('button', { name: locale === 'en' ? 'Switch to English' : '切换到中文', exact: true }).click();
      const zh = locale === 'zh-CN';
      const nav = label => page.locator('.sidebar').getByRole('button', { name: label, exact: true });
      await nav(zh ? '新手指南' : 'Getting started').click();
      await nav(zh ? '连接眼镜' : 'Connect glasses').click();
      await connectionMethod(page, 'wireless');
      await page.getByRole('button', { name: zh ? '一键连接眼镜' : 'Connect glasses', exact: true }).waitFor();
      await guideShot(locale, 'overview', page.locator('.wireless-connection'));
      await page.getByRole('button', { name: zh ? '用手机安装无线助手' : 'Install Wireless Setup with your phone', exact: true }).click();
      await page.locator('.wireless-download-card img').waitFor();
      await guideShot(locale, 'install', page.locator('.wireless-connection'));
      const share = [...service.wirelessHelper.sessions.values()][0];
      const url = 'http://127.0.0.1:' + share.servers[0].address().port + '/' + share.id + '/';
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, locale: zh ? 'en-US' : 'zh-CN' });
      await phone.goto(url);
      assert.equal(await phone.locator('html').getAttribute('lang'), locale);
      await phone.screenshot({ path: path.join(output, locale + '-phone-page.png'), fullPage: true });
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await phone.close();
      await page.getByRole('button', { name: zh ? '输入眼镜上的六位配对码' : 'Enter the six-digit code on your glasses', exact: true }).click();
      await page.locator('.wireless-guided-pair').waitFor();
      await guideShot(locale, 'pair', page.locator('.wireless-connection'));
      if (!zh) await englishOnly(page);
      const qrButton = page.getByRole('button', { name: zh ? '二维码配对' : 'QR pairing', exact: true });
      service.wirelessQr.lifetime = 1600;
      await qrButton.click();
      await page.getByRole('img', { name: zh ? '眼镜无线调试配对二维码' : 'Wireless debugging pairing QR for the glasses', exact: true }).waitFor();
      await page.getByText(zh ? '配对二维码已过期，请重新生成。' : 'The pairing QR has expired. Generate a new one.', { exact: true }).waitFor();
      service.wirelessQr.lifetime = 120000;
      await page.getByRole('button', { name: zh ? '重新生成配对码' : 'Generate a new pairing QR', exact: true }).click();
      await until(() => service.wirelessQr.sessions.size === 1);
      await page.locator('.wireless-connection').screenshot({ path: path.join(output, locale + '-qr-pairing.png') });
      await nav(zh ? '新手指南' : 'Getting started').click();
      await until(() => service.wirelessQr.sessions.size === 0);
      await nav(zh ? '连接眼镜' : 'Connect glasses').click();
      await page.locator('.wireless-already-ready summary').click();
      await qrButton.click();
      await until(() => service.wirelessQr.sessions.size === 1);
      const session = [...service.wirelessQr.sessions.values()][0];
      state.mdns = session.name + ' _adb-tls-pairing._tcp ' + ip + ':37123\n' + connectService;
      await page.getByRole('heading', { name: zh ? '眼镜已通过 Wi-Fi 连接' : 'Glasses connected over Wi-Fi', exact: true }).waitFor();
      await page.getByRole('heading', { name: zh ? '接下来怎么用' : 'What to do next', exact: true }).waitFor();
      await guideShot(locale, 'ready', page.locator('.device-workflow'));
      await guideShot(locale, 'usage', page.locator('.device-usage-guide'));
      if (!zh) await englishOnly(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await service.wireless.reset({}); state.devices = ''; state.mdns = '';
      await refresh(page); await connectionMethod(page, 'usb');
      await page.getByRole('heading', { name: zh ? '通过数据线连接眼镜' : 'Connect glasses with a cable', exact: true }).waitFor();
      assert.equal(await page.locator('.wireless-connection').count(), 0);
      await guideShot(locale, 'usb', page.locator('.wired-connection'));
      state.devices = 'QA123 unauthorized transport_id:1'; await refresh(page);
      await page.getByRole('heading', { name: zh ? '请在眼镜上允许 USB 调试' : 'Allow USB debugging on your glasses', exact: true }).waitFor();
      state.devices = row('QA123'); await refresh(page);
      await page.getByRole('heading', { name: zh ? '眼镜已通过数据线连接' : 'Glasses connected over USB', exact: true }).waitFor();
      await page.getByRole('heading', { name: zh ? '眼镜已就绪' : 'Glasses ready', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: zh ? '安装到眼镜' : 'Install on glasses', exact: true }).isEnabled(), true);
      await guideShot(locale, 'usb-ready', page.locator('.device-workflow'));
      await guideShot(locale, 'usb-usage', page.locator('.device-usage-guide'));
      if (!zh) assert.doesNotMatch(await page.locator('.wired-connection').innerText(), /[\u3400-\u9fff]/);
      await nav(zh ? '新手指南' : 'Getting started').click();
      await nav(zh ? '连接眼镜' : 'Connect glasses').click();
      assert.equal(await page.locator('.device-connection-methods .connection-method-tabs').getByRole('tab').nth(1).getAttribute('aria-selected'), 'true');
      await connectionMethod(page, 'wireless');
    }
    await service.wireless.reset({}); state.devices = ''; state.mdns = '';
    await page.locator('.sidebar').getByRole('button', { name: 'Getting started', exact: true }).click();
    await page.locator('.sidebar').getByRole('button', { name: 'Connect glasses', exact: true }).click();
    await connectionMethod(page, 'wireless');
    await page.locator('.wireless-already-ready summary').click();
    service.wirelessQr.lifetime = 2600;
    await page.getByRole('button', { name: 'QR pairing', exact: true }).click();
    await until(() => service.wirelessQr.sessions.size === 1);
    const pending = [...service.wirelessQr.sessions.values()][0];
    state.mdns = pending.name + ' _adb-tls-pairing._tcp ' + ip + ':37123';
    const enterAddress = page.locator('.wireless-next-copy').getByRole('button', { name: 'Enter an address', exact: true });
    await enterAddress.waitFor();
    await page.waitForFunction(expiresAt => Date.now() > expiresAt + 150, pending.expiresAt);
    assert.equal(await enterAddress.isVisible(), true, 'completed pairing remains pending transport after its QR expires');
    assert.equal(await page.getByText('The pairing QR has expired. Generate a new one.', { exact: true }).count(), 0);
  });
  assert.deepEqual(report.errors, []);
} finally {
  await browser?.close();
  await web?.close();
  await app?.close();
  await daemon.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(home, { recursive: true, force: true });
}
