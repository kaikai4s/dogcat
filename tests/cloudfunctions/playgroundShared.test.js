const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {createCollectionStore}=require('./helpers')
const world=require('../../cloudfunctions/api/services/playground-world')
const createShared=require('../../cloudfunctions/api/services/playground-shared')
const {sampleMotion}=require('../../cloudfunctions/api/services/playground-shared/shared-motion')
function fixture() {
  let time=1800000000000
  const users=['a','b','c'].map((openid,i)=>({_id:'u_'+openid,openid,nickname:openid,residentialCommunity:{name:i===2?'B小区':'A小区',address:i===2?'二号路':'一号路'}}))
  const pets=users.map((u)=>({_id:'pet_'+u.openid,openid:u.openid,name:u.openid+'的宠物',species:'cat'}))
  const db=createCollectionStore({users,pets})
  const context={db,checkTextSecurity:async()=>{},nowMs:()=>time,nowText:()=>new Date(time).toISOString(),safeText:(s)=>String(s||''),getUser:async(openid)=>db.state.users.find((u)=>u.openid===openid)}
  const shared=createShared(context),plots=world.create(context)
  const enter=(id,community)=>shared.enter(id,users.find((u)=>u.openid===id),{community},pets.filter((p)=>p.openid===id))
  const auth=(scene)=>({session:scene.session,sceneId:scene.sceneId})
  const snapshot=async(id,scene)=>{
    let cursor='',records=[]
    do {const page=await shared.snapshot(id,{...auth(scene),cursor});records.push(...page.records);cursor=page.nextCursor}while(cursor)
    return records
  }
  return {db,users,pets,context,shared,plots,enter,auth,snapshot,advance:(ms)=>{time+=ms},now:()=>time}
}

test('public home identity tracks actual community residents across relocation and demolition',async()=>{
  const f=fixture()
  const first=await f.plots.claim('a',f.users[0],{x:280,z:280})
  await f.plots.claim('b',f.users[1],{x:560,z:280})
  const extra=await f.plots.claim('a',f.users[0],{x:840,z:280,isNewPlot:true})
  await f.plots.claim('c',f.users[2],{x:280,z:280})
  const scene=await f.enter('a')
  const homeIds=(records)=>new Set(records.filter((p)=>p.kind==='plot'&&p.isResidence).map((p)=>p.ownerId))
  let records=await f.snapshot('a',scene)
  assert.equal(homeIds(records).size,2) // b has never entered the manor and is offline.
  assert.equal(records.find((p)=>p.id===extra.id).isResidence,false)
  assert.ok(records.filter((p)=>p.kind==='plot').every((p)=>!('ownerOpenid' in p)))
  const relocated=await f.plots.claim('a',f.users[0],{x:280,z:560})
  records=await f.snapshot('a',scene)
  assert.equal(homeIds(records).size,2)
  assert.ok(!records.some((p)=>p.id===first.id))
  assert.equal(records.find((p)=>p.id===relocated.id).isResidence,true)
  await f.plots.demolish('b',{plotId:records.find((p)=>p.ownerId==='presence_'+world.hash('b')&&p.kind==='plot').id})
  assert.equal(homeIds(await f.snapshot('a',scene)).size,1)
  const foreign=await f.enter('c')
  assert.equal(homeIds(await f.snapshot('c',foreign)).size,1)
})

test('demolished legacy parcels stay out of scene, region and map without truncating later snapshot pages',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const scene=await f.enter('a'),base=f.db.state.pet_playground_plots.find((p)=>p.kind==='plot')
  for(let i=0;i<105;i++) f.db.state.pet_playground_plots.push({...base,_id:'aaa_removed_'+String(i).padStart(3,'0'),ownerOpenid:'removed-'+i,demolished:true})
  const legacy={...base,_id:world.plotId(scene.sceneId,15,5),ownerOpenid:'legacy',x:840,z:280,cellX:15,cellZ:5}
  delete legacy.buildingType
  f.db.state.pet_playground_plots.push(legacy)
  const records=await f.snapshot('a',scene)
  assert.equal(records.filter((p)=>p.kind==='plot'&&p.isResidence).length,2)
  assert.equal(records.some((p)=>p.id.startsWith('aaa_removed_')),false)
  const removed={...base,_id:world.plotId(scene.sceneId,10,10),ownerOpenid:'removed',x:560,z:560,cellX:10,cellZ:10,demolished:true}
  f.db.state.pet_playground_plots.push(removed)
  const region=await f.plots.region('a',f.users[0],{chunkX:5,chunkZ:5})
  assert.equal(region.plots.some((p)=>p.id===removed._id),false)
  let cursor='',map=[]
  do {const page=await f.plots.mapOverview('a',f.users[0],{cursor});map.push(...page.plots);cursor=page.nextCursor}while(cursor)
  assert.equal(map.length,2)
})

test('legacy offline owners share one color across yards, characters, pets, cars and realtime updates',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  await f.plots.claim('b',f.users[1],{x:560,z:280})
  const initialScene=await f.enter('a'),offlineScene=await f.enter('b')
  await f.snapshot('a',initialScene)
  f.db.state.pet_playground_plots=f.db.state.pet_playground_plots.filter((r)=>r.kind!=='name_colors')
  for(const row of f.db.state.pet_playground_plots)delete row.nameColor
  const oldVersions=new Map()
  for(const shard of f.db.state.pet_playground_live)for(const record of Object.values(shard.records||{})) {
    delete record.nameColor
    oldVersions.set(record.id,{...record.version})
  }
  f.advance(30000)
  const scene=await f.enter('a'),records=await f.snapshot('a',scene)
  const plots=records.filter((r)=>r.kind==='plot')
  assert.equal(new Set(plots.map((p)=>p.nameColor)).size,2)
  assert.equal(scene.nameColor,plots.find((p)=>p.mine).nameColor)
  for(const plot of plots) {
    const owned=records.filter((r)=>r.ownerId===plot.ownerId)
    assert.deepEqual(new Set(owned.map((r)=>r.kind)),new Set(['plot','presence','resident','vehicle']))
    for(const row of owned)assert.equal(row.nameColor,plot.nameColor)
  }
  const offlineColor=plots.find((p)=>!p.mine).nameColor
  for(const shard of f.db.state.pet_playground_live)for(const record of Object.values(shard.records||{})) {
    if(record.ownerId!==offlineScene.playerId)continue
    assert.equal(record.nameColor,offlineColor)
    assert.ok(record.version.epoch>oldVersions.get(record.id).epoch)
    assert.equal(f.db.state.pet_playground_plots.find((row)=>row._id===record.id).nameColor,offlineColor)
  }
  const offlineActor=f.db.state.pet_playground_plots.find((row)=>row._id===offlineScene.playerId)
  assert.equal(offlineActor.session,offlineScene.session)
  await f.shared.sync('b',{...f.auth(offlineScene),seq:1,position:offlineActor.position})
  await f.shared.petScale('b','pet_b',1.2)
  const live=f.db.state.pet_playground_live.flatMap((shard)=>Object.values(shard.records||{}))
  const petOwner=live.find((r)=>r.kind==='resident'&&r.ownerId==='presence_'+world.hash('b'))
  assert.equal(petOwner.nameColor,plots.find((p)=>!p.mine).nameColor)
})

test('retrying a committed movement acknowledges the packet and repairs a failed realtime projection',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const scene=await f.enter('a')
  f.advance(1000)
  const packet={...f.auth(scene),seq:1,position:{x:scene.position.x+5,z:scene.position.z},moving:true}
  await f.shared.sync('a',packet)
  const actor=f.db.state.pet_playground_plots.find((r)=>r._id===scene.playerId)
  const saved=structuredClone(actor)
  const shard=f.db.state.pet_playground_live.find((r)=>r.records&&r.records[scene.playerId])
  delete shard.records[scene.playerId]
  f.advance(500)
  const duplicate=await f.shared.sync('a',packet)
  assert.equal(duplicate.ackSeq,1)
  assert.deepEqual(f.db.state.pet_playground_plots.find((r)=>r._id===scene.playerId),saved)
  const repaired=f.db.state.pet_playground_live.find((r)=>r.records&&r.records[scene.playerId])
  assert.deepEqual(repaired.records[scene.playerId].position,packet.position)
})

test('movement time credit absorbs packet jitter without allowing excess speed',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const scene=await f.enter('a')
  f.db.state.pet_playground_plots.find((r)=>r._id===scene.playerId).position={x:100,z:100}
  f.advance(1000)
  await f.shared.sync('a',{...f.auth(scene),seq:1,position:{x:107,z:100},moving:true})
  await f.shared.sync('a',{...f.auth(scene),seq:2,position:{x:114,z:100},moving:true})
  await assert.rejects(()=>f.shared.sync('a',{...f.auth(scene),seq:3,position:{x:214,z:100}}),/移动过远/)
})

test('reconciliation returns and publishes the valid route prefix instead of discarding all movement',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  await f.plots.claim('b',f.users[1],{x:400,z:400})
  const scene=await f.enter('a')
  f.db.state.pet_playground_plots.find((r)=>r._id===scene.playerId).position={x:100,z:100}
  f.advance(30000)
  const packet={...f.auth(scene),seq:1,reconcile:true,trail:[{x:110,z:100},{x:120,z:100}],position:{x:380,z:350},moving:true}
  const result=await f.shared.sync('a',packet)
  assert.equal(result.corrected,true)
  assert.equal(result.correctionReason,'path')
  assert.deepEqual(result.position,{x:120,z:100})
  const duplicate=await f.shared.sync('a',packet)
  assert.equal(duplicate.ackSeq,1)
  assert.equal(duplicate.corrected,true)
  assert.deepEqual(duplicate.position,result.position)
  const projection=f.db.state.pet_playground_live.find((r)=>r.records&&r.records[scene.playerId]).records[scene.playerId]
  assert.deepEqual(projection.position,result.position)
  assert.equal(projection.moving,false)
})

test('reconciliation still rejects excess travel and malformed points and accepts the next legal move',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const scene=await f.enter('a')
  f.db.state.pet_playground_plots.find((r)=>r._id===scene.playerId).position={x:100,z:100}
  f.advance(1000)
  const result=await f.shared.sync('a',{...f.auth(scene),seq:1,reconcile:true,trail:[{x:105,z:100}],position:{x:200,z:100}})
  assert.equal(result.correctionReason,'distance')
  assert.deepEqual(result.position,{x:105,z:100})
  const next=await f.shared.sync('a',{...f.auth(scene),seq:2,reconcile:true,position:{x:106,z:100}})
  assert.equal(next.corrected,false)
  assert.deepEqual(next.position,{x:106,z:100})
  await assert.rejects(()=>f.shared.sync('a',{...f.auth(scene),seq:3,reconcile:true,position:{x:NaN,z:100}}),/位置无效/)
})

test('buffered route batches share the elapsed-time budget and cannot multiply their movement allowance',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const scene=await f.enter('a')
  f.db.state.pet_playground_plots.find((r)=>r._id===scene.playerId).position={x:100,z:100}
  f.advance(10000)
  await f.shared.sync('a',{...f.auth(scene),seq:1,moreTrail:true,position:{x:160,z:100}})
  await f.shared.sync('a',{...f.auth(scene),seq:2,moreTrail:false,position:{x:220,z:100}})
  await assert.rejects(()=>f.shared.sync('a',{...f.auth(scene),seq:3,position:{x:250,z:100}}),/移动过远/)
})

test('same community shares yards, bowl state, pets and players; visits do not migrate or expose private IDs',async()=>{
  const f=fixture()
  const plot=await f.plots.claim('a',f.users[0],{x:280,z:280})
  const a=await f.enter('a'),b=await f.enter('b'),c=await f.enter('c')
  await f.plots.fillBowl('a',{plotId:plot.id})
  const rows=await f.snapshot('b',b)
  assert.equal(rows.find((r)=>r.kind==='plot').foodBowls.dog,100)
  assert.ok(rows.some((r)=>r.kind==='presence'&&!r.mine&&r.name==='a'))
  assert.ok(rows.some((r)=>r.kind==='resident'&&!r.mine&&r.pets[0].id==='pet_a'))
  for(const row of rows) {assert.equal(row.ownerOpenid,undefined);assert.equal(row.session,undefined)}
  assert.equal((await f.snapshot('c',c)).some((r)=>r.kind==='plot'),false)
  const visit=await f.enter('c',f.users[0].residentialCommunity)
  assert.equal(visit.visiting,true)
  assert.equal(f.users[2].residentialCommunity.name,'B小区')
  assert.ok((await f.snapshot('c',visit)).some((r)=>r.kind==='plot'))
  await assert.rejects(()=>f.plots.claim('c',f.users[2],{x:500,z:500,sceneId:visit.sceneId}),/访问其他小区/)
  await assert.rejects(()=>f.shared.commandPet('b',{...f.auth(b),petId:'pet_a',target:{x:300,z:300}}),/只能操作自己的宠物/)
  await assert.rejects(()=>f.plots.fillBowl('b',{plotId:plot.id}),/只能给自己/)
  await assert.rejects(()=>f.plots.demolish('b',{plotId:plot.id}),/只能拆除自己/)
  assert.ok(a.session)
})

test('departure saves exact position; stale sequences and previous sessions cannot overwrite it',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const a=await f.enter('a'),b=await f.enter('b')
  const position={x:a.position.x+5,z:a.position.z}
  f.advance(1000)
  await f.shared.sync('a',{...f.auth(a),seq:1,position,online:false,characterType:'girl'})
  const neighbor=(await f.snapshot('b',b)).find((r)=>r.kind==='presence'&&!r.mine)
  assert.deepEqual(neighbor.position,position)
  assert.equal(neighbor.online,false)
  await f.shared.sync('a',{...f.auth(a),seq:1,position:a.position,online:true})
  assert.equal((await f.snapshot('b',b)).find((r)=>r.kind==='presence'&&!r.mine).online,false)
  f.advance(100000)
  const returned=await f.enter('a')
  assert.deepEqual(returned.position,position)
  assert.equal(returned.characterType,'girl')
  await assert.rejects(()=>f.shared.sync('a',{...f.auth(a),seq:99,position:a.position}),/场景已切换/)
  f.advance(16000)
  assert.equal((await f.snapshot('b',b)).find((r)=>r.kind==='presence'&&!r.mine).online,false)
})

test('pets continue on the same trajectory without any client, and reconnect does not respawn them',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const a=await f.enter('a'),b=await f.enter('b')
  const resident=(await f.snapshot('b',b)).find((r)=>r.kind==='resident'&&!r.mine)
  const initial=resident.pets[0].motion
  const first=sampleMotion(initial,f.now())
  f.advance(1234567)
  const later=sampleMotion(initial,f.now())
  assert.ok(Array.from({length:30},(_,i)=>sampleMotion(initial,f.now()+i*1000)).some((s)=>s.moving && Math.hypot(s.position.x-first.position.x,s.position.z-first.position.z)>.1))
  await f.shared.sync('a',{...f.auth(a),seq:1,online:false,position:a.position})
  const reentered=await f.enter('a')
  const resumed=(await f.snapshot('a',reentered)).find((r)=>r.kind==='resident'&&r.mine).pets[0].motion
  assert.deepEqual(resumed,initial)
  assert.deepEqual(sampleMotion(resumed,f.now()),later)
  for(let t=0;t<600000;t+=733) {
    const p=sampleMotion(initial,initial.epoch+t).position
    assert.ok(Math.abs(p.x-280)<56 && Math.abs(p.z-280)<56)
  }
})

test('owned pets can leave by gate and then roam outside without entering yards',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const a=await f.enter('a')
  const command={...f.auth(a),petId:'pet_a',target:{x:280,z:350},commandSeq:1}
  const result=await f.shared.commandPet('a',command)
  assert.equal(result.pet.commandSeq,1)
  const published=(await f.snapshot('a',a)).find((row)=>row.kind==='resident'&&row.mine)
  assert.equal(published.pets[0].commandSeq,1)
  await assert.rejects(()=>f.shared.commandPet('a',command),/操作已更新/)
  for(let t=60000;t<300000;t+=501) {
    const p=sampleMotion(result.pet.motion,f.now()+t).position
    assert.ok(Math.abs(p.x-280)>=56 || Math.abs(p.z-280)>=56)
  }
})

test('demolish is owned and atomic; migration only succeeds after removing the old plot',async()=>{
  const f=fixture(),plot=await f.plots.claim('a',f.users[0],{x:280,z:280})
  const extraYard=await f.plots.claim('a',f.users[0],{x:560,z:280,isNewPlot:true})
  assert.equal(f.db.state.pet_playground_plots.filter((p)=>p.kind==='plot').length,2)
  const a=await f.enter('a')
  await assert.rejects(()=>world.updateCommunity(f.db,'a','u_a',f.users[2].residentialCommunity,{},async()=>{}),/先拆除/)
  await assert.rejects(()=>f.plots.demolish('a',{plotId:plot.id,sceneId:'foreign'}),/原小区/)
  const demRes = await f.plots.demolish('a',{plotId:plot.id,sceneId:a.sceneId})
  assert.ok(demRes.removedPlotIds.includes(plot.id))
  assert.ok(demRes.removedPlotIds.includes(extraYard.id))
  assert.equal(await f.plots.own('a'),null)
  assert.equal(await world.read(f.db,plot.id),null)
  assert.equal(await world.read(f.db,extraYard.id),null)
  assert.equal(await world.read(f.db,'resident_'+world.hash('a')),null)
  await world.updateCommunity(f.db,'a','u_a',f.users[2].residentialCommunity,{},async()=>{})
  const latest=f.db.state.users.find((u)=>u.openid==='a')
  const moved=await f.plots.claim('a',latest,{x:280,z:280})
  assert.notEqual(moved.id,plot.id)
  assert.equal(f.db.state.pet_playground_plots.filter((p)=>p.kind==='plot').length,1)
})

test('clock sampling survives days and cloud/client implementations remain identical',()=>{
  for(const file of ['shared-motion.js','navigation.js','yard-layout.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname,'../../cloudfunctions/api/services/playground-shared',file),'utf8'),
      fs.readFileSync(path.join(__dirname,'../../miniprogram/packagePlayground/utils',file),'utf8'))
  }
  const motion={epoch:1000,approach:[{x:0,z:0},{x:7,z:0}],patrol:[{x:7,z:0},{x:10,z:0},{x:7,z:0}],speed:7,roamSpeed:3,wait:3}
  assert.deepEqual(sampleMotion(motion,1500).position,{x:3.5,z:0})
  assert.equal(sampleMotion(motion,3000).moving,false)
  assert.deepEqual(sampleMotion(motion,5500).position,{x:8.5,z:0})
  assert.deepEqual(sampleMotion(motion,5500+8000*1000000).position,{x:8.5,z:0})
})

test('handler exposes scene lifecycle, rejects teleports and fences credentials',async()=>{
  const f=fixture(),handler=require('../../cloudfunctions/api/handlers/playground')(f.context)
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const overview=await handler('a','enterScene',{})
  assert.equal(overview.userCommunity.name,'A小区')
  assert.equal(overview.scene.visiting,false)
  const data=f.auth(overview.scene)
  await assert.rejects(()=>handler('a','syncScene',{...data,seq:1,position:{x:2200,z:2200}}),/移动过远/)
  await assert.rejects(()=>handler('b','getScene',data),/场景已切换/)
  const response=await handler('a','getScene',data)
  assert.ok(response.records.some((r)=>r.kind==='resident'&&r.mine))
})

test('shared snapshots paginate all neighbors without leaking records from another community',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const a=await f.enter('a')
  for(let i=0;i<205;i++) f.db.state.pet_playground_plots.push({_id:'presence_extra_'+String(i).padStart(3,'0'),kind:'presence',communityId:a.sceneId,
    ownerOpenid:'other_'+i,name:'邻居'+i,position:{x:100,z:100},lastSeen:f.now(),online:false,active:true})
  f.db.state.pet_playground_plots.push({_id:'presence_foreign',kind:'presence',communityId:'foreign',ownerOpenid:'foreign',position:{x:1,z:1}})
  const rows=await f.snapshot('a',a)
  assert.equal(rows.filter((r)=>r.kind==='presence').length,206)
  assert.equal(rows.some((r)=>r.id==='presence_foreign'),false)
})

test('existing offline residents pets appear without owner login after deployment',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const b=await f.enter('b')
  const rows=await f.snapshot('b',b)
  assert.ok(rows.some((r)=>r.kind==='resident'&&!r.mine&&r.pets.some((p)=>p.id==='pet_a')))
})

test('pet interaction is owned, checks proximity and shares the pause and feedback',async()=>{
  const f=fixture()
  await f.plots.claim('a',f.users[0],{x:280,z:280})
  const a=await f.enter('a')
  await assert.rejects(()=>f.shared.commandPet('a',{...f.auth(a),petId:'pet_a',interact:true,commandSeq:1}),/走近/)
  f.advance(1000)
  await f.shared.sync('a',{...f.auth(a),seq:1,position:{x:a.position.x-2,z:a.position.z}})
  const result=await f.shared.commandPet('a',{...f.auth(a),petId:'pet_a',interact:true,commandSeq:1})
  const current=sampleMotion(result.pet.motion,f.now()).position
  assert.deepEqual(sampleMotion(result.pet.motion,f.now()+2000).position,current)
  assert.equal(result.pet.interactionUntil,f.now()+2500)
  await assert.rejects(()=>f.shared.commandPet('a',{...f.auth(a),petId:'pet_a',interact:true,commandSeq:2}),/稍等/)
})

test('demolition despawns avatar and pets, keeps profiles, and rebuilding in another community restores them',async()=>{
  const f=fixture(),handler=require('../../cloudfunctions/api/handlers/playground')(f.context)
  const plot=await handler('a','claimPlot',{x:280,z:280})
  const before=await handler('a','enterScene',{})
  const neighbor=await f.enter('b')
  await handler('a','demolishPlot',{plotId:plot.plot.id,sceneId:before.scene.sceneId})
  await assert.rejects(()=>handler('a','syncScene',{...f.auth(before.scene),seq:1,position:before.scene.position}),/场景已切换/)
  const empty=await handler('a','enterScene',{})
  assert.equal(empty.scene.hasAvatar,false)
  assert.equal(empty.plot,null)
  assert.equal(empty.pets[0]._id,'pet_a')
  assert.equal(f.db.state.pets.length,3)
  const rows=await f.snapshot('b',neighbor)
  assert.equal(rows.some((r)=>r.kind==='presence'&&r.name==='a'),false)
  assert.equal(rows.some((r)=>r.kind==='resident'&&r.pets.some((p)=>p.id==='pet_a')),false)
  await handler('a','saveCommunity',{community:f.users[2].residentialCommunity})
  const choosing=await handler('a','enterScene',{})
  assert.equal(choosing.scene.hasAvatar,false)
  assert.equal(choosing.userCommunity.name,'B小区')
  await handler('a','claimPlot',{x:280,z:280,sceneId:choosing.scene.sceneId})
  const rebuilt=await handler('a','enterScene',{})
  assert.equal(rebuilt.scene.hasAvatar,true)
  const restored=await f.snapshot('a',rebuilt.scene)
  assert.ok(restored.some((r)=>r.kind==='resident'&&r.mine&&r.pets[0].id==='pet_a'))
  assert.ok(restored.some((r)=>r.kind==='presence'&&r.mine))
  assert.equal((await f.snapshot('b',neighbor)).some((r)=>r.kind==='resident'),false)
})

test('unplaced users can browse without publishing entities, including legacy phantom records',async()=>{
  const f=fixture(),a=await f.enter('a'),b=await f.enter('b')
  assert.equal(a.hasAvatar,false)
  assert.deepEqual(await f.snapshot('b',b),[])
  f.db.state.pet_playground_plots.push({_id:'presence_legacy',kind:'presence',communityId:a.sceneId,ownerOpenid:'legacy',position:{x:100,z:100}})
  f.db.state.pet_playground_plots.push({_id:'resident_legacy',kind:'resident',communityId:a.sceneId,ownerOpenid:'legacy',pets:[{id:'old_pet'}]})
  assert.deepEqual(await f.snapshot('b',b),[])
  await f.shared.sync('a',{...f.auth(a),seq:1,online:true})
  assert.deepEqual(await f.snapshot('b',b),[])
})
