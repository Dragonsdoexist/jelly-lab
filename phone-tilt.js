import {Vector3,Quaternion} from './vendor/three.module.min.js';

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

export function connectTilt(button,notice,apply){
  const down=new Vector3(),neutral=new Quaternion(),orientation=window.screen.orientation;
  const angle=()=>orientation?.angle??window.orientation??0;
  let phase='off',generation=0,source,baselineAngle,waitingTimer,messageTimer;
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
    if(source)window.removeEventListener(source.event,read);
    clearTimeout(waitingTimer);baselineAngle=null;
  }
  function stop(reason=''){
    generation++;detach();setPhase('off');apply(0,0,true);message(reason);
  }
  function read(event){
    if(document.hidden||(phase!=='on'&&phase!=='waiting'))return;
    if(source.event==='deviceorientation'){
      if(!Number.isFinite(event.beta)||!Number.isFinite(event.gamma))return;
      deviceDown(event.beta,event.gamma,down);
    }else{
      const a=event.accelerationIncludingGravity;
      if(!a||![a.x,a.y,a.z].every(Number.isFinite))return;
      down.set(-a.x,-a.y,-a.z);if(down.lengthSq()<1)return;down.normalize();
    }
    const currentAngle=angle();
    if(baselineAngle!==currentAngle){
      clearTimeout(waitingTimer);baselineAngle=currentAngle;
      neutral.setFromUnitVectors(down,back);setPhase('on');apply(0,0,true);
      message('Tilt toward the edge you want the jelly to slide to.');return;
    }
    apply(...screenTilt(down,neutral,currentAngle));
  }
  function listen(){
    detach();setPhase('waiting');apply(0,0,true);
    if(document.hidden)return;
    message('Hold your phone at a comfortable angle.');
    window.addEventListener(source.event,read);
    waitingTimer=setTimeout(()=>stop('No tilt readings. Try opening the playground directly in your phone browser.'),5000);
  }
  button.addEventListener('click',async()=>{
    if(phase!=='off'){stop();return}
    if(!window.isSecureContext){message('Open the HTTPS playground to use phone tilt.');return}
    source=window.DeviceOrientationEvent?{api:window.DeviceOrientationEvent,event:'deviceorientation'}:
      window.DeviceMotionEvent?{api:window.DeviceMotionEvent,event:'devicemotion'}:null;
    if(!source){message('Tilt gravity needs a phone or tablet with motion sensors.');return}
    const attempt=++generation;setPhase('requesting');
    try{
      // Safari requires this call in the original tap, before any other await.
      const permission=source.api.requestPermission?await source.api.requestPermission():'granted';
      if(attempt!==generation)return;
      if(permission!=='granted'){stop('Motion access is off. Allow it in your browser to use tilt gravity.');return}
      listen();
    }catch{if(attempt===generation)stop('Could not start tilt gravity. Check motion access in your browser.')}
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
