import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAiPrompt,readIdeaDraft,saveIdeaDraft,IDEA_STORAGE_KEY} from '../renderer/ai-prompts.mjs';

test('a new idea prepares a complete AI request without inventing an existing project or task',()=>{
 const prompt=buildAiPrompt({idea:'做一个喝水提醒，保存今天的次数。'});
 assert.match(prompt,/喝水提醒/);assert.match(prompt,/aiui_workflow_start/);assert.match(prompt,/expectedRevision/);assert.match(prompt,/aiui_diagnostics_get/);assert.ok(!prompt.includes('projectId='));assert.match(prompt,/发布和正式提审需由我确认/);
});

test('project prompts preserve the current identity and only resume a workflow belonging to that project',()=>{
 const project={id:'project-a',name:'我的应用 "清单"'},flow={id:'flow-a',projectId:'project-a',target:'glasses'};
 const prompt=buildAiPrompt({project,flow,idea:'加一个今日目标',intent:'refine'});
 assert.match(prompt,/projectId="project-a"/);assert.match(prompt,/workflowId="flow-a"/);assert.match(prompt,/不要重复创建项目/);assert.match(prompt,/加一个今日目标/);
 const other=buildAiPrompt({project,flow:{...flow,id:'other-project-flow',projectId:'project-b'},intent:'recover'});
 assert.ok(!other.includes('other-project-flow'));assert.match(other,/aiui_workflow_get/);assert.match(other,/上述 projectId/);
});

test('the install preset handles a package-only workflow without claiming it installs on glasses',()=>{
 const prompt=buildAiPrompt({project:{id:'p',name:'Checklist'},flow:{id:'f',projectId:'p',target:'package'},intent:'install',locale:'en'});
 assert.match(prompt,/targets package only/);assert.match(prompt,/aiui_device_deploy/);assert.match(prompt,/device installation/);assert.match(prompt,/projectId="p"/);assert.ok(!/[\u3400-\u9fff]/.test(prompt));
});

test('the verify preset uses the bounded preview/build tools even when the existing workflow targets glasses',()=>{
 const prompt=buildAiPrompt({project:{id:'p',name:'清单'},flow:{id:'f',projectId:'p',target:'glasses'},intent:'validate'});
 assert.match(prompt,/aiui_preview_test/);assert.match(prompt,/aiui_project_build/);assert.match(prompt,/返回证据与文件位置即可/);assert.ok(!prompt.includes('aiui_workflow_continue'));
});

test('idea drafts survive remounts, remain separate for each project and surface storage failures',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
 assert.equal(readIdeaDraft(storage,'a'),'');assert.equal(saveIdeaDraft(storage,'a','给清单加一个目标'),true);saveIdeaDraft(storage,'b','呼吸练习');saveIdeaDraft(storage,undefined,'新应用');
 assert.equal(readIdeaDraft(storage,'a'),'给清单加一个目标');assert.equal(readIdeaDraft(storage,'b'),'呼吸练习');assert.equal(readIdeaDraft(storage),'新应用');
 for(let i=0;i<120;i++)saveIdeaDraft(storage,'project-'+i,'idea '+i);assert.equal(readIdeaDraft(storage,'a'),'给清单加一个目标');
 data.set(IDEA_STORAGE_KEY,'{bad');assert.equal(readIdeaDraft(storage,'a'),'');
 const blocked={getItem:()=>{throw new Error('storage blocked');}};assert.equal(readIdeaDraft(blocked,'a'),'');assert.equal(saveIdeaDraft(blocked,'a','idea'),false);
});
