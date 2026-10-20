const test=require('node:test')
const assert=require('node:assert/strict')
const {fixture}=require('../fixtures/playgroundLife')
const createCare=require('../../cloudfunctions/api/services/playground-care')
const {sampleMotion}=require('../../cloudfunctions/api/services/playground-shared/shared-motion')
const {sampleNeeds}=require('../../cloudfunctions/api/services/playground-shared/pet-needs')
test('certified villa exposes only a public profile id and revocation removes its badge',async()=>{
  const f=fixture(),scene=await f.build()
  const extra=await f.plots.claim('a',f.user('a'),{x:560,z:280,isNewPlot:true})
  f.db.state.staff_profiles=[{_id:'staff_a',openid:'a',auditStatus:'approved',realName:'私人姓名',phone:'13812345678',idCard:'secret',staffLevel:'formal'}]
  let snapshot=await f.shared.snapshot('a',f.auth(scene)),plot=snapshot.records.find((r)=>r.kind==='plot'&&r.isResidence)
  assert.deepEqual(plot.staffCard,{id:'staff_a',label:'认证宠托师'})
  assert.equal(snapshot.records.find((r)=>r.id===extra.id).staffCard,null)
  assert.ok(!JSON.stringify(plot).includes('13812345678'))
  f.db.state.staff_profiles[0].auditStatus='rejected'
  snapshot=await f.shared.snapshot('a',f.auth(scene));plot=snapshot.records.find((r)=>r.kind==='plot'&&r.isResidence)
  assert.equal(plot.staffCard,null)
})
test('active walking service enters the yard, escorts only the booked dog, and returns home after actual completion',async()=>{
  const f=fixture(),scene=await f.build(),resident=f.resident('a')
  resident.pets.push({...JSON.parse(JSON.stringify(resident.pets[0])),id:'unbooked',name:'未预约的宠物'})
  f.db.state.orders=[{_id:'walk',clientOpenid:'a',staffOpenid:'b',petIds:['pet_a'],serviceTypes:['walk'],status:'in_service',updatedAt:new Date(f.now()).toISOString()}]
  await f.shared.snapshot('a',f.auth(scene))
  assert.equal(f.resident('a').careAgent.phase,'entering')
  assert.ok(f.pet('a').serviceManaged)
  assert.ok(!f.resident('a').pets.find((p)=>p.id==='unbooked').serviceManaged)
  f.advance(20000);await f.shared.snapshot('a',f.auth(scene))
  assert.equal(f.resident('a').careAgent.phase,'walking')
  await f.enter('a')
  assert.equal(f.resident('a').careAgent.phase,'walking')
  assert.equal(f.resident('a').serviceCare.orderId,'walk')
  f.advance(15000)
  const pos=sampleMotion(f.pet('a').motion,f.now()).position,plot=f.row(f.resident('a').plotId)
  assert.ok(Math.abs(pos.x-plot.x)>(plot.size||48)/2||Math.abs(pos.z-plot.z)>(plot.size||48)/2)
  f.db.state.orders[0].status='completed'
  const freshScene=await f.enter('a')
  await f.shared.snapshot('a',f.auth(freshScene))
  assert.equal(f.resident('a').careAgent.phase,'returning')
  f.advance(120000);await f.shared.snapshot('a',f.auth(freshScene))
  assert.equal(f.resident('a').careAgent,null)
  assert.equal(f.pet('a').serviceManaged,false)
  const back=sampleMotion(f.pet('a').motion,f.now()).position
  assert.ok(Math.abs(back.x-plot.x)<plot.size/2&&Math.abs(back.z-plot.z)<plot.size/2)
})
test('public nearby pet care is whitelisted and cannot expose remarks, photos, addresses or foreign pets',async()=>{
  const f=fixture(),scene=await f.build(),care=createCare(f.context)
  const pet=f.pet('a'),position=sampleMotion(pet.motion,f.now()).position
  f.place('a',position)
  f.db.state.orders=[{_id:'booked',clientOpenid:'a',staffOpenid:'b',petIds:['pet_a'],status:'completed',createdAt:'2026-10-20T01:00:00Z',doorplate:'secret-door'}]
  f.db.state.checkin_logs=[{_id:'food',orderId:'booked',eventType:'food',createdAt:'2026-10-20T01:00:00Z',remark:'密码123456',mediaFileId:'private-photo'}, {orderId:'booked',eventType:'enter_door',createdAt:'2026-10-20T01:00:00Z',remark:'private'}]
  const result=await care.publicCare('a',{...f.auth(scene),petId:'pet_a'})
  assert.deepEqual(result.records,[{label:'添加粮食',date:'2026-10-20'}])
  for(const secret of ['密码','private','secret','staffOpenid','orderId'])assert.ok(!JSON.stringify(result).includes(secret))
  f.place('a',{x:1000,z:1000})
  await assert.rejects(care.publicCare('a',{...f.auth(scene),petId:'pet_a'}),/走近/)
  await assert.rejects(care.publicCare('a',{...f.auth(scene),petId:'pet_a',session:'wrong'}),/先进入/)
})
test('species-specific state recovery uses server config and agrees with client sampling',()=>{
  const config=require('../../cloudfunctions/api/services/playground-config').careConfig({cat:{eatRate:.5,satietyDecay:6},dog:{eatRate:.1,satietyDecay:12}})
  const cat={needs:{at:0,satiety:10},needsRules:config.cat,care:{type:'eat',startsAt:0,endsAt:100000}}
  const dog={...cat,needsRules:config.dog}
  assert.ok(sampleNeeds(cat,10000).satiety>sampleNeeds(dog,10000).satiety)
  assert.deepEqual(sampleNeeds(cat,10000),require('../../miniprogram/packagePlayground/utils/pet-needs').sampleNeeds(cat,10000))
})
test('sitter public card service history contains no client identity, exact location, media or medical details',async()=>{
  const f=fixture()
  f.db.state.orders=[{_id:'private-order-id',staffOpenid:'b',clientOpenid:'a',status:'completed',petIds:['pet_a'],serviceTypes:['feed','medicine'],completedAt:'2026-10-20T02:00:00Z',serviceSummary:'私人药物名称',doorplate:'秘密门牌',contactPhone:'13800000000',petSnapshot:{name:'私人宠物名'}}]
  const service=require('../../cloudfunctions/api/services/reviews')({...f.context,toPublicSitter:()=>({}),toTimeValue:(v)=>new Date(v).getTime(),safeText:String})
  const card=await service.toPublicSitterDetail('',{_id:'sp_b',openid:'b'})
  assert.deepEqual(card.recentServices,[{date:'2026-10-20',serviceText:'喂养、日常照护',petCount:1}])
  for(const secret of ['private-order','私人','秘密','13800000000','clientOpenid'])assert.ok(!JSON.stringify(card.recentServices).includes(secret))
})

test('simultaneous services keep independent sitters for different booked pets and survive reentry', async () => {
  const f=fixture(), scene=await f.build(), resident=f.resident('a')
  resident.pets.push({...JSON.parse(JSON.stringify(resident.pets[0])),id:'second-dog',name:'第二只狗'})
  f.db.state.pets.push({_id:'second-dog',openid:'a',name:'第二只狗',species:'dog'})
  f.db.state.orders=[
    {_id:'first-service',clientOpenid:'a',staffOpenid:'b',petIds:['pet_a'],serviceTypes:['walk'],status:'in_service',updatedAt:new Date(f.now()).toISOString()},
    {_id:'second-service',clientOpenid:'a',staffOpenid:'c',petIds:['second-dog'],serviceTypes:['feed'],status:'in_service',updatedAt:new Date(f.now()).toISOString()}
  ]
  const snapshot=await f.shared.snapshot('a',f.auth(scene))
  assert.equal(f.resident('a').serviceCares.length,2)
  const publicResident=snapshot.records.find((r)=>r.kind==='resident')
  assert.equal(publicResident.careAgents.length,2)
  assert.equal(publicResident.serviceCares,undefined)
  assert.ok(!JSON.stringify(publicResident).includes('first-service'))
  assert.notEqual(f.resident('a').pets[0].serviceAgentId,f.resident('a').pets[1].serviceAgentId)
  await f.shared.enter('a',f.user('a'),{},f.db.state.pets.filter((p)=>p.openid==='a'))
  assert.equal(f.resident('a').serviceCares.length,2)
  f.advance(20000)
  const fresh=await f.shared.enter('a',f.user('a'),{},f.db.state.pets.filter((p)=>p.openid==='a'))
  await f.shared.snapshot('a',f.auth(fresh))
  assert.deepEqual(f.resident('a').careAgents.map((a)=>a.phase).sort(),['caring','walking'])
  f.db.state.orders[0].status='completed'
  await f.shared.snapshot('a',f.auth(fresh))
  f.advance(120000);await f.shared.snapshot('a',f.auth(fresh))
  assert.equal(f.resident('a').serviceCares.length,1)
  assert.equal(f.resident('a').serviceCares[0].orderId,'second-service')
  assert.equal(f.resident('a').pets[0].serviceManaged,false)
  assert.equal(f.resident('a').pets[1].serviceManaged,true)
})

test('a new daily session cannot keep walking on the previous session route',async()=>{
  const f=fixture(),scene=await f.build()
  const order={_id:'multi',clientOpenid:'a',staffOpenid:'b',petIds:['pet_a'],serviceTypes:['walk'],status:'in_service',activeSessionIndex:1,currentSessionStartedAt:'2026-10-20T01:00:00Z',updatedAt:new Date(f.now()).toISOString()}
  f.db.state.orders=[order]
  await f.shared.snapshot('a',f.auth(scene));f.advance(20000);await f.shared.snapshot('a',f.auth(scene))
  const oldSession=f.resident('a').serviceCare.sessionKey
  f.db.state.orders[0].activeSessionIndex=2;f.db.state.orders[0].currentSessionStartedAt='2026-10-21T01:00:00Z'
  await f.shared.snapshot('a',f.auth(scene))
  assert.equal(f.resident('a').careAgent.phase,'returning')
  f.advance(120000);await f.shared.snapshot('a',f.auth(scene))
  assert.notEqual(f.resident('a').serviceCare.sessionKey,oldSession)
  assert.equal(f.resident('a').careAgent.phase,'entering')
})

test('new geometry rebuilds an active sitter route but bowl updates do not interrupt it',async()=>{
  const f=fixture(),scene=await f.build()
  f.db.state.orders=[{_id:'walk-layout',clientOpenid:'a',staffOpenid:'b',petIds:['pet_a'],serviceTypes:['walk'],status:'in_service',updatedAt:new Date(f.now()).toISOString()}]
  await f.shared.snapshot('a',f.auth(scene));f.advance(20000);await f.shared.snapshot('a',f.auth(scene))
  const oldGeometry=f.resident('a').serviceCare.layoutKey
  f.row(f.resident('a').plotId).revision+=1
  await f.shared.snapshot('a',f.auth(scene))
  assert.equal(f.resident('a').careAgent.phase,'walking')
  f.row(f.resident('a').plotId).gateDirection='east'
  await f.shared.snapshot('a',f.auth(scene))
  assert.notEqual(f.resident('a').serviceCare.layoutKey,oldGeometry)
  assert.equal(f.resident('a').careAgent.phase,'returning')
})

test('sitter refills advance the plot version so connected clients accept the new bowl state',async()=>{
  const f=fixture(),scene=await f.build()
  f.db.state.orders=[{_id:'refill',clientOpenid:'a',staffOpenid:'b',petIds:['pet_a'],serviceTypes:['feed'],status:'in_service',updatedAt:new Date(f.now()).toISOString()}]
  const before=await f.shared.snapshot('a',f.auth(scene))
  const oldPlot=before.records.find((r)=>r.kind==='plot')
  assert.equal(oldPlot.foodBowls.dog,0)
  f.advance(20000)
  const after=await f.shared.snapshot('a',f.auth(scene))
  const plot=after.records.find((r)=>r.id===oldPlot.id)
  assert.equal(plot.foodBowls.dog,100)
  assert.ok(plot.version.epoch>oldPlot.version.epoch,'refills must not be discarded as an old scene record')
  const unchanged=await f.shared.snapshot('a',f.auth(scene))
  assert.deepEqual(unchanged.records.find((r)=>r.id===plot.id).version,plot.version,'full bowls must not generate redundant updates')
})
