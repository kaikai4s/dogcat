const test = require('node:test')
const assert = require('node:assert/strict')

const {
  formatOrderStatus,
  formatPaymentStatus,
  formatRefundStatus,
  formatAuditStatus,
  formatStaffLevel,
  formatOnboardingStatus,
  formatPointSource,
  formatActorRole,
  formatIncidentResolutionType,
  formatServiceTypes,
  withIncidentActionText,
  withOrderText
} = require('../../miniprogram/utils/format')

test('point sources cover every current award and never return internal codes', () => {
  const sources = {
    order_complete: '完成订单', order_review: '评价订单', admin_grant: '管理员操作',
    checkin_daily: '每日签到', reward_mail: '奖励邮箱', lottery_reward: '抽奖奖励',
    pet_title_duplicate: '重复头衔补偿', playground_care: '每日关爱照料',
    playground_report: '环境反馈', playground_resolve: '纠纷处理', playground_weekly: '每周处理奖励', playground_wash: '洗车服务'
  }
  for (const [source, label] of Object.entries(sources)) {
    assert.equal(formatPointSource(source), label)
    assert.equal(formatPointSource(` ${source.toUpperCase()} `), label)
  }
  for (const source of ['new_reward_type', '', null, undefined, '__proto__', 'constructor']) {
    assert.equal(formatPointSource(source), '其他积分变动')
  }
})

test('service type summaries localize single, multiple and unknown types', () => {
  assert.equal(formatServiceTypes('walk'), '遛狗服务')
  assert.equal(formatServiceTypes(['feed', 'litter']), '喂养服务、清理宠物厕所')
  assert.equal(formatServiceTypes('play,medicine,clean'), '陪伴玩耍、喂药协助、简单清洁')
  assert.equal(formatServiceTypes('future_service'), '其他服务')
  assert.equal(formatServiceTypes('constructor'), '其他服务')
  assert.equal(formatServiceTypes(null), '上门宠护')
})

test('incident roles and resolution types use Chinese fallbacks without changing free text', () => {
  assert.equal(formatActorRole('staff'), '宠托师')
  assert.equal(formatActorRole(' ADMIN '), '后台')
  assert.equal(formatIncidentResolutionType('refund'), '部分退款')
  assert.equal(formatIncidentResolutionType('coupon'), '优惠补偿')
  assert.equal(formatIncidentResolutionType('explain'), '解释说明')
  assert.equal(formatIncidentResolutionType('reject'), '驳回诉求')
  for (const unknown of ['new_type', '', null, '__proto__']) {
    assert.equal(formatActorRole(unknown), '其他人员')
    assert.equal(formatIncidentResolutionType(unknown), '处理结果')
  }
  const action = withIncidentActionText({ action: 'commented', actorRole: 'internal_role', detail: { remark: '用户备注 ABC_123' } })
  assert.equal(action.actorRole, 'internal_role')
  assert.equal(action.actorRoleText, '其他人员')
  assert.equal(action.detailText, '用户备注 ABC_123')
})

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
  assert.equal(formatOrderStatus('anything_unknown', { refundStatus: 'approved' }), '退款中')
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

test('refund badges follow payment results even when fulfillment status remains cancelled or completed', () => {
  for (const status of ['cancelled', 'expired', 'completed', 'paid']) {
    assert.equal(withOrderText({ status, paymentStatus: 'refunding', refundStatus: 'processing' }).statusText, '退款中')
    assert.equal(withOrderText({ status, paymentStatus: 'refunded', refundStatus: 'full_refunded' }).statusText, '已退款')
    assert.equal(withOrderText({ status, paymentStatus: 'paid', refundStatus: 'partially_refunded', refundedAmount: 20 }).statusText, '部分退款')
    assert.equal(withOrderText({ status, paymentStatus: 'refunding', refundedAmount: 20 }).statusText, '退款中')
  }
})
