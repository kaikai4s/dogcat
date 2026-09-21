module.exports = function createService({
  safeText
}) {
  function safeNumber(value) {
    const normalized = String(value || 0).replace(/[^0-9.]/g, '')
    const number = Number(normalized || 0)
    return Number.isFinite(number) ? number : 0
  }

  function safeFileId(value) {
    const text = safeText(value)
    return text.startsWith('cloud://') ? text : ''
  }

  function roleText(roles = []) {
    const labels = { client: '用户', staff: '宠托师', admin: '管理员' }
    return (Array.isArray(roles) ? roles : []).map((role) => labels[role] || role).join('、') || '用户'
  }

  function auditStatusText(status) {
    const labels = { approved: '已通过', pending: '待审核', rejected: '未通过', revoked: '已移除' }
    return labels[status] || '未知'
  }

  function staffLevelText(level) {
    const labels = { applicant: '申请人', intern: '实习宠托师', certified: '认证宠托师' }
    return labels[level] || labels.applicant
  }

  function onboardingStatusText(status) {
    const labels = { application_pending: '入驻审核中', training_pending: '待完成培训', quiz_passed: '答题已通过', videos_completed: '视频已完成', video_audit_pending: '视频审核中', intern: '实习中' }
    return labels[status] || labels.application_pending
  }

  function videoAuditStatusText(status) {
    const labels = { not_started: '未申请', pending: '待视频审核', approved: '已通过', rejected: '未通过' }
    return labels[status] || labels.not_started
  }

  function promotionStatusText(status) {
    const labels = { none: '未申请', pending: '转正审核中', approved: '已转正', rejected: '转正未通过' }
    return labels[status] || labels.none
  }

  function matchText(value, keyword) {
    return String(value || '').toLowerCase().includes(keyword)
  }

  function formatHomeCount(count) {
    const value = Number(count || 0)
    if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万`
    return String(value)
  }

  function getMonthDays(monthKey) {
    const matched = String(monthKey || '').match(/^(\d{4})-(\d{2})$/)
    if (!matched) return 31
    return new Date(Number(matched[1]), Number(matched[2]), 0).getDate()
  }

  function defaultCheckinDays(monthKey) {
    const count = getMonthDays(monthKey)
    return Array.from({ length: count }, (_, index) => ({ day: index + 1, rewardType: 'points', points: 5, couponTemplateId: '', couponSnapshot: null, title: `第${index + 1}天奖励`, desc: '签到奖励' }))
  }

  return {
    safeNumber,
    safeFileId,
    roleText,
    auditStatusText,
    staffLevelText,
    onboardingStatusText,
    videoAuditStatusText,
    promotionStatusText,
    matchText,
    formatHomeCount,
    getMonthDays,
    defaultCheckinDays
  }
}
