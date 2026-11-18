import { Float32BufferAttribute, Vector3 } from 'three';

// A curvilinear parameterization from the exported stream, including its meanders.
function flowCoordinates(geo) {
  const p=geo.getAttribute('position'),sections=new Map();
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),z=p.getZ(i),s=sections.get(x);
    if(s){s.lo=Math.min(s.lo,z);s.hi=Math.max(s.hi,z);}else sections.set(x,{x,lo:z,hi:z});
  }
  const rows=[...sections.values()].sort((a,b)=>a.x-b.x);
  let last=null;
  for(const row of rows) {
    row.center=(row.lo+row.hi)*.5;
    row.distance=last?last.distance+Math.hypot(row.x-last.x,row.center-last.center):0;
    last=row;
  }
  for(let i=0;i<rows.length;i++) {
    const a=rows[Math.max(0,i-1)],b=rows[Math.min(rows.length-1,i+1)],s=rows[i];
    s.slope=(b.center-a.center)/Math.max(.001,b.x-a.x);
  }
  const buffer=new Float32Array(p.count*4);
  for(let i=0;i<p.count;i++){
    const s=sections.get(p.getX(i)),dz=p.getZ(i)-s.center,stretch=Math.sqrt(1+s.slope*s.slope);
    buffer.set([s.distance+dz*s.slope/stretch,dz/stretch,2*dz/Math.max(.01,s.hi-s.lo),s.slope],i*4);
  }
  geo.setAttribute('valleyFlow',new Float32BufferAttribute(buffer,4));
}

const riverHeader=`
uniform float valleyTime;
varying vec4 vFlow;
float valleyCrest(float phase,float width){
  float c=sin(phase);
  return smoothstep(1.-width,1.-width*.26,c);
}
`;
function river(shader, clock, mobile) {
  shader.uniforms.valleyTime=clock;
  shader.vertexShader='attribute vec4 valleyFlow; varying vec4 vFlow;\n'+shader.vertexShader.replace(
    '#include <begin_vertex>','#include <begin_vertex>\n vFlow=valleyFlow;');
  shader.fragmentShader=riverHeader+shader.fragmentShader.replace('#include <map_fragment>',`
    float bank=clamp(abs(vFlow.z),0.,1.);
    float speed=1.18-.37*bank*bank;
    float streamT=valleyTime*speed;
    float a=vFlow.x-streamT;
    float b=vFlow.y;
    float sw=sin(a*.48+b*1.17);
    float bend=sin(a*.207-b*.64+sw*.34);
    float broad=sin(a*.92-b*1.67+1.14*bend+.43*sw);
    #ifdef USE_MAP
      vec2 dir=normalize(vec2(1.,vFlow.w));
      vec2 across=vec2(-dir.y,dir.x);
      vec2 wobble=dir*(.032*broad+.017*sw)+across*(.045*bend);
      vec4 wet=texture2D(map,vMapUv+vec2(.075,.155)*(-dir*streamT*.58)+wobble);
      diffuseColor*=wet;
    #endif
    float pool=sin(a*.105+sin(b*.81)*.66)*.5+.5;
    float band=.82*a+2.34*b+.94*sin(a*.28+b*1.37)+.58*bend;
    float broken=smoothstep(.03,.72,sin(a*.36-b*1.5+sw)*.54+sin(b*.95+a*.17)*.47);
    float closeRipple=1.-smoothstep(.34,1.15,fwidth(vFlow.x)+fwidth(vFlow.y));
    float glints=valleyCrest(band,.105)*broken*(.29+.71*pool)*closeRipple;
    ${mobile?'':'glints+=.32*valleyCrest(band*1.76-.79*bend,.07)*smoothstep(.4,.87,pool)*closeRipple;'}
    float edge=smoothstep(.68,.97,bank)*(1.-smoothstep(.974,1.002,bank));
    float foamPhase=b*4.7+(vFlow.z>0.?-1.:1.)*(a*.25+1.56*sin(a*.29)+.88*bend);
    float foam=edge*valleyCrest(foamPhase,.30)*smoothstep(-.32,.56,sin(a*.77+b*.69)+.51*sw);
    diffuseColor.rgb*=.92+.12*bend+.051*broad;
    diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.62,.87,.78),clamp(glints*.66+foam*.79,0.,.84));
  `).replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
    vec2 flowNormal=vec2(.075*cos(band)+.029*sw,.105*cos(band*.79+.84*bend));
    vec2 streamDir=normalize(vec2(1.,vFlow.w));vec2 lateral=vec2(-streamDir.y,streamDir.x);
    vec2 disturbed=(flowNormal.x*streamDir+flowNormal.y*lateral)*(1.-bank*.8)*closeRipple;
    normal=normalize(normal+mat3(viewMatrix)*vec3(disturbed.x,0.,disturbed.y));
  `);
}
function breeze(shader,clock,profile){
  shader.uniforms.valleyTime=clock;
  const leaf=profile==='leaf';
  shader.vertexShader='uniform float valleyTime;\n'+(leaf?'':'attribute float meadowWind;\n')+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
    vec3 worldLeaf=(modelMatrix*vec4(position,1.)).xyz;
    float weight=${leaf?'clamp(.28+.72*uv.y,0.,1.)':'meadowWind*meadowWind'};
    float gust=.49*sin(.52*worldLeaf.x+.17*worldLeaf.z-valleyTime*1.35)
             +.34*sin(.15*worldLeaf.x-.23*worldLeaf.z-valleyTime*.81)
             +.17*sin(.72*worldLeaf.z+.63*worldLeaf.x-valleyTime*2.45);
    transformed.x+=weight*gust*${leaf?'.118':'.048'};
    transformed.z+=weight*(.42*gust+.19*sin(worldLeaf.z*.74+valleyTime*1.09))*${leaf?'.107':'.052'};
  `);
}
export function createValleyNature(scene,{mobile=false}={}){
  const clock={value:0},done=new Set(),grassTiles=[];
  const lastCamera=new Vector3(Infinity,Infinity,Infinity);let meshes=0;
  scene.updateMatrixWorld(true);
  scene.traverse(mesh=>{
    if(!mesh.isMesh)return;
    if(mesh.userData.grass===true&&(mesh.userData.detail==='near'||mesh.userData.detail==='cluster')){
      const g=mesh.geometry;if(!g.boundingSphere)g.computeBoundingSphere();
      const sphere=g.boundingSphere.clone().applyMatrix4(mesh.matrixWorld);
      const distance=sphere.radius+(mesh.userData.detail==='near'?115:210);
      grassTiles.push({mesh,center:sphere.center,limit2:distance*distance});
    }
    const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    for(const m of materials){
      const name=m.name.toLowerCase(),geo=mesh.geometry;
      let mode=/mineral-green and sky-blue current/.test(name)?'river':/leaf and blossom tips|botanical leaf sprays/.test(name)?'leaf':/meadow grass/.test(name)?'grass':null;
      if(!mode)continue;
      if(mode==='river')flowCoordinates(geo);
      else if(mode==='leaf'&&!geo.attributes.uv)continue;
      else if(mode==='grass'){
        const wind=geo.attributes._wind||geo.attributes.meadowWind||geo.attributes._meadowwind;
        if(wind)geo.setAttribute('meadowWind',wind);
        else if(geo.attributes.uv){
          const uv=geo.attributes.uv,values=new Float32Array(uv.count);
          for(let i=0;i<values.length;i++)values[i]=Math.max(0,Math.min(1,uv.getY(i)));
          geo.setAttribute('meadowWind',new Float32BufferAttribute(values,1));
        }else continue;
      }
      meshes++;
      if(done.has(m))continue;done.add(m);
      m.onBeforeCompile=shader=>mode==='river'?river(shader,clock,mobile):breeze(shader,clock,mode);
      m.customProgramCacheKey=()=>`valley/${mode}/${+mobile}/1`;
      m.needsUpdate=true;
    }
  });
  return {active:meshes>0,setTime(seconds){clock.value=seconds;},updateView(cameraPosition){
    if(lastCamera.distanceToSquared(cameraPosition)<.09)return;
    lastCamera.copy(cameraPosition);
    for(const tile of grassTiles)tile.mesh.visible=cameraPosition.distanceToSquared(tile.center)<=tile.limit2;
  }};
}
