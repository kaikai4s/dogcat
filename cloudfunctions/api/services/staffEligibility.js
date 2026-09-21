module.exports = function createService({
  enabledTrainingVideos,
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
      supplyReimbursementStatus: profile.supplyReimbursementStatus || 'not_applied',
      videoAuditStatus: profile.videoAuditStatus || 'not_started',
      videoAuditStatusText: videoAuditStatusText(profile.videoAuditStatus || 'not_started'),
      promotionStatus: profile.promotionStatus || 'none',
      promotionStatusText: promotionStatusText(profile.promotionStatus || 'none'),
      internCompletedOrderCount: Number(profile.internCompletedOrderCount || 0)
    }
  }

  function staffDepositSatisfied(profile = {}, depositConfig = null) {
    if (depositConfig && depositConfig.enabled === true && Number(depositConfig.amount) > 0) {
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
    if (!staffDepositSatisfied(p, depositConfig)) {
      return { can: false, reason: 'deposit_unpaid', message: '未缴纳宠托师履约保证金，暂不可抢单或接单，请先缴纳保证金' }
    }
    return { can: true }
  }

  function isTrainingComplete(profile = {}, training = normalizeStaffTrainingConfig()) {
    const p = normalizeStaffWorkflow(profile)
    const progress = p.trainingVideoProgress || {}
    const videos = enabledTrainingVideos(training)
    const allVideosWatched = videos.length === 0 || videos.every((video) => progress[video.key] && progress[video.key].watched === true)
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
