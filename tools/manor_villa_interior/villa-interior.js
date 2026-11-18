import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { VILLA_LAYOUT } from './villa-layout.js'

const FRONT_DOOR = { x: 1.28, y: .40, w: 1.28, h: 2.34, crown: .49 }
const REAR_DOOR = { x: .65, y: .38, w: 1.18, h: 2.23, crown: .33 }
const win = (x, y, w, h, crown = 0) => ({ x, y, w, h, crown })
const wallSpecs = [
  [0, 3.56, 0, -6.46, 2.84, 6.50, [FRONT_DOOR,
    win(-4.01,.81,1.94,1.73,.38),win(-1.37,.81,1.90,1.73,.38),
    win(-3.86,3.99,.91,1.33,.16),win(-1.42,3.96,.92,1.39,.16),win(1.02,4.02,1.04,1.26)]],
  [0,-3.60,Math.PI,-2.84,6.46,6.48,[REAR_DOOR,
    win(-1.47,.86,1.54,1.77),win(3.43,.82,1.38,1.64),win(5.27,.86,1.06,1.54),
    win(-1.78,3.98,1.15,1.50),win(.62,4.04,1.20,1.47),win(4.49,4.01,1.40,1.49)]],
  [0,4.93,0,2.83,7.53,6.42,[win(3.87,4.08,.80,1.51),
    {...win(5.74,.38,2.68,2.11),bay:true},{...win(5.92,3.18,1.68,2.07),bay:true}]],
  [0,-4.34,Math.PI,-7.53,-2.83,6.42,[win(-5.15,.81,2.05,1.64,.24),
    win(-6.31,4,1.26,1.66),win(-4.02,4.04,.96,1.47)]],
  [7.53,0,Math.PI/2,-4.93,4.34,6.33,[win(-3.47,.83,1.19,1.72),win(-.78,.83,1.53,1.72),
    win(2.44,.87,1.42,1.68),win(-3.51,4.04,1.10,1.56,.15),win(-.76,4.1,1.20,1.51),win(2.30,4.07,1.24,1.52)]],
  [2.83,4.24,-Math.PI/2,-.68,.69,6.38,[]],
  [2.83,-3.96,-Math.PI/2,-.38,.36,6.38,[]],
  [0,3.22,0,-7.33,-6.46,5.03,[win(-6.99,1,.65,1.29)]],
  [0,3.22,0,-10.32,-10.18,5.03,[]],
  [0,3.93,0,-10.18,-7.33,5.03,[{...win(-8.76,.39,1.74,1.97),bay:true},win(-8.76,3.18,1.29,1.40)]],
  [-10.18,3.57,-Math.PI/2,-.35,.36,5.03,[]],
  [-7.33,3.57,Math.PI/2,-.36,.35,5.03,[]],
  [0,-3.43,Math.PI,6.46,10.32,5.02,[win(8.61,.84,1.45,1.49),win(7.52,3.02,.91,1.36),win(9.21,3.02,.77,1.29)]],
  [-10.32,0,-Math.PI/2,-3.43,3.22,5.02,[win(-.04,.88,1.54,1.46),win(-1.76,3.01,1.14,1.34),win(1.43,3,1.12,1.34)]]
]

const palette = {
  plaster:0xe4d7c0, oak:0x674832, edge:0xb58b59, walnut:0x49312a, glass:0x9dbcb7,
  floor0:0x98724f,floor1:0xa37b55,floor2:0x906948,floor3:0xad825b,
  linen:0xe1d4bd,sage:0x63765b,cushion:0xb29b6b,wine:0x713e39,navy:0x465b62,
  stone:0xaa9276,stoneLight:0xc1ad8f,terracotta:0xab614e,leaf:0x597348,darkLeaf:0x435d3d,
  brass:0xb18343,iron:0x3b3b35,ember:0xbd5d31,fire:0xe4a454,paper:0xd6be96
}

function mat(THREE,color,extra={}) {
  return new THREE.MeshStandardMaterial({color,roughness:.86,...extra})
}
function box(THREE,parent,name,material,x,y,z,sx,sy,sz,ry=0,rx=0,rz=0) {
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),material)
  mesh.name=name
  mesh.position.set(x,y,z)
  mesh.rotation.set(rx,ry,rz)
  mesh.castShadow=mesh.receiveShadow=true
  parent.add(mesh)
  return mesh
}
function archPoints(THREE,x,y,w,h,crown=0) {
  const points=[]
  if (!crown) return [[x-w/2,y],[x+w/2,y],[x+w/2,y+h],[x-w/2,y+h]]
  points.push([x-w/2,y],[x+w/2,y],[x+w/2,y+h-crown])
  for(let i=1;i<=12;i++) {
    const angle=Math.PI*i/12
    points.push([x+Math.cos(angle)*w/2,y+h-crown+Math.sin(angle)*crown])
  }
  return points
}
function shapePath(THREE,points) {
  const path=new THREE.Shape()
  path.moveTo(...points[0])
  points.slice(1).forEach(point=>path.lineTo(...point))
  path.closePath()
  return path
}
function facade(THREE,level,spec,bottom,top,materials) {
  const [x,z,yaw,left,right,height,openings]=spec
  top=Math.min(top,height)
  if(top<=bottom)return null
  const firstChild=level.children.length
  const usable=openings.filter(o=>o.y<top&&o.y+o.h>bottom)
  const shape=new THREE.Shape()
  shape.moveTo(left,bottom)
  shape.lineTo(right,bottom)
  shape.lineTo(right,top)
  shape.lineTo(left,top)
  shape.closePath()
  shape.holes=usable.map(o=>shapePath(THREE,archPoints(THREE,o.x,Math.max(o.y,bottom),o.w,o.h,o.crown)))
  const mesh=new THREE.Mesh(new THREE.ShapeGeometry(shape),materials.plaster)
  mesh.name='Facade wall'
  mesh.position.set(x,0,z)
  mesh.rotation.y=yaw
  mesh.userData.outward=new THREE.Vector3(Math.sin(yaw),0,Math.cos(yaw))
  mesh.castShadow=mesh.receiveShadow=true
  level.add(mesh)
  for(const o of usable) {
    const sill=Math.max(bottom,o.y), lintel=Math.min(top,o.y+o.h)
    if(o.bay) continue
    const isDoor=o===FRONT_DOOR||o===REAR_DOOR
    const frameMat=isDoor?materials.oak:materials.edge
    const frame=new THREE.Group()
    frame.name=isDoor?'Arched doorway':'Window frame'
    frame.position.set(x,0,z)
    frame.rotation.y=yaw
    level.add(frame)
    for(const side of [-1,1])box(THREE,frame,isDoor?'Door jamb':'Window casing',frameMat,
      o.x+side*o.w/2,(sill+lintel)/2,0,.075,lintel-sill,.12)
    box(THREE,frame,isDoor?'Door arch':'Window header',frameMat,o.x,lintel,0,o.w,.085,.12)
    if(o.crown) {
      const spring=o.y+o.h-o.crown
      for(let segment=0;segment<10;segment++) {
        const a=Math.PI*segment/10,b=Math.PI*(segment+1)/10
        const ax=Math.cos(a)*o.w/2,ay=spring+Math.sin(a)*o.crown
        const bx=Math.cos(b)*o.w/2,by=spring+Math.sin(b)*o.crown
        box(THREE,frame,isDoor?'Door arch':'Window arch',frameMat,o.x+(ax+bx)/2,(ay+by)/2,0,
          Math.hypot(bx-ax,by-ay),.07,.12,0,0,Math.atan2(by-ay,bx-ax))
      }
    }
    if(isDoor) {
      box(THREE,frame,'Door threshold',materials.stoneLight,o.x,sill,0,o.w+.20,.10,.35)
    }
    if(!isDoor) {
      const glazing=new THREE.Mesh(new THREE.ShapeGeometry(shapePath(THREE,archPoints(THREE,o.x,sill,o.w,lintel-sill,Math.min(o.crown,lintel-sill*.15)))),materials.glass)
      glazing.name='Glazed window'
      glazing.position.set(x+Math.sin(yaw)*.07,-0,z+Math.cos(yaw)*.07)
      glazing.rotation.y=yaw
      level.add(glazing)
      const columns=o.w>1.5?3:2
      for(let column=1;column<columns;column++) {
        const u=o.x+o.w*(column/columns-.5)
        box(THREE,level,'Oak window mullion',materials.oak,x+u*Math.cos(yaw),sill+(lintel-sill)/2,z-u*Math.sin(yaw),.045,lintel-sill,.05,yaw)
      }
      box(THREE,level,'Stone window sill',materials.stoneLight,x+o.x*Math.cos(yaw),sill-.06,z-o.x*Math.sin(yaw),o.w+.22,.11,.29,yaw)
    }
  }
  const shell=new THREE.Group()
  shell.name='Villa exterior wall '+wallSpecs.indexOf(spec)
  shell.userData={facadeIndex:wallSpecs.indexOf(spec),x,z,yaw}
  const additions=level.children.slice(firstChild)
  for(const child of additions) level.remove(child)
  shell.add(...additions)
  level.add(shell)
  return shell
}

function buildFloor(THREE,group,floor,mats) {
  const {minX,maxX,minZ,maxZ,y}=floor
  const rows=Math.ceil((maxZ-minZ)/.30),columns=Math.max(1,Math.ceil((maxX-minX)/2.3))
  for(let row=0;row<rows;row++) for(let col=0;col<columns;col++) {
    const width=(maxX-minX)/columns,depth=(maxZ-minZ)/rows
    const x=minX+width*(col+.5)+((row%3)-1)*.06
    const z=minZ+depth*(row+.5)
    box(THREE,group,'Oak floorboard',mats['floor'+((row*7+col*3)%4)],x,y-.06,z,width-.025,.12,depth-.025)
  }
}
function stairs(THREE,group,ramp,mats) {
  const {minX,maxX,minZ,maxZ,fromY,toY}=ramp
  const steps=Math.max(2,Math.round(Math.abs(toY-fromY)/.18)),run=(maxZ-minZ)/steps,width=maxX-minX
  for(let i=0;i<steps;i++) {
    const y=fromY+(toY-fromY)*(i+1)/steps,z=minZ+run*(i+.5)
    box(THREE,group,'Oak stair',mats.oak,(minX+maxX)/2,(y+Math.min(fromY,toY))*.5,z,width,y-Math.min(fromY,toY)+.08,run)
    box(THREE,group,'Stair tread',mats.edge,(minX+maxX)/2,y,z,width+.03,.055,run+.02)
  }
  const length=Math.hypot(maxZ-minZ,toY-fromY),angle=Math.atan2(fromY-toY,maxZ-minZ)
  for(const x of [minX+.06,maxX-.06]) for(const rail of [-1,1]) {
    box(THREE,group,'Stair handrail',mats.oak,x,(fromY+toY)/2+.72,(minZ+maxZ)/2,
      .075,.10,length,0,rail*angle)
    for(let t=.1;t<.95;t+=.20) box(THREE,group,'Stair baluster',mats.walnut,x,
      fromY+(toY-fromY)*t+.35,minZ+(maxZ-minZ)*t,.045,.70,.045)
  }
}
function furnish(THREE,parent,item,y,mats) {
  const {minX,maxX,minZ,maxZ,kind}=item
  const x=(minX+maxX)/2,z=(minZ+maxZ)/2,w=maxX-minX,d=maxZ-minZ
  const part=(name,material,dx,dy,dz,sx,sy,sz,ry=0)=>box(THREE,parent,name,material,x+dx,y+dy,z+dz,sx,sy,sz,ry)
  if(kind==='sofa') {
    part('Sofa frame',mats.walnut,0,.21,0,w,.30,d)
    part('Linen sofa',mats.sage,0,.48,0,w-.08,.42,d-.08)
    part('Sofa back',mats.sage,0,.76,d/2-.13,w-.12,.45,.22,-.12)
    for(const side of [-1,1]) part('Sofa arm',mats.sage,side*(w/2-.12),.63,0,.22,.36,d*.9)
    for(const [i,color] of ['wine','cushion','navy'].entries()) part('Cushion',mats[color],(i-1)*.68,.77,.21,.48,.30,.17,i*.12)
  } else if(kind==='coffee'||kind==='dining') {
    const dining=kind==='dining',height=dining?.76:.43
    part('Table top',mats.edge,0,height,0,w,.10,d)
    for(const sx of [-1,1])for(const sz of [-1,1])part('Table leg',mats.walnut,sx*(w/2-.11),height/2,sz*(d/2-.11),.08,height,.08)
    if(dining) for(const dx of [-w*.31,w*.31])for(const dz of [-d*.34,d*.34])
      box(THREE,parent,'Dining plate',mats.linen,x+dx,y+height+.08,z+dz,.30,.025,.30)
    else {
      part('Book',mats.paper,-.3,.51,.08,.42,.045,.28)
      part('Book cover',mats.wine,-.3,.54,.08,.42,.018,.28)
      part('Tea tray',mats.navy,.33,.51,-.08,.36,.04,.24)
    }
  } else if(kind==='fireplace') {
    part('Fireplace stone hearth',mats.stoneLight,0,.10,0,w+.25,.20,d)
    for(const side of [-1,1])part('Fireplace surround',mats.stone,0,.73,side*d*.35,w,.95,d*.28)
    part('Fireplace lintel',mats.stoneLight,0,1.26,0,w,.17,d)
    part('Fireplace mantel',mats.oak,0,1.41,0,w+.16,.15,d+.12)
    part('Blackened fireplace opening',mats.iron,0,.39,0,.11,.49,d*.53)
    for(let i=0;i<5;i++)box(THREE,parent,'Hearth flame',mats[i%2?'ember':'fire'],
      x+w*.27,y+.38+(i%3)*.09,z+(i-2)*d*.09,.09,.24+(i%3)*.04,.09)
  } else if(kind==='kitchen') {
    part('Kitchen island',mats.sage,0,.43,0,w,.86,d)
    part('Limestone counter',mats.stoneLight,0,.91,0,w+.10,.09,d+.10)
    const drawers=Math.max(2,Math.floor(d/.62))
    for(let i=0;i<drawers;i++) {
      const zz=-d/2+d*(i+.5)/drawers
      part('Oak cabinet front',mats.oak,-w*.49,.45,zz,.045,.58,d/drawers-.045)
      part('Brass pull',mats.brass,-w*.53,.60,zz,.045,.035,.14)
    }
    part('Cooktop',mats.iron,0,.97,d*.25,w*.68,.025,d*.24)
  } else if(kind==='pet') {
    part('Pet bed base',mats.oak,0,.13,0,w,.22,d)
    part('Pet bed cushion',mats.cushion,0,.28,0,w*.9,.17,d*.72)
    part('Raised pet bed end',mats.terracotta,0,.38,d*.40,w*.92,.20,.15)
    for(const sx of [-1,1])part('Raised pet bed side',mats.terracotta,sx*w*.42,.36,0,.14,.18,d*.9)
  } else if(kind==='bed') {
    part('Bed frame',mats.oak,0,.29,0,w,.34,d)
    part('Mattress',mats.linen,0,.49,.02,w-.10,.20,d-.12)
    part('Quilt',mats.navy,0,.62,-d*.15,w-.15,.08,d*.52)
    part('Bed headboard',mats.walnut,0,.76,-d/2+.05,w,.90,.14)
    for(const dx of [-w*.24,w*.24])part('Linen pillow',mats.linen,dx,.63,d*.32,w*.4,.14,.40)
  } else if(kind==='shelf') {
    const horizontal=w>=d,length=horizontal?w:d,thickness=horizontal?d:w
    const bookshelf=(name,material,along,height,across,lengthSize,heightSize,depthSize)=> {
      const dx=horizontal?along:across,dz=horizontal?across:along
      const sx=horizontal?lengthSize:depthSize,sz=horizontal?depthSize:lengthSize
      part(name,material,dx,height,dz,sx,heightSize,sz)
    }
    bookshelf('Library back',mats.walnut,0,1.02,-thickness*.40,length,2.04,.10)
    for(let row=0;row<4;row++) {
      const shelfY=.14+row*.45
      bookshelf('Oak book shelf',mats.edge,0,shelfY,0,length,.09,thickness)
      const count=Math.floor(length/.16)
      for(let book=0;book<count;book++) {
        const along=length*((book+.6)/count-.5),height=.21+(book%4)*.035
        bookshelf('Hardcover book',mats[['wine','navy','sage','terracotta'][book%4]],along,
          shelfY+.045+height/2,0,.10,height,thickness*.7)
      }
    }
  }
}
function pot(THREE,group,x,y,z,size,mats) {
  const pot=new THREE.Mesh(new THREE.CylinderGeometry(size*.27,size*.40,size*.53,14),mats.terracotta)
  pot.position.set(x,y+size*.27,z);pot.castShadow=true;group.add(pot)
  for(let i=0;i<8;i++) {
    const a=i*2.4,r=size*(.07+(i%3)*.045)
    const leaf=new THREE.Mesh(new THREE.IcosahedronGeometry(size*.17,0),mats[i%2?'leaf':'darkLeaf'])
    leaf.position.set(x+Math.cos(a)*r,y+size*(.69+(i%3)*.09),z+Math.sin(a)*r)
    leaf.scale.set(.85,1.4,.7);leaf.castShadow=true;group.add(leaf)
  }
}

function mergeDirectMeshes(THREE, group) {
  const byMaterial = new Map()
  for (const child of [...group.children]) {
    if (!child.isMesh || Array.isArray(child.material)) continue
    child.updateMatrix()
    const geometry = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()
    geometry.applyMatrix4(child.matrix)
    let geometries = byMaterial.get(child.material)
    if (!geometries) byMaterial.set(child.material, geometries = [])
    geometries.push(geometry)
    child.geometry.dispose()
    group.remove(child)
  }
  for (const [material, geometries] of byMaterial) {
    const geometry = mergeGeometries(geometries, false)
    geometries.forEach(part => part.dispose())
    if (!geometry) throw new Error('Could not batch villa interior meshes for ' + material.name)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = group.name + ' - ' + (material.name || 'interior')
    mesh.userData.floorLevel = group.userData.floorLevel ?? geometries[0].userData?.floorLevel
    if (group.userData.floorSurfaceLevel) mesh.userData.floorSurfaceLevel = group.userData.floorSurfaceLevel
    mesh.castShadow = mesh.receiveShadow = true
    group.add(mesh)
  }
}

function optimizeMeshes(THREE, group) {
  for (const child of [...group.children]) {
    if (child.isGroup) optimizeMeshes(THREE, child)
  }
  mergeDirectMeshes(THREE, group)
}

function createVillaInterior(THREE) {
  const mats=Object.fromEntries(Object.entries(palette).map(([name,color])=>[name,mat(THREE,color,
    name==='glass'||name==='plaster'?{side:THREE.DoubleSide}: {})]))
  mats.glass.transparent=true
  mats.glass.opacity=.30
  mats.glass.depthWrite=false
  const root=new THREE.Group()
  root.name='Furnished villa interior'
  const levels=[new THREE.Group(),new THREE.Group()]
  levels[0].name='Ground floor'
  levels[1].name='Upper floor'
  root.add(...levels)
  const floorSurfaces=[new THREE.Group(),new THREE.Group()]
  floorSurfaces[0].name='Ground floorboards'
  floorSurfaces[1].name='Upper floorboards'
  levels[0].add(floorSurfaces[0])
  levels[1].add(floorSurfaces[1])
  for(const floor of VILLA_LAYOUT.floors)buildFloor(THREE,floorSurfaces[floor.level===2?1:0],floor,mats)
  for(const ramp of VILLA_LAYOUT.ramps)stairs(THREE,levels[0],ramp,mats)
  for(const item of VILLA_LAYOUT.furniture)furnish(THREE,levels[item.level===2?1:0],item,item.level===2?3.43:.405,mats)
  for(let story=0;story<2;story++) {
    for(let i=0;i<wallSpecs.length;i++) {
      const spec=wallSpecs[i], wing=i>=7&&i<=10||i===13
      const bottom=story&&wing?2.69:story?3.43:.405
      const top=!story&&wing?2.69:story?6.37:3.43
      const wall=facade(THREE,levels[story],spec,bottom,top,mats)
      if(wall) {
        wall.name='Villa exterior wall '+i+' level '+(story+1)
        wall.userData.facadeIndex=i
      }
    }
  }
  for(const [group,x,y,z,size] of [
    [levels[0],2.30,.405,-3.03,.43],[levels[0],-9.79,.405,-2.76,.45],
    [levels[1],2.36,3.43,3.08,.43],[levels[1],6.96,3.43,3.92,.43]
  ])pot(THREE,group,x,y,z,size,mats)
  for (const [index, level] of levels.entries()) {
    level.traverse(node => { node.userData.floorLevel = index + 1 })
  }
  floorSurfaces.forEach((group, index) => { group.userData.floorSurfaceLevel = index + 1 })
  optimizeMeshes(THREE, root)
  root.userData={units:'meters',up:'+Y',front:'+Z',origin:'existing villa exterior floor center'}
  root.traverse(node=>{if(node.isMesh)node.castShadow=node.receiveShadow=true})
  function setCutaway(level='both',cameraLocal={x:16,z:17}) {
    const showGround=level==='both'||level===1||level==='ground'
    const showUpper=level==='both'||level===2||level==='upper'
    levels[0].visible=showGround;levels[1].visible=showUpper
    floorSurfaces[0].visible=showGround
    floorSurfaces[1].visible=showUpper&&level!=='both'
    for(const story of [0,1]) for(const wall of levels[story].children) {
      if(wall.userData.facadeIndex===undefined)continue
      const across=(cameraLocal.x-wall.userData.x)*Math.sin(wall.userData.yaw)+
        (cameraLocal.z-wall.userData.z)*Math.cos(wall.userData.yaw)
      wall.visible=(story?showUpper:showGround)&&(level==='both'?across<-.09:across<.09)
    }
  }
  root.setCutaway=setCutaway
  setCutaway('both')
  return {root,group:root,setCutaway}
}

export { createVillaInterior, VILLA_LAYOUT }
