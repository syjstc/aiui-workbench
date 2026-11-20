import { redact } from './util.mjs';

export const ADB_ACCESS_MARKER = 'AIUI_ADB_ACCESS_OK';
export const ROKID_ADB_PROPERTY = 'persist.vendor.adb';
export const ROKID_ADB_STEP = '在手机 Rokid AI → 主页 → 眼镜卡片右侧齿轮 → 开发者，开启「眼镜 ADB 调试」。';
const resume = '完成后重新检查连接，让 AI 继续原任务，无需重新创建项目。';

// On verified Rokid firmware the app gate stays readable through getprop even
// while it closes screencap/input. Android adb_enabled and AIUI developer mode
// are independent. Missing vendor properties must remain unknown.
export function parseRokidAdbGate(output) {
  const properties = Object.fromEntries([...output.matchAll(/^\[([^\]]+)\]: \[(.*)\]\r?$/gm)].map(match => [match[1], match[2]]));
  const rokid = [properties['ro.product.brand'], properties['ro.product.manufacturer']].some(value => /^rokid$/i.test(value || ''));
  const value = properties[ROKID_ADB_PROPERTY];
  const state = rokid && /^(?:true|1)$/.test(value || '') ? 'enabled' : rokid && /^(?:false|0)$/.test(value || '') ? 'disabled' : 'unknown';
  return { state, ...(rokid ? { property: ROKID_ADB_PROPERTY, value: value || '', model: properties['ro.product.model'] || '', firmware: properties['ro.build.version.incremental'] || '' } : {}) };
}

export async function readRokidAdbGate(execute, device) {
  try {
    const result = await execute('adb', ['-s', device.serial, 'shell', 'getprop'], { timeout: 4000 });
    if (result.code === 0) return parseRokidAdbGate(result.output);
  } catch {}
  return { state: 'unknown' };
}

export function adbAccessDiagnostic(state, { serial, connection, evidence = '', rokidAppAdb = { state: 'unknown' } } = {}) {
  const messages = {
    available: rokidAppAdb.state === 'enabled' ? 'ADB 基本命令可用，Rokid App 的「眼镜 ADB 调试」已开启；具体操作仍以执行结果为准。' : 'ADB 基本命令可用；Rokid App 的操作开关状态尚未确认。',
    'rokid-adb-disabled': 'ADB 已连接，但 Rokid App 的「眼镜 ADB 调试」已关闭；请开启后再执行截图、投屏或遥控。',
    missing: '尚未发现可用的眼镜连接，可能是手机 Rokid AI 的「眼镜 ADB 调试」未开启，也可能是眼镜未开机、网络或数据线未连接。',
    unauthorized: connection === 'wireless' ? '眼镜尚未授权无线调试，请在眼镜上允许连接或完成配对。' : '眼镜尚未授权 USB 调试，请在眼镜上确认「允许 USB 调试」。',
    offline: '眼镜处于离线状态，请检查连接，并确认手机 Rokid AI 的「眼镜 ADB 调试」已开启。',
    restricted: '眼镜拒绝了 ADB 命令。请先检查手机 Rokid AI 的「眼镜 ADB 调试」；若已开启，还需核对当前命令、文件路径或 Android 权限。',
    unavailable: 'ADB 命令通道暂不可用。请检查手机 Rokid AI 的「眼镜 ADB 调试」、眼镜授权及当前连接。',
    'tool-unavailable': '电脑上的 ADB 连接工具暂不可用，请检查工坊安装包；这不能证明手机的调试开关已关闭。',
  };
  const message = messages[state];
  if (!message) throw new Error('Unknown ADB access state: ' + state);
  const steps = state === 'rokid-adb-disabled' ? [ROKID_ADB_STEP, '这是 Rokid App 的独立操作开关，Android USB 调试和 AIUI 开发者模式不能代替它。', resume]
    : state === 'tool-unavailable' ? ['确认使用完整的工坊安装包，重新打开工坊。', resume]
    : state === 'unauthorized' ? [message, ROKID_ADB_STEP, '也可用 Rokid AI → 工具箱 → 遥控器确认眼镜上的授权提示。', resume]
    : [ROKID_ADB_STEP, ...(state === 'restricted' ? ['若开关已开启，检查本次操作所需的 Android 权限和目标路径；单个文件不可访问不代表 ADB 被关闭。'] : ['无线连接需眼镜与电脑使用可互访的 Wi-Fi；有线连接需支持数据传输的调试线。', '眼镜出现调试授权提示时，请确认允许。']), resume];
  return {
    state, ...(serial ? { serial } : {}), rokidAppAdb, phoneAdbSwitch: rokidAppAdb.state === 'enabled' ? 'on' : rokidAppAdb.state === 'disabled' ? 'off' : 'unknown',
    message, ...(evidence ? { evidence: redact(evidence).slice(-2000) } : {}),
    ...(state === 'available' ? {} : { recovery: {
      code: state === 'rokid-adb-disabled' ? state : 'adb-' + state, category: 'device-connection', owner: 'user',
      title: state === 'rokid-adb-disabled' ? '请开启 Rokid App 的眼镜 ADB 调试' : state === 'unauthorized' ? '请在眼镜上允许连接' : state === 'tool-unavailable' ? '请检查工坊安装' : '请检查眼镜 ADB 调试与连接',
      message, steps, view: 'devices', resumeSameWorkflow: true,
      recheck: { tool: 'aiui_environment_check', arguments: {} },
    } }),
  };
}

export function adbFailureState(message) {
  if (/cannot connect to daemon|failed to start daemon|ADB server.*(?:didn't ACK|out of date)|failed to bind.*(?:5037|ADB)/i.test(message)) return 'tool-unavailable';
  if (/unauthorized|not authorized|authentication|允许.*调试|尚未授权/i.test(message)) return 'unauthorized';
  if (/\boffline\b|离线/i.test(message)) return 'offline';
  if (/device[^\r\n]*(?:not found|not online)|no (?:online[^\r\n]*|devices?[^\r\n]*)?(?:device|emulator)|眼镜.*断开|未发现眼镜/i.test(message)) return 'missing';
  if (/permission denied|operation not permitted|not allowed|SecurityException|access denied|拒绝/i.test(message)) return 'restricted';
  if (/\bclosed\b|\bdisconnected\b|connection (?:reset|refused)|cannot connect|connect failed|眼镜操作超时|眼镜操作失败.*连接/i.test(message)) return 'unavailable';
  return null;
}

export function withAdbRecovery(error, context = {}) {
  if (error.name === 'AbortError') return error;
  if (error.deviceDiagnostic) {
    if (!context.rokidAppAdb || context.rokidAppAdb.state === 'unknown') return error;
    error.message = error.deviceDiagnostic.evidence || error.message;
  }
  if (!context.state && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return error;
  const state = context.rokidAppAdb?.state === 'disabled' ? 'rokid-adb-disabled' : context.state || adbFailureState(error.message);
  if (!state) return error;
  const diagnostic = adbAccessDiagnostic(state, { ...context, evidence: error.message });
  error.deviceDiagnostic = diagnostic;
  error.recovery = diagnostic.recovery;
  error.message += '\n' + diagnostic.message + (state === 'tool-unavailable' ? '' : '\n' + ROKID_ADB_STEP);
  return error;
}

export async function probeAdbAccess(execute, device) {
  const rokidAppAdb = await readRokidAdbGate(execute, device);
  if (rokidAppAdb.state === 'disabled') return adbAccessDiagnostic('rokid-adb-disabled', { ...device, rokidAppAdb, evidence: ROKID_ADB_PROPERTY + '=' + rokidAppAdb.value });
  let result;
  try {
    result = await execute('adb', ['-s', device.serial, 'shell', 'printf', ADB_ACCESS_MARKER], { timeout: 4000 });
  } catch (error) {
    result = { code: -1, output: error.message };
  }
  const output = result.output.trim();
  return adbAccessDiagnostic(result.code === 0 && output === ADB_ACCESS_MARKER ? 'available' : adbFailureState(output) || 'unavailable', {
    ...device, rokidAppAdb, evidence: result.code === 0 && output === ADB_ACCESS_MARKER ? '' : output,
  });
}

export async function diagnoseAdbFailure(error, device, execute) {
  if (error.name === 'AbortError' || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return error;
  if (error.deviceDiagnostic?.rokidAppAdb && error.deviceDiagnostic.rokidAppAdb.state !== 'unknown') return error;
  const state = error.deviceDiagnostic?.state || adbFailureState(error.message);
  if (!state || state === 'tool-unavailable' || state === 'missing' || state === 'offline' || state === 'unauthorized') return withAdbRecovery(error, device);
  const rokidAppAdb = await readRokidAdbGate(execute, device);
  return withAdbRecovery(error, { ...device, state, rokidAppAdb });
}

export function connectionAdbDiagnostic(environment, devices = environment.devices || []) {
  if (environment.adb === false) return adbAccessDiagnostic('tool-unavailable', { evidence: environment.diagnostics?.adb });
  if (!devices.length) return adbAccessDiagnostic('missing');
  const device = devices.find(d => d.status === 'device' && d.adbAccess?.state === 'available') || devices.find(d => d.status === 'device') || devices[0];
  return device.adbAccess || (device.status === 'device' ? null : adbAccessDiagnostic(device.status === 'unauthorized' ? 'unauthorized' : 'offline', device));
}
