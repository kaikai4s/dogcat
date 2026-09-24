const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')

test('expire orders refund idempotency: static key without dynamic timestamp prevents duplicate refunds across schedule runs', async () => {
  const openid = 'openid_client_idempotency_1'
  const orderId = 'order_idempotency_test_1'

  const db = createCollectionStore({
    users: [{ _id: 'u_idem_1', openid, roles: ['client'], activeRole: 'client', status: 'active' }],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_IDEM_001',
        clientOpenid: openid,
        staffOpenid: '', // 无人接单
        status: 'paid',
        paymentStatus: 'paid',
        paymentNo: 'PAY_IDEM_001',
        amount: 100,
        payAmount: 100,
        startTime: '2026-09-20 09:00', // 已过服务开始时间
        createdAt: '2026-09-20 08:00:00'
      }
    ],
    refunds: [],
    payment_events: [],
    order_timeline: []
  })

  const createContext = require('../../cloudfunctions/api/services/context')

  // 第 1 次调度运行：系统时间为 T1
  const t1 = new Date('2026-09-24T10:00:00Z')
  const ctx1 = createContext({ db, cloud: {}, now: () => t1 })
  await ctx1.expireDueUnacceptedOrders()

  // 验证第 1 次运行后退款生成成功
  assert.equal(db.state.refunds.length, 1)
  const firstRefund = db.state.refunds[0]
  assert.equal(firstRefund.orderId, orderId)
  assert.equal(firstRefund.refundAmount, 100)

  // 验证幂等键 clientRequestId 恒定且不包含动态毫秒时间戳
  const expectedIdempotencyKey = ctx1.makeIdempotencyKey('expire_refund', orderId)
  assert.equal(firstRefund.clientRequestId, expectedIdempotencyKey)
  assert.equal(firstRefund.clientRequestId.includes(String(t1.getTime())), false, 'clientRequestId must not contain timestamp')

  // 第 2 次调度运行：10 分钟后（系统时间改变为 T2），再次触发无人接单超时检查
  const t2 = new Date('2026-09-24T10:10:00Z')
  const ctx2 = createContext({ db, cloud: {}, now: () => t2 })
  await ctx2.expireDueUnacceptedOrders()

  // 验证退款记录依然只有 1 笔，绝对未重复生成退款记录
  assert.equal(db.state.refunds.length, 1, 'Refunds collection must still have exactly 1 record')
  const refundAfterSecondRun = db.state.refunds[0]
  assert.equal(refundAfterSecondRun._id, firstRefund._id)
  assert.equal(refundAfterSecondRun.refundNo, firstRefund.refundNo)
})
