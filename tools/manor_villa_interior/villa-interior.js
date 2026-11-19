import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { BAYS, ELEVATOR, GROUND_Y, UPPER_Y, WEST_UPPER_Y, WEST_STUDY_FLOOR, VILLA_LAYOUT } from './villa-layout.js'

const FRONT_DOOR = { x: 1.28, y: .40, w: 1.28, h: 2.34, crown: .49 }
const REAR_DOOR = { x: .65, y: .38, w: 1.18, h: 2.23, crown: .33 }
const UPPER_SLAB_THICKNESS = .17
const win = (x, y, w, h, crown = 0) => ({ x, y, w, h, crown })
const bay = b => ({ x: b.x, y: b.floorY, w: b.width, h: b.y + b.height - b.floorY, bay: b })
const wallSpecs = [
  [0, 3.56, 0, -6.46, 2.83, 6.50, [FRONT_DOOR,
    win(-4.01,.81,1.94,1.73,.38),win(-1.37,.81,1.90,1.73,.38),
    win(-3.86,3.99,.91,1.33,.16),win(-1.42,3.96,.92,1.39,.16),win(1.02,4.02,1.04,1.26)]],
  [0,-3.60,Math.PI,-2.84,6.46,6.48,[REAR_DOOR,
    win(-1.47,.86,1.54,1.77),win(3.43,.82,1.38,1.64),win(5.27,.86,1.06,1.54),
    win(-1.78,3.98,1.15,1.50),win(.62,4.04,1.20,1.47),win(4.49,4.01,1.40,1.49)]],
  [0,4.93,0,2.83,7.53,6.42,[win(3.87,4.08,.80,1.51), bay(BAYS.eastGround), bay(BAYS.eastUpper)]],
  [0,-4.34,Math.PI,-7.53,-2.83,6.42,[win(-5.15,.81,2.05,1.64,.24),
    win(-6.31,4,1.26,1.66),win(-4.02,4.04,.96,1.47)]],
  [7.53,0,Math.PI/2,-4.93,4.34,6.33,[win(-3.47,.83,1.19,1.72),win(-.78,.83,1.53,1.72),
    win(2.44,.87,1.42,1.68),win(-3.51,4.04,1.10,1.56,.15),win(-.76,4.1,1.20,1.51),win(2.30,4.07,1.24,1.52)]],
  [2.83,4.24,-Math.PI/2,-.68,.69,6.38,[]],
  [2.83,-3.96,-Math.PI/2,-.38,.36,6.38,[]],
  [0,3.22,0,-7.33,-6.46,5.03,[win(-6.99,1,.65,1.29)]],
  [0,3.22,0,-10.32,-10.18,5.03,[]],
  [0,3.93,0,-10.18,-7.33,5.03,[bay(BAYS.westGround),win(-8.76,3.18,1.29,1.40)]],
  [-10.18,3.57,-Math.PI/2,-.35,.36,5.03,[]],
  [-7.33,3.57,Math.PI/2,-.36,.35,5.03,[]],
  [0,-3.43,Math.PI,6.46,10.32,5.02,[win(8.61,.84,1.45,1.49),win(7.52,3.02,.91,1.36),win(9.21,3.02,.77,1.29)]],
  [-10.32,0,-Math.PI/2,-3.43,3.22,5.02,[win(-.04,.88,1.54,1.46),win(-1.76,3.01,1.14,1.34),win(1.43,3,1.12,1.34)]],
  [-6.46,0,-Math.PI/2,3.22,3.56,6.34,[]],
  [-6.46,0,-Math.PI/2,-3.60,-3.43,6.34,[]]
]

const palette = {
  plaster:0xe4d7c0, oak:0x674832, edge:0xb58b59, walnut:0x49312a, glass:0x9dbcb7,
  floor0:0x98724f,floor1:0xa37b55,floor2:0x906948,floor3:0xad825b,subfloor:0x806248,
  linen:0xe1d4bd,sage:0x63765b,cushion:0xb29b6b,wine:0x713e39,navy:0x465b62,
  stone:0xaa9276,stoneLight:0xc1ad8f,terracotta:0xab614e,leaf:0x597348,darkLeaf:0x435d3d,
  brass:0xb18343,iron:0x3b3b35,ember:0xbd5d31,fire:0xe4a454,paper:0xd6be96,
  textile:0x758078,trim:0xb6a587,
  liftBronze:0x8c6850,liftBrass:0xc29867,liftIron:0x3f4944,liftStone:0xc9b7a0,
  shaftGlass:0xbce1d9,cabinGlass:0xb0ded6,liftLight:0xffebc2
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
function archPoints(x,y,w,h,crown=0) {
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

function makePanel(THREE,group,name,geometry,material) {
  const mesh=new THREE.Mesh(geometry,material)
  mesh.name=name
  mesh.castShadow=mesh.receiveShadow=true
  group.add(mesh)
  return mesh
}

function plasterPanel(THREE,group,left,right,bottom,top,openings,mats) {
  if(top<=bottom)return
  const sillOpenings=openings.filter(o=>o.y<=bottom+1e-6).sort((a,b)=>a.x-b.x)
  const perimeter=[[left,bottom]]
  for(const o of sillOpenings) {
    const [a,b,...sides]=archPoints(o.x,bottom,o.w,o.h,o.crown)
    perimeter.push(a,...sides.reverse(),b)
  }
  perimeter.push([right,bottom],[right,top],[left,top])
  const shape=shapePath(THREE,perimeter)
  shape.holes=openings.filter(o=>o.y>bottom+1e-6)
    .map(o=>shapePath(THREE,archPoints(o.x,o.y,o.w,o.h,o.crown)))
  makePanel(THREE,group,'Plaster wall',new THREE.ExtrudeGeometry(shape,
    {depth:.08,bevelEnabled:false}),mats.plaster)
  let start=left
  for(const o of [...sillOpenings,{x:right,w:0}]) {
    const end=o.x-o.w/2
    if(end-start>.04)box(THREE,group,'Oak baseboard',mats.oak,(start+end)/2,bottom+.065,-.018,end-start,.13,.042)
    start=o.x+o.w/2
  }
}

function finishOpening(THREE,group,o,mats) {
  const outline=archPoints(o.x,o.y,o.w,o.h,o.crown)
  const frame=o.door?mats.oak:mats.edge
  for(let i=0;i<outline.length;i++) {
    if(i===0&&o.door)continue
    const [ax,ay]=outline[i], [bx,by]=outline[(i+1)%outline.length]
    box(THREE,group,o.door?'Oak doorway':'Oak window casing',frame,(ax+bx)/2,(ay+by)/2,.025,
      Math.hypot(bx-ax,by-ay)+.035,.075,.13,0,0,Math.atan2(by-ay,bx-ax))
  }
  if(o.door) {
    box(THREE,group,'Stone threshold',mats.stoneLight,o.x,o.y-.028,.035,o.w+.10,.06,.28)
    return
  }
  const pane=makePanel(THREE,group,'Window glazing',new THREE.ShapeGeometry(shapePath(THREE,outline)),mats.glass)
  pane.position.z=.036
  pane.castShadow=false
  const columns=o.columns??(o.w>1.5?3:2)
  for(let column=1;column<columns;column++) {
    const u=column/columns, top=o.h-o.crown+o.crown*Math.sqrt(1-(u*2-1)**2)
    box(THREE,group,'Oak window mullion',mats.oak,o.x+o.w*(u-.5),o.y+top/2,.025,.043,top,.065)
  }
  box(THREE,group,'Oak window transom',mats.oak,o.x,o.y+o.h*.53,.025,o.w,.04,.062)
  box(THREE,group,'Stone window sill',mats.stoneLight,o.x,o.y-.048,.027,o.w+.12,.09,.22)
}

function slab(THREE,group,name,mats,xz,y,thickness) {
  const shape=shapePath(THREE,xz.map(([x,z])=>[x,-z]))
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false})
  geometry.rotateX(-Math.PI/2).translate(0,y-thickness,0)
  return makePanel(THREE,group,name,geometry,mats)
}

function buildBay(THREE,shell,b,mats) {
  const left=b.x-b.width/2, right=b.x+b.width/2
  const faceLeft=b.x-b.faceWidth/2,faceRight=b.x+b.faceWidth/2
  const far=b.depth, cap=b.y+b.height
  const footprint=[[left,0],[right,0],[faceRight,far],[faceLeft,far]]
  const bayGroup=new THREE.Group()
  bayGroup.name='Glazed projecting bay'
  bayGroup.userData.bayWindow=true
  shell.add(bayGroup)
  for(const [a,c,front] of [[[left,0],[faceLeft,far],false],[[faceLeft,far],[faceRight,far],true],[[faceRight,far],[right,0],false]]) {
    const dx=c[0]-a[0], dz=c[1]-a[1], width=Math.hypot(dx,dz)
    const side=new THREE.Group()
    side.name=front?'Bay picture window':'Bay return window'
    side.position.set((a[0]+c[0])/2,0,(a[1]+c[1])/2)
    side.rotation.y=-Math.atan2(dz,dx)
    // The upper bay's exterior sill is set low, close to the finished floor.
    const glass={...win(0,b.y+.31,width-(front?.22:.16),b.height-.56),columns:front?(b.faceWidth>1.5?4:3):1}
    plasterPanel(THREE,side,-width/2,width/2,b.floorY,cap,[glass],mats)
    finishOpening(THREE,side,glass,mats)
    bayGroup.add(side)
  }
  slab(THREE,bayGroup,'Bay window ceiling',mats.oak,footprint,cap,.085)
}

function facade(THREE,level,spec,bottom,top,mats) {
  const [x,z,yaw,left,right,height,openings]=spec
  top=Math.min(top,height)
  if(top<=bottom)return
  const usable=openings.filter(o=>o.y<top&&o.y+o.h>bottom).map(o=>{
    const sill=Math.max(bottom,o.y)
    return {...o,y:sill,h:Math.min(top,o.y+o.h)-sill,door:o===FRONT_DOOR||o===REAR_DOOR}
  })
  const shell=new THREE.Group()
  shell.name='Villa exterior wall '+wallSpecs.indexOf(spec)
  shell.userData={facadeIndex:wallSpecs.indexOf(spec),x,z,yaw}
  shell.position.set(x,0,z)
  shell.rotation.y=yaw
  plasterPanel(THREE,shell,left,right,bottom,top,usable,mats)
  for(const o of usable) {
    if(o.bay)buildBay(THREE,shell,o.bay,mats)
    else finishOpening(THREE,shell,o,mats)
  }
  level.add(shell)
  return shell
}

function buildFloor(THREE,group,floor,mats) {
  const {minX,maxX,minZ,maxZ,y,outline}=floor
  const rows=Math.ceil((maxZ-minZ)/.32), depth=(maxZ-minZ)/rows
  const finish=.026, thickness=floor.level===1?.20:UPPER_SLAB_THICKNESS, gap=.008
  if(outline) {
    slab(THREE,group,'Continuous bay floor',mats.subfloor,outline,y-finish,thickness-finish)
    const [[x0],[x1],[x2],[x3]]=outline
    const spans=z=>{
      const t=(z-minZ)/(maxZ-minZ)
      return [x0+(x3-x0)*t,x1+(x2-x1)*t]
    }
    for(let row=0;row<rows;row++) {
      const a=minZ+depth*row+(row?gap/2:0), b=minZ+depth*(row+1)-(row===rows-1?0:gap/2)
      const [leftA,rightA]=spans(a), [leftB,rightB]=spans(b)
      slab(THREE,group,'Oak bay floorboard',mats['floor'+(row%4)],
        [[leftA,a],[rightA,a],[rightB,b],[leftB,b]],y,finish)
    }
    return
  }
  const width=maxX-minX
  box(THREE,group,'Continuous floor slab',mats.subfloor,(minX+maxX)/2,y-(thickness+finish)/2,(minZ+maxZ)/2,
    width,thickness-finish,maxZ-minZ)
  const length=width/Math.max(1,Math.ceil(width/2.30))
  for(let row=0;row<rows;row++) {
    const stagger=width>2.4?length*(row%3)/3:0
    for(let col=0;col*length-stagger<width-1e-6;col++) {
      const x0=col*length-stagger, x1=x0+length
      const a=minX+Math.max(0,x0)+(x0>0?gap/2:0)
      const b=minX+Math.min(width,x1)-(x1<width-1e-6?gap/2:0)
      const z0=minZ+row*depth+(row?gap/2:0), z1=minZ+(row+1)*depth-(row===rows-1?0:gap/2)
      box(THREE,group,'Oak floorboard',mats['floor'+((row*7+col*3)%4)],
        (a+b)/2,y-finish/2,(z0+z1)/2,b-a,finish,z1-z0)
    }
  }
}

function rail(THREE,group,start,end,mats,{height=.91,name='Oak handrail',footY=p=>p.y}={}) {
  const a=new THREE.Vector3(...start), b=new THREE.Vector3(...end)
  const delta=b.clone().sub(a), center=a.clone().lerp(b,.5)
  const handrail=box(THREE,group,name,mats.oak,center.x,center.y+height,center.z,.09,delta.length()+.07,.076)
  handrail.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.clone().normalize())
  const spans=Math.max(1,Math.ceil(Math.hypot(delta.x,delta.z)/.23))
  for(let i=0;i<=spans;i++) {
    const t=(i+.08)/(spans+.16), p=a.clone().lerp(b,t), bottom=footY(p,t), top=p.y+height
    const newel=i===0||i===spans
    const w=newel?.085:.035
    box(THREE,group,newel?'Oak newel':'Stair baluster',newel?mats.oak:mats.walnut,p.x,(bottom+top)/2,p.z,w,top-bottom,w)
    if(newel)box(THREE,group,'Oak newel cap',mats.edge,p.x,p.y+height+.036,p.z,.103,.054,.103)
  }
}

function stairs(THREE,group,ramp,mats) {
  const {minX,maxX,minZ,maxZ,fromY,toY,axis}=ramp, alongZ=axis==='z'
  const a=alongZ?minZ:minX, b=alongZ?maxZ:maxX, left=alongZ?minX:minZ, right=alongZ?maxX:maxZ
  const steps=Math.ceil(Math.abs(toY-fromY)/.185), run=(b-a)/steps, width=right-left
  const base=Math.min(fromY,toY), across=(left+right)/2
  for(let i=0;i<steps;i++) {
    const y=fromY+(toY-fromY)*(i+.5)/steps, u=a+run*(i+.5)
    const [x,z]=alongZ?[across,u]:[u,across]
    const [sx,sz]=alongZ?[width,run]:[run,width]
    const tread=.041
    box(THREE,group,'Closed oak riser',mats.oak,x,(y+base-tread)/2,z,sx,y-base-tread,sz)
    box(THREE,group,'Rounded tread edge',mats.edge,x,y-tread/2,z,sx,tread,sz)
  }
  for(const s of [left+.07,right-.07]) {
    const footY=(_,t)=>fromY+(toY-fromY)*(Math.floor(t*steps)+.5)/steps-.007
    rail(THREE,group,alongZ?[s,fromY,a]:[a,fromY,s],alongZ?[s,toY,b]:[b,toY,s],mats,{footY})
  }
}

function landingRails(THREE,upper,mats) {
  const [study]=VILLA_LAYOUT.ramps
  const x=study.maxX+.055
  rail(THREE,upper,[x,UPPER_Y,WEST_STUDY_FLOOR.minZ+.055],[x,UPPER_Y,study.minZ-.055],mats)
  rail(THREE,upper,[x,UPPER_Y,study.maxZ+.055],[x,UPPER_Y,WEST_STUDY_FLOOR.maxZ-.055],mats)
}

function finishStudyLanding(THREE,upperFloor,mats) {
  const {maxX,minZ,maxZ,y}=WEST_STUDY_FLOOR
  const underside=UPPER_Y-UPPER_SLAB_THICKNESS
  const z=(minZ+maxZ)/2, span=maxZ-minZ
  // Close the space beneath the higher hall while leaving the stair portal free above it.
  box(THREE,upperFloor,'Split level plaster riser',mats.plaster,maxX+.054,(y+underside)/2,z,
    .108,underside-y,span)
  box(THREE,upperFloor,'Split level oak rim',mats.oak,maxX-.013,(underside+UPPER_Y)/2,z,
    .026,UPPER_SLAB_THICKNESS,span)
}

function buildElevator(THREE, root, groundFloor, mats) {
  const {bounds, openingWidth, landings, platformNode}=ELEVATOR
  const x=(bounds.minX+bounds.maxX)/2, z=(bounds.minZ+bounds.maxZ)/2
  const width=bounds.maxX-bounds.minX, depth=bounds.maxZ-bounds.minZ
  const travel=landings[1].y-landings[0].y
  const doorHeight=2.17
  const doorNodes=[]
  const lift=new THREE.Group(), shaft=new THREE.Group(), cabin=new THREE.Group()
  lift.name='Glass lift assembly'
  lift.position.set(x,0,z)
  root.add(lift)
  shaft.name='VillaElevatorShaft'
  shaft.userData.elevatorRole='shaft'
  cabin.name=platformNode
  cabin.userData={elevatorRole:'car',travel}
  cabin.position.y=GROUND_Y
  lift.add(shaft,cabin)

  function pane(group,name,material,x,y,z,w,h,yaw=0) {
    const mesh=makePanel(THREE,group,name,new THREE.PlaneGeometry(w,h),material)
    mesh.position.set(x,y,z)
    mesh.rotation.y=yaw
  }

  function enclosure(group,w,d,bottom,top,material,frame) {
    const h=top-bottom, y=(top+bottom)/2
    for(const side of [-1,1]) {
      pane(group,'Side glazing',material,side*w/2,y,0,d,h,Math.PI/2)
      for(const end of [-1,1])box(THREE,group,'Slim corner post',mats.liftBronze,
        side*w/2,y,end*d/2,frame,h,frame)
    }
    pane(group,'Rear glazing',material,0,y,-d/2,w,h)
    for(const y of [bottom,top]) {
      box(THREE,group,'Rear glazing trim',mats.liftBronze,0,y,-d/2,w,frame,frame)
      for(const side of [-1,1])box(THREE,group,'Side glazing trim',mats.liftBronze,side*w/2,y,0,frame,frame,d)
    }
  }

  function doors(group,prefix,z,y,floor,material) {
    const leafWidth=openingWidth/4
    for(const side of [-1,1])for(let lane=0;lane<2;lane++) {
      const leaf=new THREE.Group()
      leaf.name=`${prefix}${side<0?'L':'R'}${lane+1}`
      leaf.position.set(side*leafWidth*(lane+.5),y,z-lane*.023)
      const slideX=side*(openingWidth/2+leafWidth/2+.006)-leaf.position.x
      const landing=floor?{floor}:{}
      leaf.userData={elevatorRole:'door',slideX,...landing}
      doorNodes.push({name:leaf.name,dx:slideX,dz:0,...landing})
      group.add(leaf)
      pane(leaf,'Sliding glass leaf',material,0,doorHeight/2,0,leafWidth-.002,doorHeight-.035)
      for(const edge of [-1,1]) {
        box(THREE,leaf,'Door glazing edge',mats.liftBrass,edge*(leafWidth/2-.006),doorHeight/2,0,.012,doorHeight,.016)
        box(THREE,leaf,'Door cap',mats.liftBronze,0,edge<0?.016:doorHeight-.016,0,leafWidth,.032,.018)
      }
    }
  }

  box(THREE,groundFloor,'Lift pit support',mats.subfloor,x,GROUND_Y-.163,z,width,.074,depth)
  enclosure(shaft,width-.055,depth-.055,GROUND_Y-.126,UPPER_Y+2.37,mats.shaftGlass,.042)
  for(const side of [-1,1])box(THREE,shaft,'Lift guide rail',mats.liftIron,
    side*.56,(GROUND_Y+UPPER_Y+2.23)/2,-.865,.051,travel+2.34,.038)
  for(const {floor,y} of landings) {
    const frameZ=(depth-.055)/2, jambX=openingWidth/2+.015
    for(const side of [-1,1]) {
      box(THREE,shaft,'Landing door jamb',mats.liftBronze,side*jambX,y+doorHeight/2,frameZ,
        .036,doorHeight,.055)
      const sidelightWidth=(width-.055)/2-jambX
      pane(shaft,'Landing sidelight',mats.shaftGlass,side*(jambX+sidelightWidth/2),y+doorHeight/2,
        frameZ,sidelightWidth,doorHeight)
    }
    box(THREE,shaft,'Bronze threshold',mats.liftBrass,0,y-.013,depth/2,openingWidth+.09,.026,.16)
    box(THREE,shaft,'Landing lintel',mats.liftBronze,0,y+doorHeight+.089,frameZ,width-.055,.178,.072)
    const top=floor===1?UPPER_Y:UPPER_Y+2.37
    const transom=top-y-doorHeight-.178
    if(transom>.01)pane(shaft,'Glazed transom',mats.shaftGlass,0,top-transom/2,frameZ,width-.063,transom)
    box(THREE,shaft,'Landing number plaque',mats.liftIron,0,y+doorHeight+.089,frameZ+.039,.172,.125,.018)
    for(let i=0;i<floor;i++)box(THREE,shaft,'Landing number inlay',mats.liftLight,
      (i-(floor-1)/2)*.032,y+doorHeight+.089,frameZ+.050,.013,.068,.005)
    box(THREE,shaft,'Call button plate',mats.liftBronze,1.3*jambX,y+1.11,frameZ+.027,.087,.143,.032)
    const button=makePanel(THREE,shaft,'Lit call button',new THREE.CylinderGeometry(.023,.023,.011,16),mats.liftLight)
    button.rotation.x=Math.PI/2
    button.position.set(1.3*jambX,y+1.11,frameZ+.049)
    doors(shaft,`VillaLift${floor}FDoor`,frameZ-.049,y+.009,floor,mats.shaftGlass)
  }

  const carW=width-.115, carD=depth-.153
  box(THREE,cabin,'Cabin platform',mats.liftBronze,0,-.072,0,carW,.107,carD)
  box(THREE,cabin,'Machined deck rim',mats.liftBrass,0,-.017,0,carW,.034,carD)
  for(let i=0;i<7;i++)box(THREE,cabin,'Oak cabin decking',mats['floor'+(i%4)],0,-.010,
    (i-3)*(carD-.078)/7,carW-.077,.020,(carD-.078)/7-.005)
  enclosure(cabin,carW-.029,carD-.028,.006,2.22,mats.cabinGlass,.029)
  const carFront=carD/2-.025
  for(const side of [-1,1]) {
    const w=(carW-.029-openingWidth)/2
    pane(cabin,'Cabin front sidelight',mats.cabinGlass,side*(openingWidth+w)/2,1.09,carFront,w,2.17)
    box(THREE,cabin,'Cabin handrail',mats.liftBrass,side*(carW/2-.068),.98,-.075,.037,.035,carD-.36)
  }
  box(THREE,cabin,'Rear cabin handrail',mats.liftBrass,0,.98,-carD/2+.067,carW-.20,.035,.043)
  box(THREE,cabin,'Slim bronze canopy',mats.liftBronze,0,2.242,0,carW,.064,carD)
  box(THREE,cabin,'Light oak ceiling',mats.liftStone,0,2.202,0,carW-.09,.021,carD-.08)
  for(const side of [-1,1])box(THREE,cabin,'Recessed cabin light',mats.liftLight,
    side*(carW/2-.14),2.188,0,.029,.014,carD-.22)
  doors(cabin,'VillaLiftCabinDoor',carFront,.008,0,mats.cabinGlass)
  return { ...ELEVATOR, doorNodes }
}

function deskLamp(THREE,group,x,y,z,mats) {
  const base=makePanel(THREE,group,'Brass lamp base',new THREE.CylinderGeometry(.112,.132,.043,18),mats.brass)
  base.position.set(x,y+.022,z)
  box(THREE,group,'Lamp stand',mats.brass,x,y+.20,z,.029,.37,.029)
  const shade=makePanel(THREE,group,'Linen lamp shade',new THREE.CylinderGeometry(.094,.169,.17,18),mats.linen)
  shade.position.set(x,y+.37,z)
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
    part('Fireplace stone hearth',mats.stoneLight,0,.064,0,w,.128,d)
    for(const side of [-1,1])part('Carved stone surround',mats.stone,side*w*.391,.39,d*.073,w*.18,.59,d*.81)
    part('Fireplace lintel',mats.stoneLight,0,.74,d*.06,w*.965,.14,d*.80)
    part('Oak mantel',mats.oak,0,.855,d*.02,w,.092,d*.88)
    part('Blackened fireplace back',mats.iron,0,.408,d*.41,w*.62,.57,d*.10)
    for(let i=0;i<5;i++)part('Hearth flame',mats[i%2?'ember':'fire'],
      (i-2)*w*.092,.251+(i%3)*.05,d*.13,.087,.208+(i%3)*.06,.087)
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
  } else if(kind==='desk') {
    const height=.76
    part('Writing desk top',mats.edge,0,height,0,w,.075,d)
    part('Oak desk apron',mats.oak,0,.65,d*.32,w-.12,.15,.11)
    for(const sx of [-1,1])for(const sz of [-1,1]) {
      part('Writing desk leg',mats.walnut,sx*(w/2-.10),.35,sz*(d/2-.09),.10,.70,.10)
    }
    for(const dx of [-w*.24,w*.24]) {
      part('Desk drawer front',mats.edge,dx,.653,-d*.407,w*.44,.12,.056)
      part('Desk drawer pull',mats.brass,dx,.655,-d*.452,.13,.031,.031)
    }
    deskLamp(THREE,parent,x+w*.32,y+height+.037,z+d*.19,mats)
    part('Leather writing mat',mats.sage,-.14,.804,-.055,.71,.014,.47)
    for(const side of [-1,1]) {
      part('Open notebook cover',mats.wine,-.14+side*.125,.821,-.053,.25,.017,.29,side*.03)
      part('Open notebook page',mats.paper,-.14+side*.125,.837,-.053,.235,.017,.272,side*.03)
    }
    part('Pencil',mats.walnut,.12,.848,.02,.15,.015,.015,.10)
    part('Closed study book',mats.navy,-w*.34,.824,d*.11,.29,.056,.36,.10)
    part('Closed study book',mats.wine,-w*.34,.879,d*.11,.26,.052,.33,-.07)
  } else if(kind==='chair') {
    const facing=item.reversed?-1:1
    part('Chair seat',mats.oak,0,.425,0,w-.04,.083,d-.07)
    part('Upholstered seat',mats.textile,0,.48,-facing*.02,w-.069,.068,d-.15)
    for(const sx of [-1,1])for(const sz of [-1,1]) {
      part('Chair leg',mats.walnut,sx*(w/2-.08),.203,sz*(d/2-.08),.062,.406,.062)
    }
    for(const dx of [-w*.36,w*.36])part('Chair back post',mats.oak,dx,.70,-facing*(d/2-.08),.063,.49,.065)
    part('Arched chair back',mats.oak,0,.925,-facing*(d/2-.08),w*.82,.092,.062)
    for(const dx of [-w*.22,0,w*.22])part('Chair back slat',mats.edge,dx,.692,-facing*(d/2-.08),.033,.42,.041)
  } else if(kind==='nightstand') {
    part('Nightstand cabinet',mats.oak,0,.31,0,w-.06,.51,d-.08)
    part('Nightstand top',mats.edge,0,.585,0,w,.061,d)
    for(const dy of [.28,.453]) {
      part('Nightstand drawer',mats.edge,0,dy,d*.448,w-.11,.135,.046)
      part('Brass knob',mats.brass,0,dy,d*.495,.067,.027,.033)
    }
    for(const sx of [-1,1])for(const sz of [-1,1])part('Nightstand foot',mats.walnut,sx*w*.32,.042,sz*d*.32,.074,.085,.074)
    deskLamp(THREE,parent,x,y+.615,z-.04,mats)
  } else if(kind==='shelf') {
    const horizontal=w>=d,length=horizontal?w:d,thickness=horizontal?d:w
    const bookshelf=(name,material,along,height,across,lengthSize,heightSize,depthSize)=> {
      const dx=horizontal?along:across,dz=horizontal?across:along
      const sx=horizontal?lengthSize:depthSize,sz=horizontal?depthSize:lengthSize
      part(name,material,dx,height,dz,sx,heightSize,sz)
    }
    const height=item.room==='study'?1.78:2.04
    bookshelf('Library back',mats.walnut,0,height/2,-thickness*.39,length,height,.065)
    for(const side of [-1,1])bookshelf('Oak bookcase side',mats.oak,side*(length/2-.036),height/2,0,.072,height,thickness)
    for(let row=0;row<=4;row++) {
      const shelfY=.09+row*(height-.125)/4
      bookshelf('Oak book shelf',mats.edge,0,shelfY,0,length,.07,thickness)
      if(row===4)break
      const count=Math.floor((length-.13)/.148)
      for(let book=0;book<count;book++) {
        if((row*2+book)%9===7)continue
        const along=(length-.13)*((book+.5)/count-.5),height=.185+((book+row)%5)*.033
        bookshelf('Hardcover book',mats[['wine','navy','sage','terracotta'][book%4]],along,
          shelfY+.035+height/2,.027,.095+(book%3)*.012,height,thickness*.64)
        for(const band of [.18,.79])bookshelf('Book spine tooling',mats.brass,along,shelfY+.035+height*band,
          thickness*.35+.027,.077,.009,.006)
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
    // Keep individual lift panes sortable as the cab and doors move.
    if (!child.isMesh || Array.isArray(child.material) || child.material.userData.sortIndividual) continue
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
    const combined = mergeGeometries(geometries, false)
    geometries.forEach(part => part.dispose())
    if (!combined) throw new Error('Could not batch villa interior meshes for ' + material.name)
    const mesh = new THREE.Mesh(mergeVertices(combined), material)
    combined.dispose()
    mesh.name = group.name + ' - ' + material.name
    mesh.userData.floorLevel = group.userData.floorLevel
    if (group.userData.floorSurfaceLevel) mesh.userData.floorSurfaceLevel = group.userData.floorSurfaceLevel
    mesh.castShadow = !material.transparent
    mesh.receiveShadow = true
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
  const mats=Object.fromEntries(Object.entries(palette).map(([name,color])=>[name,mat(THREE,color,{
    name,...(name==='glass'?{side:THREE.DoubleSide}:{})
  })]))
  mats.glass.transparent=true
  mats.glass.opacity=.38
  mats.glass.depthWrite=false
  for(const [name,opacity] of [['shaftGlass',.16],['cabinGlass',.25]]) {
    Object.assign(mats[name],{transparent:true,opacity,depthWrite:false,side:THREE.DoubleSide,roughness:.17})
    mats[name].userData.sortIndividual=true
  }
  Object.assign(mats.liftBrass,{metalness:.34,roughness:.31})
  Object.assign(mats.liftBronze,{metalness:.15,roughness:.43})
  mats.liftLight.emissive.setHex(0xffca89)
  mats.liftLight.emissiveIntensity=.7
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
  finishStudyLanding(THREE,floorSurfaces[1],mats)
  for(const ramp of VILLA_LAYOUT.ramps) {
    const flight=new THREE.Group()
    flight.name='Study connecting steps'
    flight.userData.staircase=true
    levels[ramp.level-1].add(flight)
    stairs(THREE,flight,ramp,mats)
  }
  const guard=new THREE.Group()
  guard.name='Upper landing guards'
  levels[1].add(guard)
  landingRails(THREE,guard,mats)
  const elevator=buildElevator(THREE,root,floorSurfaces[0],mats)

  const study=new THREE.Group()
  study.name='West window study'
  study.userData.room='study'
  levels[1].add(study)
  for(const item of VILLA_LAYOUT.furniture) {
    const inStudy=item.room==='study'
    furnish(THREE,inStudy?study:levels[item.level-1],item,inStudy?WEST_UPPER_Y:item.level===2?UPPER_Y:GROUND_Y,mats)
  }
  box(THREE,study,'Woven study rug',mats.textile,-8.76,WEST_UPPER_Y+.007,1.70,2.03,.014,1.37)
  for(const z of [1.052,2.348])box(THREE,study,'Study rug border',mats.trim,-8.76,WEST_UPPER_Y+.015,z,1.95,.005,.038)
  for(const x of [-9.708,-7.812])box(THREE,study,'Study rug border',mats.trim,x,WEST_UPPER_Y+.015,1.70,.041,.005,1.258)
  for(let story=0;story<2;story++) {
    for(let i=0;i<wallSpecs.length;i++) {
      const spec=wallSpecs[i], wing=i>=7&&i<=13
      const upperY=wing?WEST_UPPER_Y:UPPER_Y
      const bottom=story?upperY:GROUND_Y
      const top=story?6.37:upperY
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
  function setCutaway(level='both',cameraLocal={x:16,z:17}) {
    const showGround=level==='both'||level===1||level==='ground'
    const showUpper=level==='both'||level===2||level==='upper'
    levels[0].visible=showGround;levels[1].visible=showUpper
    floorSurfaces[0].visible=showGround
    floorSurfaces[1].visible=showUpper
    for(const story of [0,1]) for(const wall of levels[story].children) {
      if(wall.userData.facadeIndex===undefined)continue
      const across=(cameraLocal.x-wall.userData.x)*Math.sin(wall.userData.yaw)+
        (cameraLocal.z-wall.userData.z)*Math.cos(wall.userData.yaw)
      wall.visible=(story?showUpper:showGround)&&(level==='both'?across<-.09:across<.09)
    }
  }
  root.setCutaway=setCutaway
  setCutaway('both')
  return {root,group:root,setCutaway,elevator}
}

export { createVillaInterior, VILLA_LAYOUT }
