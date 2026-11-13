import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConnectionPrompt,connectionReady} from '../renderer/ai-connection.mjs';
import {buildAiPrompt} from '../renderer/ai-prompts.mjs';

test('a first-use request includes the exact stable MCP configuration, skill/environment setup and no unrequested project',()=>{
 const config={mcpServers:{'aiui-workbench':{command:'/bin/sh',args:['/Library/Test Profile/mcp/launch.sh'],env:{AIUI_WORKBENCH_HOME:'/Library/Test Profile'}}}};
 const prompt=buildConnectionPrompt({config,serviceVersion:'0.6.0'});assert.ok(prompt.includes(JSON.stringify(config,null,2)));assert.match(prompt,/setup=true/);assert.match(prompt,/主动问我想做什么/);assert.match(prompt,/不要擅自创建示例项目/);assert.match(prompt,/重启工坊/);assert.match(prompt,/更新工坊/);assert.match(prompt,/保留其他服务和设置/);
});

test('an optional idea proceeds after setup and an existing project identity survives the handoff',()=>{
 const prompt=buildConnectionPrompt({idea:'Add a daily goal\nand save it.',project:{id:'p',name:'Checklist'},serviceVersion:'0.6.0',locale:'en'});
 assert.match(prompt,/Add a daily goal\nand save it/);assert.match(prompt,/proceed directly/);assert.match(prompt,/projectId="p"/);assert.match(prompt,/do not create a duplicate/);assert.match(prompt,/open AIUI Workshop/);assert.doesNotMatch(prompt,/[\u3400-\u9fff]/);
});

test('only a successful guide read from the current running service is presented as connected',()=>{
 assert.equal(connectionReady(null),false);assert.equal(connectionReady({version:'0.6.0',lastAiAt:'now',clients:[{name:'MCP'}]}),false);
 assert.equal(connectionReady({version:'0.6.0',aiConnection:{verifiedThisSession:false,verifiedAt:'yesterday',serviceVersion:'0.6.0'}}),false);
 assert.equal(connectionReady({version:'0.6.0',aiConnection:{verifiedThisSession:true,serviceVersion:'0.5.8'}}),false);
 assert.equal(connectionReady({version:'0.6.0',aiConnection:{verifiedThisSession:true,serviceVersion:'0.6.0'}}),true);
});

test('known old services get a compatible project prompt without new workflow or source tools',()=>{
 const prompt=buildAiPrompt({project:{id:'old-project'},idea:'继续完善',features:{workflow:false}});assert.match(prompt,/old-project/);assert.doesNotMatch(prompt,/aiui_workflow_start|aiui_workflow_continue|aiui_project_files|aiui_diagnostics_get/);
});
