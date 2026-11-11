import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, run, sha } from '../core/util.mjs';

const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(os.homedir(),'Library/Android/sdk');
const java = process.env.JAVA_HOME || '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home';
const temporary = path.join(ROOT,'.local/app-info-build');
const source = path.join(ROOT,'assets/android/AppInfo.java');
await fs.mkdir(path.join(temporary,'classes'),{recursive:true});
await fs.mkdir(path.join(temporary,'dex'),{recursive:true});
for (const [command,args] of [
  [path.join(java,'bin/javac'),['-source','8','-target','8','-classpath',path.join(sdk,'platforms/android-35/android.jar'),'-d',path.join(temporary,'classes'),source]],
  [path.join(sdk,'build-tools/35.0.1/d8'),['--min-api','23','--lib',path.join(sdk,'platforms/android-35/android.jar'),'--output',path.join(temporary,'dex'),path.join(temporary,'classes/local/aiui/workbench/AppInfo.class')]],
]) {
  const result=await run(command,args,{timeout:30000,env:{...process.env,JAVA_HOME:java}});
  if(result.code)throw new Error(result.output);
}
const dex=await fs.readFile(path.join(temporary,'dex/classes.dex'));
await fs.writeFile(path.join(ROOT,'assets/android/app-info.dex'),dex);
await fs.writeFile(path.join(ROOT,'assets/android/app-info.json'),JSON.stringify({schemaVersion:1,minApi:23,sourceSha256:sha(await fs.readFile(source)),dexSha256:sha(dex)},null,2)+'\n');
console.log('Built read-only Android app metadata helper:',dex.length,'bytes');
