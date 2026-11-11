// scrcpy 5.0.1, send_device_meta=false. The first dummy byte is consumed
// during connection setup. Metadata and media packets share a 12-byte header.
export class MirrorPacketParser {
  constructor(onPacket){this.onPacket=onPacket;this.buffer=Buffer.alloc(0);this.codec=false;}
  push(chunk){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    if(!this.codec){if(this.buffer.length<4)return;if(this.buffer.toString('ascii',0,4)!=='h264')throw new Error('内嵌投屏返回了不支持的视频编码');this.buffer=this.buffer.subarray(4);this.codec=true;}
    while(this.buffer.length>=12){
      const session=!!(this.buffer[0]&0x80),length=session?0:this.buffer.readUInt32BE(8);
      if(length>4*1024*1024)throw new Error('投屏视频包超过限制');
      if(this.buffer.length<12+length)return;
      const bytes=this.buffer.subarray(0,12+length);this.buffer=this.buffer.subarray(12+length);
      if(session){const width=bytes.readUInt32BE(4),height=bytes.readUInt32BE(8);if(!width||!height||width>8192||height>8192)throw new Error('投屏画面尺寸无效');this.onPacket({type:'session',width,height,bytes});}
      else this.onPacket({type:'media',config:!!(bytes[0]&0x40),key:!!(bytes[0]&0x20),bytes});
    }
  }
}
const KEYS={Enter:66,Backspace:4,Escape:4,ArrowUp:19,ArrowDown:20,ArrowLeft:21,ArrowRight:22,Space:62,Home:3};
export function mirrorInput(message,width,height){
  if(message.type==='key'){
    if(!Object.hasOwn(KEYS,message.code)||![0,1].includes(message.action))throw new Error('不支持的投屏按键');
    const bytes=Buffer.alloc(14);bytes[0]=0;bytes[1]=message.action;bytes.writeUInt32BE(KEYS[message.code],2);return bytes;
  }
  if(message.type==='touch'){
    if(![0,1,2,3].includes(message.action)||![message.x,message.y].every(Number.isFinite))throw new Error('投屏触控参数无效');
    const bytes=Buffer.alloc(32);bytes[0]=2;bytes[1]=message.action;bytes.writeBigUInt64BE(0xfffffffffffffffen,2);
    bytes.writeUInt32BE(Math.max(0,Math.min(width-1,Math.round(message.x))),10);bytes.writeUInt32BE(Math.max(0,Math.min(height-1,Math.round(message.y))),14);
    bytes.writeUInt16BE(width,18);bytes.writeUInt16BE(height,20);bytes.writeUInt16BE([1,3].includes(message.action)?0:65535,22);return bytes;
  }
  throw new Error('不支持的投屏输入');
}
