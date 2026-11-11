import { t, getLocale } from './i18n.jsx';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bindMousePose } from '../preview/mouse-pose.mjs';
import { getAppearance, subscribeAppearance } from './theme.mjs';

const RAD = Math.PI / 180;
const mesh = [];
function ellipsoid(cx,cy,cz,rx,ry,rz,head=false) {
  const rings=20, slices=28;
  function point(i,j) {
    const t=i/rings*Math.PI,p=j/slices*Math.PI*2,h=Math.cos(t);
    const jaw=head&&h<-.25?1+(h+.25)*.27:1;
    return [cx+Math.sin(t)*Math.cos(p)*rx*jaw,cy+h*ry,cz+Math.sin(t)*Math.sin(p)*rz];
  }
  for(let i=0;i<rings;i++)for(let j=0;j<slices;j++)mesh.push([point(i,j),point(i+1,j),point(i+1,j+1),point(i,j+1)]);
}
ellipsoid(0,.35,0,.77,1.24,.66,true);
ellipsoid(-.78,.20,0,.12,.28,.16);ellipsoid(.78,.20,0,.12,.28,.16);
ellipsoid(0,-1.08,-.07,.36,.53,.34);ellipsoid(0,-1.57,-.08,1.3,.27,.62);
const nose=[[-.13,.37,.61],[.13,.37,.61],[.11,.03,.63],[-.11,.03,.63],[0,.1,.94]];
mesh.push([nose[0],nose[1],nose[4]],[nose[1],nose[2],nose[4]],[nose[2],nose[3],nose[4]],[nose[3],nose[0],nose[4]]);

function rotate([x,y,z],pose) {
  const r=-pose.roll*RAD,p=-pose.pitch*RAD,a=pose.yaw*RAD;
  const xr=x*Math.cos(r)-y*Math.sin(r),yr=x*Math.sin(r)+y*Math.cos(r);
  const yp=yr*Math.cos(p)-z*Math.sin(p),zp=yr*Math.sin(p)+z*Math.cos(p);
  return [xr*Math.cos(a)+zp*Math.sin(a),yp,-xr*Math.sin(a)+zp*Math.cos(a)];
}

function draw(canvas,pose) {
  const width=canvas.clientWidth,height=canvas.clientHeight;
  if(!width||!height)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const palette=getComputedStyle(canvas),color=name=>palette.getPropertyValue('--'+name).trim();
  const scale=height*.257,cx=width*.5,cy=height*.48;
  const project=([x,y,z])=>{const depth=5/(5-z);return[cx+x*scale*depth,cy-y*scale*depth];};
  const background=ctx.createRadialGradient(cx,cy,5,cx,cy,height*.7);background.addColorStop(0,color('model-center'));background.addColorStop(1,color('model-edge'));ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
  ctx.strokeStyle=color('model-grid');ctx.lineWidth=.7;
  const meshColor=color('model-mesh').split(',').map(Number),meshAlpha=Number(color('model-mesh-alpha'));
  for(let i=-2;i<=2;i++){ctx.beginPath();ctx.ellipse(cx,cy+height*.39,scale*(1.55+i*.06),scale*(.32+i*.06),0,0,Math.PI*2);ctx.stroke();}
  const transformed=mesh.map(face=>face.map(v=>rotate(v,pose))).sort((a,b)=>a.reduce((s,p)=>s+p[2],0)/a.length-b.reduce((s,p)=>s+p[2],0)/b.length);
  for(const face of transformed){
    const a=face[0],b=face[1],c=face[2],u=b.map((v,i)=>v-a[i]),v=c.map((n,i)=>n-a[i]);
    const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...normal)||1,light=Math.abs((normal[0]*-.4+normal[1]*.7+normal[2]*.6)/length);
    const points=face.map(project);ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();
    ctx.fillStyle=`rgba(${meshColor.map((value,i)=>Math.min(255,value+Math.round(light*[40,35,38][i]))).join(',')},${meshAlpha})`;ctx.fill();
    ctx.strokeStyle=color('model-wire');ctx.lineWidth=.3;ctx.stroke();
  }
  function line(points,color,width,fill) {
    ctx.beginPath();points.map(v=>project(rotate(v,pose))).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
    if(fill){ctx.closePath();ctx.fillStyle=fill;ctx.fill();}ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
  }
  // Curved frames, translucent lenses and temples remain readable through the head.
  for(const sign of [-1,1]){
    const lens=[[.10,.49,.69],[.67,.49,.53],[.71,.40,.54],[.64,.18,.59],[.20,.17,.72],[.10,.28,.74]].map(([x,y,z])=>[x*sign,y,z]);
    line(lens,color('model-frame'),2.6,color('model-lens'));
    line([[sign*.68,.46,.55],[sign*.84,.39,.12],[sign*.82,.22,-.32]],color('model-frame'),3.4);
    line([[sign*.24,.38,.73],[sign*.51,.39,.65]],color('model-highlight'),1.2);
  }
  line([[-.11,.39,.72],[0,.43,.78],[.11,.39,.72]],color('model-frame'),2.6);
  line([[-.17,-.19,.59],[0,-.22,.64],[.17,-.19,.59]],color('model-mouth'),1);
  const forward=project(rotate([0,.33,1.65],pose)),base=project(rotate([0,.33,.86],pose));
  ctx.setLineDash([3,3]);ctx.strokeStyle=color('model-direction');ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(...base);ctx.lineTo(...forward);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle=color('model-point');ctx.beginPath();ctx.arc(...forward,2.5,0,Math.PI*2);ctx.fill();
  // A fixed corner compass makes all three axes visible at once.
  const origin=[width-30,height-25];
  for(const [vector,axisColor,label] of [[[.48,0,0],color('axis-x'),'X'],[[0,.48,0],color('axis-y'),'Y'],[[0,0,.48],color('axis-z'),'Z']]){
    const [x,y,z]=rotate(vector,pose),tip=[origin[0]+x*34+z*12,origin[1]-y*34+z*6];
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
  return <div className="head-model"><div className="head-model-label"><span>{t("头部姿态")}</span><span>{motion?t("自动演示中"):dragging?t("跟随鼠标"):'3 DoF'}</span></div><canvas ref={canvas} className="mouse-look" tabIndex={0} aria-label={t("鼠标跟随的三维头部模型")}/><div className="head-model-hint">{t("移动转头 · Shift 移动侧倾")}</div></div>;
}
