import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets'), branding = path.join(assets, 'branding');
const source = path.join(branding, 'aiui-workshop-icon-master.png');
const iconset = path.join(assets, 'app.iconset');
await fs.mkdir(iconset, { recursive: true });
// Export sizes only; the generated master remains the source of the artwork.
const resize = (size, file) => execFileSync('sips', ['-z', String(size), String(size), source, '--out', file], { stdio: 'ignore' });
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(iconset, `icon_${size}x${size}.png`));
  resize(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
for (const size of [16, 32, 48, 64, 180, 256]) resize(size, path.join(branding, `icon-${size}.png`));
resize(512, path.join(assets, 'icon.png'));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'app.icns')]);
// Modern ICO containers support PNG frames, keeping alpha at every size.
const sizes = [16, 32, 48, 64, 256];
const frames = await Promise.all(sizes.map(size => fs.readFile(path.join(branding, `icon-${size}.png`))));
const header = Buffer.alloc(6 + frames.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((frame, i) => {
  const start = 6 + i * 16;
  header[start] = header[start + 1] = sizes[i] === 256 ? 0 : sizes[i];
  header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(frame.length, start + 8); header.writeUInt32LE(offset, start + 12); offset += frame.length;
});
const ico = Buffer.concat([header, ...frames]);
await fs.writeFile(path.join(assets, 'app.ico'), ico);
await fs.writeFile(path.join(branding, 'favicon.ico'), ico);
console.log('Exported desktop icons, PNG sizes and favicon from the generated master.');
