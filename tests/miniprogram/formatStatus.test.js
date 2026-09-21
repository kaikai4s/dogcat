const test = require('node:test')
const assert = require('node:assert/strict')

const {
  formatOrderStatus,
  formatPaymentStatus,
  formatRefundStatus,
  formatAuditStatus,
  formatStaffLevel,
  formatOnboardingStatus,
  withOrderText
} = require('../../miniprogram/utils/format')

test('formatOrderStatus: maps all known statuses to Chinese and never leaks English', () => {
  assert.equal(formatOrderStatus('pending_pay'), '待支付')
  assert.equal(formatOrderStatus('unpaid'), '待支付')
  assert.equal(formatOrderStatus('paid'), '待附近宠托师接单')
  assert.equal(formatOrderStatus('paid', { publishMode: 'direct' }), '待指定宠托师接单')
  assert.equal(formatOrderStatus('assigned'), '已接单')
  assert.equal(formatOrderStatus('in_service'), '服务中')
  assert.equal(formatOrderStatus('day_completed'), '当天已完成')
  assert.equal(formatOrderStatus('completed'), '已完成')
  assert.equal(formatOrderStatus('completed', { autoCompleted: true }), '已自动完成')
  assert.equal(formatOrderStatus('cancelled'), '已取消')
  assert.equal(formatOrderStatus('expired'), '已过期')
  assert.equal(formatOrderStatus('refunded'), '已退款')
  assert.equal(formatOrderStatus('refunding'), '退款中')
  assert.equal(formatOrderStatus('refund_applied'), '退款申请中')
  assert.equal(formatOrderStatus('partial_refunded'), '部分退款')
  assert.equal(formatOrderStatus('pending_ship'), '待发货')
  assert.equal(formatOrderStatus('shipped'), '已发货')
  assert.equal(formatOrderStatus('auto_completed'), '已自动完成')

  // Status with refundStatus
  assert.equal(formatOrderStatus('anything_unknown', { refundStatus: 'approved' }), '已退款')
  assert.equal(formatOrderStatus('anything_unknown', { paymentStatus: 'refunded' }), '已退款')

  // Unknown statuses fallback to '处理中', never English string
  assert.equal(formatOrderStatus('some_random_status'), '处理中')
  assert.equal(formatOrderStatus(''), '')
  assert.equal(formatOrderStatus(null), '')
})

test('formatRefundStatus: maps refund statuses to Chinese without English leak', () => {
  assert.equal(formatRefundStatus('requested'), '退款申请中')
  assert.equal(formatRefundStatus('applied'), '退款申请中')
  assert.equal(formatRefundStatus('processing'), '退款中')
  assert.equal(formatRefundStatus('approved'), '已同意退款')
  assert.equal(formatRefundStatus('rejected'), '退款已驳回')
  assert.equal(formatRefundStatus('refunded'), '已退款')
  assert.equal(formatRefundStatus('success'), '退款成功')
  assert.equal(formatRefundStatus('pending_manual'), '待人工退款')
  assert.equal(formatRefundStatus('unknown_status'), '退款处理中')
})

test('withOrderText: attaches Chinese statusText and refundStatusText', () => {
  const order = {
    status: 'refunded',
    paymentStatus: 'refunded',
    refundStatus: 'approved'
  }
  const result = withOrderText(order)
  assert.equal(result.statusText, '已退款')
  assert.equal(result.paymentStatusText, '已退款')
  assert.equal(result.refundStatusText, '已同意退款')
})
