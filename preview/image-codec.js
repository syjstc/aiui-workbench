import { zlibSync } from 'fflate';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value;
}
function write32(bytes, offset, value) {
  bytes[offset] = value >>> 24; bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8; bytes[offset + 3] = value;
}
function chunk(type, data) {
  const bytes = new Uint8Array(data.length + 12); write32(bytes, 0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  write32(bytes, bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

// PNG is the simulator's supported encoding fallback, including requests for
// JPEG. The returned Blob always reports its actual image/png MIME type.
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16777216)
    throw new RangeError('Image dimensions must contain 1–16777216 pixels');
  const stride = width * 4;
  if (rgba.length !== stride * height) throw new RangeError('RGBA dimensions do not match');
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13); write32(header, 0, width); write32(header, 4, height); header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(rows, { level: 1 })), chunk('IEND', new Uint8Array())];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
