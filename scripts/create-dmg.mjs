import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT,run,id } from '../core/util.mjs';
import { APP_VERSION } from '../core/version.mjs';
const {values}=parseArgs({options:{app:{type:'string'},out:{type:'string'}}});
if(process.platform!=='darwin')throw new Error('Create the DMG on macOS.');
const app=path.resolve(values.app||path.join(ROOT,'output/release/AIUI Workshop-darwin-arm64/AIUI Workshop.app'));
const out=path.resolve(values.out||path.dirname(path.dirname(app))),stage=path.join(ROOT,'.local/dmg-'+id());
await fs.mkdir(stage,{recursive:true});await fs.mkdir(out,{recursive:true});
async function execute(name,args){const result=await run(name,args,{timeout:300000});if(result.code)throw new Error(result.output);return result.output.trim();}
try {
  const version=await execute('plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(app,'Contents/Info.plist')]);
  if(version!==APP_VERSION)throw new Error('DMG app version does not match package.json.');
  await execute('codesign',['--verify','--deep','--strict',app]);
  await execute('xcrun',['stapler','validate',app]);
  await execute('ditto',[app,path.join(stage,'AIUI Workshop.app')]);
  await fs.symlink('/Applications',path.join(stage,'Applications'));
  const file=path.join(out,`AIUI-Workbench-${version}-darwin-arm64.dmg`);
  await execute('hdiutil',['create','-volname',`AIUI 工坊 ${version}`,'-srcfolder',stage,'-format','UDZO','-ov',file]);
  console.log(file);
} finally {await fs.rm(stage,{recursive:true,force:true});}
