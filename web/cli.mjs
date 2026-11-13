#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import { connect } from '../core/client.mjs';
import { APP_VERSION } from '../core/version.mjs';
import {homePath} from '../core/util.mjs';
import {Diagnostics,readServiceLog} from '../core/diagnostics.mjs';
import { resolveLocale, translateMessage } from '../shared/i18n.mjs';
const locale = resolveLocale(process.env.AIUI_WORKBENCH_LANG, [Intl.DateTimeFormat().resolvedOptions().locale]);
const localize = value => translateMessage(value, locale);

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string' }, 'no-open': { type: 'boolean' }, args: { type: 'string' }, 'args-file': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
  if (values.help) console.log(localize('AIUI 工坊 Web\n\naiui-workbench [--port 3100] [--no-open]\n\n自动连接或启动本地服务，并打开浏览器。仅监听 127.0.0.1。\n使用 AIUI_WORKBENCH_HOME 指定数据目录；Ctrl+C 关闭 Web 入口，共享本地服务继续供桌面和 MCP 使用。')+'\n\nAI / CLI (JSON output):\n  aiui-workbench tools [tool-name]\n  aiui-workbench call <tool-name> --args \'{"projectId":"..."}\'\n  aiui-workbench call <tool-name> --args-file /path/request.json\n  aiui-workbench mcp\n  aiui-workbench diagnose\n\nCLI call shares desktop/MCP projects, simulator logs and jobs.\nUse aiui_cli_info for exact bundled commands and AIUI_WORKBENCH_HOME.');
  else if (values.version) console.log(APP_VERSION);
  else if(positionals[0]==='diagnose') {
    const home=homePath();let client;
    try{client=await connect(home,{autoStart:false,requireCurrentVersion:false});}catch{}
    const diagnostics=client?await client.call('aiui_diagnostics_get',{},'CLI'):await(await new Diagnostics(home).init()).read({},'CLI');
    console.log(JSON.stringify({home,version:APP_VERSION,runtime:process.versions.node,diagnostics,serviceLog:await readServiceLog(home),instruction:'主服务未启动时也可读取此诊断。按恢复步骤完成操作，再重新打开工坊或让 AI 重试。'},null,2));
  }
  else if (positionals[0] === 'tools') {
    if(positionals.length>2)throw new Error('Usage: aiui-workbench tools [tool-name]');
    const client=await connect(undefined,{requireCurrentVersion:false}),catalog=await client.catalog();
    const definitions=positionals[1]?catalog.tools.filter(tool=>tool.name===positionals[1]):catalog.tools;
    if(!definitions.length)throw new Error('Unknown tool: '+positionals[1]);
    console.log(JSON.stringify({...catalog,tools:definitions},null,2));
  }
  else if (positionals[0] === 'call') {
    if(positionals.length!==2 || (values.args!==undefined && values['args-file']!==undefined))throw new Error('Usage: aiui-workbench call <tool-name> [--args JSON | --args-file /path/request.json]');
    const client=await connect(undefined,{requireCurrentVersion:false});
    const definition=(await client.catalog()).tools.find(tool=>tool.name===positionals[1]);
    if(!definition)throw new Error('Unknown tool: '+positionals[1]);
    let raw=values.args||'{}';
    if(values['args-file']){if((await fs.stat(values['args-file'])).size>1024*1024)throw new Error('Arguments file must be at most 1 MB');raw=await fs.readFile(values['args-file'],'utf8');}
    const args=JSON.parse(raw),result=await client.call(definition.name,args,'CLI');
    if(['aiui_preview_capture','aiui_glasses_screenshot'].includes(definition.name) || (definition.name==='aiui_glasses_read_file' && result.type==='image'))delete result.data;
    console.log(JSON.stringify(result,null,2));
    if(['failed','cancelled','interrupted'].includes(result.status))process.exitCode=1;
  }
  else if (positionals[0] === 'mcp') {
    if(positionals.length!==1)throw new Error('Usage: aiui-workbench mcp');
    await import('../mcp/server.mjs');
  }
  else {
    if(positionals.length && (positionals[0]!=='web' || positionals.length>1))throw new Error('Unknown command: '+positionals.join(' '));
    const { startWeb, openOnHost } = await import('./server.mjs');
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0 到 65535 的整数');
    const web = await startWeb({ port });
    console.log(localize(`\nAIUI 工坊 Web v${APP_VERSION}\n\n  ${web.url}\n\n本地服务和 Web 界面已就绪。Ctrl+C 关闭 Web 入口。\n完整链接含本机会话口令，请勿分享。\n`));
    if (!values['no-open']) openOnHost(web.url).catch(error => console.error(localize(error.message) + localize('，请手动打开上面的完整链接。')));
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await web.close(); process.exit(0); });
  }
} catch (error) { console.error(error.sharedDiagnostics?JSON.stringify({error:error.message,diagnosticId:error.diagnosticId,sharedDiagnostics:error.sharedDiagnostics},null,2):localize('AIUI 工坊 Web 启动失败：') + localize(error.message)); process.exitCode = 1; }
