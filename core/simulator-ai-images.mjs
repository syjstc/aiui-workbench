// Header-only limits keep image handoffs small without decoding or rewriting
// the application's image. Reject oversized input instead of silently cropping.
export function aiImageSize(bytes,mime){
  if(mime==='image/png'&&bytes.length>=24&&bytes.toString('ascii',12,16)==='IHDR')return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(mime==='image/jpeg'){
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==255)return null;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===0xd9||marker===0xda)return null;
      if(marker===0x01||marker>=0xd0&&marker<=0xd8)continue;
      if(offset+2>bytes.length)return null;
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)return null;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
      offset+=length;
    }
  }
  if(mime==='image/webp'){
    const kind=bytes.toString('ascii',12,16);
    if(kind==='VP8X'&&bytes.length>=30)return [1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3)];
    if(kind==='VP8 '&&bytes.length>=30&&bytes.toString('hex',23,26)==='9d012a')return [bytes.readUInt16LE(26)&0x3fff,bytes.readUInt16LE(28)&0x3fff];
    if(kind==='VP8L'&&bytes.length>=25&&bytes[20]===0x2f)return [1+(bytes[21]|(bytes[22]&63)<<8),1+((bytes[22]>>6)|bytes[23]<<2|(bytes[24]&15)<<10)];
  }
  return null;
}
