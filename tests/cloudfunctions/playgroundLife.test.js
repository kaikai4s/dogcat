const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const {fixture}=require('../fixtures/playgroundLife')
const world=require('../../cloudfunctions/api/services/playground-world')
const createShared=require('../../cloudfunctions/api/services/playground-shared')
const {sampleMotion}=require('../../cloudfunctions/api/services/playground-shared/shared-motion')
const {sampleNeeds,settleNeeds}=require('../../cloudfunctions/api/services/playground-shared/pet-needs')
const {yardLayout}=require('../../cloudfunctions/api/services/playground-shared/yard-layout')
const {farmLayout,bedReach}=require('../../cloudfunctions/api/services/playground-shared/farm-model')

test('needs decay offline, recovery starts on arrival, and settling does not apply recovery twice',()=>{
  const stamp=1800000000000,pet={needs:{at:stamp,energy:70,satiety:70,hydration:70}}
  assert.deepEqual(sampleNeeds(pet,stamp+3600000),{at:stamp+3600000,energy:62,satiety:58,hydration:52,pee:22.22,poop:11.11})
  pet.care={type:'sleep',startsAt:stamp+60000,endsAt:stamp+960000}
  assert.ok(sampleNeeds(pet,stamp+30000).energy<70)
  const value=sampleNeeds(pet,stamp+120000)
  assert.ok(value.energy>79);assert.ok(value.hydration<70)
  settleNeeds(pet,stamp+120000)
  assert.deepEqual(sampleNeeds(pet,stamp+120000),value)
  assert.equal(sampleNeeds(pet,stamp+365*86400000).energy,0)
  assert.equal(sampleNeeds(pet,stamp+365*86400000).hydration,0)
  assert.equal(sampleNeeds(pet,stamp+365*86400000).pee,100)
  assert.equal(sampleNeeds(pet,stamp+365*86400000).poop,100)
})

test('full recovery cannot bank excess needs and offline sampling matches periodic settlement',()=>{
  const stamp=1800000000000
  for(const [type,key,seconds,decay] of [['sleep','energy',900,8],['eat','satiety',300,12],['drink','hydration',420,18]]) {
    const pet={needs:{at:stamp,energy:90,satiety:90,hydration:90},care:{type,startsAt:stamp+60000,endsAt:stamp+60000+seconds*1000}}
    const copy=JSON.parse(JSON.stringify(pet)),end=pet.care.endsAt
    settleNeeds(copy,end)
    const later=sampleNeeds(pet,end+3600000),settled=sampleNeeds(copy,end+3600000)
    assert.equal(later[key],100-decay)
    for(const need of ['energy','satiety','hydration'])assert.ok(Math.abs(later[need]-settled[need])<1e-9)
  }
})

test('following crosses its own gate along valid paths and patrols near the owner without crossing walls',async()=>{
  const f=fixture(),a=await f.build(),p=f.pet('a')
  f.place('a',{x:280,z:340});f.placePet('a',{x:283,z:294})
  await f.petAction('a',a,'follow')
  const pet=f.pet('a'),plots=f.db.state.pet_playground_plots.filter((r)=>r.kind==='plot')
  const nav=createShared.navigation(await f.plots.config(),plots,pet.motion.approach[0],f.actor('a').position,'companion',null,[a.plot.id])
  for(let i=1;i<pet.motion.approach.length;i++)assert.equal(nav.clearSegment(pet.motion.approach[i-1],pet.motion.approach[i]),true)
  assert.ok(pet.motion.approach.some((p)=>p.z>335))
  for(const point of pet.motion.patrol)assert.ok(Math.hypot(point.x-280,point.z-340)<4)
  assert.equal(f.actor('a').hasFollowers,true)
  f.advance(2000)
  await f.sync('a',a,{position:{x:290,z:340},moving:true})
  assert.deepEqual(f.pet('a').followCenter,{x:290,z:340})
  const live=f.db.state.pet_playground_live.find((r)=>r.records&&r.records[f.resident('a')._id])
  assert.equal(live.records[f.resident('a')._id].pets[0].following,true)
  f.advance(30000);await f.petAction('a',a,'stay')
  assert.equal(f.pet('a').following,false)
})

test('following buffers departure once, stays continuous across updates and catches a stopped owner',async()=>{
  const f=fixture(),a=await f.build(),start={x:270,z:340}
  f.place('a',{x:280,z:340});f.placePet('a',start)
  await f.petAction('a',a,'follow')
  const departure=f.pet('a').motion.epoch
  assert.equal(departure-f.now(),700)
  assert.deepEqual(sampleMotion(f.pet('a').motion,f.now()+500).position,start)
  assert.equal(sampleMotion(f.pet('a').motion,f.now()+500).moving,false)
  f.advance(600)
  await f.sync('a',a,{position:{x:284,z:340},moving:true})
  assert.equal(f.pet('a').motion.epoch,departure)
  for(let i=1;i<=12;i++) {
    f.advance(600)
    const before=sampleMotion(f.pet('a').motion,f.now()).position
    await f.sync('a',a,{position:{x:284+i*4,z:340},moving:true})
    const after=sampleMotion(f.pet('a').motion,f.now()).position
    assert.ok(Math.hypot(after.x-before.x,after.z-before.z)<1e-8)
    assert.equal(f.pet('a').motion.epoch,f.now())
  }
  f.advance(30000)
  const settled=sampleMotion(f.pet('a').motion,f.now()).position,actor=f.actor('a').position
  assert.ok(Math.hypot(settled.x-actor.x,settled.z-actor.z)<4)
  await f.sync('a',a,{position:{x:actor.x+6,z:actor.z},moving:true})
  assert.equal(f.pet('a').motion.epoch-f.now(),700)
})

test('following pets board and disembark with the driver, reconnect preserves them, far pets delay boarding',async()=>{
  const f=fixture(),a=await f.build()
  await f.petAction('a',a,'follow')
  await f.drive('a',a)
  assert.equal(f.pet('a').ridingVehicleId,f.car('a')._id)
  f.advance(1000);await f.sync('a',a,{position:{x:280,z:360},moving:true})
  const returned=await f.enter('a')
  assert.equal(returned.vehicleId,f.car('a')._id)
  assert.equal(f.pet('a').ridingVehicleId,f.car('a')._id)
  await f.action('a',returned,'exit')
  assert.equal(f.pet('a').ridingVehicleId,'');assert.equal(f.pet('a').following,true)
  const position=sampleMotion(f.pet('a').motion,f.now()+1000).position
  assert.ok(Math.hypot(position.x-f.actor('a').position.x,position.z-f.actor('a').position.z)<5)
  f.placePet('a',{x:100,z:100})
  await assert.rejects(()=>f.action('a',returned,'enter'),/等跟随的宠物/)
  assert.equal(f.car('a').state,'outside');assert.equal(f.actor('a').vehicleId,'')
})

test('a following pet in an expired private yard returns to legal ground instead of remaining trapped',async()=>{
  const f=fixture(),a=await f.build()
  await f.build('b',{x:504,z:280})
  f.place('a',{x:440,z:340});f.placePet('a',{x:504,z:294})
  f.pet('a').following=true;f.actor('a').hasFollowers=true
  f.advance(1000)
  await f.sync('a',a,{position:{x:440,z:340}})
  const pet=f.pet('a'),plots=f.db.state.pet_playground_plots.filter((r)=>r.kind==='plot')
  const nav=createShared.navigation(await f.plots.config(),plots,pet.motion.approach[0],f.actor('a').position,'companion',null,[a.plot.id])
  assert.equal(nav.walkable(pet.motion.approach[0]),true)
  for(let i=1;i<pet.motion.approach.length;i++)assert.equal(nav.clearSegment(pet.motion.approach[i-1],pet.motion.approach[i]),true)
  assert.deepEqual(pet.followCenter,f.actor('a').position)
})

test('species bowls consume reserved food once; rest and fountain actions use actual reachable stations',async()=>{
  const f=fixture(),a=await f.build(),stamp=f.now()
  f.pet('a').needs={at:stamp,energy:20,satiety:10,hydration:15}
  await assert.rejects(()=>f.petAction('a',a,'eat'),/粮食不足/)
  await f.plots.fillBowl('a',{plotId:a.plot.id})
  const data={...f.auth(a),petId:'pet_a',operation:'eat',commandSeq:10}
  await f.shared.companions.action('a',data)
  assert.equal(f.row(world.ownerId('a')).foodBowls.dog,75)
  await f.shared.companions.action('a',data)
  assert.equal(f.row(world.ownerId('a')).foodBowls.dog,75)
  const care=f.pet('a').care
  assert.equal(sampleNeeds(f.pet('a'),care.startsAt-1).satiety<11,true)
  f.advance(360000)
  assert.ok(sampleNeeds(f.pet('a'),f.now()).satiety>70)
  const sleep=await f.petAction('a',a,'sleep',{commandSeq:11})
  assert.deepEqual(sleep.pet.motion.approach.at(-1),yardLayout(a.plot).stations.dog.sleep)
  const drink=await f.petAction('a',a,'drink',{commandSeq:12})
  assert.deepEqual(drink.pet.motion.approach.at(-1),yardLayout(a.plot).stations.dog.drink)
  f.advance(500000);assert.ok(sampleNeeds(f.pet('a'),f.now()).hydration>90)
  const b=await f.build('b',{x:504,z:280});await f.plots.fillBowl('b',{plotId:b.plot.id})
  await f.petAction('b',b,'eat')
  assert.equal(f.row(world.ownerId('b')).foodBowls.cat,75)
  assert.equal(f.row(world.ownerId('b')).foodBowls.dog,100)
})

test('feeding and pet commands enforce ownership, proximity, cooldowns and current scene sessions',async()=>{
  const f=fixture(),a=await f.build(),b=await f.build('b',{x:504,z:280})
  await assert.rejects(()=>f.petAction('b',b,'follow',{petId:'pet_a'}),/只能照料/)
  f.pet('a').needs={at:f.now(),energy:30,satiety:20,hydration:40}
  f.place('a',{x:100,z:100});await assert.rejects(()=>f.petAction('a',a,'feed'),/先走近/)
  f.place('a',sampleMotion(f.pet('a').motion,f.now()).position)
  await f.petAction('a',a,'feed');assert.equal(sampleNeeds(f.pet('a'),f.now()).satiety,45)
  await assert.rejects(()=>f.petAction('a',a,'feed'),/一分钟/)
  await f.enter('a');await assert.rejects(()=>f.petAction('a',a,'follow'),/场景已切换/)
})

test('decorative garden has four soil stages, no economic rewards, and replays safely',async()=>{
  const f=fixture(),a=await f.build(),tile=farmLayout(a.plot)[0],bedId=tile.id
  const before=JSON.parse(JSON.stringify(f.db.state.users))
  const initial=await f.shared.farm.state('a',f.auth(a))
  assert.ok(initial.beds.length>12);assert.ok(initial.beds.every((b)=>b.state==='grass'))
  assert.equal(initial.coins,undefined);assert.equal(initial.xp,undefined)
  await assert.rejects(()=>f.farmAction('a',a,'convert',{bedId}),/先走到/)
  f.place('a',tile)
  const packet={...f.auth(a),operation:'convert',bedId,requestId:'exact_request_001'}
  assert.equal((await f.shared.farm.action('a',packet)).beds.find((b)=>b.id===bedId).stage,'soil')
  await f.shared.farm.action('a',packet)
  await assert.rejects(()=>f.shared.farm.action('a',{...packet,bedId:bedId+1}),/标识已使用/)
  await f.farmAction('a',a,'till',{bedId})
  let state=await f.farmAction('a',a,'plant',{bedId,cropId:'carrot'})
  const readyAt=state.beds.find((b)=>b.id===bedId).readyAt
  state=await f.farmAction('a',a,'water',{bedId})
  assert.equal(state.beds.find((b)=>b.id===bedId).readyAt,readyAt)
  assert.equal(state.beds.find((b)=>b.id===bedId).stage,'watered')
  await assert.rejects(()=>f.farmAction('a',a,'harvest',{bedId}),/生长中/)
  f.advance(300000)
  const results=await Promise.allSettled([f.farmAction('a',a,'harvest',{bedId}),f.farmAction('a',a,'harvest',{bedId})])
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1)
  state=await f.farmAction('a',a,'lawn',{bedId})
  assert.equal(state.beds.find((b)=>b.id===bedId).state,'grass')
  assert.deepEqual(f.db.state.users,before);assert.equal((f.db.state.point_logs||[]).length,0)
  assert.equal(state.produce,undefined);assert.equal(state.seeds,undefined)
  const scene=await f.shared.snapshot('a',f.auth(a))
  assert.equal(scene.records.some((r)=>r.kind==='garden_receipts'),false)
})

test('gardens allow more than 12 tiles and additional own plots, reject foreign tiles, obstacles and obsolete operations',async()=>{
  const f=fixture(),a=await f.build(),b=await f.build('b',{x:504,z:280}),tiles=farmLayout(a.plot)
  for(const tile of tiles.slice(0,15)){
    f.place('a',tile);await f.farmAction('a',a,'convert',{bedId:tile.id})
  }
  assert.equal(f.row(a.plot.id).farmBeds.length,15)
  const yard=await f.plots.claim('a',f.user('a'),{x:280,z:504,size:48,isNewPlot:true})
  const tile=farmLayout(yard)[0];f.place('a',tile)
  await f.farmAction('a',a,'convert',{bedId:tile.id,plotId:yard.id})
  assert.equal(f.row(yard.id).farmBeds.length,1)
  f.place('b',tile)
  await assert.rejects(()=>f.farmAction('b',b,'convert',{bedId:tile.id,plotId:yard.id}),/只能在自己/)
  await assert.rejects(()=>f.farmAction('a',a,'convert',{bedId:-1,plotId:yard.id}),/草块/)
  for(const operation of ['buySeeds','sell','fertilize','plantAll','waterAll','harvestAll'])await assert.rejects(()=>f.farmAction('a',a,operation,{bedId:tile.id,plotId:yard.id}),/不支持/)
  f.place('a',tiles[0]);await assert.rejects(()=>f.farmAction('a',a,'till',{bedId:tiles[10].id}),/先走到/)
  await f.enter('a');await assert.rejects(()=>f.shared.farm.state('a',f.auth(a)),/场景已切换/)
})

test('client and server clock models and station coordinates remain identical',()=>{
  for(const name of ['pet-needs','farm-model','yard-layout','shared-motion'])assert.equal(
    fs.readFileSync(require.resolve('../../cloudfunctions/api/services/playground-shared/'+name),'utf8'),
    fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/utils/'+name),'utf8'))
})

test('old fixed beds migrate into decorative tiles without consuming legacy balances',async()=>{
  const f=fixture(),a=await f.build()
  const plot=f.row(a.plot.id)
  plot.farmBeds=[{id:0,cropId:'carrot',plantedAt:f.now()-300000,readyAt:f.now()}]
  f.db.state.users[0].playgroundCoins=31
  const state=await f.shared.farm.state('a',f.auth(a)),bed=state.beds.find((b)=>b.cropId)
  assert.ok(bed);assert.equal(bed.label,'成熟展示')
  f.place('a',bed);await f.farmAction('a',a,'harvest',{bedId:bed.id})
  assert.equal(f.row(a.plot.id).gardenVersion,2)
  assert.equal(f.db.state.users[0].playgroundCoins,31)
})

test('ground waste pickup removes one real event, never creates fertilizer or awards points',async()=>{
  const f=fixture(),a=await f.build(),p={x:280,z:338}
  const id='waste_'+world.hash('a')+'_'+world.hash('pet_a').slice(0,8)+'_'+f.now()
  f.pet('a').waste=[{id,type:'poop',...p,createdAt:f.now(),vehicleId:''}];f.place('a',p)
  const outcomes=await Promise.allSettled([f.farmAction('a',a,'pickupPoop',{poopId:id}),f.farmAction('a',a,'pickupPoop',{poopId:id})])
  assert.equal(outcomes.filter((r)=>r.status==='fulfilled').length,1)
  assert.equal(f.pet('a').waste.length,0);assert.equal((f.db.state.point_logs||[]).length,0)
  assert.equal(outcomes.find((r)=>r.status==='fulfilled').value.manure,undefined)
  await assert.rejects(()=>f.farmAction('a',a,'pickupPoop',{poopId:'fake'}),/已消失/)
})

test('care behavior expires after duration and automatically returns pet to free roaming motion', async () => {
  const f = fixture(), a = await f.build()
  const pet = f.pet('a')
  // Order pet to drink at fountain
  await f.petAction('a', a, 'drink')
  let petState = f.resident('a').pets[0]
  assert.equal(petState.care.type, 'drink')
  assert.equal(petState.motion.patrol.length, 1) // Pointing to fountain station

  // Advance time beyond care.endsAt (420s + buffer)
  f.advance(450000)

  // On next sync or snapshot, pet care must be cleared and free roaming motion restored
  await f.shared.snapshot('a', f.auth(a))
  petState = f.resident('a').pets[0]
  assert.equal(petState.care, null)
  assert.ok(petState.motion.patrol.length > 1) // Roaming patrol around yard
})

test('petRelief action decreases pee/poop values and persists to resident database', async () => {
  const f = fixture(), a = await f.build()
  const petId = f.resident('a').pets[0].id
  // Pet needs start with pee=0, poop=0 at stamp. Advance 4.5 hours -> pee=100, poop=50
  f.advance(4.5 * 3600000)

  // Trigger pee relief (-20)
  const peeRes = await f.shared.companions.relief('a', { ...f.auth(a), petId, type: 'pee', amount: 20 })
  assert.ok(peeRes && peeRes.pet)
  assert.equal(Math.round(peeRes.pet.needs.pee), 80)
  assert.equal(Math.round(f.resident('a').pets[0].needs.pee), 80)

  // Trigger poop relief (-40)
  f.advance(3001)
  const poopRes = await f.shared.companions.relief('a', { ...f.auth(a), petId, type: 'poop', amount: 40 })
  assert.ok(poopRes && poopRes.pet)
  assert.equal(Math.round(poopRes.pet.needs.poop), 10) // 50 - 40 = 10
  assert.equal(Math.round(f.resident('a').pets[0].needs.poop), 10)
})

test('buildings catalog management, grass tile calculation, and committee parameters', async () => {
  const createBuildings = require('../../cloudfunctions/api/services/playground-buildings')
  const f = fixture()
  const bService = createBuildings(f.context)

  // 1. List default buildings
  const listRes = await bService.list()
  assert.ok(listRes.buildings && listRes.buildings.length >= 4)
  const repairShop = listRes.buildings.find((b) => b.type === 'repair_shop')
  const committee = listRes.buildings.find((b) => b.type === 'committee')
  assert.ok(repairShop)
  assert.ok(committee)
  assert.equal(repairShop.name, '社区修理厂')
  assert.equal(committee.name, '社区居委会')
  assert.equal(committee.weeklySalary, 20)
  assert.equal(committee.resolveReward, 10)

  // 2. Save new custom building with tile calculation: 10.5m x 7m = 73.5m² = 6 grass tiles
  const customBuilding = {
    id: 'my_custom_clinic',
    name: '阳光宠物诊所',
    type: 'pet_hospital',
    desc: '提供全天候洗护和调理',
    width: 10.5,
    depth: 7,
    costCoins: 300,
    image: 'cloud://env/buildings/clinic.png',
    enabled: true
  }
  const saveRes = await bService.save('admin_user', { building: customBuilding, revision: listRes.revision })
  assert.equal(saveRes.revision, listRes.revision + 1)
  const saved = saveRes.buildings.find((b) => b.id === 'my_custom_clinic')
  assert.ok(saved)
  assert.equal(saved.tileCount, 6) // (10.5 * 7) / (3.5 * 3.5) = 73.5 / 12.25 = 6
  assert.equal(saved.costCoins, 0)

  // 3. Remove custom building
  const delRes = await bService.remove('admin_user', { id: 'my_custom_clinic',revision:saveRes.revision })
  assert.equal(delRes.buildings.some((b) => b.id === 'my_custom_clinic'), false)
})


