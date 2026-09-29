const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('Risk 4: checkin photos and remarks undergo content security checks', async () => {
  const staffOpenid = 'openid_staff_checkin_sec'
  const clientOpenid = 'openid_client_checkin_sec'
  const orderId = 'order_checkin_sec'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_cs', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_cs', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_cs', openid: staffOpenid, auditStatus: 'approved' }
    ],
    orders: [
      {
        _id: orderId,
        clientOpenid,
        staffOpenid,
        status: 'in_service',
        serviceType: 'feed',
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        serviceLatitude: 31.23,
        serviceLongitude: 121.47
      }
    ],
    checkin_logs: []
  })

  const securityMock = {
    async msgSecCheck({ content }) {
      if (content.includes('违禁词') || content.includes('敏感内容')) {
        const error = new Error('risky content')
        error.errCode = 87014
        throw error
      }
      return { errCode: 0, result: { suggest: 'pass', label: 100 } }
    },
    async imgSecCheck({ media }) {
      if (media && media.value && media.value.toString().includes('bad-image')) {
        const error = new Error('risky image')
        error.errCode = 87014
        throw error
      }
      return { errCode: 0, result: { suggest: 'pass', label: 100 } }
    }
  }

  const staffApi = loadCloudFunction('api', db, staffOpenid, {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    })
  })

  // 1. 提交违规备注文字被拦截
  const badTextRes = await staffApi.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'feed',
      mediaFileId: 'cloud://normal_food.jpg',
      latitude: 31.2301,
      longitude: 121.4701,
      remark: '包含涉黄赌毒违禁词'
    }
  })
  assert.equal(badTextRes.ok, false)
  assert.match(badTextRes.error, /打卡备注包含敏感或不合规信息/)

  // 2. 提交违规图片被拦截
  const badImgRes = await staffApi.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'feed',
      mediaFileId: 'cloud://bad_image.jpg',
      latitude: 31.2301,
      longitude: 121.4701,
      remark: '正常备注'
    }
  })
  assert.equal(badImgRes.ok, false)
  assert.match(badImgRes.error, /服务打卡照片包含违规敏感内容/)

  // 2. 正常打卡图片与备注成功提交
  const goodRes = await staffApi.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'feed',
      mediaFileId: 'cloud://normal_food.jpg',
      latitude: 31.2301,
      longitude: 121.4701,
      remark: '猫咪粮食已添加，食欲良好'
    }
  })
  assert.equal(goodRes.ok, true, goodRes.message)
  assert.equal(goodRes.data.eventType, 'feed')
  assert.equal(goodRes.data.remark, '猫咪粮食已添加，食欲良好')
})

test('Risk 5: staff order limit protection blocks excess active orders and daily overload', async () => {
  const staffOpenid = 'openid_staff_limit_test'
  const newOrderId = 'order_new_grab'

  const activeOrders = Array.from({ length: 8 }, (_, i) => ({
    _id: `order_active_${i}`,
    staffOpenid,
    status: 'assigned',
    serviceStartDate: '2026-10-05',
    startTime: '2026-10-05 10:00:00'
  }))

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_lim', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active', gender: 'male' }
    ],
    staff_profiles: [
      {
        _id: 'sp_lim',
        openid: staffOpenid,
        auditStatus: 'approved',
        serviceLatitude: 31.23,
        serviceLongitude: 121.47,
        serviceAddress: '上海市人民广场',
        serviceRadiusKm: 10,
        staffLevel: 'certified',
        gender: 'male'
      }
    ],
    orders: [
      ...activeOrders,
      {
        _id: newOrderId,
        status: 'paid',
        paymentStatus: 'paid',
        publishMode: 'open',
        serviceLatitude: 31.23,
        serviceLongitude: 121.47,
        addressLatitude: 31.23,
        addressLongitude: 121.47,
        serviceStartDate: '2026-10-06',
        startTime: '2026-10-06 14:00:00',
        endTime: '2026-10-06 15:00:00',
        serviceSessions: [{ index: 1, startTime: '2026-10-06 14:00:00', endTime: '2026-10-06 15:00:00' }]
      }
    ]
  })

  const staffApi = loadCloudFunction('api', db, staffOpenid)

  // 1. 进行中订单达到 8 笔上限时抢单被熔断拦截
  const activeExceededRes = await staffApi.main({
    module: 'staff',
    action: 'acceptOrder',
    data: { orderId: newOrderId, currentLatitude: 31.23, currentLongitude: 121.47 }
  })
  assert.equal(activeExceededRes.ok, false)
  assert.match(activeExceededRes.error, /进行中订单已有 8 笔.*已达接单上限/)

  // 2. 清理其他日期的在途单，构造同一日期达到 6 笔上限的场景
  db.state.orders = db.state.orders.filter(o => o._id === newOrderId)
  for (let i = 0; i < 6; i++) {
    db.state.orders.push({
      _id: `order_sameday_${i}`,
      staffOpenid,
      status: 'completed',
      serviceStartDate: '2026-10-06',
      startTime: `2026-10-06 0${i + 8}:00:00`
    })
  }

  const dailyExceededRes = await staffApi.main({
    module: 'staff',
    action: 'acceptOrder',
    data: { orderId: newOrderId, currentLatitude: 31.23, currentLongitude: 121.47 }
  })
  assert.equal(dailyExceededRes.ok, false)
  assert.match(dailyExceededRes.error, /已达单日接单上限/)
})

test('Risk 7: direct order auto-acceptance handles off-schedule hours and falls back if sitter disqualified', async () => {
  const staffOpenid = 'openid_staff_auto_direct'
  const disqualifiedStaffOpenid = 'openid_staff_disqualified'
  const orderId1 = 'order_auto_direct_1'
  const orderId2 = 'order_auto_direct_disqualified'

  const pastPaidTime = new Date(Date.now() - 3700000).toISOString() // 超过 1 小时 (61 分钟前)
  const futureServiceTime = new Date(Date.now() + 48 * 3600000).toISOString()

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_ad', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active', gender: 'female' },
      { _id: 'u_staff_dq', openid: disqualifiedStaffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active', gender: 'female' }
    ],
    staff_profiles: [
      {
        _id: 'sp_ad',
        openid: staffOpenid,
        auditStatus: 'approved',
        staffLevel: 'certified',
        gender: 'female',
        weeklySchedule: { monday: ['09:00-11:00'] } // 只有早间排班
      },
      {
        _id: 'sp_dq',
        openid: disqualifiedStaffOpenid,
        auditStatus: 'revoked', // 资质已被撤销
        staffLevel: 'applicant',
        gender: 'female'
      }
    ],
    orders: [
      {
        _id: orderId1,
        publishMode: 'direct',
        requestedStaffOpenid: staffOpenid,
        requestedStaffProfileId: 'sp_ad',
        status: 'paid',
        paymentStatus: 'paid',
        paidAt: pastPaidTime,
        startTime: futureServiceTime,
        endTime: new Date(Date.now() + 49 * 3600000).toISOString(),
        serviceSessions: [{ index: 1, startTime: futureServiceTime, endTime: new Date(Date.now() + 49 * 3600000).toISOString() }]
      },
      {
        _id: orderId2,
        publishMode: 'direct',
        requestedStaffOpenid: disqualifiedStaffOpenid,
        requestedStaffProfileId: 'sp_dq',
        status: 'paid',
        paymentStatus: 'paid',
        paidAt: pastPaidTime,
        startTime: futureServiceTime,
        endTime: new Date(Date.now() + 49 * 3600000).toISOString(),
        serviceSessions: [{ index: 1, startTime: futureServiceTime, endTime: new Date(Date.now() + 49 * 3600000).toISOString() }]
      }
    ],
    order_timeline: [],
    order_client_messages: []
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin_test')

  // 触发定时任务接口：自动接单
  const staffApi = loadCloudFunction('api', db, staffOpenid)
  const listRes = await staffApi.main({ module: 'staff', action: 'listDirectOrders' })
  assert.equal(listRes.ok, true)

  // 1. orderId1 (正常宠托师跨常规排班) 超时1小时顺利被自动接单
  const order1 = db.state.orders.find(o => o._id === orderId1)
  assert.equal(order1.status, 'assigned')
  assert.equal(order1.staffOpenid, staffOpenid)
  assert.equal(order1.assignmentSource, 'direct_auto_accept')

  // 2. orderId2 (失信被撤销宠托师) 超时1小时自动转为公开订单，不被卡死
  const order2 = db.state.orders.find(o => o._id === orderId2)
  assert.equal(order2.status, 'paid')
  assert.equal(order2.publishMode, 'open')
  assert.equal(order2.requestedStaffOpenid, '')
})
