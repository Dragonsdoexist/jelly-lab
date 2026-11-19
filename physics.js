import R from './vendor/rapier.mjs';

import {GelContacts} from './gel-contact.js';

export const STEP = 1/90;
const zero = {x:0,y:0,z:0};
const identity = {x:0,y:0,z:0,w:1};
const initialised = R.init();

export async function createDynamics(shapes) {
  await initialised;
  return new Dynamics(shapes);
}

class Dynamics {
  constructor(shapes) {
    this.shapes=shapes;
    this.world=new R.World({x:0,y:-9.81,z:0});
    this.world.timestep=STEP;
    this.world.numSolverIterations=6;
    this.world.maxCcdSubsteps=3;
    this.events=new R.EventQueue(true);
    this.floor=this.world.createCollider(R.ColliderDesc.cuboid(200,.25,200)
      .setTranslation(0,-.25,0).setFriction(.73).setRestitution(.28));
    this.walls=[];
    this.lookup=new Map();this.gel=new GelContacts();this.sequence=0;
  }
  bound(width,depth) {
    if(this.width===width&&this.depth===depth)return;
    this.width=width;this.depth=depth;
    for(const c of this.walls)this.world.removeCollider(c,false);
    const w=width/2,d=depth/2,t=.22;
    const specs=[[w+t,0,t,d+2*t],[-w-t,0,t,d+2*t],[0,d+t,w,t],[0,-d-t,w,t]];
    this.walls=specs.map(([x,z,hx,hz])=>this.world.createCollider(R.ColliderDesc.cuboid(hx,20,hz)
      .setTranslation(x,20,z).setFriction(.5).setRestitution(.36)));
  }
  add(b) {
    const shape=this.shapes[b.id],s=b.size;
    if(!shape?.hulls.length)throw new Error('Missing collision model for '+b.id);
    const [cx,cy,cz]=shape.center,[ix,iy,iz]=shape.principalInertia,[x,y,z,w]=shape.inertiaRotation;
    const descriptor=R.RigidBodyDesc.dynamic().setTranslation(...b.mesh.position.toArray())
      .setRotation(b.mesh.quaternion).setLinearDamping(.035).setAngularDamping(.29)
      .setCcdEnabled(true).setCanSleep(true)
      .setAdditionalMassProperties(shape.volume*s**3,{x:cx*s,y:cy*s,z:cz*s},
        {x:ix*s**5,y:iy*s**5,z:iz*s**5},{x,y,z,w});
    const rb=this.world.createRigidBody(descriptor);
    try {
      for(const vertices of shape.hulls){
        const hull=R.ColliderDesc.convexHull(Float32Array.from(vertices,v=>v*s));
        if(!hull)throw new Error('Invalid collision hull for '+b.id);
        // The actual integrated solid sets mass and inertia, including its clear gel.
        hull.setDensity(0).setFriction(.72).setRestitution(.34)
          .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS);
        this.world.createCollider(hull,rb);
      }
      rb.recomputeMassPropertiesFromColliders();
    }catch(error){this.world.removeRigidBody(rb);throw error}
    b.contactId=++this.sequence;b.rigid=rb;this.lookup.set(rb.handle,b);
  }
  remove(b) {
    if(!b.rigid)return;
    this.gel.remove(b);this.lookup.delete(b.rigid.handle);this.world.removeRigidBody(b.rigid);b.rigid=null;
  }
  hold(b,point,local,turn) {
    const desc=R.RigidBodyDesc.kinematicPositionBased().setTranslation(point.x,point.y,point.z);
    if(turn)desc.setRotation(b.rigid.rotation());
    const hand=this.world.createRigidBody(desc),mass=b.rigid.mass();
    const joint=turn?R.JointData.fixed(zero,identity,local,identity):
      R.JointData.spring(0,165*mass,15*mass,zero,local);
    const link=this.world.createImpulseJoint(joint,hand,b.rigid,true);
    link.setContactsEnabled(false);
    return hand;
  }
  unhold(hand){if(hand?.isValid())this.world.removeRigidBody(hand)}
  step(onImpact) {
    for(const b of this.lookup.values()){
      if(!b.soft||b.rigid.isSleeping()){b.approach=null;continue}
      b.approach={linear:b.rigid.linvel(),angular:b.rigid.angvel(),center:b.rigid.worldCom()};
    }
    this.world.step(this.events);
    this.events.drainCollisionEvents((h1,h2,started)=>{
      if(!started)return;
      const a=this.world.getCollider(h1),b=this.world.getCollider(h2);if(!a||!b)return;
      const ba=this.lookup.get(a.parent()?.handle),bb=this.lookup.get(b.parent()?.handle);
      if((!ba&&!bb)||(ba?.soft&&bb?.soft))return;
      this.world.contactPair(a,b,(manifold,flipped)=>{
        if(!manifold.numSolverContacts())return;
        const n=manifold.normal(),point=manifold.solverContactPoint(0);
        let impulse=0;
        for(let i=0;i<manifold.numContacts();i++)impulse+=Math.abs(manifold.contactImpulse(i));
        // Rapier reports the normal pointing from manifold collider 1 to 2.
        const sign=flipped?-1:1;
        for(const [body,side] of [[ba,-sign],[bb,sign]]){
          if(!body)continue;
          const change=impulse/body.rigid.mass();
          if(change>.36)onImpact(body,{x:n.x*side,y:n.y*side,z:n.z*side},point,change);
        }
      });
    });
    this.gel.update(this.world,this.events,this.lookup,STEP,onImpact);
  }
}
