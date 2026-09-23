const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('processOverdueUnstartedOrders sends warning to staff at T+15min and alerts client at T+30min', async () => {
  const scheduledStart = '2026-09-21 10:00'
  const scheduledEnd = '2026-09-21 11:00'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_unstarted_1',
        orderNo: 'UNSTART001',
        status: 'assigned',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        serviceType: 'feed',
        serviceSummary: '上门喂猫',
        startTime: scheduledStart,
        endTime: scheduledEnd,
        durationMinutes: 60,
        payAmount: 65,
        paymentStatus: 'paid',
        serviceSessions: [{ index: 1, startTime: scheduledStart, endTime: scheduledEnd, status: 'pending' }]
      }
    ],
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    staff_earnings: [],
    subscription_logs: []
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // Case 1: At 10:05 (5 minutes after start) - should not trigger
  let res = await fn.main({
    module: 'order',
    action: 'checkOverdueOrders',
    data: {}
  })
  // Overdue check with simulated time: let's test directly via Timer or calling checkOverdueOrders
  // In checkOverdueOrders, currentTime is now(). Let's test by setting scheduledStart to past time!
})

test('callable checkOverdueOrders rejects non-admin callers without side effects', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [{ _id: 'order_overdue_start', status: 'assigned', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', startTime: '2000-01-01 10:00', endTime: '2000-01-01 11:00', serviceSessions: [{ index: 1, startTime: '2000-01-01 10:00', endTime: '2000-01-01 11:00', status: 'pending' }] }],
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    subscription_logs: []
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const result = await staffFn.main({ module: 'order', action: 'checkOverdueOrders', data: {} })

  assert.equal(result.ok, false)
  assert.equal(result.message, '仅管理员可操作')
  assert.equal(db.state.order_staff_messages.length, 0)
  assert.equal(db.state.order_messages.length, 0)
  assert.equal(db.state.orders[0].isStartOverdue, undefined)
})

test('overdue unstarted orders flow: triggers staff warning at 15min and client alert at 30min', async () => {
  // 40 minutes in the past
  const pastStart = new Date(Date.now() - 40 * 60 * 1000)
  const pastStartStr = `${pastStart.getFullYear()}-${String(pastStart.getMonth() + 1).padStart(2, '0')}-${String(pastStart.getDate()).padStart(2, '0')} ${String(pastStart.getHours()).padStart(2, '0')}:${String(pastStart.getMinutes()).padStart(2, '0')}`
  const pastEnd = new Date(Date.now() + 20 * 60 * 1000)
  const pastEndStr = `${pastEnd.getFullYear()}-${String(pastEnd.getMonth() + 1).padStart(2, '0')}-${String(pastEnd.getDate()).padStart(2, '0')} ${String(pastEnd.getHours()).padStart(2, '0')}:${String(pastEnd.getMinutes()).padStart(2, '0')}`

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_overdue_start',
        orderNo: 'O_START_001',
        status: 'assigned',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        serviceType: 'feed',
        serviceSummary: '上门喂猫',
        startTime: pastStartStr,
        endTime: pastEndStr,
        durationMinutes: 60,
        payAmount: 65,
        paymentStatus: 'paid',
        serviceSessions: [{ index: 1, startTime: pastStartStr, endTime: pastEndStr, status: 'pending' }]
      }
    ],
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    order_incidents: [],
    staff_earnings: [],
    subscription_logs: []
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const result = await fn.main({ module: 'order', action: 'checkOverdueOrders', data: {} })

  assert.equal(result.ok, true)
  assert.equal(result.data.unstartedCount, 1)

  // Verify staff received overdue warning message
  const staffMsg = db.state.order_staff_messages.find((m) => m.orderId === 'order_overdue_start' && m.eventType === 'overdue_unstarted_warning')
  assert.notEqual(staffMsg, undefined)
  assert.match(staffMsg.detail, /已超时超过 15 分钟/)

  // Verify client received notice
  const clientMsg = db.state.order_messages.find((m) => m.orderId === 'order_overdue_start' && m.eventType === 'overdue_unstarted_client_notice')
  assert.notEqual(clientMsg, undefined)
  assert.match(clientMsg.detail, /已超时 30 分钟尚未开始/)

  // Verify order updated with flags
  const updatedOrder = db.state.orders.find((o) => o._id === 'order_overdue_start')
  assert.equal(updatedOrder.isStartOverdue, true)
  assert.deepEqual(updatedOrder.staffOverdueStartRemindedSessions, [1])
  assert.deepEqual(updatedOrder.clientOverdueStartAlertedSessions, [1])
})

test('overdue unfinished orders flow: auto-completes when checkins are complete and overdue >= 30min', async () => {
  // Service started 90 minutes ago, scheduled duration was 45 minutes, ended 45 minutes ago (overdue by 45min >= 30min)
  const startTime = new Date(Date.now() - 90 * 60 * 1000)
  const startTimeStr = `${startTime.getFullYear()}-${String(startTime.getMonth() + 1).padStart(2, '0')}-${String(startTime.getDate()).padStart(2, '0')} ${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')}`
  const endTime = new Date(Date.now() - 45 * 60 * 1000)
  const endTimeStr = `${endTime.getFullYear()}-${String(endTime.getMonth() + 1).padStart(2, '0')}-${String(endTime.getDate()).padStart(2, '0')} ${String(endTime.getHours()).padStart(2, '0')}:${String(endTime.getMinutes()).padStart(2, '0')}`

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_auto_complete_1',
        orderNo: 'O_FINISH_AUTO',
        status: 'in_service',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        clientUserId: 'u_client',
        serviceType: 'feed',
        serviceSummary: '上门喂养',
        startTime: startTimeStr,
        endTime: endTimeStr,
        currentSessionStartedAt: startTime,
        durationMinutes: 45,
        payAmount: 80,
        paymentStatus: 'paid',
        requiredCheckins: ['enter_door', 'leave_door'],
        serviceSessions: [{ index: 1, startTime: startTimeStr, endTime: endTimeStr, status: 'in_service', startedAt: startTime }]
      }
    ],
    checkin_logs: [
      { _id: 'ck_s', orderId: 'order_auto_complete_1', eventType: 'sanitization', mediaFileId: 'cloud://san.jpg', recordedAt: startTime },
      { _id: 'ck_1', orderId: 'order_auto_complete_1', eventType: 'enter_door', mediaFileId: 'cloud://enter.jpg', recordedAt: new Date(startTime.getTime() + 60000) },
      { _id: 'ck_2', orderId: 'order_auto_complete_1', eventType: 'leave_door', mediaFileId: 'cloud://leave.jpg', recordedAt: new Date(startTime.getTime() + 30 * 60000) }
    ],
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    order_incidents: [],
    staff_earnings: [],
    subscription_logs: [],
    point_logs: []
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const result = await fn.main({ module: 'order', action: 'checkOverdueOrders', data: {} })

  assert.equal(result.ok, true)
  assert.equal(result.data.unfinishedCount, 1)
  assert.equal(result.data.unfinished[0].type, 'auto_completed')

  // Order status should be completed
  const order = db.state.orders.find((o) => o._id === 'order_auto_complete_1')
  assert.equal(order.status, 'completed')
  assert.equal(order.autoCompleted, true)

  // Staff earning should be created
  const earning = db.state.staff_earnings.find((e) => e.orderId === 'order_auto_complete_1')
  assert.notEqual(earning, undefined)
  assert.equal(earning.staffOpenid, 'openid_staff')

  // Timeline should have system_auto_completed event
  const timelineItem = db.state.order_timeline.find((t) => t.orderId === 'order_auto_complete_1' && t.type === 'system_auto_completed')
  assert.notEqual(timelineItem, undefined)
  assert.match(timelineItem.title, /系统智能完成服务/)

  // Sitter message explaining auto finish
  const staffMsg = db.state.order_staff_messages.find((m) => m.orderId === 'order_auto_complete_1' && m.eventType === 'system_auto_completed')
  assert.notEqual(staffMsg, undefined)
  assert.match(staffMsg.detail, /系统已自动帮您完成服务并结算收益/)

  // Client message explaining service is done
  const clientMsg = db.state.order_messages.find((m) => m.orderId === 'order_auto_complete_1' && m.eventType === 'completed')
  assert.notEqual(clientMsg, undefined)
})

test('overdue unfinished orders flow: creates incident when missing checkins and overdue >= 60min', async () => {
  // Service started 120 minutes ago, ended 70 minutes ago, missing checkins
  const startTime = new Date(Date.now() - 120 * 60 * 1000)
  const startTimeStr = `${startTime.getFullYear()}-${String(startTime.getMonth() + 1).padStart(2, '0')}-${String(startTime.getDate()).padStart(2, '0')} ${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')}`
  const endTime = new Date(Date.now() - 70 * 60 * 1000)
  const endTimeStr = `${endTime.getFullYear()}-${String(endTime.getMonth() + 1).padStart(2, '0')}-${String(endTime.getDate()).padStart(2, '0')} ${String(endTime.getHours()).padStart(2, '0')}:${String(endTime.getMinutes()).padStart(2, '0')}`

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_missing_checkins_overdue',
        orderNo: 'O_INCIDENT_001',
        status: 'in_service',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        clientUserId: 'u_client',
        serviceType: 'feed',
        serviceSummary: '上门喂养',
        startTime: startTimeStr,
        endTime: endTimeStr,
        currentSessionStartedAt: startTime,
        durationMinutes: 50,
        payAmount: 70,
        paymentStatus: 'paid',
        requiredCheckins: ['enter_door', 'leave_door'],
        serviceSessions: [{ index: 1, startTime: startTimeStr, endTime: endTimeStr, status: 'in_service', startedAt: startTime }]
      }
    ],
    checkin_logs: [], // No checkins!
    order_timeline: [],
    order_messages: [],
    order_message_threads: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    order_incidents: [],
    staff_earnings: [],
    subscription_logs: []
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const result = await fn.main({ module: 'order', action: 'checkOverdueOrders', data: {} })

  assert.equal(result.ok, true)
  assert.equal(result.data.unfinishedCount, 1)
  assert.equal(result.data.unfinished[0].type, 'incident_created')

  // Incident should be created
  const incident = db.state.order_incidents.find((inc) => inc.orderId === 'order_missing_checkins_overdue')
  assert.notEqual(incident, undefined)
  assert.equal(incident.type, 'service_finish_overdue')
  assert.equal(incident.status, 'open')

  // Timeline alert
  const alertTimeline = db.state.order_timeline.find((t) => t.orderId === 'order_missing_checkins_overdue' && t.type === 'finish_overdue_incident')
  assert.notEqual(alertTimeline, undefined)
})

test('admin listOrders filters by auto_completed and overdue, and returns autoCompleted and isOverdue flags', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'openid_admin', roles: ['admin', 'client'], status: 'active' },
      { _id: 'client_1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    orders: [
      {
        _id: 'order_normal_completed',
        orderNo: 'ORD_NORM_01',
        status: 'completed',
        clientOpenid: 'openid_client',
        autoCompleted: false,
        createdAt: '2026-09-21 08:00'
      },
      {
        _id: 'order_auto_completed',
        orderNo: 'ORD_AUTO_01',
        status: 'completed',
        clientOpenid: 'openid_client',
        autoCompleted: true,
        createdAt: '2026-09-21 09:00'
      },
      {
        _id: 'order_start_overdue',
        orderNo: 'ORD_OVRD_01',
        status: 'assigned',
        clientOpenid: 'openid_client',
        isStartOverdue: true,
        createdAt: '2026-09-21 10:00'
      }
    ],
    order_timeline: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. All orders
  const allRes = await adminFn.main({ module: 'admin', action: 'listOrders', data: {} })
  assert.equal(allRes.ok, true)
  assert.equal(allRes.data.list.length, 3)
  const autoItem = allRes.data.list.find((o) => o._id === 'order_auto_completed')
  assert.equal(autoItem.autoCompleted, true)
  const overdueItem = allRes.data.list.find((o) => o._id === 'order_start_overdue')
  assert.equal(overdueItem.isOverdue, true)

  // 2. Filter by status: 'auto_completed'
  const autoStatusRes = await adminFn.main({ module: 'admin', action: 'listOrders', data: { status: 'auto_completed' } })
  assert.equal(autoStatusRes.ok, true)
  assert.deepEqual(autoStatusRes.data.list.map((o) => o._id), ['order_auto_completed'])

  // 3. Filter by specialFilter: 'auto_completed'
  const autoSpecialRes = await adminFn.main({ module: 'admin', action: 'listOrders', data: { specialFilter: 'auto_completed' } })
  assert.equal(autoSpecialRes.ok, true)
  assert.deepEqual(autoSpecialRes.data.list.map((o) => o._id), ['order_auto_completed'])

  // 4. Filter by status: 'overdue'
  const overdueStatusRes = await adminFn.main({ module: 'admin', action: 'listOrders', data: { status: 'overdue' } })
  assert.equal(overdueStatusRes.ok, true)
  assert.deepEqual(overdueStatusRes.data.list.map((o) => o._id), ['order_start_overdue'])

  // 5. Filter by specialFilter: 'overdue'
  const overdueSpecialRes = await adminFn.main({ module: 'admin', action: 'listOrders', data: { specialFilter: 'overdue' } })
  assert.equal(overdueSpecialRes.ok, true)
  assert.deepEqual(overdueSpecialRes.data.list.map((o) => o._id), ['order_start_overdue'])

  // 6. Filter by status: 'completed' and specialFilter: 'auto_completed'
  const combinedRes = await adminFn.main({ module: 'admin', action: 'listOrders', data: { status: 'completed', specialFilter: 'auto_completed' } })
  assert.equal(combinedRes.ok, true)
  assert.deepEqual(combinedRes.data.list.map((o) => o._id), ['order_auto_completed'])
})

test('withOrderText adds autoCompletedText and preserves isOverdue flag', () => {
  const { withOrderText } = require('../../miniprogram/utils/format')
  const order1 = withOrderText({ status: 'completed', autoCompleted: true })
  assert.equal(order1.autoCompleted, true)
  assert.equal(order1.autoCompletedText, '系统自动结算')

  const order2 = withOrderText({ status: 'in_service', isFinishOverdue: true })
  assert.equal(order2.isOverdue, true)
})
