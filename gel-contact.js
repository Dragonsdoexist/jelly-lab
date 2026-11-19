// Sustained contact samples use the solver's normal impulse divided by its
// timestep. The two material frames receive the same load, in opposite directions.
import * as T from './vendor/three.module.min.js';
import R from './vendor/rapier.mjs';
import {bindPoints} from './soft-body.js';

const point=new T.Vector3(),normal=new T.Vector3(),inverse=new T.Quaternion();
function collectPatch(pair,p,n,impulse){
  const sign=pair.sign, nx=n.x*sign,ny=n.y*sign,nz=n.z*sign;
  const nearby=pair.patches.find(c=>Math.hypot(c.x-p.x,c.y-p.y,c.z-p.z)<.3&&c.nx*nx+c.ny*ny+c.nz*nz>.78);
  if(nearby){
    const f=impulse/(impulse+nearby.impulse);nearby.impulse+=impulse;
    nearby.x+=(p.x-nearby.x)*f;nearby.y+=(p.y-nearby.y)*f;nearby.z+=(p.z-nearby.z)*f;
    nearby.nx+=(nx-nearby.nx)*f;nearby.ny+=(ny-nearby.ny)*f;nearby.nz+=(nz-nearby.nz)*f;
  }else pair.patches.push({x:p.x,y:p.y,z:p.z,nx,ny,nz,impulse});
  pair.impulse+=impulse;
}
function normalSpeed(body,p){
  const motion=body.approach;if(!motion)return 0;
  const {linear:v,angular:w,center:c}=motion,x=p.x-c.x,y=p.y-c.y,z=p.z-c.z;
  return (v.x+w.y*z-w.z*y)*p.nx+(v.y+w.z*x-w.x*z)*p.ny+(v.z+w.x*y-w.y*x)*p.nz;
}
export class GelContacts{
  constructor(){this.pairs=new Map();this.invalidated=new Set();this.tick=0}
  remove(b){
    this.invalidated.delete(b);
    for(const [key,p] of this.pairs)if(p.a===b||p.b===b){this.invalidated.add(p.a===b?p.b:p.a);this.pairs.delete(key)}
  }
  update(world,events,lookup,dt,onImpact){
    const current=new Map();
    events.drainContactForceEvents(e=>{
      const ca=world.getCollider(e.collider1()),cb=world.getCollider(e.collider2());
      const a=lookup.get(ca?.parent()?.handle),b=lookup.get(cb?.parent()?.handle);
      if(!a?.soft||!b?.soft)return;
      const first=a.contactId<b.contactId,key=first?a.contactId+'/'+b.contactId:b.contactId+'/'+a.contactId;
      let pair=current.get(key);
      if(!pair){pair={a:first?a:b,b:first?b:a,patches:[],impulse:0};current.set(key,pair)}
      world.contactPair(ca,cb,(m,flipped)=>{
        const n=m.normal(),one=flipped?cb:ca;
        pair.sign=(flipped?1:-1)*(first?1:-1);
        const rotation=one.rotation(),translation=one.translation();
        for(let i=0;i<m.numContacts();i++){
          const j=m.contactImpulse(i);if(j<.000001)continue;
          const local=m.localContactPoint1(i);if(!local)continue;
          point.copy(local).applyQuaternion(rotation).add(translation);
          collectPatch(pair,point,n,j);
        }
      });
    });

    for(const [key,old] of this.pairs){
      // Sleeping islands produce no new force events. Their last solved support
      // forces still hold weight until a body wakes, moves or leaves the studio.
      if(!current.get(key)?.impulse&&old.a.rigid.isSleeping()&&old.b.rigid.isSleeping())current.set(key,old);
    }
    const changed=this.invalidated;
    for(const [key,pair] of current)if(this.pairs.get(key)!==pair){changed.add(pair.a);changed.add(pair.b)}
    for(const [key,old] of this.pairs)if(!current.has(key)){changed.add(old.a);changed.add(old.b)}
    for(const b of changed)b.soft.beginPressure();
    for(const [key,pair] of current){
      if(!pair.impulse){current.delete(key);continue}
      const previous=this.pairs.get(key)?.impulse||0;
      const rise=Math.max(0,pair.impulse-previous*1.4);
      for(const [body,sign] of [[pair.a,1],[pair.b,-1]]){
        if(!changed.has(body))continue;
        inverse.copy(body.rigid.rotation()).invert();
        const velocity=rise/body.rigid.mass();
        for(const p of pair.patches){
          normal.set(sign*p.nx,sign*p.ny,sign*p.nz).normalize();
          point.set(p.x,p.y,p.z);
          const closing=normalSpeed(pair.b,p)-normalSpeed(pair.a,p);
          if(closing>.45&&rise>.0001&&p.impulse>pair.impulse*.07)
            onImpact(body,normal,point,Math.min(closing*1.5,velocity)*Math.sqrt(p.impulse/pair.impulse));
          normal.applyQuaternion(inverse);point.sub(body.rigid.translation()).applyQuaternion(inverse).divideScalar(body.size);
          body.soft.press(point,normal,p.impulse/(dt*body.size**2));
        }
      }
    }
    this.pairs=current;changed.clear();this.tick++;
    for(const b of lookup.values()){
      if(!b.soft)continue;
      b.soft.finishPressure(dt);
      if(this.tick%5!==0)continue;
      if(b.soft.grip){
        const at=b.rigid.translation();
        for(const other of lookup.values()){
          if(other===b)continue;
          const p=other.rigid.translation(),reach=(b.size+other.size)*1.25+.35;
          if((at.x-p.x)**2+(at.y-p.y)**2+(at.z-p.z)**2<reach*reach){b.followUntil=this.tick+50;break}
        }
      }
      // A stretched corner can reach another body before its rigid rest contour.
      // Follow the live skin through the grab and the first part of its recoil.
      const follow=this.tick<(b.followUntil||0);
      if(follow||b.soft.loaded||b.compressedHull)fitCollisionSurface(b,follow);
    }
  }
}

// Refit only hulls whose pressure indentation has materially changed. The
// supported logo can then settle into the dent instead of hovering above it.
function fitCollisionSurface(b,follow){
  if(!b.pressureHulls){
    b.pressureHulls=Array.from({length:b.rigid.numColliders()},(_,i)=>{
      const collider=b.rigid.collider(i),rest=collider.vertices().slice();
      const unit=Float32Array.from(rest,x=>x/b.size);
      return {collider,rest,skin:bindPoints(unit,b.soft.cage),live:rest.slice(),next:rest.slice()};
    });
  }
  let changed=false,pending=false;
  for(const h of b.pressureHulls){
    const {rest,skin,live,next}=h,u=follow?b.soft.u:b.soft.pressure;let error=0;
    for(let j=0,base=0;j<rest.length;j+=3,base+=skin.k){
      let x=0,y=0,z=0;
      for(let k=base;k<base+skin.k;k++){const i=skin.index[k]*3,w=skin.weight[k];x+=w*u[i];y+=w*u[i+1];z+=w*u[i+2]}
      next[j]=rest[j]+b.size*x;next[j+1]=rest[j+1]+b.size*y;next[j+2]=rest[j+2]+b.size*z;
      error=Math.max(error,Math.abs(next[j]-live[j]),Math.abs(next[j+1]-live[j+1]),Math.abs(next[j+2]-live[j+2]));
    }
    if(error<((follow||b.soft.loaded)?.009:.00005)*b.size)continue;
    const maxStep=(follow?.14:b.hullFollowsGrip?.09:.015)*b.size;
    if(error>maxStep){
      pending=true;const t=maxStep/error;for(let j=0;j<next.length;j++)next[j]=live[j]+t*(next[j]-live[j]);
    }
    h.collider.setShape(new R.ConvexPolyhedron(next));live.set(next);changed=true;
  }
  if(changed)b.rigid.wakeUp();
  b.hullFollowsGrip=follow;
  b.compressedHull=follow||pending||b.soft.loaded;
}
