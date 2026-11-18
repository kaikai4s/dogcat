import {sculptLandmark, treeWood} from './tree-wood.mjs';

// All vegetation is baked into ordinary indexed meshes: the exported garden can
// be opened in glTF viewers that do not implement GPU instancing or custom shaders.
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const spraySites = new WeakMap();
export const getLeafSprayAnchors = layout => spraySites.get(layout) || [];

// The tree anchors frame the crossing in the north-facing approach.
export const heroTreeSites = [
  {x:-38,z:80,r:7.6,h:16.3,kind:'bloom'},
  {x:56,z:66,r:6.5,h:14.8,kind:'apple'},
  {x:-53,z:20,r:7.2,h:16.2,kind:'oak'},
  {x:45,z:0,r:5.9,h:13.2,kind:'bloom'},
  {x:0,z:-100,r:4.6,h:12.7,kind:'birch'},
  {x:-8,z:-106,r:4.1,h:10.3,kind:'oak'},
  {x:7,z:-108,r:3.4,h:10.6,kind:'birch'},
];

function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let v = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    v ^= v + Math.imul(v ^ (v >>> 7), 61 | v);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

class Patch {
  constructor() { this.pos = []; this.colors = []; this.indices = []; }
  point(x, y, z, color, brightness = 1) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.colors.push(...color.map(c => Math.round(255 * clamp(c * brightness, 0, 1))));
    return i;
  }
  tri(a, b, c) { this.indices.push(a, b, c); }
  between(a, b) {
    for (let j = 0; j < a.length; j++) {
      const k = (j + 1) % a.length;
      this.tri(a[j], b[j], a[k]); this.tri(a[k], b[j], b[k]);
    }
  }
  close(bottom, first, last, top) {
    for (let j = 0; j < first.length; j++) {
      const k = (j + 1) % first.length;
      this.tri(bottom, first[j], first[k]); this.tri(last[j], top, last[k]);
    }
  }
  mesh(THREE, material, name) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geom.setAttribute('color', new THREE.Uint8BufferAttribute(this.colors, 3, true));
    geom.setIndex(this.indices); geom.computeVertexNormals(); geom.computeBoundingSphere();
    const result = new THREE.Mesh(geom, material);
    result.name = name; result.receiveShadow = true; result.castShadow = true;
    return result;
  }
}

export function addFlora(THREE, root, layout, textures={}) {
  const {width, depth, height, canDecorate} = layout;
  const anchors=[]; spraySites.set(layout,anchors);
  const wood=treeWood(THREE,width,depth,textures);
  const rnd = random(0x2708b9), range = (a,b) => mix(a,b,rnd());
  const pick = list => list[Math.floor(rnd() * list.length)];
  const lin = h => new THREE.Color(h).toArray();
  const tone = (a, b, t) => a.map((v,i) => mix(v,b[i],t));
  const palette = {
    bark: ['#705947','#715440','#82664a','#665345'].map(lin),
    fir: [['#30594d','#75a17a'],['#315e56','#75a390'],['#3a6955','#8cb48c']],
    stone: [['#797f75','#b9b9a6'],['#80837f','#c3bdaf'],['#798078','#abae9c']],
    shrub: [['#49704d','#9ba75b'],['#437858','#8ead72'],['#42715c','#7aab7f']],
  };
  for (const k of ['fir','stone','shrub']) palette[k] = palette[k].map(pair=>pair.map(lin));
  const moss = lin('#91a77c');
  const leaves = ['#718f4c','#839b56','#95a967','#719062','#82a271'].map(lin);
  const petals = ['#f0cf80','#f2dc9a','#f5edda','#eee7ce','#daa5a1','#dfb1ab'].map(lin);
  const appleRed = ['#a35442','#da8c66'].map(lin), applePear = ['#989a47','#cebc67'].map(lin);
  const seeds = lin('#e1ad60');
  const material = new THREE.MeshStandardMaterial({name:'Handpainted woodland',vertexColors:true,roughness:0.98,metalness:0});
  const batches = new Map();
  const batch = (x,z,kind) => {
    const cellX = clamp(Math.floor((x / width + 0.5)*4),0,3);
    const cellZ = clamp(Math.floor((z / depth + 0.5)*3),0,2);
    const key = `${kind}_${cellX}_${cellZ}`;
    if (!batches.has(key)) batches.set(key,new Patch());
    return batches.get(key);
  };

  // Rings remain horizontal and the centerline can bend. This makes forks
  // irregular without the kinks from joining lengths of separate cylinders.
  function stem(p, points, shade, sides=7) {
    const start = range(0,TAU); let prev;
    const flutes=Array.from({length:sides},()=>range(.9,1.13));
    for (let i=0;i<points.length;i++) {
      const [x,y,z,r] = points[i], row=[];
      for (let j=0;j<sides;j++) {
        const a=start+j*TAU/sides, f=flutes[j];
        row.push(p.point(x+Math.cos(a)*r*f,y,z+Math.sin(a)*r*f,shade,(.82+.14*i/(points.length-1))*(.93+.09*Math.cos(a+.7))));
      }
      if (prev) p.between(prev,row);
      prev=row;
    }
  }

  function globe(p,x,y,z,rx,ry,rz,pair,rock=false,segments=10,layers=4) {
    const phase=range(0,TAU), phase2=range(0,TAU), yaw=range(0,TAU), rot=range(0,TAU);
    const bulge=Array.from({length:segments},(_,j)=>1+.067*Math.sin(3*j*TAU/segments+phase)+range(-.05,.05));
    const bottom=p.point(x,y-ry,z,pair[0],.83), top=p.point(x+.06*rx,y+ry,z-.05*rz,rock?tone(pair[1],moss,.22):pair[1],1.01);
    let prev,first;
    for(let k=1;k<=layers;k++) {
      const angle=-Math.PI/2+Math.PI*k/(layers+1), sy=Math.sin(angle), ring=Math.cos(angle), row=[];
      for(let j=0;j<segments;j++) {
        const a=rot+j*TAU/segments+(k%2)*.15;
        const w=bulge[j]*(1+.035*Math.sin(3*a+k+phase2)), cx=Math.cos(a), sz=Math.sin(a);
        const xx=rx*w*ring*cx, zz=rz*w*ring*sz;
        const h=sy+ring*(.045*Math.sin(3*a+phase)+range(-.025,.025));
        const lighting=clamp(.48+.44*sy+.12*(cx*.6+sz*.35)+range(-.07,.07),0,1);
        let color=tone(pair[0],pair[1],lighting);
        if(rock && k>=layers-1) color=tone(color,moss,clamp(.18+.29*Math.sin(2*a+phase2)+.2*sy,0,.52));
        row.push(p.point(x+xx*Math.cos(yaw)-zz*Math.sin(yaw),y+ry*h,z+xx*Math.sin(yaw)+zz*Math.cos(yaw),color));
      }
      if(prev) p.between(prev,row); else first=row;
      prev=row;
    }
    p.close(bottom,first,prev,top);
  }

  function deciduous(p,x,y,z,h,kind) {
    const birch=kind==='birch',bark=wood.batch(kind,x,z);
    const angle=range(0,TAU), drift=range(.055,.11)*h, dx=Math.cos(angle)*drift, dz=Math.sin(angle)*drift;
    const r=h*(birch?.024:.034), curve=h*.026,swx=-Math.sin(angle)*curve,swz=Math.cos(angle)*curve;
    const tube=(points,sides=6,subdiv=1)=>bark.tube(points,sides,range(0,TAU),Array.from({length:sides},()=>range(.92,1.08)),subdiv,.96,rnd());
    const neck=new THREE.CatmullRomCurve3([[x,y-.29,z],[x+swx*.32,y+h*.17,z+swz*.32],[x+dx*.28+swx*.68,y+h*.35,z+dz*.28+swz*.68],[x+dx*.72+swx*.38,y+h*.54,z+dz*.72+swz*.38],[x+dx,y+h*.86,z+dz]].map(v=>new THREE.Vector3(...v)));
    tube(neck.points.map((q,i)=>[...q.toArray(),r*[1.50,1,.76,.47,.088][i],i===0?.35:0]),7,2);
    const n=birch?5:7;
    for(let i=0;i<n;i++) {
      const a=angle+i*2.399963+range(-.31,.31), t=i/(n-1), reach=h*(birch?range(.16,.21):range(.235,.33))*(1-.58*t);
      const ox=Math.cos(a)*reach,oz=Math.sin(a)*reach, cy=h*(.53+.29*t+range(-.025,.025));
      const bx=x+dx*(.46+.45*t), bz=z+dz*(.46+.45*t), cx=bx+ox, cz=bz+oz;
      const start=neck.getPoint(.36+.38*t), bud=new THREE.Vector3(cx,y+cy,cz);
      const fork=start.clone().lerp(bud,.60);fork.y-=h*.034;
      tube([[...start.toArray(),r*(.56-.22*t)],[...fork.toArray(),r*.27],[cx,y+cy,cz,r*.083]],5,2);
      const mass=h*(birch?range(.119,.161):range(.124,.188));
      for(let j=0;j<(birch?3:4);j++){
        const b=a+[-1.01,.36,1.12,-.45][j]+range(-.19,.19);
        const len=mass*(j===3?.26:range(.67,1.04));
        const ex=cx+Math.cos(b)*len,ez=cz+Math.sin(b)*len,ey=y+cy+(j===0?-.25:range(.14,.68))*mass;
        if(j<2)tube([[...fork.clone().lerp(bud,.53+j*.23).toArray(),r*.19],[ex,ey,ez,r*.042]],4);
        const dy=range(-.30,.82),q=Math.sqrt(1-dy*dy);
        anchors.push({x:ex,y:ey,z:ez,dx:Math.cos(b)*q,dy,dz:Math.sin(b)*q,size:mass*range(.56,.80),kind});
      }
      if(kind==='apple'&&i%3===0) {
        const phi=a+range(-.74,.74), reach=mass*range(.82,1.03), s=h*range(.010,.016);
        globe(p,cx+Math.cos(phi)*reach,y+cy-mass*range(.05,.35),cz+Math.sin(phi)*reach,s,s*.97,s,rnd()<.66?appleRed:applePear,false,5,2);
      }
    }
    const crown=h*(birch?.145:.17);
    for(let k=0;k<4;k++){
      const a=angle+k*2.40,sy=range(.28,.83),ox=Math.cos(a),oz=Math.sin(a);
      anchors.push({x:x+dx+ox*crown*.44,y:y+h*.86+crown*sy*.58,z:z+dz+oz*crown*.44,
        dx:ox,dy:sy,dz:oz,size:crown*range(.57,.76),kind,hero:false});
    }
  }

  function conifer(p,x,y,z,h) {
    const palettePair=pick(palette.fir), r=h*range(.174,.218), leanX=h*range(-.077,.04), leanZ=h*range(-.045,.045);
    stem(p,[[x,y-.32,z,h*.037],[x,y+h*.18,z,h*.025],[x+leanX*.43,y+h*.54,z+leanZ*.43,h*.015],[x+leanX,y+h*.93,z+leanZ,h*.006]],pick(palette.bark),7);
    for(let k=0;k<6;k++) {
      const f=k/6, rad=r*(1-.83*f), yc=y+h*(.17+.13*k), cx=x+leanX*(.18+.13*k), cz=z+leanZ*(.18+.13*k);
      const yaw=range(0,TAU), sides=20, rise=h*(.29-.09*f), wob=Array.from({length:sides},()=>range(.93,1.07));
      const bottom=p.point(cx,yc-rise*.03,cz,palettePair[0],.78);
      const top=p.point(cx+leanX*.11,yc+rise,cz+leanZ*.11,palettePair[1],.97);
      const rows=[];
      for(let u=0;u<3;u++) {
        const row=[];
        for(let j=0;j<sides;j++) {
          const a=yaw+j*TAU/sides, fringe=j%2===0;
          const rad0=(u===0?(fringe?1.03:.78):u===1?(fringe?.77:.67):.35)*rad*wob[j];
          const lift=(u===0?(fringe?-.042:.026):u===1?.14:.57)*rise;
          const col=tone(palettePair[0],palettePair[1],clamp(.16+.28*u+(fringe?.105:0)+.10*Math.cos(a+1)+f*.09,0,1));
          row.push(p.point(cx+Math.cos(a)*rad0,yc+lift+rise*.045*Math.sin(3*a),cz+Math.sin(a)*rad0,col));
        }
        if(u) p.between(rows[u-1],row);
        rows.push(row);
      }
      p.close(bottom,rows[0],rows[2],top);
    }
  }

  function blade(p,x,y,z,a,h,w,color) {
    const s=Math.sin(a), c=Math.cos(a), base=p.point(x-c*w,y,z-s*w,color,.82), right=p.point(x+c*w,y,z+s*w,color,.87);
    const mid=p.point(x+s*h*.12,y+h*.48, z-c*h*.12,color,.95), tip=p.point(x+s*h*.34,y+h,z-c*h*.34,color,1.09);
    p.tri(base,mid,right); p.tri(base,tip,mid); p.tri(mid,tip,right); p.tri(base,right,tip);
  }
  function flower(p,x,y,z,s,col) {
    const a0=range(0,TAU), headY=y+s*range(.75,1.12), dx=s*range(-.13,.13),dz=s*range(-.13,.13);
    stem(p,[[x,y-.03,z,s*.042],[x+dx,headY,z+dz,s*.028]],leaves[3],4);
    const hx=x+dx,hz=z+dz;
    for(let i=0;i<5;i++) {
      const a=a0+i*TAU/5, cx=Math.cos(a),sz=Math.sin(a),rr=s*range(.13,.19),w=rr*.43;
      const base=p.point(hx,headY,hz,col,.92);
      const left=p.point(hx+cx*rr*.63-sz*w,headY+rr*.17,hz+sz*rr*.63+cx*w,col);
      const point=p.point(hx+cx*rr,headY+rr*.44,hz+sz*rr,col,1.06);
      const right=p.point(hx+cx*rr*.63+sz*w,headY+rr*.17,hz+sz*rr*.63-cx*w,col);
      p.tri(base,left,point); p.tri(base,point,right);
    }
    const p1=p.point(hx+s*.046,headY+s*.032,hz,seeds),p2=p.point(hx-s*.029,headY+s*.031,hz-s*.053,seeds),p3=p.point(hx-s*.03,headY+s*.03,hz+s*.053,seeds);
    p.tri(p1,p2,p3);
  }

  const spread=(n,e) => Math.max(Math.abs(n/width*2),Math.abs(e/depth*2));
  const allowed=(x,z,r) => Math.abs(x)+r < width/2-1 && Math.abs(z)+r < depth/2-1 && canDecorate(x,z,r);
  const treePos=[], actualHeroes=[]; const stats={trees:0,shrubs:0,boulders:0,flowers:0};
  for(const site of heroTreeSites){
    for(let k=0;k<49;k++){
      const angle=k*2.39996,reach=k===0?0:2.22*Math.sqrt(k);
      const x=site.x+Math.cos(angle)*reach,z=site.z+Math.sin(angle)*reach;
      if(!allowed(x,z,site.r)||treePos.some(t=>Math.hypot(t.x-x,t.z-z)<(t.r+site.r)*.65))continue;
      const y=height(x,z);
      sculptLandmark(THREE,wood.batch(site.kind,x,z,true),x,y,z,site.h,site.kind,height,anchors,(fx,fy,fz,r)=>{
        globe(batch(x,z,'Landmark_trees'),fx,fy,fz,r,r*.94,r,appleRed,false,8,4);
      });
      const tree={x,z,r:site.r,h:site.h};
      treePos.push(tree);actualHeroes.push({...tree,y,kind:site.kind});stats.trees++;break;
    }
  }
  const w=width*.5,d=depth*.5;
  const broad=width>700, treeLimit=broad?235:160;
  for(let tries=0;tries<(broad?880:350) && stats.trees<treeLimit;tries++) {
    const core=broad&&stats.trees<40;
    const ax=core?range(-180,180):range(-w+6,w-6), az=core?range(-157,100):range(-d+6,d-6), edge=spread(ax,az);
    if((core?Math.abs(ax)<65&&az>-110:edge<(broad?.44:.60)) || !allowed(ax,az,2.6)) continue;
    const grove=rnd(), kind=grove<.035?'fir':grove<.135?'birch':grove<.18?'bloom':grove<.44?'apple':'oak';
    const h0=kind==='apple'?range(8,12.8):range(9.5,16.8);
    const count=(core?2:3)+Math.floor(rnd()*(core?3:5)), dir=range(0,TAU);
    for(let i=0;i<count && stats.trees<treeLimit;i++) {
      const a=dir+i*2.39996, rad=i===0?0:range(4.8,8)*Math.sqrt(i),x=ax+Math.cos(a)*rad,z=az+Math.sin(a)*rad;
      const s=i===0?h0*range(1.08,1.34):h0*range(.56,1.05), type=rnd()<.82?kind:(rnd()<.66?'oak':'birch');
      const radius=s*(type==='fir'?.239:type==='birch'?.285:.405);
      if(!allowed(x,z,radius) || treePos.some(t=>Math.hypot(t.x-x,t.z-z)<(t.r+radius)*.62)) continue;
      const y=height(x,z), dest=batch(x,z,'Canopy');
      if(type==='fir') conifer(dest,x,y,z,s); else deciduous(dest,x,y,z,s,type);
      stats.trees++;treePos.push({x,z,r:radius,h:s});
    }
  }
  if(layout.riverZ && layout.riverHalf) {
    const reedColor=lin('#88a15e'), headColor=lin('#956f48');
    for(let n=0;n<118;n++) {
      const xx=range(-w+6,w-6), side=rnd()<.5?-1:1;
      const zz=layout.riverZ(xx)+side*(layout.riverHalf(xx)+range(1.2,6.5));
      if(!allowed(xx,zz,.65))continue;
      const p=batch(xx,zz,'Brookside_herbs'), n0=4+Math.floor(rnd()*5), col=pick(petals);
      for(let i=0;i<n0;i++) {
        const x=xx+range(-1.5,1.5),z=zz+range(-.9,.9);
        if(!allowed(x,z,.22))continue;
        const y=height(x,z)-.06,s=range(.74,1.55), a=range(0,TAU);
        for(let j=0;j<4;j++) blade(p,x,y,z,a+j*1.77,s*range(.65,1.19),s*.057,reedColor);
        if(i%3===0) {
          const dx=s*range(-.12,.12), dz=s*range(-.12,.12);
          stem(p,[[x,y,z,s*.026],[x+dx,y+s*1.18,z+dz,s*.02]],reedColor,4);
          stem(p,[[x+dx,y+s*1.00,z+dz,s*.034],[x+dx,y+s*1.04,z+dz,s*.046],[x+dx,y+s*1.18,z+dz,s*.043],[x+dx,y+s*1.21,z+dz,s*.014]],headColor,5);
        } else if(i%2===0){flower(p,x,y,z,s*.81,col);stats.flowers++;}
      }
    }
  }

  for(let n=0;n<390;n++) {
    const x0=range(-w+3,w-3),z0=range(-d+3,d-3),edge=spread(x0,z0);
    if(edge<.52 || !allowed(x0,z0,1.65)) continue;
    if(stats.boulders<125 && rnd()<.40) {
      const group=2+Math.floor(rnd()*4),angle=range(0,TAU),s0=range(1.12,3.3);
      for(let k=0;k<group;k++) {
        const rr=k?range(.45,1.4)*s0:0,a=angle+k*2.39996,x=x0+rr*Math.cos(a),z=z0+rr*Math.sin(a),s=s0*(k?range(.23,.65):1);
        if(!allowed(x,z,s*1.35))continue;
        globe(batch(x,z,'Outcrops'),x,height(x,z)+s*.14,z,s*range(.84,1.14),s*range(.43,.78),s*range(.69,1.00),pick(palette.stone),true,8,3);stats.boulders++;
      }
    } else if(stats.shrubs<120 && rnd()<.61) {
      const p=batch(x0,z0,'Understory'),s=range(.9,2.2),pair=pick(palette.shrub),n0=3+Math.floor(rnd()*3);
      for(let k=0;k<n0;k++) {
        const a=range(0,TAU),r=k===0?0:range(.45,1.05)*s,x=x0+Math.cos(a)*r,z=z0+Math.sin(a)*r,ss=s*(k?range(.52,.77):1);
        if(!allowed(x,z,ss*1.2))continue;
        globe(p,x,height(x,z)+ss*.52,z,ss,ss*.65,ss*.77,pair,false,8,3);
      }
      stats.shrubs++;
    }
    if(rnd()<.74) {
      const col=pick(petals), r=range(2,4), nb=8+Math.floor(rnd()*9), p=batch(x0,z0,'Meadow_detail');
      for(let k=0;k<nb;k++) {
        const a=range(0,TAU), rr=r*Math.sqrt(rnd()),x=x0+Math.cos(a)*rr,z=z0+Math.sin(a)*rr;
        if(!allowed(x,z,.38))continue;
        const y=height(x,z)-.045,s=range(.42,.85), colLeaf=pick(leaves);
        for(let j=0;j<3;j++) blade(p,x,y,z,a+j*1.92,s*range(.62,1.12),s*.09,colLeaf);
        if((k%3)===0) {flower(p,x,y,z,s*range(.9,1.45),col);stats.flowers++;}
      }
    }
  }
  const group=new THREE.Group(); group.name='Woodland and wildflower margins';
  for(const [name,p] of batches) if(p.indices.length) group.add(p.mesh(THREE,material,name));
  wood.addTo(group);
  layout.treeShadows=treePos;
  group.userData.heroTrees=actualHeroes;
  group.userData.population=stats;root.add(group);
  return group;
}
