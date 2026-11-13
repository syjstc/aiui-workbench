import fs from 'node:fs/promises';
import path from 'node:path';
import {safeRelative,id} from './util.mjs';
import {collectFiles,sourceRevision} from './projects.mjs';

const hidden=part=>part.startsWith('.')||['node_modules','dist','output','artifacts'].includes(part.toLowerCase());
function sourcePath(value,write=false){safeRelative(value);if(value.split('/').some(part=>hidden(part)||(write&&['agents.md','claude.md'].includes(part.toLowerCase()))))throw new Error('这里只能编辑应用源码，不能写入工具配置、指令或隐藏目录');return value;}
async function destination(root,relative){
  let current=root;
  for(const part of relative.split('/')){
    current=path.join(current,part);
    const stat=await fs.lstat(current).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(stat?.isSymbolicLink())throw new Error('不能通过符号链接访问项目外部文件');
  }
  return current;
}

export class ProjectFiles {
  constructor(w){this.w=w;this.writing=new Set();}
  async operate({projectId,action,paths,files,expectedRevision}){
    const w=this.w,p=w.projects.get(projectId),root=await fs.realpath(p.agentPath);
    const snapshot=await collectFiles(root),revision=sourceRevision(snapshot);
    if(action==='list')return {projectId,revision,root,files:snapshot.filter(f=>!f.path.split('/').some(hidden)).map(f=>({path:f.path,bytes:f.data.length}))};
    if(action==='read'){
      if(!paths?.length)throw new Error('请指定要读取的源码相对路径');
      let bytes=0;const result=[];
      for(const relative of paths){sourcePath(relative);const file=await destination(root,relative),data=await fs.readFile(file);bytes+=data.length;if(bytes>1024*1024)throw new Error('一次最多读取 1 MB 文本源码，请分开读取');const content=data.toString('utf8');if(!Buffer.from(content).equals(data)||data.includes(0))throw new Error('此工具读取 UTF-8 文本源码，所选文件是二进制资源');result.push({path:relative,content});}
      return {projectId,revision,files:result};
    }
    if(!files?.length||!expectedRevision)throw new Error('写入前请先读取源码，并传入 expectedRevision 和 files');
    if(this.writing.has(projectId))throw new Error('该项目正在写入，请完成后读取最新版本再修改');
    if(w.jobs.list().some(j=>j.projectId===projectId&&j.status==='running'))throw new Error('该项目仍有任务运行，请等待完成或取消后再编辑');
    this.writing.add(projectId);const written=[];
    try{
      if(revision!==expectedRevision)throw Object.assign(new Error('源码已变化，未写入；请重新读取并合并最新改动'),{result:{currentRevision:revision,written:[]}});
      if(new Set(files.map(f=>f.path)).size!==files.length)throw new Error('一次写入不能包含重复路径');
      if(files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>1024*1024)throw new Error('一次最多写入 1 MB 文本源码');
      const targets=[];
      for(const file of files){
        sourcePath(file.path,true);if(file.content.includes('\0'))throw new Error('源码不能包含二进制空字符');
        if(file.path==='app.json'){const app=JSON.parse(file.content);if(!app||Array.isArray(app)||typeof app!=='object')throw new Error('app.json 必须是 JSON 对象');}
        const target=await destination(root,file.path),stat=await fs.lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
        if(stat&&!stat.isFile())throw new Error('只能写入普通源码文件，不能覆盖目录');
        targets.push({...file,file:target,mode:stat?stat.mode&0o777:0o600});
      }
      // Check again after preflight; invalid paths never cause a partial edit.
      const current=sourceRevision(await collectFiles(root));if(current!==revision)throw Object.assign(new Error('写入前源码已变化，请重新读取并合并'),{result:{currentRevision:current,written:[]}});
      for(const target of targets){
        await fs.mkdir(path.dirname(target.file),{recursive:true});const temp=path.join(path.dirname(target.file),'.aiui-edit-'+id());
        try{await fs.writeFile(temp,target.content,{flag:'wx',mode:target.mode});await fs.rename(temp,target.file);written.push(target.path);}finally{await fs.rm(temp,{force:true});}
      }
      const nextRevision=sourceRevision(await collectFiles(root));
      let metadataError;try{await w.projects.refresh(projectId);}catch(error){metadataError=error.message;await w.captureDiagnostic(error,{source:'operation',tool:'aiui_project_files',projectId});}
      return {projectId,revision:nextRevision,written,metadataError,nextTool:metadataError?'aiui_project_files':'aiui_workflow_continue'};
    }catch(error){error.result={...error.result,written};throw error;}
    finally{this.writing.delete(projectId);}
  }
}
