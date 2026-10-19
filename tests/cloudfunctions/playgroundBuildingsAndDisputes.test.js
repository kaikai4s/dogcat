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

