import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../core/util.mjs';

export async function prepareWindowsIcon(root = ROOT) {
  const images = await Promise.all([16, 32, 128, 256].map(size => fs.readFile(path.join(root, `assets/app.iconset/icon_${size}x${size}.png`))));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [index, image] of images.entries()) {
    const width = image.readUInt32BE(16), height = image.readUInt32BE(20), entry = 6 + index * 16;
    if (!width || width > 256 || !height || height > 256) throw new Error('Invalid Windows icon dimensions');
    header[entry] = width % 256; header[entry + 1] = height % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }
  const file = path.join(root, 'assets/app.ico');
  await fs.writeFile(file, Buffer.concat([header, ...images]));
  return file;
}
