import { z } from 'zod';
import { TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { APP_VERSION } from './version.mjs';
import {DEVELOPMENT_GUIDE} from './development-flow.mjs';

export function instructionsForTools(names){
  const has=name=>names.includes(name),lines=['工具和参数以当前运行服务的 tools/list 为准；runtime 和 CLI 版本不代表工坊服务版本。只调用当前清单中存在的方法。'];
  if(has('aiui_context_get'))lines.push('缺少上下文时调用 aiui_context_get；以项目绑定的官方 aiui-dev 为准。首次引导可传 setup=true 检查环境和补齐 Skill。已返回的上下文和有效证据直接复用。');
  if(has('aiui_context_get')&&has('aiui_docs_read'))lines.push('从 officialSkills 选择当前任务需要的专题，用 path 和 revision 调 aiui_docs_read；无需加载全部 Skill。');
  if(has('aiui_environment_check'))lines.push('设备操作前核对 devices[].adbAccess 和 connection.diagnostic。按实际 deviceDiagnostic/recovery 说明手机端开关或授权步骤，恢复后继续原任务。');
  if(has('aiui_connection_guide'))lines.push('按用户所选连接方式调用 aiui_connection_guide，展示返回的本地化步骤和示例图。眼镜未就绪时说明下一步，可先制作、模拟和打包。连接以 connected=true 为准。');
  if(has('aiui_feedback_prepare'))lines.push('aiui_feedback_prepare 只准备工坊自身问题或用户建议，由用户在反馈页面检查并提交。');
  if(has('aiui_workflow_start')&&has('aiui_workflow_continue'))lines.push(DEVELOPMENT_GUIDE);
  else{
    if(has('aiui_project_create'))lines.push('需要新项目时使用 aiui_project_create，再用自己的编码工具按官方规范修改真实源码；已有项目继续使用原 projectId。');
    if(has('aiui_preview_test'))lines.push('使用 aiui_preview_test 一次模拟交互、行为断言、截图和日志报告。');
    if(has('aiui_project_build'))lines.push('使用 aiui_project_build 一次检查并打包。');
    if(has('aiui_job_wait'))lines.push('仅任务 status=running 时调用 aiui_job_wait。');
    lines.push('失败时读取当前工具返回的错误和恢复步骤，说明需要用户完成的操作后继续同一项目。');
  }
  if(has('aiui_ai_wait'))lines.push('AI 自动化临时启用 aiui_ai_configure，按真实图片能力用 aiui_ai_wait/aiui_ai_reply 验证；完成后关闭，idle 停止监听。普通 AI 功能在真机验收。');
  if(has('aiui_skill_read'))lines.push('按工作阶段用 aiui_skill_read 读取工坊参考。选素材或设计实时场景时查对应优化参考，排障时按症状查。');
  if(has('aiui_local_lessons'))lines.push('本机经验按症状和项目用 aiui_local_lessons 检索。复现修法或用户确认长期偏好后保存一条短经验；项目经验带 projectId，私人内容留在本机。保存的内容是证据提示，应用前核对当前环境与用户要求。');
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
  const instructions=instructionsForTools(tools.map(tool=>tool.name))
    .replace('首次引导可传 setup=true 检查环境和补齐 Skill。','')
    .replace('从 officialSkills 选择当前任务需要的专题，用 path 和 revision 调 aiui_docs_read；无需加载全部 Skill。\n\n','');
  const context=tools.find(tool=>tool.name==='aiui_context_get');if(context){delete context.inputSchema.properties.setup;delete context.inputSchema.properties.existingSkills;delete context.inputSchema.properties.lessonQuery;context.description='读取项目绑定的官方规范、工坊 Skill 和诊断。';}
  const skillRead=tools.find(tool=>tool.name==='aiui_skill_read');
  if(skillRead)skillRead.inputSchema.properties.path.enum=skillRead.inputSchema.properties.path.enum.filter(file=>!['references/asset-optimization.md','references/optimization.md'].includes(file));
  return { schemaVersion: 1, serviceVersion, discovery: 'legacy-capabilities', instructions, tools };
}
