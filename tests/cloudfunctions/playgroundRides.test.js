const test=require('node:test')
const assert=require('node:assert/strict')
const {fixture}=require('../fixtures/playgroundLife')
const world=require('../../cloudfunctions/api/services/playground-world')
const {sampleMotion}=require('../../cloudfunctions/api/services/playground-shared/shared-motion')
async function ready() {
  const f=fixture(),a=await f.drive(),b=await f.build('b',{x:504,z:280})
  f.place('b',{x:283.5,z:338});f.placePet('b',{x:284,z:339})
  await f.petAction('b',b,'follow')
  f.place('a',f.car('a').position)
  const invite=(id,scene,operation,player)=>f.shared.rides.request(id,{...f.auth(scene),operation,playerId:f.actor(player)._id})
  const accept=async(id,scene,yes=true)=>{
    const mail=await f.shared.social.state(id),r=mail.incoming.find((r)=>r.type.startsWith('ride'))
    assert.ok(r)
    return f.shared.rides.respond(id,{...f.auth(scene),requestId:r.id,accept:yes})
  }
  return {...f,a,b,invite,accept}
}
test('driver invites a nearby player; only their acceptance boards both passenger and following pets',async()=>{
  const f=await ready()
  await f.invite('a',f.a,'invite','b')
  assert.equal(f.actor('b').vehicleId,'')
  const mail=await f.shared.social.state('b'),request=mail.incoming[0]
  assert.equal(request.type,'rideInvite');assert.equal(request.openid,undefined);assert.equal(request.driverSession,undefined)
  const result=await f.accept('b',f.b)
  assert.equal(f.actor('b').vehicleId,f.car('a')._id);assert.equal(f.actor('b').vehicleRole,'passenger')
  assert.equal(f.pet('b').ridingVehicleId,f.car('a')._id)
  assert.equal(f.car('a').passengers.length,1)
  assert.ok(result.records.some((r)=>r.kind==='resident'&&r.ownerId===f.actor('b')._id))
  await f.shared.rides.respond('b',{...f.auth(f.b),requestId:request.id,accept:true})
  assert.equal(f.car('a').passengers.length,1)
  const snapshot=await f.shared.snapshot('a',f.auth(f.a)),car=snapshot.records.find((r)=>r.kind==='vehicle'&&r.ownerId===f.a.playerId)
  assert.equal(car.passengers[0].openid,undefined)
})

test('passenger follows realtime car coordinates, cannot drive it, and can leave with their own pets',async()=>{
  const f=await ready()
  await f.invite('b',f.b,'request','a');await f.accept('a',f.a)
  f.advance(1000)
  await f.sync('a',f.a,{position:{x:280,z:360},moving:true,facing:'ne'})
  const before=structuredClone(f.car('a'))
  const packet=await f.sync('b',f.b,{position:{x:100,z:100},moving:true,facing:'sw'})
  assert.equal(packet.riding,true);assert.deepEqual(f.actor('b').position,before.position)
  assert.deepEqual(f.car('a'),before)
  await assert.rejects(()=>f.shared.vehicles.action('b',f.user('b'),{...f.auth(f.b),operation:'exit',vehicleId:f.car('a')._id}),/只能操作自己的/)
  await f.shared.rides.leave('b',f.auth(f.b))
  assert.equal(f.actor('b').vehicleId,'');assert.equal(f.car('a').passengers.length,0)
  assert.equal(f.pet('b').ridingVehicleId,'');assert.equal(f.pet('b').following,true)
  assert.ok(Math.hypot(f.actor('b').position.x-280,f.actor('b').position.z-360)<8)
})

test('driver exit releases every passenger and all of their pets on valid ground in one transaction',async()=>{
  const f=await ready()
  await f.petAction('a',f.a,'feed').catch(()=>{})
  await f.invite('a',f.a,'invite','b');await f.accept('b',f.b)
  const exited=await f.action('a',f.a,'exit')
  assert.equal(f.actor('a').vehicleId,'');assert.equal(f.actor('b').vehicleId,'')
  assert.equal(f.car('a').state,'outside');assert.deepEqual(f.car('a').passengers,[])
  assert.equal(f.pet('b').ridingVehicleId,'')
  assert.ok(exited.records.some((r)=>r.kind==='presence'&&r.ownerId===f.b.playerId))
  const p=sampleMotion(f.pet('b').motion,f.now()).position
  assert.deepEqual(p,f.actor('b').position)
})

test('a rejected invitation never boards, expired or stale sessions cannot approve old invitations',async()=>{
  const f=await ready()
  await f.invite('a',f.a,'invite','b');await f.accept('b',f.b,false)
  assert.equal(f.car('a').passengers.length,0)
  f.advance(11000);f.place('a',f.car('a').position);f.place('b',{x:283.5,z:338})
  await f.invite('a',f.a,'invite','b')
  const mail=await f.shared.social.state('b'),request=mail.incoming[0]
  f.advance(61000)
  await assert.rejects(()=>f.shared.rides.respond('b',{...f.auth(f.b),requestId:request.id,accept:true}),/过期/)
  f.place('a',f.car('a').position);f.place('b',{x:283.5,z:338})
  await f.invite('a',f.a,'invite','b')
  const reentered=await f.enter('b')
  await assert.rejects(()=>f.accept('b',reentered),/车辆或场景已变化/)
  assert.equal(f.car('a').passengers.length,0)
})

test('ride consent rechecks distance, stopped car, community and capacity at acceptance time',async()=>{
  const f=await ready()
  f.car('a').moving=true
  await assert.rejects(()=>f.invite('b',f.b,'request','a'),/先停车/)
  f.car('a').moving=false
  await f.invite('a',f.a,'invite','b')
  f.place('b',{x:300,z:338})
  await assert.rejects(()=>f.accept('b',f.b),/距离太远/)
  f.place('b',{x:283.5,z:338})
  f.car('a').passengers=[{id:'occupied1'},{id:'occupied2'},{id:'occupied3'}]
  await assert.rejects(()=>f.accept('b',f.b),/满员/)
  f.car('a').passengers=[]
  const c=await f.build('f',{x:280,z:280})
  f.place('f',{x:283.5,z:338})
  await assert.rejects(()=>f.invite('f',c,'request','a'),/离开/)
  const pending=(await f.shared.social.state('b')).incoming[0]
  await assert.rejects(()=>f.shared.social.respond('b',{requestId:pending.id,accept:true}),/乘车申请入口/)
})

test('passenger scene re-entry detaches the seat and pets; a driver scene switch safely drops everyone first',async()=>{
  const f=await ready()
  await f.invite('a',f.a,'invite','b');await f.accept('b',f.b)
  const b=await f.enter('b')
  assert.equal(f.car('a').passengers.length,0);assert.equal(b.vehicleId,'');assert.equal(f.pet('b').ridingVehicleId,'')
  f.advance(11000);f.place('a',f.car('a').position);f.place('b',{x:283.5,z:338});f.placePet('b',{x:284,z:338})
  await f.invite('a',f.a,'invite','b');await f.accept('b',b)
  await f.enter('a',{name:'B小区'})
  assert.equal(f.actor('b').vehicleId,'');assert.equal(f.car('a').state,'parked');assert.equal(f.pet('b').ridingVehicleId,'')
})

test('demolition API releases passengers atomically and publishes their exit without leaking private records',async()=>{
  const f=await ready()
  await f.invite('a',f.a,'invite','b');await f.accept('b',f.b)
  const handler=require('../../cloudfunctions/api/handlers/playground')({...f.context,getUser:async(id)=>f.user(id),safeText:String})
  const result=await handler('a','demolishPlot',{...f.auth(f.a),plotId:f.a.plot.id})
  assert.deepEqual(result,{removed:true})
  assert.equal(f.car('a'),undefined);assert.equal(f.actor('a'),undefined)
  assert.equal(f.actor('b').vehicleId,'');assert.equal(f.pet('b').ridingVehicleId,'')
  const shard=f.db.state.pet_playground_live.find((r)=>r.records&&r.records[f.b.playerId])
  assert.equal(shard.records[f.b.playerId].vehicleId,'')
  assert.equal(shard.records[f.b.playerId].ownerOpenid,undefined)
})
