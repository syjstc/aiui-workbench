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
  const files=await workflowSkillFiles(),content=files['SKILL.md'];
  return {name:'aiui-workshop',version:APP_VERSION,sha256:sha(content),bundleSha256:sha(JSON.stringify(hashes(files))),content,references:Object.keys(files).filter(file=>file!=='SKILL.md'),role:'MCP orchestration only; official aiui-dev owns application development and its delivery checklist'};
}

const hashes=files=>Object.fromEntries(Object.entries(files).map(([file,content])=>[file,sha(content)]).sort(([a],[b])=>a.localeCompare(b)));
const sameFiles=(a,b)=>a&&b&&JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());
export async function workflowSkillFiles(){
  const directory=path.join(ROOT,'assets/skills/aiui-workshop'),files={};
  async function read(prefix=''){
    for(const entry of await fs.readdir(path.join(directory,prefix),{withFileTypes:true})){
      const file=prefix+entry.name;
      if(entry.isDirectory())await read(file+'/');
      else if(entry.isFile()&&file.endsWith('.md'))files[file]=await fs.readFile(path.join(directory,file),'utf8');
    }
  }
  await read();return files;
}

async function officialFiles(knowledge,revision){
  const docs=(await knowledge.index(revision)).filter(doc=>doc.path.startsWith(officialPrefix));
  if(!docs.some(doc=>doc.path===officialPrefix+'SKILL.md'))throw new Error('当前项目的官方 Skill 尚未缓存，请在官方资料中同步后重试');
  if(docs.some(doc=>sha(doc.content)!==doc.sha256))throw new Error('官方 Skill 缓存完整性核对失败，请重新同步官方资料');
  return Object.fromEntries(docs.map(doc=>[doc.path.slice(officialPrefix.length),doc.content]));
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
      const content=await fs.readFile(file,'utf8').catch(absent);
      const managed=await readJson(path.join(root,entry.name,marker),null).catch(()=>null);
      const name=managed?.owner==='aiui-workbench'?managed.name:content&&skillName(content);if(!['aiui-dev','aiui-workshop'].includes(name))continue;
      const real=await fs.realpath(path.dirname(file));if(found.some(item=>item.real===real))continue;
      found.push({name,path:file,real,managed,baseRoot:path.dirname(path.dirname(root)),symlink:entry.isSymbolicLink(),sha256:content===null?null:sha(content),scope:globalRoots.includes(root)?'user':path.relative(projectPath,file).startsWith('..')?'inherited':'project'});
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

const installing=new Map();
async function installOne(projectPath,name,files,metadata,options={}){
  const key=options.destination||path.join(projectPath,'.agents/skills',name);
  const work=(installing.get(key)||Promise.resolve()).catch(()=>{}).then(()=>installOneUnlocked(projectPath,name,files,metadata,options));
  installing.set(key,work);try{return await work;}finally{if(installing.get(key)===work)installing.delete(key);}
}
async function installOneUnlocked(projectPath,name,files,metadata,{destination,baseRoot,originalHashes}={}){
  const parent=destination?await safeDirectory(baseRoot,path.relative(baseRoot,path.dirname(destination))):await safeDirectory(projectPath,'.agents/skills');
  const directory=destination||path.join(parent,name),targetHashes=hashes(files);
  const existing=await fs.lstat(directory).catch(absent);let managed=existing&&!existing.isSymbolicLink()?await readJson(path.join(directory,marker),null).catch(()=>null):null,adopted=false;
  if(existing){
    if(!managed||managed.owner!=='aiui-workbench'||managed.name!==name){
      const actual=existing.isDirectory()&&!existing.isSymbolicLink()?await diskFiles(directory):null;
      if(!actual||!originalHashes?.some(original=>sameFiles(actual,original))){const content=existing.isDirectory()?await fs.readFile(path.join(directory,'SKILL.md'),'utf8').catch(absent):null;return {name,status:content&&skillName(content)===name?'existing':'name-conflict',path:path.join(directory,'SKILL.md'),updateAvailable:!sameFiles(actual,targetHashes)};}
      managed={owner:'aiui-workbench',name,files:actual};adopted=true;
    }
    const actual=await diskFiles(directory),expected=managed.files;
    if(!sameFiles(actual,expected))return {name,status:'user-modified',path:path.join(directory,'SKILL.md'),updateAvailable:true};
    if(!adopted&&managed.revision===metadata.revision&&managed.version===metadata.version&&sameFiles(managed.files,targetHashes))return {name,status:'current',path:path.join(directory,'SKILL.md'),...metadata};
  }
  const stagingParent=await safeDirectory(parent,'.aiui-skill-staging'),staging=path.join(stagingParent,id()),backup=path.join(stagingParent,id());
  await fs.mkdir(staging);
  try{
    for(const [file,content] of Object.entries(files)){
      if(!file||file.split('/').some(part=>['..','.',''].includes(part))||path.isAbsolute(file)||file.includes('\\'))throw new Error('官方 Skill 包含无效引用路径');
      const target=path.join(staging,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content,{mode:0o600});
    }
    await atomicJson(path.join(staging,marker),{owner:'aiui-workbench',name,...metadata,files:targetHashes});
    if(existing){
      const latest=await diskFiles(directory);if(!sameFiles(latest,managed.files))return {name,status:'user-modified',path:path.join(directory,'SKILL.md'),updateAvailable:true};
      await fs.rename(directory,backup);
    }
    try{await fs.rename(staging,directory);}catch(error){if(existing)await fs.rename(backup,directory);throw error;}
    await fs.rm(backup,{recursive:true,force:true});
    return {name,status:adopted&&sameFiles(managed.files,targetHashes)?'adopted':existing?'updated':'installed',path:path.join(directory,'SKILL.md'),...metadata,fileCount:Object.keys(files).length};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}

const pending=new Map();
export async function ensureAgentSkills(project,knowledge,options={}){
  const key=project.projectPath;if(pending.has(key))return pending.get(key);
  const work=(async()=>{
    if(options.writeIgnore!==false){const ignore=await fs.lstat(path.join(project.agentPath,'.aixignore')).catch(absent);if(ignore?.isSymbolicLink()||ignore&&!ignore.isFile())throw new Error('.aixignore 不是普通文件，已停止 Skill 安装并保留现有内容');}
    const found=await findAgentSkills(key,options),results=[];
    for(const name of ['aiui-dev','aiui-workshop']){
      const existing=found.filter(item=>item.name===name),copies=[];
      // A loaded skill says nothing about its on-disk version. Update managed
      // global/inherited copies before considering the client's no-duplicate hint.
      for(const item of existing.length?existing:[null]){
        if(!item&&(options.existingSkills?.includes(name)||options.installMissing===false))continue;
        const revision=item?.scope==='user'?knowledge.meta.revision:project.knowledgeRevision||knowledge.meta.revision;
        const files=name==='aiui-dev'?await officialFiles(knowledge,revision):await workflowSkillFiles();
        const metadata=name==='aiui-dev'?{revision,source:`https://github.com/yodaos-project/AIUI/tree/${revision}/skills/aiui-dev`}:{version:APP_VERSION};
        if(item?.symlink){copies.push({name,status:'existing',path:item.path,updateAvailable:true,reason:'Linked skills are preserved; read current guidance inline.'});continue;}
        const originals=[hashes(files)];
        if(item&&!item.managed&&name==='aiui-dev'){
          const bundled=await readJson(path.join(ROOT,'vendor/official/current.json'),null);
          if(bundled?.revision&&bundled.revision!==revision){try{originals.push(hashes(await officialFiles(knowledge,bundled.revision)));}catch{}}
        }
        copies.push(await installOne(key,name,files,metadata,{destination:item&&path.dirname(item.path),baseRoot:item?.baseRoot,originalHashes:options.adoptOriginal===false?[]:originals}));
      }
      const priority=['user-modified','name-conflict','updated','installed','adopted','current','existing'];
      const primary=copies.slice().sort((a,b)=>priority.indexOf(a.status)-priority.indexOf(b.status))[0];
      results.push(primary?{...primary,...(copies.length>1?{copies}:{}),duplicateCount:Math.max(0,existing.length-1)}:{name,status:options.existingSkills?.includes(name)?'provided-by-client':'not-installed',source:'Current guidance is returned inline without creating duplicates.'});
    }
    if(options.writeIgnore!==false){
      const ignoreFile=path.join(project.agentPath,'.aixignore'),ignore=await fs.readFile(ignoreFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      const additions=['.agents/','.claude/','.cursor/','.codex/'].filter(rule=>!ignore.split(/\r?\n/).includes(rule));
      if(additions.length)await fs.appendFile(ignoreFile,(ignore&&!ignore.endsWith('\n')?'\n':'')+additions.join('\n')+'\n');
    }
    return {skills:results,officialRules:'aiui-dev',workflowRules:'aiui-workshop',scope:options.writeIgnore===false?'user':'project',reloadRequired:results.some(item=>['updated','adopted','installed'].includes(item.status)),delivery:'Managed global and project copies update automatically; read current inline guidance in this chat, as client skill caches may require a reload.'};
  })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
