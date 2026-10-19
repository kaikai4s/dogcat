const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture } = require('../fixtures/playgroundLife')
const createBuildingsService = require('../../cloudfunctions/api/services/playground-buildings')
const { settleNeeds, treatPetHealth } = require('../../cloudfunctions/api/services/playground-shared/pet-needs')

test('buildings catalog includes police_station and prison facilities', async () => {
  const f = fixture()
  const buildingsService = createBuildingsService(f.context)
  const catalog = await buildingsService.list()
  const police = catalog.buildings.find((b) => b.type === 'police_station')
  const prison = catalog.buildings.find((b) => b.type === 'prison')

  assert.ok(police, 'catalog should have police_station')
  assert.equal(police.name, '文明督导所')
  assert.equal(police.costCoins, 0)

  assert.ok(prison, 'catalog should have prison')
  assert.equal(prison.name, '安全宣教自省室')
  assert.equal(prison.costCoins, 0)
})

test('pet becomes sick when satiety and hydration stay zero and hospital cures it', () => {
  const pet = {
    id: 'dog_1',
    name: '旺财',
    needs: {
      at: Date.now() - 3600 * 1000,
      satiety: 0,
      hydration: 0,
      energy: 50
    },
    vitality: 10,
    sick: false
  }

  // 计算需求时检测到双零饥渴严重匮乏，标记虚弱生病
  settleNeeds(pet, Date.now())
  assert.equal(pet.sick, true)
  assert.equal(pet.sickReason, 'hunger_thirst')

  // 医院接受治疗全面康复
  treatPetHealth(pet)
  assert.equal(pet.sick, false)
  assert.equal(pet.injured, false)
  assert.equal(pet.sickReason, '')
  assert.equal(pet.needs.satiety, 100)
  assert.equal(pet.needs.hydration, 100)
  assert.equal(pet.needs.energy, 100)
})

test('traffic accident reporting, police investigation and jail arrest workflow', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  // 1. 在场景中建造执法所与监狱
  await handler('a', 'buildInYard', {
    buildingType: 'police_station',
    buildingName: '阳光社区执法所',
    sceneId
  })

  // c 在空草坪圈地建造社区监狱
  await f.plots.claim('c', f.user('c'), {
    x: 400,
    z: 400,
    gateDirection: 'south',
    buildingType: 'prison',
    buildingName: '阳光社区第一监狱'
  })

  // 2. 发生交通事故：车撞人与车撞宠上报
  const humanHit = await handler('a', 'reportAccident', {
    sceneId,
    victimType: 'human',
    victimName: '张小帅',
    driverOpenid: 'd',
    driverName: '马路杀手小李',
    x: 250,
    z: 260
  })
  assert.equal(humanHit.reported, true)
  assert.equal(humanHit.record.status, 'wanted')

  const petHit = await handler('a', 'reportAccident', {
    sceneId,
    victimType: 'pet',
    victimName: '二哈',
    driverOpenid: 'd',
    driverName: '马路杀手小李',
    x: 270,
    z: 280
  })
  assert.equal(petHit.reported, true)

  // 3. 执法所查询案卷
  const caseList = await handler('a', 'listAccidents', { sceneId })
  assert.equal(caseList.hasPoliceStation, true)
  assert.equal(caseList.hasPrison, true)
  assert.equal(caseList.accidents.length, 2)
  assert.equal(caseList.isJailed, false)

  // 4. 警官实施逮捕肇事司机收押入狱
  const arrestRes = await handler('a', 'arrestDriver', {
    sceneId,
    accidentId: humanHit.accidentId
  })
  assert.equal(arrestRes.arrested, true)
  assert.equal(arrestRes.driverOpenid, 'd')
  assert.ok(arrestRes.jailedUntil > Date.now())

  // 5. 肇事司机查询自己状态，显示正在服刑
  const driverStatus = await handler('d', 'listAccidents', { sceneId })
  assert.equal(driverStatus.isJailed, true)
  assert.ok(driverStatus.jailRemainingSeconds > 0)

  // 6. 宣教自省期未满时尝试无安全公约金离开被拦截
  await assert.rejects(
    () => handler('d', 'releaseDriver', { payBail: false, sceneId }),
    /安全宣教自省期未满/
  )

  // 7. 缴纳安全公约金提前恢复通行
  const bailRes = await handler('d', 'releaseDriver', { payBail: true, sceneId })
  assert.equal(bailRes.released, true)
  assert.ok(bailRes.message.includes('安全公约金'))

  // 释放后再查询，不再服刑
  const releasedStatus = await handler('d', 'listAccidents', { sceneId })
  assert.equal(releasedStatus.isJailed, false)

  // 8. 医院治疗行人和宠物外伤
  const treatHuman = await handler('a', 'hospitalTreat', { target: 'human', sceneId })
  assert.equal(treatHuman.treated, true)
  assert.equal(treatHuman.target, 'human')

  const treatPet = await handler('a', 'hospitalTreat', { target: 'pet', sceneId })
  assert.equal(treatPet.treated, true)
  assert.equal(treatPet.target, 'pet')
})

test('cannot arrest if police station or prison is missing', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  const acc = await handler('a', 'reportAccident', {
    sceneId,
    victimType: 'human',
    victimName: '小王',
    driverOpenid: 'driver_c',
    driverName: '司机小王'
  })

  // 没有建文明督导所时安排自省报错
  await assert.rejects(
    () => handler('a', 'arrestDriver', { sceneId, accidentId: acc.accidentId }),
    /尚未设立文明督导所/
  )
})

test('concurrent poop pickup between different users consumes the ground event once', async () => {
  const f=fixture(),a=await f.build(),b=await f.build('b',{x:504,z:280})
  const world=require('../../cloudfunctions/api/services/playground-world'),position={x:280,z:338}
  const poopId='waste_'+world.hash('a')+'_'+world.hash('pet_a').slice(0,8)+'_'+f.now()
  f.pet('a').waste=[{id:poopId,type:'poop',...position,createdAt:f.now(),vehicleId:''}]
  f.place('a',position);f.place('b',position)
  const results=await Promise.allSettled([f.farmAction('a',a,'pickupPoop',{poopId}),f.farmAction('b',b,'pickupPoop',{poopId})])
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1)
  assert.equal(f.pet('a').waste.length,0)
  assert.equal(results.find((r)=>r.status==='fulfilled').value.manure,undefined)
})

test('arrest parks driver car and resets vehicle presence', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a', { x: 280, z: 280 })
  const sceneId = a.sceneId

  await handler('a', 'buildInYard', {
    buildingType: 'police_station',
    buildingName: '阳光社区执法所',
    sceneId
  })
  await f.plots.claim('c', f.user('c'), {
    x: 400,
    z: 400,
    gateDirection: 'south',
    buildingType: 'prison',
    buildingName: '阳光社区第一监狱'
  })

  // 司机 d 在独立坐标建房并开车
  const dScene = await f.build('d', { x: 520, z: 520 })
  await f.drive('d', dScene)
  const carBefore = f.car('d')
  assert.equal(carBefore.state, 'driving')

  const hit = await handler('a', 'reportAccident', {
    sceneId,
    victimType: 'human',
    victimName: '小刘',
    driverOpenid: 'd',
    driverName: '飙车司机'
  })

  // 警官实施逮捕
  await handler('a', 'arrestDriver', { sceneId, accidentId: hit.accidentId })

  // 司机的车辆已被重置为 parked，下车且停止开动
  const carAfter = f.car('d')
  assert.equal(carAfter.state, 'parked')
  assert.equal(carAfter.moving, false)
})

