const key='jelly-lab.softness.v1';
const clamp=n=>Math.max(0,Math.min(100,Math.round(n)));
export function connectSoftness(dial,output,change){
  let value=72,drag;
  try{const saved=localStorage.getItem(key);if(saved!==null&&Number.isFinite(Number(saved)))value=clamp(Number(saved))}catch{}
  function set(next,save=true){
    value=clamp(next);dial.style.setProperty('--sweep',value*2.7+'deg');
    dial.setAttribute('aria-valuenow',value);dial.setAttribute('aria-valuetext',value+' percent softness');
    output.textContent=value+'%';change(value/100);
    if(save){try{localStorage.setItem(key,String(value))}catch{}}
  }
  function angle(x,y){return Math.atan2(x-drag.cx,drag.cy-y)*180/Math.PI}
  dial.addEventListener('pointerdown',e=>{
    if(e.button!==0||drag||dial.disabled)return;
    e.preventDefault();dial.focus({preventScroll:true});dial.setPointerCapture(e.pointerId);
    const r=dial.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    drag={id:e.pointerId,cx,cy,x:e.clientX,y:e.clientY,start:value,delta:0,round:Math.hypot(e.clientX-cx,e.clientY-cy)>r.width*.23};
    drag.a=angle(e.clientX,e.clientY);dial.classList.add('turning');
  });
  dial.addEventListener('pointermove',e=>{
    if(drag?.id!==e.pointerId)return;
    if(drag.round){
      const a=angle(e.clientX,e.clientY);drag.delta+=((a-drag.a+540)%360)-180;drag.a=a;
      set(drag.start+drag.delta/2.7);
    }else set(drag.start+(drag.y-e.clientY+(e.clientX-drag.x)*.4)*.8);
  });
  function end(e){
    if(drag?.id!==e.pointerId)return;
    if(e.type==='pointerup'&&drag.round&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<3)set((angle(e.clientX,e.clientY)+135)/2.7);
    drag=null;dial.classList.remove('turning');if(dial.hasPointerCapture(e.pointerId))dial.releasePointerCapture(e.pointerId);
  }
  for(const event of ['pointerup','pointercancel','lostpointercapture'])dial.addEventListener(event,end);
  dial.addEventListener('keydown',e=>{
    const delta={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1,PageUp:10,PageDown:-10}[e.key];
    if(delta===undefined&&e.key!=='Home'&&e.key!=='End')return;
    e.preventDefault();set(e.key==='Home'?0:e.key==='End'?100:value+delta*(e.shiftKey?5:1));
  });
  set(value,false);
}
