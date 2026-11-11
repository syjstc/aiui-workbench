import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../core/util.mjs';

export async function generateLicenses() {
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const packages = [];
  for (const [directory, entry] of Object.entries(lock.packages)) {
    if (!directory || entry.dev || entry.link) continue;
    const location = path.join(ROOT, directory);
    const metadata = await fs.readFile(path.join(location, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!metadata) continue; // Optional packages for a different host.
    const names = (await fs.readdir(location)).filter(name => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name)).sort();
    const notices = [];
    for (const name of names) if ((await fs.stat(path.join(location, name))).isFile()) notices.push({ file: name, text: await fs.readFile(path.join(location, name), 'utf8') });
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license || entry.license || 'See upstream package', ...(metadata.repository ? { repository: metadata.repository } : {}), notices });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  await fs.writeFile(path.join(ROOT, 'THIRD_PARTY_LICENSES.json'), JSON.stringify({ description: 'Production npm dependency licenses. Original notices are also retained in node_modules. See NOTICE.md for Electron, official documentation, ADB and scrcpy.', packages }, null, 2) + '\n');
  return packages.length;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('Dependency notices:', await generateLicenses());
