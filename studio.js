import * as T from './vendor/three.module.min.js';
import {getModel,sculptGeometry,bindSkin,pickMaterial,deform,palette} from './sculpture.js';
import {createOptics} from './optics.js';
import {createTransmission} from './transmission.js';
import {SoftBody} from './soft-body.js';
import {createDynamics,STEP} from './physics.js';

const vec=()=>new T.Vector3(),up=new T.Vector3(0,1,0),tau=2*Math.PI,clamp=T.MathUtils.clamp;
const clearLogos=new Set(['openai','meta','perplexity']);
const defaultElevation=.89;
const sizes=[1.10,.94,.98,.89,.98,1.04];
const tilts=[[-.64,-.26,-.14],[-.38,.39,.16],[-.57,-.39,.12],[-.83,.20,-.09],[-.39,-.35,-.12],[-.65,.35,.14]];
async function models(asset){
  const response=await fetch('models/'+asset+'.json');if(!response.ok)throw new Error('Could not load '+asset);return (await response.json()).models;
}

export class Studio{
  constructor(tank,canvas,tone){
    this.tank=tank;this.canvas=canvas;this.tone=tone;this.bodies=[];this.byMesh=new Map();this.hands=new Map();
    this.tiltTarget=new T.Vector2();this.tiltValue=new T.Vector2();this.gravity=vec().set(0,-9.81,0);
    this.yaw=0;this.elevation=defaultElevation;this.generation=0;this.clock=0;this.accumulator=0;this.previous=0;this.frame=0;this.awakeUntil=0;
    this.touchScreen=matchMedia('(any-pointer: coarse)');this.softness=.72;this.reduced=matchMedia('(prefers-reduced-motion: reduce)');this.mode='grab';this.paused=false;
    this.renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.NoToneMapping;
    this.scene=new T.Scene();this.scene.background=new T.Color('#fafafa');this.camera=new T.OrthographicCamera(-8,8,4,-4,.1,120);
    this.target=new T.Vector3(0,.28,0);this.lightDir=vec();this.glass=createTransmission(this.renderer,this.scene,this.camera);
    this.optics=createOptics(this.renderer,this.scene);this.ray=new T.Raycaster();this.ndc=new T.Vector2();this.floorPlane=new T.Plane(up,0);
    this.temp=vec();this.temp2=vec();this.quat=new T.Quaternion();this.mtx=new T.Matrix4();
    this.portrait=this.touchScreen.matches?matchMedia('(orientation: portrait)').matches:tank.getBoundingClientRect().width<630;this.capacity=6;this.layoutTable(6);
    this.lightAngle(225,false);this.resize(false);this.bindPointers();
    new ResizeObserver(()=>this.resize()).observe(tank);
    document.addEventListener('visibilitychange',()=>{if(document.hidden){this.cancelHands();this.cancel()}else this.wake()});
  }
  async initPhysics(){
    if(!this.initializing)this.initializing=Promise.all([models('colliders').then(createDynamics),models('cages')]).then(([sim,cages])=>{
      this.physics=sim;sim.world.gravity=this.gravity;this.cages=cages;sim.bound(this.tableW,this.tableD);
    }).catch(e=>{this.initializing=null;throw e});
    await this.initializing;
  }
  lightAngle(angle,draw=true){
    const a=angle*Math.PI/180;this.lightDir.set(Math.cos(a)*.95,1.2,Math.sin(a)*.95).normalize();
    if(draw)this.wake();
  }
  layoutTable(n){
    const factor=Math.sqrt(Math.max(6,n)/6);
    this.tableW=(this.portrait?5.4:12.1)*factor;this.tableD=(this.portrait?9.7:6.50)*factor;
    this.physics?.bound(this.tableW,this.tableD);
  }
  resize(wake=true){
    const r=this.tank.getBoundingClientRect();if(!r.width||!r.height)return;
    this.w=r.width;this.h=r.height;const aspect=this.w/this.h;
    this.nextNameLayout=0;this.labelKeepouts=['.stage-meta','.manage-logos'].map(selector=>{
      const box=this.tank.querySelector(selector).getBoundingClientRect();
      return {l:box.left-r.left-2,r:box.right-r.left+2,t:box.top-r.top-2,b:box.bottom-r.top+2};
    });
    // A quarter turn refits the same table after device rotation, preserving
    // stacks and grips in world space.
    const rotated=this.touchScreen.matches&&this.portrait!==(aspect<1);
    this.viewTurn=rotated?Math.PI/2:0;
    const width=rotated?this.tableD:this.tableW,depth=rotated?this.tableW:this.tableD;
    this.worldH=Math.max(depth*Math.sin(defaultElevation)+1.15,(width+.80)/aspect);
    this.worldW=this.worldH*aspect;
    this.camera.left=-this.worldW/2;this.camera.right=this.worldW/2;this.camera.top=this.worldH/2;this.camera.bottom=-this.worldH/2;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,this.touchScreen.matches?(this.bodies.length>12?1:1.35):1.65));this.renderer.setSize(r.width,r.height,false);this.positionCamera();
    if(wake)this.wake();
  }
  positionCamera(){
    const c=Math.cos(this.elevation),angle=this.yaw+(this.viewTurn||0);this.camera.position.set(Math.sin(angle)*c,Math.sin(this.elevation),Math.cos(angle)*c).multiplyScalar(30).add(this.target);
    this.camera.lookAt(this.target);this.camera.updateMatrixWorld();
  }
  spawnPoint(slot,count,existing){
    const cols=Math.min(count,Math.max(1,Math.round(Math.sqrt(count*(this.portrait?.64:1.52)))));
    const rows=Math.ceil(count/cols);
    const gridPoint=i=>{
      const row=Math.floor(i/cols),items=Math.min(cols,count-row*cols);
      return new T.Vector2((((i%cols)+.5)/items-.5)*this.tableW,((row+.5)/rows-.5)*this.tableD);
    };
    if(!existing)return gridPoint(slot);
    // Sample the free floor, so a newly added logo leaves the others in place.
    const candidates=[];
    for(let z=0;z<7;z++)for(let x=0;x<9;x++)candidates.push(new T.Vector2((x/8-.5)*(this.tableW-2.1),(z/6-.5)*(this.tableD-2.1)));
    const clearance=p=>this.bodies.reduce((d,b)=>Math.min(d,Math.hypot(p.x-b.mesh.position.x,p.y-b.mesh.position.z)-b.size),Infinity);
    return candidates.reduce((best,p)=>clearance(p)>clearance(best)?p:best,gridPoint(slot));
  }
  place(b,spot,slot){
    b.mesh.rotation.set(...tilts[slot%6],'YXZ');
    const down=this.temp.set(0,-1,0).applyQuaternion(this.quat.copy(b.mesh.quaternion).invert());
    let bottom=0;for(const p of b.data.support)bottom=Math.max(bottom,p.dot(down)*b.size);
    b.mesh.position.set(spot.x,bottom+b.size*(this.reduced.matches?.09:.53),spot.y);b.mesh.updateMatrixWorld();
  }
  makeBody(entry,data,clearData,slot,spot){
    const [id,name,style]=entry;
    const build=d=>new T.Mesh(sculptGeometry(d),new T.MeshBasicMaterial());
    const mesh=build(data),parts=[{data,mesh}];
    mesh.name=name;mesh.frustumCulled=false;
    let filler;
    if(clearData){filler=build(clearData);filler.name=name+' clear gel';filler.frustumCulled=false;mesh.add(filler);parts.push({data:clearData,mesh:filler})}
    const label=document.createElement('button');label.className='name';label.textContent=name;label.dataset.slug=id;
    label.setAttribute('aria-label',name+' sculpture');label.style.setProperty('--dot',palette[style]);
    const cage=this.cages[id],soft=new SoftBody(cage,this.softness);
    for(const part of parts)bindSkin(part,cage);
    const b={id,name:label,color:new T.Color(palette[style]),mesh,filler,parts,data,size:sizes[slot%6],slot,held:null,
      soft,localUp:vec(),weightUp:vec(),pinTarget:vec(),impactTime:-1};
    mesh.scale.setScalar(b.size);this.place(b,spot,slot);this.physics.add(b);b.localCom=vec().copy(b.rigid.localCom()).divideScalar(b.size);
    this.scene.add(mesh);this.byMesh.set(mesh,b);if(filler)this.byMesh.set(filler,b);this.bodies.push(b);document.querySelector('#bodies').append(label);
    label.addEventListener('click',e=>{if(e.detail===0)this.bounce(b)});
    label.addEventListener('keydown',e=>{
      const key={ArrowRight:[1,0],ArrowLeft:[-1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}[e.key];if(!key)return;
      e.preventDefault();if(this.mode==='turn'){
        const omega=this.temp.copy(b.rigid.angvel()).addScaledVector(up,key[0]*2.1).addScaledVector(this.cameraRight(),-key[1]*2.1);
        b.rigid.setAngvel(omega,true);
      }else{
        const impulse=this.temp.copy(this.cameraRight()).multiplyScalar(key[0]*2.7);impulse.y+=key[1]*3.1;b.rigid.applyImpulse(impulse.multiplyScalar(b.rigid.mass()),true);
      }
      this.wake();
    });
  }
  removeBody(b){
    if(b.held!==null)this.release(b.held,true);
    this.physics.remove(b);b.name.remove();this.scene.remove(b.mesh);
    for(const p of b.parts){this.byMesh.delete(p.mesh);p.mesh.geometry.dispose();p.mesh.material.dispose()}
    this.bodies.splice(this.bodies.indexOf(b),1);
  }
  async select(entries,{reset=false}={}){
    const generation=++this.generation;
    await this.initPhysics();if(this.generation!==generation)return;
    const wanted=new Set(entries.map(c=>c[0]));
    const additions=entries.filter(c=>reset||!this.bodies.some(b=>b.id===c[0]));
    const prefix=this.touchScreen.matches?'mobile/':'';
    const loaded=await Promise.all(additions.map(async entry=>[entry,...await Promise.all([getModel(prefix+entry[0]),clearLogos.has(entry[0])?getModel(prefix+entry[0]+'-clear'):null])]));
    if(this.generation!==generation)return;
    if(reset||!this.bodies.length){this.capacity=Math.max(6,entries.length);this.layoutTable(this.capacity);if(reset){this.yaw=0;this.elevation=defaultElevation}this.resize(false)}
    else if(entries.length>this.capacity){this.capacity=entries.length;this.layoutTable(this.capacity);this.resize(false)}
    for(const b of [...this.bodies])if(reset||!wanted.has(b.id))this.removeBody(b);
    const existing=this.bodies.length>0;
    for(const [entry,data,clearData] of loaded){
      const slot=entries.indexOf(entry),spot=this.spawnPoint(slot,entries.length,existing);this.makeBody(entry,data,clearData,slot,spot);
    }
    this.bodies.sort((a,b)=>entries.findIndex(e=>e[0]===a.id)-entries.findIndex(e=>e[0]===b.id));
    this.optics.setBodies(this.bodies);this.glass.setBodies(this.bodies);if(this.touchScreen.matches)this.resize(false);this.wake();
  }
  cameraRight(){return this.temp2.setFromMatrixColumn(this.camera.matrixWorld,0)}
  setRay(e){
    const r=this.tank.getBoundingClientRect();this.ndc.set((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2);this.ray.setFromCamera(this.ndc,this.camera);
  }
  pick(e,bodies,fingerRadius=0){
    this.setRay(e);
    const meshes=bodies.map(b=>b.mesh),direct=this.ray.intersectObjects(meshes,true)[0];
    if(direct||!fingerRadius)return direct;
    // Give a fingertip a small tolerance around narrow strokes.
    for(const [x,y] of [[-1,0],[1,0],[0,-1],[0,1]]){
      this.setRay({clientX:e.clientX+x*fingerRadius,clientY:e.clientY+y*fingerRadius});
      const hit=this.ray.intersectObjects(meshes,true)[0];if(hit){this.setRay(e);return hit}
    }
    this.setRay(e);
  }
  dropTarget(h,target){
    if(h.over===target)return;
    const previous=h.over;h.over=target;
    if(previous&&!Array.from(this.hands.values()).some(hand=>hand!==h&&hand.over===previous))previous.name.classList.remove('drop-target');
    target?.name.classList.add('drop-target');
  }
  aimDrop(h){
    const base=h.over,b=h.b;
    const center=base.rigid.worldCom(),rotation=b.rigid.rotation(),grip=this.temp.copy(h.grip).applyQuaternion(rotation);
    const offset=this.temp2.copy(b.localCom).multiplyScalar(b.size).applyQuaternion(rotation);
    const lift=this.quat.copy(b.mesh.quaternion).invert(),vertical=vec().copy(up).applyQuaternion(lift);
    let low=0;const {rest,u,cage}=b.soft;
    for(let i=0,j=0;i<b.soft.n;i++,j+=3)low=Math.min(low,(rest[j]+u[j])*vertical.x+(rest[j+1]+u[j+1])*vertical.y+(rest[j+2]+u[j+2])*vertical.z-cage.radii[i]);
    const baseUp=vertical.copy(up).applyQuaternion(lift.copy(base.mesh.quaternion).invert());
    let high=0;const gel=base.soft;
    for(let i=0,j=0;i<gel.n;i++,j+=3)high=Math.max(high,(gel.rest[j]+gel.u[j])*baseUp.x+(gel.rest[j+1]+gel.u[j+1])*baseUp.y+(gel.rest[j+2]+gel.u[j+2])*baseUp.z+gel.cage.radii[i]);
    const targetY=base.mesh.position.y+high*base.size+.36;
    h.target.set(center.x+grip.x-offset.x,targetY-low*b.size+grip.y,center.z+grip.z-offset.z);
    return Math.hypot(center.x-b.rigid.worldCom().x,center.z-b.rigid.worldCom().z)<.19&&b.mesh.position.y+low*b.size>targetY-.25;
  }
  pointerDown(e){
    if(e.button!==0||e.target.closest('#tilt-gravity,.manage-logos,#loading,#empty-studio'))return;this.setRay(e);
    const label=e.target.closest('.name'),labelBody=label?this.bodies.find(b=>b.name===label):null;
    const hit=labelBody?null:this.pick(e,this.bodies,e.pointerType==='touch'?7:0),b=labelBody??this.byMesh.get(hit?.object);
    const action=this.mode==='attract'||this.mode==='repel'?this.mode:b?this.mode:'orbit';
    if(b&&this.hands.get(b.held)?.placing)this.release(b.held,true);
    if(b&&b.held!==null&&(action==='grab'||action==='turn'))return;
    const hand={action,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,dist:0,target:vec(),touch:e.pointerType==='touch',id:e.pointerId};
    if(action==='grab'||action==='turn'){
      hand.b=b;b.held=e.pointerId;b.name.classList.add('active');
      const point=(labelBody||action==='turn')?vec().copy(b.rigid.worldCom()):hit.point.clone();
      const local=b.mesh.worldToLocal(point.clone());
      const pick=action==='turn'?{rest:local}:pickMaterial(b.parts.find(p=>p.mesh===hit?.object),hit,local,b.soft.cage);
      hand.rest=pick.rest;hand.grip=pick.rest.clone().multiplyScalar(b.size);
      if(action==='grab')b.soft.grab(pick.binding);
      hand.rotation=b.mesh.quaternion.clone();hand.target.copy(point);
      hand.plane=new T.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(vec()),point);
      const click=this.ray.ray.intersectPlane(hand.plane,vec());hand.offset=(click??point.clone()).sub(point);
      if(hand.touch){const floor=this.ray.ray.intersectPlane(this.floorPlane,vec());hand.carryOffset=floor?point.clone().sub(floor):vec();hand.startHeight=point.y}
      hand.control=this.physics.hold(b,point,hand.grip,action==='turn');this.tone(230+18*(b.slot%6),.22);
    }else if(action!=='orbit'){this.ray.ray.intersectPlane(this.floorPlane,hand.target);this.applyField(hand,.07)}
    e.preventDefault();this.tank.setPointerCapture(e.pointerId);this.hands.set(e.pointerId,hand);this.tank.classList.add('holding');this.wake();
  }
  pointerMove(e){
    const h=this.hands.get(e.pointerId);if(!h)return;
    const dx=e.clientX-h.x,dy=e.clientY-h.y;h.dist=Math.max(h.dist,Math.hypot(e.clientX-h.startX,e.clientY-h.startY));h.x=e.clientX;h.y=e.clientY;
    if(h.action==='orbit'){
      this.yaw=clamp(this.yaw-dx*.005,-1.14,1.14);this.elevation=clamp(this.elevation+dy*.004,.30,1.43);this.positionCamera();
    }else if(h.action==='turn'){
      h.rotation.premultiply(this.quat.setFromAxisAngle(up,dx*.012));h.rotation.premultiply(this.quat.setFromAxisAngle(this.cameraRight(),dy*.012));h.rotation.normalize();
      h.target.y=Math.max(h.target.y,h.b.size*1.06);
    }else{
      this.setRay(e);
      if(h.action==='grab'){
        if(h.dist<5)return;
        const candidates=this.bodies.filter(b=>b!==h.b&&b.held===null);
        const label=document.elementFromPoint(e.clientX,e.clientY)?.closest('.name');
        const hit=this.pick(e,candidates,h.touch?5:0),base=candidates.find(b=>b.name===label)??this.byMesh.get(hit?.object);
        this.dropTarget(h,base);
        if(base){this.aimDrop(h);this.wake();return}
        const p=this.ray.ray.intersectPlane(h.touch?this.floorPlane:h.plane,this.temp);if(!p)return;
        if(h.touch){
          h.target.copy(p).add(h.carryOffset);
          h.target.y=h.startHeight+Math.min(1,h.dist/48)*1.55*h.b.size;
        }else h.target.copy(p).sub(h.offset);
        h.target.x=clamp(h.target.x,-this.tableW*.49,this.tableW*.49);h.target.z=clamp(h.target.z,-this.tableD*.49,this.tableD*.49);
        h.target.y=clamp(h.target.y,.035,Math.max(3.8,this.worldH*.81));
      }else this.ray.ray.intersectPlane(this.floorPlane,h.target);
    }
    this.wake();
  }
  release(id,cancel=false){
    const h=this.hands.get(id);if(!h)return;this.hands.delete(id);
    if(typeof id==='number'&&this.tank.hasPointerCapture(id))this.tank.releasePointerCapture(id);
    if(h.over&&!cancel&&!h.placing&&h.dist>=5){
      // Finish a deliberate placement through the same physical hand spring.
      // A short drag on a phone may end before the heavy gel reaches the finger.
      const key=Symbol('drop'),b=h.b;
      this.physics.unhold(h.control);b.soft.release();b.followUntil=0;
      h.grip.copy(b.localCom).multiplyScalar(b.size);
      h.control=this.physics.hold(b,b.rigid.worldCom(),h.grip,false);
      b.held=key;h.placing=true;h.action='place';h.timeLeft=1.0;
      this.hands.set(key,h);b.name.classList.remove('active');
    }else{
      this.dropTarget(h,null);
      if(h.b){
        this.physics.unhold(h.control);h.b.held=null;h.b.soft.release();h.b.name.classList.remove('active');
        if(h.placing&&!cancel){
          const rb=h.b.rigid,v=rb.linvel(),spin=this.temp.copy(rb.angvel()).multiplyScalar(.45).clampLength(0,1.2);
          rb.setLinvel({x:clamp(v.x*.18,-.22,.22),y:clamp(v.y,-.6,.12),z:clamp(v.z*.18,-.22,.22)},true);
          rb.setAngvel(spin,true);
        }
        if(!cancel&&h.dist<5)this.bounce(h.b);
      }
    }
    this.tank.classList.toggle('holding',Array.from(this.hands.values()).some(hand=>!hand.placing));this.wake();
  }
  bindPointers(){
    this.tank.addEventListener('pointerdown',e=>this.pointerDown(e));this.tank.addEventListener('pointermove',e=>this.pointerMove(e));
    this.tank.addEventListener('pointerup',e=>this.release(e.pointerId));
    for(const ev of ['pointercancel','lostpointercapture'])this.tank.addEventListener(ev,e=>this.release(e.pointerId,true));
    window.addEventListener('blur',()=>this.cancelHands());
    window.addEventListener('pagehide',()=>this.cancelHands());
  }
  cancelHands(){for(const id of [...this.hands.keys()])this.release(id,true)}
  setMode(mode){this.cancelHands();this.mode=mode}
  bounce(b){
    const rb=b.rigid,m=rb.mass(),p=vec().copy(rb.worldCom());p.x+=.12*b.size;
    rb.applyImpulseAtPoint({x:0,y:m*(this.reduced.matches?2.1:4.15)*Math.sqrt(b.size),z:0},p,true);
    this.tone(195+26*(b.slot%6),.5);this.wake();
  }
  shake(){
    this.cancelHands();for(const b of this.bodies){
      const rb=b.rigid,t=Math.random()*tau,k=this.reduced.matches?.58:1,m=rb.mass()*k;
      const p=vec().copy(rb.worldCom());p.x+=(Math.random()-.5)*b.size;p.z+=(Math.random()-.5)*b.size;
      rb.applyImpulseAtPoint({x:Math.cos(t)*2.35*m,y:(3.1+Math.random()*2.25)*m,z:Math.sin(t)*2.35*m},p,true);
    }
    this.tone(160,.7);this.wake();
  }
  applyField(h,dt){
    const sign=h.action==='attract'?1:-1;
    for(const b of this.bodies){
      const d=this.temp.copy(h.target).sub(b.rigid.worldCom());d.y=0;const length=d.length(),range=b.size*6.5;if(length<.03||length>range)continue;
      b.rigid.applyImpulse(d.multiplyScalar(sign*dt*15*(1-length/range)*b.rigid.mass()/length),true);
    }
  }
  impact=(b,normal,point,change)=>{
    this.quat.copy(b.rigid.rotation()).invert();
    const direction=this.temp.copy(normal).applyQuaternion(this.quat).normalize();
    const local=this.temp2.copy(point).sub(b.rigid.translation()).applyQuaternion(this.quat).divideScalar(b.size);
    b.soft.impact(local,direction,change/b.size);
    if(change>1.25&&this.clock-b.impactTime>.07){this.tone(135+19*(b.slot%6),change*.1);b.impactTime=this.clock}
  };
  setSoftness(value){
    this.softness=clamp(value,0,1);for(const b of this.bodies)b.soft.setSoftness(this.softness);
    this.wake();
  }
  setTilt(right,down,immediate=false){
    const dx=right-this.tiltTarget.x,dy=down-this.tiltTarget.y;
    const change=dx*dx+dy*dy;
    const threshold=right===0&&down===0?0:.000016;
    if(!immediate&&change<=threshold)return;
    this.tiltTarget.set(right,down);
    if(immediate){this.tiltValue.copy(this.tiltTarget);this.updateGravity(0)}
    this.wake();
  }
  updateGravity(dt){
    const current=this.tiltValue,goal=this.tiltTarget;
    current.lerp(goal,1-Math.exp(-dt*12));
    if(current.distanceToSquared(goal)<.000004)current.copy(goal);
    const yaw=this.yaw+(this.viewTurn||0),c=Math.cos(yaw),s=Math.sin(yaw);
    const next=this.temp.set(current.x*c+current.y*s,-Math.sqrt(Math.max(0,1-current.lengthSq())),current.y*c-current.x*s).multiplyScalar(9.81);
    const settled=current.equals(goal);
    if(this.gravity.distanceToSquared(next)>(settled?1e-12:.0004)){
      this.gravity.copy(next);
      if(this.physics){this.physics.world.gravity=this.gravity;for(const b of this.bodies)if(b.rigid.isSleeping())b.rigid.wakeUp()}
    }
    return !settled;
  }
  step(dt=STEP){
    if(!this.physics||!this.bodies.length)return false;
    this.clock+=dt;
    const gravityChanging=this.updateGravity(dt);
    for(const h of this.hands.values()){
      if(h.action==='attract'||h.action==='repel'){this.applyField(h,dt);continue}
      if(!h.control)continue;
      if(h.over){
        if(!h.over.rigid||h.over.held!==null){this.dropTarget(h,null);if(h.placing){this.release(h.b.held,true);continue}}
        else{
          const ready=this.aimDrop(h);
          if(h.placing){h.timeLeft-=dt;if((ready&&h.timeLeft<.72)||h.timeLeft<=0){this.release(h.b.held);continue}}
        }
      }
      const current=h.control.translation(),travel=this.temp.copy(h.target).sub(current).multiplyScalar(1-Math.exp(-34*dt)).clampLength(0,15*dt);
      h.control.setNextKinematicTranslation(travel.add(current));if(h.action==='turn')h.control.setNextKinematicRotation(h.rotation);
    }
    for(const b of this.bodies){
      if(!b.soft.active||b.hullFollowsGrip)continue;
      const rb=b.rigid,inv=this.quat.copy(b.mesh.quaternion).invert();
      b.localUp.copy(up).applyQuaternion(inv);
      const spin=this.temp.copy(rb.angvel()).applyQuaternion(inv);
      const contact=b.soft.floorContact(dt,b.localUp,b.mesh.position.y/b.size,rb.linvel().y/b.size,this.temp2.crossVectors(b.localUp,spin),b.localCom);
      if(contact){
        const point=this.temp.set(contact.x,contact.y,contact.z).multiplyScalar(b.size).applyQuaternion(b.mesh.quaternion).add(b.mesh.position);
        rb.applyImpulseAtPoint({x:0,y:contact.dv*b.size*rb.mass(),z:0},point,true);
      }
    }
    this.physics.step(this.impact);
    let moving=gravityChanging;
    for(const b of this.bodies){
      b.mesh.position.copy(b.rigid.translation());b.mesh.quaternion.copy(b.rigid.rotation());
      this.quat.copy(b.mesh.quaternion).invert();b.localUp.copy(up).applyQuaternion(this.quat);
      const hand=this.hands.get(b.held);
      const target=hand?.action==='grab'?b.pinTarget.copy(hand.control.translation()).sub(b.mesh.position).applyQuaternion(this.quat).divideScalar(b.size).sub(hand.rest):null;
      if(target)b.weightUp.copy(this.gravity).multiplyScalar(-1/9.81).applyQuaternion(this.quat);
      const elastic=b.soft.step(dt,b.localUp,b.mesh.position.y/b.size,9.81/b.size,target,b.weightUp);
      moving ||= !b.rigid.isSleeping()||elastic;
    }
    return moving;
  }
  positionCrowdedNames(){
    const occupied=[...this.labelKeepouts].sort((a,b)=>a.l-b.l);
    for(const body of this.bodies)if(body.labelWidthAt!==this.w){
      body.labelHalfWidth=body.name.offsetWidth/2+1.5;body.labelHeight=body.name.offsetHeight+2;body.labelWidthAt=this.w;
    }
    // The nearest free rectangle lies at the anchor or flush with an obstacle.
    // Test those rows, scanning horizontal gaps in order of their left edge.
    for(const body of [...this.bodies].sort((a,b)=>b.labelY-a.labelY)){
      const name=body.name,half=body.labelHalfWidth,h=body.labelHeight,minX=half+2,maxX=this.w-half-2,maxY=this.h-h-2;
      const anchorX=clamp(body.labelX,minX,maxX),anchorY=clamp(body.labelY,2,maxY);
      let best=Infinity,x=anchorX,y=anchorY;
      const row=cy=>{
        if(cy<2||cy>maxY)return;
        const dy=(cy-anchorY)**2;if(dy>=best)return;
        let left=minX;
        const gap=right=>{
          if(right<left)return;
          const cx=clamp(anchorX,left,right),cost=(cx-anchorX)**2+dy;
          if(cost<best){best=cost;x=cx;y=cy}
        };
        for(const box of occupied){
          if(cy>=box.b||cy+h<=box.t)continue;
          gap(Math.min(maxX,box.l-half));left=Math.max(left,box.r+half);if(left>maxX)return;
        }
        gap(maxX);
      };
      row(anchorY);
      if(best>0){for(const box of occupied){row(box.t-h);row(box.b)}row(2);row(maxY)}
      const rect={l:x-half,r:x+half,t:y,b:y+h};
      const index=occupied.findIndex(box=>box.l>rect.l);
      occupied.splice(index<0?occupied.length:index,0,rect);
      name.style.transform='translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px) translateX(-50%)';
    }
  }
  draw(){
    this.mtx.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);
    const crowded=this.touchScreen.matches&&this.bodies.length>9,now=performance.now();
    this.skinPhase=1-(this.skinPhase||0);
    for(const b of this.bodies){
      // Small, distant meshes share the skinning budget. Grips, the final
      // resting shape and the rigid pose are updated on every relevant draw.
      const skinDue=!crowded||b.held!==null||!b.soft.active||b.slot%2===this.skinPhase||now-(b.lastSkin||0)>58;
      if(b.soft.dirty&&skinDue){deform(b);b.lastSkin=now}
      b.mesh.updateMatrixWorld();const vp=new T.Matrix4().multiplyMatrices(this.mtx,b.mesh.matrixWorld).elements;
      let minY=Infinity;const surface=b.mesh.geometry.attributes.position.array;
      for(const j of b.data.supportIndices)minY=Math.min(minY,vp[1]*surface[j]+vp[5]*surface[j+1]+vp[9]*surface[j+2]+vp[13]);
      const center=this.temp.copy(b.mesh.position).project(this.camera),x=clamp((center.x*.5+.5)*this.w,40,this.w-40),y=clamp((.5-minY*.5)*this.h+5,28,this.h-21);
      if(crowded){b.labelX=x;b.labelY=y}
      else b.name.style.transform='translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px) translateX(-50%)';
    }
    if(crowded&&(now>=this.nextNameLayout||this.previous===0)){
      this.positionCrowdedNames();this.nextNameLayout=now+55;
    }
    this.optics.update(this.lightDir,this.tableW+7,this.tableD+8);this.glass.draw(this.lightDir);
  }
  tick=(time)=>{
    this.frame=0;if(this.paused||document.hidden)return;
    this.accumulator+=this.previous?Math.min(.18,(time-this.previous)/1000):STEP;this.previous=time;
    let motion=this.bodies.some(b=>!b.rigid.isSleeping()||b.soft.active);
    while(this.accumulator>=STEP){motion=this.step()||motion;this.accumulator-=STEP}
    this.draw();
    if(motion||this.hands.size||time<this.awakeUntil)this.frame=requestAnimationFrame(this.tick);else this.previous=0;
  };
  wake(){this.awakeUntil=performance.now()+250;if(!this.frame&&!this.paused&&!document.hidden)this.frame=requestAnimationFrame(this.tick)}
  cancel(){cancelAnimationFrame(this.frame);this.frame=0;this.previous=0;this.accumulator=0}
  setPaused(value){this.paused=value;if(value){this.cancelHands();this.cancel()}else this.wake()}
}
