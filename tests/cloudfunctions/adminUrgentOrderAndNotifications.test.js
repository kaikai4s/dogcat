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
  const serviceStart = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const serviceEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
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
      startTime: serviceStart,
      endTime: serviceEnd,
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
      startTime: serviceStart,
      endTime: serviceEnd,
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
  assert.equal(orderInDb.startTime, serviceStart)
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
    data: { orderId: 'order_urgent_1', currentLatitude: 31.2, currentLongitude: 121.5, riskConfirmed: true }
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

test('admin can manually complete order with violation deduction, supplement photos and staff earning settlement', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff_v', roles: ['staff'], status: 'active', name: '王宠托', phone: '13922223333', completedOrderCount: 0 },
      { _id: 'u_client', openid: 'openid_client_v', roles: ['client'], status: 'active', name: '赵客户', phone: '13833334444', completedOrderCount: 0 }
    ],
    staff_profiles: [
      { _id: 'sp_v', openid: 'openid_staff_v', realName: '王宠托', phone: '13922223333', completedOrderCount: 0 }
    ],
    orders: [
      {
        _id: 'order_manual_1',
        orderNo: 'OMANUAL2026',
        serviceType: 'feed',
        serviceSummary: '上门喂猫服务',
        status: 'in_service',
        clientOpenid: 'openid_client_v',
        clientUserId: 'u_client',
        staffOpenid: 'openid_staff_v',
        staffProfileId: 'sp_v',
        staffUserId: 'u_staff',
        payAmount: 100,
        startTime: '2026-09-22 10:00',
        endTime: '2026-09-22 11:00'
      }
    ],
    staff_earnings: [],
    finance_logs: [],
    order_timeline: [],
    order_messages: [],
    order_staff_messages: [],
    checkin_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 查询订单详情，检查计算的标准应得收益 (100 * 0.7 = 70)
  const detailRes = await adminFn.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { id: 'order_manual_1' }
  })
  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.order.standardStaffReward, 70)

  // 2. 执行核实手动完单：扣除 20 元违规服务费，实发 50 元，并补录 1 张打卡截图
  const completeRes = await adminFn.main({
    module: 'admin',
    action: 'manualCompleteOrder',
    data: {
      id: 'order_manual_1',
      remark: '核实宠托师手机进水无法在小程序打卡，已通过微信发送服务凭据；因未规范打卡扣除20元服务费',
      deductAmount: 20,
      deductReason: '未按规范打卡扣除违规服务费',
      evidenceImages: ['cloud://manual_checkin_proof.jpg']
    }
  })
  assert.equal(completeRes.ok, true)
  assert.equal(completeRes.data.status, 'completed')
  assert.equal(completeRes.data.baseReward, 70)
  assert.equal(completeRes.data.deductAmount, 20)
  assert.equal(completeRes.data.finalStaffReward, 50)

  // 3. 验证数据库中的订单状态
  const updatedOrder = (db.state.orders || []).find((o) => o._id === 'order_manual_1')
  assert.equal(updatedOrder.status, 'completed')
  assert.equal(updatedOrder.completionType, 'admin_manual')
  assert.equal(updatedOrder.adminManualDeductEarning, 20)
  assert.equal(updatedOrder.adminManualStaffReward, 50)

  // 4. 验证 checkin_logs 中是否补录了凭证
  const checkins = db.state.checkin_logs || []
  assert.equal(checkins.length, 1)
  assert.equal(checkins[0].eventType, 'admin_supplement')
  assert.equal(checkins[0].mediaFileId, 'cloud://manual_checkin_proof.jpg')

  // 5. 验证 staff_earnings 收益入账：实发 50，原应得 70，扣除 20
  const earnings = db.state.staff_earnings || []
  assert.equal(earnings.length, 1)
  assert.equal(earnings[0].orderId, 'order_manual_1')
  assert.equal(earnings[0].amount, 50)
  assert.equal(earnings[0].originalAmount, 70)
  assert.equal(earnings[0].deductAmount, 20)
  assert.equal(earnings[0].isDeducted, true)

  // 6. 验证宠托师消息中心通知
  const staffMsgs = db.state.order_staff_messages || []
  assert.ok(staffMsgs.length > 0)
  const lastStaffMsg = staffMsgs[staffMsgs.length - 1]
  assert.ok(lastStaffMsg.detail.includes('扣减违规收益 ¥20.00'))
  assert.ok(lastStaffMsg.detail.includes('实际入账收益 ¥50.00'))

  // 7. 验证订单时间线
  const timelines = db.state.order_timeline || []
  const manualTimeline = timelines.find((t) => t.type === 'admin_manual_completed')
  assert.ok(manualTimeline)
  assert.ok(manualTimeline.title.includes('扣减收益 ¥20.00'))
})

test('republishOrderAsUrgent blocks republishing if order status is already in_service', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'openid_staff', roles: ['staff'], status: 'active', name: '张托师' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_staff', name: '张托师' }
    ],
    orders: [
      {
        _id: 'order_in_service_1',
        orderNo: 'O20260922003',
        status: 'in_service',
        staffOpenid: 'openid_staff',
        payAmount: 80
      }
    ],
    admin_notifications: [],
    order_timeline: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const res = await adminFn.main({
    module: 'admin',
    action: 'republishOrderAsUrgent',
    data: {
      orderId: 'order_in_service_1',
      staffReward: 90
    }
  })

  assert.equal(res.ok, false)
  assert.ok(res.message.includes('不可转为加急公共抢单') || res.message.includes('宠托师可能已开始服务'))
})

test('republishOrderAsUrgent blocks republishing if staff has already started check-in logs', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'openid_staff', roles: ['staff'], status: 'active', name: '张托师' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_staff', name: '张托师' }
    ],
    orders: [
      {
        _id: 'order_checkin_1',
        orderNo: 'O20260922004',
        status: 'assigned',
        staffOpenid: 'openid_staff',
        payAmount: 80
      }
    ],
    checkin_logs: [
      {
        _id: 'chk_1',
        orderId: 'order_checkin_1',
        staffOpenid: 'openid_staff',
        eventType: 'sanitization',
        mediaFileId: 'cloud://photo.jpg',
        createdAt: new Date()
      }
    ],
    admin_notifications: [],
    order_timeline: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const res = await adminFn.main({
    module: 'admin',
    action: 'republishOrderAsUrgent',
    data: {
      orderId: 'order_checkin_1',
      staffReward: 90
    }
  })

  assert.equal(res.ok, false)
  assert.ok(res.message.includes('原宠托师已到场开始打卡履约'))
})

test('republishOrderAsUrgent blocks republishing on concurrent status update via optimistic locking', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'openid_staff', roles: ['staff'], status: 'active', name: '张托师' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_staff', name: '张托师' }
    ],
    orders: [
      {
        _id: 'order_concurrent_1',
        orderNo: 'O20260922005',
        status: 'assigned',
        staffOpenid: 'openid_staff',
        payAmount: 80
      }
    ],
    admin_notifications: [],
    order_timeline: [],
    staff_deposit_evidences: []
  })

  // 包装 db.collection，在管理员读取订单后，立即模拟宠托师抢先点击开始服务（将数据库中的 order.status 改为 in_service）
  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const col = origCollection(name)
    if (name === 'orders') {
      const origDoc = col.doc.bind(col)
      col.doc = (id) => {
        const docObj = origDoc(id)
        const origGet = docObj.get.bind(docObj)
        docObj.get = async () => {
          const res = await origGet()
          // 产生一个拷贝返回给管理员读取，代表管理员在瞬间读到了当时的 assigned 状态
          const clonedData = { ...res.data, status: 'assigned' }
          // 而此时并发事件真实将底层数据更新为 in_service
          const realOrder = db.state.orders.find((o) => o._id === id)
          if (realOrder) {
            realOrder.status = 'in_service'
          }
          return { data: clonedData }
        }
        return docObj
      }
    }
    return col
  }

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const res = await adminFn.main({
    module: 'admin',
    action: 'republishOrderAsUrgent',
    data: {
      orderId: 'order_concurrent_1',
      staffReward: 90,
      recordDepositEvidence: true,
      deductAmount: 50
    }
  })

  assert.equal(res.ok, false)
  assert.ok(res.message.includes('订单状态已被并发更新') || res.message.includes('被宠托师抢先开始'))
  // 确认在并发拦截后，由于状态更新为 0，订单没有被错误更新为 paid，仍保持并发后的 in_service
  const checkOrder = db.state.orders.find((o) => o._id === 'order_concurrent_1')
  assert.equal(checkOrder.status, 'in_service')
  // 确认保证金证据已被安全回滚清理，没有脏数据
  assert.equal(db.state.staff_deposit_evidences.length, 0)
})
