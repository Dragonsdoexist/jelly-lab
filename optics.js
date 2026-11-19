import * as THREE from './vendor/three.module.min.js';

// Each atlas tile records the first entrance and exit seen from the studio lamp.
// The ray pass samples both surfaces and splats the transmitted flux onto the floor.
const TILE = 144;
const CONTACT_SLOTS = 24;

const surfaceVertex = `
  uniform vec3 center, toLight, right, up;
  uniform float span;
  uniform vec4 tile;
  uniform mat3 worldNormals;
  varying vec3 n;
  varying float d;
  void main() {
    vec3 p = (modelMatrix * vec4(position,1.)).xyz - center;
    vec2 local = vec2(dot(p,right),dot(p,up)) / span;
    d = dot(p,toLight)/span;
    n = worldNormals * normal;
    // Orthographic projection into just this model's atlas tile.
    gl_Position = vec4((local*.5+.5)*tile.xy*2.+tile.zw*2.-1., -d, 1.);
  }
`;
const surfaceFragment = `
  varying vec3 n;
  varying float d;
  vec2 signNotZero(vec2 p){return vec2(p.x>=0.?1.:-1.,p.y>=0.?1.:-1.);}
  void main(){
    vec3 unit = normalize(n);
    vec2 oct = unit.xy/(abs(unit.x)+abs(unit.y)+abs(unit.z));
    if(unit.z < 0.) oct = (1.-abs(oct.yx))*signNotZero(oct);
    float depthValue = clamp(d*.48+.5,.001,.999)*255.;
    gl_FragColor = vec4(oct*.5+.5, floor(depthValue)/255., fract(depthValue));
  }
`;
const photonVertex = `
  uniform sampler2D entrance, exitSurface;
  uniform vec3 center, toLight, right, up, dye;
  uniform vec4 tile;
  uniform vec2 worldExtent, mapPixels;
  uniform float span, samplesPerAxis, film;
  attribute float bent;
  varying vec4 flux;
  vec2 signNotZero(vec2 p){return vec2(p.x>=0.?1.:-1.,p.y>=0.?1.:-1.);}
  vec3 normalFrom(vec4 s){
    vec2 o = s.xy*2.-1.;
    vec3 n = vec3(o,1.-abs(o.x)-abs(o.y));
    if(n.z<0.) n.xy=(1.-abs(n.yx))*signNotZero(n.xy);
    return normalize(n);
  }
  float depthFrom(vec4 s) { return ((s.b+s.a/255.)-.5)*span/.48; }
  vec4 backAt(vec2 uv){return texture2D(exitSurface,clamp(uv,vec2(.0035),vec2(.9965))*tile.xy+tile.zw);}
  bool exists(vec4 sampleValue){return sampleValue.b > .001;}
  void main(){
    vec2 uv = position.xy;
    gl_Position=vec4(2.,2.,2.,1.);
    gl_PointSize=1.;
    flux=vec4(0.);
    vec4 front = texture2D(entrance,uv*tile.xy+tile.zw);
    vec4 back = backAt(uv);
    if(!exists(front)||!exists(back)) return;
    vec3 nIn=normalFrom(front);
    float facing=dot(nIn,toLight);
    if(facing < .015) return;
    float nearDepth=depthFrom(front),farDepth=depthFrom(back);
    float gap=nearDepth-farDepth;
    if(gap <= .0001) return;
    vec3 entry=center+(right*(uv.x*2.-1.)+up*(uv.y*2.-1.))*span+toLight*nearDepth;
    vec3 incident=-toLight;
    vec3 inside=refract(incident,nIn,1./1.36);
    float forward=max(.28,dot(inside,incident));
    float path=gap/forward;
    vec3 straightHit=entry+incident*(max(0.,entry.y)/max(.16,toLight.y));
    vec2 floorHit=straightHit.xz;
    float density=clamp(path/span,.025,1.6);
    vec3 transmission=pow(max(dye,vec3(.001)),vec3(.33+.5*density));
    // Grid rays carry equal flux in the plane perpendicular to the lamp.
    float energy=4.*span*span*mapPixels.x*mapPixels.y /
                 ((samplesPerAxis*samplesPerAxis)*worldExtent.x*worldExtent.y*max(.16,toLight.y));
    float samplesAcross=2.*span/samplesPerAxis*max(mapPixels.x/worldExtent.x,mapPixels.y/worldExtent.y);
    float footprint=clamp(samplesAcross*2.4, 3.5, 16.);
    vec4 contribution;
    if(bent < .5){
      // Unbent rays delimit the shadow of the actual silhouette. Forward
      // scattering returns some dyed light within that footprint.
      contribution=vec4(transmission*.40, .86);
      footprint*=1.55;
    }else if(bent < 1.5){
      // A forward-scattered lobe leaves the volume with smoother angular
      // spread than the fully ballistic component. Its focal bands stay
      // close to the shadow of a thick, translucent piece.
      vec3 emerging=normalize(mix(incident,inside,.82));
      vec3 lobeHit=entry+emerging*max(.008,entry.y)/max(.18,-emerging.y);
      floorHit=lobeHit.xz;
      contribution=vec4(transmission*.53,0.);
      footprint*=1.58;
    }else{
      // Refine the exit estimate along the bent internal path.
      vec2 displacement=vec2(dot(inside,right),dot(inside,up));
      vec2 uvExit=uv+displacement*(path/(2.*span));
      if(any(lessThan(uvExit,vec2(.0035)))||any(greaterThan(uvExit,vec2(.9965))))return;
      for(int j=0;j<2;j++){
        vec4 candidate=backAt(uvExit);
        if(!exists(candidate)||depthFrom(candidate)>=nearDepth) break;
        back=candidate;
        path=mix(path,(nearDepth-depthFrom(back))/forward,.76);
        uvExit=uv+displacement*(path/(2.*span));
      }
      vec3 exitPoint=entry+inside*path;
      vec3 exitNormal=normalFrom(back);
      float exitCos=dot(inside,exitNormal);
      if(exitCos <= .01) return;
      vec3 outDir=refract(inside,-exitNormal,1.36);
      // Internally reflected rays or rays emerging above the horizon do
      // not immediately reach this receiver.
      if(outDir.y >= -.10) return;
      vec3 target=exitPoint+outDir*(max(.008,exitPoint.y)/-outDir.y);
      float travel=distance(target.xz,straightHit.xz)/span;
      float received=(1.-smoothstep(1.6,3.5,travel))*
          (1.-.75*pow(1.-facing,5.))*(1.-.75*pow(1.-exitCos,5.));
      if(received < .006) return;
      floorHit=target.xz;
      contribution=vec4(transmission*received*.90,0.);
      footprint*=1.+clamp(travel*.55,0.,1.);
    }
    gl_Position=vec4(floorHit/worldExtent*2.,0.,1.);
    gl_PointSize=footprint;
    // Clear membranes divert a small share of the key without dyeing the floor.
    contribution*=mix(vec4(1.),vec4(.22,.22,.22,.16),film);
    flux=contribution*(energy*5.82/(footprint*footprint))*.46;
  }
`;
const photonFragment = `
  varying vec4 flux;
  void main(){
    vec2 offset=gl_PointCoord*2.-1.;
    float r=dot(offset,offset);
    if(r>1.) discard;
    gl_FragColor=flux*exp(-4.4*r);
  }
`;

const blurVertex = `
  varying vec2 sampleUV;
  void main(){sampleUV=uv;gl_Position=vec4(position.xy,0.,1.);}
`;
const blurFragment = `
  uniform sampler2D source;
  uniform vec2 offset;
  varying vec2 sampleUV;
  void main(){
    vec4 blur=texture2D(source,sampleUV)*.227027;
    blur+=(texture2D(source,sampleUV+offset*1.384615)+texture2D(source,sampleUV-offset*1.384615))*.316216;
    blur+=(texture2D(source,sampleUV+offset*3.230769)+texture2D(source,sampleUV-offset*3.230769))*.070270;
    gl_FragColor=blur;
  }
`;

const receiverVertex = `
  varying vec2 pos;
  void main(){
    vec4 p=modelMatrix*vec4(position,1.);
    pos=p.xz;
    gl_Position=projectionMatrix*viewMatrix*p;
  }
`;
const receiverFragment = `
  uniform sampler2D lightField,softField;
  uniform vec2 worldExtent,mapPixels;
  uniform vec4 contacts[${CONTACT_SLOTS}];
  uniform int contactCount;
  uniform float contactWeights[${CONTACT_SLOTS}];
  varying vec2 pos;
  vec4 filterField(vec2 uv,vec2 d){
    // A finite lamp softens the light-space footprint and caustic edges.
    vec4 sum=texture2D(lightField,uv)*.16;
    sum+=texture2D(lightField,uv+vec2(d.x,0.))*.12;
    sum+=texture2D(lightField,uv-vec2(d.x,0.))*.12;
    sum+=texture2D(lightField,uv+vec2(0.,d.y))*.12;
    sum+=texture2D(lightField,uv-vec2(0.,d.y))*.12;
    sum+=texture2D(lightField,uv+d)*.09;
    sum+=texture2D(lightField,uv-d)*.09;
    sum+=texture2D(lightField,uv+vec2(d.x,-d.y))*.09;
    sum+=texture2D(lightField,uv+vec2(-d.x,d.y))*.09;
    return sum;
  }
  void main(){
    vec2 uv=pos/worldExtent+.5;
    float inBounds=step(0.,uv.x)*step(0.,uv.y)*step(uv.x,1.)*step(uv.y,1.);
    vec4 tight=filterField(uv,1.3/mapPixels);
    vec4 soft=texture2D(softField,uv);
    vec2 w=vec2(.086)/worldExtent;
    vec4 wide=(texture2D(softField,uv+w)+texture2D(softField,uv-w)+
               texture2D(softField,uv+vec2(w.x,-w.y))+texture2D(softField,uv+vec2(-w.x,w.y)))*.25;
    vec3 light=(tight.rgb*.30+soft.rgb*.54+wide.rgb*.16)*inBounds/.46;
    float shadow=clamp((tight.a*.11+soft.a*.58+wide.a*.31)*inBounds/.46,0.,1.);
    float contact=0.;
    for(int i=0;i<${CONTACT_SLOTS};i++){
      if(i>=contactCount)break;
      vec4 c=contacts[i];
      vec2 q=(pos-c.xy)/max(vec2(.035),c.zw);
      contact+=contactWeights[i]*exp(-2.*dot(q,q));
    }
    // White seamless paper, with gentle studio falloff toward the viewer.
    float warmth=.5+.5*tanh(pos.y*.13);
    vec3 paper=mix(vec3(.977,.980,.984),vec3(.913,.922,.933),warmth);
    float peak=max(light.r,max(light.g,light.b));
    vec3 hue=light/max(.0001,peak);
    vec3 absorb=(1.-hue)*(1.-exp(-peak*1.7))*.55;
    vec3 result=paper*(1.-shadow*.46-clamp(contact,0.,.2))-absorb;
    // Focused flux returns colored light and makes the cores brighter.
    result+=light*(.21+.34*shadow)/(1.+peak*.58);
    gl_FragColor=vec4(clamp(result,0.,1.),1.);
    #include <colorspace_fragment>
  }
`;

function target(width,height,nearest,depth){
  const rt=new THREE.WebGLRenderTarget(width,height,{
    minFilter:nearest?THREE.NearestFilter:THREE.LinearFilter,
    magFilter:nearest?THREE.NearestFilter:THREE.LinearFilter,
    type:THREE.UnsignedByteType,
    depthBuffer:depth,stencilBuffer:false,generateMipmaps:false
  });
  rt.texture.colorSpace=THREE.NoColorSpace;
  return rt;
}

function photonGeometry(RAYS){
  const uv=new Float32Array(RAYS*RAYS*3*3),kind=new Float32Array(RAYS*RAYS*3);
  for(let y=0;y<RAYS;y++)for(let x=0;x<RAYS;x++){
    const i=(y*RAYS+x)*3;
    const hash=(x*1973+y*9277+89173)>>>0;
    const jitterX=(Math.sin(hash)*43758.5453)%1;
    const jitterY=(Math.sin(hash*.23+17)*39217.191)%1;
    for(let k=0;k<3;k++){
      uv[(i+k)*3]=(x+.5+jitterX*.32)/RAYS;
      uv[(i+k)*3+1]=(y+.5+jitterY*.32)/RAYS;
      kind[i+k]=k;
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(uv,3));
  geometry.setAttribute('bent',new THREE.BufferAttribute(kind,1));
  return geometry;
}

export function createOptics(renderer,scene){
  const captureScene=new THREE.Scene(),photons=new THREE.Scene();
  const touch=globalThis.matchMedia?.('(pointer: coarse)');
  let mobileLoad=0;
  const dummyCamera=new THREE.Camera();
  const front=target(TILE,TILE,true,true);
  const back=target(TILE,TILE,true,true);
  const field=target(640,640,false,false);
  const blurA=target(352,352,false,false),blurB=target(352,352,false,false);
  if(renderer.extensions.has('EXT_color_buffer_float')){
    for(const rt of [field,blurA,blurB])rt.texture.type=THREE.HalfFloatType;
  }
  const blurScene=new THREE.Scene();
  const blurMat=new THREE.ShaderMaterial({
    uniforms:{source:{value:field.texture},offset:{value:new THREE.Vector2()}},
    vertexShader:blurVertex,fragmentShader:blurFragment,depthTest:false,depthWrite:false,toneMapped:false
  });
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),blurMat);
  quad.frustumCulled=false;blurScene.add(quad);
  const common={
    toLight:{value:new THREE.Vector3(-.55,1,-.65).normalize()},
    right:{value:new THREE.Vector3()},up:{value:new THREE.Vector3()},
    worldExtent:{value:new THREE.Vector2(18,16)},
    mapPixels:{value:new THREE.Vector2(field.width,field.height)},
    entrance:{value:front.texture},exitSurface:{value:back.texture}
  };
  const contacts=Array.from({length:CONTACT_SLOTS},()=>new THREE.Vector4());
  const contactCount={value:0},contactWeights={value:new Float32Array(CONTACT_SLOTS)};
  const material=new THREE.ShaderMaterial({
    uniforms:{...common,lightField:{value:field.texture},softField:{value:blurB.texture},contacts:{value:contacts},contactCount,contactWeights},
    vertexShader:receiverVertex,fragmentShader:receiverFragment,toneMapped:false
  });
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(1000,1000),material);
  floor.rotation.x=-Math.PI*.5;
  floor.name='White studio floor';
  scene.add(floor);
  const pointGrids=new Map(),entries=[];
  const clearDye=new THREE.Color(.985,.997,1.);
  let dirty=true,lastUpdate=-Infinity;
  const savedColor=new THREE.Color(),savedViewport=new THREE.Vector4(),savedScissor=new THREE.Vector4();
  const axis=new THREE.Vector3(0,0,1),worldBox=new THREE.Box3(),unit=new THREE.Vector3();

  function removeEntry(e){
    captureScene.remove(e.surface);photons.remove(e.points);
    e.frontMaterial.dispose();e.backMaterial.dispose();e.rayMaterial.dispose();
  }

  function makeEntry(b,mesh,isFilm,samples){
    const values={
      ...common,center:{value:new THREE.Vector3()},span:{value:1},
      tile:{value:new THREE.Vector4()},worldNormals:{value:new THREE.Matrix3()},
      dye:{value:isFilm?clearDye:b.color},film:{value:isFilm?1:0},samplesPerAxis:{value:1}
    };
    const makeSurface=side=>new THREE.ShaderMaterial({
      side,uniforms:values,vertexShader:surfaceVertex,fragmentShader:surfaceFragment,
      blending:THREE.NoBlending,toneMapped:false
    });
    const frontMaterial=makeSurface(THREE.FrontSide),backMaterial=makeSurface(THREE.BackSide);
    const surface=new THREE.Mesh(mesh.geometry,frontMaterial);
    surface.matrixAutoUpdate=false;surface.matrixWorldAutoUpdate=false;surface.frustumCulled=false;
    const rayMaterial=new THREE.ShaderMaterial({
      uniforms:values,vertexShader:photonVertex,fragmentShader:photonFragment,
      transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor,
      blendEquation:THREE.AddEquation,depthTest:false,depthWrite:false,toneMapped:false
    });
    const points=new THREE.Points(samples,rayMaterial);
    points.frustumCulled=false;captureScene.add(surface);photons.add(points);
    return {b,mesh,isFilm,values,surface,frontMaterial,backMaterial,rayMaterial,points,
      positionVersion:-1,normalVersion:-1,sourceColor:new THREE.Color(),contact:-1,size:0};
  }

  function setBodies(bodies){
    const parts=[];
    for(const b of bodies){
      parts.push({b,mesh:b.mesh,isFilm:false});
      if(b.filler)parts.push({b,mesh:b.filler,isFilm:true});
    }
    if(parts.length===entries.length&&parts.every((p,i)=>p.mesh===entries[i].mesh&&p.b===entries[i].b))return;
    const old=new Map(entries.map(e=>[e.mesh,e]));
    entries.length=0;
    // A crowded phone view projects each logo onto fewer floor texels.
    // Preserve the full sampling density for the initial six sculptures.
    mobileLoad=touch?.matches?bodies.length:0;
    const crowded=mobileLoad>14,medium=mobileLoad>6;
    const grid=crowded?28:medium?40:parts.length<=4?80:parts.length<=9?64:parts.length<=16?48:36;
    const tileSize=crowded?88:medium?112:TILE;
    const fieldSize=crowded?384:medium?496:640,blurSize=crowded?208:medium?272:352;
    field.setSize(fieldSize,fieldSize);blurA.setSize(blurSize,blurSize);blurB.setSize(blurSize,blurSize);
    common.mapPixels.value.set(fieldSize,fieldSize);
    if(!pointGrids.has(grid))pointGrids.set(grid,photonGeometry(grid));
    const samples=pointGrids.get(grid),columns=Math.ceil(Math.sqrt(Math.max(1,parts.length)));
    const rows=Math.max(1,Math.ceil(parts.length/columns));
    front.setSize(tileSize*columns,tileSize*rows);back.setSize(tileSize*columns,tileSize*rows);
    let count=0;
    for(const [i,{b,mesh,isFilm}] of parts.entries()){
      const e=old.get(mesh)??makeEntry(b,mesh,isFilm,samples);
      old.delete(mesh);e.b=b;e.mesh=mesh;e.points.geometry=samples;
      e.values.dye.value=isFilm?clearDye:b.color;
      e.values.tile.value.set(1/columns,1/rows,(i%columns)/columns,Math.floor(i/columns)/rows);
      e.values.samplesPerAxis.value=grid;
      e.contact=isFilm?-1:count++;
      entries.push(e);
    }
    for(const e of old.values())removeEntry(e);
    contactCount.value=Math.min(contacts.length,count);
    dirty=true;
  }

  function update(direction,width=18,depth=16){
    const now=performance.now();
    const refresh=mobileLoad>14?12:mobileLoad>6?17:entries.length>16?18:entries.length>9?23:30;
    const light=common.toLight.value,extent=common.worldExtent.value;
    const lampChanged=light.distanceToSquared(direction)>.0000002||extent.x!==width||extent.y!==depth;
    if(!dirty&&!lampChanged&&now-lastUpdate<1000/refresh)return false;
    let changed=dirty||lampChanged;
    for(const e of entries){
      const mesh=e.mesh;
      mesh.updateWorldMatrix(true,false);
      const g=mesh.geometry;
      if(!changed)changed=e.surface.geometry!==g||!e.surface.matrixWorld.equals(mesh.matrixWorld)||
        e.positionVersion!==g.attributes.position.version||e.normalVersion!==g.attributes.normal.version||
        e.size!==e.b.size||!e.sourceColor.equals(e.values.dye.value);
    }
    if(!changed)return false;
    dirty=false;lastUpdate=now;
    const L=light.copy(direction).normalize();
    common.right.value.crossVectors(L,Math.abs(L.z)>.97?unit.set(1,0,0):axis).normalize();
    common.up.value.crossVectors(L,common.right.value).normalize();
    extent.set(Math.max(.1,width),Math.max(.1,depth));
    for(const e of entries){
      const mesh=e.mesh,g=mesh.geometry;
      e.positionVersion=g.attributes.position.version;e.normalVersion=g.attributes.normal.version;
      e.sourceColor.copy(e.values.dye.value);e.size=e.b.size;
      e.surface.geometry=g;e.surface.matrixWorld.copy(mesh.matrixWorld);
      e.values.worldNormals.value.getNormalMatrix(mesh.matrixWorld);
      if(!g.boundingSphere)g.computeBoundingSphere();
      if(!g.boundingBox)g.computeBoundingBox();
      const sphere=g.boundingSphere;
      // Skinning updates the sphere around the displaced mesh. Centering
      // the light-space capture there preserves ray density as the jelly sags.
      e.values.center.value.copy(sphere.center).applyMatrix4(mesh.matrixWorld);
      e.values.span.value=Math.max(.025,sphere.radius*mesh.matrixWorld.getMaxScaleOnAxis()*1.045);
      if(e.contact>=0&&e.contact<contacts.length){
        worldBox.copy(g.boundingBox).applyMatrix4(mesh.matrixWorld);
        const altitude=Math.max(0,worldBox.min.y),base=Math.max(.045,e.b.size||1);
        const radiusX=(worldBox.max.x-worldBox.min.x)*.43+base*.16;
        const radiusZ=(worldBox.max.z-worldBox.min.z)*.43+base*.16;
        contacts[e.contact].set((worldBox.min.x+worldBox.max.x)*.5,(worldBox.min.z+worldBox.max.z)*.5,
          radiusX+altitude*.08,radiusZ+altitude*.08);
        contactWeights.value[e.contact]=.105*Math.exp(-1.9*altitude/base);
      }
    }
    const previous=renderer.getRenderTarget();
    const face=renderer.getActiveCubeFace(),level=renderer.getActiveMipmapLevel();
    renderer.getViewport(savedViewport);renderer.getScissor(savedScissor);
    const scissorTest=renderer.getScissorTest(),alpha=renderer.getClearAlpha(),auto=renderer.autoClear;
    renderer.getClearColor(savedColor);
    try{
      renderer.autoClear=false;
      renderer.setClearColor(0,0);
      renderer.setScissorTest(false);
      for(const [rt,side] of [[front,'frontMaterial'],[back,'backMaterial']]){
        renderer.setRenderTarget(rt);renderer.clear(true,true,false);
        for(const e of entries)e.surface.material=e[side];
        renderer.render(captureScene,dummyCamera);
      }
      renderer.setRenderTarget(field);renderer.clear(true,false,false);if(entries.length)renderer.render(photons,dummyCamera);
      blurMat.uniforms.source.value=field.texture;
      blurMat.uniforms.offset.value.set(.030/common.worldExtent.value.x,0);
      renderer.setRenderTarget(blurA);renderer.render(blurScene,dummyCamera);
      blurMat.uniforms.source.value=blurA.texture;
      blurMat.uniforms.offset.value.set(0,.030/common.worldExtent.value.y);
      renderer.setRenderTarget(blurB);renderer.render(blurScene,dummyCamera);
    }finally{
      renderer.setRenderTarget(previous,face,level);renderer.setClearColor(savedColor,alpha);
      renderer.setViewport(savedViewport);renderer.setScissor(savedScissor);renderer.setScissorTest(scissorTest);
      renderer.autoClear=auto;
    }
    floor.userData.opticsRevision=(floor.userData.opticsRevision||0)+1;
    return true;
  }
  function dispose(){
    for(const e of entries)removeEntry(e);
    entries.length=0;scene.remove(floor);
    floor.geometry.dispose();material.dispose();
    for(const geometry of pointGrids.values())geometry.dispose();
    front.dispose();back.dispose();field.dispose();blurA.dispose();blurB.dispose();
    quad.geometry.dispose();blurMat.dispose();
  }
  return { setBodies, update, dispose };
}
