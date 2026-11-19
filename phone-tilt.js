import {Vector3,Quaternion} from './vendor/three.module.min.js';
import {MotionSampler,trayAcceleration} from './tray-motion.js';

const rad=Math.PI/180;
const back=new Vector3(0,0,-1);

// Gravity in the device's natural frame. Compass heading does not affect downhill.
export function deviceDown(beta,gamma,out){
  const pitch=beta*rad,roll=gamma*rad,c=Math.cos(pitch);
  return out.set(c*Math.sin(roll),-Math.sin(pitch),-c*Math.cos(roll));
}

export function screenTilt(down,neutral,angle){
  const v=down.clone().applyQuaternion(neutral),h=Math.hypot(v.x,v.y);
  if(h<1e-6)return [0,0];
  const tilt=Math.max(0,Math.atan2(h,-v.z)-1.5*rad);
  const gain=Math.sin(Math.min(68*rad,tilt*2.4))/h;
  const c=Math.cos(angle*rad),s=Math.sin(angle*rad);
  return [gain*(v.x*c-v.y*s),-gain*(v.x*s+v.y*c)];
}

async function permission(api){
  if(!api)return false;
  try{return !api.requestPermission || await api.requestPermission()==='granted'}
  catch{return false}
}

export function connectTilt(button,notice,apply,move){
  const down=new Vector3(),neutral=new Quaternion(),orientation=window.screen.orientation;
  const sensor=new MotionSampler(),tray=new Vector3();
  const angle=()=>orientation?.angle??window.orientation??0;
  let phase='off',generation=0,allowAngles=false,allowMotion=false;
  let baselineAngle=null,calibrationSource='',hasOrientation=false,seenMovement=false;
  let waitingTimer,messageTimer;
  function message(text){
    clearTimeout(messageTimer);notice.textContent=text;notice.hidden=!text;
    if(text)messageTimer=setTimeout(()=>{notice.hidden=true},6500);
  }
  function setPhase(next){
    phase=next;
    button.setAttribute('aria-checked',String(next==='on'||next==='waiting'));
    button.setAttribute('aria-busy',String(next==='requesting'||next==='waiting'));
    button.dataset.state=next;
  }
  function detach(){
    window.removeEventListener('deviceorientation',readAngles);
    window.removeEventListener('devicemotion',readMotion);
    clearTimeout(waitingTimer);baselineAngle=null;calibrationSource='';
    hasOrientation=false;seenMovement=false;neutral.identity();sensor.reset();
  }
  function stop(reason=''){
    generation++;detach();setPhase('off');apply(0,0,true);message(reason);
  }
  function ready(){
    clearTimeout(waitingTimer);setPhase('on');
    if(seenMovement)message('Flick forward and up, then draw back to toss the jelly.');
    else message('Lower an edge to slide the jelly.');
  }
  function tilt(direction,source){
    const a=angle();
    if(baselineAngle!==a||!calibrationSource){
      baselineAngle=a;calibrationSource=source;
      neutral.setFromUnitVectors(direction,back);apply(0,0,true);ready();return;
    }
    apply(...screenTilt(direction,neutral,a));
  }
  function readAngles(event){
    if(document.hidden||!Number.isFinite(event.beta)||!Number.isFinite(event.gamma))return;
    if(baselineAngle!==null && baselineAngle!==angle())listen();
    // Prefer orientation for tilt once it arrives. Motion still drives translation.
    if(!hasOrientation && calibrationSource==='motion')calibrationSource='';
    hasOrientation=true;tilt(deviceDown(event.beta,event.gamma,down),'orientation');
  }
  function readMotion(event){
    if(document.hidden)return;
    const sample=sensor.sample(event,hasOrientation?down:null);
    if(!sample)return;
    const a=angle();
    if(baselineAngle!==null && baselineAngle!==a){listen();return}
    if(!hasOrientation && sample.measuredDown)tilt(sample.measuredDown,'motion');
    if(!seenMovement){
      seenMovement=true;baselineAngle=a;ready();
    }
    if(sample.dt)move(trayAcceleration(sample.acceleration,neutral,a,tray),sample.dt);
  }
  function listen(){
    detach();setPhase('waiting');apply(0,0,true);
    if(document.hidden)return;
    message('Hold your phone at a comfortable angle.');
    if(allowAngles)window.addEventListener('deviceorientation',readAngles);
    if(allowMotion)window.addEventListener('devicemotion',readMotion);
    waitingTimer=setTimeout(()=>stop('No sensor readings. Open the playground directly in your phone browser.'),5000);
  }
  button.addEventListener('click',async()=>{
    if(phase!=='off'){stop();return}
    if(!window.isSecureContext){message('Open the HTTPS playground to use phone motion.');return}
    const angles=window.DeviceOrientationEvent,motion=window.DeviceMotionEvent;
    if(!angles&&!motion){message('Phone motion needs a device with motion sensors.');return}
    const attempt=++generation;setPhase('requesting');
    // Both iOS requests must be started in the original tap.
    const grants=await Promise.all([permission(angles),permission(motion)]);
    if(attempt!==generation)return;
    [allowAngles,allowMotion]=grants;
    if(!allowAngles&&!allowMotion){stop('Motion access is off. Allow it in your browser to use phone motion.');return}
    listen();
  });
  function suspend(){
    if(phase==='on'||phase==='waiting'){detach();setPhase('waiting');apply(0,0,true);message('')}
  }
  function resume(){if(phase==='waiting'&&!document.hidden)listen()}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend();else resume()});
  window.addEventListener('pagehide',suspend);window.addEventListener('pageshow',resume);
  const rotate=()=>{if(phase==='on'&&baselineAngle!==angle())listen()};
  orientation?.addEventListener?.('change',rotate);window.addEventListener('orientationchange',rotate);
  return stop;
}
