function effectivePrize(config = {}) {
  if (config.enabled === false) return 0
  const amount = Number(config.firstPrizeAmount ?? config.rewardAmount ?? 500)
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : 0
}
function publicContest(config = {}) {
  const defaults = {
    posterFileId: '', posterUrl: '', bannerTitle: '最美爱宠月度大赛',
    bannerSubtitle: '晒出爱宠萌照 · 争夺月度冠军现金大奖与全服专属头衔',
    rulesSummary: '每月评选 · 每日投1票 · 邀请新用户当日+1票 · 榜首享现金大奖', detailedRules: ''
  }
  const amount = effectivePrize(config)
  return { ...defaults, ...config, enabled: config.enabled !== false, firstPrizeAmount: amount, rewardAmount: amount }
}
module.exports = { effectivePrize, publicContest }
