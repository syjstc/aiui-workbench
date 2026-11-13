import { z } from 'zod';
import { TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { APP_VERSION } from './version.mjs';
import {DEVELOPMENT_GUIDE} from './development-flow.mjs';

export function instructionsForTools(names){
  const has=name=>names.includes(name),lines=['工具和参数以当前运行服务的 tools/list 为准；runtime 和 CLI 版本不代表工坊服务版本。只调用当前清单中存在的方法。'];
  if(has('aiui_context_get'))lines.push('先调用 aiui_context_get，一次读取官方 aiui-dev 和工坊补充流程；官方 Skill 负责开发规范与验收要求。首次引导使用 setup=true，一次检查并补齐缺失 Skill 和环境；不要重复安装或覆盖用户修改。已有返回的上下文和成功证据不必重复读取。');
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
