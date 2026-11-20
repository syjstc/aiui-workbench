import fs from 'node:fs/promises';
import path from 'node:path';
import qrcode from 'qrcode-generator';
import { ROOT } from './util.mjs';
import { t } from '../shared/i18n.mjs';
import { connectionAdbDiagnostic, ROKID_ADB_STEP } from './adb-access.mjs';

export async function connectionGuide(workbench, { step = 'overview', method, locale = 'zh-CN', shareHelper = false, includeImages = true } = {}) {
  const environment = await workbench.environmentCheck();
  const allDevices = [...new Map([...(environment.devices || []), ...(environment.usbDevices || [])].map(d => [d.serial, d])).values()];
  const translate = value => t(value, {}, locale);
  const allOnline = allDevices.filter(d => d.status === 'device');
  method ||= allOnline.length && allOnline.every(d => d.connection === 'usb') ? 'usb' : 'wireless';
  const devices = allDevices.filter(d => d.connection === (method === 'usb' ? 'usb' : 'wireless')), online = devices.filter(d => d.status === 'device');
  const diagnostic = connectionAdbDiagnostic(environment, devices);
  const recovery = diagnostic?.recovery && { ...diagnostic.recovery, title: translate(diagnostic.recovery.title), message: translate(diagnostic.recovery.message), steps: diagnostic.recovery.steps.map(translate) };
  const steps = {
    overview: ['让电脑和眼镜连接同一 Wi-Fi 或热点。', '在工坊打开「连接眼镜」，点击「一键连接眼镜」。', '没有找到眼镜时，点击「用手机安装无线助手」，按下载页操作。'],
    install: ['手机和电脑连接同一个 Wi-Fi，用手机相机扫描工坊的手机下载码，点「下载 APK」。', '打开 Rokid AI → 工具箱 → 眼镜应用管理 → 安装新应用，选择刚下载的无线助手 APK。', '打开 Rokid AI → 工具箱 → 遥控器：滑动移动焦点，点击确认，返回键回到上一页。', '在眼镜应用列表打开「AIUI 无线助手」，按按钮进入「无线调试」。'],
    pair: ['在眼镜上开启「无线调试」，选「使用配对码配对设备」，把六位数字填回工坊。', '也可以在工坊选「二维码配对」，用眼镜的「使用二维码配对设备」扫描；没有扫码入口时使用六位码。', '配对码仅用于首次授权。等工坊核实「已连接」，才可继续安装。手机下载码与配对二维码用途不同。'],
    ready: ['在工坊选择项目，点击「安装到眼镜」，完成后点「在眼镜上打开」。', '普通 Android APK 可在 Rokid AI → 工具箱 → 眼镜应用管理 → 安装新应用中安装；AIUI 项目使用工坊安装。', '用 Rokid AI → 工具箱 → 遥控器，或眼镜镜腿操作应用。', '下次保持眼镜开机、连接同一 Wi-Fi 并开启无线调试，工坊会尝试自动重连。'],
  };
  const result = {
    step, method, locale, availableMethods: ['wireless', 'usb'], connected: online.length > 0,
    adbUsable: diagnostic?.state === 'available',
    diagnostic: diagnostic && { ...diagnostic, message: translate(diagnostic.message), ...(recovery ? { recovery } : {}) },
    devices: devices.map(({ serial, name, status, connection }) => ({ serial, name, status, connection })),
    message: translate(recovery ? diagnostic.message : online.length ? '眼镜已连接，可以继续安装和使用。' : '眼镜尚未连接。我可以先完成制作和打包；安装前请按以下步骤连接。'),
    steps: (method === 'usb' ? step === 'ready' ? [...steps.ready.slice(0, 3), '使用期间保持数据线连接，工坊会自动检测断开和恢复。'] : ['在工坊「连接眼镜」选择「有线连接」Tab。', '使用适配当前眼镜型号、支持数据传输的 Rokid 调试线。普通充电线无法完成调试连接。', 'Rokid AI → 主页 → 眼镜卡片右侧齿轮 → 开发者 → 眼镜 ADB 调试。', '连接电脑与眼镜。眼镜弹出「允许 USB 调试」时确认；也可用 Rokid AI 工具箱里的遥控器确认。'] : steps[step]).map(translate),
    nextAction: recovery || { owner: online.length ? 'ai' : 'user', view: 'devices', resumeSameWorkflow: true },
    images: [],
  };
  if (recovery && online.length) result.steps = recovery.steps;
  if (recovery && !online.length && method === 'wireless') result.steps.unshift(translate(ROKID_ADB_STEP));
  if (shareHelper) {
    const helper = await workbench.wirelessHelper.start({ locale });
    result.helper = helper;
    if (helper.urls[0]) {
      const code = qrcode(0, 'M'); code.addData(helper.urls[0]); code.make();
      result.images.push({ mimeType: 'image/gif', data: code.createDataURL(6, 24).split(',')[1], purpose: translate('手机下载码：用手机相机扫描后下载 APK') });
    }
  }
  if (includeImages) {
    for (const name of step === 'ready' ? method === 'usb' ? ['usb-ready', 'usb-usage'] : ['ready', 'usage'] : [method === 'usb' ? 'usb' : step]) {
      const file = path.join(ROOT, 'assets/connection-guide', locale, name + '.png');
      const bytes = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (bytes) result.images.push({ mimeType: 'image/png', data: bytes.toString('base64'), purpose: translate('工坊操作示例截图；连接状态以本次检查为准') });
    }
  }
  return result;
}
