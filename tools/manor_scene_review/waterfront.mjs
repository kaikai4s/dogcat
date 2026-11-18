// The single-span bridge and its planting stay independently selectable in the GLB.
export const bridgeDeckLift=x=>.026+.050*(1-(x/3.8)**2);

export function addWaterfront(T, root, layout, textures={}) {
  const material = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0, side: T.DoubleSide });
  material.name = 'Bridge | limestone, chestnut and reeds';
  const masonry=material.clone();masonry.name='Bridge | weathered local limestone';
  if(textures['limestone-grain.jpg']){masonry.map=textures['limestone-grain.jpg'];masonry.map.wrapS=masonry.map.wrapT=T.RepeatWrapping;}
  const v = (a) => new T.Vector3(...a);
  const yAxis = new T.Vector3(0, 1, 0);
  const unitBox = new T.BoxGeometry(1, 1, 1);
  const rot = (x = 0, y = 0, z = 0) => new T.Quaternion().setFromEuler(new T.Euler(x, y, z));
  const noRot = rot();
  function object(name, base, turn, draw) {
    const pos = [], norm = [], col = [];
    const matrix = new T.Matrix4(), normalMatrix = new T.Matrix3(), point = new T.Vector3(), normal = new T.Vector3();
    const rgb = new T.Color();
    function add(geo, p, q, s, c) {
      rgb.set(c); matrix.compose(v(p), q, v(s)); normalMatrix.getNormalMatrix(matrix);
      const idx = geo.index, a = geo.attributes.position, n = geo.attributes.normal;
      for (let i = 0, l = idx ? idx.count : a.count; i < l; i++) {
        const j = idx ? idx.getX(i) : i;
        point.fromBufferAttribute(a, j).applyMatrix4(matrix); normal.fromBufferAttribute(n, j).applyNormalMatrix(normalMatrix);
        pos.push(point.x, point.y, point.z); norm.push(normal.x, normal.y, normal.z); col.push(rgb.r, rgb.g, rgb.b);
      }
    }
    function box(p, size, color, rotation = noRot) { add(unitBox, p, rotation, size, color); }
    function rod(pa, pb, bottom, top, color, sides = 8) {
      const a = v(pa), b = v(pb), direction = b.clone().sub(a), len = direction.length();
      if (len < 0.00001) return;
      const geometry = new T.CylinderGeometry(top, bottom, len, sides);
      add(geometry, a.lerp(b, 0.5).toArray(), new T.Quaternion().setFromUnitVectors(yAxis, direction.normalize()), [1, 1, 1], color); geometry.dispose();
    }
    function face(points, color) {
      const ids = points.length === 3 ? [0,1,2] : [0,1,2,0,2,3];
      rgb.set(color);
      for (let i = 0; i < ids.length; i += 3) {
        const [a,b,c] = ids.slice(i, i + 3).map(j => v(points[j]));
        normal.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
        for (const p of [a,b,c]) { pos.push(p.x,p.y,p.z); norm.push(normal.x,normal.y,normal.z); col.push(rgb.r,rgb.g,rgb.b); }
      }
    }
    function beam(pa,pb,w,h,color) {
      const a=v(pa), b=v(pb), dir=b.clone().sub(a), len=dir.length();
      add(unitBox,a.lerp(b,0.5).toArray(),new T.Quaternion().setFromUnitVectors(yAxis,dir.normalize()),[w,len,h],color);
    }
    draw({box, rod, face, beam, add});
    const geo = new T.BufferGeometry();
    for (const [key, values] of [['position',pos],['normal',norm],['color',col]]) geo.setAttribute(key,new T.Float32BufferAttribute(values,3));
    const isStone=/^0[1-4]/.test(name);
    if(isStone){
      const uv=[];
      for(let i=0;i<pos.length;i+=3){
        const x=pos[i],y=pos[i+1],z=pos[i+2],onEnd=Math.abs(norm[i+2])>.73;
        uv.push((onEnd?x:z)*.44,(Math.abs(norm[i+1])>.70?x:y)*.44);
      }
      geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
    }
    const mesh = new T.Mesh(geo,isStone?masonry:material); mesh.name = name; mesh.position.set(...base); mesh.rotation.y = turn;
    mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  }

  const center = layout.riverZ(0), halfRiver = layout.riverHalf(0);
  const L=layout.reach??halfRiver+4, a=halfRiver*0.82, hw=3.8, spring=0.51;
  const rise=Math.max(3.4,Math.min(9.2,halfRiver*0.53)), ring=0.77;
  const north=layout.height(0,center-L),south=layout.height(0,center+L);
  const crown=Math.max(north,south,spring+rise+1.66);
  const limestone=[0xd7bd93,0xd0b48b,0xe0c9a2,0xd7c19d,0xcbb491,0xe4d1ad,0xcbb08b];
  const archstone=[0xe6d2aa,0xf0ddba,0xdcc398,0xe4cba1,0xeed9af,0xe7cfa6];
  const paving=[0xe1c9a3,0xe7d2ae,0xd9c39e,0xe4ceaa,0xe9d6b5];
  const wood=[0x835237,0x92603e,0x9d6a47,0x8d583a],woodCap=0xaa7750;
  const clamp=(n,l,h)=>Math.min(h,Math.max(l,n));
  function deck(z) {
    const t=clamp(Math.abs(z)/L,0,1), bank=z<0?north:south;
    return bank+(crown-bank)*Math.pow(1-t*t,1.50);
  }
  const soffit=z=>Math.abs(z)>=a?-1.35:spring+rise*Math.sqrt(Math.max(0,1-(z/a)**2));
  function archPoint(theta,rad) {return [(rise+rad)*Math.sin(theta)+spring,(a+rad)*Math.cos(theta)];}
  object('01 Stone arch | barrel vault and abutments',[0,0,center],0,({face})=>{
    function slice(z,lo,next,loNext) {
      const h=deck(z),endH=deck(next);
      for(const side of [-1,1]) {
        const x=side*hw;
        let pts=[[x,lo,z],[x,loNext,next],[x,endH,next],[x,h,z]];if(side>0)pts.reverse();face(pts,0xbfa784);
      }
      face([[-hw,h,z],[-hw,endH,next],[hw,endH,next],[hw,h,z]],0xc5b294);
      face([[-hw,lo,z],[hw,lo,z],[hw,loNext,next],[-hw,loNext,next]],0xb79b77);
    }
    for(let i=0;i<48;i++) {
      const [y1,z1]=archPoint(Math.PI*(1-i/48),0),[y2,z2]=archPoint(Math.PI*(1-(i+1)/48),0);
      slice(z1,y1,z2,y2);
    }
    for(const s of [-1,1]) {
      const pts=[s*a,s*(a+(L-a)*0.45),s*L].sort((u,v)=>u-v);
      for(let i=0;i<2;i++)slice(pts[i],-1.35,pts[i+1],-1.35);
      const x0=-hw,x1=hw,z=s*a;
      face([[x0,-1.35,z],[x0,spring,z],[x1,spring,z],[x1,-1.35,z]],0xb79d78);
    }
  });
  object('02 Stone arch | dressed voussoirs and golden keystone',[0,0,center],0,({face})=>{
    const count=29;
    for(let i=0;i<count;i++) {
      const key=i===(count-1)/2, color=key?0xf3dfb6:archstone[(i*7+Math.floor(i/4))%archstone.length];
      const t0=(i+0.028)*Math.PI/count,t1=(i+0.972)*Math.PI/count,depth=key?ring+0.22:ring;
      const [y0,z0]=archPoint(t0,0),[y1,z1]=archPoint(t1,0),[Y0,Z0]=archPoint(t0,depth),[Y1,Z1]=archPoint(t1,depth);
      for(const s of [-1,1]) {
        const near=s*(hw+(key?0.224:0.142)),far=s*(hw-0.04);
        let front=[[near,y0,z0],[near,Y0,Z0],[near,Y1,Z1],[near,y1,z1]]; if(s===1)front.reverse();face(front,color);
        face([[near,Y0,Z0],[far,Y0,Z0],[far,Y1,Z1],[near,Y1,Z1]],color);
        face([[near,y0,z0],[near,Y0,Z0],[far,Y0,Z0],[far,y0,z0]],color);
        face([[near,y1,z1],[far,y1,z1],[far,Y1,Z1],[near,Y1,Z1]],color);
      }
      // Each rib continues along the underside, so the opening is real from either bank.
      const xx=hw+0.137;face([[-xx,y0-0.008,z0],[xx,y0-0.008,z0],[xx,y1-0.008,z1],[-xx,y1-0.008,z1]],archstone[(i+3)%6]);
    }
  });
  object('03 Stone arch | coursed limestone walls and coping',[0,0,center],0,({face})=>{
    let k=0;
    for(const s of [-1,1]) {
      const x=s*(hw+0.044),rowH=0.50;
      // Horizontal masonry courses end at the curve of the barrel vault.
      for(let row=0, y=-1.25;y<crown;row++,y+=rowH) {
        const blockW=1.16,offset=row%2?0.57:0;
        for(let z=-L-offset;z<L;z+=blockW) {
          const za=Math.max(-L,z+0.018),zb=Math.min(L,z+blockW-0.018);if(zb-za<0.035) continue;
          const color=limestone[(row*17+(k++)*11)%7];
          for(let part=0;part<3;part++) {
            const p=za+(zb-za)*part/3,q=za+(zb-za)*(part+1)/3;
            const lo=u=>Math.max(y+0.023,soffit(u)-0.03),hi=u=>Math.min(deck(u)-0.08,y+rowH-0.017);
            let ya=lo(p),yb=lo(q),Ya=hi(p),Yb=hi(q);
            if(Ya<=ya&&Yb<=yb) continue;
            ya=Math.min(ya,Ya);yb=Math.min(yb,Yb);
            const pts=[[x,ya,p],[x,yb,q],[x,Yb,q],[x,Ya,p]];if(s===1)pts.reverse();face(pts,color);
          }
        }
      }
      const n=Math.ceil(2*L/1.25);
      for(let i=0;i<n;i++){
        const p=-L+i*(2*L)/n+0.014,q=-L+(i+1)*(2*L)/n-0.014;
        const inner=s*(hw-0.41),outer=s*(hw+0.15), hp=deck(p)+0.10,hq=deck(q)+0.10;
        face([[inner,hp,p],[inner,hq,q],[outer,hq,q],[outer,hp,p]],archstone[(i+1)%6]);
        face([[outer,hp,p],[outer,hq,q],[outer,hq-0.23,q],[outer,hp-0.23,p]],limestone[i%7]);
      }
    }
  });
  object('04 Stone arch | softly crowned flagstone road',[0,0,center],0,({face})=>{
    const rows=Math.ceil(2*L/0.76),row=2*L/rows;
    for(let j=0;j<rows;j++){
      const p=-L+j*row+(j===0?0:0.016),q=-L+(j+1)*row-(j===rows-1?0:0.016);
      const offset=j%2?0.60:0;
      for(let i=-4;i<=4;i++) {
        const l=clamp(i*1.21+offset+0.014,-hw+0.39,hw-0.39),r=clamp((i+1)*1.21+offset-0.014,-hw+0.39,hw-0.39);
        if(r-l<0.03) continue;
        face([[l,deck(p)+bridgeDeckLift(l),p],[l,deck(q)+bridgeDeckLift(l),q],[r,deck(q)+bridgeDeckLift(r),q],[r,deck(p)+bridgeDeckLift(r),p]],paving[(j*3+i+12)%5]);
      }
    }
  });
  object('05 Stone arch | chestnut rails and carved newels',[0,0,center],0,({box,beam,rod})=>{
    const n=Math.max(8,Math.round(2*(L-0.55)/2.45));
    for(const side of [-1,1]) {
      const x=side*(hw-0.19), start=-L+0.54, end=L-0.54;
      for(let i=0;i<=n;i++){
        const z=start+(end-start)*i/n,h=deck(z), endPost=i===0||i===n;
        if(endPost){
          box([x,h+0.68,z],[0.89,1.36,0.90],0xd8bf97);
          box([x,h+0.17,z],[1.00,0.30,1.01],0xcbb28c);
          box([x,h+1.31,z],[0.98,0.14,0.99],0xc1a783);
          box([x,h+1.44,z],[1.07,0.18,1.08],0xe2caa5);
          const cap = 0.52;
          // A low, four-sided weather cap bevels each bridge-head pillar.
          rod([x,h+1.54,z],[x,h+1.74,z],cap*1.37,cap*0.64,0xe9d4b0,4);
        } else {
          box([x,h+0.81,z],[0.225,1.46,0.225],wood[i%4]);
          box([x,h+1.53,z],[0.28,0.08,0.28],woodCap);
          box([x,h+0.19,z],[0.27,0.17,0.27],0x6d513d);
        }
        if(i<n) {
          const nz=start+(end-start)*(i+1)/n,nh=deck(nz);
          for(const [y,w,hh,c] of [[1.37,0.21,0.18,wood[i%4]],[0.76,0.15,0.12,wood[(i+1)%4]]])beam([x,h+y,z],[x,nh+y,nz],w,hh,c);
        }
      }
    }
  });
  object('06 Creek | river stones, reeds and rush heads',[0,0,center],0,({add,rod,face})=>{
    const pebble=new T.IcosahedronGeometry(1,0),rock=[0xb5ac95,0xa8a18d,0xc4b89d,0xbdb39b,0x9a9c88];
    let seed=419;const rand=()=>((seed=Math.imul(1664525,seed)+1013904223|0)>>>0)/4294967296;
    for(const [px,side] of [[9,-1],[-10,1],[-17,-1],[15,1],[-28,1],[25,-1]]) {
      for(let i=0;i<7;i++){
        const wx=px+(rand()-0.5)*5.0;
        const wz=layout.riverZ(wx)+side*(layout.riverHalf(wx)-rand()*1.35+0.2);
        const h=layout.height(wx,wz), sz=0.19+rand()*0.65;
        add(pebble,[wx,h+0.17,wz-center],rot(rand()*0.5,rand()*5,rand()*0.4),[sz*1.47,sz*0.76,sz],rock[i%5]);
      }
      for(let j=0;j<4;j++){
        const wx=px+(rand()-0.5)*4.5,wz=layout.riverZ(wx)+side*(layout.riverHalf(wx)+0.45+rand()*1.5);
        const h=layout.height(wx,wz),dz=wz-center;
        for(let b=0;b<12;b++){
          const phi=rand()*Math.PI*2,len=0.38+rand()*0.72, dx=Math.cos(phi), ds=Math.sin(phi),w=0.055+rand()*0.039;
          const ox=wx+(rand()-0.5)*0.33,oz=dz+(rand()-0.5)*0.33,ry=h-0.03;
          const mx=ox+dx*len*0.27,mz=oz+ds*len*0.27,my=ry+len*0.58;
          const c=[0x80934f,0x9baf66,0x69854f,0x829851][b%4];
          face([[ox-ds*w,ry,oz+dx*w],[mx-ds*w*.6,my,mz+dx*w*.6],[mx+ds*w*.6,my,mz-dx*w*.6],[ox+ds*w,ry,oz-dx*w]],c);
          face([[mx-ds*w*.6,my,mz+dx*w*.6],[ox+dx*len*0.64,ry+len,oz+ds*len*0.64],[mx+ds*w*.6,my,mz-dx*w*.6]],c);
        }
        if(j%2===0){
          rod([wx,h,dz],[wx+0.1,h+1.13,dz+0.06],0.019,0.011,0x83935e,5);
          rod([wx+0.1,h+1.13,dz+0.06],[wx+0.13,h+1.36,dz+0.07],0.045,0.035,0x7c5d41,6);
        }
      }
    }
    pebble.dispose();
  });
  unitBox.dispose();
}
