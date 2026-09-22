const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb() {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '系统管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', nickname: '客户小李', phone: '13800002222', roles: ['client'], points: 100, totalPoints: 100, status: 'active' }
    ],
    member_levels: [
      { _id: 'lvl_1', name: '大众会员', minPoints: 0, pointMultiplier: 1 }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_service_walk',
        name: '遛狗专享立减20元',
        discountAmount: 20,
        minOrderAmount: 50,
        validType: 'relative_days',
        validDays: 30,
        usageScope: 'service',
        applicableServiceTypes: ['walk'],
        enabled: true,
        issuedCount: 0,
        sortOrder: 10
      },
      {
        _id: 'tmpl_universal',
        name: '全场通用30元券',
        discountAmount: 30,
        minOrderAmount: 60,
        validType: 'relative_days',
        validDays: 30,
        usageScope: 'all',
        applicableServiceTypes: [],
        enabled: true,
        issuedCount: 0,
        sortOrder: 20
      }
    ],
    service_prices: [
      { key: 'walk', label: '上门遛狗', price: 60, enabled: true, sortOrder: 1 },
      { key: 'cat_feed', label: '上门喂猫', price: 50, enabled: true, sortOrder: 2 }
    ],
    lottery_activities: [],
    lottery_records: [],
    user_coupons: [],
    point_logs: [],
    admin_operation_logs: []
  })
}

test('coupon: universal coupon is applicable to all services & service coupon is limited to configured services', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 管理员保存通用券，即使传入 applicableServiceTypes，也被自动规范为空，确保所有服务都可用
  const universalRes = await adminFn.main({
    module: 'admin',
    action: 'saveCouponTemplate',
    data: {
      name: '通用券测试',
      discountAmount: 20,
      minOrderAmount: 50,
      usageScope: 'all',
      applicableServiceTypes: ['walk']
    }
  })
  assert.equal(universalRes.ok, true)
  assert.deepEqual(universalRes.data.applicableServiceTypes, [], 'Universal coupon applicableServiceTypes must be empty array')

  // 2. 验证 coupons service 评估逻辑
  const couponsService = require('../../cloudfunctions/api/services/coupons')({
    db,
    now: () => new Date('2026-09-22T12:00:00.000Z'),
    safeText: (t) => String(t || '')
  })

  // 通用券在任何服务上都可用
  const universalCoupon = {
    _id: 'c_univ',
    openid: 'openid_client',
    status: 'available',
    templateSnapshot: {
      name: '通用券测试',
      discountAmount: 20,
      minOrderAmount: 50,
      usageScope: 'all',
      applicableServiceTypes: []
    }
  }
  const evalWalk = couponsService.evaluateCoupon(universalCoupon, { amount: 80, serviceTypes: ['walk'] }, 'openid_client')
  assert.equal(evalWalk.applicable, true, 'Universal coupon must be applicable for walk service')

  const evalCat = couponsService.evaluateCoupon(universalCoupon, { amount: 80, serviceTypes: ['cat_feed'] }, 'openid_client')
  assert.equal(evalCat.applicable, true, 'Universal coupon must be applicable for cat_feed service')

  // 服务券限制指定服务
  const serviceCoupon = {
    _id: 'c_srv',
    openid: 'openid_client',
    status: 'available',
    templateSnapshot: {
      name: '遛狗券',
      discountAmount: 20,
      minOrderAmount: 50,
      usageScope: 'service',
      applicableServiceTypes: ['walk']
    }
  }
  const evalSrvWalk = couponsService.evaluateCoupon(serviceCoupon, { amount: 80, serviceTypes: ['walk'] }, 'openid_client')
  assert.equal(evalSrvWalk.applicable, true, 'Service coupon must be applicable for matching walk service')

  const evalSrvCat = couponsService.evaluateCoupon(serviceCoupon, { amount: 80, serviceTypes: ['cat_feed'] }, 'openid_client')
  assert.equal(evalSrvCat.applicable, false, 'Service coupon must NOT be applicable for cat_feed')
  assert.equal(evalSrvCat.reason, '当前服务不可用')
})

test('lottery: admin can create activity with text (no-prize), points, and coupon prizes with customized probabilities', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 管理员创建包含文字、积分、优惠券 3 类奖品的活动
  const saveRes = await adminFn.main({
    module: 'admin',
    action: 'saveLotteryActivity',
    data: {
      name: '中秋多重大礼抽奖',
      description: '赢取积分、优惠券与神秘好礼',
      enabled: true,
      prizes: [
        {
          type: 'text',
          name: '谢谢参与',
          text: '谢谢参与，祝您下次好运',
          probability: 40,
          stockLeft: 9999
        },
        {
          type: 'points',
          name: '50 积分奖励',
          points: 50,
          probability: 30,
          stockLeft: 100
        },
        {
          type: 'coupon',
          name: '全场通用30元券',
          templateId: 'tmpl_universal',
          probability: 30,
          stockLeft: 100
        }
      ]
    }
  })

  assert.equal(saveRes.ok, true)
  assert.equal(saveRes.data.name, '中秋多重大礼抽奖')
  assert.equal(saveRes.data.prizes.length, 3)

  const textPrize = saveRes.data.prizes.find((p) => p.type === 'text')
  assert.ok(textPrize)
  assert.equal(textPrize.text, '谢谢参与，祝您下次好运')
  assert.equal(textPrize.probability, 40)

  const pointsPrize = saveRes.data.prizes.find((p) => p.type === 'points')
  assert.ok(pointsPrize)
  assert.equal(pointsPrize.points, 50)
  assert.equal(pointsPrize.probability, 30)

  const couponPrize = saveRes.data.prizes.find((p) => p.type === 'coupon')
  assert.ok(couponPrize)
  assert.equal(couponPrize.templateId, 'tmpl_universal')
  assert.equal(couponPrize.probability, 30)
})

test('lottery draw: winning points automatically adds points to user and records point_logs with activity detail', async () => {
  const db = createTestDb()
  // 配置仅能抽中积分的活动以准确验证积分发放流水
  db.state.lottery_activities.push({
    _id: 'act_points_only',
    name: '每日积分大派送',
    enabled: true,
    prizes: [
      {
        type: 'points',
        name: '88 积分',
        points: 88,
        probability: 100,
        stockLeft: 50
      }
    ],
    createdAt: '2026-09-22 10:00:00'
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const drawRes = await clientFn.main({
    module: 'lottery',
    action: 'draw'
  })

  assert.equal(drawRes.ok, true)
  assert.equal(drawRes.data.prizeType, 'points')
  assert.equal(drawRes.data.points, 88)
  assert.equal(drawRes.data.prizeName, '88 积分')

  // 验证用户积分自动增加
  const user = db.state.users.find((u) => u.openid === 'openid_client')
  assert.equal(user.points, 100 + 88, 'User points must increase by 88')
  assert.equal(user.totalPoints, 100 + 88, 'User totalPoints must increase by 88')

  // 验证 point_logs 详细流水记录
  const log = db.state.point_logs.find((l) => l.sourceType === 'lottery_reward')
  assert.ok(log, 'Must record point log with sourceType lottery_reward')
  assert.equal(log.delta, 88)
  assert.equal(log.balance, 188)
  assert.equal(log.sourceId, 'act_points_only')
  assert.ok(log.reason.includes('每日积分大派送'), 'Reason must mention lottery activity name')
  assert.ok(log.reason.includes('88 积分'), 'Reason must mention points count')

  // 验证抽奖记录 lottery_records
  const record = db.state.lottery_records.find((r) => r.openid === 'openid_client')
  assert.ok(record)
  assert.equal(record.prizeType, 'points')
  assert.equal(record.points, 88)
})

test('lottery draw: winning text prize awards no points or coupons, acting as a non-winning cheer text', async () => {
  const db = createTestDb()
  db.state.lottery_activities.push({
    _id: 'act_text_only',
    name: '幸运大转盘',
    enabled: true,
    prizes: [
      {
        type: 'text',
        name: '下次再来',
        text: '下次再来',
        probability: 100,
        stockLeft: 100
      }
    ],
    createdAt: '2026-09-22 10:00:00'
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const drawRes = await clientFn.main({
    module: 'lottery',
    action: 'draw'
  })

  assert.equal(drawRes.ok, true)
  assert.equal(drawRes.data.prizeType, 'text')
  assert.equal(drawRes.data.prizeName, '下次再来')
  assert.equal(drawRes.data.prizeText, '下次再来')
  assert.equal(drawRes.data.couponId, '')

  // 验证抽奖记录中持久化了 prizeText
  const record = db.state.lottery_records.find((r) => r.openid === 'openid_client')
  assert.ok(record)
  assert.equal(record.prizeText, '下次再来')

  // 验证 listMyRecords 接口返回了 prizeText
  const listRes = await clientFn.main({
    module: 'lottery',
    action: 'listMyRecords'
  })
  assert.equal(listRes.ok, true)
  assert.ok(listRes.data && listRes.data.length > 0)
  assert.equal(listRes.data[0].prizeText, '下次再来')

  // 验证用户积分没有改变，也没有发券
  const user = db.state.users.find((u) => u.openid === 'openid_client')
  assert.equal(user.points, 100)
  assert.equal(db.state.user_coupons.length, 0)
  assert.equal(db.state.point_logs.length, 0)
})

test('lottery client view: displays blessing text quotes in lottery records and modal', () => {
  const clientWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/lottery/index.wxml'), 'utf8')
  const clientJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/lottery/index.js'), 'utf8')
  const clientWxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/lottery/index.wxss'), 'utf8')

  // 验证抽奖记录和结果卡片展示祝福文案
  assert.ok(clientWxml.includes('record-blessing-content'), 'Client WXML must render record-blessing-content in record list')
  assert.ok(clientWxml.includes('item.prizeText'), 'Client WXML must bind item.prizeText')
  assert.ok(clientWxml.includes('result-blessing-box'), 'Client WXML must render result-blessing-box')

  // 验证 JS 中弹窗与标记
  assert.ok(clientJs.includes('wx.showModal'), 'Client JS must trigger wx.showModal for blessings')
  assert.ok(clientJs.includes('prizeTag = \'祝福\''), 'Client JS must tag text blessings with 祝福')

  // 验证样式类
  assert.ok(clientWxss.includes('.record-blessing-content'), 'Client WXSS must define .record-blessing-content')
  assert.ok(clientWxss.includes('.result-blessing-box'), 'Client WXSS must define .result-blessing-box')
})

test('frontend files: coupon and lottery wxml and js contain modal popup, servicePriceRows and multi-type prizes bindings', async () => {
  // 1. 验证 coupons 页面逻辑与模板
  const couponWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/coupons/index.wxml'), 'utf8')
  const couponJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/coupons/index.js'), 'utf8')

  assert.ok(couponWxml.includes('servicePriceRows'), 'Coupon WXML must render servicePriceRows')
  assert.ok(couponWxml.includes('item.selected'), 'Coupon WXML must bind item.selected to avoid .indexOf expression')
  assert.ok(couponWxml.includes('通用券对所有上门服务及宠物商城订单均可用'), 'Coupon WXML must explicitly note all-scope universal coupon availability')
  assert.ok(couponJs.includes('buildServicePriceRows'), 'Coupon JS must implement buildServicePriceRows')

  // 2. 验证 lottery 页面逻辑与模板
  const lotteryWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.wxml'), 'utf8')
  const lotteryJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.js'), 'utf8')

  assert.ok(lotteryWxml.includes('modal-mask'), 'Lottery WXML must have modal-mask popup container')
  assert.ok(lotteryWxml.includes('openCreateModal'), 'Lottery WXML must support openCreateModal')
  assert.ok(lotteryWxml.includes('openEditModal'), 'Lottery WXML must support openEditModal')
  assert.ok(lotteryWxml.includes('setPrizeType'), 'Lottery WXML must support selecting prize types')
  assert.ok(lotteryWxml.includes('积分奖品'), 'Lottery WXML must support points prize type')
  assert.ok(lotteryWxml.includes('文字 (未中奖)'), 'Lottery WXML must support text prize type')
  assert.ok(lotteryWxml.includes('优惠券'), 'Lottery WXML must support coupon prize type')

  assert.ok(lotteryJs.includes('openCreateModal'), 'Lottery JS must implement openCreateModal')
  assert.ok(lotteryJs.includes('openEditModal'), 'Lottery JS must implement openEditModal')
  assert.ok(lotteryJs.includes('calcTotalProbability'), 'Lottery JS must compute probability sum')
  assert.ok(lotteryJs.includes('type === \'points\''), 'Lottery JS must handle points prize type')
  assert.ok(lotteryJs.includes('type === \'text\''), 'Lottery JS must handle text prize type')
  assert.ok(lotteryJs.includes('type === \'coupon\''), 'Lottery JS must handle coupon prize type')
})

test('pet blessings library: provides rich dog and cat presets and can be chosen in lottery admin', () => {
  const { PET_BLESSINGS, getFormattedBlessingList, getRandomBlessing } = require('../../miniprogram/pages/admin/lottery/petBlessings')
  assert.ok(PET_BLESSINGS.length >= 25, 'Must provide at least 25 blessings')

  // 验证包含大金毛与财运祝福
  const goldenRetriever = PET_BLESSINGS.find((b) => b.breed.includes('金毛'))
  assert.ok(goldenRetriever, 'Must include golden retriever blessing')
  assert.ok(goldenRetriever.text.includes('大金毛') && goldenRetriever.text.includes('财运'), 'Golden retriever text must mention 大金毛 and 财运')

  // 验证包含多种猫咪品种
  const orangeCat = PET_BLESSINGS.find((b) => b.breed.includes('橘'))
  assert.ok(orangeCat, 'Must include orange cat')
  const ragdollCat = PET_BLESSINGS.find((b) => b.breed.includes('布偶'))
  assert.ok(ragdollCat, 'Must include ragdoll cat')

  // 验证包含多种狗狗品种
  const corgi = PET_BLESSINGS.find((b) => b.breed.includes('柯基'))
  assert.ok(corgi, 'Must include corgi')
  const husky = PET_BLESSINGS.find((b) => b.breed.includes('哈士奇'))
  assert.ok(husky, 'Must include husky')

  const list = getFormattedBlessingList()
  assert.equal(list.length, PET_BLESSINGS.length)
  assert.ok(list[0].label.includes('【'), 'Label must format with brackets')

  const random = getRandomBlessing()
  assert.ok(random && random.text, 'Random blessing must return valid item')

  // 验证 WXML & JS 绑定与避遮挡结构
  const lotteryWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.wxml'), 'utf8')
  const lotteryJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.js'), 'utf8')

  assert.ok(lotteryWxml.includes('choosePetBlessing'), 'WXML must bind choosePetBlessing')
  assert.ok(lotteryWxml.includes('pickRandomBlessing'), 'WXML must bind pickRandomBlessing')
  assert.ok(lotteryWxml.includes('modal-scroll-spacer'), 'WXML must have modal-scroll-spacer to avoid footer overlap')
  assert.ok(lotteryJs.includes('choosePetBlessing('), 'JS must implement choosePetBlessing')
  assert.ok(lotteryJs.includes('pickRandomBlessing('), 'JS must implement pickRandomBlessing')
})

