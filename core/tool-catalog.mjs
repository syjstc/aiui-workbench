import { z } from 'zod';
import { TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { APP_VERSION } from './version.mjs';
import {DEVELOPMENT_GUIDE} from './development-flow.mjs';

export function instructionsForTools(names){
  const has=name=>names.includes(name),lines=['工具和参数以当前运行服务的 tools/list 为准；runtime 和 CLI 版本不代表工坊服务版本。只调用当前清单中存在的方法。'];
  if(has('aiui_context_get'))lines.push('先调用 aiui_context_get，一次读取官方 aiui-dev 和工坊补充流程；官方 Skill 负责开发规范与验收要求。首次引导使用 setup=true，一次检查并补齐缺失 Skill 和环境；不要重复安装或覆盖用户修改。已有返回的上下文和成功证据不必重复读取。');
  if(has('aiui_environment_check'))lines.push('设备操作前检查 devices[].adbAccess、rokidAppAdb 和 connection.diagnostic：Rokid App 的“眼镜 ADB 调试”是独立操作开关，和 Android USB/无线调试、AIUI 开发者模式不同。已验证 Rokid 固件可通过 persist.vendor.adb 读取；state=rokid-adb-disabled/phoneAdbSwitch=off 时，ADB 仍可在线但截图、投屏、遥控会被拦截。明确告诉用户在手机 Rokid AI → 主页 → 眼镜卡片齿轮 → 开发者开启“眼镜 ADB 调试”，不要反复重连或改 AIUI 模式。失败读取 deviceDiagnostic/recovery（长任务在 job 中）；phoneAdbSwitch=unknown 时只提示检查，不断言关闭，不把普通 Android 文件权限错误当成该开关关闭。恢复后重查并继续原任务。');
  if(has('aiui_adb_discover'))lines.push('连接眼镜支持无线：aiui_adb_discover 自动发现，aiui_adb_connect 配对后自动续连并核实在线，aiui_adb_wireless_enable 可将已授权 USB 眼镜一键切为无线。不要要求新手安装 ADB、配 PATH 或运行终端命令；需同一 Wi-Fi、眼镜端开关或授权时，明确告诉用户操作。配对成功不等于连接完成。');
  if(has('aiui_connection_guide'))lines.push('连接眼镜提供无线、有线两个同级 Tab，按用户选择和硬件条件使用，method=wireless 或 usb 可取得对应指引；不推荐其中一种优先。发现设备未连接、未授权或断开时，主动告诉用户当前状态和下一步，不等用户追问；制作和打包可先继续。aiui_connection_guide 按用户语言返回实际连接状态及操作截图，step=install,shareHelper=true 提供手机下载码。说明 Rokid AI → 工具箱 → 眼镜应用管理 → 安装新应用；工具箱 → 遥控器可滑动选择、点击确认、返回。显示工具返回的图片，不编造手机或眼镜截图；示例图不代表当前已连接。连接恢复后继续原 projectId/workflowId，安装后说明如何打开和操作。');
  if(has('aiui_adb_pair_qr'))lines.push('二维码配对使用 aiui_adb_pair_qr(action=start)，把返回图片展示给用户，由眼镜的“使用二维码配对设备”扫描，使用同一 id 有限查询 status，最多两分钟。离开、取消或改用六位码时 cancel。手机下载码只下载 APK，手机扫码不能代替眼镜配对；固件无扫码入口时退回六位码。connected=true 才算已连接。');
  if(has('aiui_feedback_prepare'))lines.push('反馈仅限已定位的工坊自身问题和用户主动提出的建议；接入 MCP 的外部助手可调用 aiui_feedback_prepare 填写草稿，工坊按本机固定规则脱敏并生成预览，由用户在反馈页面提交到当前更新源仓库。此功能不调用模型。不要批量上报普通应用开发错误，不把诊断自动公开；结果不明时核对原回执，不重放发布。');
  if(has('aiui_workflow_start')&&has('aiui_workflow_continue'))lines.push(DEVELOPMENT_GUIDE);
  else{
    if(has('aiui_project_create'))lines.push('需要新项目时使用 aiui_project_create，再用自己的编码工具按官方规范修改真实源码；已有项目继续使用原 projectId。');
    if(has('aiui_preview_test'))lines.push('使用 aiui_preview_test 一次模拟交互、行为断言、截图和日志报告。');
    if(has('aiui_project_build'))lines.push('使用 aiui_project_build 一次检查并打包。');
    if(has('aiui_job_wait'))lines.push('仅任务 status=running 时调用 aiui_job_wait。');
    lines.push('失败时读取当前工具返回的错误和恢复步骤，说明需要用户完成的操作后继续同一项目。');
  }
  if(has('aiui_ai_wait'))lines.push('AI 自动化才临时启用 aiui_ai_configure，随后 aiui_ai_wait 阻塞领取请求并用 aiui_ai_reply 回填；验证后关闭，idle 后停止监听，不进行空轮询。必须如实声明图片能力；无法看图时主动告知用户在真机测试。普通模拟器用户直接在真机测试 AI 功能；独立后端可选、不推荐默认。常用流程按需读 aiui_skill_read，不反复读取完整上下文。');
  lines.push('遵循用户授权范围，模拟、真机、佩戴和平台发布分别验收；正式提审由用户在工坊确认。');
  return lines.join('\n\n');
}
export const MCP_INSTRUCTIONS=instructionsForTools(TOOL_DEFINITIONS.map(([name])=>name));

export function toolCatalog() {
  return {
    schemaVersion: 1, serviceVersion: APP_VERSION, instructions: MCP_INSTRUCTIONS,
    tools: TOOL_DEFINITIONS.map(([name, description, shape]) => ({ name, description, inputSchema: z.toJSONSchema(z.object(shape), { io: 'input' }) })),
  };
}

// Pre-discovery services can only attest the tools in their capability response.
// Do not advertise the bridge's entire (possibly newer) local tool catalog.
export function legacyToolCatalog(serviceVersion, capabilities) {
  const names = new Set(['aiui_status', ...(capabilities ? ['aiui_capabilities_get'] : [])]);
  for (const capability of capabilities?.capabilities || []) {
    if (capability.tool) names.add(capability.tool);
    for (const name of capability.relatedTools || []) names.add(name);
  }
  const tools = toolCatalog().tools.filter(tool => names.has(tool.name));
  const actions = capabilities?.simulation?.inputs;
  const preview = tools.find(tool => tool.name === 'aiui_preview_action');
  if (preview && Array.isArray(actions)) preview.inputSchema.properties.action.enum = actions;
  // Legacy context schemas do not support setup=true. Keep guidance within the
  // capabilities actually attested by that service, including its parameters.
  const instructions=instructionsForTools(tools.map(tool=>tool.name)).replace('首次引导使用 setup=true，一次检查并补齐缺失 Skill 和环境；不要重复安装或覆盖用户修改。','');
  const context=tools.find(tool=>tool.name==='aiui_context_get');if(context){delete context.inputSchema.properties.setup;delete context.inputSchema.properties.existingSkills;}
  return { schemaVersion: 1, serviceVersion, discovery: 'legacy-capabilities', instructions, tools };
}
