// Elastic displacements live in each sculpture's rotating material frame. Rapier
// supplies the frame's motion and the contact impulses shared with other bodies.
const limit=(n,a,b)=>Math.max(a,Math.min(b,n));
export const INFLUENCES=7;

// Smooth, compact skin weights shared by surface vertices, grip constraints and optics.
export function bindPoints(points,cage){
  const p=cage.positions,count=p.length/3,k=Math.min(INFLUENCES,count-1);
  const index=new Uint16Array(points.length/3*k),weight=new Float32Array(index.length);
  const nearest=new Uint16Array(k+1),dist=new Float64Array(k+1);
  for(let v=0;v<points.length;v+=3){
    dist.fill(Infinity);
    for(let j=0;j<p.length;j+=3){
      const dx=p[j]-points[v],dy=p[j+1]-points[v+1],dz=p[j+2]-points[v+2],d=dx*dx+dy*dy+dz*dz;
      if(d>=dist[k])continue;
      let t=k;while(t>0&&d<dist[t-1]){dist[t]=dist[t-1];nearest[t]=nearest[t-1];t--}
      dist[t]=d;nearest[t]=j/3;
    }
    const offset=v/3*k,support=Math.max(1e-8,dist[k]);let sum=0;
    for(let t=0;t<k;t++){
      const w=(1-dist[t]/support)**2/(dist[t]+cage.spacing*cage.spacing*.24);
      index[offset+t]=nearest[t];sum+=weight[offset+t]=w;
    }
    if(sum<1e-10){weight[offset]=1;sum=1}
    for(let t=0;t<k;t++)weight[offset+t]/=sum;
  }
  return {index,weight,k};
}

export class SoftBody{
  constructor(cage,softness){
    this.cage=cage;this.rest=new Float32Array(cage.positions);this.n=this.rest.length/3;
    this.u=new Float32Array(this.rest.length);this.v=new Float32Array(this.u.length);this.force=new Float32Array(this.u.length);
    this.pressure=new Float32Array(this.u.length);this.traction=new Float32Array(this.u.length);
    this.strain=new Float32Array(this.u.length);this.hasLoad=false;this.loaded=false;
    this.patches=[];this.quiet=0;this.active=false;this.dirty=false;
    const degree=new Float32Array(this.n);this.mass=Float32Array.from(cage.weights,w=>Math.max(.26,w*this.n));
    for(let j=0;j<cage.edges.length;j+=3){const [a,b,w]=cage.edges.slice(j,j+3);degree[a]+=w;degree[b]+=w}
    this.ends=new Uint16Array(cage.edges.length/3*2);this.links=new Float32Array(cage.edges.length/3*4);
    for(let j=0,e=0;j<cage.edges.length;j+=3,e++){
      const a=cage.edges[j],b=cage.edges[j+1],i=a*3,l=b*3;
      const x=this.rest[i]-this.rest[l],y=this.rest[i+1]-this.rest[l+1],z=this.rest[i+2]-this.rest[l+2],d=Math.hypot(x,y,z);
      this.ends.set([a,b],e*2);this.links.set([x/d,y/d,z/d,cage.edges[j+2]*2/(degree[a]/this.mass[a]+degree[b]/this.mass[b])],e*4);
    }
    this.setSoftness(softness);
  }
  setSoftness(s){
    this.pressureSettled=false;this.softness=limit(s,0,1);this.shapeK=190*Math.pow(.055,this.softness);
    this.coupling=2.8*((5.8-3.15*this.softness)/this.cage.spacing)**2;
    this.damping=4.8-1.4*this.softness;
  }
  beginPressure(){this.pressureSettled=false;if(this.hasLoad)this.traction.fill(0);this.hasLoad=false}
  press(p,n,force){
    // Spread each measured force across a finite contact patch. Opposite faces
    // receive less strain and material at the perimeter expands laterally.
    this.hasLoad=true;
    const {rest,traction}=this;let depthMax=.12;
    for(let i=0;i<rest.length;i+=3)depthMax=Math.max(depthMax,(rest[i]-p.x)*n.x+(rest[i+1]-p.y)*n.y+(rest[i+2]-p.z)*n.z);
    const radius=.5+this.cage.spacing*.75,r2=radius*radius,depthSpan=Math.min(.92,depthMax+.04);
    for(let i=0;i<rest.length;i+=3){
      const x=rest[i]-p.x,y=rest[i+1]-p.y,z=rest[i+2]-p.z,d=x*n.x+y*n.y+z*n.z;
      const tx=x-n.x*d,ty=y-n.y*d,tz=z-n.z*d;
      const area=Math.exp(-(tx*tx+ty*ty+tz*tz)/(2*r2));
      const depth=Math.max(0,1-Math.max(0,d)/depthSpan);
      const w=force*area*depth*.041;
      traction[i]+=w*(n.x+tx*.65);traction[i+1]+=w*(n.y+ty*.65);traction[i+2]+=w*(n.z+tz*.65);
    }
  }
  finishPressure(dt){
    if(this.pressureSettled||(!this.hasLoad&&!this.loaded))return;
    const gain=.09+.91*this.softness**1.25,cap=.045+.215*this.softness;
    const relax=1-Math.exp(-dt*(this.hasLoad?6.5:8.5));let magnitude=0,change=0;
    for(let i=0;i<this.pressure.length;i+=3){
      const x=this.traction[i],y=this.traction[i+1],z=this.traction[i+2],f=Math.hypot(x,y,z)*gain;
      const scale=f>0?gain*cap*Math.tanh(f/cap)/f:0;
      for(let c=0;c<3;c++){
        const j=i+c,d=(scale*this.traction[j]-this.pressure[j])*relax;
        this.pressure[j]+=d;change=Math.max(change,Math.abs(d));magnitude=Math.max(magnitude,Math.abs(this.pressure[j]));
      }
    }
    this.loaded=magnitude>.0006;
    if(!this.loaded&&!this.hasLoad)this.pressure.fill(0);
    if(change>.00006){this.active=true;this.quiet=0}
    if(change<.000002)this.pressureSettled=true;
  }
  grab(binding){this.grip=binding;this.active=true;this.quiet=0}
  release(){this.grip=null}
  impact(point,normal,speed){
    // The collision patch has finite area. The rest of the network receives
    // the disturbance only through the elastic links in subsequent substeps.
    const radius=Math.max(.25,this.cage.spacing*1.35),r2=radius*radius;
    const close=this.patches.find(p=>(p.x-point.x)**2+(p.y-point.y)**2+(p.z-point.z)**2<r2*.7);
    if(close&&close.speed>=speed)return;
    const patch=close||{};Object.assign(patch,{x:point.x,y:point.y,z:point.z,nx:normal.x,ny:normal.y,nz:normal.z,speed});
    if(!close)this.patches.push(patch);this.active=true;this.quiet=0;
  }
  floorContact(dt,up,height,verticalSpeed,spinGradient,center){
    // A drooping tip can meet the floor before its rest-shape collider does.
    // Split that contact impulse between material motion and the rigid frame.
    // Only the protruding gel participates, so the hull keeps its usual contacts.
    if(!this.active||height>2.6)return null;
    const {rest,u,v,cage}=this;let dv=0,x=0,y=0,z=0;
    for(let i=0,j=0;i<this.n;i++,j+=3){
      const fitted=this.loaded?up.x*this.pressure[j]+up.y*this.pressure[j+1]+up.z*this.pressure[j+2]:0;
      const extension=fitted-(up.x*u[j]+up.y*u[j+1]+up.z*u[j+2]);if(extension<.045)continue;
      const base=height+fitted+up.x*rest[j]+up.y*rest[j+1]+up.z*rest[j+2]-cage.radii[i];
      if(base<.038)continue;
      const px=rest[j]+u[j],py=rest[j+1]+u[j+1],pz=rest[j+2]+u[j+2];
      const vn=verticalSpeed+spinGradient.x*(px-center.x)+spinGradient.y*(py-center.y)+spinGradient.z*(pz-center.z)
        +up.x*v[j]+up.y*v[j+1]+up.z*v[j+2];
      const gap=base-extension;if(gap+Math.min(vn,0)*dt>.002)continue;
      const impulse=Math.min(3,Math.max(0,-vn)*.64+Math.max(0,-gap)*65);
      const share=cage.weights[i]*impulse;
      dv+=share;x+=px*share;y+=py*share;z+=pz*share;
      v[j]+=up.x*impulse;v[j+1]+=up.y*impulse;v[j+2]+=up.z*impulse;
    }
    if(dv<1e-8)return null;
    for(let j=0;j<v.length;j+=3){v[j]-=up.x*dv;v[j+1]-=up.y*dv;v[j+2]-=up.z*dv}
    return {dv,x:x/dv,y:y/dv,z:z/dv};
  }
  kick(){
    const {rest,u,v}=this;
    for(const p of this.patches){
      const r=Math.max(this.cage.spacing*1.65,.21+Math.min(1,p.speed/5)*(.19+.15*this.softness));
      let min=Infinity;
      for(let j=0;j<u.length;j+=3)min=Math.min(min,(rest[j]+u[j]-p.x)**2+(rest[j+1]+u[j+1]-p.y)**2+(rest[j+2]+u[j+2]-p.z)**2);
      for(let j=0;j<u.length;j+=3){
        const x=rest[j]+u[j]-p.x,y=rest[j+1]+u[j+1]-p.y,z=rest[j+2]+u[j+2]-p.z;
        const w=1-(x*x+y*y+z*z-min)/(r*r);if(w<=0)continue;
        const push=w*w*Math.min(p.speed,6)*(.54+.8*this.softness),dot=x*p.nx+y*p.ny+z*p.nz;
        v[j]+=push*(p.nx+(x-p.nx*dot)*1.3);v[j+1]+=push*(p.ny+(y-p.ny*dot)*1.3);v[j+2]+=push*(p.nz+(z-p.nz*dot)*1.3);
      }
    }
    this.patches.length=0;
  }
  pin(target,h){
    const {index,weight}=this.grip;let x=target.x,y=target.y,z=target.z,den=0;
    for(let k=0;k<index.length;k++){
      const i=index[k],j=i*3,w=weight[k];x-=this.u[j]*w;y-=this.u[j+1]*w;z-=this.u[j+2]*w;den+=w*w/this.mass[i];
    }
    // Distributed constraint enforces the material point under the fingertip.
    const scale=Math.min(1,.042/Math.max(.0001,Math.hypot(x,y,z)))/Math.max(.0001,den);
    for(let k=0;k<index.length;k++){
      const i=index[k],j=i*3,w=weight[k]*scale/this.mass[i];
      this.u[j]+=w*x;this.u[j+1]+=w*y;this.u[j+2]+=w*z;
      this.v[j]+=w*x/h*.75;this.v[j+1]+=w*y/h*.75;this.v[j+2]+=w*z/h*.75;
    }
  }
  step(dt,up,floorHeight,gravity,target,weightUp=up){
    if(!this.active)return false;
    if(this.patches.length)this.kick();
    const {u,v,force,rest,mass,ends,links}=this,h=dt/3;
    const shapeK=this.shapeK*(target?1:.52),damping=this.damping*(target?1:.77);
    let activity=0;
    for(let pass=0;pass<3;pass++){
      force.fill(0);
      const strain=this.loaded?this.strain:u;
      if(this.loaded)for(let i=0;i<u.length;i++)strain[i]=u[i]-this.pressure[i];
      for(let e=0,j=0;e<ends.length;e+=2,j+=4){
        const a=ends[e]*3,b=ends[e+1]*3,ex=links[j],ey=links[j+1],ez=links[j+2],k=links[j+3];
        const dx=strain[b]-strain[a],dy=strain[b+1]-strain[a+1],dz=strain[b+2]-strain[a+2],axial=(dx*ex+dy*ey+dz*ez)*.48;
        const fx=k*(this.coupling*(.52*dx+axial*ex)+4*(v[b]-v[a]));
        const fy=k*(this.coupling*(.52*dy+axial*ey)+4*(v[b+1]-v[a+1]));
        const fz=k*(this.coupling*(.52*dz+axial*ez)+4*(v[b+2]-v[a+2]));
        force[a]+=fx;force[a+1]+=fy;force[a+2]+=fz;force[b]-=fx;force[b+1]-=fy;force[b+2]-=fz;
      }
      activity=0;
      for(let j=0,i=0;j<u.length;j+=3,i++){
        for(let c=0;c<3;c++){
          const l=j+c;v[l]+=(force[l]/mass[i]-shapeK*strain[l]-damping*v[l])*h;
        }
        // Rigid transport already integrates gravity in free fall. A supported
        // grip exposes the material to its own weight in the rotating frame.
        if(target){v[j]-=gravity*weightUp.x*h;v[j+1]-=gravity*weightUp.y*h;v[j+2]-=gravity*weightUp.z*h}
        u[j]+=v[j]*h;u[j+1]+=v[j+1]*h;u[j+2]+=v[j+2]*h;
        const base=rest[j]*up.x+rest[j+1]*up.y+rest[j+2]*up.z+floorHeight-this.cage.radii[i];
        const depth=Math.max(0,-(Math.max(0,base)+up.x*u[j]+up.y*u[j+1]+up.z*u[j+2]));
        if(depth>0){
          u[j]+=depth*up.x;u[j+1]+=depth*up.y;u[j+2]+=depth*up.z;
          const vn=Math.min(0,v[j]*up.x+v[j+1]*up.y+v[j+2]*up.z);v[j]-=vn*up.x;v[j+1]-=vn*up.y;v[j+2]-=vn*up.z;
        }
        activity=Math.max(activity,Math.abs(v[j]),Math.abs(v[j+1]),Math.abs(v[j+2]),this.loaded?0:Math.max(Math.abs(u[j]),Math.abs(u[j+1]),Math.abs(u[j+2]))*2);
      }
      if(target&&this.grip)this.pin(target,h);
    }
    this.dirty=true;this.quiet=activity<.003&&!target?this.quiet+dt:0;
    if(this.quiet>.18){if(!this.loaded)u.fill(0);v.fill(0);this.active=false}
    return this.active;
  }
}
