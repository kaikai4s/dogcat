const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('subscription privacy hardening: console logs and audit records do not leak openid, address, or message payload', async () => {
  const sensitiveAddress = '上海市浦东新区张江高科科苑路88号3栋502室'
  const sensitiveOpenid = 'openid_client_privacy_test'
  const sensitiveOrderNo = 'O2026092388889999'

  const db = createCollectionStore({
    users: [
      { _id: 'client_1', openid: sensitiveOpenid, roles: ['client'], status: 'active', phone: '13811112222' },
      { _id: 'staff_1', openid: 'openid_staff_privacy', roles: ['staff'], status: 'active', phone: '13933334444' }
    ],
    orders: [
      {
        _id: 'ord_privacy_1',
        orderNo: sensitiveOrderNo,
        clientOpenid: sensitiveOpenid,
        staffOpenid: 'openid_staff_privacy',
        staffName: '王宠托',
        serviceAddress: sensitiveAddress,
        city: '上海市',
        startTime: '2026-09-23 15:00',
        endTime: '2026-09-23 16:00',
        serviceSummary: '上门遛狗',
        status: 'paid'
      }
    ],
    subscription_logs: [],
    system_settings: [
      {
        _id: 'current',
        subscription: {
          enabled: false,
          templates: {
            orderAccepted: 'mock_tpl_accepted'
          }
        }
      }
    ]
  })

  // 拦截 console.log 和 console.error 收集输出文本
  const logs = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => {
    logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
    originalLog(...args)
  }
  console.error = (...args) => {
    logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '))
    originalError(...args)
  }

  try {
    const fn = loadCloudFunction('api', db, 'openid_staff_privacy')

    // 触发接受订单通知（内部调用 notifyOrderAccepted）
    const order = db.state.orders[0]
    const subscriptions = require('../../cloudfunctions/api/services/subscriptions')({
      ORDER_STATUS: { ASSIGNED: 'assigned', DAY_COMPLETED: 'day_completed' },
      appendOrderStaffMessage: async () => {},
      appendOrderTimeline: async () => {},
      beijingClockText: () => '15:00',
      buildMallOrderTitle: () => '',
      cloud: { openapi: { subscribeMessage: { send: async () => {} } } },
      db,
      deliverSubscription: async (msg, send) => send(msg),
      retrySubscriptionDeliveries: async () => 0,
      readScopedDocuments: async () => [],
      formatDateTime: () => '2026-09-23 15:00',
      getActiveServiceSession: () => null,
      getNextPendingServiceSession: () => null,
      getSystemSettings: async () => db.state.system_settings[0],
      isMallOrder: () => false,
      makeIdempotencyKey: () => 'idem_key',
      now: () => new Date('2026-09-23T07:00:00.000Z'),
      nowText: () => '2026-09-23 15:00',
      safeText: (v) => String(v || ''),
      toTimeValue: (v) => new Date(v).getTime()
    })

    const res = await subscriptions.notifyOrderAccepted(order, '王宠托')

    // 1. 验证 console 日志中绝不包含任何敏感信息
    const combinedLogs = logs.join('\n')
    assert.equal(combinedLogs.includes(sensitiveOpenid), false, '日志不得包含用户 OpenID')
    assert.equal(combinedLogs.includes(sensitiveAddress), false, '日志不得包含客户服务详细地址')
    assert.equal(combinedLogs.includes('502室'), false, '日志不得包含具体门牌号')
    assert.equal(combinedLogs.includes(sensitiveOrderNo), false, '日志不得包含明文订单号')

    // 2. 验证日志包含脱敏后的结构化审计关键字段（orderId, templateKey, status 等）
    assert.equal(combinedLogs.includes('ord_privacy_1'), true, '日志应保留脱敏业务关联 orderId')
    assert.equal(combinedLogs.includes('orderAccepted'), true, '日志应保留 templateKey')
    assert.equal(combinedLogs.includes('skipped'), true, '日志应保留 status')

    // 3. 验证数据库 subscription_logs 投递记录
    const subLogs = db.state.subscription_logs
    assert.equal(subLogs.length > 0, true)
    const latestLog = subLogs[subLogs.length - 1]
    assert.equal(latestLog.orderId, 'ord_privacy_1')
    assert.equal(latestLog.templateKey, 'orderAccepted')
    // 验证具备保留期限 expiresAt
    assert.equal(latestLog.expiresAt instanceof Date, true)
    // 验证即使记录了 data，其内部地址门牌号等敏感信息也已被脱敏
    if (latestLog.data && latestLog.data.thing4) {
      assert.equal(String(latestLog.data.thing4.value).includes('502室'), false)
      assert.equal(String(latestLog.data.thing4.value).includes('***'), true)
    }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
})
