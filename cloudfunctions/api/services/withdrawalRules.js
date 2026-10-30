const { WECHAT_MAX_TRANSFER_CENTS } = require('../utils/wechatTransferLimits')

function amount(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100) / 100) : fallback
}

function buildWithdrawalRules({ minAmount = 10, quota = {}, settlementDelayDays = 0, source = 'staff' } = {}) {
  const min = Math.max(0.1, amount(minAmount, 10))
  const singleMax = quota.singleMaxAmount == null ? WECHAT_MAX_TRANSFER_CENTS / 100 : amount(quota.singleMaxAmount)
  const dailyAmountParts = []
  if (quota.recipientDailyMaxAmount != null) dailyAmountParts.push(`个人每日累计不超过¥${amount(quota.recipientDailyMaxAmount).toFixed(2)}`)
  if (quota.platformDailyMaxAmount != null) dailyAmountParts.push(`平台每日总额度¥${amount(quota.platformDailyMaxAmount).toFixed(2)}`)
  const settlementText = source === 'staff'
    ? (Number(settlementDelayDays) > 0 ? `订单完成后需经过${Number(settlementDelayDays)}天结算保护期，且无未决售后纠纷后进入可提现余额` : '订单完成且无未决售后纠纷后进入可提现余额')
    : '邀请佣金达到最低提现金额且状态为可提现后可申请'
  return {
    minAmount: min,
    minAmountText: `¥${min.toFixed(2)}`,
    singleMaxAmount: singleMax,
    singleMaxAmountText: `¥${singleMax.toFixed(2)}`,
    dailyCountText: '每日提现次数不限',
    dailyAmountText: dailyAmountParts.length ? dailyAmountParts.join('；') : '每日金额受微信零钱及平台实时额度限制',
    requestTimeText: '每日00:00-24:00均可提交申请',
    auditTimeText: '提交后进入平台审核，审核时间以平台实际处理为准',
    arrivalTimeText: '审核通过后发起微信零钱转账；如显示待确认，请在24小时内完成确认，到账时间以微信处理结果为准',
    settlementText
  }
}

module.exports = { buildWithdrawalRules }
