// Small, ground-hugging details are grouped into tiles for frustum culling.
export function addMeadowDetail(T, root, layout) {
  const group = new T.Group();
  group.name = 'Meadow | spring groundcover';
  const tiles = new Map(), colors = new Map(), detailSize = 84;
  const mat = new T.MeshStandardMaterial({vertexColors:true, roughness:1, metalness:0, side:T.DoubleSide});
  mat.name = 'Spring | grasses, petals and gravel';
  const tau = 2*Math.PI;
  let seed = 48123;
  const random = () => (seed = (Math.imul(seed, 1664525)+1013904223)>>>0)/4294967296;
  const r = (a,b) => a+(b-a)*random();
  const pick = a => a[Math.floor(random()*a.length)];
  function tile(x,z) {
    const ix=Math.floor(x/detailSize), iz=Math.floor(z/detailSize), id=ix+':'+iz;
    if(!tiles.has(id))tiles.set(id,{id,x:ix*detailSize,z:iz*detailSize,p:[],c:[],i:[]});
    return tiles.get(id);
  }
  function vert(b,x,y,z,hex) {
    const i=b.p.length/3;
    let c=colors.get(hex);
    if(!c){c=new T.Color(hex);colors.set(hex,c);}
    b.p.push(x-b.x,y,z-b.z);b.c.push(c.r,c.g,c.b);
    return i;
  }
  const green=[0x83a95e,0x94b86d,0x99bb66,0x739653,0x87a55a,0x9daa65,0xa7bb71];
  const meadow=[0x91aa62,0x97b66d,0x87a45f,0x9eb469,0xa4b973];
  const gold=[0xc9b56a,0xd8c781,0xdac27a,0xcebb76];
  function blade(b,x,y,z,angle,h,lean,w,col) {
    const a=Math.cos(angle),d=Math.sin(angle),sx=-d*w,sz=a*w;
    const vx=x+a*lean*.33,vz=z+d*lean*.33;
    const A=vert(b,x-sx,y,z-sz,col),B=vert(b,x+sx,y,z+sz,col);
    const C=vert(b,vx+sx*.64,y+h*.62,vz+sz*.64,col),D=vert(b,vx-sx*.64,y+h*.62,vz-sz*.64,col);
    const E=vert(b,x+a*lean,y+h,z+d*lean,col);
    b.i.push(A,B,C,A,C,D,D,C,E);
  }
  function grass(b,x,y,z,scale) {
    const theta=r(0,tau),tint=pick(green);
    for(let i=0,n=Math.floor(r(4,8));i<n;i++){
      const a=theta+r(-2.7,2.7);
      blade(b,x+r(-.08,.08)*scale,y-.035,z+r(-.08,.08)*scale,a,r(.14,.38)*scale,r(.09,.29)*scale,r(.012,.034)*scale,i%3?tint:pick(green));
    }
  }
  // Etched, tapered leaves provide patches of hue at walking distance.
  function spread(b,x,y,z,angle,scale) {
    const t=angle+r(-.67,.67),h=r(.08,.17)*scale;
    blade(b,x,y-.023,z,t,h,r(.25,.56)*scale,r(.038,.072)*scale,pick(meadow));
  }
  function stalk(b,x,y,z,tx,ty,tz,width,col) {
    const a=vert(b,x-width,y,z,col),d=vert(b,x+width,y,z,col),c=vert(b,tx+width*.63,ty,tz,col),e=vert(b,tx-width*.63,ty,tz,col);
    b.i.push(a,d,c,a,c,e);
  }
  function daisy(b,x,y,z,scale,kind) {
    const h=r(.18,.39)*scale,tx=x+r(-.08,.08),tz=z+r(-.08,.08),ty=y+h;
    stalk(b,x,y-.02,z,tx,ty,tz,.009*scale,0x799557);
    blade(b,x,y-.02,z,r(0,tau),h*.64,h*.45,.026*scale,0x88a562);
    const rad=r(.046,.078)*scale, angle=r(0,tau),tilt=r(-.35,.35), n=kind?6:7;
    const center=vert(b,tx,ty+rad*.16,tz,kind?0xb78b43:0xeebf58);
    const ring=[];
    const hue=pick(kind?[0xf3c966,0xf6d87a,0xeac063]:[0xfcf3d7,0xfbf4e3,0xfff9e4]);
    for(let i=0;i<n;i++){
      const a=angle+i*tau/n,dx=Math.cos(a),dz=Math.sin(a),w=kind?.36:.265;
      const u=vert(b,tx+dx*rad*.28,ty+rad*.1+rad*dx*tilt*.28,tz+dz*rad*.28,hue);
      const v=vert(b,tx+(dx*.75-dz*w)*rad,ty+rad*(.06+dx*tilt),tz+(dz*.75+dx*w)*rad,hue);
      const t=vert(b,tx+dx*rad,ty+rad*(.09+dx*tilt),tz+dz*rad,hue);
      const e=vert(b,tx+(dx*.75+dz*w)*rad,ty+rad*(.06+dx*tilt),tz+(dz*.75-dx*w)*rad,hue);
      b.i.push(u,v,t,u,t,e);
      ring.push(vert(b,tx+dx*rad*.32,ty+rad*(.12+tilt*dx*.32),tz+dz*rad*.32,kind?0xc59141:0xedba4f));
    }
    for(let i=0;i<n;i++)b.i.push(center,ring[(i+1)%n],ring[i]);
  }
  function spike(b,x,y,z,golden) {
    const h=golden?r(.50,.86):r(.39,.70),lean=r(-.08,.12),dz=r(-.08,.08),tx=x+lean,tz=z+dz;
    stalk(b,x,y-.035,z,tx,y+h,tz,golden?.008:.013,golden?0xa7a366:0x7e9557);
    const tones=golden?gold:[0xd9a5ab,0xe8b7be,0xeebfc0,0xc895ac];
    const shade=pick(tones);
    for(let i=0,n=golden?8:10;i<n;i++){
      const f=.56+.44*i/n,rad=(golden?.042:.049)*(1-.31*i/n),a=i*2.399;
      const px=x+lean*f,pz=z+dz*f,py=y+h*f,ux=Math.cos(a),uz=Math.sin(a);
      const A=vert(b,px,py,pz,shade),B=vert(b,px+rad*(ux*.55-uz*.37),py+.028,pz+rad*(uz*.55+ux*.37),shade);
      const C=vert(b,px+rad*ux,py+(golden?.078:.040),pz+rad*uz,shade);
      const D=vert(b,px+rad*(ux*.55+uz*.37),py+.028,pz+rad*(uz*.55-ux*.37),shade);
      b.i.push(A,B,C,A,C,D);
    }
    blade(b,x,y-.03,z,r(0,tau),h*.53,h*.44,.023,0x8f9d60);
  }
  const land=(x,z)=>Math.abs(z-layout.riverZ(x))-layout.riverHalf(x);
  const path=(x,z)=>layout.distanceToPath(x,z);
  const valid=(x,z)=>land(x,z)>1.1 && path(x,z)>5.9 && layout.height(x,z)>.29 && layout.canDecorate(x,z,.8);
  const maxX=Math.min(115,layout.width*.41),minZ=Math.max(-71,-layout.depth*.43),maxZ=Math.min(159,layout.depth*.46);
  let built=0;
  for(let tries=0;tries<3200 && built<126;tries++) {
    const x=r(-maxX,maxX),z=random()<.58?r(Math.max(minZ,maxZ-88),maxZ):r(minZ,maxZ);
    if(!valid(x,z))continue;
    const gap=path(x,z),edge=land(x,z);
    const affinity=gap<13 || edge<9;
    if(!affinity && random()>.115)continue;
    const b=tile(x,z),angle=r(0,tau),length=r(1.4,4.8),width=r(.38,1.35),florid=(affinity?.82:.27)>random(), species=random();
    let step=0;
    for(let q=0;q<(affinity?18:9);q++) {
      const u=r(-1,1)*length, v=r(-1,1)*width*(1-.56*Math.abs(u/length));
      const px=x+Math.cos(angle)*u-Math.sin(angle)*v,pz=z+Math.sin(angle)*u+Math.cos(angle)*v;
      if(!valid(px,pz))continue;
      const y=layout.height(px,pz);
      if(q%3===1)grass(b,px,y,pz,r(.71,1.36));
      else spread(b,px,y,pz,angle,r(.83,1.46));
      if(florid && q%2===0){
        if(species>.72)spike(b,px,y,pz,species>.89);
        else daisy(b,px,y,pz,r(.88,1.40),species<.31);
      }
      step++;
    }
    if(step)built++;
  }
  // Flat, oval stones cluster in the wake of the banks; the channel stays open.
  const stones=[0xb4af93,0xb8ae99,0xc5b8a0,0xa9a895,0xcbbda1,0xb2b09b];
  for(let j=0;j<36;j++){
    const ax=r(-maxX,maxX),sgn=random()<.5?-1:1;if(Math.abs(ax)<4.6)continue;
    for(let i=0,n=Math.floor(r(3,9));i<n;i++){
      const x=ax+r(-1.9,1.9),z=layout.riverZ(x)+sgn*(layout.riverHalf(x)+r(-.26,1.46));
      if(path(x,z)<5.6)continue;
      const y=layout.height(x,z),s=r(.07,.28),elong=r(1.2,1.9),theta=r(0,tau),c=pick(stones),b=tile(x,z),ring=[];
      for(let k=0;k<7;k++){
        const u=Math.cos(k*tau/7)*s*elong,v=Math.sin(k*tau/7)*s*r(.80,1.13);
        ring.push(vert(b,x+u*Math.cos(theta)-v*Math.sin(theta),y+s*.12,z+u*Math.sin(theta)+v*Math.cos(theta),c));
      }
      const top=vert(b,x-s*.12,y+s*r(.55,.82),z+s*.11,c);
      for(let k=0;k<7;k++)b.i.push(top,ring[(k+1)%7],ring[k]);
    }
  }
  for(const b of tiles.values()){
    if(!b.i.length)continue;
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.Float32BufferAttribute(b.p,3));
    geometry.setAttribute('color',new T.Float32BufferAttribute(b.c,3));
    geometry.setIndex(b.i);geometry.computeVertexNormals();geometry.computeBoundingSphere();
    const mesh=new T.Mesh(geometry,mat);mesh.name='Meadow detail '+b.id;mesh.position.set(b.x,0,b.z);mesh.receiveShadow=true;group.add(mesh);
  }
  root.add(group);
  return group;
}
