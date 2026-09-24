const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createOverdueOrdersService = require('../../cloudfunctions/api/services/overdueOrders')

test('multi-session order overdue tracking, session isolation, and incident idempotency', async () => {
  const orderId = 'order_multi_day_overdue_1'
  const clientOpenid = 'openid_client_overdue'
  const staffOpenid = 'openid_staff_overdue'

  const serviceSessions = [
    {
      index: 1,
      date: '2026-09-01',
      startTime: '2026-09-01 10:00',
      endTime: '2026-09-01 11:00',
      status: 'in_service',
      startedAt: '2026-09-01 10:00:00'
    },
    {
      index: 2,
      date: '2026-09-02',
      startTime: '2026-09-02 10:00',
      endTime: '2026-09-02 11:00',
      status: 'pending',
      startedAt: ''
    }
  ]

  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: clientOpenid, roles: ['client'], status: 'active', name: '客户小王', phone: '13800000001' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], status: 'active', name: '宠托师小李', phone: '13900000002' }
    ],
    staff_profiles: [
      { _id: 'sp_staff', openid: staffOpenid, name: '宠托师小李', phone: '13900000002' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_MULTI_001',
        clientOpenid,
        staffOpenid,
        staffProfileId: 'sp_staff',
        status: 'in_service',
        serviceType: 'catsitter',
        serviceSummary: '上门喂猫 (2天)',
        startTime: '2026-09-01 10:00',
        endTime: '2026-09-02 11:00',
        serviceSessions,
        activeSessionIndex: 1,
        activeSessionDate: '2026-09-01',
        currentSessionStartedAt: '2026-09-01 10:00:00',
        startedAt: '2026-09-01 10:00:00',
        durationMinutes: 60,
        requiredCheckins: ['arrive', 'depart'],
        optionalCheckins: []
      }
    ],
    order_checkins: [],
    order_incidents: [],
    order_timeline: [],
    order_client_messages: [],
    order_staff_messages: [],
    admin_notifications: []
  })

  // 1. 第 1 天服务严重超时 60 分钟（当前时间 12:05，已超时 65 分钟），缺少打卡
  const timeDay1Overdue = '2026-09-01 12:05:00'
  const ctx = createContext({
    db,
    cloud: {},
    now: () => new Date(timeDay1Overdue)
  })
  const overdueService = createOverdueOrdersService(ctx)

  const res1 = await overdueService.processOverdueUnfinishedOrders(timeDay1Overdue)
  assert.equal(res1.length, 1, '第 1 天严重超时成功处理 1 笔异常')
  assert.equal(res1[0].type, 'incident_created')
  assert.equal(res1[0].sessionIndex, 1)

  // 验证生成的工单具有确定性 ID，且包含场次索引
  const expectedIncidentId1 = `inc_${orderId}_1_finish_overdue`
  const incidentDoc1 = await db.collection('order_incidents').doc(expectedIncidentId1).get()
  assert.ok(incidentDoc1.data, '确定性主键工单已生成')
  assert.equal(incidentDoc1.data.sessionIndex, 1)
  assert.equal(incidentDoc1.data.type, 'service_finish_overdue')

  // 验证订单状态记录了场次索引
  const orderAfterDay1 = (await db.collection('orders').doc(orderId).get()).data
  assert.deepEqual(orderAfterDay1.finishOverdueIncidentSessions, [1])
  assert.deepEqual(orderAfterDay1.overdueFinishRemindedSessions, [1])
  assert.equal(orderAfterDay1.finishOverdueIncidentCreated, true)
  assert.equal(orderAfterDay1.overdueFinishReminded, true)

  // 2. 定时任务重试/并发重复扫描第 1 天：应被幂等拦截，绝不重复生成工单
  const resRetry = await overdueService.processOverdueUnfinishedOrders(timeDay1Overdue)
  assert.equal(resRetry.length, 0, '同一场次再次扫描应被拦截跳过')

  const incidentsAll = (await db.collection('order_incidents').get()).data
  assert.equal(incidentsAll.length, 1, '工单总数保持为 1，无重复生成')

  // 3. 推进订单到第 2 天（模拟宠托师打卡完成第 1 天后开始第 2 天履约）
  const updatedSessions = [
    { ...serviceSessions[0], status: 'completed', finishedAt: '2026-09-01 12:30:00' },
    { ...serviceSessions[1], status: 'in_service', startedAt: '2026-09-02 10:00:00' }
  ]
  await db.collection('orders').doc(orderId).update({
    data: {
      status: 'in_service',
      serviceSessions: updatedSessions,
      activeSessionIndex: 2,
      activeSessionDate: '2026-09-02',
      currentSessionStartedAt: '2026-09-02 10:00:00',
      isFinishOverdue: false
    }
  })

  // 4. 第 2 天超时 20 分钟（11:20），缺少打卡，应触发第 2 天的超时提醒，而不被第 1 天旧标记阻断
  const timeDay2Remind = '2026-09-02 11:20:00'
  const ctxDay2Remind = createContext({
    db,
    cloud: {},
    now: () => new Date(timeDay2Remind)
  })
  const overdueServiceDay2Remind = createOverdueOrdersService(ctxDay2Remind)

  const resDay2Remind = await overdueServiceDay2Remind.processOverdueUnfinishedOrders(timeDay2Remind)
  assert.equal(resDay2Remind.length, 1, '第 2 天超时成功触发提醒')
  assert.equal(resDay2Remind[0].type, 'reminded')
  assert.equal(resDay2Remind[0].sessionIndex, 2)

  const orderAfterDay2Remind = (await db.collection('orders').doc(orderId).get()).data
  assert.deepEqual(orderAfterDay2Remind.overdueFinishRemindedSessions, [1, 2], '催促场次数组记录了场次 1 和 2')

  // 5. 第 2 天继续严重超时 60 分钟（12:05），仍缺少打卡，应触发第 2 天的异常工单
  const timeDay2Incident = '2026-09-02 12:05:00'
  const ctxDay2Incident = createContext({
    db,
    cloud: {},
    now: () => new Date(timeDay2Incident)
  })
  const overdueServiceDay2Incident = createOverdueOrdersService(ctxDay2Incident)

  const resDay2Incident = await overdueServiceDay2Incident.processOverdueUnfinishedOrders(timeDay2Incident)
  assert.equal(resDay2Incident.length, 1, '第 2 天严重超时成功生成工单')
  assert.equal(resDay2Incident[0].type, 'incident_created')
  assert.equal(resDay2Incident[0].sessionIndex, 2)

  const expectedIncidentId2 = `inc_${orderId}_2_finish_overdue`
  const incidentDoc2 = await db.collection('order_incidents').doc(expectedIncidentId2).get()
  assert.ok(incidentDoc2.data, '第 2 天确定性工单已独立生成')
  assert.equal(incidentDoc2.data.sessionIndex, 2)

  const orderAfterDay2Incident = (await db.collection('orders').doc(orderId).get()).data
  assert.deepEqual(orderAfterDay2Incident.finishOverdueIncidentSessions, [1, 2], '工单场次数组包含了 1 和 2')
})

test('multi-session order auto-completion tracks sessions independently', async () => {
  const orderId = 'order_multi_day_auto_1'
  const clientOpenid = 'openid_client_auto'
  const staffOpenid = 'openid_staff_auto'

  const serviceSessions = [
    {
      index: 1,
      date: '2026-09-01',
      startTime: '2026-09-01 10:00',
      endTime: '2026-09-01 11:00',
      status: 'in_service',
      startedAt: '2026-09-01 10:00:00'
    },
    {
      index: 2,
      date: '2026-09-02',
      startTime: '2026-09-02 10:00',
      endTime: '2026-09-02 11:00',
      status: 'pending',
      startedAt: ''
    }
  ]

  const db = createCollectionStore({
    users: [
      { _id: 'u_client_2', openid: clientOpenid, roles: ['client'], status: 'active', name: '客户小张', phone: '13800000003' },
      { _id: 'u_staff_2', openid: staffOpenid, roles: ['staff'], status: 'active', name: '宠托师小赵', phone: '13900000004' }
    ],
    staff_profiles: [
      { _id: 'sp_staff_2', openid: staffOpenid, name: '宠托师小赵', phone: '13900000004' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_AUTO_001',
        clientOpenid,
        staffOpenid,
        staffProfileId: 'sp_staff_2',
        status: 'in_service',
        serviceType: 'catsitter',
        serviceSummary: '上门喂猫 (2天)',
        startTime: '2026-09-01 10:00',
        endTime: '2026-09-02 11:00',
        serviceSessions,
        activeSessionIndex: 1,
        activeSessionDate: '2026-09-01',
        currentSessionStartedAt: '2026-09-01 10:00:00',
        startedAt: '2026-09-01 10:00:00',
        durationMinutes: 60,
        requiredCheckins: ['arrive', 'depart'],
        optionalCheckins: []
      }
    ],
    checkin_logs: [
      { _id: 'ck_1', orderId, eventType: 'arrive', mediaFileId: 'cloud://photo1.jpg', sessionStartedAt: '2026-09-01 10:00:00', createdAt: '2026-09-01 10:00:00' },
      { _id: 'ck_2', orderId, eventType: 'depart', mediaFileId: 'cloud://photo2.jpg', sessionStartedAt: '2026-09-01 10:00:00', createdAt: '2026-09-01 10:55:00' }
    ],
    order_incidents: [],
    order_timeline: [],
    order_client_messages: [],
    order_staff_messages: [],
    admin_notifications: []
  })

  // 第 1 天打卡齐全，超时 35 分钟（11:35） -> 自动完成第 1 天服务
  const timeDay1 = '2026-09-01 11:35:00'
  const ctx = createContext({
    db,
    cloud: {},
    now: () => new Date(timeDay1)
  })
  const overdueService = createOverdueOrdersService(ctx)

  const res1 = await overdueService.processOverdueUnfinishedOrders(timeDay1)
  assert.equal(res1.length, 1)
  assert.equal(res1[0].type, 'auto_completed')
  assert.equal(res1[0].sessionIndex, 1)

  const orderAfterDay1 = (await db.collection('orders').doc(orderId).get()).data
  assert.equal(orderAfterDay1.status, 'day_completed')
  assert.deepEqual(orderAfterDay1.autoCompletedSessions, [1])

  // 推进到第 2 天服务开始
  const day2Sessions = [
    { ...orderAfterDay1.serviceSessions[0] },
    { ...orderAfterDay1.serviceSessions[1], status: 'in_service', startedAt: '2026-09-02 10:00:00' }
  ]
  await db.collection('orders').doc(orderId).update({
    data: {
      status: 'in_service',
      serviceSessions: day2Sessions,
      activeSessionIndex: 2,
      activeSessionDate: '2026-09-02',
      currentSessionStartedAt: '2026-09-02 10:00:00'
    }
  })
  // 第 2 天也完成打卡
  await db.collection('checkin_logs').add({ data: { _id: 'ck_3', orderId, eventType: 'arrive', mediaFileId: 'cloud://photo3.jpg', sessionStartedAt: '2026-09-02 10:00:00', createdAt: '2026-09-02 10:00:00' } })
  await db.collection('checkin_logs').add({ data: { _id: 'ck_4', orderId, eventType: 'depart', mediaFileId: 'cloud://photo4.jpg', sessionStartedAt: '2026-09-02 10:00:00', createdAt: '2026-09-02 10:55:00' } })

  // 第 2 天超时 35 分钟（11:35） -> 自动完成第 2 天服务（也是最终服务）
  const timeDay2 = '2026-09-02 11:35:00'
  const ctxDay2 = createContext({
    db,
    cloud: {},
    now: () => new Date(timeDay2)
  })
  const overdueServiceDay2 = createOverdueOrdersService(ctxDay2)

  const res2 = await overdueServiceDay2.processOverdueUnfinishedOrders(timeDay2)
  assert.equal(res2.length, 1, '第 2 天打卡齐全且超时能够正常自动完成，不被第 1 天标记阻断')
  assert.equal(res2[0].type, 'auto_completed')
  assert.equal(res2[0].sessionIndex, 2)

  const orderAfterDay2 = (await db.collection('orders').doc(orderId).get()).data
  assert.equal(orderAfterDay2.status, 'completed')
  assert.deepEqual(orderAfterDay2.autoCompletedSessions, [1, 2])
})
