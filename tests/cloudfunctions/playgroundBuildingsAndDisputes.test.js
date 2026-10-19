const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture } = require('../fixtures/playgroundLife')
const createBuildingsService = require('../../cloudfunctions/api/services/playground-buildings')
const createDisputesService = require('../../cloudfunctions/api/services/playground-disputes')

test('building catalog calculates grass tile count correctly and manages buildings', async () => {
  const f = fixture()
  const service = createBuildingsService(f.context)
  const catalog = await service.list()
  assert.ok(catalog.buildings.length >= 4)
  const repair = catalog.buildings.find((b) => b.type === 'repair_shop')
  assert.equal(repair.width, 7)
  assert.equal(repair.depth, 7)
  assert.equal(repair.tileCount, 4) // 49 / 12.25 = 4
  assert.equal(repair.costCoins, 0)

  // 保存一个更大尺寸的建筑并验证草地格子换算 (10.5m x 10.5m = 110.25㎡ / 12.25 = 9 块草地)
  const saved = await service.save('admin', {revision:catalog.revision,
    building: {
      id: 'mega_hospital',
      name: '大型综合宠物医院',
      type: 'pet_hospital',
      width: 10.5,
      depth: 10.5,
      costCoins: 500,
      image: 'https://cloud.test/hospital.png'
    }
  })
  const custom = saved.buildings.find((b) => b.id === 'mega_hospital')
  assert.equal(custom.tileCount, 9)
  assert.equal(custom.costCoins, 0)
})

test('outdoor plot purchase with fence and gate direction places selected building', async () => {
  const f = fixture()
  const user = f.user('a')
  // 庭院外购买地皮建造宠物医院，选择东侧留门
  const plot = await f.plots.claim('a', user, {
    x: 280,
    z: 280,
    gateDirection: 'east',
    buildingId: 'pet_hospital_default',
    buildingType: 'pet_hospital',
    buildingName: '爱心宠物医院'
  })
  assert.equal(plot.gateDirection, 'east')
  assert.equal(plot.buildingType, 'pet_hospital')
  assert.equal(plot.buildingName, '爱心宠物医院')
  assert.ok(plot.name.includes('爱心宠物医院'))
})

test('buildInYard modifies existing courtyard building without moving plot or gates', async () => {
  const f = fixture()
  const user = f.user('a')
  // 先安置标准住宅庭院
  await f.plots.claim('a', user, { x: 280, z: 280, gateDirection: 'north' })
  const before = await f.plots.own('a')
  assert.equal(before.gateDirection, 'north')
  assert.equal(before.buildingType, 'residential')

  // 在庭院内建造社区修理厂
  const updated = await f.plots.buildInYard('a', user, {
    buildingId: 'repair_shop_default',
    buildingType: 'repair_shop',
    buildingName: '社区修理厂',
    buildingWidth: 7,
    buildingDepth: 7
  })
  assert.equal(updated.buildingType, 'repair_shop')
  assert.equal(updated.buildingName, '社区修理厂')
  assert.equal(updated.gateDirection, 'north') // 原留门方向不变
  assert.equal(updated.x, 280)
  assert.equal(updated.z, 280)
})

test('committee uniqueness: only one committee can be built per community', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a') // a 建造庭院
  const sceneId = a.sceneId

  // a 成为居委会
  await handler('a', 'buildInYard', {
    buildingType: 'committee',
    buildingName: '阳光居委会',
    sceneId
  })

  // Replacing the building on the same plot must ignore its owner mapping.
  await handler('a','buildInYard',{buildingId:'committee_default',plotId:a.plot.id,sceneId})

  // b 尝试在同一社区建造居委会，必须被拦截
  await f.build('b', { x: 560, z: 280 })
  await assert.rejects(
    () =>
      handler('b', 'buildInYard', {
        buildingType: 'committee',
        buildingName: '第二居委会',
        sceneId
      }),
    /当前社区已设立居委会，每个社区有且仅能有一个居委会/
  )
})


const world=require('../../cloudfunctions/api/services/playground-world')
const {farmLayout}=require('../../cloudfunctions/api/services/playground-shared/farm-model')
const pointUser=(f,id)=>f.db.state.users.find((u)=>u.openid===id)
function waste(f,id='c',extra={}) {
  const event={id:'waste_'+world.hash(id)+'_'+world.hash('pet_'+id).slice(0,8)+'_'+f.now(),type:'poop',x:280,z:338,createdAt:f.now(),vehicleId:'',...extra}
  f.pet(id).waste=[event];return event
}
async function committeeFixture() {
  const f=fixture(),a=await f.build(),b=await f.build('b',{x:504,z:280}),c=await f.build('c',{x:280,z:504})
  const handler=require('../../cloudfunctions/api/handlers/playground')(f.context)
  await handler('a','buildInYard',{...f.auth(a),buildingId:'committee_default'})
  f.place('b',{x:280,z:338})
  return {f,a,b,c,handler}
}

test('real poop reports and resolutions award real membership points once, including concurrent retries',async()=>{
  const {f,a,b,c,handler}=await committeeFixture(),event=waste(f)
  await f.db.collection('member_levels').doc('bronze').set({data:{name:'普通',minPoints:0}})
  await f.db.collection('member_levels').doc('silver').set({data:{name:'银卡',minPoints:5}})
  const reports=await Promise.all([handler('b','reportPoop',{...f.auth(b),poopId:event.id,x:0,z:0}),handler('b','reportPoop',{...f.auth(b),poopId:event.id})])
  assert.deepEqual(reports.map((r)=>r.pointsReceived).sort((a,b)=>a-b),[0,5])
  assert.equal(pointUser(f,'b').points,5);assert.equal(pointUser(f,'b').totalPoints,5);assert.equal(pointUser(f,'b').memberLevel,'silver')
  const list=await handler('a','listDisputes',f.auth(a))
  assert.equal(list.isCommittee,true);assert.equal(list.disputes.length,1);assert.equal(list.disputes[0].suspectOpenid,undefined)
  assert.equal(list.disputes[0].location.x,event.x)
  const disputeId=reports[0].disputeId
  await assert.rejects(()=>handler('b','resolveDispute',{...f.auth(b),disputeId}),/只有当前社区在任/)
  const resolutions=await Promise.all([handler('a','resolveDispute',{...f.auth(a),disputeId}),handler('a','resolveDispute',{...f.auth(a),disputeId})])
  assert.equal(resolutions.reduce((sum,r)=>sum+r.rewardReceived,0),10)
  assert.equal(pointUser(f,'a').points,10);assert.equal(pointUser(f,'a').totalPoints,10)
  assert.equal(f.pet('c').waste.length,0)
  assert.equal(f.db.state.point_logs.length,2)
  assert.ok(f.db.state.point_logs.every((l)=>l.sourceType.startsWith('playground_')))
  assert.equal(pointUser(f,'c').points,undefined)
})

test('reports reject fabricated, own, far, car-stain and cross-scene waste with no points issued',async()=>{
  const {f,a,b,c,handler}=await committeeFixture(),event=waste(f)
  await assert.rejects(()=>handler('b','reportPoop',{...f.auth(b),poopId:'fake'}),/实际存在/)
  await assert.rejects(()=>handler('c','reportPoop',{...f.auth(c),poopId:event.id}),/自己的宠物/)
  f.place('b',{x:100,z:100});await assert.rejects(()=>handler('b','reportPoop',{...f.auth(b),poopId:event.id}),/走近/)
  const other=await f.build('f',{x:280,z:280});await assert.rejects(()=>handler('f','reportPoop',{...f.auth(other),poopId:event.id}),/消失/)
  f.place('b',event);f.pet('c').waste[0].vehicleId='vehicle'
  await assert.rejects(()=>handler('b','reportPoop',{...f.auth(b),poopId:event.id}),/消失/)
  await assert.rejects(()=>handler('b','listDisputes',{sceneId:a.sceneId}),/场景已切换/)
  assert.equal((f.db.state.point_logs||[]).length,0)
})

test('weekly membership rewards require actual recent work and seven days, concurrent claims pay once',async()=>{
  const {f,a,b,handler}=await committeeFixture()
  await assert.rejects(()=>handler('a','claimWeeklySalary',f.auth(a)),/未满一周/)
  f.advance(7*86400000+1)
  await assert.rejects(()=>handler('a','claimWeeklySalary',f.auth(a)),/暂无已处理/)
  const event=waste(f)
  const report=await handler('b','reportPoop',{...f.auth(b),poopId:event.id})
  await handler('a','resolveDispute',{...f.auth(a),disputeId:report.disputeId})
  const claims=await Promise.allSettled([handler('a','claimWeeklySalary',f.auth(a)),handler('a','claimWeeklySalary',f.auth(a))])
  assert.equal(claims.filter((r)=>r.status==='fulfilled').length,1)
  assert.equal(claims.find((r)=>r.status==='fulfilled').value.salary,20)
  assert.equal(pointUser(f,'a').points,30);assert.equal(f.db.state.point_logs.filter((l)=>l.sourceType==='playground_weekly').length,1)
  f.advance(8*86400000)
  await assert.rejects(()=>handler('a','claimWeeklySalary',f.auth(a)),/暂无已处理/)
})

test('unresolved reports expire after three days and revoke the current committee',async()=>{
  const {f,a,b,handler}=await committeeFixture(),event=waste(f)
  await handler('b','reportPoop',{...f.auth(b),poopId:event.id})
  f.advance(73*3600000)
  const state=await handler('a','listDisputes',f.auth(a))
  assert.equal(state.isCommittee,false);assert.equal(state.disputes[0].status,'expired')
  assert.equal((await f.plots.own('a')).buildingType,'residential')
})

test('washing verifies scene, owner, proximity, shop and actual dirt before paying the shop owner once',async()=>{
  const f=fixture(),a=await f.build(),b=await f.build('b',{x:504,z:280}),handler=require('../../cloudfunctions/api/handlers/playground')(f.context)
  await f.drive('b',b)
  f.car('b').soiled=true;f.car('b').stains=[{id:'waste-1',type:'poop',createdAt:f.now()}]
  await assert.rejects(()=>handler('b','washVehicle',f.auth(b)),/洗车店/)
  await handler('a','buildInYard',{...f.auth(a),buildingId:'repair_shop_default'})
  await assert.rejects(()=>handler('b','washVehicle',f.auth(b)),/洗车店/)
  f.car('b').position={x:280,z:338};f.place('b',{x:280,z:338})
  await assert.rejects(()=>handler('a','washVehicle',{...f.auth(a),vehicleId:f.car('b')._id}),/只能清洗自己/)
  const washes=await Promise.all([handler('b','washVehicle',f.auth(b)),handler('b','washVehicle',f.auth(b))])
  assert.equal(washes.reduce((sum,r)=>sum+r.pointsReceived,0),10)
  assert.deepEqual(f.car('b').stains,[]);assert.equal(f.car('b').soiled,false)
  assert.equal(pointUser(f,'a').points,10);assert.equal(pointUser(f,'a').totalPoints,10)
  assert.equal(pointUser(f,'b').points,undefined);assert.equal(f.db.state.point_logs.length,1)
  f.car('b').soiled=true;f.car('b').stains=[{id:'waste-1',type:'poop',createdAt:f.now()}]
  assert.equal((await handler('b','washVehicle',f.auth(b))).pointsReceived,0)
  assert.equal(pointUser(f,'a').points,10)
})

test('admin zero point configurations disable report, resolve and weekly rewards',async()=>{
  const {f,a,b,handler}=await committeeFixture(),catalog=createBuildingsService(f.context),initial=await catalog.list()
  await catalog.save('admin',{revision:initial.revision,building:{...initial.buildings.find((x)=>x.type==='committee'),reportPoints:0,resolveReward:0,weeklySalary:0}})
  f.advance(7*86400000)
  const event=waste(f),report=await handler('b','reportPoop',{...f.auth(b),poopId:event.id})
  assert.equal(report.pointsReceived,0)
  assert.equal((await handler('a','resolveDispute',{...f.auth(a),disputeId:report.disputeId})).rewardReceived,0)
  assert.equal((await handler('a','claimWeeklySalary',f.auth(a))).salary,0)
  assert.equal((f.db.state.point_logs||[]).length,0)
})

test('membership controls new plots and canonical buildings without any token debit or forged parameters',async()=>{
  const f=fixture(),a=await f.build(),service=createBuildingsService(f.context)
  await f.db.collection('member_levels').doc('gold').set({data:{name:'金卡',minPoints:100}})
  const initial=await service.list(),clinic=initial.buildings.find((b)=>b.type==='pet_hospital')
  const saved=await service.save('admin',{revision:0,building:{...clinic,unlockLevelIds:['gold']}})
  await service.savePlotAccess('admin',{revision:saved.revision,size:64,unlockLevelIds:['gold']})
  await assert.rejects(()=>f.plots.buildInYard('a',f.user('a'),{plotId:a.plot.id,buildingId:clinic.id,unlocked:true}),/会员等级/)
  await assert.rejects(()=>f.plots.claim('a',f.user('a'),{x:504,z:280,size:64,isNewPlot:true,costCoins:0}),/会员等级/)
  await assert.rejects(()=>f.plots.claim('a',f.user('a'),{x:504,z:280,size:999,isNewPlot:true}),/无效的绿地规格/)
  await f.db.collection('users').doc('user_a').update({data:{memberLevel:'gold',points:100,totalPoints:100,playgroundCoins:8}})
  const yard=await f.plots.claim('a',f.user('a'),{x:504,z:280,size:64,isNewPlot:true,costCoins:999})
  const built=await f.plots.buildInYard('a',f.user('a'),{plotId:yard.id,buildingId:clinic.id,buildingName:'伪造',buildingType:'committee',buildingWidth:1,costCoins:999})
  assert.equal(built.buildingName,clinic.name);assert.equal(built.buildingWidth,clinic.width)
  assert.equal(built.buildingType,'pet_hospital');assert.equal(built.gateDirection,yard.gateDirection)
  assert.equal((await f.plots.own('a')).plotId,a.plot.id)
  assert.equal(pointUser(f,'a').points,100);assert.equal(pointUser(f,'a').playgroundCoins,8)
  await assert.rejects(()=>f.plots.buildInYard('b',f.user('b'),{plotId:yard.id,buildingId:'repair_shop_default'}),/只能在自己/)
  await assert.rejects(()=>service.remove('admin',{id:clinic.id,revision:0}),/其他管理员/)
})

test('construction preserves decorative plants and rejects a building footprint that would cover them',async()=>{
  const f=fixture(),a=await f.build(),yard=await f.plots.claim('a',f.user('a'),{x:504,z:280,size:48,isNewPlot:true})
  const tile=farmLayout(yard).slice().sort((a,b)=>Math.hypot(a.x-yard.x,a.z-yard.z)-Math.hypot(b.x-yard.x,b.z-yard.z))[0]
  f.place('a',tile);await f.farmAction('a',a,'convert',{plotId:yard.id,bedId:tile.id})
  await assert.rejects(()=>f.plots.buildInYard('a',f.user('a'),{plotId:yard.id,buildingId:'repair_shop_default'}),/占用已布置/)
  await f.farmAction('a',a,'lawn',{plotId:yard.id,bedId:tile.id})
  assert.equal((await f.plots.buildInYard('a',f.user('a'),{plotId:yard.id,buildingId:'repair_shop_default'})).buildingType,'repair_shop')
})

test('traffic dispute exceeding 3 days automatically revokes police station without refund', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const userA = f.user('a')
  f.db.state.users.find((u) => u.openid === 'a').playgroundCoins = 300

  // 1. a 建立督导所
  const a = await f.build('a')
  const sceneId = a.sceneId
  await f.plots.buildInYard('a', userA, {
    plotId: a.plot.id,
    buildingType: 'police_station',
    buildingName: '文明督导所',
    costCoins: 100
  })
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 300)

  // 2. 模拟一起交通事故举报（3天未处理，status 为 wanted）
  const accident = {
    _id: 'dispute_traffic_timeout',
    communityId: sceneId,
    victimType: 'human',
    victimName: '居民',
    victimOpenid: 'b',
    driverOpenid: 'c',
    driverName: '肇事司机',
    status: 'wanted',
    createdAt: f.now() - 73 * 3600 * 1000
  }
  await f.db.collection('pet_playground_accidents').add({ data: accident })

  // 3. 督导所超时弹劾检查
  const listRes = await handler('a', 'listAccidents', { sceneId })
  assert.equal(listRes.hasPoliceStation, false) // 督导所资格已被撤销收回
  assert.equal(listRes.accidents[0].status, 'expired')

  // 4. 检查督导所已被拆除恢复为普通住宅，且绝不退还爱心币！
  const ownPlot = await f.plots.own('a')
  assert.equal(ownPlot.buildingType, 'residential')
  assert.equal(ownPlot.buildingName, '住宅洋房')
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 300) // 100 币未退还！
})

test('pet automatically leaves facility and roams when thirst or hunger is satisfied', async () => {
  const f = fixture()
  const a = await f.build('a')
  const pet = f.pet('a')

  // 设置正在喝水状态，且水分回满至 99%
  pet.care = {
    type: 'drink',
    startsAt: f.now() - 10000,
    endsAt: f.now() + 60000
  }
  pet.hydration = 99
  pet.satiety = 100
  pet.energy = 100

  // 触发同步检查
  await f.sync('a', a)

  // 验证需求满足后 pet.care 自动清除，恢复自由漫游状态
  const updatedPet = f.pet('a')
  assert.equal(updatedPet.care, null)
})
