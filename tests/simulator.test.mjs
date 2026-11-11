import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopNavigation } from '../renderer/desktop-navigation.mjs';
import { dragPose, updatePose, poseQuaternion, motionPose, NEUTRAL_POSE } from '../shared/pose.mjs';
import { bindMousePose } from '../preview/mouse-pose.mjs';

test('desktop navigation coalesces long swipes, keyup-only aliases, and a held key', () => {
  const nav = new DesktopNavigation();
  const key=(type,code,timeStamp,repeat=false)=>nav.handle(type,{code,timeStamp,repeat});
  assert.equal(key('keyup','ArrowRight',0),1);
  for(let t=60;t<2000;t+=60)assert.equal(key('keyup',t%120?'ArrowDown':'ArrowRight',t),0);
  assert.equal(key('keyup','ArrowRight',2400),1);
  assert.equal(key('keyup','ArrowLeft',2410),-1);
  nav.reset();
  assert.equal(key('keydown','ArrowRight',3000),0);
  for(let t=3060;t<5000;t+=60)assert.equal(key('keydown','ArrowRight',t,true),0);
  assert.equal(key('keyup','ArrowRight',5000),1);
  assert.equal(key('keyup','ArrowDown',5010),0);
  assert.equal(key('keyup','ArrowRight',5400),1);
  assert.equal(key('keyup','Enter',5500),null);
});

test('delayed callbacks use original event times and reset on leaving the desktop', () => {
  const nav=new DesktopNavigation();
  assert.equal(nav.handle('keyup',{code:'ArrowRight',timeStamp:10}),1);
  // These events can be delivered after a long first paint; their timestamps
  // still belong to the original physical burst.
  for(const timeStamp of [20,35,100,200])assert.equal(nav.handle('keyup',{code:'ArrowDown',timeStamp}),0);
  nav.reset();
  assert.equal(nav.handle('keyup',{code:'ArrowDown',timeStamp:220}),1);
});

test('mouse movement maps right/up/roll to independent axes with finite limits', () => {
  assert.deepEqual(dragPose(NEUTRAL_POSE,80,-40,.25,false),{yaw:20,pitch:10,roll:0});
  assert.deepEqual(dragPose({yaw:20,pitch:10,roll:0},40,200,.25,true),{yaw:20,pitch:10,roll:10});
  assert.deepEqual(dragPose(NEUTRAL_POSE,10000,-10000,1,false),{yaw:180,pitch:89,roll:0});
  assert.deepEqual(dragPose(NEUTRAL_POSE,-10000,0,1,true),{yaw:0,pitch:0,roll:-180});
  assert.throws(()=>updatePose(NEUTRAL_POSE,{roll:NaN}),/有限数字/);
  assert.deepEqual(NEUTRAL_POSE,{yaw:0,pitch:0,roll:0});
});

test('sensor quaternions are normalized with the Android neutral gravity basis', () => {
  const zero=poseQuaternion(NEUTRAL_POSE);
  assert.ok(Math.abs(zero[0]-Math.SQRT1_2)<1e-12);
  assert.equal(zero[1],0);assert.equal(zero[2],0);
  assert.ok(Math.abs(zero[3]-Math.SQRT1_2)<1e-12);
  for(const p of [{yaw:180,pitch:89,roll:-180},{yaw:-60,pitch:-45,roll:40}]) {
    assert.ok(Math.abs(Math.hypot(...poseQuaternion(p))-1)<1e-12);
  }
});

test('automatic motion starts at the current pose and respects amplitude and period', () => {
  const origin={yaw:10,pitch:-4,roll:5,connected:false};
  const motion={pattern:'yaw',amplitude:20,periodMs:4000};
  assert.deepEqual(motionPose(origin,motion,0),origin);
  assert.equal(motionPose(origin,motion,1000).yaw,30);
  assert.equal(motionPose(origin,motion,3000).yaw,-10);
  assert.deepEqual(motionPose(origin,motion,4000),origin);
  assert.equal(motionPose(origin,{...motion,pattern:'pitch'},1000).pitch,16);
  assert.equal(motionPose(origin,{...motion,pattern:'roll'},1000).roll,25);
  assert.equal(motionPose(origin,motion,1000).connected,false);
});

test('mouse follows with no button, anchors on entry, freezes on leave, and preserves clicks', t => {
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  const canvas=new EventTarget();canvas.focus=()=>{};
  let pose={...NEUTRAL_POSE},taps=0,interactions=0,enabled=true,forwarded=0;
  const input=bindMousePose(canvas,{getPose:()=>pose,getOptions:()=>({enabled,sensitivity:.25}),ready:()=>true,onPose:p=>pose=p,onDrag:()=>{},onTap:()=>taps++,onInteract:()=>interactions++});
  t.after(()=>{input.destroy();globalThis.window=oldWindow;globalThis.document=oldDocument;});
  canvas.addEventListener('pointermove',()=>forwarded++);
  function pointer(type,x,y,extra={}){const e=new Event(type,{cancelable:true});Object.assign(e,{pointerId:1,pointerType:'mouse',clientX:x,clientY:y,buttons:0,button:0,shiftKey:false,...extra});canvas.dispatchEvent(e);return e;}
  pointer('pointerenter',100,100);pointer('pointermove',180,60);
  assert.deepEqual(pose,{yaw:20,pitch:10,roll:0});assert.equal(forwarded,0);
  pointer('pointermove',220,80,{shiftKey:true});assert.deepEqual(pose,{yaw:20,pitch:10,roll:10});
  pointer('pointerleave',300,200);pointer('pointerenter',20,20);pointer('pointermove',20,20);
  assert.deepEqual(pose,{yaw:20,pitch:10,roll:10});
  pointer('pointerdown',20,20,{buttons:1});pointer('pointerup',20,20);assert.equal(taps,1);
  pointer('pointerdown',20,20,{buttons:1});pointer('pointermove',40,20,{buttons:1});pointer('pointerup',40,20);assert.equal(taps,1);
  enabled=false;const before={...pose};pointer('pointermove',100,100);assert.deepEqual(pose,before);assert.equal(forwarded,1);assert.ok(interactions>0);
});

test('delayed UI snapshots cannot drop displacement during one continuous mouse movement', t => {
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  const canvas=new EventTarget();canvas.focus=()=>{};const emitted=[];
  const input=bindMousePose(canvas,{getPose:()=>NEUTRAL_POSE,getOptions:()=>({enabled:true,sensitivity:.25}),ready:()=>true,onPose:p=>emitted.push(p),onDrag:()=>{},onTap:()=>{},onInteract:()=>{}});
  t.after(()=>{input.destroy();globalThis.window=oldWindow;globalThis.document=oldDocument;});
  for(const [type,clientX] of [['pointerenter',100],['pointermove',110],['pointermove',120],['pointermove',140]]) {
    const e=new Event(type,{cancelable:true});Object.assign(e,{clientX,clientY:100,pointerId:1,pointerType:'mouse',buttons:0});canvas.dispatchEvent(e);
  }
  assert.equal(emitted.at(-1).yaw,10);
});
