const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function fixture() {
  const session = { index: 1, startTime: '2026-11-13 00:10', endTime: '2026-11-13 00:40',
    startedAt: new Date('2026-11-12T16:10:00Z'), status: 'in_service' }
  const db = createCollectionStore({
    users: ['a', 'b'].map(id => ({ _id: id, openid: id, roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 })),
    orders: ['a', 'b'].map(id => ({ _id: id, clientOpenid: id, clientUserId: id, staffOpenid: 'staff',
      groupBuyId: 'group', groupBuyStatus: 'formed', status: 'in_service', paymentStatus: 'paid',
      payAmount: 100, paymentNo: `PAY_${id}`, paymentChannel: 'wechat',
      serviceSessions: [structuredClone(session)], activeSessionIndex: 1, currentSessionStartedAt: session.startedAt })),
    pet_playground_groups: [{ _id: 'group', status: 'formed', formedAt: 1 }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { settlement: { staffCommissionRate: .7, settlementDelayDays: 0 } } }]
  })
  optimistic(db)
  const context = createContext({ db, cloud: {} })
  const completion = require('../../cloudfunctions/api/services/serviceExecution')({ ...context,
    requireSanitizationEvidence: async () => {}, readScopedDocuments: async () => []
  })
  let status = 'SUCCESS'
  const refunds = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    assertPaymentModeAllowed: () => {}, getWechatPayConfig: () => ({}), sanitizeWechatPayload: value => value,
    enqueueOrderNotification: async () => {}, notifyOrder: async () => {},
    wechatPayRequest: async (method, path, body) => {
      const row = db.state.refunds[0]
      return { status, out_refund_no: row.refundNo, amount: body ? body.amount : { refund: 10000, total: 10000 } }
    }
  })
  return { db, completion, refunds, session, setStatus: value => { status = value } }
}

for (const legacyMarker of [false, true]) {
  test(`group refund reconciliation settles only the served household once (legacy waiting marker: ${legacyMarker})`, async () => {
    const f = fixture()
    const a = structuredClone(f.db.state.orders[0])
    const first = await f.completion.completeOrderService(a, f.session, new Date('2026-11-12T16:45:00Z'))
    assert.equal(first.partialGroupCompleted, true)
    assert.equal((f.db.state.staff_earnings || []).length, 0)
    if (legacyMarker) f.db.state.orders[0].groupCompletionPending = false
    f.setStatus('PROCESSING')
    const refund = await f.refunds.requestOrderRefund(structuredClone(f.db.state.orders[1]), 100, '未履约住户协商全退', 'admin_manual', 'admin', 'refund-b')
    await f.completion.retryPendingGroupCompletions()
    assert.equal(f.db.state.orders[0].status, 'day_completed')
    assert.equal((f.db.state.staff_earnings || []).length, 0)
    f.setStatus('SUCCESS')
    await Promise.all([f.refunds.syncOrderRefund(refund), f.completion.retryPendingGroupCompletions()])
    await f.completion.retryPendingGroupCompletions()
    assert.equal(f.db.state.orders[0].status, 'completed')
    assert.equal(f.db.state.orders[0].groupCompletionPending, false)
    assert.equal(f.db.state.orders[0].completedAt.toISOString(), '2026-11-12T16:45:00.000Z')
    assert.equal(f.db.state.orders[1].status, 'refunded')
    assert.equal(f.db.state.orders[1].refundedAmount, 100)
    assert.equal(f.db.state.staff_earnings.length, 1)
    assert.equal(f.db.state.staff_earnings[0].orderId, 'a')
    assert.equal(f.db.state.staff_earnings[0].amount, 70)
    assert.equal(f.db.state.users.find(user => user.openid === 'a').completedOrderCount, 1)
    assert.equal(f.db.state.users.find(user => user.openid === 'b').completedOrderCount, 0)
    await f.refunds.syncOrderRefund(refund)
    await f.completion.retryPendingGroupCompletions()
    assert.equal(f.db.state.staff_earnings.length, 1)
    assert.equal(f.db.state.point_logs.length, 1)
    assert.equal(f.db.state.finance_logs.filter(row => row.action === 'refund_success').length, 1)
  })
}
