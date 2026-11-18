// Low beds made from the reference painting's petals, branches and foreground leaves.
export function addBorders(T,root,layout,textures){
  const map=textures['border-atlas.png'];if(!map)return null;
  let seed=0x78ade9;function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
  const range=(a,b)=>a+(b-a)*rand(), pick=a=>a[Math.floor(rand()*a.length)];
  const banks=[[0,1,4,10,8],[2,3,6,0,9],[1,4,7,11],[3,6,0,2,8]];
  const pos=[],uv=[],color=[],indices=[];let plants=0;
  const can=(x,z,r)=>Math.abs(x)<layout.width*.49&&Math.abs(z)<layout.depth*.49&&layout.canDecorate(x,z,r);
  function place(x,z,s,type){
    if(!can(x,z,s*.52))return;
    const a=range(0,Math.PI),y=layout.height(x,z)-.055;
    const width=s*range(1.12,1.62),h=s*range(.91,1.21),sheetCount=2,main=range(.88,.99);
    for(let k=0;k<sheetCount;k++){
      const an=a+k*Math.PI/sheetCount+range(-.07,.07),dx=Math.cos(an),dz=Math.sin(an),idx=pos.length/3;
      const row=Math.floor(type/4),col=type%4,bend=.10*width*(k===0?1:-1);
      // Two mildly folded planes follow each clump. Vertex shading anchors the crown to its stem.
      for(const [u,v,bulge] of [[0,1,0],[1,1,0],[1,0,.18],[0,0,-.12],[.5,.46,1]]){
        const vx=(u-.5)*width;
        pos.push(x+dx*vx-dz*bulge*bend,y+(1-v)*h,z+dz*vx+dx*bulge*bend);
        uv.push((col+.008+u*.984)/4,(row+.007+v*.986)/3);
        const shade=main*(.66+.34*(1-v));
        color.push(shade,shade*(.98+.02*v),shade*(.93+.07*(1-v)));
      }
      indices.push(idx,idx+1,idx+4,idx+1,idx+2,idx+4,idx+2,idx+3,idx+4,idx+3,idx,idx+4);
    }
    plants++;
  }
  function bed(x,z,tx,tz,length,width,scale,palette,count){
    for(let i=0;i<count;i++){
      const phase=rand()*Math.PI*2,rad=Math.sqrt(rand()),a=Math.cos(phase)*rad*length,b=Math.sin(phase)*rad*width;
      let slot=pick(palette);if(rand()<.14)slot=pick([8,9,11]);
      place(x+tx*a-tz*b,z+tz*a+tx*b,scale*range(.58,1.30)*(1-.25*rad),slot);
    }
  }
  // Unequal patch lengths and gaps avoid turning the shore into a formal flower border.
  if(layout.riverZ&&layout.riverHalf)for(const side of [-1,1]){
    for(let x=-213;x<216;x+=range(5.5,13.3)){
      if(rand()<.23)continue;
      const near=Math.abs(x)<93,zz=layout.riverZ(x)+side*(layout.riverHalf(x)+range(2.5,5.8));
      const dz=(layout.riverZ(x+1)-layout.riverZ(x-1))*.5,inv=1/Math.hypot(1,dz);
      bed(x,zz,inv,dz*inv,range(3.7,8.8),range(1.1,3),near?range(1.28,1.73):range(.75,1.31),pick(banks),near?34:14);
    }
  }
  for(const trail of layout.trails||[]){
    for(const side of [-1,1])for(let i=4;i<trail.ps.length-2;){
      const [x,z]=trail.ps[i],[nx,nz]=trail.ps[i+1];i+=Math.floor(range(8,19));
      if(rand()<.25)continue;
      const len=Math.hypot(nx-x,nz-z)||1,tx=(nx-x)/len,tz=(nz-z)/len,offset=side*(trail.w*.5+range(3.1,6.1));
      const s=Math.abs(x)<100&&z>16?range(1.15,1.60):range(.72,1.16);
      bed(x-tz*offset,z+tx*offset,tx,tz,range(2.6,6.6),range(1.1,2.3),s,pick(banks),Math.round(s*19));
    }
  }
  if(layout.riverZ)for(const dx of [-25,-14,-9,9,14,24,33]){
    for(const sign of [-1,1]){
      const z=layout.riverZ(dx)+sign*(layout.riverHalf(dx)+range(2.9,6.3));
      bed(dx,z,1,0,range(3.2,5.1),range(1.3,2.2),range(1.45,1.94),pick(banks),34);
    }
  }
  for(const t of (layout.treeShadows||[]).slice(0,7)){
    for(let j=0;j<4;j++){
      const a=range(0,2*Math.PI),co=Math.cos(a),si=Math.sin(a),s=range(.94,1.42);
      bed(t.x+co*t.r*.69,t.z+si*t.r*.69,-si,co,range(2,3.9),range(1.1,2.0),s,pick(banks),16);
    }
  }
  const geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute(pos,3));
  geom.setAttribute('color',new T.Float32BufferAttribute(color,3));geom.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
  geom.setIndex(indices);geom.computeVertexNormals();geom.computeBoundingSphere();
  const mat=new T.MeshBasicMaterial({name:'Reference wildflowers and leafy banks',map,vertexColors:true,alphaTest:.30,side:T.DoubleSide});
  const mesh=new T.Mesh(geom,mat);mesh.name='Creekside flowers and meadow borders';mesh.userData.plants=plants;
  root.add(mesh);return mesh;
}
