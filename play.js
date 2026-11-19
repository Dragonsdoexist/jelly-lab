import { companies,palette } from './sculpture.js';
import {connectSoftness} from './softness-dial.js';
import {connectTilt} from './phone-tilt.js';
import { Studio } from './studio.js';

const $=selector=>document.querySelector(selector);
const all=selector=>[...document.querySelectorAll(selector)];
const tank=$('#tank'),canvas=$('#surfaces'),frame=$('#play-frame'),loading=$('#loading'),help=$('#instructions'),menu=$('#logo-menu');
const selectionKey='jelly-lab.studio-logos.v1',library=new Map(companies.map(c=>[c[0],c]));
function loadSelection(){
  try{const saved=JSON.parse(localStorage.getItem(selectionKey));if(Array.isArray(saved))return new Set(saved.filter(id=>library.has(id)))}catch{}
  return new Set(companies.slice(0,6).map(c=>c[0]));
}
const selected=loadSelection(),buttons=new Map();
let studio,request=0,sound=false,context,lastTone=-1,failed3D=false;
const status=text=>{$('#status').textContent=text};
function tone(pitch,volume){
  if(!sound||context?.state!=='running')return;
  const now=context.currentTime;if(now-lastTone<.07)return;lastTone=now;
  const o=context.createOscillator(),gain=context.createGain();
  o.frequency.setValueAtTime(pitch*1.54,now);o.frequency.exponentialRampToValueAtTime(pitch*.60,now+.14);
  gain.gain.setValueAtTime(.001,now);gain.gain.exponentialRampToValueAtTime(Math.max(.002,Math.min(.12,volume*.12)),now+.012);gain.gain.exponentialRampToValueAtTime(.001,now+.20);
  o.connect(gain);gain.connect(context.destination);o.start(now);o.stop(now+.21);o.onended=()=>{o.disconnect();gain.disconnect()};
}
function setAngle(value){$('#light-angle').value=value;$('#light-value').value=value+'°';studio?.lightAngle(Number(value))}
function setMode(mode){
  studio?.setMode(mode);tank.dataset.mode=mode;all('.tools button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  $('#hint').textContent={grab:'Drag a logo over another and release to stack them.',turn:'Drag a sculpture to turn it. Release to let it settle.',attract:'Hold on the floor to draw nearby sculptures toward you.',repel:'Hold on the floor to push nearby sculptures away.'}[mode];
}
function stills(entries){
  let sheet=$('#fallback');if(!sheet){sheet=document.createElement('div');sheet.id='fallback';tank.append(sheet)}
  const cols=tank.clientWidth<630?2:Math.min(6,Math.max(3,Math.ceil(Math.sqrt(entries.length*1.5))));
  sheet.style.gridTemplateColumns='repeat('+cols+',minmax(0,1fr))';sheet.style.gridTemplateRows='repeat('+Math.max(1,Math.ceil(entries.length/cols))+',minmax(60px,1fr))';
  sheet.replaceChildren(...entries.map(([id,name])=>{const fig=document.createElement('figure'),img=document.createElement('img'),label=document.createElement('figcaption');img.src='previews/'+id+'.webp';img.alt=name+' translucent sculpture';label.textContent=name;fig.append(img,label);return fig}));
  canvas.hidden=true;$('#bodies').hidden=true;
  for(const el of [...all('.tools button'),$('#light-angle'),$('#softness-dial'),$('#shake'),$('#tilt-gravity')])el.disabled=true;
  $('#hint').textContent='Studio renders are shown here. Interactive 3D requires WebGL 2.';
}
function menuState(){
  const count=selected.size;$('#active-count').textContent=count;$('#menu-count').textContent=count+' of '+companies.length+' in studio';
  $('#add-all').disabled=count===companies.length;$('#remove-all').disabled=count===0;
  for(const [id,b] of buttons){
    const on=selected.has(id);b.setAttribute('aria-pressed',String(on));b.setAttribute('aria-label',(on?'Remove ':'Add ')+library.get(id)[1]);b.querySelector('.choice').textContent=on?'✓':'+';
  }
}
async function applySelection(reset=false){
  const serial=++request,ids=[...selected],entries=ids.map(id=>library.get(id));menuState();
  $('#empty-studio').hidden=entries.length>0;
  try{
    if(failed3D)stills(entries);else{
      loading.hidden=studio.bodies.length>0||!entries.length;
      if(!loading.hidden)loading.textContent='Opening the studio…';
      await studio.select(entries,{reset});if(serial!==request)return;
    }
    loading.hidden=true;try{localStorage.setItem(selectionKey,JSON.stringify(ids))}catch{}
    status(entries.length+' sculptures in the studio.');
  }catch(error){
    if(serial!==request)return;console.error(error);loading.hidden=false;loading.replaceChildren('The selection could not load. ');
    const b=document.createElement('button');b.textContent='Try again';b.onclick=()=>applySelection(reset);loading.append(b);status('Could not load the selected logos.');
  }
}
function filter(){
  const term=$('#logo-search').value.toLowerCase().trim();let found=0;
  for(const [id,b] of buttons){const entry=library.get(id);b.hidden=!(entry[1]+' '+id).toLowerCase().includes(term);if(!b.hidden)found++}
  $('#no-results').hidden=!!found;
}
function openMenu(){
  studio?.cancelHands();$('#logo-search').value='';filter();menuState();if(!menu.open)menu.showModal();$('#collection-link').classList.add('menu-open');
}
for(const [id,name,style] of companies){
  const b=document.createElement('button');b.className='catalog-item';b.style.setProperty('--dot',palette[style]);
  b.innerHTML='<img loading="lazy" class="preview" src="previews/'+id+'.webp" alt=""><span>'+name+'</span><span class="choice" aria-hidden="true"></span>';
  b.onclick=()=>{if(selected.has(id))selected.delete(id);else selected.add(id);applySelection()};buttons.set(id,b);$('#catalog').append(b);
}
$('#add-all').onclick=()=>{for(const [id] of companies)selected.add(id);applySelection()};
$('#remove-all').onclick=()=>{selected.clear();applySelection()};
$('#logo-search').oninput=filter;
for(const el of ['#collection-link','#manage-logos','#empty-choose'])$(el).onclick=openMenu;
for(const el of ['#close-menu','#menu-done'])$(el).onclick=()=>menu.close();
menu.addEventListener('close',()=>$('#collection-link').classList.remove('menu-open'));
$('#playground-link').onclick=()=>window.scrollTo(0,0);
$('.brand').onclick=e=>{e.preventDefault();window.scrollTo(0,0)};
$('#shake').onclick=()=>{studio?.shake();status('Studio shaken')};
$('#light-angle').oninput=e=>setAngle(e.target.value);
$('#reset').onclick=()=>{setAngle(225);setMode('grab');applySelection(true)};
all('.tools button').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
function expand(value){
  frame.classList.toggle('expanded',value);document.body.classList.toggle('expanded',value);$('#expand').setAttribute('aria-pressed',String(value));
  $('#expand').setAttribute('aria-label',value?'Exit expanded studio':'Expand studio');studio?.resize();if(!value)$('#expand').focus();
}
$('#expand').onclick=()=>expand(!frame.classList.contains('expanded'));
$('#help').onclick=()=>{help.showModal();studio?.setPaused(true)};$('#close-help').onclick=()=>help.close();help.addEventListener('close',()=>{if(!failed3D)studio?.setPaused(false)});
for(const dlg of [help,menu])dlg.addEventListener('click',e=>{if(e.target===dlg){const r=dlg.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dlg.close()}});
$('#sound').onclick=async()=>{
  if(!sound){try{context??=new (window.AudioContext||window.webkitAudioContext)();await context.resume()}catch{status('Audio unavailable on this browser');return}}
  sound=!sound;$('#sound').setAttribute('aria-pressed',String(sound));$('#sound span').textContent=sound?'Sound on':'Sound off';$('#sound use').setAttribute('href',sound?'#i-audio-on':'#i-audio-off');if(sound)tone(270,.6);
};
document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey||help.open||menu.open)return;
  if(e.key==='Escape'&&frame.classList.contains('expanded'))expand(false);if(e.key.toLowerCase()==='s'&&!e.repeat&&!failed3D){e.preventDefault();studio.shake()}
});
function fallback(){stopTilt();failed3D=true;studio?.setPaused(true);applySelection()}
try{studio=new Studio(tank,canvas,tone)}catch(e){console.warn('Interactive renderer unavailable.',e.message);failed3D=true}
const stopTilt=connectTilt($('#tilt-gravity'),$('#tilt-status'),(x,y,immediate)=>studio?.setTilt(x,y,immediate));
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();fallback()});canvas.addEventListener('webglcontextrestored',()=>location.reload());
connectSoftness($('#softness-dial'),$('#softness-value'),s=>studio?.setSoftness(s));
setMode('grab');applySelection();
