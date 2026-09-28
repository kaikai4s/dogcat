const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createFixture() {
  const staffOpenid = 'openid_staff_1'
  const clientOpenid = 'openid_client_1'
  const adminOpenid = 'openid_admin_1'
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_1', openid: staffOpenid, roles: ['staff'], phone: '13800000001', realName: '张宠托', status: 'active' },
      { _id: 'u_client_1', openid: clientOpenid, roles: ['client'], phone: '13900000002', nickname: '李主人', status: 'active' },
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], realName: '平台管理员', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: staffOpenid, realName: '张宠托', phone: '13800000001' }
    ],
    orders: [
      {
        _id: 'order_transit_1',
        orderNo: 'ORD_TRANSIT_001',
        clientOpenid,
        clientUserId: 'u_client_1',
        staffOpenid,
        staffUserId: 'u_staff_1',
        status: 'assigned',
        paymentStatus: 'paid',
        serviceAddress: '测试小区1号楼',
        serviceLatitude: 31.2304,
        serviceLongitude: 121.4737, // 人民广场
        startTime: '2026-09-28 00:00:00',
        endTime: '2026-09-28 23:59:59',
        serviceSessions: [
          { index: 1, startTime: '2026-09-28 00:00:00', endTime: '2026-09-28 23:59:59', status: 'pending' }
        ],
        petName: '咪咪',
        serviceSummary: '上门喂养',
        serviceType: 'feed',
        checkinRequirements: [
          { eventType: 'sanitization', required: true, label: '进门消毒' },
          { eventType: 'feed', required: true, label: '添加粮食' }
        ]
      }
    ],
    order_timeline: [],
    order_message_threads: [],
    order_messages: [],
    order_session_messages: [],
    risk_bypass_logs: [],
    checkin_logs: []
  })
  return { db, staffOpenid, clientOpenid, adminOpenid }
}

test('ongoing chat returns the newest 100 messages chronologically after a long conversation', async () => {
  const { db, clientOpenid, staffOpenid } = createFixture()
  for (let i = 0; i < 120; i++) {
    await db.collection('order_session_messages').add({ data: {
      _id: `message_${String(i).padStart(3, '0')}`, orderId: 'order_transit_1', content: `消息${i}`,
      senderRole: i % 2 ? 'staff' : 'client', createdAt: new Date(1800000000000 + Math.floor(i / 2) * 1000)
    } })
  }
  for (const openid of [clientOpenid, staffOpenid]) {
    const api = loadCloudFunction('api', db, openid)
    const result = await api.main({ module: 'order', action: 'listOrderSessionMessages', data: { orderId: 'order_transit_1' } })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.data.length, 100)
    assert.equal(result.data[0]._id, 'message_020')
    assert.equal(result.data.at(-1)._id, 'message_119')
  }
})

test('Spatio-Temporal Radar: departForService transitions status to on_the_way and calculates ETA', async () => {
  const { db, staffOpenid } = createFixture()
  const api = loadCloudFunction('api', db, staffOpenid)

  // 宠托师出发：位置距离目的地约 2 公里
  // 经纬度：31.2304, 121.4937 (约 1.9 km)
  const res = await api.main({
    module: 'order',
    action: 'departForService',
    data: {
      orderId: 'order_transit_1',
      latitude: 31.2304,
      longitude: 121.4937
    }
  })

  assert.equal(res.ok, true, res.error || '')
  assert.equal(res.data.status, 'on_the_way')
  assert.ok(res.data.travelDistanceKm > 1.0)
  assert.ok(res.data.travelEtaMinutes > 0)

  const updatedOrder = db.state.orders.find(o => o._id === 'order_transit_1')
  assert.equal(updatedOrder.status, 'on_the_way')
  assert.equal(updatedOrder.travelDeparted, true)
})

test('Spatio-Temporal Radar: proximity trigger fires alert within 1km or 10min', async () => {
  const { db, staffOpenid } = createFixture()
  const api = loadCloudFunction('api', db, staffOpenid)

  // 宠托师出发并在距离目的地 0.5 公里处
  const res = await api.main({
    module: 'order',
    action: 'departForService',
    data: {
      orderId: 'order_transit_1',
      latitude: 31.2304,
      longitude: 121.4780 // 约 0.4 公里
    }
  })

  assert.equal(res.ok, true, res.error || '')
  assert.equal(res.data.radarProximityNotified, true)
  assert.ok(res.data.travelDistanceKm <= 1.0)

  // 检查客户端订单消息是否包含临近到家提醒
  const radarMsg = db.state.order_messages.find(m => m.eventType === 'radar_proximity')
  assert.ok(radarMsg)
  assert.match(radarMsg.title, /时空雷达/i)
  assert.match(radarMsg.detail, /预计10分钟后到达/i)
})

test('Privacy Call: returns masked numbers, virtual number and AI compliance warning', async () => {
  const { db, staffOpenid } = createFixture()
  const api = loadCloudFunction('api', db, staffOpenid)

  const res = await api.main({
    module: 'order',
    action: 'getPrivacyCallInfo',
    data: { orderId: 'order_transit_1' }
  })

  assert.equal(res.ok, true, res.error || '')
  assert.ok(res.data.privacyNumber)
  assert.match(res.data.maskedTargetPhone, /139\*{4}0002/)
  assert.match(res.data.warningNotice, /全程录音|风控质检|严禁私下/i)
})

test('Session IM anti-bypass: blocks phone numbers, WeChat, and logs risk violation', async () => {
  const { db, staffOpenid } = createFixture()
  const api = loadCloudFunction('api', db, staffOpenid)

  // 1. 发送合规消息 -> 成功
  const cleanRes = await api.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_transit_1',
      content: '您好，我已经出发在路上了，预计15分钟到达。'
    }
  })
  assert.equal(cleanRes.ok, true, cleanRes.error || '')
  assert.equal(cleanRes.data.content, '您好，我已经出发在路上了，预计15分钟到达。')

  // 2. 发送手机号 -> 被风控引擎拦截
  const phoneRes = await api.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_transit_1',
      content: '我电话是 138-1234-5678，方便的话加我下'
    }
  })
  assert.equal(phoneRes.ok, false)
  assert.match(phoneRes.error, /平台安全拦截|疑似微信号|手机号/i)

  // 3. 发送微信号/微信转账 -> 被拦截
  const wxRes = await api.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_transit_1',
      content: '加我微信号 wx_pet_sitter 给你发红包'
    }
  })
  assert.equal(wxRes.ok, false)
  assert.match(wxRes.error, /平台安全拦截|疑似微信号|手机号/i)

  // 4. 验证风控日志已被妥善存证
  assert.ok(db.state.risk_bypass_logs.length >= 2)
  const log = db.state.risk_bypass_logs[0]
  assert.equal(log.orderId, 'order_transit_1')
  assert.equal(log.senderRole, 'staff')
})

test('Live stream checkins: createCheckin writes live_checkin stream message to client', async () => {
  const { db, staffOpenid } = createFixture()
  const api = loadCloudFunction('api', db, staffOpenid)

  // 宠托师在 on_the_way 状态下完成进门消毒
  await db.collection('orders').doc('order_transit_1').update({
    data: { status: 'on_the_way' }
  })

  const timestamp = Date.now()
  const sanitizationRes = await api.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId: 'order_transit_1',
      eventType: 'sanitization',
      mediaFileId: `cloud://dogcat/sanitization/${timestamp}_sitter.jpg`,
      latitude: 31.2304,
      longitude: 121.4737,
      remark: '已佩戴口罩手套鞋套，工具消毒完毕'
    }
  })
  assert.equal(sanitizationRes.ok, true, sanitizationRes.error || '')

  // 检查客户端消息中是否收到现场动态 live_checkin
  const liveMsgs = db.state.order_messages.filter(m => m.eventType === 'live_checkin')
  assert.ok(liveMsgs.length >= 1)
  const latestLive = liveMsgs[liveMsgs.length - 1]
  assert.match(latestLive.title, /现场动态.*进门消毒/)
  assert.match(latestLive.detail, /已佩戴口罩手套鞋套/)
  assert.equal(latestLive.mediaFileId, `cloud://dogcat/sanitization/${timestamp}_sitter.jpg`)
})

test('Admin Order Detail: inspects client-staff session messages and anti-bypass risk logs', async () => {
  const { db, adminOpenid } = createFixture()
  const api = loadCloudFunction('api', db, adminOpenid)

  // 模拟写入会话消息与被拦截的风控日志
  await db.collection('order_session_messages').add({
    data: {
      orderId: 'order_transit_1',
      senderRole: 'client',
      senderOpenid: 'openid_client_1',
      content: '请问大概什么时候能到？猫咪在阳台晒太阳。',
      createdAt: new Date('2026-09-28T10:00:00Z')
    }
  })
  await db.collection('order_session_messages').add({
    data: {
      orderId: 'order_transit_1',
      senderRole: 'staff',
      senderOpenid: 'openid_staff_1',
      content: '路上有点微堵，预计15分钟左右到达！',
      createdAt: new Date('2026-09-28T10:02:00Z')
    }
  })
  await db.collection('risk_bypass_logs').add({
    data: {
      orderId: 'order_transit_1',
      senderRole: 'staff',
      senderOpenid: 'openid_staff_1',
      content: '加我微信号 wx_test 给你返现',
      riskReason: '包含疑似微信号导流关键词',
      createdAt: new Date('2026-09-28T10:03:00Z')
    }
  })

  // 1. 测试 admin.getOrderDetail 是否完整返回聊天与风控日志
  const detailRes = await api.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { orderId: 'order_transit_1' }
  })

  assert.equal(detailRes.ok, true, detailRes.error || '')
  assert.ok(detailRes.data.order)
  assert.equal(detailRes.data.sessionMessages.length, 2)
  assert.equal(detailRes.data.sessionMessages[0].content, '请问大概什么时候能到？猫咪在阳台晒太阳。')
  assert.equal(detailRes.data.sessionMessages[1].content, '路上有点微堵，预计15分钟左右到达！')
  assert.equal(detailRes.data.riskBypassLogs.length, 1)
  assert.equal(detailRes.data.riskBypassLogs[0].content, '加我微信号 wx_test 给你返现')

  // 2. 测试 admin.listOrderSessionMessages 单独查询/刷新
  const listRes = await api.main({
    module: 'admin',
    action: 'listOrderSessionMessages',
    data: { orderId: 'order_transit_1' }
  })
  assert.equal(listRes.ok, true, listRes.error || '')
  assert.equal(listRes.data.sessionMessages.length, 2)
  assert.equal(listRes.data.riskBypassLogs.length, 1)
  assert.equal(listRes.data.riskBypassLogs[0].senderRole, 'staff')
})

test('Session messaging: bidirectional sending, stranger blocking, and depart fallback without GPS', async () => {
  const { db, staffOpenid, clientOpenid } = createFixture()
  const staffApi = loadCloudFunction('api', db, staffOpenid)
  const clientApi = loadCloudFunction('api', db, clientOpenid)
  const strangerApi = loadCloudFunction('api', db, 'openid_stranger')

  // 1. 宠托师发送正常沟通消息
  const staffMsgRes = await staffApi.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_transit_1',
      content: '您好，我快到小区门口了，门铃是按哪个？'
    }
  })
  assert.equal(staffMsgRes.ok, true, staffMsgRes.error || '')
  assert.equal(staffMsgRes.data.senderRole, 'staff')

  // 2. 客户发送回复消息
  const clientMsgRes = await clientApi.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_transit_1',
      content: '门铃按 101# 就可以，我在阳台看着呢。'
    }
  })
  assert.equal(clientMsgRes.ok, true, clientMsgRes.error || '')
  assert.equal(clientMsgRes.data.senderRole, 'client')

  // 3. 陌生人/无关用户尝试发消息 -> 被拦截
  const strangerMsgRes = await strangerApi.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_transit_1',
      content: '我是路人'
    }
  })
  assert.equal(strangerMsgRes.ok, false)
  assert.match(strangerMsgRes.error, /无权/i)

  // 4. departForService 无经纬度降级出发（模拟器或未开GPS场景）
  const departNoGpsRes = await staffApi.main({
    module: 'order',
    action: 'departForService',
    data: {
      orderId: 'order_transit_1'
    }
  })
  assert.equal(departNoGpsRes.ok, true, departNoGpsRes.error || '')
  assert.equal(departNoGpsRes.data.status, 'on_the_way')
  assert.equal(departNoGpsRes.data.travelEtaMinutes, 15)
})

test('on_the_way orders: republishOrderAsUrgent succeeds, clears travel radar state, and resets to paid', async () => {
  const { db, adminOpenid, staffOpenid } = createFixture()
  const order = db.state.orders.find(o => o._id === 'order_transit_1')
  order.status = 'on_the_way'
  order.travelDeparted = true
  order.travelDepartedAt = new Date()
  order.travelEtaMinutes = 20
  order.radarProximityNotified = true

  const adminApi = loadCloudFunction('api', db, adminOpenid)

  const futureStart = new Date(Date.now() + 45 * 60 * 1000 + 8 * 3600 * 1000)
  const startTimeStr = `${futureStart.getUTCFullYear()}-${String(futureStart.getUTCMonth() + 1).padStart(2, '0')}-${String(futureStart.getUTCDate()).padStart(2, '0')} ${String(futureStart.getUTCHours()).padStart(2, '0')}:${String(futureStart.getUTCMinutes()).padStart(2, '0')}`
  const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000)
  const endTimeStr = `${futureEnd.getUTCFullYear()}-${String(futureEnd.getUTCMonth() + 1).padStart(2, '0')}-${String(futureEnd.getUTCDate()).padStart(2, '0')} ${String(futureEnd.getUTCHours()).padStart(2, '0')}:${String(futureEnd.getUTCMinutes()).padStart(2, '0')}`

  const res = await adminApi.main({
    module: 'admin',
    action: 'republishOrderAsUrgent',
    data: {
      orderId: 'order_transit_1',
      staffReward: 80,
      startTime: startTimeStr,
      endTime: endTimeStr,
      urgentRemark: '宠托师半路堵车，改发加急单'
    }
  })

  assert.equal(res.ok, true, res.error || '')
  assert.equal(res.data.isUrgent, true)
  assert.equal(res.data.staffReward, 80)

  const updatedOrder = db.state.orders.find(o => o._id === 'order_transit_1')
  assert.equal(updatedOrder.status, 'paid')
  assert.equal(updatedOrder.isUrgent, true)
  assert.equal(updatedOrder.travelDeparted, false)
  assert.equal(updatedOrder.travelDepartedAt, null)
  assert.equal(updatedOrder.travelLocation, null)
  assert.equal(updatedOrder.travelEtaMinutes, 0)
  assert.equal(updatedOrder.radarProximityNotified, false)
  assert.equal(updatedOrder.originalStaffOpenid, staffOpenid)
})

test('on_the_way orders: processOverdueUnstartedOrders detects overdue on_the_way and sends alerts', async () => {
  const { db, adminOpenid, staffOpenid } = createFixture()
  const order = db.state.orders.find(o => o._id === 'order_transit_1')
  order.status = 'on_the_way'
  order.travelDeparted = true
  // 设定约定开始时间为 40 分钟前
  const pastTime = new Date(Date.now() - 40 * 60 * 1000 + 8 * 3600 * 1000)
  const pastTimeStr = `${pastTime.getUTCFullYear()}-${String(pastTime.getUTCMonth() + 1).padStart(2, '0')}-${String(pastTime.getUTCDate()).padStart(2, '0')} ${String(pastTime.getUTCHours()).padStart(2, '0')}:${String(pastTime.getUTCMinutes()).padStart(2, '0')}`
  order.startTime = pastTimeStr
  order.serviceSessions[0].startTime = pastTimeStr

  const adminApi = loadCloudFunction('api', db, adminOpenid)

  // 触发超时巡检
  const overdueRes = await adminApi.main({
    module: 'order',
    action: 'checkOverdueOrders',
    data: {}
  })
  assert.equal(overdueRes.ok, true, overdueRes.error || '')

  const updatedOrder = db.state.orders.find(o => o._id === 'order_transit_1')
  assert.equal(updatedOrder.isStartOverdue, true)
  assert.ok(updatedOrder.staffOverdueStartRemindedSessions.includes(1))
  assert.ok(updatedOrder.clientOverdueStartAlertedSessions.includes(1))

  // 管理端查看待服务订单：包含 assigned 和 on_the_way
  const listRes = await adminApi.main({
    module: 'admin',
    action: 'listOrders',
    data: { status: 'assigned' }
  })
  assert.equal(listRes.ok, true, listRes.error || '')
  const found = (listRes.data.list || []).some(o => o._id === 'order_transit_1')
  assert.equal(found, true)
})

