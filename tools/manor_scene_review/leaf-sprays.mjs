import {getLeafSprayAnchors} from './flora.mjs';

export function addLeafSprays(T,root,layout,textures) {
  const map=textures['leaf-sprays.png'], branches=getLeafSprayAnchors(layout);
  if(!map||!branches.length)return null;
  const cells=new Map(), mat=new T.MeshBasicMaterial({name:'Painted leaf and blossom tips',map,vertexColors:true,alphaTest:.34,side:T.DoubleSide});
  const group=new T.Group();group.name='Layered spring tree crowns';
  const sun=new T.Vector3(.59,.82,.24).normalize(),up=new T.Vector3(0,1,0);
  let seed=0x78a241;
  function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
  for(const b of branches){
    const id=Math.floor(b.x/192)+'_'+Math.floor(b.z/192);
    if(!cells.has(id))cells.set(id,{pos:[],uv:[],colors:[],indices:[]});
    const {pos,uv,colors,indices}=cells.get(id);
    const dir=new T.Vector3(b.dx,b.dy*.72+.16,b.dz).normalize(),side=new T.Vector3().crossVectors(up,dir).normalize();
    const count=b.hero&&!b.terminal?3:2;
    for(let k=0;k<count;k++){
      const n=dir.clone().applyAxisAngle(up,k===0?0:(k%2?1:-1)*(.75+rand()*.75));
      n.y+=k===2?.42:-.12+rand()*.28;n.normalize();
      const u=new T.Vector3().crossVectors(up,n).normalize(),v=new T.Vector3().crossVectors(n,u).normalize();
      u.applyAxisAngle(n,(rand()-.5)*1.94);v.crossVectors(n,u).normalize();
      const p=new T.Vector3(b.x,b.y,b.z).addScaledVector(side,(k%2?1:-1)*b.size*(k?.62:.11));
      p.addScaledVector(dir,b.size*(k===0?.32:-.13)).y+=(rand()-.45)*b.size*.45;
      const width=b.size*(2.38+.54*rand()),height=width*(.77+.21*rand()),bend=width*.12;
      const rosy=b.kind==='bloom'&&(b.hero&&!b.lower||k===0||rand()>.33);
      const row=rosy?2:b.kind==='birch'||b.kind==='bloom'?3:b.kind==='apple'?1:0;
      const col=Math.floor(4*rand()),index=pos.length/3;
      const outdoor=Math.max(0,.48+.52*n.dot(sun));
      const lightAt=b.sunward??.48;
      const lighting=(.53+.38*outdoor+.08*lightAt+.075*rand())*(k===0?1:.94)*(b.lower?.85:1);
      for(const [a,c,lift] of [[-.5,-.5,0],[.5,-.5,0],[.5,.5,-.14],[-.5,.5,.14],[0,0,1]]){
        const point=p.clone().addScaledVector(u,a*width).addScaledVector(v,c*height).addScaledVector(n,lift*bend);
        pos.push(...point.toArray());uv.push((col+.5+a*.97)/4,(row+.5-c*.97)/4);
        const l=Math.min(1,lighting+lift*.027+c*.17);
        const reddening=.98+.03*outdoor,blue=rosy?1.02-.02*outdoor:.99-.07*outdoor;
        colors.push(Math.round(255*Math.min(1,l*reddening)),Math.round(255*l),Math.round(255*l*blue));
      }
      indices.push(index,index+1,index+4,index+1,index+2,index+4,index+2,index+3,index+4,index+3,index,index+4);
    }
  }
  // Colour is taken from the lit painting. Baked directional modulation gives
  // each spray consistent shading even when viewed from behind its branches.
  for(const [cell,{pos,uv,colors,indices}] of cells){
    const geo=new T.BufferGeometry();
    geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));
    geo.setAttribute('color',new T.Uint8BufferAttribute(colors,3,true));
    geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
    geo.setIndex(indices);geo.computeBoundingSphere();
    const result=new T.Mesh(geo,mat);result.name='Leaf-and-blossom sprays '+cell;group.add(result);
  }
  root.add(group);return group;
}
