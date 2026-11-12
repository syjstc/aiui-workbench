import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import { connect } from '../core/client.mjs';
import { APP_VERSION } from '../core/version.mjs';

const client = await connect(undefined, { requireCurrentVersion: false });
let catalog = await client.catalog(), signature = JSON.stringify(catalog.tools), initialized = false, updating;
// Preserve the running service's JSON schemas, including tools and parameters
// that did not exist in this bridge's bundled application release.
const server = new Server({ name: 'aiui-workbench', version: APP_VERSION }, {
  capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} },
  instructions: catalog.instructions,
});
async function discover({ autoStart = true } = {}) {
  if (updating) return updating;
  updating = (async () => {
    const next = await client.catalog({ autoStart }), nextSignature = JSON.stringify(next.tools);
    catalog = next;
    if (nextSignature !== signature) {
      signature = nextSignature;
      if (initialized) { await server.sendToolListChanged(); await server.sendResourceListChanged(); }
    }
    return catalog;
  })();
  try { return await updating; } finally { updating = null; }
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await discover()).tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const current = await discover();
    if (!current.tools.some(tool => tool.name === params.name)) throw new Error('当前服务不支持工具：' + params.name);
    const result = await client.call(params.name, params.arguments || {}, 'MCP');
    if (params.name === 'aiui_preview_capture' || params.name === 'aiui_glasses_screenshot' || (params.name === 'aiui_glasses_read_file' && result.type === 'image')) {
      const { data, ...meta } = result;
      return { content: [{ type: 'image', data, mimeType: result.mime || 'image/png' }, { type: 'text', text: JSON.stringify(meta) }] };
    }
    const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    if (['aiui_preview_test', 'aiui_job_wait'].includes(params.name) && result.type === 'preview-test' && result.result?.capture?.path) {
      try { content.unshift({ type: 'image', data: (await fs.readFile(result.result.capture.path)).toString('base64'), mimeType: 'image/png' }); } catch {}
    }
    return { ...(['aiui_preview_test', 'aiui_project_build', 'aiui_job_wait', 'aiui_record_clip', 'aiui_record_stop', 'aiui_platform_upload', 'aiui_platform_review_prepare'].includes(params.name) && ['failed', 'cancelled', 'interrupted'].includes(result.status) ? { isError: true } : {}), content };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
function resources() {
  const names = new Set(catalog.tools.map(tool => tool.name));
  return [
    { name: 'tools', uri: 'aiui://tools', description: '当前运行服务的实际工具与参数', mimeType: 'application/json' },
    ...(names.has('aiui_projects_list') ? [{ name: 'projects', uri: 'aiui://projects', description: '与桌面同步的项目库', mimeType: 'application/json' }] : []),
    ...(names.has('aiui_capabilities_get') ? [{ name: 'capabilities', uri: 'aiui://capabilities', description: '当前服务的能力、示例和边界', mimeType: 'application/json' }] : []),
  ];
}
server.setRequestHandler(ListResourcesRequestSchema, async () => { await discover(); return { resources: resources() }; });
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  await discover();
  if (!resources().some(resource => resource.uri === params.uri)) throw new McpError(ErrorCode.InvalidParams, '当前服务没有此资源');
  const value = params.uri === 'aiui://tools' ? catalog : await client.call(params.uri === 'aiui://projects' ? 'aiui_projects_list' : 'aiui_capabilities_get', {}, 'MCP');
  return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(value) }] };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'develop-aiui', description: '按当前服务能力开发、模拟验证并生成 AIX', arguments: [{ name: 'request', description: '开发需求', required: true }] }] }));
server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
  if (params.name !== 'develop-aiui' || !params.arguments?.request) throw new McpError(ErrorCode.InvalidParams, '需要 develop-aiui 提示和 request 参数');
  return { messages: [{ role: 'user', content: { type: 'text', text: `${params.arguments.request}\n\n先读取当前 tools/list，按服务实际提供的能力调用 aiui_context_get 获取官方 Skill。使用现有编码工具编辑真实源码。可用时优先 aiui_preview_test 完成模拟、显式行为断言、截图和日志报告，再用 aiui_project_build 检查并打包；仅 status=running 时调用 aiui_job_wait。视频可用 record=true 或 aiui_record_clip。失败时读取报告定位问题，修改后重测。没有应用断言只代表运行健康；模拟、真机与平台发布分别验收。上传时先核对 aiui_platform_status 和 aiui_platform_agents，再用 aiui_platform_upload 上传草稿、aiui_platform_review_prepare 保存材料。aiui_platform_review_request 只请求用户在工坊确认；AI 不得代替用户完成原生提审确认。` } }] };
});
server.oninitialized = () => { initialized = true; };
const timer = setInterval(() => discover({ autoStart: false }).catch(() => {}), 1000);
timer.unref();
server.onclose = () => clearInterval(timer);
await server.connect(new StdioServerTransport());
