import { t } from './i18n.jsx';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bindMousePose } from '../preview/mouse-pose.mjs';
import { getAppearance, subscribeAppearance } from './theme.mjs';
import {headScene,HEAD_VOLUMES,rearSkullPoint} from './head-scene.mjs';

const mesh = [];
function ellipsoid(cx,cy,cz,rx,ry,rz,head=false) {
  const rings=24, slices=36;
  function point(i,j) {
    const t=i/rings*Math.PI,p=j/slices*Math.PI*2,h=Math.cos(t);
    const jaw=head&&h<-.55?1+(h+.55)*.15:1;
    return [cx+Math.sin(t)*Math.cos(p)*rx*jaw,cy+h*ry,cz+Math.sin(t)*Math.sin(p)*rz];
  }
  for(let i=0;i<rings;i++)for(let j=0;j<slices;j++)mesh.push([point(i,j),point(i+1,j),point(i+1,j+1),point(i,j+1)]);
}
const surfaces=HEAD_VOLUMES.slice(0,3).map(({center,radius,head})=>{const start=mesh.length;ellipsoid(...center,...radius,head);return mesh.slice(start);});
const silhouettes=surfaces.map(faces=>faces.flat());

function hull(points){
  const sorted=points.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const side=values=>{const result=[];for(const p of values){while(result.length>1&&cross(result.at(-2),result.at(-1),p)<=0)result.pop();result.push(p);}return result;};
  return [...side(sorted).slice(0,-1),...side(sorted.slice().reverse()).slice(0,-1)];
}

function draw(canvas,pose) {
  const width=canvas.clientWidth,height=canvas.clientHeight;
  if(!width||!height)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const palette=getComputedStyle(canvas),color=name=>palette.getPropertyValue('--'+name).trim();
  const scene=headScene(pose),rotate=point=>scene.transform(point);
  const scale=height*.24,cx=width*.5,cy=height*.46;
  const project=([x,y,z])=>{const depth=5/(5-z);return[cx+x*scale*depth,cy-y*scale*depth];};
  const background=ctx.createRadialGradient(cx,cy,5,cx,cy,height*.7);background.addColorStop(0,color('model-center'));background.addColorStop(1,color('model-edge'));ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
  const meshColor=color('model-mesh').split(',').map(Number),meshAlpha=Number(color('model-mesh-alpha'));
  // Open neck/shoulder lines, rather than closed ellipses whose visible
  // undersides made the old transparent bust look like a bottom view.
  ctx.strokeStyle=color('model-wire');ctx.lineWidth=.8;
  for(const sign of [-1,1]){
    const shoulder=[[sign*.26,-.38,.30],[sign*.27,-1.08,.25],[sign*.95,-1.38,.10]];
    ctx.beginPath();shoulder.map(v=>project(rotate(v))).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();
  }
  // A crisp translucent shell: visible surface lighting gives the back of
  // the skull depth without an opaque mask or a blur over the glasses.
  for(let surface=0;surface<silhouettes.length;surface++){
    const silhouette=silhouettes[surface];
    const points=hull(silhouette.map(v=>project(rotate(v))));ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();
    ctx.fillStyle=`rgba(${meshColor.join(',')},${meshAlpha})`;ctx.fill();ctx.strokeStyle=color('model-wire');ctx.lineWidth=.8;ctx.stroke();
    for(const face of surfaces[surface]){
      const center=face[0].map((_,i)=>face.reduce((s,p)=>s+p[i],0)/face.length);
      const volume=HEAD_VOLUMES[surface],normal=center.map((v,i)=>(v-volume.center[i])/volume.radius[i]**2);
      const [nx,ny,nz]=scene.direction(normal),length=Math.hypot(nx,ny,nz);
      if(nz<=0||!length)continue;
      const light=Math.max(0,(nz*.65+ny*.5-nx*.35)/length);
      ctx.fillStyle=`rgba(${meshColor.join(',')},${meshAlpha*(.3+light*1.4)})`;
      ctx.beginPath();face.map(v=>project(rotate(v))).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();
    }
  }
  function line(points,color,width,closed=false,throughAlpha=.65,remote=false) {
    const vertices=closed?[...points,points[0]]:points;
    for(const behindHead of [true,false]){
    if(remote&&!behindHead)continue;
    if(behindHead&&!throughAlpha)continue;
    ctx.beginPath();let connected=false;
    for(let i=1;i<vertices.length;i++){
      const from=vertices[i-1],to=vertices[i],steps=Math.max(1,Math.ceil(Math.hypot(...to.map((v,j)=>v-from[j]))/.025));
      const at=t=>from.map((v,j)=>v+(to[j]-v)*t);
      for(let step=0;step<steps;step++){
        if((remote||scene.occluded(at((step+.5)/steps)))!==behindHead){connected=false;continue;}
        if(!connected)ctx.moveTo(...project(rotate(at(step/steps))));
        ctx.lineTo(...project(rotate(at((step+1)/steps))));connected=true;
      }
    }
    // Far-side frames remain visible through the transparent head. Their
    // lighter, thinner stroke preserves the rear-view depth cue.
    ctx.save();ctx.globalAlpha=remote ? .22 : behindHead ? throughAlpha : 1;ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=color;ctx.lineWidth=remote?width*.4:behindHead?width*.65:width;if(remote)ctx.setLineDash([2,2]);ctx.stroke();ctx.restore();
    }
  }
  // A rounded occiput and nape line distinguish the back of the skull from a
  // face/chin oval. This posterior contour disappears when it turns away.
  const nape=[[-.67,.27],[-.61,.04],[-.48,-.15],[-.31,-.27],[-.22,-.35],[.22,-.35],[.31,-.27],[.48,-.15],[.61,.04],[.67,.27]].map(([x,y])=>rearSkullPoint(x,y));
  line(nape,color('model-wire'),1.2,false,0);
  line([[0,-.44,.4],[0,-.75,.33],[0,-1.04,.29]],color('model-wire'),.8,false,0);
  // A faint crown whorl and posterior hair flow make this recognizably the
  // back of a head even though the far lenses are visible through the shell.
  const whorl=Array.from({length:36},(_,i)=>{const angle=i/35*Math.PI*2.7,radius=.018+i/35*.115;return rearSkullPoint(-.16+Math.cos(angle)*radius,1.08+Math.sin(angle)*radius*1.1);});
  line(whorl,color('model-wire'),1.2,false,0);
  // Lenses face away; rear ear hooks are nearer and draw more strongly.
  for(const sign of [-1,1]){
    const lens=[[.10,.49,-.69],[.67,.49,-.53],[.71,.40,-.54],[.64,.18,-.59],[.20,.17,-.72],[.10,.28,-.74]].map(([x,y,z])=>[x*sign,y,z]);
    // In a rear view, a pair of complete see-through lens loops reads as
    // eyes on a face. Show the exposed rim and a faint far upper edge;
    // keep the near temples and ear hooks as the dominant physical frame.
    line(lens,color('model-frame'),3,true,scene.fromRear?0:.65);
    if(scene.fromRear)line(lens.slice(0,3),color('model-frame'),2,false,.65,true);
    const temple=[[sign*.68,.46,-.55],[sign*.86,.39,-.12],[sign*.90,.30,.18],[sign*.89,.12,.38],[sign*.84,.08,.46]];
    line(temple,color('model-frame'),4.2);
    line(temple.slice(0,3).map(([x,y,z])=>[x,y+.035,z]),color('model-highlight'),1.1);
    line([[sign*.82,.085,.46],[sign*.86,.075,.46]],color('model-frame'),3.8);
    if(!scene.fromRear)line([[sign*.24,.38,-.73],[sign*.51,.39,-.65]],color('model-highlight'),1.2);
  }
  line([[-.11,.39,-.72],[0,.43,-.78],[.11,.39,-.72]],color('model-frame'),2.6,false,.65,scene.fromRear);
  const forward=project(rotate([0,.33,-2.1])),base=project(rotate([0,.33,-1.1]));
  if(Math.hypot(forward[0]-base[0],forward[1]-base[1])>8){
  ctx.setLineDash([3,3]);ctx.strokeStyle=color('model-direction');ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(...base);ctx.lineTo(...forward);ctx.stroke();ctx.setLineDash([]);
  const angle=Math.atan2(forward[1]-base[1],forward[0]-base[0]);
  ctx.fillStyle=color('model-point');ctx.beginPath();ctx.moveTo(...forward);ctx.lineTo(forward[0]-7*Math.cos(angle-.45),forward[1]-7*Math.sin(angle-.45));ctx.lineTo(forward[0]-7*Math.cos(angle+.45),forward[1]-7*Math.sin(angle+.45));ctx.closePath();ctx.fill();
  }
  // A fixed corner compass makes all three axes visible at once.
  const origin=[width-30,height-25];
  for(const [vector,axisColor,label] of [[[.48,0,0],color('axis-x'),'X'],[[0,.48,0],color('axis-y'),'Y'],[[0,0,.48],color('axis-z'),'Z']]){
    const [x,y,z]=scene.direction(vector),tip=[origin[0]+x*34+z*12,origin[1]-y*34+z*6];
    ctx.strokeStyle=axisColor;ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(...origin);ctx.lineTo(...tip);ctx.stroke();ctx.font='8px -apple-system';ctx.fillStyle=axisColor;ctx.fillText(label,tip[0]+2,tip[1]-2);
  }
}

export function HeadModel({pose,sensitivity,ready,onPose,onInteract,motion}) {
  const { resolved:theme }=useSyncExternalStore(subscribeAppearance,getAppearance);
  const canvas=useRef(null),latest=useRef(null),[dragging,setDragging]=useState(false);
  latest.current={pose,sensitivity,ready,onPose,onInteract};
  useEffect(()=>{
    const node=canvas.current;
    const input=bindMousePose(node,{getPose:()=>latest.current.pose,getOptions:()=>({enabled:true,sensitivity:latest.current.sensitivity}),ready:()=>latest.current.ready,onPose:value=>{latest.current.pose=value;latest.current.onPose(value);},onDrag:setDragging,onTap:()=>{},onInteract:()=>latest.current.onInteract()});
    const resize=new ResizeObserver(()=>draw(node,latest.current.pose));resize.observe(node);
    return()=>{input.destroy();resize.disconnect();};
  },[]);
  useEffect(()=>{draw(canvas.current,pose);},[pose.yaw,pose.pitch,pose.roll,theme]);
  return <div className="head-model"><div className="head-model-label"><span>{t("背面视角 · 面向模拟屏幕")}</span><span>{motion?t("自动演示中"):dragging?t("跟随鼠标"):'3 DoF'}</span></div><canvas ref={canvas} className="mouse-look" tabIndex={0} aria-label={t("鼠标跟随的三维头部模型")}/><div className="head-model-hint">{t("向右转头 · 向上抬头 · Shift 向右侧倾")}</div></div>;
}
