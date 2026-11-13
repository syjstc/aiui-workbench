import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Knowledge} from '../core/knowledge.mjs';
import {ensureAgentSkills,findAgentSkills,workflowSkill} from '../core/agent-skills.mjs';
import {collectFiles} from '../core/projects.mjs';
import {Workbench} from '../core/service.mjs';
import {AiConnection} from '../core/ai-connection.mjs';
import {toolCatalog,legacyToolCatalog} from '../core/tool-catalog.mjs';
import {sha} from '../core/util.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-agent-skills-')),projectPath=path.join(root,'project');await fs.mkdir(projectPath);
  const knowledge=await new Knowledge(path.join(root,'service')).init();
  t.after(async()=>{await knowledge.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,knowledge,project:{projectPath,agentPath:projectPath,knowledgeRevision:knowledge.meta.revision}};
}
const options={globalRoots:[]};

test('missing official skill is installed byte-for-byte with references, separately from the workflow skill',async t=>{
  const {knowledge,project}=await fixture(t),first=await ensureAgentSkills(project,knowledge,options);
  assert.deepEqual(first.skills.map(s=>s.status),['installed','installed']);
  const official=(await knowledge.index()).filter(d=>d.path.startsWith('skills/aiui-dev/'));assert.ok(official.length>20);
  for(const doc of official)assert.equal(sha(await fs.readFile(path.join(project.projectPath,'.agents',doc.path))),doc.sha256,doc.path);
  assert.match(await fs.readFile(path.join(project.projectPath,'.agents/skills/aiui-workshop/SKILL.md'),'utf8'),/supplements the official/);
  assert.ok((await collectFiles(project.agentPath)).every(file=>!file.path.startsWith('.agents/')));
  const second=await ensureAgentSkills(project,knowledge,options);assert.deepEqual(second.skills.map(s=>s.status),['current','current']);
});

test('an official skill in an inherited client folder or a renamed global folder is reused without creating a duplicate',async t=>{
  const {root,knowledge,project}=await fixture(t),globalRoot=path.join(root,'global-skills'),folder=path.join(globalRoot,'official-renamed');await fs.mkdir(folder,{recursive:true});
  const content=(await knowledge.read('skills/aiui-dev/SKILL.md')).content+'\nUser notes stay here.\n';await fs.writeFile(path.join(folder,'SKILL.md'),content);
  const result=await ensureAgentSkills(project,knowledge,{globalRoots:[globalRoot]});assert.equal(result.skills[0].status,'existing');assert.equal(result.skills[0].path,path.join(folder,'SKILL.md'));
  assert.equal(await fs.access(path.join(project.projectPath,'.agents/skills/aiui-dev')).then(()=>true,()=>false),false);assert.equal(await fs.readFile(path.join(folder,'SKILL.md'),'utf8'),content);
  const parent=path.join(root,'.claude/skills/aiui-dev');await fs.mkdir(parent,{recursive:true});await fs.writeFile(path.join(parent,'SKILL.md'),content);
  const found=await findAgentSkills(project.projectPath,options);assert.equal(found.find(s=>s.name==='aiui-dev').scope,'inherited');
});
test('a client-reported plugin skill is not duplicated into local folders',async t=>{
  const {knowledge,project}=await fixture(t),result=await ensureAgentSkills(project,knowledge,{...options,existingSkills:['aiui-dev']});
  assert.equal(result.skills[0].status,'provided-by-client');assert.equal(await fs.access(path.join(project.projectPath,'.agents/skills/aiui-dev')).then(()=>true,()=>false),false);assert.equal(result.skills[1].status,'installed');
});

test('managed official snapshots update together, while user edits to either skill are preserved',async t=>{
  const {knowledge,project}=await fixture(t);await ensureAgentSkills(project,knowledge,options);
  const docs=await knowledge.index(),next=docs.map(doc=>{if(doc.path!=='skills/aiui-dev/SKILL.md')return doc;const content=doc.content+'\nNew official revision.\n';return {...doc,content,sha256:sha(content)};}),updatedKnowledge={meta:{revision:'a'.repeat(40)},index:async()=>next};
  const updated=await ensureAgentSkills({...project,knowledgeRevision:'a'.repeat(40)},updatedKnowledge,options);assert.equal(updated.skills[0].status,'updated');
  const reference=path.join(project.projectPath,'.agents/skills/aiui-dev/references/checklist.md'),workflow=path.join(project.projectPath,'.agents/skills/aiui-workshop/SKILL.md');
  await fs.appendFile(reference,'\nPersonal checklist rule.\n');await fs.appendFile(workflow,'\nPersonal workflow rule.\n');
  const preserved=await ensureAgentSkills(project,knowledge,options);assert.deepEqual(preserved.skills.map(s=>s.status),['user-modified','user-modified']);assert.match(await fs.readFile(reference,'utf8'),/Personal checklist rule/);assert.match(await fs.readFile(workflow,'utf8'),/Personal workflow rule/);
});

test('managed global copies and their references update despite client-reported loaded skills, without project duplicates',async t=>{
  const {root,knowledge,project}=await fixture(t),user=path.join(root,'user');await fs.mkdir(user);
  const globals=[path.join(user,'.agents/skills')];
  await ensureAgentSkills({projectPath:user,agentPath:user},knowledge,{globalRoots:[],writeIgnore:false});
  const directory=path.join(globals[0],'aiui-workshop'),markerFile=path.join(directory,'.aiui-managed.json');
  const old='---\nname: aiui-workshop\ndescription: Original managed guide\n---\nOld version\n';
  await fs.writeFile(path.join(directory,'SKILL.md'),old);
  const metadata=JSON.parse(await fs.readFile(markerFile,'utf8'));metadata.version='0.1.0';metadata.files['SKILL.md']=sha(old);await fs.writeFile(markerFile,JSON.stringify(metadata));
  const result=await ensureAgentSkills(project,knowledge,{globalRoots:globals,existingSkills:['aiui-dev','aiui-workshop']});
  assert.equal(result.skills[1].status,'updated');assert.equal(result.reloadRequired,true);
  assert.match(await fs.readFile(path.join(directory,'references/simulator-ai.md'),'utf8'),/supportsImages/);
  assert.match(await fs.readFile(path.join(directory,'references/verification.md'),'utf8'),/3DoF/);
  assert.equal(await fs.access(path.join(project.projectPath,'.agents/skills/aiui-workshop')).then(()=>true,()=>false),false);
  await fs.appendFile(path.join(directory,'references/simulator-ai.md'),'\nPersonal rule.\n');
  const preserved=await ensureAgentSkills(project,knowledge,{globalRoots:globals,existingSkills:['aiui-workshop']});assert.equal(preserved.skills[1].status,'user-modified');
  assert.match(await fs.readFile(path.join(directory,'references/simulator-ai.md'),'utf8'),/Personal rule/);
});

test('a complete unmodified original can be adopted, while a modified original is preserved',async t=>{
  const {root,knowledge,project}=await fixture(t),user=path.join(root,'user');await fs.mkdir(user);
  await ensureAgentSkills({projectPath:user,agentPath:user},knowledge,{globalRoots:[],writeIgnore:false});
  const directory=path.join(user,'.agents/skills/aiui-dev');await fs.unlink(path.join(directory,'.aiui-managed.json'));
  const adopted=await ensureAgentSkills(project,knowledge,{globalRoots:[path.join(user,'.agents/skills')]});assert.equal(adopted.skills[0].status,'adopted');
  await fs.unlink(path.join(directory,'.aiui-managed.json'));await fs.appendFile(path.join(directory,'SKILL.md'),'\nCustom instructions.\n');
  const kept=await ensureAgentSkills(project,knowledge,{globalRoots:[path.join(user,'.agents/skills')]});assert.equal(kept.skills[0].status,'existing');assert.match(await fs.readFile(path.join(directory,'SKILL.md'),'utf8'),/Custom instructions/);
});

test('skill setup refuses symlinked destinations and an unsafe ignore file before external writes',async t=>{
  const {root,knowledge,project}=await fixture(t),outside=path.join(root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(project.projectPath,'.agents'),'dir');
  await assert.rejects(ensureAgentSkills(project,knowledge,options),/符号链接/);assert.deepEqual(await fs.readdir(outside),[]);
  await fs.unlink(path.join(project.projectPath,'.agents'));const external=path.join(outside,'ignore');await fs.writeFile(external,'kept');await fs.symlink(external,path.join(project.projectPath,'.aixignore'));
  await assert.rejects(ensureAgentSkills(project,knowledge,options),/不是普通文件/);assert.equal(await fs.readFile(external,'utf8'),'kept');
});

test('copied configuration, failed calls, CLI and discovery do not verify an external AI connection',async t=>{
  const {root}=await fixture(t),w=await new Workbench(path.join(root,'connection-service')).init();t.after(()=>w.close());
  for(const actor of ['desktop','CLI','MCP-discovery'])await w.call('aiui_context_get',{},actor);
  await w.call('aiui_mcp_config',{},'MCP');await assert.rejects(w.call('aiui_context_get',{projectId:'absent'},'MCP'));
  assert.equal(w.status().aiConnection.verifiedThisSession,false);
  const context=await w.call('aiui_context_get',{},'MCP');assert.equal(context.connection.verifiedThisSession,true);assert.equal(context.serviceVersion,w.status().version);assert.equal(context.availableTools.length,toolCatalog().tools.length);assert.equal(context.workflowSkill.sha256,(await workflowSkill()).sha256);
  const reopened=await new AiConnection(w.home,toolCatalog()).init();assert.equal(reopened.status().verifiedThisSession,false);assert.ok(reopened.status().verifiedAt);
});

test('one setup call installs only missing user skills, checks the environment once and leaves project creation to the user request',async t=>{
  const {root}=await fixture(t),w=await new Workbench(path.join(root,'setup-service')).init();t.after(()=>w.close());
  w.skillHome=path.join(root,'user-home');await fs.mkdir(w.skillHome);w.skillOptions={globalRoots:[]};let checks=0;w.devices.check=async()=>{checks++;return {adb:true,aix:true,devices:[]};};
  const context=await w.call('aiui_context_get',{setup:true},'MCP');assert.equal(checks,1);assert.equal(context.skillSetup.status,'ready');assert.equal(context.skillSetup.scope,'user');assert.deepEqual(context.skillSetup.skills.map(s=>s.status),['installed','installed']);assert.deepEqual(context.environment.devices,[]);assert.match(context.nextAction,/ask what app/);assert.equal(w.projects.list().length,0);
  assert.equal(await fs.access(path.join(w.skillHome,'.aixignore')).then(()=>true,()=>false),false);
  const again=await w.call('aiui_context_get',{setup:true},'MCP');assert.deepEqual(again.skillSetup.skills.map(s=>s.status),['current','current']);assert.equal(checks,2);
});

test('legacy guidance does not advertise unavailable workflow/source/diagnostic tools or unsupported setup arguments',()=>{
  const legacy=legacyToolCatalog('0.2.0',{capabilities:[{tool:'aiui_context_get',relatedTools:['aiui_project_create','aiui_preview_test','aiui_project_build']}]});
  assert.doesNotMatch(legacy.instructions,/aiui_workflow_start|aiui_project_files|aiui_diagnostics_get|setup=true/);assert.equal(legacy.tools.find(t=>t.name==='aiui_context_get').inputSchema.properties.setup,undefined);
});
