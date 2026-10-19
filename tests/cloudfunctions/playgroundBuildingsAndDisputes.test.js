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
  assert.equal(repair.costCoins, 100)

  // 保存一个更大尺寸的建筑并验证草地格子换算 (10.5m x 10.5m = 110.25㎡ / 12.25 = 9 块草地)
  const saved = await service.save('admin', {
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
  assert.equal(custom.costCoins, 500)
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

test('poop reporting, committee dispute arbitration, fine and reward cycle', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  // a 担任居委会主任
  await handler('a', 'buildInYard', {
    buildingType: 'committee',
    buildingName: '阳光社区居委会',
    sceneId
  })

  // b 路人看见路上的便便发起举报
  const reportRes = await handler('b', 'reportPoop', {
    poopId: 'poop_123',
    x: 310,
    z: 320,
    sceneId
  })
  assert.equal(reportRes.reported, true)
  const disputeId = reportRes.disputeId

  // 防止对同一个便便重复举报
  await assert.rejects(
    () => handler('c', 'reportPoop', { poopId: 'poop_123', x: 310, z: 320, sceneId }),
    /该便便已被其他邻居举报/
  )

  // 居委会查看纠纷列表
  const listRes = await handler('a', 'listDisputes', { sceneId })
  assert.equal(listRes.isCommittee, true)
  assert.equal(listRes.disputes.length, 1)
  assert.equal(listRes.disputes[0]._id, disputeId)

  // 非居委会成员不能擅自上门调解
  await assert.rejects(
    () => handler('b', 'resolveDispute', { disputeId, sceneId }),
    /只有当前社区的在任居委会才能上门处理纠纷/
  )

  // 居委会主任 a 上门调解纠纷
  const resolveRes = await handler('a', 'resolveDispute', { disputeId, sceneId })
  assert.equal(resolveRes.resolved, true)
  assert.ok(resolveRes.rewardReceived > 0)

  // 再次查看列表，纠纷变为已解决
  const listAfter = await handler('a', 'listDisputes', { sceneId })
  assert.equal(listAfter.disputes[0].status, 'resolved')
})

test('committee automatically revoked after 3 days of unresolved dispute', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  // a 成为居委会
  await handler('a', 'buildInYard', {
    buildingType: 'committee',
    buildingName: '阳光社区居委会',
    sceneId
  })

  // b 举报便便
  const reportRes = await handler('b', 'reportPoop', {
    poopId: 'poop_unresolved',
    x: 350,
    z: 350,
    sceneId
  })
  const disputeId = reportRes.disputeId

  // 时间过去 3 天零 1 小时 (3 * 24 + 1 = 73 小时)
  f.advance(73 * 3600 * 1000)

  // 查询纠纷列表时自动触发 3 天未处理超时弹劾检查
  const listAfter = await handler('a', 'listDisputes', { sceneId })
  assert.equal(listAfter.disputes[0].status, 'expired')
  assert.equal(listAfter.isCommittee, false) // 居委会资格已收回

  // 居委会房屋已被收回，恢复为普通住宅
  const ownPlot = await f.plots.own('a')
  assert.equal(ownPlot.buildingType, 'residential')
  assert.equal(ownPlot.buildingName, '住宅洋房')
  assert.ok(ownPlot.name.includes('庭院'))
  assert.equal(ownPlot.committeeRevoked, true)
})

test('weekly salary claim succeeds after 7 days in committee', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  await handler('a', 'buildInYard', {
    buildingType: 'committee',
    buildingName: '阳光社区居委会',
    sceneId
  })

  // 刚当上居委会不满 7 天无法领取津贴
  await assert.rejects(
    () => handler('a', 'claimWeeklySalary', { sceneId }),
    /成功履职满一周/
  )

  // 任满 7 天 (7 * 24 小时)
  f.advance(7 * 24 * 3600 * 1000 + 1000)

  const salaryRes = await handler('a', 'claimWeeklySalary', { sceneId })
  assert.equal(salaryRes.claimed, true)
  assert.ok(salaryRes.salary >= 200)

  // 重复领取被拦截
  await assert.rejects(
    () => handler('a', 'claimWeeklySalary', { sceneId }),
    /成功履职满一周/
  )
})

test('repair shop washes car removing soiled state and hospital provides care', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  // 启动并上车，确保车辆已存在于场景数据库中
  await f.drive('a', a)
  const car = f.car('a')
  car.stains = [{ x: 0, y: 0, type: 'poop' }]
  car.soiled = true

  // 调用修理厂洗车
  const washRes = await handler('a', 'washVehicle', { sceneId })
  assert.equal(washRes.washed, true)
  const cleanedCar = f.car('a')
  assert.equal(cleanedCar.soiled, false)
  assert.deepEqual(cleanedCar.stains, [])

  // 车辆检修
  const repairRes = await handler('a', 'repairVehicle', { sceneId })
  assert.equal(repairRes.success, true)

  // 宠物医院专业洗护
  const washCare = await handler('a', 'hospitalCare', { careType: 'wash', sceneId })
  assert.equal(washCare.success, true)
  assert.ok(washCare.message.includes('洗护'))

  // 宠物医院健康体检与治疗
  const treatCare = await handler('a', 'hospitalCare', { careType: 'treat', sceneId })
  assert.equal(treatCare.success, true)
  assert.ok(treatCare.message.includes('治疗'))
})

test('neighbor using repair shop and pet hospital grants coins bonus to facility owners', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/playground')(f.context)
  const a = await f.build('a')
  const sceneId = a.sceneId

  // a 用户在庭院建造了修理厂
  await handler('a', 'buildInYard', {
    buildingType: 'repair_shop',
    buildingName: '阿强汽修厂',
    sceneId
  })

  // c 用户在庭院建造了宠物医院
  const c = await f.build('c', { x: 400, z: 400 })
  await handler('c', 'buildInYard', {
    buildingType: 'pet_hospital',
    buildingName: '爱心宠医',
    sceneId: c.sceneId
  })

  // 邻居 b 来到该社区
  const b = await f.build('b', { x: 504, z: 280 })
  await f.drive('b', b)
  const bCar = f.car('b')
  bCar.soiled = true
  bCar.stains = [{ x: 1, y: 1, type: 'dirt' }]

  // 初始 a 和 c 的金币
  const userA = f.db.state.users.find((u) => u.openid === 'a')
  const userC = f.db.state.users.find((u) => u.openid === 'c')
  const coinsBeforeA = userA.playgroundCoins || 0
  const coinsBeforeC = userC.playgroundCoins || 0

  // 1. 邻居 b 洗车，a 获得 10 爱心币
  const washRes = await handler('b', 'washVehicle', { sceneId })
  assert.equal(washRes.washed, true)
  assert.ok(washRes.message.includes('10 爱心币'))
  const userAAfterWash = f.db.state.users.find((u) => u.openid === 'a')
  assert.equal(userAAfterWash.playgroundCoins, coinsBeforeA + 10)

  // 2. 邻居 b 做宠物洗护，c 获得 15 爱心币
  const washCare = await handler('b', 'hospitalCare', { careType: 'wash', sceneId })
  assert.equal(washCare.success, true)
  assert.ok(washCare.message.includes('15 爱心币'))
  const userCAfterCare = f.db.state.users.find((u) => u.openid === 'c')
  assert.equal(userCAfterCare.playgroundCoins, coinsBeforeC + 15)
})

test('purchasing standalone new plot retains original villa intact and sets custom gate direction with fence', async () => {
  const f = fixture()
  const userA = f.user('a')
  const dbUserA = f.db.state.users.find((u) => u.openid === 'a')
  dbUserA.playgroundCoins = 100 // 赋予 100 爱心币

  // 1. 建造最初的家园别墅
  const originalVilla = await f.plots.claim('a', userA, {
    x: 280,
    z: 280,
    gateDirection: 'south'
  })
  assert.equal(originalVilla.x, 280)
  assert.equal(originalVilla.z, 280)
  assert.equal(originalVilla.gateDirection, 'south')

  // 2. 购买全新独立地块（围木栅栏，选择西门，消耗 50 爱心币）
  const newPlot = await f.plots.claim('a', userA, {
    x: 400,
    z: 280,
    isNewPlot: true,
    costCoins: 50,
    gateDirection: 'west',
    buildingType: 'garden',
    buildingName: '专属独立花园'
  })
  assert.equal(newPlot.x, 400)
  assert.equal(newPlot.z, 280)
  assert.equal(newPlot.gateDirection, 'west')
  assert.equal(newPlot.isNewPlot, true)

  // 3. 核心校验：用户原来的家园别墅必须完好无损保留在 (280, 280)，绝不能被挪动或删除！
  const ownPlot = await f.plots.own('a')
  assert.equal(ownPlot.x, 280)
  assert.equal(ownPlot.z, 280)
  assert.equal(ownPlot.gateDirection, 'south')
  assert.notEqual(ownPlot.id, newPlot.id)

  // 4. 校验爱心币正常扣减 (100 - 50 = 50)
  const updatedUserA = f.db.state.users.find((u) => u.openid === 'a')
  assert.equal(updatedUserA.playgroundCoins, 50)

  // 5. 校验新地皮防重叠机制：距离老别墅小于 116m 时不能重叠建造 (400 - 350 = 50 < 116)
  await assert.rejects(
    () =>
      f.plots.claim('a', userA, {
        x: 350,
        z: 280,
        isNewPlot: true,
        costCoins: 50,
        gateDirection: 'north'
      }),
    /地皮范围与已有建筑或邻居重叠/
  )

  // 6. 校验爱心币不足拦截：需要 80 但只剩 50
  await assert.rejects(
    () =>
      f.plots.claim('a', userA, {
        x: 560,
        z: 280,
        isNewPlot: true,
        costCoins: 80,
        gateDirection: 'north'
      }),
    /爱心币不足/
  )
})
test('standalone yard plot sizes pricing, decoupling houses into yard, and uniqueness constraints', async () => {
  const f = fixture()
  const userA = f.user('a')
  f.db.state.users.find((u) => u.openid === 'a').playgroundCoins = 500 // 赋予 500 爱心币

  // 1. 验证 config 接口正确输出地皮尺寸规格
  const worldCfg = await f.plots.config()
  assert.ok(Array.isArray(worldCfg.plotSizes))
  assert.equal(worldCfg.plotSizes.length, 4)
  assert.deepEqual(worldCfg.plotSizes.map((p) => p.size), [36, 48, 64, 80])

  // 2. a 购买最初住宅 (48m，自家庭院)
  const home = await f.plots.claim('a', userA, {
    x: 280,
    z: 280,
    gateDirection: 'south'
  })
  assert.equal(home.buildingType, 'residential')

  // 3. a 购买一块 64m 独立纯地皮 (草坪 + 围栏，消耗 80 爱心币)
  const yard64 = await f.plots.claim('a', userA, {
    x: 480,
    z: 280,
    size: 64,
    isNewPlot: true,
    gateDirection: 'east'
  })
  assert.equal(yard64.size, 64)
  assert.equal(yard64.buildingType, 'yard') // 纯地皮草坪
  assert.equal(yard64.gateDirection, 'east')
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 420) // 500 - 80 = 420

  // 4. 用户 b 尝试在 a 的地皮内建造单房建筑 -> 必须被拒绝拦截
  const userB = f.user('b')
  await assert.rejects(
    () =>
      f.plots.buildInYard('b', userB, {
        plotId: yard64.id,
        buildingType: 'pet_hospital',
        buildingName: '爱心宠医',
        costCoins: 100
      }),
    /公共设施建筑只能在已认领的爱心绿地内部建造/
  )

  // 5. a 在自己的 64m 地皮内部建造文明督导所 (消耗 100 爱心币)
  const policeBuilding = await f.plots.buildInYard('a', userA, {
    plotId: yard64.id,
    buildingType: 'police_station',
    buildingName: '文明督导所',
    costCoins: 100
  })
  assert.equal(policeBuilding.buildingType, 'police_station')
  assert.equal(policeBuilding.size, 64) // 地皮尺寸保留
  assert.equal(policeBuilding.gateDirection, 'east') // 原栅栏门方向保留
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 320) // 420 - 100 = 320

  // 6. 重复在同社区建立文明督导所 -> 触发唯一性拦截
  await assert.rejects(
    () =>
      f.plots.buildInYard('a', userA, {
        plotId: home.id,
        buildingType: 'police_station',
        buildingName: '第二督导所'
      }),
    /当前社区已设立文明督导所，每个社区有且仅能有一个文明督导所/
  )

  // 7. a 在自己的家园地皮内部建造安全宣教自省室
  await f.plots.buildInYard('a', userA, {
    plotId: home.id,
    buildingType: 'prison',
    buildingName: '安全宣教自省室',
    costCoins: 50
  })
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 270) // 320 - 50 = 270

  // 重复在同社区建立自省室 -> 触发唯一性拦截
  await assert.rejects(
    () =>
      f.plots.buildInYard('a', userA, {
        plotId: yard64.id,
        buildingType: 'prison',
        buildingName: '第二自省室'
      }),
    /当前社区已设立安全宣教自省室，每个社区有且仅能有一个自省室/
  )
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
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 200)

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
  assert.equal(f.db.state.users.find((u) => u.openid === 'a').playgroundCoins, 200) // 100 币未退还！
})

test('crops are completely free to plant and seeds are free in shop', async () => {
  const f = fixture()
  const a = await f.build('a')

  // 1. 免费领取种子铺里的胡萝卜种子（初始资金 120 金币，购买 5 个种子不扣除任何金币）
  const buyRes = await f.farmAction('a', a, 'buySeeds', { cropId: 'carrot', quantity: 5 })
  assert.equal(buyRes.coins, 120) // 保持 120 金币，不扣币！
  assert.equal(buyRes.seeds.carrot, 17) // 初始自带 12 + 领取的 5 = 17

  // 2. 走到田地旁，耕地并免费播种
  const { farmLayout } = require('../../cloudfunctions/api/services/playground-shared/farm-model')
  const tile = farmLayout(a.plot)[0]
  f.place('a', tile)
  await f.farmAction('a', a, 'till', { bedId: 0 })
  const plantRes = await f.farmAction('a', a, 'plant', { bedId: 0, cropId: 'carrot' })
  assert.equal(plantRes.beds[0].cropId, 'carrot')
  assert.equal(plantRes.beds[0].name, '胡萝卜')
  assert.equal(plantRes.coins, 110) // 耕地消耗 10 基础体力/金币，而播种胡萝卜免费（0币）！
  assert.equal(plantRes.seeds.carrot, 16) // 17 - 1 = 16 粒种子
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
