const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function setupRefunds(extraContext = {}, initialState = {}) {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_test_1',
        clientOpenid: 'client',
        status: 'paid',
        paymentStatus: 'paid',
        paymentNo: 'P10001',
        wxTransactionId: 'WX10001',
        payAmount: 100,
        refundAmount: 0,
        refundedAmount: 0,
        createdAt: new Date()
      }
    ],
    refunds: [],
    finance_logs: [],
    payment_events: [],
    ...initialState
  })
  optimistic(db)
  const baseContext = createContext({ db, cloud: {} })
  const service = require('../../cloudfunctions/api/services/refunds')({
    ...baseContext,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    getWechatPayConfig: () => ({ appId: 'app', mchId: 'mch', apiV3Key: 'key', certSerialNo: 'cert', privateKey: 'pk' }),
    ...extraContext
  })
  return { db, baseContext, ...service }
}

test('wechat refund CLOSED terminal failure atomically releases quota and allows new refund', async () => {
  const { db, requestOrderRefund } = setupRefunds({
    wechatPayRequest: async (method, path, body) => ({
      status: 'CLOSED',
      out_refund_no: body.out_refund_no,
      refund_id: 'WX_REF_CLOSED',
      amount: body.amount
    })
  })

  const order = structuredClone(db.state.orders[0])
  const result = await requestOrderRefund(order, 100, '用户申请退款', 'admin_manual', 'admin', 'req_closed_1')

  assert.equal(result.status, 'failed')
  assert.equal(result.gatewayStatus, 'CLOSED')
  assert.equal(result.failReason, '微信退款已关闭')

  // 退款单记录检查
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.refunds[0].status, 'failed')
  assert.equal(db.state.refunds[0].gatewayStatus, 'CLOSED')

  // 订单状态与预占额度检查：额度必须完全释放回 0，订单 paymentStatus 恢复为 paid
  assert.equal(db.state.orders[0].refundAmount, 0)
  assert.equal(db.state.orders[0].refundedAmount, 0)
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.orders[0].refundStatus, 'failed')

  // 支付事件检查：记录 refund_failed 事件
  const failEvents = db.state.payment_events.filter(e => e.eventType === 'refund_failed')
  assert.equal(failEvents.length, 1)
  assert.equal(failEvents[0].status, 'failed')
  assert.equal(failEvents[0].detail.gatewayStatus, 'CLOSED')

  // 关键验证：原预占被释放后，商户可以顺利再次发起 100 元全额退款，不会被超额拦截！
  const retryOrder = structuredClone(db.state.orders[0])
  let secondRequestDispatched = false
  const retryService = require('../../cloudfunctions/api/services/refunds')({
    ...setupRefunds().baseContext,
    db,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    getWechatPayConfig: () => ({ appId: 'app', mchId: 'mch', apiV3Key: 'key', certSerialNo: 'cert', privateKey: 'pk' }),
    wechatPayRequest: async (method, path, body) => {
      secondRequestDispatched = true
      return {
        status: 'SUCCESS',
        out_refund_no: body.out_refund_no,
        refund_id: 'WX_REF_SUCCESS',
        amount: body.amount
      }
    }
  })

  const retryResult = await retryService.requestOrderRefund(retryOrder, 100, '重新发起退款', 'admin_manual', 'admin', 'req_success_2')
  assert.equal(secondRequestDispatched, true)
  assert.equal(retryResult.status, 'success')
  assert.equal(db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(db.state.orders[0].refundedAmount, 100)
  assert.equal(db.state.orders[0].refundAmount, 100)
})

test('wechat refund ABNORMAL terminal failure atomically releases quota and marks status', async () => {
  const { db, requestOrderRefund } = setupRefunds({
    wechatPayRequest: async (method, path, body) => ({
      status: 'ABNORMAL',
      out_refund_no: body.out_refund_no,
      refund_id: 'WX_REF_ABNORMAL',
      amount: body.amount
    })
  })

  const order = structuredClone(db.state.orders[0])
  const result = await requestOrderRefund(order, 50, '部分退款', 'admin_manual', 'admin', 'req_abnormal_1')

  assert.equal(result.status, 'failed')
  assert.equal(result.gatewayStatus, 'ABNORMAL')
  assert.equal(result.failReason, '微信退款异常')
  assert.equal(db.state.orders[0].refundAmount, 0)
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.orders[0].refundStatus, 'failed')
})

test('reconcilePendingRefunds heals stuck processing refund when gateway reports CLOSED', async () => {
  let callCount = 0
  const { db, requestOrderRefund, reconcilePendingRefunds } = setupRefunds({
    wechatPayRequest: async (method, path, body) => {
      callCount++
      if (callCount === 1) {
        throw new Error('ETIMEDOUT: network glitch during refund request')
      }
      return {
        status: 'CLOSED',
        out_refund_no: body.out_refund_no,
        refund_id: 'WX_REF_POLL_CLOSED',
        amount: body.amount
      }
    }
  })

  const order = structuredClone(db.state.orders[0])
  // 首次请求因网络超时中断，本地单据落为 processing 且额度预占
  await assert.rejects(
    requestOrderRefund(order, 100, '网络超时退款', 'admin_manual', 'admin', 'req_timeout_1'),
    /待核实/
  )
  assert.equal(db.state.refunds[0].status, 'processing')
  assert.equal(db.state.orders[0].refundAmount, 100)
  assert.equal(db.state.orders[0].paymentStatus, 'refunding')

  // 定时任务轮询补偿
  const reconciled = await reconcilePendingRefunds()
  assert.equal(reconciled, 1)

  // 验证自愈结果：状态转为 failed，订单额度释放归零，恢复为 paid
  assert.equal(db.state.refunds[0].status, 'failed')
  assert.equal(db.state.refunds[0].gatewayStatus, 'CLOSED')
  assert.equal(db.state.orders[0].refundAmount, 0)
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.orders[0].refundStatus, 'failed')

  // 再次轮询已无待对账记录，不会陷入死循环
  const secondReconciled = await reconcilePendingRefunds()
  assert.equal(secondReconciled, 0)
})

test('partial success with partial failure accurately preserves successful quota and releases failed quota', async () => {
  let requestIndex = 0
  const { db, requestOrderRefund } = setupRefunds({
    wechatPayRequest: async (method, path, body) => {
      requestIndex++
      if (requestIndex === 1) {
        return {
          status: 'SUCCESS',
          out_refund_no: body.out_refund_no,
          refund_id: 'WX_PARTIAL_1',
          amount: body.amount
        }
      }
      return {
        status: 'CLOSED',
        out_refund_no: body.out_refund_no,
        refund_id: 'WX_PARTIAL_2',
        amount: body.amount
      }
    }
  })

  // 第一笔 40 元成功
  const order1 = structuredClone(db.state.orders[0])
  const res1 = await requestOrderRefund(order1, 40, '首笔退款', 'admin_manual', 'admin', 'req_part_1')
  assert.equal(res1.status, 'success')
  assert.equal(db.state.orders[0].refundedAmount, 40)
  assert.equal(db.state.orders[0].refundAmount, 40)
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.orders[0].refundStatus, 'partially_refunded')

  // 第二笔 60 元失败
  const order2 = structuredClone(db.state.orders[0])
  const res2 = await requestOrderRefund(order2, 60, '次笔退款', 'admin_manual', 'admin', 'req_part_2')
  assert.equal(res2.status, 'failed')

  // 验证：成功额度 40 元保留，失败额度 60 元被释放，有效预占总额保持 40 元
  assert.equal(db.state.orders[0].refundedAmount, 40)
  assert.equal(db.state.orders[0].refundAmount, 40)
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.orders[0].refundStatus, 'partially_refunded')
})
