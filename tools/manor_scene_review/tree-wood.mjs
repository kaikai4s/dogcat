const TAU = Math.PI * 2;
const SPECIES = {
  bloom: {map:'bark-cherry.jpg', name:'Flowering cherry', fallback:0x786159, radius:.046, spread:.40, drift:.10, down:.022, leaf:.069, crown:.61, rise:.25, top:.946, root:5},
  oak: {map:'bark-oak.jpg', name:'English oak', fallback:0x6d5d49, radius:.054, spread:.44, drift:.055, down:.012, leaf:.069, crown:.67, rise:.23, top:.959, root:6},
  apple: {map:'bark-apple.jpg', name:'Orchard apple', fallback:0x826c54, radius:.044, spread:.40, drift:.080, down:.044, leaf:.067, crown:.61, rise:.22, top:.902, root:5},
  birch: {map:'bark-birch.jpg', name:'Silver birch', fallback:0xc4b89e, radius:.027, spread:.23, drift:.071, down:.069, leaf:.053, crown:.64, rise:.29, top:.974, root:4},
};

class BarkBatch {
  constructor(T,name,material) {
    Object.assign(this,{T,name,material,positions:[],uvs:[],colors:[],indices:[],seams:[]});
  }
  tube(points,sides,phase,flutes,divisions=1,shade=1,offset=0) {
    const {T,positions,uvs,colors,indices,seams}=this;
    const knots=points.map(([x,y,z])=>new T.Vector3(x,y,z));
    const curve=knots.length===2?new T.LineCurve3(...knots):new T.CatmullRomCurve3(knots);
    const steps=(points.length-1)*divisions, stride=sides+1, first=positions.length/3;
    const axis=new T.Vector3(),u=new T.Vector3(1,0,0),v=new T.Vector3(),last=new T.Vector3();
    let length=0;
    for(let i=0;i<=steps;i++) {
      const t=i/steps,center=curve.getPoint(t),segment=Math.min(Math.floor(i/divisions),points.length-2);
      const r0=points[segment][3], radius=r0+(points[segment+1][3]-r0)*(i/divisions-segment);
      curve.getTangent(t,axis).normalize();
      u.addScaledVector(axis,-u.dot(axis));
      if(u.lengthSq()<1e-5)u.set(0,0,1).addScaledVector(axis,-axis.z);
      u.normalize();v.crossVectors(u,axis).normalize();
      if(i)length+=last.distanceTo(center);last.copy(center);
      const row=positions.length/3;
      for(let j=0;j<=sides;j++) {
        const a=phase+(j%sides)*TAU/sides;
        const r=radius*flutes[j%sides], dx=r*Math.cos(a), dz=r*Math.sin(a);
        positions.push(center.x+dx*u.x+dz*v.x,center.y+dx*u.y+dz*v.y,center.z+dx*u.z+dz*v.z);
        uvs.push(j/sides,offset-length/3.65);
        const light=255*Math.min(1,shade*(.90+.10*Math.min(1,t*3))*(.97+.03*Math.sin(a*3+phase)));
        const moss=points[0][4]??0;
        const stain=moss*(1-Math.min(1,t*2.6))*(.54+.46*Math.sin(a+phase)**2);
        colors.push(Math.round(light*(1-.31*stain)),Math.round(light*(1-.09*stain)),Math.round(light*(1-.40*stain)));
        if(i>0&&j<sides)indices.push(row-stride+j,row+j,row-stride+j+1,row-stride+j+1,row+j,row+j+1);
      }
      seams.push(row,row+sides);
    }
    // The end can be visible on a short twig. The base is inside its parent or the ground.
    const ring=first+steps*stride, tip=positions.length/3;
    positions.push(...last.toArray());uvs.push(.5,offset-length/3.65);colors.push(185,177,162);
    for(let j=0;j<sides;j++)indices.push(tip,ring+j+1,ring+j);
  }
  mesh() {
    const {T,positions,uvs,colors,indices,seams,name,material}=this, geo=new T.BufferGeometry();
    geo.setAttribute('position',new T.Float32BufferAttribute(positions,3));
    geo.setAttribute('uv',new T.Float32BufferAttribute(uvs,2));
    geo.setAttribute('color',new T.Uint8BufferAttribute(colors,3,true));
    geo.setIndex(indices);geo.computeVertexNormals();
    const n=geo.attributes.normal, a=new T.Vector3(),b=new T.Vector3();
    for(let i=0;i<seams.length;i+=2) {
      const x=seams[i], y=seams[i+1];
      a.fromBufferAttribute(n,x).add(b.fromBufferAttribute(n,y)).normalize();
      n.setXYZ(x,a.x,a.y,a.z);n.setXYZ(y,a.x,a.y,a.z);
    }
    geo.computeBoundingSphere();
    const mesh=new T.Mesh(geo,material);mesh.name=name;mesh.castShadow=mesh.receiveShadow=true;return mesh;
  }
}

export function treeWood(T,width,depth,textures) {
  const batches=new Map(),materials=new Map();
  return {
    batch(kind,x,z,landmark=false) {
      const type=kind in SPECIES?kind:'oak', species=SPECIES[type];
      const col=Math.floor((x/width+.5)*4), row=Math.floor((z/depth+.5)*3);
      const name=`${landmark?'Landmark trees':'Canopy'} ${col}_${row} | ${species.name} bark`;
      if(!batches.has(name)) {
        if(!materials.has(type)) {
          const map=textures[species.map]??null;
          if(map) {map.wrapS=map.wrapT=T.RepeatWrapping;map.anisotropy=4;}
          materials.set(type,new T.MeshStandardMaterial({name:species.name+' | Woodland bark',map,color:map?0xffffff:species.fallback,vertexColors:true,roughness:.98}));
        }
        batches.set(name,new BarkBatch(T,name,materials.get(type)));
      }
      return batches.get(name);
    },
    addTo(group) {for(const batch of batches.values())if(batch.indices.length)group.add(batch.mesh());},
  };
}

export function sculptLandmark(T,wood,x,y,z,h,kind,ground,anchors,fruit) {
  const s=SPECIES[kind], birch=kind==='birch', oak=kind==='oak';
  let seed=(Math.imul(Math.round(x*41),257)^Math.imul(Math.round(z*53),131)^0x4569c)>>>0;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const pick=(a,b)=>a+(b-a)*rand(), yaw=pick(0,TAU), r=s.radius;
  const V=(x,y,z)=>new T.Vector3(x,y,z), heading=a=>V(Math.cos(a),0,Math.sin(a));
  const shift=(base,dir,reach,lift)=>base.clone().addScaledVector(dir,reach).add(V(0,lift,0));
  const coordinates=p=>[x+h*p.x,y+h*p.y,z+h*p.z];
  const tube=(knots,radii,sides,divisions,shade=1,moss=0)=>{
    const phase=pick(0,TAU),flutes=Array.from({length:sides},(_,i)=>pick(.955,1.052)+.043*Math.sin(i*TAU/sides*3+phase));
    wood.tube(knots.map((p,i)=>[...coordinates(p),radii[i]*h,i===0?moss:0]),sides,phase,flutes,divisions,shade,rand());
  };
  const sweep=heading(yaw), cross=heading(yaw+Math.PI*.5);
  const trunkPoints=[V(0,-.034,0),shift(V(0,.045,0),sweep,-.013,0),
    shift(V(0,.20,0),sweep,-s.drift*.31,0),shift(V(0,.38,0),cross,s.drift*.26,0),
    shift(V(0,.55,0),sweep,s.drift*.54,0),shift(V(0,.71,0),sweep,s.drift*.85,0),
    shift(V(0,s.top-.091,0),sweep,s.drift*1.44,0),shift(V(0,s.top,0),sweep,s.drift*1.72,0)];
  const thickness=[r*1.64,r*1.08,r*.88,r*.69,r*.52,r*.35,r*.19,r*.044];
  const trunk=new T.CatmullRomCurve3(trunkPoints);
  tube(trunkPoints,thickness,14,3,1,.63);
  for(let i=0;i<s.root;i++) {
    const a=yaw+i*TAU/s.root+pick(-.34,.34), dir=heading(a),reach=pick(.088,oak?.212:.167);
    const at=(d,level)=>{const p=shift(V(0,0,0),dir,d,0), [px,,pz]=coordinates(p);p.y=(ground(px,pz)-y)/h+level;return p;};
    tube([at(r*.5,.053),at(reach*.48,.013),at(reach*.82,-.003),at(reach,-.028)],
      [r*pick(.54,.72),r*.35,r*.18,r*.027],9,3,.89,.76);
  }

  const foliage=(p,dir,size,lower=false,terminal=false)=>{
    const [px,py,pz]=coordinates(p),n=dir.clone().normalize();
    anchors.push({x:px,y:py,z:pz,dx:n.x,dy:n.y,dz:n.z,size:h*size,kind,hero:true,lower,terminal,sunward:Math.min(1,Math.max(0,(p.y-.56)/.43))});
  };
  const arms=birch?8:9;
  for(let k=0;k<arms;k++) {
    const f=k/(arms-1),a=yaw+k*2.39996+pick(-.28,.30),dir=heading(a),side=heading(a+Math.PI*.5);
    const start=trunk.getPoint(.30+.54*f+pick(-.014,.014));
    const reach=s.spread*(1-.74*f*f)*pick(.70,1.08)*(birch&&k===0?.74:1);
    const lift=Math.max(.068,s.crown+s.rise*f+pick(-.052,.06)-start.y);
    const crook=pick(-.21,.21)*reach;
    const armPoints=[start,shift(start,dir,reach*.23,lift*(oak?.40:.48)).addScaledVector(side,crook),
      shift(start,dir,reach*.62,lift*.72).addScaledVector(side,crook*.64),shift(start,dir,reach,lift).addScaledVector(side,-crook*.25)];
    const arm=new T.CatmullRomCurve3(armPoints),radius=r*(.64-.37*f)*pick(.82,1.12);
    tube(armPoints,[radius,radius*.72,radius*.40,radius*.11],10,3,.91+.08*f);
    const shots=(birch?3:4)+(k<5?1:0);
    for(let j=0;j<shots;j++) {
      const t=.37+j*.59/(shots-1),base=arm.getPoint(t),sign=(j+k)%2===0?-1:1;
      const theta=a+sign*pick(.44,1.22),branchDir=heading(theta);
      const reach2=pick(.075,.139)*(1-.44*f)*(birch?.83:1), drop=(j===0||birch)?s.down:0;
      const tipRise=pick(.012,.088)*(1-.43*f)-drop;
      const branchPoints=[base,shift(base,branchDir,reach2*.57,tipRise*.48+.018),shift(base,branchDir,reach2,tipRise)];
      const rad=radius*(.38-.23*j/(shots-1));
      tube(branchPoints,[rad,rad*.58,rad*.105],7,2,.93);
      const end=branchPoints[2], branch=new T.CatmullRomCurve3(branchPoints),lower=j===0&&f<.55;
      foliage(end,branchDir.clone().add(V(0,tipRise/reach2,0)),s.leaf*pick(.83,1.23)*(lower?.85:1),lower);
      for(const side of [-1,1]) {
        const origin=branch.getPoint(pick(.54,.81)),twigDir=heading(theta+side*pick(.48,1.08));
        const twigReach=pick(.039,.083)*(1-.32*f),rise=pick(-.023,.058)-(birch?.038:0);
        const tip=shift(origin,twigDir,twigReach,rise);
        tube([origin,shift(origin,twigDir,twigReach*.53,rise*.48+.007),tip],[rad*.5,rad*.24,.0014],5,1,.92);
        foliage(tip,twigDir.clone().add(V(0,rise/twigReach,0)),s.leaf*pick(.60,.97),lower,true);
      }
      if(kind==='apple'&&fruit&&(k+j*3)%4===0) {
        const base=branch.getPoint(.86),drop=pick(.029,.054),apple=shift(base,branchDir,.014,-drop);
        tube([base,apple],[.0018,.0013],5,1);
        apple.y-=.009;
        fruit(...coordinates(apple),h*pick(.009,.015));
      }
    }
  }
  for(let j=0;j<5;j++) {
    const base=trunk.getPoint(.83+j*.036),dir=heading(yaw+j*2.39996),len=pick(.039,.070),rise=pick(.016,.055);
    const tip=shift(base,dir,len,rise);
    tube([base,shift(base,dir,len*.52,rise*.42),tip],[r*.20,r*.12,.0016],6,1,.96);
    foliage(tip,dir.clone().add(V(0,.59,0)),s.leaf*pick(.64,.88));
  }
}
