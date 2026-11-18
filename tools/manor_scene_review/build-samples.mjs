import {BoxGeometry, Color, Group, InstancedMesh, MeshStandardMaterial, Object3D, Shape, ExtrudeGeometry} from 'three';

// Preview-only cottages share geometry and fit inside every recommended lot.
export function createBuildSamples(plots) {
  const layer=new Group();
  layer.name='Example cottages';
  const shape=new Shape();
  shape.moveTo(-.5,0);shape.lineTo(.5,0);shape.lineTo(0,1);shape.closePath();
  const roof=new ExtrudeGeometry(shape,{depth:1,bevelEnabled:false});
  roof.translate(0,0,-.5);
  const box=new BoxGeometry(1,1,1), parts=[], transform=new Object3D(), color=new Color();
  const walls=[0xffe7bd,0xf6daaa,0xf3dbcc,0xf5eed3], roofs=[0x425e69,0x9c583f,0x526d60,0x5e5670];
  const add=(geometry,capacity)=>{
    const material=new MeshStandardMaterial({roughness:.92});
    const mesh=new InstancedMesh(geometry,material,capacity);
    mesh.count=0;layer.add(mesh);parts.push(mesh);return mesh;
  };
  const base=add(box,plots.length),wall=add(box,plots.length),gables=add(roof,plots.length);
  const tiles=add(box,2*plots.length),trim=add(box,7*plots.length),windows=add(box,4*plots.length);
  const put=(mesh,p,side,x,y,z,w,h,d,c,tilt=0)=>{
    transform.position.set(p.x+x*side,p.y+y,p.z+z*side);
    transform.rotation.set(0,side===1?0:Math.PI,tilt);
    transform.scale.set(w,h,d);transform.updateMatrix();
    const i=mesh.count++;
    mesh.setMatrixAt(i,transform.matrix);mesh.setColorAt(i,color.set(c));
  };
  plots.forEach((p,i)=>{
    const variety=(i*7+Math.floor(i/9))%walls.length, side=p.z>45?-1:1;
    const w=p.width*(.55+.045*(i%3)),d=p.depth*(.58+.038*(i%4)),h=p.width>=40?6.8:5.4,peak=w*.255;
    put(base,p,side,0,.18,0,w+1.2,.5,d+1.2,0xa1977d);
    put(wall,p,side,0,h/2+.3,0,w,h,d,walls[variety]);
    put(gables,p,side,0,h+.3,0,w,peak,d,walls[variety]);
    const run=w*.5+.68,slope=Math.atan2(peak,w*.5),length=run/Math.cos(slope);
    for(const s of [-1,1]){
      put(tiles,p,side,s*run*.5,h+.55+peak-run*.5*Math.tan(slope),0,length,.36,d+1.35,roofs[variety],-s*slope);
      put(trim,p,side,s*w*.30,3.1,d*.5+.09,1.65,2.02,.24,0x684e39);
      put(windows,p,side,s*w*.30,3.1,d*.5+.23,1.29,1.61,.10,0x47707b);
      put(trim,p,side,s*w*.24,3.0,-d*.5-.09,1.65,1.85,.24,0x684e39);
      put(windows,p,side,s*w*.24,3.0,-d*.5-.23,1.29,1.47,.10,0x47707b);
    }
    put(trim,p,side,0,1.75,d*.5+.14,1.86,2.94,.33,0x7d553b);
    put(trim,p,side,-w*.15,h+peak+.42,-d*.22,1.02,2.35,1.16,0xa78d78);
    put(trim,p,side,-w*.15,h+peak+1.66,-d*.22,1.33,.25,1.45,0x6f6b65);
  });
  for(const mesh of parts){mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}
  return layer;
}
