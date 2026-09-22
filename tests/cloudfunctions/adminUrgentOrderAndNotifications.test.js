const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('processOverdueUnstartedOrders notifies admins when order start is overdue by 30 minutes', async () => {
  const now = new Date()
  const pastMs = now.getTime() - 40 * 60 * 1000
  const pastDate = new Date(pastMs)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(pastDate)
  const getPart = (type) => parts.find((p) => p.type === type).value
  const startTime = `${getPart('year')}-${getPart('month')}-${getPart('day')} ${getPart('hour')}:${getPart('minute')}`

  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'openid_staff', roles: ['staff'], status: 'active', name: '张托师', phone: '13900001111' },
      { _id: 'client_1', openid: 'openid_client', roles: ['client'], status: 'active', name: '李客户', phone: '13800002222' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_staff', name: '张托师', phone: '13900001111' }
    ],
    orders: [
      {
        _id: 'order_1',
        orderNo: 'O20260922001',
        serviceType: 'walk',
        serviceSummary: '上门遛狗服务',
        petName: '毛球',
        status: 'assigned',
        staffOpenid: 'openid_staff',
        staffProfileId: 'sp_1',
        clientOpenid: 'openid_client',
        startTime,
        endTime: '2026-09-22 19:00',
        payAmount: 60
      }
    ],
    admin_notifications: [],
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: []
  })

  const timerFn = loadCloudFunction('api', db, '')
  // 运行定时任务
  const scheduledResult = await timerFn.main({ Type: 'Timer' })
  assert.equal(scheduledResult.ok, true)

  // 验证 admin_notifications 中是否写入了超时 30 分钟未开始预警
  const notifications = db.state.admin_notifications || []
  assert.equal(notifications.length >= 1, true)

  const overdueNotice = notifications.find((n) => n.type === 'order_start_overdue')
  assert.ok(overdueNotice, 'Must generate order_start_overdue notification')
  assert.equal(overdueNotice.level, 'urgent')
  assert.equal(overdueNotice.orderId, 'order_1')
  assert.ok(overdueNotice.content.includes('超时 30 分钟'))
  assert.ok(overdueNotice.actionUrl.includes('order_1'))
})

test('admin can republish order as urgent with adjusted reward, modified time & remark, preserving client payAmount', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'openid_staff', roles: ['staff'], status: 'active', name: '张托师', phone: '13900001111' },
      { _id: 'staff_2', openid: 'openid_staff_2', roles: ['staff'], status: 'active', name: '李托师', phone: '13900002222' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_staff', name: '张托师', phone: '13900001111' },
      { _id: 'sp_2', openid: 'openid_staff_2', name: '李托师', phone: '13900002222', serviceLatitude: 31.2, serviceLongitude: 121.5, serviceAddress: '浦东', serviceRadiusKm: 10, auditStatus: 'approved' }
    ],
    orders: [
      {
        _id: 'order_urgent_1',
        orderNo: 'O20260922002',
        serviceType: 'walk',
        serviceSummary: '上门遛狗服务',
        petName: '豆豆',
        status: 'assigned',
        staffOpenid: 'openid_staff',
        staffProfileId: 'sp_1',
        clientOpenid: 'openid_client',
        startTime: '2026-09-22 14:00',
        endTime: '2026-09-22 15:00',
        payAmount: 60, // 客户实付60元
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        addressLatitude: 31.2,
        addressLongitude: 121.5
      }
    ],
    admin_notifications: [],
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    admin_operation_logs: [],
    platform_configs: [
      {
        _id: 'system_settings',
        settlement: { staffCommissionRate: 0.7, settlementDelayDays: 0 }
      }
    ]
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 管理员将该单重新发布为加急公共抢单：宠托师收益设定为 85 元（加价 43 元），开始时间调整为 15:00
  const republishRes = await adminFn.main({
    module: 'admin',
    action: 'republishOrderAsUrgent',
    data: {
      orderId: 'order_urgent_1',
      staffReward: 85,
      startTime: '2026-09-22 15:00',
      endTime: '2026-09-22 16:00',
      urgentRemark: '原宠托师突发状况无法履约，平台加价补贴，请尽快接单'
    }
  })

  assert.equal(republishRes.ok, true)
  assert.equal(republishRes.data.isUrgent, true)
  assert.equal(republishRes.data.status, 'paid')
  assert.equal(republishRes.data.staffReward, 85)

  // 检查数据库中订单状态
  const orderInDb = db.state.orders.find((o) => o._id === 'order_urgent_1')
  assert.equal(orderInDb.status, 'paid')
  assert.equal(orderInDb.isUrgent, true)
  assert.equal(orderInDb.urgentStaffReward, 85)
  assert.equal(orderInDb.staffOpenid, '', 'Must unbind original staff')
  assert.equal(orderInDb.startTime, '2026-09-22 15:00')
  assert.equal(orderInDb.payAmount, 60, 'Client payAmount must NEVER change')

  assert.equal(orderInDb.originalStaffOpenid, 'openid_staff', 'Must retain original staff openid')
  assert.equal(orderInDb.hasReassignedStaff, true)
  assert.equal(orderInDb.previousStaffRecords.length, 1)
  assert.equal(orderInDb.previousStaffRecords[0].staffOpenid, 'openid_staff')

  // 验证原宠托师收到取消履约消息
  const staffMsgs = db.state.order_staff_messages || []
  const cancelMsg = staffMsgs.find((m) => m.eventType === 'order_cancelled_by_admin')
  assert.ok(cancelMsg, 'Must send unbind notification to original staff')

  // 验证加急公共单隔离展示：
  // 1. 普通抢单列表不会出现该加急单
  const staffFn = loadCloudFunction('api', db, 'openid_staff_2')
  const nearbyRes = await staffFn.main({
    module: 'staff',
    action: 'listNearbyOrders',
    data: { latitude: 31.2, longitude: 121.5 }
  })
  assert.equal(nearbyRes.ok, true)
  const foundInNormal = (nearbyRes.data || []).some((o) => o._id === 'order_urgent_1')
  assert.equal(foundInNormal, false, 'Urgent order must NOT appear in normal nearby orders')

  // 2. 加急公共单列表可以查询到该单，且收益为 85 元
  const urgentRes = await staffFn.main({
    module: 'staff',
    action: 'listUrgentOrders',
    data: { latitude: 31.2, longitude: 121.5 }
  })
  assert.equal(urgentRes.ok, true)
  const foundInUrgent = (urgentRes.data || []).find((o) => o._id === 'order_urgent_1')
  assert.ok(foundInUrgent, 'Must appear in urgent orders')
  assert.equal(foundInUrgent.staffEarning, 85)

  // 3. 管理员端系统通知：验证转加急派单已向管理员生成系统通知
  const urgentAdminNotice = (db.state.admin_notifications || []).find((n) => n.type === 'order_urgent_republished')
  assert.ok(urgentAdminNotice, 'Must generate order_urgent_republished admin notification')

  const markRes = await adminFn.main({
    module: 'admin',
    action: 'markAdminNotificationRead',
    data: { all: true }
  })
  assert.equal(markRes.ok, true)

  // 4. 新宠托师接单
  const acceptRes = await staffFn.main({
    module: 'staff',
    action: 'acceptOrder',
    data: { orderId: 'order_urgent_1', currentLatitude: 31.2, currentLongitude: 121.5 }
  })
  assert.equal(acceptRes.ok, true)
  assert.equal(acceptRes.data.status, 'assigned')

  // 5. 收益结算：验证加急单结算时，按调整后的 85 元发放
  const createContext = require('../../cloudfunctions/api/services/context')
  const ctx = createContext({ cloud: {}, db })
  const updatedOrder = (await db.collection('orders').doc('order_urgent_1').get()).data
  assert.equal(updatedOrder.staffOpenid, 'openid_staff_2')
  const earning = await ctx.ensureStaffEarning(updatedOrder)
  assert.equal(earning.amount, 85, 'Staff earning must equal urgentStaffReward of 85')
})

test('admin can record deposit penalty evidence on problematic order and see issue orders in sitter management', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'openid_staff_bad', roles: ['staff'], status: 'active', nickname: '失联托师', phone: '13911112222' }
    ],
    staff_profiles: [
      { _id: 'sp_bad', openid: 'openid_staff_bad', realName: '王失信', phone: '13911112222', auditStatus: 'approved' }
    ],
    orders: [
      {
        _id: 'order_problem_1',
        orderNo: 'O20260922099',
        serviceType: 'walk',
        serviceSummary: '上门遛狗服务',
        status: 'assigned',
        originalStaffOpenid: 'openid_staff_bad',
        originalStaffName: '王失信',
        staffOpenid: '',
        clientOpenid: 'openid_client',
        startTime: '2026-09-22 10:00',
        endTime: '2026-09-22 11:00',
        payAmount: 80,
        isUrgent: true,
        previousStaffRecords: [
          {
            staffOpenid: 'openid_staff_bad',
            staffName: '王失信',
            reason: 'admin_urgent_republish',
            urgentRemark: '严重超时失联转加急'
          }
        ]
      }
    ],
    staff_deposit_evidences: [],
    order_timeline: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 管理员在订单详情中点击“加入保证金扣除证据”
  const addEvidenceRes = await adminFn.main({
    module: 'admin',
    action: 'addOrderDepositPenaltyEvidence',
    data: {
      orderId: 'order_problem_1',
      staffOpenid: 'openid_staff_bad',
      reasonType: 'start_overdue',
      reasonText: '接单超时30分钟未到岗且多次电话催单未接听，导致平台补贴加急重派',
      deductAmount: 50,
      evidenceImages: ['cloud://test/evidence_1.png']
    }
  })

  assert.equal(addEvidenceRes.ok, true)
  assert.ok(addEvidenceRes.data.evidenceId)
  assert.equal(addEvidenceRes.data.deductAmount, 50)
  assert.equal(addEvidenceRes.data.status, 'pending')

  // 2. 检查订单状态已更新标记
  const orderInDb = (await db.collection('orders').doc('order_problem_1').get()).data
  assert.equal(orderInDb.hasDepositPenaltyEvidence, true)
  assert.ok(orderInDb.depositPenaltyEvidenceIds.includes(addEvidenceRes.data.evidenceId))

  // 3. 检查 getOrderDetail 包含证据与原宠托师联系信息
  const detailRes = await adminFn.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { id: 'order_problem_1' }
  })
  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.order.hasDepositPenaltyEvidence, true)
  assert.equal(detailRes.data.depositPenaltyEvidences.length, 1)
  assert.equal(detailRes.data.depositPenaltyEvidences[0].deductAmount, 50)
  assert.ok(detailRes.data.order.originalStaffContact)
  assert.equal(detailRes.data.order.originalStaffContact.phone, '13911112222')

  // 4. 检查宠托师管理列表 listStaffProfiles：后台一眼看到该宠托师出过问题的订单
  const profilesRes = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {}
  })
  assert.equal(profilesRes.ok, true)
  const badProfile = profilesRes.data.list.find((p) => p.openid === 'openid_staff_bad')
  assert.ok(badProfile, 'Must find staff profile')
  assert.equal(badProfile.problemOrderCount, 1, 'problemOrderCount must be 1')
  assert.equal(badProfile.pendingPenaltyCount, 1, 'pendingPenaltyCount must be 1')
  assert.equal(badProfile.problemOrders.length, 1)
  assert.equal(badProfile.problemOrders[0].orderId, 'order_problem_1')
  assert.equal(badProfile.problemOrders[0].orderNo, 'O20260922099')
  assert.equal(badProfile.problemOrders[0].reasonTypeName, '接单超时未开始/爽约')
  assert.equal(badProfile.problemOrders[0].deductAmount, 50)
})
