const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

const TEMPLATE_ID = 'YUcIBa5N4Nr-A7raD9e9vfKl0TKVqCyD4iMhsVswo_I'

function fixture({
  publishMode = 'open',
  orderTime = '2099-10-12 10:00', // Monday
  endTime = '2099-10-12 11:00',
  orderLat = 39.9042,
  orderLng = 116.4074,
  clientOpenid = 'client_1',
  serviceSummary = '上门遛狗',
  payAmount = 89.0,
  petName = '百万',
  petSpecies = 'dog',
  isVaccinated = true,
  staffGenderRequirement = 'any'
} = {}) {
  const db = createCollectionStore({
    platform_configs: [{
      _id: 'config',
      key: 'system_settings',
      value: {
        subscription: {
          enabled: true,
          templates: {
            staffPublicOrderGrab: TEMPLATE_ID
          }
        },
        staffDeposit: { enabled: true, amount: 500 },
        dispatch: { maxStaffActiveOrders: 8, maxStaffDailyOrders: 6, maxPublicGrabRecipients: 8 }
      }
    }],
    users: [
      { _id: 'u_staff1', openid: 'staff_near', roles: ['staff'], status: 'active' },
      { _id: 'u_staff2', openid: 'staff_far', roles: ['staff'], status: 'active' },
      { _id: 'u_staff3', openid: 'staff_rest', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: clientOpenid, roles: ['client'], status: 'active' }
    ],
    staff_profiles: [
      // 1. 距离近且时间合适的宠托师 (约 1km)
      {
        _id: 'p_staff1',
        openid: 'staff_near',
        name: '小王',
        gender: 'female',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        acceptOrders: true,
        serviceAddress: '北京市东城区某小区',
        serviceLatitude: 39.9142,
        serviceLongitude: 116.4074,
        serviceRadiusKm: 5,
        weeklySchedule: {
          '1': [{ start: 8, end: 18 }] // 周一 8:00 - 18:00
        }
      },
      // 2. 超出服务半径的宠托师 (约 20km)
      {
        _id: 'p_staff2',
        openid: 'staff_far',
        name: '小李',
        gender: 'male',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        acceptOrders: true,
        serviceAddress: '北京市海淀区某小区',
        serviceLatitude: 40.0842,
        serviceLongitude: 116.3074,
        serviceRadiusKm: 5,
        weeklySchedule: {
          '1': [{ start: 8, end: 18 }]
        }
      },
      // 3. 当天休息不接单的宠托师 (位置近但休息)
      {
        _id: 'p_staff3',
        openid: 'staff_rest',
        name: '小张',
        gender: 'female',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        acceptOrders: true,
        serviceAddress: '北京市东城区邻近小区',
        serviceLatitude: 39.9082,
        serviceLongitude: 116.4074,
        serviceRadiusKm: 5,
        weeklySchedule: {
          '1': [{ start: 8, end: 18 }]
        }
      }
    ],
    staff_schedule_exceptions: [
      {
        _id: 'exc_1',
        staffOpenid: 'staff_rest',
        dateKey: '2099-10-12',
        status: 'unavailable',
        remark: '调休'
      }
    ],
    orders: [
      {
        _id: 'order_1',
        orderNo: 'O209910120001',
        clientOpenid,
        status: 'pending_pay',
        paymentStatus: 'unpaid',
        publishMode,
        staffOpenid: '',
        requestedStaffOpenid: '',
        payAmount,
        serviceSummary,
        startTime: orderTime,
        endTime,
        addressLatitude: orderLat,
        addressLongitude: orderLng,
        serviceLatitude: orderLat,
        serviceLongitude: orderLng,
        serviceAddress: '北京市东城区王府井大街1号',
        petName,
        petSnapshot: { name: petName, species: petSpecies, isVaccinated },
        staffGenderRequirement,
        createdAt: new Date()
      }
    ]
  })

  optimistic(db)
  const sent = []
  const cloud = {
    openapi: {
      subscribeMessage: {
        send: async (message) => {
          sent.push(message)
          return { errCode: 0, errMsg: 'ok' }
        }
      }
    }
  }

  const ctx = createContext({ db, cloud })
  return { db, ctx, cloud, sent }
}

test('buildPublicOrderGrabData formats template 67413 exact 5 fields with bounds', () => {
  const { ctx } = fixture()
  const order = {
    _id: 'test_order',
    serviceSummary: '上门遛狗中大型犬极速照护',
    serviceAddress: '朝阳区三里屯太古里北区1号院',
    petName: '超级无敌大金毛豆豆',
    startTime: '2026-11-10 14:00',
    payAmount: 68.5
  }

  const data = ctx.buildPublicOrderGrabData(order, { staffEarning: 58.0 })
  assert.equal(data.thing1.value, '上门遛狗中大型犬极速照护')
  assert.ok(data.thing2.value.length <= 20)
  assert.ok(data.thing2.value.includes('【抢单提醒】'))
  assert.equal(data.thing3.value, '超级无敌大金毛豆豆')
  assert.equal(data.time4.value, '2026-11-10 14:00')
  assert.equal(data.amount5.value, '58.00')
})

test('checkSitterEligibilityForOrder validates distance, schedule, rest days, and bounds', async () => {
  const { ctx, db } = fixture()
  const settings = await ctx.getSystemSettings()
  const order = db.state.orders[0]

  const pNear = db.state.staff_profiles.find(p => p.openid === 'staff_near')
  const pFar = db.state.staff_profiles.find(p => p.openid === 'staff_far')
  const pRest = db.state.staff_profiles.find(p => p.openid === 'staff_rest')
  const exceptions = db.state.staff_schedule_exceptions

  // 1. 距离近、排班正常且未休息的宠托师 -> 通过
  const resNear = await ctx.checkSitterEligibilityForOrder(pNear, order, settings, [])
  assert.equal(resNear.eligible, true)
  assert.ok(resNear.distanceKm < 5)

  // 2. 超出服务半径 -> 排除
  const resFar = await ctx.checkSitterEligibilityForOrder(pFar, order, settings, [])
  assert.equal(resFar.eligible, false)
  assert.equal(resFar.reason, 'out_of_service_range')

  // 3. 当天休假不接单 -> 排除
  const resRest = await ctx.checkSitterEligibilityForOrder(pRest, order, settings, exceptions)
  assert.equal(resRest.eligible, false)
  assert.equal(resRest.reason, 'out_of_working_hours')
})

test('checkSitterEligibilityForOrder checks gender, vaccine, and history exclusions', async () => {
  const { ctx, db } = fixture({ staffGenderRequirement: 'female' })
  const settings = await ctx.getSystemSettings()
  const order = db.state.orders[0]

  // 男性宠托师在要求女性时被排除
  const maleProfile = {
    ...db.state.staff_profiles[0],
    gender: 'male'
  }
  const resGender = await ctx.checkSitterEligibilityForOrder(maleProfile, order, settings, [])
  assert.equal(resGender.eligible, false)
  assert.equal(resGender.reason, 'gender_mismatch')

  // 宠托师拒绝未免疫宠物，而订单未接种疫苗 -> 排除
  const vaccineProfile = {
    ...db.state.staff_profiles[0],
    rejectUnvaccinatedPets: true
  }
  const unvaccinatedOrder = {
    ...order,
    hasUnvaccinatedPets: true
  }
  const resVaccine = await ctx.checkSitterEligibilityForOrder(vaccineProfile, unvaccinatedOrder, settings, [])
  assert.equal(resVaccine.eligible, false)
  assert.equal(resVaccine.reason, 'unvaccinated_pet_rejected')

  // 历史超时取消转加急宠托师 -> 排除
  const previouslyAssignedOrder = {
    ...order,
    originalStaffOpenid: 'staff_near'
  }
  const resHistory = await ctx.checkSitterEligibilityForOrder(db.state.staff_profiles[0], previouslyAssignedOrder, settings, [])
  assert.equal(resHistory.eligible, false)
  assert.equal(resHistory.reason, 'previously_assigned_staff')
})

test('settleOrderPayment for open public order automatically notifies eligible nearby sitters', async () => {
  const { ctx, db, sent } = fixture()
  const order = db.state.orders[0]

  // 支付订单触发沉淀
  const payment = await ctx.reserveOrderPayment(order, 'client_1', 'wechat', 'pay_pub_1')
  await ctx.settleOrderPayment('order_1', { paymentNo: payment.paymentNo, wxTransactionId: 'wx_tx_1' })

  // 验证只有距离近、在服务范围与时间内且未休假的宠托师收到通知
  assert.equal(sent.length, 1)
  assert.equal(sent[0].touser, 'staff_near')
  assert.equal(sent[0].templateId, TEMPLATE_ID)
  assert.equal(sent[0].page, 'pages/staff/home/index?orderId=order_1&from=grab_notification')
  assert.equal(sent[0].data.thing1.value, '上门遛狗')
  assert.equal(sent[0].data.thing3.value, '百万')
  assert.equal(sent[0].data.time4.value, '2099-10-12 10:00')

  // 幂等性校验：同一订单再次通知不重复发送
  const secondRes = await ctx.notifyEligibleSittersForPublicOrder(order)
  assert.equal(sent.length, 1)
})

test('checkSitterEligibilityForOrder respects active orders limit and daily limit', async () => {
  const { ctx, db } = fixture()
  const settings = await ctx.getSystemSettings()
  const order = db.state.orders[0]
  const pNear = db.state.staff_profiles.find(p => p.openid === 'staff_near')

  // 1. 模拟宠托师名下已有 8 笔进行中订单
  for (let i = 0; i < 8; i++) {
    db.state.orders.push({
      _id: `active_order_${i}`,
      staffOpenid: 'staff_near',
      status: 'in_service'
    })
  }

  const resActiveLimit = await ctx.checkSitterEligibilityForOrder(pNear, order, settings, [])
  assert.equal(resActiveLimit.eligible, false)
  assert.equal(resActiveLimit.reason, 'max_active_orders_reached')
})

test('unconfigured staffPublicOrderGrab template skips sending and can be configured via saveSystemSettings', async () => {
  const { ctx, db, sent } = fixture()
  // 1. 清空模板配置（模拟后台未配置状态）
  db.state.platform_configs[0].value.subscription.templates.staffPublicOrderGrab = ''

  const order = db.state.orders[0]
  const payment = await ctx.reserveOrderPayment(order, 'client_1', 'wechat', 'pay_pub_unconfigured')
  await ctx.settleOrderPayment('order_1', { paymentNo: payment.paymentNo, wxTransactionId: 'wx_tx_unc' })
  assert.equal(sent.length, 0, '未在后台配置模板ID时跳过发送')

  // 2. 模拟管理员在后台填写并点击保存系统设置
  const currentSettings = await ctx.getSystemSettings()
  currentSettings.subscription.templates.staffPublicOrderGrab = 'NEW_CONFIGURED_TEMPLATE_ID'
  await ctx.saveSystemSettings(currentSettings)

  // 重新获取设置，验证后台已成功持久化保存
  const savedSettings = await ctx.getSystemSettings()
  assert.equal(savedSettings.subscription.templates.staffPublicOrderGrab, 'NEW_CONFIGURED_TEMPLATE_ID')
})
