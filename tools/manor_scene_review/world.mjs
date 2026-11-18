import {addFlora, heroTreeSites} from './flora.mjs';
import {addWaterfront,bridgeDeckLift} from './waterfront.mjs';
import {addMeadowDetail} from './wildflowers.mjs';
import {addRidges} from './ridges.mjs';
import {addLeafSprays} from './leaf-sprays.mjs';
import {addBorders} from './borders.mjs';
import {addGrass} from './grass.mjs';

const TAU=Math.PI*2, clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)), mix=(a,b,t)=>a+(b-a)*t;
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t)};
function hash(x,z){let h=Math.imul(x,1597334677)^Math.imul(z,3812015801);h=Math.imul(h^(h>>>16),0x45d9f3b);return ((h^(h>>>16))>>>0)/4294967296}
function noise(x,z){const i=Math.floor(x),j=Math.floor(z),u=smooth(0,1,x-i),v=smooth(0,1,z-j);return mix(mix(hash(i,j),hash(i+1,j),u),mix(hash(i,j+1),hash(i+1,j+1),u),v)}
function rng(s){return ()=>{s=Math.imul(s,1664525)+1013904223|0;return (s>>>0)/4294967296}}
const WORLD_WIDTH=1200,WORLD_DEPTH=960;
const riverZ=x=>66-31*Math.sin(x*.041)-8*Math.sin(x*.019)+12*Math.sin(x*.013)-Math.min(130,Math.max(0,x-55))*.90-Math.max(0,x-185)*.24;
const riverSlope=x=>(riverZ(x+.08)-riverZ(x-.08))/.16;
const riverHalf=x=>(7.0+2.5*(.5+.5*Math.cos(x*.051+.55))+1.4*Math.sin(x*.016))*Math.hypot(1,riverSlope(x));
const bank=(x,z)=>Math.abs(z-riverZ(x))-riverHalf(x);
const terrainColumns=[];
for(const [a,b,n] of [[-1850,-640,105],[-640,640,336],[640,1850,105]])for(let i=0;i<n;i++)terrainColumns.push(mix(a,b,i/n));
terrainColumns.push(1850);
function bridgeAt(x){
 const slope=riverSlope(x),yaw=Math.atan(-slope),halfRiver=riverHalf(x)/Math.hypot(1,slope),z=riverZ(x);
 const reach=halfRiver+(x===0?6.8:9.5),c=Math.cos(yaw),s=Math.sin(yaw);
 return {x,z,yaw,halfRiver,reach,local:(u,v)=>[x+u*c+v*s,z-u*s+v*c]};
}
const terrainBase=(x,z)=>{
  const north=smooth(370,650,-z), side=smooth(575,840,Math.abs(x)),south=smooth(445,720,z);
  const distance=Math.max(north,side,south);
  const relief=(north*90+side*65+south*40)*(.51+.32*noise(x*.005,z*.006)+.17*Math.sin(x*.008-z*.007)**2)+3.5*noise(x*.055,z*.059)*distance;
  // A flat shelf covers most of the playable meadow. Relief rises along its margins.
  return 4.10+relief;
};
const height=(x,z)=>{
  const d=bank(x,z),e=mix(4.10,terrainBase(x,z),smooth(12,95,d));
  if(d < 0)return mix(-1.6,.25,smooth(-3,0,d));
  const grade=8.5+2.9*Math.sin(x*.045+(z>riverZ(x)?0:1));
  return mix(.25,e,smooth(0,grade,d));
};
function grid(T,root,name,material,nx,nz,point){
  const ps=[],uv=[],cs=[],ix=[];
  for(let j=0;j<=nz;j++)for(let i=0;i<=nx;i++){const [x,y,z,u,v,r,g,b]=point(i/nx,j/nz);ps.push(x,y,z);uv.push(u,v);if(r!==undefined)cs.push(r,g,b);if(i<nx&&j<nz){const a=j*(nx+1)+i;ix.push(a,a+nx+1,a+1,a+1,a+nx+1,a+nx+2)}}
  const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(ps,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));if(cs.length)geo.setAttribute('color',new T.Float32BufferAttribute(cs,3));geo.setIndex(ix);geo.computeVertexNormals();
  const obj=new T.Mesh(geo,material);obj.name=name;root.add(obj);return obj;
}
function meshBatch(T,root,name,mat){const pos=[],cols=[],ind=[];return {
  pt(x,y,z,c){pos.push(x,y,z);cols.push(...c);return pos.length/3-1},tri(a,b,c){ind.push(a,b,c)},
  end(){if(!ind.length)return;const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('color',new T.Float32BufferAttribute(cols,3));g.setIndex(ind);g.computeVertexNormals();const o=new T.Mesh(g,mat);o.name=name;root.add(o);return o}
}}
function trail(T,control,w){const sp=new T.CatmullRomCurve3(control.map(([x,z])=>new T.Vector3(x,0,z)));const n=Math.ceil(sp.getLength()/1.15);return {ps:sp.getSpacedPoints(n).map(p=>[p.x,p.z]),w}}
function join(path,[x,z]){
 let best=Infinity,point;
 for(let i=1;i<path.ps.length;i++){
  const [a,b]=path.ps[i-1],[c,d]=path.ps[i],dx=c-a,dz=d-b;
  const t=clamp(((x-a)*dx+(z-b)*dz)/(dx*dx+dz*dz));
  const p=a+t*dx,q=b+t*dz,err=(x-p)**2+(z-q)**2;
  if(err<best){best=err;point=[p,q];}
 }
 return point;
}
function paths(T){
 const [west,center,east]=[-455,0,455].map(bridgeAt);
 const head=(bridge,side,offset=0)=>bridge.local(0,side*(bridge.reach+offset));
 const road=(points,w,bridgeEdges={})=>Object.assign(trail(T,points,w),bridgeEdges);
 const north=road([head(west,-1),head(west,-1,6),[-482,38],[-483,-12],[-469,-85],[-453,-229],[-359,-304],[-142,-307],[91,-292],[310,-283],[464,-217],[445,-199],[423,-177],[422,-151],head(east,-1,12),head(east,-1,5),head(east,-1)],6.2,{bridgeStart:true,bridgeEnd:true});
 const south=road([head(west,1),head(west,1,6),[-435,99],[-448,128],[-475,160],[-435,291],[-280,369],[-50,388],[169,365],[375,295],[474,165],[480,5],[489,-76],head(east,1,12),head(east,1,5),head(east,1)],6.2,{bridgeStart:true,bridgeEnd:true});
 const northStreet=road([join(north,[-454,-171]),[-287,-171],[-113,-164],[35,-171],[219,-170],[380,-168],[404,-174],join(north,[423,-177])],4.1);
 const southStreet=road([join(south,[-435,275]),[-269,239],[-126,236],[32,221],[207,207],[390,208],join(south,[470,163])],4.3);
 const centralSouth=road([head(center,1),head(center,1,3),[23,82],[31,95],[24,111],[28,129],[45,143],[59,160],[84,189],join(southStreet,[101,215])],5.7,{bridgeStart:true});
 const centralNorth=road([head(center,-1),head(center,-1,3),[-25,50],[-36,35],[-38,9],[-32,-9],[-11,-28],[12,-39],[32,-56],[49,-82],[47,-111],[50,-146],join(northStreet,[68,-168])],4.3,{bridgeStart:true});
 const southeast=road([join(southStreet,[226,208]),[213,107],[220,37],[230,-34]],3.4);
 return [
  centralSouth,centralNorth,
  road([join(centralNorth,[-32,-10]),[-59,-10],[-86,-30],[-124,-29],[-154,-11],[-184,-20],[-219,-44],[-249,-50]],2.55),
  road([join(centralSouth,[25,121]),[60,113],[87,105],[120,101],[147,86],[171,82],[198,72],join(southeast,[217,56])],2.8),
  north,south,northStreet,southStreet,
  road([join(north,[-290,-300]),[-281,-203],[-287,-118],[-279,-47],[-261,4]],3.4),
  road([join(north,[276,-284]),[262,-205],[249,-159],[227,-93],[237,-70]],3.4),
  road([join(southStreet,[-277,237]),[-265,157],[-249,116],[-241,109]],3.4),
  southeast,
 ];
}
function pathField(trails){
 const buckets=new Map(),key=(i,j)=>i+'|'+j,cell=20;
 for(const {ps,w} of trails)for(let n=0;n<ps.length-1;n++){
  const [x,z]=ps[n],[xx,zz]=ps[n+1],dx=xx-x,dz=zz-z,len=dx*dx+dz*dz,s={x,z,dx,dz,len,w};
  for(let i=Math.floor((Math.min(x,xx)-28)/cell);i<=Math.floor((Math.max(x,xx)+28)/cell);i++)for(let j=Math.floor((Math.min(z,zz)-28)/cell);j<=Math.floor((Math.max(z,zz)+28)/cell);j++){const k=key(i,j);if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(s)}
 }
 return (x,z)=>{let d=1e6;for(const s of buckets.get(key(Math.floor(x/cell),Math.floor(z/cell)))||[]){const t=clamp(((x-s.x)*s.dx+(z-s.z)*s.dz)/(s.len||1));d=Math.min(d,Math.hypot(x-s.x-t*s.dx,z-s.z-t*s.dz)-s.w*.5)}return d};
}
function plotSetup(distance){
 const plots=[];const sites=(heroTreeSites||[]);
 // Reserve a diverse set of footprints for review, without drawing lot divisions.
 const clear=(x,z)=>Math.abs(x)<535 && z>-335 && z<416 && bank(x,z)>14 && distance(x,z)>4 && sites.every(s=>Math.hypot(x-s.x,z-s.z)>s.r+3);
 for(const [w,d,step] of [[40,30,52],[30,24,40]]){
  for(let z=-308;z<398;z+=step-4)for(let x=-506;x<526;x+=step){
   if(plots.some(p=>Math.abs(x-p.x)<(w+p.width)*.5+3.9 && Math.abs(z-p.z)<(d+p.depth)*.5+3.9))continue;
   let ok=true;for(let zz=-d/2;zz<=d/2+.001;zz+=d/8)for(let xx=-w/2;xx<=w/2+.001;xx+=w/8)if(!clear(x+xx,z+zz))ok=false;
   if(ok)plots.push({id:'M'+String(plots.length+1).padStart(2,'0'),x,z,y:height(x,z),width:w,depth:d});
  }
 }
 return plots;
}

function ground(T,scene,layout,tex){
 const shadows=layout.treeShadows||[];
 const meadow=tex['meadow.jpg'];meadow.wrapS=meadow.wrapT=T.RepeatWrapping;
 const mat=new T.MeshStandardMaterial({name:'Sunlit meadow and stream banks',map:meadow,vertexColors:true,roughness:.99,side:T.DoubleSide});
 // The inner rows track the real bank width, matching the water at both edges.
 const spans=[[-1700,-510,42],[-510,-31,104],[-31,-1,15],[-1,1,18],[1,31,15],[31,510,104],[510,1700,42]],depthRows=[];
 for(const [a,b,n] of spans)for(let i=0;i<n;i++)depthRows.push(mix(a,b,i/n));depthRows.push(1700);
 grid(T,scene,'01 | Continuous meadow, rolling foothills and carved riverbed',mat,terrainColumns.length-1,depthRows.length-1,(u,v)=>{
  const x=terrainColumns[Math.round(u*(terrainColumns.length-1))],local=depthRows[Math.round(v*(depthRows.length-1))],half=riverHalf(x);
  const a=Math.abs(local),z=riverZ(x)+(a<=1?local*half:Math.sign(local)*(a<31?mix(half,31,(a-1)/30):a));
  const d=bank(x,z),y=height(x,z);
  const large=noise(x*.016+12,z*.016),n=noise(x*.066+42,z*.066),f=noise(x*.37,z*.35);
  let light=.71+.35*large+.14*n+.06*f;
  const verge=smooth(0,16,d)*(1-smooth(17,28,d)),far=smooth(143,340,-z);
  light*=1-.055*verge;
  let cool=.33*(1-smooth(0,9,d))+.10*far;
  for(const s of shadows){
   if(Math.abs(x-s.x)>s.r*2.8||Math.abs(z-s.z)>s.r*2.8)continue;
   const ao=Math.exp(-(((x-(s.x-s.h*.27))/(s.r*1.12))**2+((z-(s.z-s.h*.14))/(s.r*.88))**2)*1.60);
   light*=1-.51*ao;cool+=ao*.15;
  }
  return [x,y,z,x*.19+noise(x*.039,z*.037)*.42,z*.18+noise(x*.042+30,z*.039)*.38,light*(.94-cool*.28),light*(1.10+cool*.12),light*(1.26+cool*1.48)];
 });
}
function paving(T,root,trails,tex){
 const tile=tex['flagstone.jpg'];tile.wrapS=tile.wrapT=T.RepeatWrapping;
 const mat=new T.MeshStandardMaterial({name:'Handlaid buff limestone',map:tile,vertexColors:true,roughness:.97,side:T.DoubleSide});
 trails.forEach(({ps,w,bridgeStart,bridgeEnd},k)=>{
  grid(T,root,'02 | Limestone walk '+(k+1),mat,10,ps.length-1,(u,v)=>{
   const i=Math.round(v*(ps.length-1)),[x,z]=ps[i],lo=ps[Math.max(0,i-1)],hi=ps[Math.min(ps.length-1,i+1)],dx=hi[0]-lo[0],dz=hi[1]-lo[1],len=Math.hypot(dx,dz)||1;
   const edge=w*.5*(1+.038*Math.sin(i*.13)+.026*Math.cos(i*.53)),off=(2*u-1)*edge,X=x+dz/len*off,Z=z-dx/len*off;
   const bridgeFade=Math.min(bridgeStart?smooth(0,4,i):1,bridgeEnd?smooth(0,4,ps.length-1-i):1);
   const col=.84+.12*noise(X*.18,Z*.18),lift=mix(bridgeDeckLift(off),.113,bridgeFade);
   return [X,height(X,Z)+lift,Z,X/3.5,Z/3.5,col,col,col*.98];
  });
 });
}
function stream(T,root,tex){
 const map=tex['creek.jpg'];map.wrapS=map.wrapT=T.RepeatWrapping;
 const mat=new T.MeshStandardMaterial({name:'Mineral-green and sky-blue current',map,vertexColors:true,roughness:.56,metalness:.01,side:T.DoubleSide});
 const colors=['#c8f4ff','#daf5ff','#c9f6d4','#fff2c5','#93c7d0'].map(s=>new T.Color(s));
 grid(T,root,'03 | Winding clear stream',mat,terrainColumns.length-1,18,(u,v)=>{
  const x=terrainColumns[Math.round(u*(terrainColumns.length-1))],r=riverHalf(x),z=riverZ(x)+(v*2-1)*r;
  const near=Math.abs(2*v-1),f=noise(x*.096,z*.17),c=colors[4].clone().lerp(colors[0],.16+.64*f).lerp(colors[1],Math.max(0,Math.sin(x*.23+v*12)*.21+.12)).lerp(colors[2],near**2*.73).lerp(colors[3],near**9*.43);
  return [x,.25+.017*Math.sin(2*x+z*.7)*Math.sin(v*Math.PI),z,x*.075+noise(x*.045,z*.04)*.39,z*.155+Math.sin(x*.081)*.20,c.r,c.g,c.b];
 });
 const rr=rng(5638),water=meshBatch(T,root,'03b | Broken glints and shallow shoals',new T.MeshBasicMaterial({name:'Water glints',vertexColors:true,side:T.DoubleSide}));
 for(let k=0;k<1520;k++){
  const x=mix(-360,360,rr()),h=riverHalf(x),t=rr()*1.92-.96,z=riverZ(x)+t*h;
  if(Math.abs(x)<4)continue;
  const bright=rr(),c=new T.Color(bright>.92?'#d5efe0':bright>.62?'#a0d2b8':'#70b4a8').multiplyScalar(.82+rr()*.15).toArray();
  const len=.18+rr()**2*2.0,w=.02+rr()*.085,ang=.21*Math.cos(x*.04)+rr()*.18;
  const a=water.pt(x-len,.283,z-ang*len,c),b=water.pt(x,.284,z-w,c),d=water.pt(x,.284,z+w,c),e=water.pt(x+len*.85,.283,z+ang*len,c);
  water.tri(a,d,b);water.tri(b,d,e);
 }water.end();
}
function outerHills(T,root,tex){
 // Broken tree belts between the meadow and the high massif supply middle-distance parallax.
 const rand=rng(53523), cols=['#608051','#7f9756','#698b54','#8da257','#638056','#617f52'].map(s=>new T.Color(s));
 const pos=[],uv=[],cs=[],idx=[];
 for(let k=0;k<690;k++){
  const cx=mix(-1560,1560,rand()),cz=mix(-1320,-455,rand()),extra=Math.floor(rand()*7)+3;
  for(let j=0;j<extra;j++){
   const x=cx+(rand()-.5)*54,z=cz+(rand()-.5)*28;
   if((Math.abs(x)<WORLD_WIDTH*.52 && z>-WORLD_DEPTH*.52)||bank(x,z)<12)continue;
   const h=5+rand()**1.6*11.6,w=h*(.78+rand()*.32),y=height(x,z)-h*.07,ofs=rand()*TAU;
   const shade=randomShade(cols[Math.floor(rand()*cols.length)],rand());
   for(let face=0;face<2;face++){const angle=ofs+face*Math.PI*.5,dx=Math.cos(angle)*w*.5,dz=Math.sin(angle)*w*.5,base=pos.length/3;
    pos.push(x-dx,y,z-dz,x+dx,y,z+dz,x+dx,y+h,z+dz,x-dx,y+h,z-dz);
    uv.push(0,1,1,1,1,0,0,0);for(let i=0;i<4;i++)cs.push(...shade);idx.push(base,base+1,base+2,base,base+2,base+3);
   }
  }
 }const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('color',new T.Float32BufferAttribute(cs,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
 const trees=new T.Mesh(g,new T.MeshBasicMaterial({name:'Distant hillside woodland',map:tex['foothill-tree.png'],vertexColors:true,side:T.DoubleSide,alphaTest:.40}));
 trees.name='06 | Orchard copses and foothill woodland';root.add(trees);
 function randomShade(c,u){return new T.Color('#eaf2de').lerp(c,.15+.28*u).toArray()}
}
function edgeStones(T,root) {
 const rand=rng(18432), rock=meshBatch(T,root,'04b | Rounded creek stones, moss and gravel bars',new T.MeshStandardMaterial({name:'Streamside granite',vertexColors:true,roughness:.98,side:T.DoubleSide}));
 const type=['#acaa90','#aab4a3','#879187','#9aa39a','#bfb99d','#c6c7ad','#adb292','#9d998c'].map(x=>new T.Color(x)),moss=new T.Color('#8f9d59');
 function boulder(x,z,w,h,d){
  const ang=rand()*TAU, y=height(x,z)-h*.12, shade=type[Math.floor(rand()*type.length)],m=rand(),rings=[],sides=8;
  for(const [ilevel,scale,tint] of [[-.28,.72,.53],[.04,1,.72],[.56,.87,.94],[.91,.49,1.02],[1,.12,1.06]]){
   const row=[];for(let i=0;i<sides;i++){const a=i/sides*TAU,rr=scale*(.87+rand()*.22),lx=Math.cos(a)*w*rr,lz=Math.sin(a)*d*rr;
    const c=shade.clone().lerp(moss,(ilevel>.48&&m>.54)?(.15+.45*rand()):0).multiplyScalar(tint*(.92+.14*Math.cos(a+ang-1))*(.97+rand()*.05));
    row.push(rock.pt(x+lx*Math.cos(ang)-lz*Math.sin(ang),y+h*(ilevel+rand()*.08),z+lx*Math.sin(ang)+lz*Math.cos(ang),c.toArray()));
   }if(rings.length)for(let i=0;i<sides;i++){const j=(i+1)%sides,p=rings.at(-1);rock.tri(p[i],row[i],p[j]);rock.tri(p[j],row[i],row[j])}rings.push(row);
  }
  const last=rings.at(-1);for(let i=1;i+1<sides;i++)rock.tri(last[0],last[i+1],last[i]);
 }
 for(let k=0;k<143;k++){
  const xx=mix(-254,252,rand()),sign=rand()<.49?-1:1,phase=rand(),amount=3+Math.floor(rand()*7);
  for(let n=0;n<amount;n++){
   const x=xx+(rand()-.5)*8.3;
   const z=riverZ(x)+sign*(riverHalf(x)+(phase-.36)*3.8+(rand()-.48)*2.3);
   const size=.25+rand()**2*1.20+(k%9===0&&n<2?.85:0);
   boulder(x,z,size*(.9+rand()*.4),size*(.64+rand()*.65),size*(.65+rand()*.33));
  }
 }rock.end();
}
function sky(T,root,tex){
 const mat=new T.MeshBasicMaterial({name:'Painted valley sky',map:tex['sky.jpg'],side:T.DoubleSide,fog:false});
 grid(T,root,'08 | Upper sky vault',mat,112,28,(u,v)=>{
  const a=(u-.5)*TAU,alt=mix(Math.PI/2,-.07,v),r=6000;
  return [Math.sin(a)*Math.cos(alt)*r,Math.sin(alt)*r,-Math.cos(a)*Math.cos(alt)*r,u,clamp(1-alt/(Math.PI/2))];
 });
}
export function makeValley(T,textures){
 const scene=new T.Scene();scene.name='Clearbrook Meadow';const trails=paths(T),distanceToPath=pathField(trails);
 const plots=plotSetup(distanceToPath);
 const canDecorate=(x,z,r)=>{
  if(bank(x,z)<.35+r*.65 || distanceToPath(x,z)<r+1)return false;
  if(Math.abs(x)<4+r && Math.abs(z-riverZ(0))<riverHalf(0)+7+r)return false;
  return !plots.some(p=>Math.abs(x-p.x)<p.width*.5+r+.8&&Math.abs(z-p.z)<p.depth*.5+r+.8);
 };
 const l={width:WORLD_WIDTH,depth:WORLD_DEPTH,height,riverZ,riverHalf,canDecorate,distanceToPath,trails,plots};
 const flora=addFlora(T,scene,l,textures);
 addLeafSprays(T,scene,l,textures);
 addBorders(T,scene,l,textures);
 ground(T,scene,l,textures);stream(T,scene,textures);paving(T,scene,trails,textures);
 const bridges=[0,-455,455].map(bridgeAt);
 for(const b of bridges){
  const bridge=new T.Group();bridge.name='04 | Stone footbridge '+b.x;bridge.position.set(b.x,0,b.z);bridge.rotation.y=b.yaw;
  addWaterfront(T,bridge,{riverZ:()=>0,riverHalf:()=>b.halfRiver,reach:b.reach,height:(x,z)=>height(...b.local(x,z))},textures);scene.add(bridge);
 }
 addMeadowDetail(T,scene,l);const turf=addGrass(T,scene,l,textures);edgeStones(T,scene);outerHills(T,scene,textures);addRidges(T,scene,l,textures);sky(T,scene,textures);
 const highlands=scene.getObjectByName('Reference sculpted highlands');if(highlands){highlands.scale.set(2.35,1.7,2.35);highlands.position.z=-110;}
 const layout={name:'晴溪庄园',world:{width:WORLD_WIDTH,depth:WORLD_DEPTH,units:'meters',up:'Y'},camera:{closePosition:[6,11.5,105],closeTarget:[-1,4.5,62],detailPosition:[13,6.2,97],detailTarget:[-10,4.6,68]},plots,
  version:3,vegetation:{grass:turf.userData.stats,trees:flora.userData.population},landmarkTrees:flora.userData.heroTrees,groundLevel:4.1,bridge:{x:0,z:riverZ(0),width:7.6},
  crossings:bridges.map(({x,z,yaw,reach,local})=>({x,z,yaw,width:7.6,length:reach*2,heads:[local(0,-reach),local(0,reach)]}))};
 return {scene,layout};
}
