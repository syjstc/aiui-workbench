// Read finalized MP4 timing/geometry without adding a runtime FFmpeg dependency.
export function mp4Metadata(bytes) {
  function boxes(start,end){const result=[];for(let at=start;at+8<=end;){let size=bytes.readUInt32BE(at),header=8;const type=bytes.toString('ascii',at+4,at+8);if(size===1){if(at+16>end)break;size=Number(bytes.readBigUInt64BE(at+8));header=16;}if(size===0)size=end-at;if(!Number.isSafeInteger(size)||size<header||at+size>end)break;result.push({type,start:at+header,end:at+size});at+=size;}return result;}
  const top=boxes(0,bytes.length),movie=top.find(b=>b.type==='moov');
  if(!top.some(b=>b.type==='ftyp')||!movie||!top.some(b=>b.type==='mdat'))throw new Error('MP4 尚未完成封装');
  const metadata={},children=boxes(movie.start,movie.end),header=children.find(b=>b.type==='mvhd');
  if(header){const p=header.start,version=bytes[p],scaleAt=p+(version===1?20:12),durationAt=scaleAt+4;if(durationAt+(version===1?8:4)<=header.end){const scale=bytes.readUInt32BE(scaleAt),duration=version===1?Number(bytes.readBigUInt64BE(durationAt)):bytes.readUInt32BE(durationAt);if(scale>0&&duration>0&&Number.isSafeInteger(duration))metadata.durationMs=Math.round(duration*1000/scale);}}
  for(const track of children.filter(b=>b.type==='trak')){const h=boxes(track.start,track.end).find(b=>b.type==='tkhd');if(h&&h.end-h.start>=80){const width=bytes.readUInt32BE(h.end-8)/65536,height=bytes.readUInt32BE(h.end-4)/65536;if(width>0&&height>0){metadata.width=width;metadata.height=height;break;}}}
  return metadata;
}
