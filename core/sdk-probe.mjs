import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run each version in a separate process: wasm-bindgen keeps a module singleton.
const [directory, ranges = '[]'] = process.argv.slice(2);
const sdk = await import(pathToFileURL(path.join(directory, 'index.js')).href);
for (const name of ['createInkView', 'getInkVersion', 'getInkBundleVersion', 'satisfiesInkEngine']) {
  if (typeof sdk[name] !== 'function') throw new Error(`工坊需要的 SDK 接口缺失：${name}`);
}
for (const name of ['destroy', 'openBundle', 'setHostCapabilities', 'setOnMessage', 'setOnClosed', 'setTarget', 'focus', 'blur', 'bindDomEvents', 'startRendering', 'isRunning', 'isRendering', 'isDestroyed', 'getHostCapabilitiesTarget', 'notifyUserInteraction', 'dispatchInput', 'setInputEnabled', 'dispatchConnectivityEvent', 'render']) {
  if (typeof sdk.InkView?.prototype[name] !== 'function') throw new Error(`工坊需要的 InkView 接口缺失：${name}`);
}
const wasm = await import(pathToFileURL(path.join(directory, 'pkg/ink_web.js')).href);
await wasm.default({ module_or_path: await fs.readFile(path.join(directory, 'pkg/ink_web_bg.wasm')) });
const matches = JSON.parse(ranges).map(range => {
  try { return { range, compatible: sdk.satisfiesInkEngine(range) === true }; }
  catch (error) { return { range, compatible: false, error: error.message }; }
});
process.stdout.write('\nWORKBENCH_SDK_PROBE ' + JSON.stringify({ runtime: sdk.getInkVersion(), bundleVersion: sdk.getInkBundleVersion(), matches }) + '\n');
