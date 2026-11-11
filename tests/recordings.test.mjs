import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CanvasRecording} from '../preview/recording.mjs';
import {Recordings} from '../core/recordings.mjs';
import {recordingSchema,clipSchema} from '../core/automation-contract.mjs';
import {sleep} from '../core/util.mjs';
import {mp4Metadata} from '../core/video-metadata.mjs';

test('canvas recording samples a static screen, finalizes once and releases its media track',async t=>{
  const previous=globalThis.MediaRecorder;let frames=0,stopped=0,uploads=0;
  class Recorder extends EventTarget{static isTypeSupported(type){return type==='video/webm';}constructor(){super();this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{const event=new Event('dataavailable');event.data=new Blob(['real media output is validated separately by ffprobe']);this.dispatchEvent(event);this.dispatchEvent(new Event('stop'));});}}
  globalThis.MediaRecorder=Recorder;t.after(()=>{globalThis.MediaRecorder=previous;});
  const track={requestFrame(){frames++;},stop(){stopped++;}},canvas={width:480,height:352,captureStream(){return{getTracks:()=>[track],getVideoTracks:()=>[track]};}};
  const recording=new CanvasRecording(canvas,async(id,blob,meta)=>{uploads++;assert.equal(id,'r1');assert.equal(meta.revision,'source');assert.equal(meta.runId,'instance');assert.equal(meta.stopReason,'stopped');assert.ok(blob.size);return{path:'video.webm'};});
  recording.start({id:'r1',durationSeconds:2,fps:30,revision:'source',runId:'instance'});assert.throws(()=>recording.start({id:'r2'}),/已有录制/);
  await sleep(80);const result=await recording.stop();assert.equal(result.path,'video.webm');assert.ok(frames>=2);assert.equal(stopped,1);assert.equal(uploads,1);assert.equal(await recording.stop(),null);assert.equal(recording.state(),null);
});

async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),'recording-test-'));const w={home,emit(){},projects:{get:()=>({revision:'revision',toolchainId:'sdk'})},previews:{sessions:new Map()}};const recordings=await new Recordings(w).init();t.after(async()=>{for(const r of recordings.items)if(['starting','recording','finalizing'].includes(r.status))r.status='interrupted';await recordings.close();await fs.rm(home,{recursive:true,force:true});});return{home,w,recordings};}
test('unfinished recordings are marked interrupted after restart, never completed',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.home,'recordings.json'),JSON.stringify([{id:'old',source:'glasses',status:'recording'}]));const next=await new Recordings(f.w).init();t.after(()=>next.close());assert.equal(next.status({recordingId:'old'}).status,'interrupted');
});
test('invalid or partial uploads cannot become completed videos and remove temporary data',async t=>{
  const {recordings,home}=await fixture(t),r={id:'r1',source:'simulator',sessionId:'s1',status:'recording',durationSeconds:10,runId:'run'};recordings.items.push(r);
  const req=(async function*(){yield Buffer.from('invalid video bytes');})();req.headers={'content-type':'video/mp4','x-recording-metadata':JSON.stringify({width:480,height:352,durationMs:1000,runId:'run'})};
  await assert.rejects(recordings.receive({id:'other'},'r1',req),/会话无效/);
  await assert.rejects(recordings.receive({id:'s1'},'r1',req),/为空或不完整/);assert.equal(r.status,'failed');assert.ok(!(await fs.readdir(path.join(home,'recordings'))).some(name=>name.endsWith('.partial')));
});
test('recording parameters bound clip duration and require an explicit simulator or device source',()=>{
  assert.equal(recordingSchema.safeParse({source:'desktop'}).success,false);assert.equal(recordingSchema.safeParse({source:'simulator',durationSeconds:121}).success,false);assert.equal(clipSchema.safeParse({source:'glasses',serial:'device',durationSeconds:31}).success,false);assert.equal(clipSchema.parse({source:'simulator',sessionId:'s'}).durationSeconds,10);
});
test('MP4 metadata uses media duration rather than process startup and shutdown time',()=>{
  const box=(type,payload)=>{const b=Buffer.alloc(payload.length+8);b.writeUInt32BE(b.length);b.write(type,4);payload.copy(b,8);return b;};
  const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(1100,16);
  const tkhd=Buffer.alloc(84);tkhd.writeUInt32BE(480*65536,76);tkhd.writeUInt32BE(640*65536,80);
  const file=Buffer.concat([box('ftyp',Buffer.alloc(16)),box('mdat',Buffer.alloc(16)),box('moov',Buffer.concat([box('mvhd',mvhd),box('trak',box('tkhd',tkhd))]))]);
  assert.deepEqual(mp4Metadata(file),{durationMs:1100,width:480,height:640});assert.throws(()=>mp4Metadata(file.subarray(0,45)),/未完成/);
});
