import fs from 'node:fs/promises';
import path from 'node:path';
import { sign, walk } from '@electron/osx-sign';
import { ROOT, run } from '../core/util.mjs';
import { APP_INFO } from '../core/version.mjs';

export async function signMac(app) {
  const identity = process.env.MACOS_SIGN_IDENTITY;
  if (process.platform !== 'darwin' || !identity?.startsWith('Developer ID Application:')) throw new Error('Set MACOS_SIGN_IDENTITY to an installed Developer ID Application certificate.');
  // osx-sign discovers every binary resource, including PNG, PAK and WASM.
  // Sign actual Mach-O code and bundles; ordinary resources are sealed by
  // their containing bundle, rather than receiving detached code signatures.
  const magic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  const resources = new Set();
  for (const file of await walk(path.join(app, 'Contents'))) {
    if (file.endsWith('.app') || file.endsWith('.framework')) continue;
    const handle = await fs.open(file, 'r');
    try { const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); if (!magic.has(header.toString('hex'))) resources.add(file); }
    finally { await handle.close(); }
  }
  // All nested Mach-O files include ADB, scrcpy and Electron helpers.
  // Entitlements are needed by Electron/V8 and the opt-in camera only.
  await sign({ app, identity, platform: 'darwin', version: APP_INFO.devDependencies.electron,
    ignore: file => resources.has(file),
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: file => ({ hardenedRuntime: true, entitlements: path.join(ROOT, 'electron/entitlements.mac.plist'), ...(file.includes('/vendor/') ? { entitlements: [] } : {}) }),
  });
  const verified = await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (verified.code) throw new Error(verified.output);
  const details = await run('codesign', ['--display', '--verbose=4', app]);
  if (details.code || !details.output.includes(`Authority=${identity}`) || !details.output.includes('runtime')) throw new Error('Developer ID / hardened runtime verification failed: ' + details.output);
  await fs.writeFile(path.join(path.dirname(app), 'signature-verification.txt'), details.output + verified.output);
  console.log('Developer ID signature verified:', app);
}
