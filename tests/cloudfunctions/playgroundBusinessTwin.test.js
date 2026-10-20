const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createHandler = require('../../cloudfunctions/api/handlers/playground')
const { ownerId } = require('../../cloudfunctions/api/services/playground-world')

function createTestContext(dbState, openid = 'test_owner') {
  const db = createCollectionStore(dbState)
  const issuedCoupons = []
  const pointLogs = []

  const context = {
    db,
    getUser: async () => db.state.users.find((user) => user.openid === openid) || {
      _id: `u_${openid}`,
      openid,
      role: 'client',
      points: 100
    },
    safeText: (value) => String(value || '').trim(),
    nowText: () => '2026-10-20T11:00:00.000Z',
    addPoints: async (userOpenid, userId, delta, sourceType, refId, title, options = {}) => {
      pointLogs.push({ userOpenid, userId, delta, sourceType, refId, title, options })
      const u = db.state.users.find((user) => user.openid === userOpenid || user._id === userId)
      if (u) {
        u.points = (u.points || 0) + delta
      }
      return { duplicate: false, delta }
    },
    issueCouponToTargetUser: async (template, user, options = {}) => {
      issuedCoupons.push({ template, user, options })
      return { _id: `c_user_${Date.now()}`, templateId: template._id, status: 'unused' }
    }
  }

  return { db, handler: createHandler(context), openid, issuedCoupons, pointLogs, context }
}

test('方案1：getServiceTwinInfo 返回实时在途订单与打卡日记，打卡自动触发食盆同步', async () => {
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_test_owner', openid: 'test_owner', role: 'client' }],
    orders: [
      {
        _id: 'order_active_01',
        clientOpenid: 'test_owner',
        status: 'in_service',
        serviceSummary: '专业上门照料(1小时)',
        orderNo: 'ORD20261020001',
        staffSnapshot: { name: '金牌宠托师小李', avatarUrl: 'cloud://staff/avatar.jpg' },
        updatedAt: '2026-10-20T10:30:00.000Z'
      }
    ],
    checkin_logs: [
      {
        _id: 'checkin_01',
        orderId: 'order_active_01',
        eventType: 'food',
        mediaFileId: 'cloud://photos/food.jpg',
        checkinRemark: '已添满天然无谷猫粮与新鲜温水',
        createdAt: '2026-10-20T10:35:00.000Z'
      },
      {
        _id: 'checkin_02',
        orderId: 'order_active_01',
        eventType: 'play',
        mediaFileId: 'cloud://photos/play.jpg',
        checkinRemark: '猫咪非常活泼，玩逗猫棒玩得很开心',
        createdAt: '2026-10-20T10:45:00.000Z'
      }
    ],
    pet_playground_plots: [
      { _id: ownerId('test_owner'), kind: 'owner_plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48 }
    ]
  })

  const twinInfo = await handler(openid, 'getServiceTwinInfo', {})
  assert.equal(twinInfo.hasActiveService, true)
  assert.equal(twinInfo.activeOrder.orderNo, 'ORD20261020001')
  assert.equal(twinInfo.activeOrder.staffName, '金牌宠托师小李')
  assert.equal(twinInfo.latestCheckins.length, 2)
  assert.equal(twinInfo.bowlAutoRefilled, true)

  const overview = await handler(openid, 'getOverview', {})
  assert.ok(overview.activeService)
  assert.equal(overview.activeService.staffName, '金牌宠托师小李')
})

test('方案2：添粮打卡赠送关爱积分，getMallSupplies 返回在售商品与抵扣额', async () => {
  const { handler, openid, pointLogs } = createTestContext({
    users: [{ _id: 'u_test_owner', openid: 'test_owner', role: 'client', points: 10 }],
    mall_products: [
      {
        _id: 'prod_01',
        name: '全价无谷冻干双拼天然粮 2kg',
        price: 89,
        originalPrice: 109,
        status: 'on_sale',
        salesCount: 320,
        summary: '鲜肉高蛋白，呵护肠胃'
      }
    ],
    pet_playground_plots: [
      { _id: ownerId('test_owner'), kind: 'owner_plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48 }
    ]
  })

  const fillRes = await handler(openid, 'fillBowl', { plotId: 'mine' })
  assert.equal(fillRes.food, 100)
  assert.equal(fillRes.pointsAwarded, 5)
  assert.ok(fillRes.message.includes('获得每日关爱打卡 +5 积分'))
  assert.equal(pointLogs.length, 1)
  assert.equal(pointLogs[0].delta, 5)
  assert.equal(pointLogs[0].sourceType, 'playground_care')

  const mallRes = await handler(openid, 'getMallSupplies', {})
  assert.equal(mallRes.products.length, 1)
  assert.equal(mallRes.products[0].name, '全价无谷冻干双拼天然粮 2kg')
  assert.equal(mallRes.products[0].price, 89)
  assert.equal(mallRes.products[0].pointsDeduction, 8)
})

test('方案3：getCommunityGroupBuy 返回同小区拼单优惠与本小区常驻宠托师名片', async () => {
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_test_owner', openid: 'test_owner', role: 'client', residentialCommunity: '翠湖阳光花园' },{_id:'u_sitter',openid:'sitter_01',nickname:'张金牌',residentialCommunity:'翠湖阳光花园'}],
    staff_profiles: [
      {
        _id: 'staff_01', openid:'sitter_01', auditStatus:'approved',
        nickname: '张金牌',
        rating: 4.95,
        orderCount: 156,
        approved: true,
        isOnline: true,
        specialties: ['猫咪喂养', '上门遛狗', '健康观察']
      }
    ],
    pet_playground_plots: [
      { _id: ownerId('test_owner'), kind: 'owner_plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48 }
    ]
  })

  const groupBuyRes = await handler(openid, 'getCommunityGroupBuy', {})
  assert.equal(groupBuyRes.communityName, '翠湖阳光花园')
  assert.ok(groupBuyRes.groupBuyDiscount.includes('同小区拼单免路费'))
  assert.equal(groupBuyRes.sitters.length, 1)
  assert.equal(groupBuyRes.sitters[0].name, '张金牌')
  assert.equal(groupBuyRes.sitters[0].rating, '5.0')
})

test('方案5：关爱权益中心支持查看可用积分、会员等级并消耗积分兑换真实优惠券', async () => {
  const { handler, openid, issuedCoupons, db } = createTestContext({
    users: [{ _id: 'u_test_owner', openid: 'test_owner', role: 'client', points: 150, memberLevel: 'gold' }],
    member_levels: [
      { _id: 'gold', name: '黄金会员' }
    ],
    coupon_templates: [
      {
        _id: 'coupon_tpl_01',
        name: '上门宠托服务 10元立减券',
        discountAmount: 10,
        minSpend: 50,
        status: 'active',
        type: 'service'
      }
    ],
    pet_playground_plots: [
      { _id: ownerId('test_owner'), kind: 'owner_plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48 }
    ]
  })

  const rewards = await handler(openid, 'getPlaygroundRewards', {})
  assert.equal(rewards.points, 150)
  assert.equal(rewards.memberLevelName, '黄金会员')
  assert.equal(rewards.exchangeableCoupons.length, 1)
  assert.equal(rewards.exchangeableCoupons[0].requiredPoints, 100) // 10 * 10 = 100 积分

  // 兑换不存在或未启用的券应报错
  await assert.rejects(handler(openid, 'exchangeCoupon', { templateId: 'missing' }), /暂不可兑换/)

  // 成功兑换
  const exchangeRes = await handler(openid, 'exchangeCoupon', { templateId: 'coupon_tpl_01' })
  assert.equal(exchangeRes.success, true)
  assert.ok(exchangeRes.message.includes('成功消耗 100 积分兑换'))

  // 积分被扣减
  const userInDb = db.state.users.find((u) => u._id === 'u_test_owner')
  assert.equal(userInDb.points, 50)
  assert.equal(issuedCoupons.length, 1)
  assert.equal(issuedCoupons[0].template._id, 'coupon_tpl_01')

  // 积分不足再次兑换时被拒绝
  await assert.rejects(
    handler(openid, 'exchangeCoupon', { templateId: 'coupon_tpl_01' }),
    /积分不足，兑换该券需要 100 积分/
  )
})

test('local sitters beyond the global first page retain their public personalized names and ratings',async()=>{
  const staff_profiles=Array.from({length:105},(_,i)=>({_id:'staff_'+String(i).padStart(3,'0'),openid:'remote_'+i,auditStatus:'approved'}))
  staff_profiles.push({_id:'staff_999',openid:'local',auditStatus:'approved',ratingAverage:4.8,phone:'13800000000'})
  const {handler,openid,context}=createTestContext({
    users:[{_id:'owner',openid:'test_owner',residentialCommunity:'A小区'},{_id:'local_user',openid:'local',nickname:'昵称',residentialCommunity:'A小区'}],staff_profiles
  })
  context.toPublicSitter=()=>({displayName:'自定义公开名称',ratingAverage:4.8})
  const result=await handler(openid,'getCommunityGroupBuy',{})
  assert.equal(result.sitters.length,1)
  assert.equal(result.sitters[0].name,'自定义公开名称')
  assert.equal(result.sitters[0].rating,'4.8')
  assert.ok(!JSON.stringify(result.sitters).includes('13800000000'))
})
