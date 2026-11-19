import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const turn = 2 * Math.PI;
const cube = new T.BoxGeometry(1, 1, 1);
const stone = new T.IcosahedronGeometry(1, 1);
const up = new T.Vector3(0, 1, 0);
const vec = (x, y, z) => new T.Vector3(x, y, z);

// Finish groups with a single mesh for each material, so hundreds of joints,
// leaves and pavers are still inexpensive to orbit on a phone.
function layer(parent, name) {
  const node = new T.Group();
  node.name = name;
  parent.add(node);
  const bins = new Map();
  const add = (mat, geometry, shadow = true) => {
    const key = mat.id + ':' + shadow;
    if (!bins.has(key)) bins.set(key, { mat, shadow, pieces: [] });
    bins.get(key).pieces.push(geometry.index ? geometry.toNonIndexed() : geometry);
    if (geometry.index) geometry.dispose();
  };
  const box = (mat, x, y, z, w, h, d, angle = 0, shadow = true) =>
    add(mat, cube.clone().scale(w, h, d).rotateY(angle).translate(x, y, z), shadow);
  const slab = (mat, x0, z0, x1, z1, top, depth, shadow = false) =>
    box(mat, (x0+x1)/2, top-depth/2, (z0+z1)/2, x1-x0, depth, z1-z0, 0, shadow);
  const stem = (mat, a, b, r0, r1, segments = 6) => {
    const delta = b.clone().sub(a), len = delta.length();
    if (len <= .001) return;
    const q = new T.Quaternion().setFromUnitVectors(up, delta.normalize());
    add(mat, new T.CylinderGeometry(r1, r0, len, segments, 1, true).applyQuaternion(q).translate(...a.clone().lerp(b, .5)));
  };
  const finish = () => {
    for (const { mat, shadow, pieces } of bins.values()) {
      const g = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces);
      if (!g) throw new Error('Incompatible garden geometry: ' + mat.name);
      if (pieces.length > 1) pieces.forEach(p => p.dispose());
      const mesh = new T.Mesh(g, mat);
      mesh.name = mat.name;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      node.add(mesh);
    }
    bins.clear();
  };
  return { node, add, box, slab, stem, finish };
}

function material(name, color, roughness = .9, extra = {}) {
  return new T.MeshStandardMaterial({ name, color, roughness, ...extra });
}
function palette(name, colors) { return colors.map((color, i) => material(name + ' ' + (i+1), color)); }

function pebble(layer, mat, x, y, z, w, h, d, random, cast = true) {
  const geo = stone.clone(), p = geo.attributes.position, angle = random() * turn, noise = random()*4;
  for (let i=0; i<p.count; i++) {
    const [a,b,c] = [p.getX(i), p.getY(i), p.getZ(i)];
    const r = 1 + .12 * Math.sin(a*5.7 + b*4.9 + c*7 + noise) * Math.cos(a*4 - c*5);
    p.setXYZ(i, a*r, b*r, c*r);
  }
  geo.scale(w, h, d).rotateY(angle).translate(x, y, z);
  geo.computeVertexNormals();
  layer.add(mat, geo, cast);
}

function vertexTone(g, from, to, value) {
  const colors = [], p = g.attributes.position, c = new T.Color();
  for (let i=0; i<p.count; i++) {
    c.copy(from).lerp(to, value(p.getX(i), p.getZ(i), i));
    colors.push(c.r,c.g,c.b);
  }
  g.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
}

export function addGarden(group) {
  let seed = 48271;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = list => list[Math.floor(rand()*list.length)];
  const pale = palette('Brushed courtyard limestone', [0xcac5b8,0xd5ccba,0xbdbfb2,0xc6c5ba,0xd9d4c7]);
  const granite = palette('West parking granite setts', [0x9d9e95,0xa6a598,0xb2ada2,0xa7a89e]);
  const rocks = palette('Weathered garden stone', [0x949280,0xacaa97,0x767d72,0xb9b09b]);
  const joint = material('Permeable paving joints',0x959889);
  const bronze = material('Dark bronze fittings', 0x3e4841, .64, {metalness:.23});
  const wood = material('Outdoor teak battens', 0x8e6a4d);
  const textile = material('Outdoor linen',0xdfd4b8);
  const moss = material('Sage outdoor cushion',0x768267);
  const ivory = material('Mineral perimeter wall',0xd7d4c7);
  const cap = material('Graphite perimeter coping',0x50574d);
  const lamp = material('Lamp:Garden frosted amber',0xffdfad,.41,{emissive:0xffc686,emissiveIntensity:.09});
  function tessellate(target, mats, x0, z0, x1, z1, sx, sz, y) {
    target.slab(joint,x0,z0,x1,z1,.027,.044);
    for (let row=0,z=z0; z<z1-.07; z+=sz,row++) {
      for (let x=x0-(row%2)*sx*.5; x<x1-.07; x+=sx) {
        const l=Math.max(x,x0)+.010,r=Math.min(x+sx,x1)-.010;
        const a=z+.010,b=Math.min(z+sz,z1)-.010;
        if (r-l>.035 && b-a>.035) target.slab(pick(mats),l,a,r,b,y,.029);
      }
    }
  }

  const site = layer(group, 'Site and north arrival');
  site.slab(material('Exposed limestone site base',0xa7a397),-5,-8,21,28,-.009,.34);
  const lawn = new T.PlaneGeometry(26,36,36,48).rotateX(-Math.PI/2).translate(8,0,10);
  vertexTone(lawn,new T.Color(0x708263),new T.Color(0x99a17a),(x,z) => .48 + .17*Math.sin(x*.54+z*.75) + .19*Math.cos(x*.37-z*.44)+.12*Math.sin(x*1.4+z*2.1)+.05*(rand()-.5));
  site.add(material('Variegated sage lawn',0xffffff,.97,{vertexColors:true}),lawn,false);
  site.slab(material('North approach gravel',0x94988f),-5,-8,21,-6.75,.023,.04);
  tessellate(site,granite,-4.78,-6.75,-.30,5.52,.57,.75,.039);
  for (const x of [-4.15,-1.42]) site.box(pale[3],x,.043,.30,.07,.009,9.97,0,false);
  for (const z of [-4.67,.30,5.27]) for (let j=0;j<7;j++) site.box(pale[3],-3.98+j*.39,.043,z,.31,.009,.075,0,false);
  tessellate(site,pale,-.30,-3.88,6.43,-2.42,1.09,.72,.040);
  tessellate(site,pale,6.43,-6.75,8.97,-.89,.85,.80,.041);
  site.slab(pale[2],6.40,-.94,9.00,-.51,.106,.11,true);
  site.slab(pale[1],6.51,-.51,8.89,0,.216,.22,true);
  for (const [x,z,w,d,h] of [[-4.77,16.27,.24,21.88,.83],[20.76,10.69,.25,33.42,.91],[8,27.67,25.25,.26,.73],[-1.5,-6.21,4.55,.23,.66],[14.47,-6.21,10.39,.23,.66]]) {
    site.box(ivory,x,h/2,z,w,h,d);
    site.box(cap,x,h+.035,z,w+.075,.07,d+.075);
  }
  site.finish();

  const path = layer(group, 'Central path and south reception court');
  tessellate(path,pale,6.48,15.10,9.12,25.45,.88,1.02,.045);
  tessellate(path,pale,4.80,25.45,10.78,27.08,1.19,.79,.049);
  path.slab(pale[2],6.42,14.54,9.18,15.10,.108,.112,true);
  path.slab(pale[1],6.52,14,9.08,14.54,.216,.22,true);
  for (const x of [6.39,9.21]) path.box(pale[2],x,.031,20.28,.18,.064,10.32,0,false);
  for (const [x,z,w,d] of [[5.92,20.49,.66,1.01],[5.09,20.59,.79,1.06],[9.76,19.30,.73,1.09],[9.75,18.17,.63,1.00]]) path.box(pick(pale),x,.031,z,w,.061,d);
  path.finish();

  const pool = layer(group,'East reflecting pool');
  const x0=10.40,z0=16.35,x1=18.70,z1=23.80, trim=.28;
  pool.slab(material('Dark slate basin',0x344742),x0,z0,x1,z1,.031,.049);
  const coping = material('Honed dark pool coping',0x535e57,.56);
  for (const a of [[x0,z0,x1,z0+trim],[x0,z1-trim,x1,z1],[x0,z0+trim,x0+trim,z1-trim],[x1-trim,z0+trim,x1,z1-trim]]) pool.slab(coping,...a,.163,.164,true);
  const w=x1-x0-2*trim+.007,d=z1-z0-2*trim+.007;
  const water = new T.PlaneGeometry(w,d,34,38).rotateX(-Math.PI/2), p=water.attributes.position;
  vertexTone(water,new T.Color(0x4a6263),new T.Color(0x829c97),(x,z,i) => {
    const nearEdge=Math.min(w/2-Math.abs(x),d/2-Math.abs(z));
    const wave=Math.sin(z*4.1 + .55*Math.sin(x*1.7) + .18*x)+.5*Math.sin(x*2.7-z*3.7);
    p.setY(i,.003*Math.min(1,nearEdge*3)*wave);
    return (.42+.18*Math.sin(z*.5+x*.8)**2+.12*wave) * Math.min(1,nearEdge/.88);
  });
  water.computeVertexNormals(); water.translate((x0+x1)/2,.077,(z0+z1)/2);
  pool.add(material('Reflecting pool water',0xffffff,.185,{metalness:.23,vertexColors:true}),water,false);
  pebble(pool,rocks[2],18.42,.13,23.60,.62,.33,.45,rand);
  pebble(pool,rocks[1],18.00,.095,23.87,.32,.22,.32,rand);
  pebble(pool,rocks[2],18.82,.085,23.25,.42,.25,.35,rand);
  pool.finish();

  const planting = layer(group,'Bamboo and grasses in stone beds');
  const mulch=material('Charcoal planting mulch',0x626654), bamboo=material('Bamboo culm',0x859063), nodes=material('Bamboo growth rings',0x5e734e);
  const leafMat=material('Leaf blades and grass',0xffffff,.95,{vertexColors:true,side:T.DoubleSide});
  const leafColors = [0x506848,0x68805b,0x7d8c60,0x8e9667,0x9ca577,0x738562].map(c=>new T.Color(c));
  const leafPoints=[], leafTones=[];
  function blade(a,b,w) {
    const delta = b.clone().sub(a);
    const cross = vec(-delta.z,0,delta.x).normalize().multiplyScalar(w);
    const mid=a.clone().lerp(b,.46), tip=mid.clone().add(vec(0,w*.48,0));
    const l=mid.clone().sub(cross), r=mid.clone().add(cross);
    leafPoints.push(...a,...l,...tip,...a,...tip,...r,...l,...b,...tip,...r,...tip,...b);
    const color=pick(leafColors);
    for (let i=0;i<12;i++) leafTones.push(color.r,color.g,color.b);
  }
  const beds=[[-3.43,17.97,1.02,2.84,25],[-3.39,24.38,1.08,2.13,19],
    [.70,20.10,1.71,1.11,24],[2.03,23.96,2.02,.87,22],[19.48,18.76,.93,4.25,35],
    [15.60,24.65,3.16,.67,24],[12.1,15.73,2.1,.49,13],[11.55,26.76,.78,.50,12],
    [19.54,8.45,.92,4.67,27],[18.68,-.83,1.41,2.77,25],[2.22,-1.57,1.76,.59,16],[12.43,-2.22,2.35,1.05,24]];
  for (const [x,z,rx,rz,n] of beds) {
    const shape=new T.Shape();
    for (let i=0;i<28;i++) {
      const a=i/28*turn,r=.88+rand()*.20;
      const u=rx*Math.cos(a)*r,v=-rz*Math.sin(a)*r;
      if(i===0)shape.moveTo(u,v); else shape.lineTo(u,v);
    }
    shape.closePath();
    planting.add(mulch,new T.ShapeGeometry(shape).rotateX(-Math.PI/2).translate(x,.013,z),false);
    for (let i=0;i<n;i++) {
      const a=rand()*turn,r=Math.sqrt(rand())*.84;
      const u=x+Math.cos(a)*rx*r,v=z+Math.sin(a)*rz*r,h=.16+rand()*.44;
      for(let j=0;j<9;j++) {
        const th=rand()*turn,back=rand()*h*.37,length=.14+rand()*.50;
        const gx=u+Math.cos(th)*back,gz=v+Math.sin(th)*back;
        blade(vec(gx,.015,gz),vec(gx+Math.cos(th)*h*length,.018+h*(.43+rand()*.76),gz+Math.sin(th)*h*length),h*(.019+rand()*.048));
      }
      if(i%3===0) {
        const s=.066+rand()*.14;
        pebble(planting,pick(rocks),u,s*.22,v,s,s*.57,s*.84,rand,false);
      }
    }
  }
  for (const [cx,cz,n,h] of [[19.25,16.78,7,2.58],[19.23,20.45,7,2.68],[19.32,23.39,8,2.88],[19.28,7.61,6,2.35],[-3.25,17.20,8,2.9],[-3.23,24.58,7,2.58]]) {
    for (let i=0;i<n;i++) {
      const th=rand()*turn,s=.15+rand()*.49, height=h*(.71+rand()*.42);
      const x=cx+Math.cos(th)*s,z=cz+Math.sin(th)*s;
      let previous=vec(x,.027,z);
      for (let j=1;j<=8;j++) {
        const t=j/8,bow=t*t*(.21+s*.33),r=.034*(1-t*.73);
        const a=vec(x+Math.cos(th)*bow,.027+t*height,z+Math.sin(th)*bow);
        planting.stem(bamboo,previous,a,r*1.12,r,5);
        if(j<8) planting.stem(nodes,a,a.clone().add(vec(0,.027,0)),r*1.24,r*1.14,6);
        if(j>=3) for(let side=0;side<2;side++) {
          const az=th+j*2.43+side*2.63, reach=(.22+rand()*.25)*(1.06-t*.15);
          const twig=vec(a.x+Math.cos(az)*reach,a.y+.12,a.z+Math.sin(az)*reach);
          planting.stem(bamboo,a,twig,.009,.003,4);
          for(let b=0;b<5;b++) {
            const stem=a.clone().lerp(twig,.34+b*.15), p=az+(-1)**b*(.41+rand()*.64), length=.12+rand()*.14;
            blade(stem,vec(stem.x+Math.cos(p)*length,stem.y-.03+rand()*.08,stem.z+Math.sin(p)*length),.019+rand()*.013);
          }
        }
        previous=a;
      }
    }
  }
  for (const [x,z,w,h,d] of [[5.02,23.51,.72,.32,.53],[4.46,23.73,.38,.23,.44],[-2.4,19.31,.50,.29,.56],[12.45,-2.09,.68,.29,.49],[13.23,-2.36,.48,.23,.45],[12.02,-1.55,.35,.18,.37]]) pebble(planting,rocks[1],x,h*.40,z,w,h,d,rand);
  const leaves=new T.BufferGeometry();
  leaves.setAttribute('position',new T.Float32BufferAttribute(leafPoints,3)); leaves.setAttribute('color',new T.Float32BufferAttribute(leafTones,3));
  leaves.computeVertexNormals(); planting.add(leafMat,leaves,false); planting.finish();

  const pine=layer(group,'West sculptural pine');
  const bark=material('Pine ridged bark',0xffffff,.97,{vertexColors:true});
  const pineGreen=palette('Pine needle crowns',[0x465841,0x506348,0x5e6d4b,0x6b7a53]);
  const bx=.70,bz=20.10, trunk=[],barkTones=[], idx=[];
  function branch(points, r0, r1) {
    const curve=new T.CatmullRomCurve3(points.map(([x,y,z])=>vec(x+bx,y,z+bz)));
    const rings=Math.ceil(curve.getLength()*5)+3, sides=r0>.17?13:8;
    const frames=curve.computeFrenetFrames(rings,false), ridges=Array.from({length:sides},()=>.86+rand()*.28);
    const start=trunk.length/3, color=new T.Color();
    for(let j=0;j<=rings;j++) {
      const t=j/rings,pos=curve.getPointAt(t), r=(r1+(r0-r1)*(1-t)**1.08)*(1+.047*Math.sin(t*29));
      for(let i=0;i<sides;i++) {
        const theta=i/sides*turn+.16*t,rad=r*ridges[i]*(1+.05*Math.sin(i*2+t*16));
        trunk.push(...pos.clone().addScaledVector(frames.normals[j],Math.cos(theta)*rad).addScaledVector(frames.binormals[j],Math.sin(theta)*rad));
        color.setHex(i%4===0?0x453d32:i%2===0?0x665441:0x78644c).multiplyScalar(.84 + .31*rand());
        barkTones.push(color.r,color.g,color.b);
        if(j<rings){const a=start+j*sides+i,b=start+j*sides+(i+1)%sides;idx.push(a,b,a+sides,b,b+sides,a+sides);}
      }
    }
    return curve;
  }
  branch([[0,.014,0],[-.27,.58,.08],[-.08,1.23,.12],[.54,1.99,.27],[.76,2.67,.06],[.60,3.23,-.24],[.85,3.86,-.15],[1.06,4.30,.05]],.31,.024);
  const boughs=[
    [[[-.06,1.33,.14],[-.8,1.75,.41],[-1.54,2.13,.40],[-2.30,2.32,.46]],.145,[-1.89,2.51,.47,1.19,.31,.71]],
    [[[.54,1.99,.27],[1.30,2.15,.54],[2.1,2.36,.69],[2.91,2.57,.54]],.14,[2.42,2.73,.64,1.1,.33,.72]],
    [[[.70,2.43,.18],[.81,2.70,1.1],[1.03,2.85,1.86]],.083,[1.05,2.99,1.67,.68,.31,.86]],
    [[[.74,2.78,.02],[.04,3.04,-.23],[-.68,3.28,-.68],[-1.5,3.58,-.70]],.102,[-1.04,3.70,-.61,1.05,.32,.66]],
    [[[.61,3.12,-.23],[1.32,3.19,-.73],[2.21,3.48,-1.14]],.089,[1.96,3.64,-1.03,.87,.31,.66]],
    [[[.68,3.47,-.20],[.32,3.66,.47],[.12,3.83,1.01]],.056,[.15,3.96,.84,.71,.33,.60]],
    [[[.85,3.86,-.16],[.79,4.17,-.32],[1.12,4.41,.07]],.051,[1.06,4.53,-.09,.79,.38,.58]]
  ];
  for(const [points,r,[x,y,z,rx,ry,rz]] of boughs){
    const curve=branch(points,r,.011);
    for(let i=0;i<22;i++) {
      const q=rand()*turn, f=Math.sqrt(rand())*.91, u=x+Math.cos(q)*f*rx,v=z+Math.sin(q)*f*rz,h=y+(.5-f)*ry*.51+(rand()-.5)*ry*.73;
      if(i%5===0){const a=curve.getPointAt(.56+rand()*.39);branch([[a.x-bx,a.y,a.z-bz],[(a.x-bx+u)*.51,h-.20,(a.z-bz+v)*.50],[u,h-.086,v]],r*.34,.0037);}
      pebble(pine,pick(pineGreen),bx+u,h,bz+v,rx*(.18+rand()*.29),ry*(.29+rand()*.5),rz*(.26+rand()*.35),rand);
    }
  }
  const trunkMesh=new T.BufferGeometry();
  trunkMesh.setAttribute('position',new T.Float32BufferAttribute(trunk,3)); trunkMesh.setAttribute('color',new T.Float32BufferAttribute(barkTones,3)); trunkMesh.setIndex(idx); trunkMesh.computeVertexNormals();
  pine.add(bark,trunkMesh); pine.finish();

  const seating=layer(group,'Pine court seating and outdoor tea table');
  function chair(x,z,angle) {
    const part = (m,dx,y,dz,w,h,d) => seating.box(m,x+Math.cos(angle)*dx+Math.sin(angle)*dz,y,z-Math.sin(angle)*dx+Math.cos(angle)*dz,w,h,d,angle);
    for(const a of [-.35,.35]) {
      for(const b of [-.30,.30]) part(bronze,a,.18,b,.045,.36,.045);
      part(wood,a,.58,-.035,.057,.047,.69);
      part(bronze,a,.48,.28,.045,.20,.045);
    }
    part(wood,0,.339,0,.76,.075,.72);
    part(textile,0,.411,-.028,.68,.080,.633);
    part(wood,0,.586,-.33,.74,.43,.053);
    part(textile,0,.603,-.272,.65,.337,.10);
    part(moss,.16,.513,-.235,.25,.21,.080);
  }
  chair(3.13,18.73,.43); chair(4.91,19.80,-1.62);
  pebble(seating,rocks[3],3.88,.23,19.84,.56,.23,.50,rand);
  seating.add(wood,new T.CylinderGeometry(.21,.211,.036,20).translate(3.88,.46,19.84));
  for(const x of [3.81,3.96]) seating.add(pale[3],new T.CylinderGeometry(.036,.027,.048,9).translate(x,.502,19.84));
  for(const x of [5.88,9.76]) {
    for(const dx of [-.74,.74]) seating.box(rocks[1],x+dx,.22,26.76,.18,.43,.38);
    for(let i=0;i<4;i++) seating.box(wood,x,.463,26.55+i*.14,1.78,.076,.119);
  }
  seating.finish();

  const lighting=new T.Group(); lighting.name='Garden lanterns'; group.add(lighting);
  const posts=[[6.11,16.39],[9.45,17.62],[6.13,21.86],[9.46,24.70],[14.00,24.45],[18.84,17.08],[6.16,-5.12],[9.23,-2.98]];
  for(const [i,[x,z]] of posts.entries()) {
    const f=layer(lighting,'Garden bollard '+(i+1)); f.node.position.set(x,.018,z); f.node.userData.nightLight={color:'#ffd3a2',range:2.35};
    f.box(bronze,0,.024,0,.22,.047,.22);
    f.box(bronze,0,.105,0,.174,.18,.174);
    f.box(lamp,0,.267,0,.16,.154,.16,0,false);
    for(const a of [-1,1])for(const b of [-1,1]) f.box(bronze,a*.082,.267,b*.082,.024,.165,.024);
    f.box(bronze,0,.355,0,.21,.042,.21); f.finish();
  }
  const sconces=layer(lighting,'North entry sconces');
  for(const x of [6.17,9.28]) {
    sconces.box(bronze,x,1.38,-.132,.147,.34,.12);
    sconces.box(lamp,x,1.38,-.198,.091,.25,.035,0,false);
  }
  sconces.finish();
  return group;
}
