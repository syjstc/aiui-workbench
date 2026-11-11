import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../preview/image-codec.js';

test('simulator PNG encoding preserves dimensions, row order and RGBA pixels', () => {
  const rgba = new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,128,64,32,128]);
  const png = Buffer.from(encodePng(2, 2, rgba));
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const chunks = []; let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) }); offset += length + 12;
  }
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR','IDAT','IEND']);
  assert.equal(chunks[0].data.readUInt32BE(0), 2); assert.equal(chunks[0].data.readUInt32BE(4), 2);
  assert.deepEqual([...inflateSync(chunks[1].data)], [0,...rgba.subarray(0,8),0,...rgba.subarray(8)]);
  assert.throws(() => encodePng(100, 100, rgba), /dimensions/);
});
