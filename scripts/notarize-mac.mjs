import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { ROOT, run, sleep, readJson, atomicJson } from '../core/util.mjs';
import { APP_VERSION } from '../core/version.mjs';

const { values } = parseArgs({ options: { app: { type: 'string' }, out: { type: 'string' } } });
if (process.platform !== 'darwin') throw new Error('Notarization requires macOS.');
const localEnv = await fs.readFile(path.join(ROOT, '.env.packaging'), 'utf8').catch(() => '');
for (const [key, value] of Object.entries(parseEnv(localEnv))) if (process.env[key] === undefined) process.env[key] = value;
const env = process.env;
const auth = env.APPLE_NOTARY_KEYCHAIN_PROFILE ? ['--keychain-profile', env.APPLE_NOTARY_KEYCHAIN_PROFILE]
  : env.APPLE_API_KEY && env.APPLE_API_KEY_ID ? ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, ...(env.APPLE_API_ISSUER ? ['--issuer', env.APPLE_API_ISSUER] : [])] : null;
if (!auth) throw new Error('Configure APPLE_NOTARY_KEYCHAIN_PROFILE or APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER.');
const app = path.resolve(values.app || path.join(ROOT, 'output/release/AIUI Workshop-darwin-arm64/AIUI Workshop.app'));
const out = path.resolve(values.out || path.dirname(path.dirname(app)));
// Read the version and architecture from the actual bundle rather than trusting CLI labels.
const version = (await exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')])).trim();
if (version !== APP_VERSION) throw new Error('Bundle version does not match package.json.');
const slices = (await exec('lipo', ['-archs', path.join(app, 'Contents/MacOS/AIUI Workshop')])).trim();
const targetArch = slices === 'arm64' ? 'arm64' : slices === 'x86_64' ? 'x64' : null;
if (!targetArch) throw new Error('Unsupported bundle architecture: ' + slices);
await exec('codesign', ['--verify', '--deep', '--strict', app]);
const signature = await exec('codesign', ['--display', '--verbose=4', app]);
if (!signature.includes('Authority=Developer ID Application:') || !signature.includes('runtime')) throw new Error('Notarization requires a Developer ID signature and hardened runtime.');
await fs.mkdir(out, { recursive: true });
const state = path.join(ROOT, '.local/notary', APP_VERSION + '-' + targetArch); await fs.mkdir(state, { recursive: true });
const submission = path.join(state, 'submission.zip');
let receipt = await readJson(path.join(state, 'receipt.json'), null);
const alreadyStapled = await run('xcrun', ['stapler', 'validate', app]);
if (alreadyStapled.code !== 0) {
  await fs.rm(submission, { force: true }); await exec('ditto', ['-c', '-k', '--keepParent', app, submission]);
  const sha256 = await hash(submission);
  if (!receipt?.id || receipt.sha256 !== sha256) {
    const result = JSON.parse(await exec('xcrun', ['notarytool', 'submit', submission, ...auth, '--output-format', 'json'], 600000));
    if (!result.id) throw new Error('Apple returned no notarization submission ID.');
    receipt = { id: result.id, sha256, status: 'In Progress', version, arch: targetArch };
    await atomicJson(path.join(state, 'receipt.json'), receipt);
  }
  const deadline = Date.now() + 45 * 60000;
  while (Date.now() < deadline) {
    const info = JSON.parse(await exec('xcrun', ['notarytool', 'info', receipt.id, ...auth, '--output-format', 'json']));
    receipt.status = info.status; await atomicJson(path.join(state, 'receipt.json'), receipt);
    console.log('Apple notarization:', receipt.id, receipt.status);
    if (receipt.status === 'Accepted') break;
    if (receipt.status !== 'In Progress') {
      await fs.writeFile(path.join(state, 'log.json'), await exec('xcrun', ['notarytool', 'log', receipt.id, ...auth]));
      throw new Error('Apple notarization failed; see .local/notary log.json.');
    }
    await sleep(15000);
  }
  if (receipt.status !== 'Accepted') throw new Error('Notarization is still pending. Re-run this command to resume.');
  await exec('xcrun', ['stapler', 'staple', app]);
}
await exec('xcrun', ['stapler', 'validate', app]);
await exec('codesign', ['--verify', '--deep', '--strict', app]);
const gatekeeper = await exec('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
const archive = path.join(out, `AIUI-Workbench-${APP_VERSION}-darwin-${targetArch}.zip`);
await fs.rm(archive, { force: true }); await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
const report = { version, platform: 'darwin', arch: targetArch, developerIdSigned: true, hardenedRuntime: true, notarized: true, stapled: true, gatekeeperAccepted: true, submissionId: receipt?.id, sha256: await hash(archive), bytes: (await fs.stat(archive)).size, gatekeeper: gatekeeper.trim() };
await atomicJson(path.join(out, `macos-verification-${targetArch}.json`), report);
console.log(JSON.stringify(report, null, 2));

async function exec(command, args, timeout = 120000) { const result = await run(command, args, { timeout }); if (result.code) throw new Error(path.basename(command) + ': ' + result.output); return result.output; }
async function hash(file) { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex'); }
