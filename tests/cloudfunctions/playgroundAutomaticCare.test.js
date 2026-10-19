const test=require('node:test')
const assert=require('node:assert/strict')
const {fixture}=require('../fixtures/playgroundLife')
const world=require('../../cloudfunctions/api/services/playground-world')
const {sampleNeeds}=require('../../cloudfunctions/api/services/playground-shared/pet-needs')
const {sampleMotion}=require('../../cloudfunctions/api/services/playground-shared/shared-motion')
const {yardLayout}=require('../../cloudfunctions/api/services/playground-shared/yard-layout')

function needs(f,values={}) {
  f.pet('a').needs={at:f.now(),energy:80,satiety:80,hydration:80,pee:0,poop:0,...values}
}
function fill(f,food=100) {
  f.row(world.ownerId('a')).foodBowls={dog:food,cat:food}
  f.row(f.resident('a').plotId).foodBowls={dog:food,cat:food}
}
for(const [type,key] of [['sleep','energy'],['eat','satiety'],['drink','hydration']]) {
  test(`shared pet automatically starts ${type} at 20, recovers only after arrival and resumes roaming`,async()=>{
    const f=fixture(),scene=await f.build()
    f.placePet('a',{x:280,z:320});fill(f)
    needs(f,{[key]:21})
    await f.sync('a',scene)
    assert.ok(!f.pet('a').care)
    f.advance(1000);needs(f,{[key]:20})
    await f.sync('a',scene)
    let pet=f.pet('a'),care={...pet.care}
    assert.equal(care.type,type)
    assert.ok(care.startsAt>f.now())
    const home=f.row(world.ownerId('a')),station=yardLayout(home).stations.dog[type]
    assert.deepEqual(pet.motion.patrol,[station])
    assert.equal(sampleNeeds(pet,f.now())[key],20)
    const food=home.foodBowls.dog
    if(type==='eat')assert.equal(food,75)
    f.advance(1000);await f.sync('a',scene)
    assert.equal(f.row(world.ownerId('a')).foodBowls.dog,food)
    f.advance(care.startsAt+10000-f.now())
    await f.sync('a',scene)
    assert.ok(sampleNeeds(f.pet('a'),f.now())[key]>20)
    f.advance(care.endsAt+1-f.now())
    await f.sync('a',scene)
    pet=f.pet('a')
    assert.ok(sampleNeeds(pet,f.now())[key]>=98)
    assert.equal(pet.care,null)
    assert.ok(pet.motion.patrol.length>1)
  })
}

test('automatic care stays in own yard, handles empty bowls and prioritizes the lowest available need',async()=>{
  const f=fixture(),scene=await f.build()
  fill(f,0);f.placePet('a',{x:280,z:350});needs(f,{satiety:10,hydration:20})
  await f.sync('a',scene)
  assert.ok(!f.pet('a').care)
  f.advance(1000);f.placePet('a',{x:280,z:320})
  await f.sync('a',scene)
  assert.equal(f.pet('a').care.type,'drink')
  assert.equal(f.row(world.ownerId('a')).foodBowls.dog,0)
})

test('a visitor advances an offline neighbor pet and publishes its meal and bowl consistently',async()=>{
  const f=fixture(),scene=await f.build(),visitor=await f.enter('b')
  f.placePet('a',{x:280,z:320});needs(f,{satiety:20});fill(f,25)
  const snapshot=await f.shared.snapshot('b',f.auth(visitor))
  const resident=snapshot.records.find((r)=>r.kind==='resident'&&r.ownerId===scene.playerId)
  assert.equal(resident.pets[0].care.type,'eat')
  assert.equal(resident.pets[0].lifeManaged,true)
  assert.equal(snapshot.records.find((r)=>r.id===f.resident('a').plotId).foodBowls.dog,0)
  await f.shared.snapshot('b',f.auth(visitor))
  assert.equal(f.row(world.ownerId('a')).foodBowls.dog,0)
})

test('a low need interrupts following inside the yard and care checks use decayed values',async()=>{
  const f=fixture(),scene=await f.build()
  f.placePet('a',{x:280,z:320});needs(f,{energy:28})
  f.pet('a').following=true
  f.advance(3600001)
  await f.sync('a',scene)
  assert.equal(f.pet('a').care.type,'sleep')
  assert.equal(f.pet('a').following,false)
})

test('neighbor excretion is authoritative, pauses movement and survives repeated snapshots without duplicates',async()=>{
  const f=fixture(),scene=await f.build(),visitor=await f.enter('b')
  f.placePet('a',{x:280,z:350});needs(f,{poop:80,pee:40})
  await f.shared.snapshot('b',f.auth(visitor))
  const poopDueAt=f.pet('a').poopDueAt
  f.advance(61000)
  let snapshot=await f.shared.snapshot('b',f.auth(visitor))
  let pet=snapshot.records.find((r)=>r.ownerId===scene.playerId&&r.kind==='resident').pets[0]
  assert.equal(pet.waste.length,1)
  assert.equal(pet.waste[0].type,'pee')
  assert.equal(pet.poopDueAt,poopDueAt)
  assert.equal(pet.relieving.until-f.now(),3000)
  f.advance(60000)
  snapshot=await f.shared.snapshot('b',f.auth(visitor))
  pet=snapshot.records.find((r)=>r.ownerId===scene.playerId&&r.kind==='resident').pets[0]
  assert.equal(pet.waste.length,2)
  assert.equal(pet.waste[1].type,'poop')
  assert.equal(Math.round(pet.needs.poop),40)
  await f.shared.snapshot('b',f.auth(visitor))
  assert.equal(f.pet('a').waste.length,2)
  assert.deepEqual(sampleMotion(pet.motion,f.now()+3000).position,pet.relieving.position)
})

test('relief validates the current scene and repeated packets do not deduct needs twice',async()=>{
  const f=fixture(),scene=await f.build()
  needs(f,{poop:100})
  await assert.rejects(f.shared.companions.relief('a',{...f.auth(scene),session:'old',petId:'pet_a',type:'poop'}),/场景/)
  const packet={...f.auth(scene),petId:'pet_a',type:'poop',amount:999}
  await f.shared.companions.relief('a',packet)
  await f.shared.companions.relief('a',packet)
  assert.equal(f.pet('a').needs.poop,60)
  assert.equal(f.pet('a').waste.length,1)
})

test('picking shared poop removes it from every snapshot without awarding manure',async()=>{
  const f=fixture(),scene=await f.build()
  f.placePet('a',{x:280,z:350});needs(f,{poop:100})
  await f.shared.snapshot('a',f.auth(scene))
  const event=f.pet('a').waste[0]
  await assert.rejects(f.farmAction('a',scene,'pickupPoop',{poopId:event.id}),/走近/)
  f.place('a',{x:event.x,z:event.z})
  const result=await f.farmAction('a',scene,'pickupPoop',{poopId:event.id})
  assert.equal(result.manure,undefined)
  const snapshot=await f.shared.snapshot('a',f.auth(scene))
  assert.equal(snapshot.records.find((r)=>r.kind==='resident').pets[0].waste.length,0)
  await assert.rejects(f.farmAction('a',scene,'pickupPoop',{poopId:event.id}),/已被拾取/)
  assert.equal(f.pet('a').waste.length,0)
})

test('onboard relief publishes vehicle stains without creating ground waste',async()=>{
  const f=fixture(),scene=await f.build()
  f.pet('a').following=true
  await f.drive('a',scene)
  needs(f,{pee:100})
  const snapshot=await f.shared.snapshot('a',f.auth(scene))
  const pet=snapshot.records.find((r)=>r.kind==='resident').pets[0]
  const car=snapshot.records.find((r)=>r.kind==='vehicle')
  assert.equal(pet.waste[0].vehicleId,car.id)
  assert.equal(car.soiled,true)
  assert.equal(car.stains.length,1)
  await f.shared.snapshot('a',f.auth(scene))
  assert.equal(f.car('a').stains.length,1)
})
