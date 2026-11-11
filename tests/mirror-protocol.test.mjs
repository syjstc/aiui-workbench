import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorPacketParser,mirrorInput} from '../core/mirror-protocol.mjs';
import {EmbeddedMirroring} from '../core/embedded-mirroring.mjs';
import {EventEmitter} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';

function metadata(width=480,height=640){const b=Buffer.alloc(12);b[0]=128;b.writeUInt32BE(width,4);b.writeUInt32BE(height,8);return b;}
function media(flags,data){const b=Buffer.alloc(12+data.length);b[0]=flags;b.writeUInt32BE(data.length,8);Buffer.from(data).copy(b,12);return b;}
test('scrcpy video parser handles split codec, session, configuration and video headers without merging frames',()=>{
  const packets=[],parser=new MirrorPacketParser(packet=>packets.push(packet));
  const bytes=Buffer.concat([Buffer.from('h264'),metadata(),media(64,[0,0,0,1,0x67]),media(32,[1,2,3])]);
  for(let i=0;i<bytes.length;i+=3)parser.push(bytes.subarray(i,i+3));
  assert.equal(packets.length,3);assert.equal(packets[0].width,480);assert.equal(packets[0].height,640);assert.equal(packets[1].config,true);assert.equal(packets[2].key,true);
  assert.throws(()=>new MirrorPacketParser(()=>{}).push(Buffer.from('nope')),/不支持/);
  assert.throws(()=>new MirrorPacketParser(()=>{}).push(Buffer.concat([Buffer.from('h264'),metadata(0)])),/尺寸/);
});
test('mirror controls clamp coordinates, preserve screen dimensions, and reject unsupported keys',()=>{
  const bytes=mirrorInput({type:'touch',action:0,x:-3,y:900},480,640);
  assert.equal(bytes.length,32);assert.equal(bytes.readUInt32BE(10),0);assert.equal(bytes.readUInt32BE(14),639);assert.equal(bytes.readUInt16BE(18),480);assert.equal(bytes.readUInt16BE(20),640);
  assert.equal(mirrorInput({type:'key',action:0,code:'Enter'},480,640).readUInt32BE(2),66);
  assert.throws(()=>mirrorInput({type:'key',action:0,code:'F5'},480,640),/按键/);
  assert.throws(()=>mirrorInput({type:'touch',action:0,x:NaN,y:0},480,640),/参数/);
});
test('video capability keys and read-only sessions reject unauthorized stream and control access',()=>{
  const manager=new EmbeddedMirroring({}, {},()=>{},()=> 'http://127.0.0.1:1234');
  const session={id:'session',key:'secret',serial:'device',status:'running',readOnly:true,clients:new Set(),control:{write:()=>assert.fail('must not write')}};
  manager.sessions.set('device',session);
  assert.throws(()=>manager.authorize('session','wrong'),/授权/);assert.equal(manager.authorize('session','secret'),session);
  assert.throws(()=>manager.input(session,{type:'key',action:0,code:'Enter'}),/只允许查看/);
  assert.equal(manager.public(session).control,undefined);
});
test('new viewers refresh a static display and wait for a decodable keyframe',()=>{
  const manager=new EmbeddedMirroring({}, {},()=>{},()=> 'http://127.0.0.1:1234'),written=[],controls=[];
  const response=new EventEmitter();response.writeHead=()=>{};response.write=bytes=>written.push(bytes);response.writableLength=0;
  const session={status:'running',clients:new Set(),metadata:metadata(),config:media(64,[7]),control:{write:bytes=>controls.push(bytes)}};
  manager.attach(session,{},response);
  assert.deepEqual(controls,[Buffer.from([17])]);
  assert.equal(Buffer.concat(written).subarray(0,4).toString(),'h264');
  const before=written.length;
  manager.packet(session,{type:'media',key:false,bytes:media(0,[1])});
  assert.equal(written.length,before,'dependent frame is not sent before a keyframe');
  manager.packet(session,{type:'media',key:true,bytes:media(32,[2])});
  manager.packet(session,{type:'media',key:false,bytes:media(0,[3])});
  assert.equal(written.length,before+2);
});
test('a closing old viewer and its idle timer cannot stop a replacement session',async()=>{
  const manager=new EmbeddedMirroring({}, {},()=>{},()=> 'http://127.0.0.1:1234');let stopped=0;manager.stop=async()=>{stopped++;};
  const previous={serial:'device',status:'running',clients:new Set()};
  manager.sessions.set('device',previous);manager.idle(previous,5);
  const current={serial:'device',status:'running',clients:new Set()};manager.sessions.set('device',current);
  await pause(20);assert.equal(stopped,0,'the old idle timer must retain its original session identity');
  const expiredTimer=previous.idleTimer,response=new EventEmitter();response.writeHead=()=>{};response.write=()=>{};
  previous.control={write:()=>{}};manager.attach(previous,{},response);previous.stopping=true;previous.status='stopped';response.emit('close');
  assert.equal(previous.clients.size,0);assert.equal(previous.idleTimer,expiredTimer,'late close must not schedule another idle timer');
  manager.idle(current,5);await pause(20);assert.equal(stopped,1,'the current unused session still stops normally');
});
