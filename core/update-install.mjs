import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { atomicJson, id, readJson, run } from './util.mjs';

export function validateUpdateArchive(bytes) {
  bytes=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let total=0;const links=new Set();
  // Check Unix symlinks before extraction as macOS app bundles legitimately
  // contain framework links. Their targets must stay within this app bundle.
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw new Error('升级安装包格式无效');
  const count=bytes.readUInt16LE(end+10);let position=bytes.readUInt32LE(end+16);
  if(count===65535||position+bytes.readUInt32LE(end+12)>end)throw new Error('升级安装包格式无效');
  for(let n=0;n<count;n++){
    const i=position;if(i+46>end||bytes.readUInt32LE(i)!==0x02014b50)throw new Error('升级安装包格式无效');
    const nameLength=bytes.readUInt16LE(i+28),extraLength=bytes.readUInt16LE(i+30),commentLength=bytes.readUInt16LE(i+32),mode=bytes.readUInt32LE(i+38)>>>16;
    if(i+46+nameLength+extraLength+commentLength>end)throw new Error('升级安装包格式无效');
    if((mode&0xf000)===0xa000){if(bytes.readUInt32LE(i+24)>4096)throw new Error('升级安装包符号链接过长');links.add(bytes.subarray(i+46,i+46+nameLength).toString('utf8'));}
    position+=46+nameLength+extraLength+commentLength;
  }
  const linkData=unzipSync(bytes,{filter:entry=>links.has(entry.name)});
  for(const name of links){
    const link=new TextDecoder('utf-8',{fatal:true}).decode(linkData[name]||new Uint8Array());
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),link));
    if(!link||link.startsWith('/')||link.includes('\\')||/[\x00-\x1f]/.test(link)||!resolved.startsWith('AIUI Workshop.app/'))throw new Error('升级安装包包含不安全的符号链接');
  }
  unzipSync(bytes,{filter:entry=>{
    const name=entry.name;
    if(name.startsWith('/')||name.includes('\\')||name.includes(':')||name.split('/').includes('..')||/[\x00-\x1f]/.test(name))throw new Error('升级安装包包含不安全的路径');
    total+=entry.originalSize;if(total>2*1024**3)throw new Error('升级安装包解压后超过限制');
    return false;
  }});
}

export function macInstallScript() {
  return `#!/bin/sh
set -u
pid="$1"; next="$2"; target="$3"; backup="$4"; result="$5"; opener="$6"; profile="$7"
attempt=0
while kill -0 "$pid" 2>/dev/null; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 120 ]; then printf '%s\\n' timeout > "$result"; exit 1; fi
  sleep 0.25
done
if ! /bin/mv "$target" "$backup"; then printf '%s\\n' failed > "$result"; exit 1; fi
if ! /bin/mv "$next" "$target"; then
  /bin/mv "$backup" "$target"
  printf '%s\\n' rollback > "$result"
  "$opener" -n --env "AIUI_WORKBENCH_HOME=$profile" "$target"
  exit 1
fi
if ! "$opener" -n --env "AIUI_WORKBENCH_HOME=$profile" "$target"; then
  /bin/mv "$target" "$next"
  /bin/mv "$backup" "$target"
  printf '%s\\n' rollback > "$result"
  "$opener" -n --env "AIUI_WORKBENCH_HOME=$profile" "$target"
  exit 1
fi
printf '%s\\n' installed > "$result"
`;
}

export async function prepareMacUpdate({home,downloaded,target,pid,command=run,arch=process.arch}) {
  if(!downloaded?.path||!downloaded.version||!/^[a-f\d]{64}$/i.test(downloaded.sha256)||!Number.isSafeInteger(pid)||pid<=1)throw new Error('升级参数无效');
  target=await fs.realpath(target);
  if(!target.endsWith('.app'))throw new Error('当前运行方式不支持自动安装，请下载 DMG 手动安装');
  await fs.access(path.dirname(target),fs.constants.W_OK).catch(()=>{throw new Error('当前安装目录不可写，请下载 DMG 手动安装');});
  const hash=createHash('sha256');for await(const chunk of createReadStream(downloaded.path))hash.update(chunk);
  if(hash.digest('hex')!==downloaded.sha256||(await fs.stat(downloaded.path)).size!==downloaded.size)throw new Error('升级安装包校验失败，请重新下载');
  validateUpdateArchive(await fs.readFile(downloaded.path));
  const work=await fs.mkdtemp(path.join(path.dirname(downloaded.path),'install-'));
  const staged=path.join(work,'AIUI Workshop.app'),suffix=id(),next=target+'.next-'+suffix,backup=target+'.backup-'+suffix;
  const receipt=path.join(home,'update-install.json'),resultFile=path.join(work,'result.txt'),script=path.join(work,'install.sh');
  async function execute(name,args){const result=await command(name,args,{timeout:120000});if(result.code)throw new Error('升级安装包验证失败：'+result.output);return result.output.trim();}
  try {
    await execute('ditto',['-x','-k',downloaded.path,work]);
    const plist=path.join(staged,'Contents/Info.plist');
    const identifier=await execute('plutil',['-extract','CFBundleIdentifier','raw','-o','-',plist]);
    const version=await execute('plutil',['-extract','CFBundleShortVersionString','raw','-o','-',plist]);
    if(identifier!=='local.aiui.workbench'||version!==downloaded.version)throw new Error('升级安装包的应用身份或版本不符');
    const architecture=await execute('lipo',['-archs',path.join(staged,'Contents/MacOS/AIUI Workshop')]);
    if(!architecture.split(/\s+/).includes(arch==='arm64'?'arm64':'x86_64'))throw new Error('升级安装包与当前处理器不兼容');
    await execute('codesign',['--verify','--deep','--strict',staged]);
    const signature=await execute('codesign',['--display','--verbose=4',staged]);
    if(!signature.includes('Authority=Developer ID Application:')||!signature.match(/TeamIdentifier=([A-Z\d]+)/))throw new Error('升级安装包缺少有效的开发者签名');
    const current=await command('codesign',['--display','--verbose=4',target]);
    const oldTeam=current.output?.match(/TeamIdentifier=([A-Z\d]+)/)?.[1],newTeam=signature.match(/TeamIdentifier=([A-Z\d]+)/)[1];
    if(oldTeam&&oldTeam!=='not'&&oldTeam!==newTeam)throw new Error('升级安装包的签名发布者与当前应用不一致');
    await execute('spctl',['--assess','--type','execute',staged]);
    await execute('ditto',[staged,next]);
    await fs.writeFile(script,macInstallScript(),{mode:0o700});
    await atomicJson(receipt,{version:downloaded.version,target,next,backup,resultFile,phase:'prepared',preparedAt:new Date().toISOString()});
    const cancel=async()=>{await fs.rm(next,{recursive:true,force:true});await fs.rm(work,{recursive:true,force:true});const saved=await readJson(receipt,null);if(saved?.next===next)await fs.rm(receipt,{force:true});};
    return {script,args:[String(pid),next,target,backup,resultFile,'/usr/bin/open',home],version:downloaded.version,cancel};
  } catch(error) { await fs.rm(next,{recursive:true,force:true});await fs.rm(work,{recursive:true,force:true});throw error; }
}

export async function finishMacUpdate(home,{target,version}) {
  const receipt=await readJson(path.join(home,'update-install.json'),null);
  if(!receipt||receipt.version!==version||receipt.target!==target||receipt.phase==='complete')return false;
  if(!receipt.backup?.startsWith(target+'.backup-')||!/^[-a-f\d]+$/.test(receipt.backup.slice((target+'.backup-').length)))return false;
  receipt.phase='complete';receipt.completedAt=new Date().toISOString();await atomicJson(path.join(home,'update-install.json'),receipt);
  await fs.rm(receipt.backup,{recursive:true,force:true});return true;
}
