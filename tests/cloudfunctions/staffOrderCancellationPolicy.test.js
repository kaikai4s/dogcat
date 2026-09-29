const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createFixture() {
  const staffOpenid1 = 'openid_staff_1'
  const staffOpenid2 = 'openid_staff_2'
  const clientOpenid = 'openid_client_1'
  const adminOpenid = 'openid_admin_1'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_1', openid: staffOpenid1, roles: ['staff'], phone: '13800000001', realName: '张宠托', status: 'active', serviceLatitude: 31.2304, serviceLongitude: 121.4737 },
      { _id: 'u_staff_2', openid: staffOpenid2, roles: ['staff'], phone: '13800000002', realName: '王宠托', status: 'active', serviceLatitude: 31.2304, serviceLongitude: 121.4737 },
      { _id: 'u_client_1', openid: clientOpenid, roles: ['client'], phone: '13900000002', nickname: '李主人', status: 'active' },
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], realName: '平台管理员', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: staffOpenid1,
        realName: '张宠托',
        phone: '13800000001',
        status: 'approved',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        serviceLatitude: 31.2304,
        serviceLongitude: 121.4737,
        serviceAddress: '人民广场',
        serviceRadiusKm: 10,
        trainingScore: 100,
        videoAuditStatus: 'approved'
      },
      {
        _id: 'sp_2',
        openid: staffOpenid2,
        realName: '王宠托',
        phone: '13800000002',
        status: 'approved',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        serviceLatitude: 31.2304,
        serviceLongitude: 121.4737,
        serviceAddress: '人民广场',
        serviceRadiusKm: 10,
        trainingScore: 100,
        videoAuditStatus: 'approved'
      }
    ],
    pets: [
      { _id: 'pet_1', openid: clientOpenid, name: '大黄', species: 'dog' }
    ],
    system_settings: [
      {
        _id: 'default',
        staffDeposit: { requiredAmount: 0, gracePeriodDays: 30 },
        payment: { mode: 'mock' }
      }
    ],
    service_prices: [
      { serviceType: 'walk', basePrice: 50, enabled: true },
      { serviceType: 'visit_fee', basePrice: 10, enabled: true }
    ],
    orders: [],
    order_timeline: [],
    order_message_threads: [],
    order_messages: [],
    payment_events: [],
    refunds: [],
    staff_deposit_evidences: []
  })

  return { db, staffOpenid1, staffOpenid2, clientOpenid, adminOpenid }
}

test('Direct sitter booking: start time within 2 hours is rejected, >= 2 hours succeeds', async () => {
  const { db, clientOpenid } = createFixture()
  const clientApi = loadCloudFunction('api', db, clientOpenid)

  const now = Date.now()
  // 1. 尝试预约 1 小时后的服务（不足 2 小时） -> 应该被拒绝
  const timeWithin1h = new Date(now + 60 * 60 * 1000 + 8 * 3600 * 1000)
  const dateStr1 = `${timeWithin1h.getUTCFullYear()}-${String(timeWithin1h.getUTCMonth() + 1).padStart(2, '0')}-${String(timeWithin1h.getUTCDate()).padStart(2, '0')}`
  const startTimeStr1 = `${dateStr1} ${String(timeWithin1h.getUTCHours()).padStart(2, '0')}:${String(timeWithin1h.getUTCMinutes()).padStart(2, '0')}`
  const endTimeStr1 = `${dateStr1} ${String(Math.min(23, timeWithin1h.getUTCHours() + 1)).padStart(2, '0')}:${String(timeWithin1h.getUTCMinutes()).padStart(2, '0')}`

  const failRes = await clientApi.main({
    module: 'order',
    action: 'createOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '人民广场某小区',
      addressDetail: '1号楼101',
      doorplate: '101',
      addressLatitude: 31.2304,
      addressLongitude: 121.4737,
      startTime: startTimeStr1,
      endTime: endTimeStr1,
      orderType: 'single',
      startDate: dateStr1,
      lockMethod: 'someone_home'
    }
  })

  assert.equal(failRes.ok, false)
  assert.match(failRes.error, /2小时后/)

  // 2. 预约 3 小时后的服务（超过 2 小时） -> 应该成功
  const timeAfter3h = new Date(now + 3 * 3600 * 1000 + 8 * 3600 * 1000)
  const dateStr2 = `${timeAfter3h.getUTCFullYear()}-${String(timeAfter3h.getUTCMonth() + 1).padStart(2, '0')}-${String(timeAfter3h.getUTCDate()).padStart(2, '0')}`
  const startTimeStr2 = `${dateStr2} ${String(timeAfter3h.getUTCHours()).padStart(2, '0')}:${String(timeAfter3h.getUTCMinutes()).padStart(2, '0')}`
  const endTimeStr2 = `${dateStr2} ${String(Math.min(23, timeAfter3h.getUTCHours() + 1)).padStart(2, '0')}:${String(timeAfter3h.getUTCMinutes()).padStart(2, '0')}`

  const successRes = await clientApi.main({
    module: 'order',
    action: 'createOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '人民广场某小区',
      addressDetail: '1号楼101',
      doorplate: '101',
      addressLatitude: 31.2304,
      addressLongitude: 121.4737,
      startTime: startTimeStr2,
      endTime: endTimeStr2,
      orderType: 'single',
      startDate: dateStr2,
      lockMethod: 'someone_home'
    }
  })

  assert.equal(successRes.ok, true, successRes.error || '')
  assert.equal(successRes.data.publishMode, 'direct')
  assert.equal(successRes.data.requestedStaffProfileId, 'sp_1')
})

test('Open order cancellation: returns to public pool, cancelled staff cannot retake, another staff can take', async () => {
  const { db, staffOpenid1, staffOpenid2, clientOpenid } = createFixture()
  const staff1Api = loadCloudFunction('api', db, staffOpenid1)
  const staff2Api = loadCloudFunction('api', db, staffOpenid2)

  const futureStart = new Date(Date.now() + 3 * 3600 * 1000 + 8 * 3600 * 1000)
  const dateStr = `${futureStart.getUTCFullYear()}-${String(futureStart.getUTCMonth() + 1).padStart(2, '0')}-${String(futureStart.getUTCDate()).padStart(2, '0')}`
  const startTime = `${dateStr} ${String(futureStart.getUTCHours()).padStart(2, '0')}:00`
  const endTime = `${dateStr} ${String(futureStart.getUTCHours()).padStart(2, '0')}:30`

  // 1. 创建并支付一个公开抢单订单
  const orderId = 'order_open_test_1'
  db.state.orders.push({
    _id: orderId,
    orderNo: 'ORD_OPEN_001',
    clientOpenid,
    status: 'paid',
    paymentStatus: 'paid',
    payAmount: 60,
    publishMode: 'open',
    serviceAddress: '人民广场新村',
    serviceLatitude: 31.2304,
    serviceLongitude: 121.4737,
    addressLatitude: 31.2304,
    addressLongitude: 121.4737,
    startTime,
    endTime,
    serviceSessions: [{ index: 1, date: dateStr, startTime, endTime, status: 'pending' }],
    staffGenderRequirement: 'any',
    checkinRequirements: []
  })

  // 2. 宠托师1接单（抢单）
  const acceptRes1 = await staff1Api.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId,
      currentLatitude: 31.2304,
      currentLongitude: 121.4737
    }
  })
  assert.equal(acceptRes1.ok, true, acceptRes1.error || '')

  let order = db.state.orders.find(o => o._id === orderId)
  assert.equal(order.status, 'assigned')
  assert.equal(order.staffOpenid, staffOpenid1)

  // 3. 宠托师1获取取消报价并取消该订单
  const quoteRes = await staff1Api.main({
    module: 'staff',
    action: 'getStaffCancellationQuote',
    data: { orderId }
  })
  assert.equal(quoteRes.ok, true, quoteRes.error || '')
  assert.equal(quoteRes.data.canCancel, true)
  assert.equal(quoteRes.data.returnsToPool, true)

  const cancelRes = await staff1Api.main({
    module: 'staff',
    action: 'cancelStaffAcceptedOrder',
    data: {
      orderId,
      assignmentToken: quoteRes.data.assignmentToken,
      reason: '突发身体不适',
      requestId: 'req_cancel_1'
    }
  })
  assert.equal(cancelRes.ok, true, cancelRes.error || '')
  assert.equal(cancelRes.data.status, 'paid')
  assert.equal(cancelRes.data.returnsToPool, true)

  order = db.state.orders.find(o => o._id === orderId)
  assert.equal(order.status, 'paid')
  assert.equal(order.staffOpenid, '')
  assert.ok(Array.isArray(order.cancelledStaffOpenids))
  assert.ok(order.cancelledStaffOpenids.includes(staffOpenid1))

  // 4. 宠托师1尝试再次抢该单 -> 必须被拒绝！
  const retakeRes = await staff1Api.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId,
      currentLatitude: 31.2304,
      currentLongitude: 121.4737
    }
  })
  assert.equal(retakeRes.ok, false)
  assert.match(retakeRes.error, /此前已取消过该订单，无法再次抢单/)

  // 5. 宠托师1查看可接订单列表 -> 不包含该订单
  const listRes1 = await staff1Api.main({
    module: 'staff',
    action: 'listAvailableOrders',
    data: {}
  })
  assert.equal(listRes1.ok, true, listRes1.error || '')
  const hasOrderInList1 = (listRes1.data || []).some(o => o._id === orderId)
  assert.equal(hasOrderInList1, false)

  // 6. 宠托师2抢该单 -> 应该成功！
  const acceptRes2 = await staff2Api.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId,
      currentLatitude: 31.2304,
      currentLongitude: 121.4737
    }
  })
  assert.equal(acceptRes2.ok, true, acceptRes2.error || '')

  order = db.state.orders.find(o => o._id === orderId)
  assert.equal(order.status, 'assigned')
  assert.equal(order.staffOpenid, staffOpenid2)
})

test('Direct sitter cancellation: 10m grace period allows cancel & full refund, order does NOT return to pool', async () => {
  const { db, staffOpenid1, clientOpenid } = createFixture()
  const staff1Api = loadCloudFunction('api', db, staffOpenid1)

  const futureStart = new Date(Date.now() + 5 * 3600 * 1000 + 8 * 3600 * 1000)
  const dateStr = `${futureStart.getUTCFullYear()}-${String(futureStart.getUTCMonth() + 1).padStart(2, '0')}-${String(futureStart.getUTCDate()).padStart(2, '0')}`
  const startTime = `${dateStr} ${String(futureStart.getUTCHours()).padStart(2, '0')}:00`
  const endTime = `${dateStr} ${String(futureStart.getUTCHours()).padStart(2, '0')}:30`

  // 创建一个指定宠托师的已接单订单，指派时间为 3 分钟前（在 10 分钟免责容错时间内）
  const orderId = 'order_direct_test_1'
  const assignedAt = new Date(Date.now() - 3 * 60 * 1000)
  db.state.orders.push({
    _id: orderId,
    orderNo: 'ORD_DIRECT_001',
    clientOpenid,
    staffOpenid: staffOpenid1,
    staffUserId: 'u_staff_1',
    staffProfileId: 'sp_1',
    staffName: '张宠托',
    requestedStaffOpenid: staffOpenid1,
    requestedStaffProfileId: 'sp_1',
    requestedStaffName: '张宠托',
    status: 'assigned',
    paymentStatus: 'paid',
    payAmount: 100,
    publishMode: 'direct',
    assignmentSource: 'direct_accept',
    assignedAt,
    serviceAddress: '人民广场新村',
    serviceLatitude: 31.2304,
    serviceLongitude: 121.4737,
    startTime,
    endTime,
    serviceSessions: [{ index: 1, date: dateStr, startTime, endTime, status: 'pending' }],
    checkinRequirements: []
  })

  // 1. 获取取消报价
  const quoteRes = await staff1Api.main({
    module: 'staff',
    action: 'getStaffCancellationQuote',
    data: { orderId }
  })
  assert.equal(quoteRes.ok, true, quoteRes.error || '')
  assert.equal(quoteRes.data.canCancel, true)
  assert.equal(quoteRes.data.publishMode, 'direct')
  assert.equal(quoteRes.data.returnsToPool, false)
  assert.equal(quoteRes.data.refundAmount, 100)

  // 2. 执行免责取消
  const cancelRes = await staff1Api.main({
    module: 'staff',
    action: 'cancelStaffAcceptedOrder',
    data: {
      orderId,
      assignmentToken: quoteRes.data.assignmentToken,
      reason: '指定预约时间冲突无法接单',
      requestId: 'req_direct_cancel_1'
    }
  })
  assert.equal(cancelRes.ok, true, cancelRes.error || '')
  assert.equal(cancelRes.data.status, 'cancelled')
  assert.equal(cancelRes.data.returnsToPool, false)

  const order = db.state.orders.find(o => o._id === orderId)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.paymentStatus, 'refunding')
  assert.equal(order.staffOpenid, '')

  // 验证退款记录生成
  const refund = db.state.refunds.find(r => r.orderId === orderId)
  assert.ok(refund)
  assert.equal(refund.refundAmount, 100)

  // 3. 测试若超过 10 分钟（例如 20 分钟前接单） -> 禁止取消
  const orderIdLate = 'order_direct_test_late'
  const assignedAtLate = new Date(Date.now() - 20 * 60 * 1000)
  db.state.orders.push({
    _id: orderIdLate,
    orderNo: 'ORD_DIRECT_002',
    clientOpenid,
    staffOpenid: staffOpenid1,
    staffUserId: 'u_staff_1',
    staffProfileId: 'sp_1',
    requestedStaffOpenid: staffOpenid1,
    requestedStaffProfileId: 'sp_1',
    status: 'assigned',
    paymentStatus: 'paid',
    payAmount: 100,
    publishMode: 'direct',
    assignmentSource: 'direct_accept',
    assignedAt: assignedAtLate,
    startTime,
    endTime,
    serviceSessions: [{ index: 1, date: dateStr, startTime, endTime, status: 'pending' }],
    checkinRequirements: []
  })

  const quoteLateRes = await staff1Api.main({
    module: 'staff',
    action: 'getStaffCancellationQuote',
    data: { orderId: orderIdLate }
  })
  assert.equal(quoteLateRes.ok, true, quoteLateRes.error || '')
  assert.equal(quoteLateRes.data.canCancel, false)
  assert.match(quoteLateRes.data.ruleText, /10分钟/)

  const cancelLateRes = await staff1Api.main({
    module: 'staff',
    action: 'cancelStaffAcceptedOrder',
    data: {
      orderId: orderIdLate,
      assignmentToken: quoteLateRes.data.assignmentToken,
      reason: '超时取消',
      requestId: 'req_direct_late_cancel'
    }
  })
  assert.equal(cancelLateRes.ok, false)
  assert.match(cancelLateRes.error, /10分钟/)
})

test('cancellation closed loop: timeline logging and client cancel during on_the_way', async () => {
  const { db, staffOpenid1, staffOpenid2, clientOpenid } = createFixture()
  const staff1Api = loadCloudFunction('api', db, staffOpenid1)
  const clientApi = loadCloudFunction('api', db, clientOpenid)

  const dateStr = '2099-10-01'
  const startTime = `${dateStr} 15:00`
  const endTime = `${dateStr} 16:00`
  const orderId = 'order_timeline_cancel_1'

  // 创建一个处于 assigned 状态的公开订单
  const assignedAt = new Date(Date.now() - 5 * 60 * 1000)
  db.state.orders.push({
    _id: orderId,
    orderNo: 'ORD_TL_001',
    clientOpenid,
    staffOpenid: staffOpenid1,
    staffUserId: 'u_staff_1',
    staffProfileId: 'sp_1',
    staffName: '张宠托',
    status: 'assigned',
    paymentStatus: 'paid',
    payAmount: 80,
    publishMode: 'open',
    assignmentSource: 'open_grab',
    assignedAt,
    startTime,
    endTime,
    serviceSessions: [{ index: 1, date: dateStr, startTime, endTime, status: 'pending' }],
    checkinRequirements: []
  })

  // 1. 验证宠托师获取取消报价
  const quoteRes = await staff1Api.main({
    module: 'staff',
    action: 'getStaffCancellationQuote',
    data: { orderId }
  })
  assert.equal(quoteRes.ok, true, quoteRes.error || '')
  assert.equal(quoteRes.data.canCancel, true)
  assert.equal(quoteRes.data.returnsToPool, true)

  // 2. 宠托师执行取消
  const cancelRes = await staff1Api.main({
    module: 'staff',
    action: 'cancelStaffAcceptedOrder',
    data: {
      orderId,
      assignmentToken: quoteRes.data.assignmentToken,
      reason: '突发情况无法按时履约',
      requestId: 'req_tl_cancel_1'
    }
  })
  assert.equal(cancelRes.ok, true, cancelRes.error || '')
  assert.equal(cancelRes.data.returnsToPool, true)

  // 3. 验证订单回到 paid 状态并记录 cancelledStaffOpenids
  const updatedOrder = db.state.orders.find(o => o._id === orderId)
  assert.equal(updatedOrder.status, 'paid')
  assert.equal(updatedOrder.staffOpenid, '')
  assert.deepEqual(updatedOrder.cancelledStaffOpenids, [staffOpenid1])

  // 4. 验证 order_timeline 记录了取消节点
  const timelineItem = db.state.order_timeline.find(t => t.orderId === orderId && t.type === 'staff_cancellation')
  assert.ok(timelineItem, 'order_timeline must contain cancellation event')
  assert.match(timelineItem.title, /宠托师已取消接单/)
  assert.match(timelineItem.detail, /重新放回抢单大厅/)

  // 5. 验证宠托师在 on_the_way 状态下获取取消报价被安全拦截
  const otwOrderId = 'order_otw_staff_test'
  db.state.orders.push({
    _id: otwOrderId,
    orderNo: 'ORD_OTW_003',
    clientOpenid,
    staffOpenid: staffOpenid1,
    staffUserId: 'u_staff_1',
    status: 'on_the_way',
    paymentStatus: 'paid',
    assignedAt: new Date(Date.now() - 5 * 60 * 1000),
    startTime,
    endTime
  })
  const otwStaffQuote = await staff1Api.main({
    module: 'staff',
    action: 'getStaffCancellationQuote',
    data: { orderId: otwOrderId }
  })
  assert.equal(otwStaffQuote.ok, true)
  assert.equal(otwStaffQuote.data.canCancel, false)

  // 6. 验证客户在 on_the_way 状态下获取取消报价与退款试算允许取消
  const otwClientOrderId = 'order_otw_client_test'
  db.state.orders.push({
    _id: otwClientOrderId,
    orderNo: 'ORD_OTW_002',
    clientOpenid,
    staffOpenid: staffOpenid2,
    staffUserId: 'u_staff_2',
    status: 'on_the_way',
    paymentStatus: 'paid',
    payAmount: 100,
    startTime: '2099-10-02 18:00',
    serviceSessions: [{ index: 1, date: '2099-10-02', startTime: '2099-10-02 18:00', endTime: '2099-10-02 19:00', status: 'pending' }]
  })
  const clientQuote = await clientApi.main({
    module: 'order',
    action: 'getCancelQuote',
    data: { orderId: otwClientOrderId }
  })
  assert.equal(clientQuote.ok, true, clientQuote.error || '')
  assert.equal(clientQuote.data.canCancel, true)
})

