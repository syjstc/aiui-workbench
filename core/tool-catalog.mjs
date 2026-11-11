import { z } from 'zod';
import { TOOL_DEFINITIONS } from './tool-definitions.mjs';
import { APP_VERSION } from './version.mjs';

export const MCP_INSTRUCTIONS = '先调用 aiui_context_get 获取官方 Skill、能力清单和示例。工具和参数以当前服务返回的 tools/list 为准，不要求 MCP 入口与工坊版本相同。优先 aiui_preview_test 一次执行模拟与截图/断言/日志报告，aiui_project_build 一次完成检查与打包；仅 status=running 时调用 aiui_job_wait。需要视频时用 aiui_preview_test 的 record=true 或 aiui_record_clip。源码用现有编码工具编辑。项目传 projectId，逐步预览传 sessionId。模拟、真机、平台发布分别验收；自动平台上传未验证。';

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
  return { schemaVersion: 1, serviceVersion, discovery: 'legacy-capabilities', instructions: MCP_INSTRUCTIONS, tools };
}
