const { standardAmount } = require('../utils/staffDepositPolicy')
module.exports = function createService({
  enabledTrainingVideos,
  isTrainingVideoWatched,
  normalizeStaffTrainingConfig,
  onboardingStatusText,
  promotionStatusText,
  staffLevelText,
  videoAuditStatusText
}) {
  function normalizeStaffWorkflow(profile = {}) {
    if (!profile) return null
    const approved = profile.auditStatus === 'approved'
    const legacyCertified = approved && !profile.staffLevel
    const staffLevel = legacyCertified ? 'certified' : (profile.staffLevel || 'applicant')
    let onboardingStatus = profile.onboardingStatus || 'application_pending'
    if (approved && staffLevel === 'applicant' && onboardingStatus === 'application_pending') onboardingStatus = 'training_pending'
    if (staffLevel === 'intern' && onboardingStatus !== 'video_audit_pending') onboardingStatus = 'intern'
    return {
      ...profile,
      staffLevel,
      staffLevelText: staffLevelText(staffLevel),
      onboardingStatus,
      onboardingStatusText: onboardingStatusText(onboardingStatus),
      depositStatus: profile.depositStatus || 'unpaid',
      requireDepositRepay: profile.requireDepositRepay === true,
      requireDepositRepayReason: profile.requireDepositRepayReason || '',
      requireDepositRepayAt: profile.requireDepositRepayAt || '',
      supplyReimbursementStatus: profile.supplyReimbursementStatus || 'not_applied',
      videoAuditStatus: profile.videoAuditStatus || 'not_started',
      videoAuditStatusText: videoAuditStatusText(profile.videoAuditStatus || 'not_started'),
      promotionStatus: profile.promotionStatus || 'none',
      promotionStatusText: promotionStatusText(profile.promotionStatus || 'none'),
      internCompletedOrderCount: Number(profile.internCompletedOrderCount || 0)
    }
  }

  function staffDepositSatisfied(profile = {}, depositConfig = null) {
    if (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited') {
      return false
    }
    if (depositConfig && depositConfig.enabled === true && standardAmount(profile, depositConfig.amount) > 0) {
      return profile.depositStatus === 'paid'
    }
    if (profile.depositRequired === true) {
      return profile.depositStatus === 'paid'
    }
    return (!profile.depositRequired || profile.depositStatus === 'paid')
  }

  function staffMoneyEligible(profile = {}, depositConfig = null) {
    if (['requested', 'approved', 'exited'].includes(profile.exitStatus)) return false
    return staffDepositSatisfied(profile, depositConfig)
  }

  function isCertifiedSitter(profile = {}, depositConfig = null) {
    const p = normalizeStaffWorkflow(profile)
    return Boolean(p && staffMoneyEligible(p, depositConfig) && p.auditStatus === 'approved' && p.staffLevel === 'certified')
  }

  function canTakeOrders(profile = {}, depositConfig = null) {
    const p = normalizeStaffWorkflow(profile)
    return Boolean(p && staffMoneyEligible(p, depositConfig) && p.auditStatus === 'approved' && ['intern', 'certified'].includes(p.staffLevel))
  }

  function validateStaffTakeOrderAbility(profile = {}, depositConfig = null) {
    const p = normalizeStaffWorkflow(profile)
    if (!p || p.auditStatus !== 'approved' || !['intern', 'certified'].includes(p.staffLevel)) {
      return { can: false, reason: 'training_pending', message: '完成培训和视频审核成为实习宠托师后方可接单' }
    }
    if (['requested', 'approved', 'exited'].includes(p.exitStatus)) {
      return { can: false, reason: 'exited', message: '当前宠托师账号已申请退出或已退出，无法接单' }
    }
    if (p.requireDepositRepay === true || p.depositStatus === 'supplement_required') {
      const requiredAmount = standardAmount(p, depositConfig && depositConfig.amount)
      const amountTip = requiredAmount > 0 ? `（需补足至¥${requiredAmount.toFixed(2)}）` : ''
      const defaultReason = `平台管理员已要求您重新足额缴纳保证金${amountTip}后方可继续接单，请先完成缴纳`
      const message = p.requireDepositRepayReason
        ? `${p.requireDepositRepayReason}${amountTip ? `，需补足至履约保证金标准¥${requiredAmount.toFixed(2)}后方可恢复接单` : ''}`
        : defaultReason
      return {
        can: false,
        reason: 'deposit_repay_required',
        message
      }
    }
    if (!staffDepositSatisfied(p, depositConfig)) {
      const requiredAmount = standardAmount(p, depositConfig && depositConfig.amount)
      const amountTip = requiredAmount > 0 ? `（需缴纳¥${requiredAmount.toFixed(2)}）` : ''
      return { can: false, reason: 'deposit_unpaid', message: `未缴纳宠托师履约保证金${amountTip}，暂不可抢单或接单，请先缴纳保证金` }
    }
    return { can: true }
  }

  function isTrainingComplete(profile = {}, training = normalizeStaffTrainingConfig()) {
    const p = normalizeStaffWorkflow(profile)
    const progress = p.trainingVideoProgress || {}
    const videos = enabledTrainingVideos(training)
    const allVideosWatched = videos.length === 0 || videos.every((video) => isTrainingVideoWatched(video, progress))
    return Boolean(p && p.quizPassedAt && allVideosWatched)
  }

  return {
    normalizeStaffWorkflow,
    staffDepositSatisfied,
    staffMoneyEligible,
    isCertifiedSitter,
    canTakeOrders,
    validateStaffTakeOrderAbility,
    isTrainingComplete
  }
}
