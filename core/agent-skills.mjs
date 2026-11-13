import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ROOT,atomicJson,readJson,id,sha} from './util.mjs';
import {APP_VERSION} from './version.mjs';

const officialPrefix='skills/aiui-dev/';
const marker='.aiui-managed.json';
const skillName=text=>text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^name:\s*['"]?([a-z0-9-]+)['"]?\s*$/m)?.[1];
const absent=error=>{if(error.code==='ENOENT')return null;throw error;};
const userRoots=()=>['.agents','.codex','.claude','.cursor'].map(name=>path.join(os.homedir(),name,'skills'));

export async function workflowSkill(){
  const content=await fs.readFile(path.join(ROOT,'assets/skills/aiui-workshop/SKILL.md'),'utf8');
  return {name:'aiui-workshop',version:APP_VERSION,sha256:sha(content),content,role:'MCP orchestration only; official aiui-dev owns application development and its delivery checklist'};
}

export async function findAgentSkills(projectPath,{globalRoots=userRoots()}={}){
  const roots=[];let current=path.resolve(projectPath);
  for(;;){
    for(const client of ['.agents','.claude','.cursor','.codex'])roots.push(path.join(current,client,'skills'));
    if(await fs.lstat(path.join(current,'.git')).catch(absent)||path.dirname(current)===current)break;
    current=path.dirname(current);
  }
  const found=[];
  for(const root of new Set([...roots,...globalRoots])){
    const entries=await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return [];throw error;});
    for(const entry of entries){
      if(entry.name.startsWith('.')||(!entry.isDirectory()&&!entry.isSymbolicLink()))continue;
      const file=path.join(root,entry.name,'SKILL.md');
      const content=await fs.readFile(file,'utf8').catch(absent);if(content===null)continue;
      const name=skillName(content);if(!['aiui-dev','aiui-workshop'].includes(name))continue;
      const real=await fs.realpath(file);if(found.some(item=>item.real===real))continue;
      found.push({name,path:file,real,sha256:sha(content),scope:path.relative(projectPath,file).startsWith('..')?'inherited':'project'});
    }
  }
  return found;
}

async function safeDirectory(root,relative){
  let directory=await fs.realpath(root);
  for(const part of relative.split('/')){
    directory=path.join(directory,part);
    let entry=await fs.lstat(directory).catch(absent);
    if(!entry){await fs.mkdir(directory).catch(error=>{if(error.code!=='EEXIST')throw error;});entry=await fs.lstat(directory);}
    if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('Skill 安装目录含符号链接或非目录，已保留现有文件；可通过 MCP 读取规范');
  }
  return directory;
}

async function diskFiles(directory,prefix=''){
  const files={};
  for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){
    const relative=prefix+entry.name;
    if(entry.isSymbolicLink())return null;
    if(entry.isDirectory()){const nested=await diskFiles(directory,relative+'/');if(!nested)return null;Object.assign(files,nested);}
    else if(entry.isFile()&&relative!==marker)files[relative]=sha(await fs.readFile(path.join(directory,relative)));
  }
  return files;
}

async function installOne(projectPath,name,files,metadata){
  const parent=await safeDirectory(projectPath,'.agents/skills'),directory=path.join(parent,name);
  const existing=await fs.lstat(directory).catch(absent),managed=existing&&!existing.isSymbolicLink()?await readJson(path.join(directory,marker),null).catch(()=>null):null;
  if(existing){
    if(!managed||managed.owner!=='aiui-workbench'||managed.name!==name){const content=existing.isDirectory()?await fs.readFile(path.join(directory,'SKILL.md'),'utf8').catch(absent):null;return {name,status:content&&skillName(content)===name?'existing':'name-conflict',path:path.join(directory,'SKILL.md')};}
    const actual=await diskFiles(directory),expected=managed.files;
    if(!actual||!expected||JSON.stringify(Object.entries(actual).sort())!==JSON.stringify(Object.entries(expected).sort()))return {name,status:'user-modified',path:path.join(directory,'SKILL.md'),updateAvailable:true};
    if(managed.revision===metadata.revision&&managed.version===metadata.version&&JSON.stringify(managed.files)===JSON.stringify(Object.fromEntries(Object.entries(files).map(([file,content])=>[file,sha(content)]))))return {name,status:'current',path:path.join(directory,'SKILL.md'),...metadata};
  }
  const stagingParent=await safeDirectory(projectPath,'.agents/skill-staging'),staging=path.join(stagingParent,id()),backup=path.join(stagingParent,id());
  await fs.mkdir(staging);
  try{
    for(const [file,content] of Object.entries(files)){
      if(!file||file.split('/').some(part=>['..','.',''].includes(part))||path.isAbsolute(file)||file.includes('\\'))throw new Error('官方 Skill 包含无效引用路径');
      const target=path.join(staging,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content,{mode:0o600});
    }
    await atomicJson(path.join(staging,marker),{owner:'aiui-workbench',name,...metadata,files:Object.fromEntries(Object.entries(files).map(([file,content])=>[file,sha(content)]))});
    if(existing){
      const latest=await diskFiles(directory);if(!latest||JSON.stringify(Object.entries(latest).sort())!==JSON.stringify(Object.entries(managed.files).sort()))return {name,status:'user-modified',path:path.join(directory,'SKILL.md'),updateAvailable:true};
      await fs.rename(directory,backup);
    }
    try{await fs.rename(staging,directory);}catch(error){if(existing)await fs.rename(backup,directory);throw error;}
    await fs.rm(backup,{recursive:true,force:true});
    return {name,status:existing?'updated':'installed',path:path.join(directory,'SKILL.md'),...metadata,fileCount:Object.keys(files).length};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}

const pending=new Map();
export async function ensureAgentSkills(project,knowledge,options={}){
  const key=project.projectPath;if(pending.has(key))return pending.get(key);
  const work=(async()=>{
    if(options.writeIgnore!==false){const ignore=await fs.lstat(path.join(project.agentPath,'.aixignore')).catch(absent);if(ignore?.isSymbolicLink()||ignore&&!ignore.isFile())throw new Error('.aixignore 不是普通文件，已停止 Skill 安装并保留现有内容');}
    const found=await findAgentSkills(key,options),results=[];
    for(const name of ['aiui-dev','aiui-workshop']){
      if(options.existingSkills?.includes(name)){results.push({name,status:'provided-by-client',source:'client-reported; current project guidance is also returned inline'});continue;}
      const existing=found.filter(item=>item.name===name),local=path.join(key,'.agents/skills',name,'SKILL.md');
      if(existing.length&&!existing.every(item=>item.path===local)){results.push({name,status:'existing',path:existing[0].path,duplicateCount:existing.length-1});continue;}
      if(existing.length&&!(await readJson(path.join(path.dirname(local),marker),null).catch(()=>null))){results.push({name,status:'existing',path:local});continue;}
      if(name==='aiui-dev'){
        const revision=project.knowledgeRevision||knowledge.meta.revision;
        const docs=(await knowledge.index(revision)).filter(doc=>doc.path.startsWith(officialPrefix));
        if(!docs.some(doc=>doc.path===officialPrefix+'SKILL.md'))throw new Error('当前项目的官方 Skill 尚未缓存，请在官方资料中同步后重试');
        if(docs.some(doc=>sha(doc.content)!==doc.sha256))throw new Error('官方 Skill 缓存完整性核对失败，请重新同步官方资料');
        const files=Object.fromEntries(docs.map(doc=>[doc.path.slice(officialPrefix.length),doc.content]));
        results.push(await installOne(key,name,files,{revision,source:`https://github.com/yodaos-project/AIUI/tree/${revision}/skills/aiui-dev`}));
      }else{
        const skill=await workflowSkill();results.push(await installOne(key,name,{'SKILL.md':skill.content},{version:skill.version}));
      }
    }
    if(options.writeIgnore!==false){
      const ignoreFile=path.join(project.agentPath,'.aixignore'),ignore=await fs.readFile(ignoreFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      const additions=['.agents/','.claude/','.cursor/','.codex/'].filter(rule=>!ignore.split(/\r?\n/).includes(rule));
      if(additions.length)await fs.appendFile(ignoreFile,(ignore&&!ignore.endsWith('\n')?'\n':'')+additions.join('\n')+'\n');
    }
    return {skills:results,officialRules:'aiui-dev',workflowRules:'aiui-workshop',scope:options.writeIgnore===false?'user':'project',delivery:'skill folders plus inline MCP context; discovery depends on AI client'};
  })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
