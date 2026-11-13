import {headQuaternion,rotateHeadVector} from '../shared/pose.mjs';

// Native wearer coordinates, shared with the sensor: +X right, +Y up,
// -Z forward. Look horizontally from directly behind, at eye height.
// Do not add a presentation tilt: it makes the transparent glasses appear
// to be viewed from underneath even when the sensor pose is neutral.
const eyeHeight=.35;
const camera=[0,eyeHeight,5];
export const HEAD_VOLUMES=[
  {center:[0,.55,.12],radius:[.78,1.05,.68],head:true},
  {center:[-.78,.20,0],radius:[.12,.28,.16]},
  {center:[.78,.20,0],radius:[.12,.28,.16]},
  {center:[0,-1.08,.07],radius:[.36,.53,.34]},
  {center:[0,-1.57,.08],radius:[1.3,.27,.62]},
];

export function rearSkullPoint(x,y){
  const {center,radius}=HEAD_VOLUMES[0];
  const depth=Math.sqrt(Math.max(0,1-((x-center[0])/radius[0])**2-((y-center[1])/radius[1])**2));
  return [x,y,center[2]+radius[2]*depth+.015];
}

export function headScene(pose){
  const quaternion=headQuaternion(pose),inverse=quaternion.map((v,i)=>i<3?-v:v);
  const eye=rotateHeadVector(camera,inverse);
  return {
    fromRear:eye[2]>0,
    transform(point){const [x,y,z]=rotateHeadVector(point,quaternion);return [x,y-eyeHeight,z];},
    direction(vector){return rotateHeadVector(vector,quaternion);},
    // Classify far-side frames independently of the shell's transparency, so
    // the renderer can show them with a lighter stroke and retain rear depth.
    occluded(point){
      return HEAD_VOLUMES.some(({center,radius})=>{
        const origin=eye.map((v,i)=>(v-center[i])/radius[i]),direction=point.map((v,i)=>(v-eye[i])/radius[i]);
        const a=direction.reduce((s,v)=>s+v*v,0),b=2*origin.reduce((s,v,i)=>s+v*direction[i],0),c=origin.reduce((s,v)=>s+v*v,0)-1;
        const discriminant=b*b-4*a*c;if(discriminant<0||!a)return false;
        const near=(-b-Math.sqrt(discriminant))/(2*a);
        return near>0&&near<.985;
      });
    },
  };
}
