const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {World2D,yardObstacles}=require('../../miniprogram/packagePlayground/utils/world2d')
const {createNavigation}=require('../../miniprogram/packagePlayground/utils/navigation')
const {PlayerCharacter}=require('../../miniprogram/packagePlayground/utils/player-character')
const lifePage=require('../../miniprogram/packagePlayground/utils/life-page')
const {fixture}=require('../fixtures/playgroundLife')
const {farmLayout,CROPS,SOILS}=require('../../miniprogram/packagePlayground/utils/farm-model')

function worldFixture(scene={}) {
  let emitted=[]
  const page={...lifePage,data:{farmSelectedBed:0,farmCropId:'carrot'},fetchRegion:async()=>({plots:[]}),
    setData(data){for(const [key,value] of Object.entries(data)) {
      const parts=key.split('.');let object=this.data
      for(const part of parts.slice(0,-1))object=object[part]||(object[part]={})
      object[parts.at(-1)]=value
    }},joystickEnd(){},clearPetSelection(){this.world.clearPetSelection()}}
  const w=new World2D(page,()=>{},{scene:{hasAvatar:true,playerId:'me',sceneId:'A',session:'session',serverTime:Date.now(),position:{x:400,z:400},...scene},world:{width:1120,height:1120},pets:[]},(pets)=>{emitted=pets})
  page.world=w;w.buildWorld();w.loadVisible=async()=>{}
  return {w,page,emitted:()=>emitted}
}
function syncFixture(world,scene,call,runtime={}) {
  let SceneSync
  const requests=[]
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/utils/scene-sync'),'utf8'),{
    module:{set exports(value){SceneSync=value.SceneSync}},setTimeout,clearTimeout,Date,...runtime,
    require:()=>({getCloudEnv:()=>'',callFunction:async(_,action,data)=>{requests.push({action,data});return call(action,data)}})
  })
  const sync=new SceneSync(world,scene);world.sceneSync=sync
  return {sync,requests}
}
const motion=(p)=>({epoch:Date.now(),approach:[p],patrol:[p]})

test('crop atlases slice four and five growth columns and reserve the final frame for maturity',()=>{
  const {w}=worldFixture(),draws=[],stamp=Date.now(),duration=100000000
  w.scale=2;w.zoom=1;w.serverOffset=0
  w.ctx={drawImage:(...args)=>draws.push(args)};w.markerLabel=()=>{}
  const images=new Map()
  w.farmImage=(atlas)=>{
    if(!atlas)return null
    if(!images.has(atlas.fileID))images.set(atlas.fileID,{id:atlas.fileID})
    return images.get(atlas.fileID)
  }
  for(const id of ['carrot','corn']) {
    const crop=CROPS.find((c)=>c.id===id)
    for(const progress of [0,14,15,19,20,44,45,64,65,74,75,99.9,100]) {
      draws.length=0
      const plantedAt=stamp-progress/100*duration
      w.drawFarm({x:400,z:400,size:112,farmBeds:[{id:0,cropId:id,plantedAt,readyAt:plantedAt+duration,watered:true}]})
      const draw=draws.find((args)=>args[0].id===crop.atlas.fileID)
      const frame=crop.stages.filter((threshold)=>threshold<=progress).length-1
      assert.deepEqual(draw.slice(1,5),[frame*256,0,256,256],`${id}: ${progress}%`)
      const soil=draws.find((args)=>args[0].id===SOILS.watered)
      assert.equal(draw[5],soil[1]);assert.equal(draw[6],soil[2])
      assert.equal(draw[7],soil[3]);assert.equal(draw[8],soil[4])
    }
  }
})

test('newer crop definitions survive a late farm response while the planted display and clock still update',()=>{
  const {w,page}=worldFixture(),crop={...CROPS[0],id:'tomato',name:'番茄',enabled:false}
  const catalog={revision:3,crops:[crop],soils:SOILS}
  w.setFarmCatalog(catalog)
  page.data.farmCropId='tomato'
  page.applyFarm({catalog:{revision:2,crops:[{...crop,name:'旧名字',enabled:true}]},memberLevel:'gold',
    crops:[],serverTime:Date.now(),beds:[{id:0,cropId:'tomato',plantedAt:Date.now()-120000,readyAt:Date.now()-1000}]})
  assert.equal(w.farmCatalog.revision,3)
  assert.equal(page.data.farm.catalog.revision,3)
  assert.equal(page.data.farm.crops[0].name,'番茄')
  assert.equal(page.data.farmSeedAvailable,false)
  assert.equal(page.data.farmBed.name,'番茄');assert.equal(page.data.farmBed.state,'ready')
})

test('catalog polling is throttled during scene fallback and a stopped session rejects a late catalog',async()=>{
  const {w,page}=worldFixture(),timers=[],catalogs=[]
  let stamp=100000,snapshots=0,release
  w.setFarmCatalog=(catalog)=>catalogs.push(catalog)
  w.sceneState=()=>({trail:[]})
  page.ensureFarm=async()=>{}
  const {sync,requests}=syncFixture(w,w.scene,(action)=>{
    if(action==='getFarmCatalog')return new Promise((resolve)=>{release=resolve})
    return {}
  },{Date:{now:()=>stamp},setTimeout:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer},clearTimeout(){}})
  sync.watch=()=>{};sync.send=async()=>{};sync.snapshot=async()=>{snapshots++}
  const settle=()=>new Promise((resolve)=>setImmediate(resolve))
  const refresh=async()=>{const i=timers.findIndex((timer)=>timer.delay===1000);assert.ok(i>=0);await timers.splice(i,1)[0].fn()}
  sync.start();release({revision:1,crops:[]});await settle()
  stamp+=1000;await refresh();stamp+=1000;await refresh()
  assert.equal(requests.filter((r)=>r.action==='getFarmCatalog').length,1)
  assert.equal(snapshots,3)
  stamp+=30000
  const refreshing=refresh();await settle()
  await sync.stop();release({revision:2,crops:[]});await refreshing
  assert.equal(requests.filter((r)=>r.action==='getFarmCatalog').length,2)
  assert.equal(catalogs.length,1);assert.equal(catalogs[0].revision,1)
})

test('selected pet shows live needs and low alerts, hides ridden sprites, and ignores neighbors low needs',()=>{
  const f=worldFixture(),at=Date.now()
  f.w.applySharedPet({id:'pet',name:'团团',species:'cat',modelScale:1,motion:motion({x:401,z:401}),needs:{at,energy:10,satiety:15,hydration:80},following:true},true,'我','me')
  f.w.applySharedPet({id:'other',name:'邻居宠物',species:'dog',modelScale:1,motion:motion({x:402,z:402}),needs:{at,energy:0,satiety:0,hydration:0}},false,'邻居','other')
  assert.equal(f.w.selectPet('pet'),true)
  f.w.updateLifeUi()
  const selected=f.emitted().find((p)=>p.id==='pet')
  assert.equal(selected.needs.length,5);assert.ok(selected.fatigue>=90);assert.equal(selected.following,true)
  assert.equal(f.page.data.petAlerts.length,2);assert.ok(f.page.data.petAlerts.every((a)=>a.id==='pet'))
  f.w.applySharedPet({...f.w.pets[0].authoritativePet,ridingVehicleId:'car'},true)
  f.w.drawPet(f.w.pets[0])
  const point=f.w.project(401,401)
  assert.equal(f.w.petAt(point).id,'other')
  assert.equal(f.w.selectPet('pet'),true)
  assert.match(f.w.petActivity(f.w.pets[0]),/乘车/)
})

test('resident follow pushes update pets incrementally and preserve predicted character movement',async()=>{
  const {w}=worldFixture(),scene=w.scene
  const {sync}=syncFixture(w,scene,async()=>({accepted:true}))
  let rebuild=0
  w.applySceneRecords=async()=>{rebuild++}
  const before={...w.character.position}
  sync.merge({kind:'resident',id:'resident',ownerId:'me',pets:[{id:'p',name:'猫',modelScale:1,species:'cat',motion:motion({x:405,z:400}),following:true}],version:{epoch:1,seq:1}})
  await sync.apply(false)
  assert.equal(rebuild,0);assert.equal(w.pets.length,1);assert.equal(w.pets[0].following,true)
  assert.deepEqual(w.character.position,before)
  sync.merge({kind:'resident',id:'resident',ownerId:'me',deleted:true,version:{epoch:2,seq:0}})
  await sync.apply(false);assert.equal(w.pets.length,0)
})

test('late follow packets preserve the rendered position and walk around a fence through the gate',()=>{
  const {w}=worldFixture(),plot={id:'own',x:280,z:280,size:112,mine:true}
  w.sharedPlots=new Map([[plot.id,plot]])
  const nav=createNavigation(w.bounds,yardObstacles(plot),.8,1.5)
  const first={id:'p',name:'pet',species:'cat',modelScale:1,following:true,motion:motion({x:280,z:320})}
  w.applySharedPet(first,true)
  const pet=w.pets[0],before={...pet.position},goal={x:350,z:340}
  w.applySharedPet({...first,motion:motion(goal)},true)
  assert.deepEqual(pet.position,before)
  let distance=0
  for(let i=0;i<500;i++) {
    const previous={...pet.position},state=w.sharedPetSample(pet,.05)
    const step=Math.hypot(state.position.x-previous.x,state.position.z-previous.z)
    assert.ok(step<=18*.05+1e-8)
    assert.equal(nav.clearSegment(previous,state.position),true)
    const walked=state.distance+(pet.motionDistanceOffset||0)
    assert.ok(walked>=distance-1e-8)
    distance=walked
    Object.assign(pet,{position:state.position,walkDistance:walked,moving:state.moving,walkFacingLeft:state.facingLeft})
    if(i===50){const saved={...pet.position};w.applySharedPet({...first,motion:motion(goal)},true);assert.deepEqual(pet.position,saved)}
  }
  assert.ok(Math.hypot(pet.position.x-goal.x,pet.position.z-goal.z)<.1)
})

test('map soil routes beside the chosen bed; proximity actions disappear on departure and reject a stale button',async()=>{
  const {w,page}=worldFixture(),plot={id:'own',x:400,z:400,size:112,mine:true},calls=[]
  w.ownPlot=plot;w.sharedPlots=new Map([[plot.id,plot]]);page.data.farmEditMode=true
  w.characterTerrain={};w.characterAreaLoaded=()=>true
  w.sceneSync={getFarm:async()=>({plotId:'own',serverTime:Date.now(),beds:farmLayout(plot).map((b)=>({...b,state:'grass',unlocked:true})),crops:[]}),farmAction:async(p)=>calls.push(p)}
  let target
  w.moveCharacterTo=async(p)=>{target=p;return true}
  await w.moveToFarmBed(2)
  const tile=farmLayout(plot)[2]
  assert.ok(Math.hypot(target.x-tile.x,target.z-tile.z)>0)
  assert.ok(Math.hypot(target.x-tile.x,target.z-tile.z)<tile.size*.8)
  w.character.position=target;w.emitNearby()
  await page.ensureFarm(true)
  w.emitFarmUi();assert.equal(page.data.nearbyFarm.id,2);assert.equal(page.data.farmOpen,undefined)
  w.character.position={x:465,z:465};w.emitNearby()
  assert.equal(page.data.nearbyFarm,null)
  const previousWx=global.wx;global.wx={showToast(){}}
  try {await page.farmOperation({currentTarget:{dataset:{operation:'till',bed:2}}});assert.equal(calls.length,0)}finally{global.wx=previousWx}
})

test('field actions are unavailable from the farm overview even while standing beside the bed',async()=>{
  const {w,page}=worldFixture(),calls=[]
  w.nearbyFarmTile=()=>({id:0})
  w.sceneSync={farmAction:async(p)=>calls.push(p)};page.data.farmOpen=true
  const previousWx=global.wx;global.wx={showToast(){}}
  try {await page.farmOperation({currentTarget:{dataset:{operation:'till',bed:0}}});assert.equal(calls.length,0)}finally{global.wx=previousWx}
})

test('passenger stays attached to the realtime car, cannot move or route independently, and exit restores input',async()=>{
  const {w,page}=worldFixture(),actor={kind:'presence',id:'me',mine:true,ownerId:'me',vehicleId:'car',vehicleRole:'passenger',position:{x:400,z:400}}
  const car={kind:'vehicle',id:'car',ownerId:'driver',mine:false,state:'driving',position:{x:410,z:400},passengers:[{id:'me',name:'我'}],online:true,moving:false,lastSeen:Date.now(),speedMultiplier:2}
  await w.applySceneChanges([actor,car])
  assert.equal(page.data.riding,true);assert.equal(w.character.vehicleSpeed,0)
  w.setCharacterInput(1,0);w.updateCharacter(.1)
  assert.equal(w.character.input.x,0);assert.deepEqual(w.character.position,{x:410,z:400})
  assert.equal(await w.moveCharacterTo({x:500,z:500}),false)
  await w.applySceneChanges([{...actor,vehicleId:'',vehicleRole:'',position:{x:413.5,z:400}}])
  assert.equal(page.data.riding,false);assert.equal(w.drivingVehicleId,'')
  w.setCharacterInput(1,0);assert.equal(w.character.input.x,1)
})

test('actual movement chooses four car directions and retains the last facing while stopped',()=>{
  const navigation={clearSegment:()=>true},known=()=>true
  for(const [x,y,expected] of [[-1,.52,'sw'],[1,.52,'se'],[-1,-.52,'nw'],[1,-.52,'ne']]) {
    const p=new PlayerCharacter({x:500,z:500});p.vehicleSpeed=28
    p.setInput(x,y);p.update(.1,navigation,known)
    assert.equal(p.facing,expected)
    p.setInput(0,0);p.update(.1,navigation,known);assert.equal(p.facing,expected)
  }
})

test('rear directions render a distinct back view and horizontal mirroring, never a vertical flip',()=>{
  const {w}=worldFixture(),draws=[]
  w.camera={x:400,z:400}
  w.ctx={save(){},restore(){},translate(){},scale:(x,y)=>draws.push(['scale',x,y]),drawImage:()=>draws.push(['front'])}
  w.vehicleImage={width:1024,height:1536};w.drawRearVehicle=()=>draws.push(['rear']);w.markerLabel=()=>{}
  for(const facing of ['nw','ne'])w.drawVehicle({id:facing,state:'outside',position:{x:400,z:400},facing,online:false},false)
  assert.equal(draws.filter((d)=>d[0]==='rear').length,2)
  assert.deepEqual(draws.filter((d)=>d[0]==='scale'),[['scale',-1,1]])
  assert.equal(draws.some((d)=>d[0]==='front'),false)
})

test('near horizontal driving keeps its rear view through joystick jitter and changes on a clear downward turn',()=>{
  const navigation={clearSegment:()=>true},known=()=>true
  const p=new PlayerCharacter({x:512,z:512});p.vehicleSpeed=28
  p.setInput(-1,-.52);p.update(.1,navigation,known)
  assert.equal(p.facing,'nw')
  for(let i=0;i<40;i++) {
    p.setInput(-1,i%2?.025:-.025);p.update(.1,navigation,known)
    assert.equal(p.facing,'nw')
  }
  p.setInput(1,-.025);p.update(.1,navigation,known);assert.equal(p.facing,'ne')
  p.setInput(1,.52);p.update(.1,navigation,known);assert.equal(p.facing,'se')
})

test('farm drawer recomputes maturity from the server clock and retains idempotent requests after a lost reply',async()=>{
  const {w,page}=worldFixture(),packets=[]
  w.ownPlot={id:'own',x:400,z:400,size:112,mine:true}
  w.character.position={...farmLayout(w.ownPlot)[0]};w.characterTerrain={};w.characterAreaLoaded=()=>true
  w.ownPlot.gardenVersion=2;w.ownPlot.farmBeds=[{id:0,stage:'watered'}]
  const farm={plotId:'own',serverTime:Date.now()-120000,beds:[{id:0,cropId:'carrot',plantedAt:Date.now()-180000,readyAt:Date.now()-130000,state:'growing',unlocked:true}]}
  page.applyFarm(farm)
  assert.equal(page.data.farmBed.state,'ready');assert.equal(page.data.farmBed.label,'成熟展示')
  let calls=0
  w.sceneSync={farmAction:async(p)=>{packets.push({...p});if(++calls===1)throw new Error('网络超时');return {...farm,serverTime:Date.now(),message:'已收获'}}}
  const oldWx=global.wx;global.wx={showToast(){}}
  try {
    const event={currentTarget:{dataset:{operation:'harvest',bed:0,plot:'own'}}}
    await page.farmOperation(event);await page.farmOperation(event)
    assert.equal(packets[0].requestId,packets[1].requestId)
    assert.equal(page.data.farmBusy,false);assert.equal(page.pendingFarm,null)
  }finally{global.wx=oldWx}
})

test('lost pet action reply retries the same sequence, a new scene continues above saved pet command sequences',async()=>{
  const {w}=worldFixture()
  w.pets=[{mine:true,acceptedCommand:12}]
  let calls=0
  const {sync,requests}=syncFixture(w,w.scene,async(action,data)=>{
    if(action==='petAction') {if(++calls===1)throw new Error('网络超时');return {pet:{id:'p',name:'猫',species:'cat',modelScale:1,motion:motion({x:400,z:400}),commandSeq:data.commandSeq,following:true}}}
    return {accepted:true,ackSeq:data.seq}
  })
  await assert.rejects(()=>sync.petAction('p','follow'),/网络超时/)
  await sync.petAction('p','follow')
  const actions=requests.filter((r)=>r.action==='petAction')
  assert.equal(actions[0].data.commandSeq,13);assert.equal(actions[1].data.commandSeq,13)
})

test('ride replies and server pushes update all occupants and their pets before further movement is sent',async()=>{
  const f=fixture(),a=await f.drive(),b=await f.build('b',{x:504,z:280})
  f.place('b',{x:283.5,z:338});f.placePet('b',{x:284,z:338});await f.petAction('b',b,'follow')
  const client=worldFixture(b),w=client.w
  w.character.position={...f.actor('b').position};w.serverOffset=f.now()-Date.now()
  const {sync}=syncFixture(w,b,async(action,data)=>{
    if(action==='syncScene')return f.shared.sync('b',data)
    if(action==='rideRequest')return f.shared.rides.request('b',data)
    if(action==='rideLeave')return f.shared.rides.leave('b',data)
    if(action==='getScene')return f.shared.snapshot('b',data)
    throw new Error(action)
  })
  await sync.snapshot()
  await sync.rideAction('rideRequest',{operation:'request',playerId:a.playerId})
  const request=(await f.shared.social.state('a')).incoming.find((r)=>r.type==='rideRequest')
  const accepted=await f.shared.rides.respond('a',{...f.auth(a),requestId:request.id,accept:true})
  for(const r of accepted.records)sync.merge(r)
  await sync.apply(false)
  assert.equal(w.vehicleRole,'passenger');assert.equal(w.pets.find((p)=>p.id==='pet_b').ridingVehicleId,f.car('a')._id)
  await sync.rideAction('rideLeave')
  assert.equal(w.vehicleRole,'');assert.equal(w.pets.find((p)=>p.id==='pet_b').ridingVehicleId,'')
})


test('normal map clicks do not claim empty grass; edit mode targets own additional land only',()=>{
  const {w,page}=worldFixture(),yard={id:'yard',x:400,z:400,size:48,mine:true,buildingType:'yard',gardenVersion:2},neighbor={...yard,id:'neighbor',x:520,mine:false}
  w.ownPlot=null;w.sharedPlots=new Map([[yard.id,yard],[neighbor.id,neighbor]])
  const tile=farmLayout(yard)[0],point=w.project(tile.x,tile.z)
  assert.equal(w.farmAt(point),null)
  w.characterSelected=true;assert.equal(w.farmAt(point),null)
  page.data.farmEditMode=true
  assert.equal(w.farmAt(point).plotId,'yard')
  const other=farmLayout(neighbor)[0]
  assert.equal(w.farmAt(w.project(other.x,other.z)),null)
  assert.equal(createNavigation(w.bounds,yardObstacles(yard),.8,1.5).walkable({x:400,z:400}),true)
})

test('mature crops have no harvest badge, and deleted definitions render the saved atlas',()=>{
  const {w}=worldFixture(),labels=[],draws=[],crop=CROPS[0]
  w.scale=2;w.zoom=1;w.serverOffset=0
  w.ctx={drawImage:(...args)=>draws.push(args)};w.markerLabel=(text)=>labels.push(text)
  w.farmCatalog={crops:[],soils:SOILS};w.farmImage=(atlas)=>atlas?{id:atlas.fileID}:null
  const plot={id:'p',x:400,z:400,size:48,buildingType:'yard',gardenVersion:2},tile=farmLayout(plot)[0]
  w.drawFarm({...plot,farmBeds:[{id:tile.id,stage:'tilled',cropId:crop.id,crop,plantedAt:1,readyAt:2}]})
  assert.ok(draws.some((args)=>args[0].id===crop.atlas.fileID))
  assert.equal(labels.length,0)
})
