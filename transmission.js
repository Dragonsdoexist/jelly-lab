import * as T from './vendor/three.module.min.js';

// Capture the camera-facing exit surface. A second interface gives slim strokes,
// deep cores, and the back of every cutout different optical path lengths.
const vertex=`
uniform mat3 worldNormalMatrix;
uniform float centerDepth, span;
varying vec3 point, nWorld;
varying float depth;
void main(){
  vec4 world=modelMatrix*vec4(position,1.);
  point=world.xyz;nWorld=worldNormalMatrix*normal;
  vec4 eye=viewMatrix*world;depth=(-eye.z-centerDepth)/span;
  gl_Position=projectionMatrix*eye;
}`;
const oct=`
vec2 signs(vec2 v){return vec2(v.x<0.?-1.:1.,v.y<0.?-1.:1.);}
vec2 packN(vec3 v){v/=abs(v.x)+abs(v.y)+abs(v.z);return (v.z<0.?(1.-abs(v.yx))*signs(v.xy):v.xy)*.5+.5;}
vec3 unpackN(vec2 p){p=p*2.-1.;vec3 v=vec3(p,1.-abs(p.x)-abs(p.y));if(v.z<0.)v.xy=(1.-abs(v.yx))*signs(v.xy);return normalize(v);}
`;
// Dedicated camera-space tiles isolate rear normals and depths even when
// several solids and membranes occupy the same screen pixel.
const atlasVertex=vertex.replace('uniform mat3 worldNormalMatrix;',
  'uniform vec4 crop,tile; varying vec2 cropUV; uniform mat3 worldNormalMatrix;')
  .replace('gl_Position=projectionMatrix*eye;',`
    vec4 clip=projectionMatrix*eye;
    cropUV=((clip.xy/clip.w*.5+.5)-crop.xy)/crop.zw;
    gl_Position=vec4(((cropUV*tile.zw+tile.xy)*2.-1.)*clip.w,clip.zw);`);
const back=`
varying vec3 nWorld;varying vec2 cropUV;varying float depth;
`+oct+`
void main(){
  if(any(lessThan(cropUV,vec2(0.)))||any(greaterThan(cropUV,vec2(1.))))discard;
  // Two depth channels retain the optical path of a thin squashed film
  // on devices using an 8-bit capture texture.
  float packedDepth=clamp(depth*.45+.5,.001,.999)*255.;
  gl_FragColor=vec4(packN(normalize(nWorld)),floor(packedDepth)/255.,fract(packedDepth));
}
`;
const glass=`
uniform sampler2D exits,backdrop;
uniform mat4 viewProjection;
uniform vec3 incident,dye,keyDir;
uniform vec4 bubbles[12];
uniform vec4 tile,crop;
uniform float film,span,centerDepth,modelSize;
varying vec3 point,nWorld;
varying float depth;
`+oct+`
vec2 screen(vec3 p){vec4 projected=viewProjection*vec4(p,1.);return projected.xy/projected.w*.5+.5;}
float panel(vec3 ray,vec3 towards,vec2 dimensions){
  vec3 t=normalize(towards);float f=dot(ray,t);if(f<.15)return 0.;
  vec3 right=normalize(vec3(t.z,0.,-t.x)),up=cross(t,right);
  vec2 uv=abs(vec2(dot(ray,right),dot(ray,up)))/f/dimensions;
  return 1.-smoothstep(.82,1.10,max(uv.x,uv.y));
}
vec3 environment(vec3 dir){
  float down=1.-smoothstep(-.6,.15,dir.y);
  vec3 light=mix(vec3(.61,.63,.67),vec3(.98),down);
  float flag=panel(dir,vec3(.90,.05,.5),vec2(.49,.66))+.72*panel(dir,vec3(-.93,.12,-.22),vec2(.30,.63));
  light*=1.-.85*clamp(flag,0.,1.);
  light+=vec3(3.5)*panel(dir,vec3(-.63,.62,.46),vec2(.34,.092));
  light+=vec3(2.6)*panel(dir,vec3(.58,.48,.66),vec2(.073,.43));
  light+=vec3(2.)*panel(dir,vec3(.07,.74,-.66),vec2(.54,.085));
  light+=vec3(1.0)*pow(max(dot(dir,keyDir),0.),45.);
  return light;
}
vec3 environmentOrFloor(vec3 origin,vec3 dir){
  vec3 env=environment(dir);
  if(dir.y>=-.025)return env;
  float travel=max(.0,origin.y)/-dir.y;
  vec2 uv=screen(origin+dir*travel);
  float inside=smoothstep(0.,.035,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)));
  return mix(env,texture2D(backdrop,clamp(uv,0.,1.)).rgb,inside*smoothstep(.025,.21,-dir.y));
}
void main(){
  vec3 n=normalize(nWorld),I=normalize(incident);if(dot(n,I)>0.)n=-n;
  vec3 inner=refract(I,n,1./1.36);
  vec2 uv=screen(point);
  float frontZ=centerDepth+depth*span;
  float path=mix(.17,.026,film)*modelSize;
  vec3 outN=normalize(I*.87-n*.13);
  for(int stepIndex=0;stepIndex<3;stepIndex++){
    vec2 local=(uv-crop.xy)/crop.zw;
    if(any(lessThan(local,vec2(0.)))||any(greaterThan(local,vec2(1.))))break;
    vec4 exitSample=texture2D(exits,tile.xy+local*tile.zw);
    bool valid=exitSample.b>.22;
    float z=centerDepth+(exitSample.b+exitSample.a/255.-.5)*span/.45;
    if(!valid||z<frontZ+.0002*modelSize)break;
    float proposal=clamp((z-frontZ)/max(.30,dot(inner,I)),.001*modelSize,span);
    path=stepIndex==0?proposal:mix(path,proposal,.62);
    outN=unpackN(exitSample.rg);
    uv=screen(point+inner*path);
  }
  outN=normalize(mix(outN,inner,.68*(1.-smoothstep(-.12,.16,dot(outN,inner)))));
  vec3 exitPoint=point+inner*path;
  vec3 outDir=refract(inner,-outN,1.36);
  bool tir=dot(outDir,outDir)<.01;
  vec3 innerReflection=reflect(inner,-outN);
  vec3 through=tir?environmentOrFloor(exitPoint,innerReflection):environmentOrFloor(exitPoint,outDir);
  float transmittedCos=tir?0.:clamp(dot(outDir,outN),0.,1.);
  float rearF=.024+.976*pow(1.-transmittedCos,5.);
  vec3 rearGlow=environment(innerReflection);
  through=mix(through,environmentOrFloor(exitPoint,innerReflection),rearF);
  through+=max(vec3(0.),rearGlow-vec3(1.))*.06;
  // A thin, nearly clear sheet transmits the scene behind it. Preserve the
  // substrate at normal incidence; grazing angles reveal the meniscus.
  float facing=max(.0,dot(-I,n));
  if(film>.5){
    vec3 substrate=texture2D(backdrop,screen(point)).rgb;
    through=mix(substrate,through,.18+.56*pow(1.-facing,1.4));
  }
  // Beer-Lambert absorption preserves clear thin edges and saturated deep sections.
  float opticalDepth=(.15+1.22*path/modelSize)*(1.+.23*rearF);
  vec3 absorption=pow(clamp(dye,vec3(.010),vec3(.99)),vec3(opticalDepth));
  vec3 liquid=through*absorption;
  float f0=mix(.041,.023,film);
  float fresnel=f0+(1.-f0)*pow(1.-facing,4.);
  vec3 refl=environment(reflect(I,n));
  vec3 color=mix(liquid,refl,fresnel);
  // The wet gel surface catches the softboxes before light reaches the dye.
  color+=max(vec3(0.),refl-vec3(.90))*(.075+.10*(1.-facing));
  color+=dye*.028*(1.-film);
  if(film>.5){
    float meniscus=pow(1.-facing,1.25);
    color*=mix(vec3(1.),vec3(.79,.93,.96),.41*meniscus);
    color+=max(vec3(0.),refl-vec3(.88))*(.035+.065*meniscus);
  }
  // Air inclusions sit inside the volume and are seen along the refracted ray.
  for(int i=0;i<12;i++){
    if(film>.5)break;
    vec3 delta=bubbles[i].xyz-point;float along=dot(delta,inner),r=bubbles[i].w;
    if(along<0.||along>path)continue;
    vec3 across=delta-inner*along;float radius=length(across)/r;
    if(radius>=1.)continue;
    vec3 bubbleN=normalize(-across/r-inner*sqrt(max(0.,1.-radius*radius)));
    float edge=smoothstep(.63,.96,radius),shine=pow(max(0.,dot(reflect(inner,bubbleN),keyDir)),12.);
    color=mix(color,color*.61+vec3(.21)*max(bubbleN.y,0.),edge*.72);
    color+=vec3(.56)*shine*(1.-smoothstep(.86,1.,radius));
  }
  gl_FragColor=vec4(color,1.);
  #include <colorspace_fragment>
}`;

const copyVertex=`
  varying vec2 uvScreen;
  void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.,1.);}
`;
const copyFragment=`
  uniform sampler2D previousColor,previousDepth;
  varying vec2 uvScreen;
  void main(){
    gl_FragDepth=texture2D(previousDepth,uvScreen).r;
    gl_FragColor=vec4(texture2D(previousColor,uvScreen).rgb,1.);
    #include <colorspace_fragment>
  }
`;

export function createTransmission(renderer,scene,camera){
  const target=(depth=false)=>new T.WebGLRenderTarget(1,1,{
    minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:true,generateMipmaps:false,
    depthTexture:depth?new T.DepthTexture(1,1,T.UnsignedIntType):null
  });
  const touch=globalThis.matchMedia?.('(pointer: coarse)');
  let mobileLoad=0;
  const exits=target();
  if(renderer.extensions.has('EXT_color_buffer_float'))exits.texture.type=T.HalfFloatType;
  const paper=target(true),buffers=[target(true),target(true)];
  const direction=new T.Vector3(),vp=new T.Matrix4(),key=new T.Vector3(),eye=new T.Vector3(),bubbleNormal=new T.Vector3();
  const dims=new T.Vector2(),savedColor=new T.Color();
  const clearDye=new T.Color(.945,.987,.995);
  const capture=new T.Scene(),surfaces=new T.Scene(),copyScene=new T.Scene();
  const copy=new T.ShaderMaterial({
    uniforms:{previousColor:{value:paper.texture},previousDepth:{value:paper.depthTexture}},
    vertexShader:copyVertex,fragmentShader:copyFragment,depthFunc:T.AlwaysDepth,depthWrite:true,
    toneMapped:false,blending:T.NoBlending
  });
  const quad=new T.Mesh(new T.PlaneGeometry(2,2),copy);
  quad.frustumCulled=false;copyScene.add(quad);
  const list=[],owners=[];
  let dirty=true,lastFloor=-1,studioFloor=null,lastExitTime=-Infinity,exitPending=false;
  const lastVP=new T.Matrix4(),lastKey=new T.Vector3(),lastDims=new T.Vector2();
  const remove=e=>{
    capture.remove(e.back);surfaces.remove(e.surface);
    e.back.material.dispose();e.surface.material.dispose();
  };

  function createPart(b,mesh,film){
    const seed=[...String(b.id||mesh.id)].reduce((v,c)=>(v*33+c.charCodeAt(0))>>>0,17);
    const bubbles=film?[]:Array.from({length:12},(_,j)=>{
      const vertexId=(j*811+seed+71)%mesh.geometry.attributes.position.count;
      const radius=.011+.018*((j*71+3)%13)/12;
      return {vertexId,radius};
    });
    const uniforms={
      bubbles:{value:Array.from({length:12},()=>new T.Vector4())},worldNormalMatrix:{value:new T.Matrix3()},
      crop:{value:new T.Vector4()},tile:{value:new T.Vector4()},span:{value:1},centerDepth:{value:25},
      film:{value:film?1:0},modelSize:{value:1},exits:{value:exits.texture},backdrop:{value:paper.texture},
      viewProjection:{value:vp},incident:{value:direction},dye:{value:film?clearDye:b.color},keyDir:{value:key}
    };
    const rear=new T.Mesh(mesh.geometry,new T.ShaderMaterial({
      vertexShader:atlasVertex,fragmentShader:back,uniforms,side:T.BackSide,toneMapped:false,blending:T.NoBlending
    }));
    const optical=new T.Mesh(mesh.geometry,new T.ShaderMaterial({
      vertexShader:vertex,fragmentShader:glass,uniforms,toneMapped:false,blending:T.NoBlending
    }));
    for(const proxy of [rear,optical]){
      proxy.matrixAutoUpdate=false;proxy.matrixWorldAutoUpdate=false;proxy.frustumCulled=false;
    }
    capture.add(rear);surfaces.add(optical);
    return {b,mesh,film,back:rear,surface:optical,u:uniforms,bubbles,center:new T.Vector3(),rect:new T.Vector4(),
      radius:0,positionVersion:-1,normalVersion:-1,sourceColor:new T.Color()};
  }

  function setBodies(bodies){
    const parts=[];
    for(const b of bodies){
      parts.push([b,b.mesh,false]);
      if(b.filler)parts.push([b,b.filler,true]);
    }
    if(parts.length===list.length&&parts.every(([b,m],i)=>list[i].b===b&&list[i].mesh===m))return;
    const old=new Map(list.map(e=>[e.mesh,e]));
    list.length=0;owners.length=0;
    const cols=Math.max(1,Math.ceil(Math.sqrt(parts.length))),rows=Math.max(1,Math.ceil(parts.length/cols));
    mobileLoad=touch?.matches?bodies.length:0;
    const tileRes=mobileLoad>14?112:mobileLoad>6?160:parts.length<=6?256:parts.length<=15?224:192;
    exits.setSize(cols*tileRes,rows*tileRes);
    for(const [i,[b,m,film]] of parts.entries()){
      const e=old.get(m)??createPart(b,m,film);
      old.delete(m);e.b=b;e.u.dye.value=film?clearDye:b.color;
      e.u.tile.value.set((i%cols)/cols,Math.floor(i/cols)/rows,1/cols,1/rows);
      list.push(e);if(!film)owners.push({mesh:b.mesh,visible:b.mesh.visible});
    }
    for(const e of old.values())remove(e);
    dirty=true;
  }

  function updatePart(e){
    const {b,mesh:m,u}=e,g=m.geometry;
    e.back.geometry=g;e.surface.geometry=g;
    e.back.matrixWorld.copy(m.matrixWorld);e.surface.matrixWorld.copy(m.matrixWorld);
    u.worldNormalMatrix.value.getNormalMatrix(m.matrixWorld);
    if(!g.boundingSphere)g.computeBoundingSphere();
    if(!g.boundingBox)g.computeBoundingBox();
    e.radius=Math.max(.01,g.boundingSphere.radius*m.matrixWorld.getMaxScaleOnAxis());
    e.center.copy(g.boundingSphere.center).applyMatrix4(m.matrixWorld);
    u.centerDepth.value=-eye.copy(e.center).applyMatrix4(camera.matrixWorldInverse).z;
    // Fit the exit atlas and overlap test to the current skinned bounds.
    // A collapsed or deeply sagging sheet can occupy a slim screen rectangle.
    const box=g.boundingBox,r=e.rect;
    r.set(Infinity,Infinity,-Infinity,-Infinity);
    for(let i=0;i<8;i++){
      eye.set(i&1?box.max.x:box.min.x,i&2?box.max.y:box.min.y,i&4?box.max.z:box.min.z);
      eye.applyMatrix4(m.matrixWorld).project(camera);
      r.x=Math.min(r.x,eye.x);r.y=Math.min(r.y,eye.y);r.z=Math.max(r.z,eye.x);r.w=Math.max(r.w,eye.y);
    }
    eye.copy(e.center).project(camera);
    const rx=e.radius*camera.projectionMatrix.elements[0],ry=e.radius*camera.projectionMatrix.elements[5];
    r.x=Math.max(r.x,eye.x-rx);r.z=Math.min(r.z,eye.x+rx);
    r.y=Math.max(r.y,eye.y-ry);r.w=Math.min(r.w,eye.y+ry);
    const w=Math.max(.0001,(r.z-r.x)*.515),h=Math.max(.0001,(r.w-r.y)*.515);
    u.crop.value.set((r.x+r.z)*.25+.5-w*.5,(r.y+r.w)*.25+.5-h*.5,w,h);
    const position=g.attributes.position,normal=g.attributes.normal;
    e.bubbles.forEach(({vertexId,radius},i)=>{
      // Each trapped bubble follows its own material vertex on the deformed
      // surface. Inset along its current world normal, including model scale.
      const index=vertexId%position.count;
      eye.fromBufferAttribute(position,index).applyMatrix4(m.matrixWorld);
      bubbleNormal.fromBufferAttribute(normal,index).normalize().applyMatrix3(u.worldNormalMatrix.value);
      const inverseScale=Math.max(.0001,bubbleNormal.length()),worldRadius=radius/inverseScale;
      eye.addScaledVector(bubbleNormal,-1.75*worldRadius/inverseScale);
      u.bubbles.value[i].set(eye.x,eye.y,eye.z,worldRadius);
    });
    u.span.value=2.2*e.radius;u.modelSize.value=b.size;
    e.positionVersion=position.version;e.normalVersion=normal.version;
    e.sourceColor.copy(u.dye.value);
  }

  function layersByDepth(){
    const sorted=[...list].sort((a,b)=>b.u.centerDepth.value-a.u.centerDepth.value||Number(a.film)-Number(b.film));
    const groups=[];
    for(const e of sorted){
      let rank=0;
      for(const [i,group] of groups.entries()){
        if(group.some(f=>e.rect.x<f.rect.z&&e.rect.z>f.rect.x&&e.rect.y<f.rect.w&&e.rect.w>f.rect.y))rank=i+1;
      }
      (groups[rank]??=[]).push(e);
    }
    return groups;
  }

  function draw(lightDirection){
    renderer.getDrawingBufferSize(dims);camera.updateMatrixWorld();
    vp.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    if(!studioFloor)studioFloor=scene.getObjectByName('White studio floor');
    const floorRev=studioFloor?.userData.opticsRevision||0;
    const cameraChanged=dirty||!lastVP.equals(vp)||!lastDims.equals(dims);
    const floorChanged=cameraChanged||lastFloor!==floorRev;
    let shapeChanged=cameraChanged,dyeChanged=false;
    for(const e of list){
      const {mesh:m,b}=e;m.updateWorldMatrix(true,false);
      e.moved=cameraChanged||!m.matrixWorld.equals(e.surface.matrixWorld)||e.surface.geometry!==m.geometry||
        e.positionVersion!==m.geometry.attributes.position.version||e.normalVersion!==m.geometry.attributes.normal.version||
        e.u.modelSize.value!==b.size;
      shapeChanged||=e.moved;dyeChanged||=!e.sourceColor.equals(e.u.dye.value);
    }
    const now=performance.now();
    // In a crowded pocket-size viewport the small internal reflections can
    // reuse one rear capture while all front surfaces keep moving every frame.
    const captureDue=mobileLoad<=14||now-lastExitTime>=1000/25;
    const captureExits=cameraChanged||((shapeChanged||exitPending)&&captureDue);
    if(!shapeChanged&&!dyeChanged&&!floorChanged&&lastKey.equals(lightDirection)&&!captureExits)return false;
    const requestedMeshes=list.length;
    const scale=mobileLoad>14?.71:mobileLoad>6?.83:requestedMeshes>16?.82:.94;
    const w=Math.max(2,Math.round(dims.x*scale)),h=Math.max(2,Math.round(dims.y*scale));
    paper.setSize(w,h);for(const buffer of buffers)buffer.setSize(w,h);
    camera.getWorldDirection(direction);key.copy(lightDirection);
    const output=renderer.getRenderTarget(),cube=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const previousAuto=renderer.autoClear,previousAlpha=renderer.getClearAlpha();
    renderer.getClearColor(savedColor);
    try{
      if(!requestedMeshes){
        renderer.autoClear=true;renderer.render(scene,camera);
      }else{
        for(const e of list){
          if(e.moved)updatePart(e);
          else if(dyeChanged)e.sourceColor.copy(e.u.dye.value);
        }
        renderer.autoClear=true;
        if(captureExits){
          renderer.setRenderTarget(exits);renderer.setClearColor(0,0);renderer.render(capture,camera);
          lastExitTime=now;exitPending=false;
        }else if(shapeChanged)exitPending=true;
        // The paper target contains the receiver and its depth. Their pixels
        // stay valid between new caustic fields while the camera is fixed.
        if(floorChanged||!studioFloor){
          for(const o of owners){o.visible=o.mesh.visible;o.mesh.visible=false;}
          try{
            renderer.setClearColor(savedColor,previousAlpha);renderer.setRenderTarget(paper);renderer.render(scene,camera);
          }finally{for(const o of owners)o.mesh.visible=o.visible;}
        }
        const groups=layersByDepth();
        for(const e of list)e.surface.visible=false;
        renderer.autoClear=false;
        let previous=paper;
        for(const [i,group] of groups.entries()){
          const last=i===groups.length-1;
          const current=last?output:buffers[i%2];
          renderer.setRenderTarget(current,last?cube:0,last?mip:0);
          copy.uniforms.previousColor.value=previous.texture;copy.uniforms.previousDepth.value=previous.depthTexture;
          renderer.render(copyScene,camera);
          for(const e of group){e.u.backdrop.value=previous.texture;e.surface.visible=true;}
          renderer.render(surfaces,camera);
          for(const e of group)e.surface.visible=false;
          previous=current;
        }
      }
    }finally{
      renderer.setRenderTarget(output,cube,mip);renderer.setClearColor(savedColor,previousAlpha);renderer.autoClear=previousAuto;
    }
    lastVP.copy(vp);lastKey.copy(lightDirection);lastDims.copy(dims);lastFloor=floorRev;dirty=false;
    return true;
  }

  function dispose(){
    for(const e of list)remove(e);
    list.length=0;owners.length=0;exits.dispose();paper.dispose();
    for(const target of buffers)target.dispose();
    quad.geometry.dispose();copy.dispose();
  }
  return {setBodies,draw,dispose};
}
