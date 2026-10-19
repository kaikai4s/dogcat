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

test('farm completes till, seed, water, fertilize, offline growth, harvest and sale without duplicate charges',async()=>{
  const f=fixture(),a=await f.build(),tile=farmLayout(a.plot)[0]
  const initial=await f.shared.farm.state('a',f.auth(a))
  assert.equal(initial.coins,120);assert.equal(initial.beds.length,12)
  await assert.rejects(()=>f.farmAction('a',a,'till',{bedId:0}),/先走到/)
  f.place('a',tile)
  const packet={...f.auth(a),operation:'till',bedId:0,requestId:'exact_request_001'}
  const first=await f.shared.farm.action('a',packet),retry=await f.shared.farm.action('a',packet)
  assert.equal(first.coins,110);assert.equal(retry.coins,110)
  await assert.rejects(()=>f.shared.farm.action('a',{...packet,bedId:1}),/标识已使用/)
  let state=await f.farmAction('a',a,'plant',{bedId:0,cropId:'carrot'})
  assert.equal(state.seeds.carrot,11)
  const initialReady=state.beds[0].readyAt
  state=await f.farmAction('a',a,'water',{bedId:0})
  assert.ok(state.beds[0].readyAt<initialReady)
  state=await f.farmAction('a',a,'fertilize',{bedId:0});assert.equal(state.coins,105)
  await assert.rejects(()=>f.farmAction('a',a,'harvest',{bedId:0}),/还没有成熟/)
  f.advance(300000)
  state=await f.farmAction('a',a,'harvest',{bedId:0});assert.equal(state.produce.carrot,5);assert.equal(state.xp,12)
  state=await f.farmAction('a',a,'sell',{cropId:'carrot',quantity:5});assert.equal(state.coins,135);assert.equal(state.produce.carrot,0)
  const scene=await f.shared.snapshot('a',f.auth(a)),plot=scene.records.find((r)=>r.kind==='plot')
  assert.equal(plot.farmBeds[0].cropId,undefined);assert.equal(plot.farm,undefined)
  assert.equal(plot.coins,undefined);assert.equal(plot.receipts,undefined)
})

test('farm requires the specific nearby bed, rejects batch bypasses and serializes each harvest',async()=>{
  const f=fixture(),a=await f.build(),b=await f.build('b',{x:504,z:280})
  const tiles=farmLayout(a.plot)
  f.place('a',tiles[0]);f.place('b',tiles[0])
  await assert.rejects(()=>f.farmAction('b',b,'till',{bedId:0,plotId:a.plot.id}),/先走到/)
  await assert.rejects(()=>f.farmAction('a',a,'till',{bedId:1}),/这块土地旁边/)
  f.place('a',{x:tiles[0].x+bedReach(tiles[0])+.01,z:tiles[0].z})
  await assert.rejects(()=>f.farmAction('a',a,'till',{bedId:0}),/这块土地旁边/)
  await assert.rejects(()=>f.farmAction('a',a,'till',{bedId:7}),/还未解锁/)
  await assert.rejects(()=>f.farmAction('a',a,'buySeeds',{cropId:'corn'}),/尚未解锁/)
  for(const operation of ['plantAll','waterAll','harvestAll'])await assert.rejects(()=>f.farmAction('a',a,operation,{cropId:'carrot'}),/每块土地/)
  for(let id=0;id<4;id++) {
    f.place('a',tiles[id])
    await f.farmAction('a',a,'till',{bedId:id})
    await f.farmAction('a',a,'plant',{bedId:id,cropId:'carrot'})
    await f.farmAction('a',a,'water',{bedId:id})
  }
  f.advance(300000)
  const results=await Promise.allSettled([f.farmAction('a',a,'harvest',{bedId:3}),f.farmAction('a',a,'harvest',{bedId:3})])
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1)
  for(let bedId=0;bedId<3;bedId++){f.place('a',tiles[bedId]);await f.farmAction('a',a,'harvest',{bedId})}
  const state=await f.shared.farm.state('a',f.auth(a))
  assert.equal(state.produce.carrot,16);assert.equal(state.xp,48)
  await assert.rejects(()=>f.farmAction('a',a,'sell',{cropId:'carrot',quantity:17}),/数量不足/)
  await assert.rejects(()=>f.farmAction('a',a,'buySeeds',{cropId:'carrot',quantity:-1}),/购买数量/)
})

test('client and server clock models and station coordinates remain identical',()=>{
  for(const name of ['pet-needs','farm-model','yard-layout','shared-motion'])assert.equal(
    fs.readFileSync(require.resolve('../../cloudfunctions/api/services/playground-shared/'+name),'utf8'),
    fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/utils/'+name),'utf8'))
})

test('farm levels unlock more beds and crops; moving preserves the wallet and warehouse but resets land',async()=>{
  const f=fixture(),a=await f.build()
  const tiles=farmLayout(a.plot)
  for(let bedId=0;bedId<4;bedId++){f.place('a',tiles[bedId]);await f.farmAction('a',a,'till',{bedId})}
  for(let i=0;i<2;i++) {
    for(let bedId=0;bedId<4;bedId++){f.place('a',tiles[bedId]);await f.farmAction('a',a,'plant',{bedId,cropId:'carrot'})}
    f.advance(300000)
    for(let bedId=0;bedId<4;bedId++){f.place('a',tiles[bedId]);await f.farmAction('a',a,'harvest',{bedId})}
  }
  const levelled=await f.shared.farm.state('a',f.auth(a))
  assert.equal(levelled.level,2);assert.equal(levelled.unlockedBeds,6)
  assert.equal(levelled.crops.find((c)=>c.id==='corn').unlocked,true)
  const before=await f.farmAction('a',a,'buySeeds',{cropId:'corn',quantity:5})
  assert.equal(before.seeds.corn,5)
  await f.plots.demolish('a',{...f.auth(a),plotId:a.plot.id})
  const returned=await f.build('a',{x:504,z:504})
  const after=await f.shared.farm.state('a',f.auth(returned))
  assert.equal(after.coins,before.coins);assert.equal(after.xp,before.xp)
  assert.deepEqual(after.seeds,before.seeds);assert.deepEqual(after.produce,before.produce)
  assert.ok(after.beds.every((b)=>b.state==='wild'))
  const page=await f.shared.snapshot('a',f.auth(returned))
  assert.equal(page.records.some((r)=>r.kind==='farm_account'),false)
})

test('poop fertilizer pickup and 1 hour 2x boost acceleration',async()=>{
  const f=fixture(),a=await f.build()
  const tiles=farmLayout(a.plot)
  f.place('a',tiles[0])
  await f.farmAction('a',a,'till',{bedId:0})
  await f.farmAction('a',a,'plant',{bedId:0,cropId:'carrot'})

  let state=await f.farmAction('a',a,'pickupPoop',{quantity:2})
  assert.equal(state.manure,2)

  const beforeCoins=state.coins
  state=await f.farmAction('a',a,'fertilize',{bedId:0,useManure:true})
  assert.equal(state.manure,1)
  assert.equal(state.coins,beforeCoins)
  const bed=state.beds.find((b)=>b.id===0)
  assert.equal(bed.fertilized,true)
  assert.ok(bed.boostUntil>Date.now())
  assert.equal(bed.state,'growing')
  assert.equal(bed.label,'双倍生长中')
  assert.equal(bed.boosted,true)
  // Carrot original duration is 300s. Under 2x growth speed, remaining is cut by half to 150s
  assert.equal(bed.remaining,150)

  // Advancing 150 seconds completes growth
  f.advance(150000)
  const afterGrowth=await f.shared.farm.state('a',f.auth(a))
  const readyBed=afterGrowth.beds.find((b)=>b.id===0)
  assert.equal(readyBed.state,'ready')
  assert.equal(readyBed.label,'可收获')
})

