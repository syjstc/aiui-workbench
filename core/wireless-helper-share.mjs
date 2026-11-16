import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import { ROOT, sha } from './util.mjs';
import { networkInterfacesByRoute } from './wireless-network.mjs';

const filename = 'aiui-wireless-helper.apk';
const directory = path.join(ROOT, 'assets/wireless-helper');

function phonePage(english, downloadName) {
  const copy = english ? {
    title: 'Install Wireless Setup on your glasses', download: 'Download APK', app: 'AIUI Wireless Setup',
    intro: 'Keep your phone and computer on the same Wi-Fi while downloading.',
    phone: 'Open Rokid AI on your phone', install: 'Go to Toolbox → Glasses app management → Install new app. Select ' + downloadName + ' from Downloads.',
    glasses: 'Use your phone as a remote', remote: 'In Rokid AI → Toolbox → Remote control, swipe to move the focus, tap to select and use Back to return. You can also use the glasses temple.',
    pair: 'Open Wireless Setup on the glasses', enable: 'Follow its button to Wireless debugging. Turn it on, then choose Pair device with pairing code. Enter the six digits in Workshop on your computer. For QR pairing, open Pair device with QR code on the glasses and scan the pairing QR in Workshop.',
    build: 'Developer options still locked?', unlock: 'Open Device info from the helper. Find Build number, focus that row and tap seven times. Return to the helper and open Wireless debugging. In Developer options, first move the focus to Wireless debugging before tapping.',
    done: 'Back on your computer', finish: 'Wait for Workshop to show Connected. Then select your project, Install on glasses and Open on glasses. An APK download alone does not install the app.',
    help: 'Seeing a clock?', about: 'Go back to Device info. Scroll down to Build number and look for the build identifier. Tapping Android version opens the clock. You can use the remote in the phone Toolbox.',
  } : {
    title: '把无线助手装到眼镜上', download: '下载 APK', app: 'AIUI 无线助手',
    intro: '下载时，让手机和运行工坊的电脑连着同一个 Wi-Fi。',
    phone: '在手机上打开 Rokid AI', install: '进入「工具箱 → 眼镜应用管理 → 安装新应用」，从「下载」中选择 ' + downloadName + '。',
    glasses: '用手机遥控眼镜', remote: '在 Rokid AI → 工具箱 → 遥控器中，滑动移动焦点，点击确认，返回键回到上一页。也可以直接滑动、点击眼镜镜腿。',
    pair: '在眼镜上打开无线助手', enable: '按按钮进入「无线调试」，开启后选「使用配对码配对设备」，将六位数字填回电脑工坊。使用二维码时，在眼镜上选「使用二维码配对设备」，扫描工坊的配对二维码。',
    build: '还没开启开发者选项？', unlock: '从助手打开「设备信息」，找到「版本号」，看到焦点框后连点 7 次。返回助手打开「无线调试」。进入「开发者选项」时，先滑动选中「无线调试」这一行再点。',
    done: '回到电脑，连接后安装你的应用', finish: '等工坊显示已连接，再选择项目，点「安装到眼镜」和「在眼镜上打开」。下载 APK 后，还需要在 Rokid AI 中完成安装。',
    help: '看到时钟图案了？', about: '返回「设备信息」，往下找「版本号」。点「Android 版本」会打开时钟。可以用手机工具箱里的遥控器操作。',
  };
  return Buffer.from(`<!doctype html><html lang="${english ? 'en' : 'zh-CN'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.app}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#faf9f7;color:#262624;font:16px/1.65 system-ui,-apple-system,sans-serif}main{max-width:36rem;margin:auto;padding:clamp(24px,8vw,50px) 22px}h1{font-size:27px;line-height:1.35;margin:0 0 10px}p{margin:0 0 18px;color:#50504d}a{display:inline-block;background:#252524;color:white;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px}ol{margin:32px 0 20px;padding-left:22px}li{padding-left:5px;margin:0 0 22px}strong{display:block;margin-bottom:4px}small,summary{color:#595955}details p{margin:10px 0}a:focus-visible,summary:focus-visible{outline:3px solid #2470b1;outline-offset:3px}</style>
<main><h1>${copy.title}</h1><p>${copy.intro}</p><a href="${downloadName}" download="${downloadName}">${copy.download}</a>
<ol><li><strong>${copy.phone}</strong>${copy.install}</li><li><strong>${copy.glasses}</strong>${copy.remote}</li><li><strong>${copy.pair}</strong>${copy.enable}</li><li><strong>${copy.done}</strong>${copy.finish}</li></ol>
<details><summary>${copy.build}</summary><p>${copy.unlock}</p></details><details><summary>${copy.help}</summary><p>${copy.about}</p></details></main></html>`);
}

export class WirelessHelperShare {
  constructor({ interfaces = networkInterfacesByRoute, lifetime = 10 * 60_000 } = {}) {
    this.interfaces = interfaces; this.lifetime = lifetime; this.sessions = new Map(); this.generation = 0;
  }

  async start({ locale } = {}) {
    const generation = this.generation;
    const file = path.join(directory, filename);
    const [bytes, manifest, adapters] = await Promise.all([fs.readFile(file), fs.readFile(path.join(directory, 'manifest.json'), 'utf8'), this.interfaces()]);
    const release = JSON.parse(manifest);
    if (sha(bytes) !== release.sha256 || !/^\d+(?:\.\d+)*$/.test(release.version)) throw new Error('无线助手安装包校验失败，请重新打开完整的工坊客户端。');
    const downloadName = 'aiui-wireless-helper-' + release.version + '.apk';
    const hosts = [...new Set(adapters.filter(e => isIP(e.address) === 4 ||
      (isIP(e.address) === 6 && !e.scopeid && !e.address.includes('%') && !/^fe[89ab]/i.test(e.address))).map(e => e.address))];
    if (!hosts.length || generation !== this.generation) return { file, urls: [] };
    if (this.sessions.size >= 6) this.stop(this.sessions.keys().next().value);
    const id = randomUUID(), route = '/' + id + '/';
    const share = { id, servers: [], locale, stage: 'waiting', expiresAt: Date.now() + this.lifetime };
    this.sessions.set(id, share);
    const serve = (req, res) => {
      const download = req.url === route + downloadName || req.url === route + filename;
      if (this.sessions.get(id) !== share || Date.now() >= share.expiresAt || (req.url !== route && !download) || !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(404); res.end(); return;
      }
      const english = share.locale ? share.locale === 'en' : /^en\b/i.test(req.headers['accept-language'] || '');
      const body = download ? bytes : phonePage(english, downloadName);
      res.writeHead(200, {
        'Content-Type': download ? 'application/vnd.android.package-archive' : 'text/html; charset=utf-8',
        ...(download ? { 'Content-Disposition': 'attachment; filename="' + downloadName + '"' } : {}),
        'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Connection': 'close', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      if (req.method === 'GET') res.once('finish', () => {
        if (download) share.stage = 'sent';
        else if (share.stage === 'waiting') share.stage = 'opened';
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const urls = (await Promise.all(hosts.map(async host => {
      const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, serve);
      server.maxConnections = 4;
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
        if (this.sessions.get(id) !== share) { server.close(); return null; }
        share.servers.push(server);
        const authority = isIP(host) === 6 ? '[' + host + ']' : host;
        return 'http://' + authority + ':' + server.address().port + route;
      } catch { server.close(); return null; }
    }))).filter(Boolean);
    if (!urls.length || this.sessions.get(id) !== share) { this.stop(id); return { file, urls: [] }; }
    share.timer = setTimeout(() => this.stop(id), this.lifetime);
    share.timer.unref();
    return { id, file, urls, downloadName, ...this.status(id) };
  }

  status(id, locale) {
    const share = this.sessions.get(id);
    if (share && ['zh-CN', 'en'].includes(locale)) share.locale = locale;
    return share && Date.now() < share.expiresAt ? { stage: share.stage, expiresAt: share.expiresAt } : { stage: 'expired' };
  }

  stop(id) {
    if (!id) this.generation++;
    for (const share of id ? [this.sessions.get(id)] : this.sessions.values()) {
      if (!share) continue;
      this.sessions.delete(share.id); clearTimeout(share.timer);
      for (const server of share.servers) { server.closeAllConnections(); server.close(); }
    }
  }
}
