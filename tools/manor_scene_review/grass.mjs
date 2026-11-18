// Ordinary short turf is kept separate from permanent scenery and from each
// building footprint. Plot meshes can be removed when a house is installed.
export function addGrass(T, root, layout, textures) {
  const atlas = textures instanceof Map ? textures.get('grass-blades.png') : textures['grass-blades.png'];
  if (!atlas) throw new Error('Missing grass-blades.png; bake it with grass_art.py');
  const group = new T.Group(); group.name = 'Turf | removable meadow grass';
  const flags = { grass:true, removableGrass:true, windWeight:'uv.y', collision:false };
  group.userData = {...flags, source:'Original procedural meadow blades'};
  const blades = new T.MeshBasicMaterial({name:'Meadow grass blades',vertexColors:true,side:T.DoubleSide});
  const cards = new T.MeshBasicMaterial({name:'Meadow grass clusters',map:atlas,alphaTest:.44,vertexColors:true,side:T.DoubleSide});
  const worldW=layout.width, worldD=layout.depth, plots=layout.plots||[], tau=Math.PI*2;
  const rng=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const rand=rng(88365439),num=(a,b)=>a+(b-a)*rand();
  const buckets=new Map(),mapPlots=new Map(),cell=64;
  const key=(x,z)=>`${Math.floor(x/cell)}:${Math.floor(z/cell)}`;
  for(const p of plots) {
    const hw=p.width/2,hd=p.depth/2;
    for(let ix=Math.floor((p.x-hw-2)/cell);ix<=Math.floor((p.x+hw+2)/cell);ix++){
      for(let iz=Math.floor((p.z-hd-2)/cell);iz<=Math.floor((p.z+hd+2)/cell);iz++){
        const k=ix+':'+iz;if(!mapPlots.has(k))mapPlots.set(k,[]);mapPlots.get(k).push(p);
      }
    }
  }
  function destination(x,z,r) {
    if(Math.abs(x)+r>=worldW*.494 || Math.abs(z)+r>=worldD*.494 || Math.abs(z-layout.riverZ(x))-layout.riverHalf(x)<1.8+r*1.6 || layout.distanceToPath(x,z)<r+.58) return null;
    for(const p of mapPlots.get(key(x,z))||[]) {
      const dx=Math.abs(x-p.x)-p.width/2,dz=Math.abs(z-p.z)-p.depth/2;
      if(dx<-r && dz<-r)return p.id;
      if(dx<r && dz<r)return null;
    }
    return '';
  }
  function tile(x,z,kind,plot) {
    const step=kind==='blade'?30:85,ix=Math.floor(x/step),iz=Math.floor(z/step);
    const k=kind+' '+(plot || `${ix},${iz}`);
    if(!buckets.has(k))buckets.set(k,{p:[],uv:[],c:[],ix:[],x:(ix+.5)*step,z:(iz+.5)*step,kind,plot,key:k});
    return buckets.get(k);
  }
  function vertex(b,x,y,z,u,v,c) {
    const i=b.p.length/3;b.p.push(x-b.x,y,z-b.z);b.uv.push(Math.round(u*65535),Math.round(v*65535));b.c.push(...c.map(s=>Math.min(255,Math.max(0,Math.round(s*255)))));return i;
  }
  const tone=(hex)=>new T.Color(hex).toArray();
  const bases=['#647f43','#738849','#698343','#748847','#829348'].map(tone);
  const tips=['#a6b663','#b1bc64','#98b36b','#a4b45e','#b9ba6b'].map(tone);
  function blade(b,x,y,z,a,h,w,bend,c0,c1,twist) {
    const dx=Math.cos(a),dz=Math.sin(a),px=-dz,pz=dx, m=.52;
    const mid=c0.map((v,i)=>v*(1-m)+c1[i]*m),sh=c0.map(v=>v*.92),hil=mid.map(v=>v*1.10);
    const v0=vertex(b,x-px*w,y,z-pz*w,0,0,sh),v1=vertex(b,x+px*w,y,z+pz*w,1,0,c0);
    const xx=x+dx*bend*.29,zz=z+dz*bend*.29;
    const vl=vertex(b,xx-px*w*.64,y+h*.57,zz-pz*w*.64,0,.57,mid);
    const vr=vertex(b,xx+px*w*.43,y+h*.60,zz+pz*w*.43,1,.60,hil);
    const tip=vertex(b,x+dx*bend+px*twist,y+h,z+dz*bend+pz*twist,.50,1,c1);
    b.ix.push(v0,v1,vl,v1,vr,vl,vl,vr,tip);
  }
  function card(b,x,y,z,a,w,h,slot,tint) {
    const dx=Math.cos(a),dz=Math.sin(a),sx=-dz,sz=dx;
    const left=(slot+.012)/8,right=(slot+.988)/8;
    const lean=h*.132;
    const i=vertex(b,x-w*dx,y,z-w*dz,left,0,tint);
    vertex(b,x+w*dx,y,z+w*dz,right,0,tint);
    vertex(b,x+w*dx*.88+lean*sx,y+h,z+w*dz*.88+lean*sz,right,1,tint);
    vertex(b,x-w*dx*.88+lean*sx,y+h,z-w*dz*.88+lean*sz,left,1,tint);
    b.ix.push(i,i+1,i+3,i+1,i+2,i+3);
  }
  const patch=(x,z)=>.5+.19*Math.sin(x*.138+z*.066)+.13*Math.cos(x*.059-z*.152)+.09*Math.sin(x*.33+z*.18)+.08*Math.cos(x*.012+z*.058);
  const focusX=0,focusZ=88;
  const radial=(x,z)=>Math.hypot((x-focusX)*.95,z-focusZ);
  let clusters=0, individual=0, cardsCount=0;
  // Feather the near belt around the creek viewpoint. Rooted, curved ribbons
  // remain recognizable even when orbiting beneath an oblique camera angle.
  for(let i=0;i<19000;i++) {
    const a=rand()*tau,rr=68*Math.sqrt(rand()),x=focusX+rr*Math.cos(a)/.95,z=focusZ+rr*Math.sin(a);
    const density=patch(x,z)*(.45+.56*Math.max(0,1-(rr-25)/43));
    if(rand()>density)continue;
    const id=destination(x,z,.29);if(id===null)continue;
    const b=tile(x,z,'blade',id),y=layout.height(x,z)-.015;
    const nb=Math.floor(num(3,7)),yaw=rand()*tau,size=num(.13,.37)*(id?.81:1),idx=Math.floor(rand()*bases.length);
    for(let j=0;j<nb;j++) {
      const angle=yaw+j*2.400+num(-.47,.47),of=num(.008,.088),hh=size*num(.58,1.18);
      blade(b,x+Math.cos(angle)*of,y,z+Math.sin(angle)*of,angle,hh,hh*num(.038,.078),hh*num(.28,.83),bases[idx],tips[(idx+(rand()<.37?1:0))%tips.length],hh*num(-.12,.12));individual++;
    }
    clusters++;
  }
  function scatter(x,z,far) {
    if(rand()>.47+patch(x,z)*.41)return;
    const s=num(.39,.74)*(far?1.24:1),id=destination(x,z,s*.92);
    if(id===null)return;
    const b=tile(x,z,'card',id), y=layout.height(x,z)-.019, yaw=num(0,tau), slot=Math.floor(rand()*8);
    const density = num(.80,1.03),tint=[density*num(.94,1.02),density,density*num(.89,1.0)],h=s*num(.48,.79)*(id?.85:1),panels=far && rand()<.72?1:2;
    for(let k=0;k<panels;k++) {card(b,x,y,z,yaw+k*1.36,s*num(.51,.73),h*num(.80,1.12),(slot+k*3)%8,tint);cardsCount++;}
    clusters++;
  }
  // Looser stands cover the whole world without repeating a field tile or
  // carrying near-camera density across a square kilometre.
  for(let i=0;i<42000;i++) {
    const a=rand()*tau,rr=188*Math.pow(rand(),.65);scatter(focusX+rr*Math.cos(a),focusZ+rr*Math.sin(a),false);
  }
  for(let i=0;i<35000;i++) {
    const x=num(-worldW*.49,worldW*.49),z=num(-worldD*.49,worldD*.49);
    if(radial(x,z)<115)continue;
    scatter(x,z,true);
  }
  let triangles=0,memory=0,removablePlots=0;
  for(const b of buckets.values()) {
    if(!b.ix.length)continue;
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(b.p,3));g.setAttribute('color',new T.Uint8BufferAttribute(b.c,3,true));g.setAttribute('uv',new T.Uint16BufferAttribute(b.uv,2,true));
    g.setIndex(b.ix);g.computeBoundingSphere();
    triangles+=g.index.count/3;memory+=g.index.array.byteLength+Object.values(g.attributes).reduce((s,v)=>s+v.array.byteLength,0);
    const m=new T.Mesh(g,b.kind==='blade'?blades:cards);m.name=`Turf ${b.key}`;m.position.set(b.x,0,b.z);
    m.userData={...flags,detail:b.kind==='blade'?'near':'cluster',...(b.plot?{grassPlotId:b.plot}:{})};if(b.plot)removablePlots++;
    group.add(m);
  }
  group.userData.stats={clusters,individualBlades:individual,clusterPanels:cardsCount,triangles,geometryBytes:memory,meshCount:group.children.length,plotMeshes:removablePlots};
  root.add(group);return group;
}
