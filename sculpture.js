import * as T from './vendor/three.module.min.js';
import {bindPoints} from './soft-body.js';

export const companies = [
  ['openai','OpenAI','mint'],['anthropic','Anthropic','peach'],['deepmind','Google DeepMind','violet'],['perplexity','Perplexity','aqua'],['mistral','Mistral AI','honey'],['meta','Meta','blue'],
  ['deepseek','DeepSeek','blue'],['xai','xAI','pink'],['nvidia','NVIDIA','lime'],['microsoft','Microsoft','violet'],['amazon','Amazon','honey'],['apple','Apple','mint'],
  ['cohere','Cohere','mint'],['huggingface','Hugging Face','honey'],['stability','Stability AI','violet'],['midjourney','Midjourney','blue'],['runway','Runway','lime'],['elevenlabs','ElevenLabs','pink'],
  ['alibaba','Alibaba','peach'],['baidu','Baidu','blue'],['bytedance','ByteDance','mint'],['tencent','Tencent','aqua'],['zai','Z.ai','violet'],['moonshot','Moonshot AI','pink']
];
export const palette = {mint:'#13aa86',peach:'#ed7749',violet:'#9a65dc',aqua:'#19a2b4',honey:'#e8a111',blue:'#4a82e5',pink:'#da4e94',lime:'#8bb83d'};
const cache=new Map();
async function readModel(slug) {
  const response=await fetch('models/'+slug+'.gel');
  if(!response.ok)throw new Error('Model request failed for '+slug);
  const data=await response.arrayBuffer(),head=new DataView(data);
  if(head.getUint32(0,false)!==0x47454c31)throw new Error('Invalid sculpture '+slug);
  const vertices=head.getUint32(4,true),count=head.getUint32(8,true),indexOffset=(16+9*vertices+1)&~1;
  if(data.byteLength!==indexOffset+2*count)throw new Error('Incomplete sculpture '+slug);
  const pos=Float32Array.from(new Int16Array(data,16,vertices*3),v=>v/32767);
  const normal=Float32Array.from(new Int8Array(data,16+6*vertices,vertices*3),v=>v/127);
  const index=new Uint16Array(data,indexOffset,count);
  // Sample the silhouette for screen labels and safe starting heights.
  const support=[],supportIndices=[],golden=Math.PI*(3-Math.sqrt(5));
  for(let i=0;i<100;i++){
    const y=1-2*i/99,r=Math.sqrt(1-y*y),x=r*Math.cos(i*golden),z=r*Math.sin(i*golden);
    let best=-Infinity,winner=0;
    for(let j=0;j<pos.length;j+=3){const d=pos[j]*x+pos[j+1]*y+pos[j+2]*z;if(d>best){best=d;winner=j}}
    supportIndices.push(winner);support.push(new T.Vector3(pos[winner],pos[winner+1],pos[winner+2]));
  }
  return {pos,normal,index,support,supportIndices};
}
export function getModel(slug){
  if(!cache.has(slug))cache.set(slug,readModel(slug).catch(e=>{cache.delete(slug);throw e}));
  return cache.get(slug);
}
export function sculptGeometry(data){
  const g=new T.BufferGeometry();
  g.setIndex(new T.BufferAttribute(data.index,1));
  g.setAttribute('position',new T.BufferAttribute(data.pos.slice(),3).setUsage(T.DynamicDrawUsage));
  g.setAttribute('normal',new T.BufferAttribute(data.normal.slice(),3).setUsage(T.DynamicDrawUsage));
  g.computeBoundingBox();g.computeBoundingSphere();return g;
}
const skinCache=new WeakMap();
export function bindSkin(part,cage){
  if(!skinCache.has(part.data)){
    const skin=bindPoints(part.data.pos,cage),g=part.mesh.geometry;
    g.computeVertexNormals();skin.restNormals=g.attributes.normal.array.slice();
    g.attributes.normal.array.set(part.data.normal);skinCache.set(part.data,skin);
  }
  part.skin=skinCache.get(part.data);
}

// Interpolate the material coordinates and particle weights of the picked
// triangle. This keeps a second grab attached even while the skin is moving.
export function pickMaterial(part,hit,local,cage){
  if(!hit)return {rest:local,binding:bindPoints(local.toArray(),cage)};
  const {a,b,c}=hit.face,vs=[a,b,c],pos=part.mesh.geometry.attributes.position;
  const triangle=vs.map(i=>new T.Vector3().fromBufferAttribute(pos,i));
  const bary=T.Triangle.getBarycoord(local,...triangle,new T.Vector3())?.toArray()??[1,0,0];
  const rest=new T.Vector3(),v=new T.Vector3(),combined=new Map(),skin=part.skin;
  for(let t=0;t<3;t++){
    rest.addScaledVector(v.fromArray(part.data.pos,vs[t]*3),bary[t]);
    for(let k=0;k<skin.k;k++){
      const j=vs[t]*skin.k+k,id=skin.index[j];combined.set(id,(combined.get(id)||0)+skin.weight[j]*bary[t]);
    }
  }
  return {rest,binding:{index:[...combined.keys()],weight:[...combined.values()]}};
}
export function deform(b){
  const {u}=b.soft,up=b.localUp,height=b.mesh.position.y/b.size;
  for(const {data,mesh,skin} of b.parts){
    const g=mesh.geometry,position=g.attributes.position,out=position.array,p=data.pos;
    if(!b.soft.active&&!b.soft.loaded){
      out.set(p);g.attributes.normal.array.set(data.normal);g.attributes.normal.needsUpdate=true;
    }else{
      for(let j=0,base=0;j<p.length;j+=3,base+=skin.k){
        let x=p[j],y=p[j+1],z=p[j+2];
        for(let k=base;k<base+skin.k;k++){
          const i=skin.index[k]*3,w=skin.weight[k];x+=w*u[i];y+=w*u[i+1];z+=w*u[i+2];
        }
        const heightNow=up.x*x+up.y*y+up.z*z+height;
        if(heightNow<0){x-=up.x*heightNow;y-=up.y*heightNow;z-=up.z*heightNow}
        out[j]=x;out[j+1]=y;out[j+2]=z;
      }
      g.computeVertexNormals();
      // Transport the sculpted optical normals through the rotation of each
      // surface patch, preserving the smooth highlights as gel wakes and sleeps.
      const now=g.attributes.normal.array,base=skin.restNormals,n=data.normal;
      for(let j=0;j<now.length;j+=3){
        const x=now[j],y=now[j+1],z=now[j+2],a=base[j],b=base[j+1],c=base[j+2];
        const denom=1+a*x+b*y+c*z;if(denom<.01)continue;
        const vx=b*z-c*y,vy=c*x-a*z,vz=a*y-b*x;
        const tx=vy*n[j+2]-vz*n[j+1],ty=vz*n[j]-vx*n[j+2],tz=vx*n[j+1]-vy*n[j];
        now[j]=n[j]+tx+(vy*tz-vz*ty)/denom;
        now[j+1]=n[j+1]+ty+(vz*tx-vx*tz)/denom;
        now[j+2]=n[j+2]+tz+(vx*ty-vy*tx)/denom;
      }
    }
    position.needsUpdate=true;g.computeBoundingSphere();g.computeBoundingBox();
  }
  b.soft.dirty=false;
}
