const { formatDateTime, formatOrderStatus } = require('../../utils/format')

function decorateGroup(group) {
  const remaining = Math.max(0, group.minHouseholds - group.householdCount)
  const closed = ['cancelled', 'closed', 'refunded'].includes(group.orderStatus) || group.paymentExpired
  const groupProgressText = group.status === 'formed' ? '成团优惠已锁定' : group.status === 'expired' ? '募集已结束，未成团不收款' : `还差 ${remaining} 户成团`
  let progressText = groupProgressText
  if (closed) progressText = group.paymentExpired ? '我的订单已过支付期限' : '我的订单' + (formatOrderStatus(group.orderStatus) || '已结束')
  const amount = group.status === 'formed' ? group.payAmount : group.estimatedPayAmount
  return { ...group,
    timeText: formatDateTime(group.startTime),
    deadlineText: formatDateTime(group.deadline),
    paymentDeadlineText: formatDateTime(group.paymentDeadline),
    sessionText: (group.serviceSessions || []).length > 1 ? `连续 ${(group.serviceSessions || []).length} 天` : '单次上门',
    progress: Math.min(100, Math.round(group.householdCount / Math.max(1, group.minHouseholds) * 100)),
    progressText, groupProgressText, closed,
    ownStatusText: group.paymentExpired ? '已超时' : group.orderStatus === 'pending_pay' && group.status === 'recruiting' ? '待成团' : (group.orderStatus ? formatOrderStatus(group.orderStatus) : group.statusText),
    priceText: amount != null && Number.isFinite(Number(amount)) ? Number(amount).toFixed(2) : '',
    priceLabel: group.status === 'formed' ? '订单金额' : '成团后预计',
    canPay: !closed && group.status === 'formed' && group.orderStatus === 'pending_pay'
  }
}

function decorateListing(result) {
  const rules = result.rules
  return { ...result, groups: (result.groups || []).map(decorateGroup), myGroups: (result.myGroups || []).map(decorateGroup),
    discountText: rules ? `${Number((rules.discountRate * 10).toFixed(2))}折` : '' }
}
module.exports = { decorateGroup, decorateListing }
