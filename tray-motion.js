import {Vector3} from './vendor/three.module.min.js';

const gravity=9.81;
const axes=value=>value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);

// Keep the slow gravity estimate for tilt separate from the fast strokes of the tray.
export class MotionSampler {
  constructor(){
    this.rest=new Vector3(); this.linear=new Vector3(); this.specific=new Vector3();
    this.measuredDown=new Vector3(); this.reset();
  }
  reset(){this.previous=null; this.sign=0; this.confirmedSign=false; this.rest.set(0,0,0)}
  sample(event,orientationDown){
    const raw=event.accelerationIncludingGravity, linear=event.acceleration;
    const hasRaw=axes(raw), hasLinear=axes(linear);
    if(!hasRaw&&!hasLinear)return null;
    const elapsed=this.previous===null?0:(event.timeStamp-this.previous)/1000;
    this.previous=event.timeStamp;
    const dt=elapsed>0&&elapsed<.2?Math.min(elapsed,.08):0;
    let measuredDown=null;
    if(hasRaw){
      this.specific.copy(raw);
      if(hasLinear)this.specific.sub(linear);
      const magnitude=this.specific.length();
      if(magnitude>6 && magnitude<13){
        // Correlate a still reading with orientation to handle either accelerometer polarity.
        if(orientationDown&&!this.confirmedSign){
          const alignment=this.specific.dot(orientationDown)/magnitude;
          if(Math.abs(alignment)>.90){
            this.sign=alignment<0?1:-1;this.confirmedSign=true;
          }
        }
        if(!this.sign)this.sign=(Math.abs(raw.z)>.8?raw.z:raw.y)<0?-1:1;
        if(!this.rest.lengthSq()||hasLinear)this.rest.copy(this.specific);
        else this.rest.lerp(this.specific,1-Math.exp(-dt/.38));
      }
      if(this.rest.lengthSq())measuredDown=this.measuredDown.copy(this.rest).normalize().multiplyScalar(-this.sign);
    }
    const sign=this.sign||1;
    if(hasLinear)this.linear.copy(linear).multiplyScalar(sign);
    else if(orientationDown)this.linear.copy(raw).multiplyScalar(sign).addScaledVector(orientationDown,gravity);
    else if(measuredDown)this.linear.copy(raw).sub(this.rest).multiplyScalar(sign);
    else this.linear.set(0,0,0);
    return {acceleration:this.linear,measuredDown,dt};
  }
}

// Input axes are right, up out of the tray, and toward the near edge respectively.
export function trayAcceleration(device,neutral,angle,out){
  out.copy(device).applyQuaternion(neutral);
  const radians=angle*Math.PI/180, c=Math.cos(radians),s=Math.sin(radians);
  const {x,y,z}=out;
  out.set(x*c-y*s,z,-(x*s+y*c));
  const magnitude=out.length();
  if(magnitude<.7)return out.set(0,0,0);
  return out.multiplyScalar(Math.min(43,(magnitude-.7)*2.9)/magnitude);
}

// Deliver both halves of a flick to the fixed-step solver even between rendered frames.
export class TrayMotion {
  constructor(){this.samples=[];this.pending=0}
  clear(){this.samples.length=0;this.pending=0}
  push(acceleration,dt){
    if(!dt || (!acceleration.lengthSq() && !this.samples.some(sample=>sample.a.lengthSq()>0)))return false;
    this.samples.push({a:acceleration.clone(),dt});this.pending+=dt;
    while(this.pending>.240001 && this.samples.length>1)this.pending-=this.samples.shift().dt;
    return true;
  }
  take(dt,out){
    out.set(0,0,0);
    let time=dt;
    while(time>1e-8 && this.samples.length){
      const sample=this.samples[0],part=Math.min(time,sample.dt);
      out.addScaledVector(sample.a,part/dt);
      time-=part;sample.dt-=part;this.pending-=part;
      if(sample.dt<1e-8)this.samples.shift();
    }
    if(!this.samples.length)this.pending=0;
    return out;
  }
}
