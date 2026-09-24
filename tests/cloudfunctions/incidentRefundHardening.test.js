const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('incident refund hardening: status protection, max refundable check and duplicate prevention', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin', 'client'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000001' }
    ],
    orders: [
      {
        _id: 'ord_incident_refund_1',
        orderNo: 'O_INC_REF_1',
        clientOpenid: 'openid_client',
        status: 'completed',
        paymentStatus: 'paid',
        paymentNo: 'P_INC_REF_1',
        payAmount: 100,
        refundAmount: 70
      }
    ],
    order_incidents: [
      {
        _id: 'inc_open_1',
        orderId: 'ord_incident_refund_1',
        clientOpenid: 'openid_client',
        status: 'processing',
        createdAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'inc_closed_1',
        orderId: 'ord_incident_refund_1',
        clientOpenid: 'openid_client',
        status: 'closed',
        createdAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'inc_resolved_1',
        orderId: 'ord_incident_refund_1',
        clientOpenid: 'openid_client',
        status: 'resolved',
        createdAt: '2026-09-01 10:00:00'
      }
    ],
    refunds: [
      {
        _id: 'ref_existing_1',
        orderId: 'ord_incident_refund_1',
        refundNo: 'R_EXISTING_1',
        refundAmount: 70,
        status: 'success'
      }
    ],
    payment_events: [],
    incident_actions: [],
    order_timeline: []
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 已结案的纠纷禁止发起退款
  const resClosedRefund = await adminApi.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_closed_1',
      refundAmount: 20,
      reason: '结案后重退'
    }
  })
  assert.equal(resClosedRefund.ok, false)
  assert.match(resClosedRefund.message, /已结案纠纷不可再关联或发起退款/)

  const resResolvedRefund = await adminApi.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_resolved_1',
      refundAmount: 20,
      reason: '结案后重退'
    }
  })
  assert.equal(resResolvedRefund.ok, false)
  assert.match(resResolvedRefund.message, /已结案纠纷不可再关联或发起退款/)

  // 2. 已结案纠纷禁止再变更方案
  const resClosedResolution = await adminApi.main({
    module: 'incident',
    action: 'proposeResolution',
    data: {
      incidentId: 'inc_closed_1',
      resolutionType: 'explain',
      content: '结案后变更'
    }
  })
  assert.equal(resClosedResolution.ok, false)
  assert.match(resClosedResolution.message, /已结案纠纷不可变更处理方案/)

  // 3. 超出订单剩余可退上限拦截（总付 100，已退 70，剩余可退 30，申请 35 被拦截）
  const resExceededRefund = await adminApi.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_open_1',
      refundAmount: 35,
      reason: '超额退款'
    }
  })
  assert.equal(resExceededRefund.ok, false)
  assert.match(resExceededRefund.message, /退款金额超出订单剩余可退上限（当前最大可退 ¥30）/)

  // 4. 正常在可退额度内退款（申请 30）
  const resValidRefund = await adminApi.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_open_1',
      refundAmount: 30,
      reason: '合理退款',
      clientRequestId: 'req_valid_refund_1'
    }
  })
  assert.equal(resValidRefund.ok, true)
  assert.ok(resValidRefund.data.refundId)
  assert.equal(resValidRefund.data.status, 'refund_pending')

  // 5. 该纠纷已关联退款后，若再次传入其他退款请求，应被拦截防重
  const resDuplicateRefund = await adminApi.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_open_1',
      refundAmount: 10,
      reason: '重复发起退款',
      clientRequestId: 'req_another_refund'
    }
  })
  assert.equal(resDuplicateRefund.ok, false)
  assert.match(resDuplicateRefund.message, /该纠纷已关联退款单，请勿重复发起退款/)

  // 6. 相同 clientRequestId 幂等重试应成功返回已有关联单
  const resIdempotentRetry = await adminApi.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_open_1',
      refundAmount: 30,
      clientRequestId: 'req_valid_refund_1'
    }
  })
  assert.equal(resIdempotentRetry.ok, true)
  assert.equal(resIdempotentRetry.data.refundId, resValidRefund.data.refundId)
})
