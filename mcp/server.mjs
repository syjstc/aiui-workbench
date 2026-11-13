import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import { connect } from '../core/client.mjs';
import { APP_VERSION } from '../core/version.mjs';
import {Diagnostics,readServiceLog} from '../core/diagnostics.mjs';
import {homePath} from '../core/util.mjs';
import {toolCatalog} from '../core/tool-catalog.mjs';

let client,startupError;
try{client=await connect(undefined,{requireCurrentVersion:false});}catch(error){startupError=error;}
const fallback=()=>({...toolCatalog(),instructions:'主服务暂未就绪。读取 aiui_diagnostics_get 和 aiui_service_log_read 确认原因。工坊未打开时请用户打开；已打开但无响应时提示重启；有证据表明入口缺失或版本过旧时提示更新工坊并重连 AI。说明具体操作，不反复重试；保留原需求、项目及任务。恢复后调用 aiui_environment_check 重试并重新读取 tools/list。',tools:toolCatalog().tools.filter(t=>['aiui_diagnostics_get','aiui_service_log_read','aiui_environment_check'].includes(t.name))});
let catalog;
try{catalog=client?await client.catalog():fallback();}catch(error){startupError=error;client=null;catalog=fallback();}
let signature = JSON.stringify(catalog.tools), initialized = false, updating;
// Preserve the running service's JSON schemas, including tools and parameters
// that did not exist in this bridge's bundled application release.
const server = new Server({ name: 'aiui-workbench', version: APP_VERSION }, {
  capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} },
  instructions: catalog.instructions,
});
async function discover({ autoStart = true } = {}) {
  if (updating) return updating;
  updating = (async () => {
    if(!client){try{client=await connect(undefined,{requireCurrentVersion:false,autoStart:false});}catch{}}
    let next;
    try{next=client?await client.catalog({autoStart}):fallback();}catch(error){startupError=error;client=null;next=fallback();}
    const nextSignature = JSON.stringify(next.tools);
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
    let result;
    if(!client){
      const args=params.arguments||{},diagnostics=await new Diagnostics(homePath()).init();
      if(params.name==='aiui_service_log_read')result=await readServiceLog(homePath(),{maxBytes:Math.max(1000,Math.min(args.maxBytes||32000,64000))});
      else if(params.name==='aiui_diagnostics_get')result=await diagnostics.read({...args,limit:Math.max(1,Math.min(args.limit||30,100))},'MCP');
      else {try{client=await connect(undefined,{requireCurrentVersion:false});result=await client.call(params.name,args,'MCP');await discover();}catch(error){const d=await diagnostics.record(error,{source:'startup',tool:params.name});throw Object.assign(error,{diagnosticId:d.id});}}
    }else result=await client.call(params.name,params.arguments||{},'MCP');
    if(params.name==='aiui_ai_wait'&&result.images?.length){
      const {images,...meta}=result;
      return {content:[...images.map(({mimeType,data})=>({type:'image',mimeType,data})),{type:'text',text:JSON.stringify({...meta,images:images.map(({data,...info})=>info)})}]};
    }
    if (params.name === 'aiui_preview_capture' || params.name === 'aiui_glasses_screenshot' || (params.name === 'aiui_glasses_read_file' && result.type === 'image')) {
      const { data, ...meta } = result;
      return { content: [{ type: 'image', data, mimeType: result.mime || 'image/png' }, { type: 'text', text: JSON.stringify(meta) }] };
    }
    const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    if (['aiui_preview_test', 'aiui_job_wait','aiui_workflow_continue'].includes(params.name) && result.result?.capture?.path) {
      try { content.unshift({ type: 'image', data: (await fs.readFile(result.result.capture.path)).toString('base64'), mimeType: 'image/png' }); } catch {}
    }
    return { ...(['aiui_preview_test', 'aiui_project_build', 'aiui_job_wait', 'aiui_record_clip', 'aiui_record_stop', 'aiui_platform_upload', 'aiui_platform_review_prepare','aiui_workflow_continue'].includes(params.name) && ['failed', 'cancelled', 'interrupted'].includes(result.status) ? { isError: true } : {}), content };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({error:error.message,diagnosticId:error.diagnosticId,sharedDiagnostics:error.sharedDiagnostics,recovery:error.diagnosticId?{tool:'aiui_diagnostics_get',arguments:{diagnosticId:error.diagnosticId}}:undefined}) }] }; }
});
function resources() {
  const names = new Set(catalog.tools.map(tool => tool.name));
  return [
    { name: 'tools', uri: 'aiui://tools', description: '当前运行服务的实际工具与参数', mimeType: 'application/json' },
    ...(names.has('aiui_diagnostics_get') ? [{name:'diagnostics',uri:'aiui://diagnostics',description:'按项目标识的未读问题与恢复步骤，读取后自动标记已读',mimeType:'application/json'}] : []),
    ...(names.has('aiui_workflow_get') ? [{name:'development',uri:'aiui://development',description:'完整制作流程与恢复进度',mimeType:'application/json'}] : []),
    ...(names.has('aiui_projects_list') ? [{ name: 'projects', uri: 'aiui://projects', description: '与桌面同步的项目库', mimeType: 'application/json' }] : []),
    ...(names.has('aiui_capabilities_get') ? [{ name: 'capabilities', uri: 'aiui://capabilities', description: '当前服务的能力、示例和边界', mimeType: 'application/json' }] : []),
  ];
}
server.setRequestHandler(ListResourcesRequestSchema, async () => { await discover(); return { resources: resources() }; });
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  await discover();
  if (!resources().some(resource => resource.uri === params.uri)) throw new McpError(ErrorCode.InvalidParams, '当前服务没有此资源');
  const value = params.uri === 'aiui://tools' ? catalog : params.uri==='aiui://diagnostics'&&!client?await(await new Diagnostics(homePath()).init()).read({status:'open',read:false},'MCP'):await client.call(params.uri==='aiui://diagnostics'?'aiui_diagnostics_get':params.uri==='aiui://development'?'aiui_workflow_get':params.uri === 'aiui://projects' ? 'aiui_projects_list' : 'aiui_capabilities_get', params.uri==='aiui://diagnostics'?{status:'open',read:false}:{}, 'MCP');
  return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(value) }] };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'develop-aiui', description: '按当前服务能力开发、模拟验证并生成 AIX', arguments: [{ name: 'request', description: '开发需求', required: true }] }] }));
server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
  if (params.name !== 'develop-aiui' || !params.arguments?.request) throw new McpError(ErrorCode.InvalidParams, '需要 develop-aiui 提示和 request 参数');
  const current=await discover();
  return { messages: [{ role: 'user', content: { type: 'text', text: `${params.arguments.request}\n\n${current.instructions||'先读取当前 tools/list，只使用当前服务支持的方法。'}` } }] };
});
server.oninitialized = () => { initialized = true; };
const timer = setInterval(() => discover({ autoStart: false }).catch(() => {}), 1000);
timer.unref();
server.onclose = () => clearInterval(timer);
await server.connect(new StdioServerTransport());
