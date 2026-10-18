const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {World2D}=require('../../miniprogram/packagePlayground/utils/world2d')
const {VEHICLE_ATLAS,VEHICLE_REAR_ATLAS}=require('../../miniprogram/packagePlayground/utils/vehicle-assets')
const {AssetLoader2D,prepare}=require('../../miniprogram/packagePlayground/utils/asset-loader-2d')
function fixture(options={}) {
  const page={data:{},setData(v){Object.assign(this.data,v)},fetchRegion:async()=>({plots:[]})}
  const scene={hasAvatar:true,playerId:'me',sceneId:'A',session:'session',serverTime:Date.now(),position:{x:400,z:400}}
  const w=new World2D(page,null,{scene,world:{width:1120,height:1120},pets:[]})
  w.buildWorld();w.loadVisible=async()=>{}
  const requests=[]
  let SceneSync
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/utils/scene-sync'),'utf8'),{
    module:{set exports(value){SceneSync=value.SceneSync}},setTimeout,clearTimeout,Date,
    require:()=>({getCloudEnv:()=>'',callFunction:async(_,action,data)=>{
      requests.push({action,data})
      return options.call?options.call(action,data):{serverTime:Date.now(),accepted:true,records:[],nextCursor:''}
    }})
  })
  const sync=new SceneSync(w,scene);w.sceneSync=sync
  return {w,page,scene,sync,requests}
}
function car(extra={}) {return {id:'car',ownerId:'me',mine:true,kind:'vehicle',state:'driving',name:'凯大大',speedMultiplier:2,position:{x:400,z:400},lastSeen:Date.now(),online:true,moving:true,version:{epoch:1,seq:1},...extra}}
function actor(extra={}) {return {id:'me',ownerId:'me',mine:true,kind:'presence',vehicleId:'car',position:{x:400,z:400},version:{epoch:2,seq:1},...extra}}
test('driving switches the existing controller, hides character sprites and keeps zoom and predicted motion',async()=>{
  const {w,page}=fixture();w.zoom=.7;w.manualZoom=true
  await w.applySceneChanges([actor(),car()])
  assert.equal(page.data.driving,true);assert.equal(w.character.vehicleSpeed,28)
  w.character.position={x:405,z:405}
  await w.applySceneChanges([actor({position:{x:401,z:401}}),car({position:{x:401,z:401}})])
  assert.deepEqual(w.character.position,{x:405,z:405});assert.equal(w.zoom,.7)
  // Hidden bodies return before touching the drawing context.
  w.drawCharacter(false);w.drawNeighbor({...actor(),mine:false},false)
  await w.applySceneChanges([actor({vehicleId:'',position:{x:408.5,z:405}})])
  assert.equal(page.data.driving,false);assert.equal(w.character.vehicleSpeed,0)
  assert.deepEqual(w.character.position,{x:408.5,z:405})
})
test('vehicle watch updates stay incremental and do not rebuild pets or yards',async()=>{
  const f=fixture();let rebuilt=0
  f.w.applySceneRecords=async()=>{rebuilt++}
  for(let seq=1;seq<=4;seq++) {
    f.sync.merge(car({ownerId:'other',mine:false,position:{x:400+seq,z:400},version:{epoch:1,seq}}))
    await f.sync.apply(false)
  }
  assert.equal(rebuilt,0);assert.equal(f.w.vehicles.get('car').position.x,404)
  f.sync.merge(car({ownerId:'other',deleted:true,version:{epoch:2,seq:0}}));await f.sync.apply(false)
  assert.equal(f.w.vehicles.size,0)
})
test('only own car selects; repeated map commands, panning and pinching use the established selection rules',async()=>{
  const {w}=fixture();w.applyOwnVehicleActor(actor());w.applyVehicle(car());await w.prepareCharacterArea()
  assert.equal(w.selectVehicle(car({mine:false})),false);assert.equal(w.selectedVehicleId,undefined)
  assert.equal(w.selectVehicle(w.ownVehicle()),true)
  let moves=0;w.moveCharacterTo=()=>{moves++}
  const point=w.project(430,430)
  for(let i=0;i<2;i++){w.touchStart([point]);w.touchEnd([point])}
  assert.equal(moves,2);assert.equal(w.selectedVehicleId,'car')
  w.touchStart([{x:20,y:20}]);w.touchMove([{x:60,y:20}]);w.touchEnd([{x:60,y:20}])
  assert.equal(w.selectedVehicleId,'car');assert.equal(moves,2)
  w.touchStart([{x:20,y:20},{x:120,y:20}]);assert.equal(w.selectedVehicleId,'')
})
test('full-strength driving reaches saved 5x speed, cannot cross fences and click routes arrive without overshoot',async()=>{
  const {w}=fixture();w.applyOwnVehicleActor(actor());w.applyVehicle(car({speedMultiplier:5}))
  await w.prepareCharacterArea()
  const norm=Math.hypot(1,.52)
  w.setCharacterInput(-1/norm,.52/norm);w.updateCharacter(.1)
  assert.ok(Math.abs(w.character.position.z-407)<1e-8)
  w.sharedPlots.set('block',{id:'block',x:400,z:470,size:112})
  for(let i=0;i<30;i++)w.updateCharacter(.1)
  assert.ok(w.character.position.z<412.6)
  w.sharedPlots.clear();w.setCharacterInput(0,0)
  const target={x:w.character.position.x+8,z:w.character.position.z+8}
  await w.moveCharacterTo(target)
  for(let i=0;i<30;i++)w.updateCharacter(.1)
  assert.ok(Math.hypot(w.character.position.x-target.x,w.character.position.z-target.z)<.15)
  assert.equal(w.character.moving,false)
})
test('cars cannot enter even an accessible own yard; foot navigation still allows its gate',async()=>{
  const {w}=fixture(),plot={id:'yard',mine:true,x:400,z:400,size:112}
  w.ownPlot=plot;w.sharedPlots.set(plot.id,plot);w.character.position={x:400,z:461}
  assert.equal(w.characterNavigation().clearSegment(w.character.position,{x:400,z:450}),true)
  w.drivingVehicleId='car'
  assert.equal(w.characterNavigation().clearSegment(w.character.position,{x:400,z:450}),false)
})
test('a fast frame preserves the actual turn around a yard corner instead of sending a forbidden shortcut',async()=>{
  const {w}=fixture()
  w.applyOwnVehicleActor(actor());w.applyVehicle(car({speedMultiplier:5}))
  await w.prepareCharacterArea()
  w.sharedPlots.set('block',{id:'block',x:470,z:470,size:112})
  w.character.position={x:526,z:412.5}
  w.characterTerrain=null
  await w.prepareCharacterArea()
  const start={...w.character.position},nav=w.characterNavigation()
  w.setCharacterInput(0,1);w.updateCharacter(.1)
  assert.equal(nav.clearSegment(start,w.character.position),false)
  assert.ok(w.sceneTrail.length>1&&w.sceneTrail.length<5)
  let previous=start
  for(const point of w.sceneTrail){assert.ok(nav.clearSegment(previous,point));previous=point}
  assert.deepEqual(previous,w.character.position)
})
test('24-frame atlas preserves alpha, crops the final row, mirrors, loops and stops on frame zero',async()=>{
  const atlas={width:1024,height:1536}
  assert.equal(prepare(atlas,VEHICLE_ATLAS.fileID),atlas)
  const loader=new AssetLoader2D({});loader.loadImage=async()=>atlas
  assert.equal(await loader.loadAtlas(VEHICLE_ATLAS),atlas)
  loader.loadImage=async()=>({width:1024,height:1024})
  await assert.rejects(()=>loader.loadAtlas(VEHICLE_ATLAS),/尺寸不匹配/)
  const {w}=fixture(),calls=[],scales=[],labels=[]
  w.vehicleImage=atlas;w.ctx=new Proxy({}, {get:(_,key)=>key==='drawImage'?(...args)=>calls.push(args):key==='scale'?(...args)=>scales.push(args):()=>{}})
  w.markerLabel=(text)=>labels.push(text)
  w.width=1000;w.height=1000;w.project=()=>({x:100,y:100})
  w.applyOwnVehicleActor(actor());w.character.moving=true;w.character.mirrored=true
  w.character.animationPhase=23.5/24
  w.drawVehicle(car(),false)
  assert.deepEqual(calls.at(-1).slice(1,5),[768,1280,256,256]);assert.deepEqual(scales.at(-1),[-1,1]);assert.equal(labels.at(-1),'凯大大')
  w.character.animationPhase=0;w.drawVehicle(car(),false)
  assert.deepEqual(calls.at(-1).slice(1,3),[0,0])
  w.character.animationPhase=.5;w.character.moving=false;w.drawVehicle(car(),false)
  assert.deepEqual(calls.at(-1).slice(1,3),[0,0])
  w.drawVehicle(car({id:'other',mine:false,state:'outside',online:false}),false);assert.equal(labels.at(-1),'凯大大的车')
  w.drawVehicle(car({id:'other',mine:false,state:'driving',online:false}),false);assert.equal(labels.at(-1),'凯大大 · 离线')
})
test('uploaded rear atlas keeps alpha, crops frame 24 and mirrors NW to NE once for driver and neighbors',async()=>{
  const rear={width:1024,height:1536,rear:true},front={width:1024,height:1536}
  assert.equal(VEHICLE_REAR_ATLAS.frames,24)
  assert.equal(VEHICLE_REAR_ATLAS.anchor,VEHICLE_ATLAS.anchor)
  assert.ok(VEHICLE_REAR_ATLAS.fileID.endsWith('/car/drive-nw-v2.png'))
  assert.equal(prepare(rear,VEHICLE_REAR_ATLAS.fileID),rear)
  const loader=new AssetLoader2D({});loader.loadImage=async()=>rear
  assert.equal(await loader.loadAtlas(VEHICLE_REAR_ATLAS),rear)
  const {w}=fixture(),calls=[],scales=[]
  w.loadVehicleAtlas=()=>{};w.vehicleRearImage=rear;w.vehicleImage=front
  w.ctx=new Proxy({}, {get:(_,key)=>key==='drawImage'?(...args)=>calls.push(args):key==='scale'?(...args)=>scales.push(args):()=>{}})
  w.markerLabel=()=>{};w.width=1000;w.height=1000;w.project=()=>({x:100,y:100})
  w.applyOwnVehicleActor(actor({facing:'nw'}));w.character.moving=true;w.character.animationPhase=23.5/24
  for(const facing of ['nw','ne']) {
    scales.length=0;w.character.facing=facing;w.character.mirrored=facing==='nw'
    w.drawVehicle(car(),false)
    assert.equal(calls.at(-1)[0],rear)
    assert.deepEqual(calls.at(-1).slice(1,5),[768,1280,256,256])
    assert.deepEqual(scales,facing==='ne'?[[-1,1]]:[])
    scales.length=0
    w.drawVehicle(car({id:'other',mine:false,facing,state:'outside',online:false,mirrored:facing==='nw'}),false)
    assert.equal(calls.at(-1)[0],rear)
    assert.deepEqual(calls.at(-1).slice(1,5),[0,0,256,256])
    assert.deepEqual(scales,facing==='ne'?[[-1,1]]:[])
  }
  w.character.moving=false;w.drawVehicle(car(),false)
  assert.deepEqual(calls.at(-1).slice(1,5),[0,0,256,256])
  let fallback=0;w.vehicleRearImage=null;w.drawRearVehicle=()=>fallback++
  w.drawVehicle(car(),false);assert.equal(fallback,1)
})

test('vehicle actions flush movement before mutation and publish state before the next movement packet',async()=>{
  let release
  const gate=new Promise((resolve)=>{release=resolve})
  const f=fixture({call:async(action)=>{
    if(action==='vehicleAction') {await gate;return {actor:actor(),vehicle:car(),serverTime:Date.now()}}
    return {accepted:true,serverTime:Date.now(),records:[],nextCursor:''}
  }})
  const operation=f.sync.vehicleAction('enter','car')
  await new Promise((resolve)=>setImmediate(resolve))
  assert.deepEqual(f.requests.map((r)=>r.action),['syncScene','vehicleAction'])
  assert.equal(f.w.vehicleBusy,true)
  f.w.setCharacterInput(1,0);assert.equal(f.w.character.input.x,0)
  const sync=f.sync.send(true);release();await operation;await sync
  assert.equal(f.requests.at(-1).data.vehicleId,'car');assert.equal(f.w.vehicleBusy,false)
})
test('a lost vehicle action reply reconciles authoritative state before re-enabling driving',async()=>{
  const f=fixture({call:async(action)=>{
    if(action==='vehicleAction')throw new Error('网络断开')
    if(action==='getScene')return {records:[actor(),car()],nextCursor:'',serverTime:Date.now()}
    return {accepted:true,serverTime:Date.now()}
  }})
  await assert.rejects(()=>f.sync.vehicleAction('enter','car'),/网络断开/)
  assert.equal(f.w.drivingVehicleId,'car');assert.equal(f.w.vehicleBusy,false)
  assert.deepEqual(f.w.character.position,{x:400,z:400})
})
test('lowering speed flushes previous driving at the previous limit before saving the new limit',async()=>{
  const f=fixture({call:async(action)=>action==='setVehicleSpeed'?{speedMultiplier:2,vehicle:car({speedMultiplier:2,version:{epoch:3,seq:0}})}:{accepted:true,serverTime:Date.now()}})
  f.w.applyOwnVehicleActor(actor());f.w.applyVehicle(car({speedMultiplier:5}))
  await f.sync.setVehicleSpeed(2)
  assert.deepEqual(f.requests.map((r)=>r.action),['syncScene','setVehicleSpeed'])
  assert.equal(f.w.character.vehicleSpeed,28);assert.equal(f.w.vehicleBusy,false)
  assert.equal(f.sync.records.get('car').version.epoch,3)
})
