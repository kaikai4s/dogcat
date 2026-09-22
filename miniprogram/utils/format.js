const orderStatusText = {
  pending_pay: '待支付',
  unpaid: '待支付',
  paying: '支付中',
  paid: '待接单',
  assigned: '已接单',
  in_service: '服务中',
  day_completed: '当天已完成',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
  refunding: '退款中',
  refunded: '已退款',
  refund_applied: '退款申请中',
  refund_pending: '待退款',
  partial_refunded: '部分退款',
  pending_ship: '待发货',
  shipped: '已发货',
  auto_completed: '已自动完成',
  closed: '已关闭',
  timeout_closed: '超时关闭'
}

const auditStatusText = {
  pending: '待审核',
  approved: '已通过',
  rejected: '未通过',
  revoked: '已移除身份'
}

const paymentStatusText = {
  unpaid: '未支付',
  paying: '支付中',
  paid: '已支付',
  refunding: '退款中',
  refunded: '已退款',
  partial_refunded: '部分退款',
  failed: '支付失败',
  closed: '已关闭'
}

const staffLevelText = {
  applicant: '申请人',
  intern: '实习宠托师',
  certified: '认证宠托师'
}

const onboardingStatusText = {
  application_pending: '入驻审核中',
  training_pending: '待完成培训',
  quiz_passed: '答题已通过',
  videos_completed: '视频已完成',
  video_audit_pending: '视频审核中',
  intern: '实习中'
}

const videoAuditStatusText = {
  not_started: '未申请',
  pending: '待视频审核',
  approved: '已通过',
  rejected: '未通过'
}

const promotionStatusText = {
  none: '未申请',
  pending: '转正审核中',
  approved: '已转正',
  rejected: '转正未通过'
}

const incidentStatusText = {
  open: '待处理',
  triaging: '分诊中',
  waiting_client: '待客户补充',
  waiting_staff: '待宠托师补充',
  processing: '处理中',
  refund_pending: '退款处理中',
  resolved: '已解决',
  rejected: '已驳回',
  closed: '已关闭'
}

const checkinEventText = {
  sanitization: '隔离病菌/消毒打卡',
  enter_door: '入户打卡',
  leash_on: '牵引出门',
  feed: '喂食',
  water: '饮水',
  clean: '清洁打卡',
  medicine: '喂药打卡',
  pet_status: '宠物状态',
  return_home: '回家入户',
  leave_door: '离户闭锁',
  video_checkin: '视频打卡',
  pet_beauty_photo: '宠物美照'
}

const assignmentSourceText = {
  staff_accept: '宠托师抢单',
  open_grab: '普通抢单',
  urgent_grab: '加急揭榜抢单',
  admin_assign: '管理员派单',
  direct_accept: '指定宠托师接单',
  admin_urgent_republish: '平台转加急抢单'
}

const incidentTypeText = {
  sos: 'SOS紧急协助',
  complaint: '客户投诉',
  client_complaint: '客户投诉',
  staff_sos: '宠托师SOS',
  service_issue: '服务异常',
  refund_dispute: '退款争议',
  safety: '安全问题'
}

const incidentActionText = {
  created_sos: '宠托师发起 SOS',
  created_complaint: '宠物主发起投诉',
  commented: '新增留言',
  evidence_uploaded: '补充证据',
  status_updated: '状态更新',
  resolution_proposed: '提出处理方案',
  coupon_issued: '发放补偿优惠券',
  earning_frozen: '冻结收益',
  earning_release: '解冻收益',
  earning_deduct: '扣减收益',
  earning_keep_frozen: '继续冻结收益',
  refund_created: '发起退款',
  refund_linked: '关联退款',
  closed: '工单结案'
}

const refundStatusText = {
  none: '无退款',
  requested: '退款申请中',
  applied: '退款申请中',
  pending: '退款申请中',
  pending_manual: '待人工退款',
  processing: '退款中',
  approved: '已同意退款',
  rejected: '退款已驳回',
  refunded: '已退款',
  success: '退款成功',
  full_refunded: '全额退款',
  partially_refunded: '部分退款',
  failed: '退款失败',
  cancelled: '已取消退款'
}

function formatOrderStatus(status, order = {}) {
  const normalized = String(status || '').toLowerCase().trim()
  if (normalized === 'paid' && order.publishMode === 'direct') return '待指定宠托师接单'
  if (normalized === 'paid') return '待附近宠托师接单'
  if (order.autoCompleted && (normalized === 'completed' || normalized === 'day_completed')) return '已自动完成'
  if (orderStatusText[normalized]) return orderStatusText[normalized]
  if (order.refundStatus === 'approved' || order.paymentStatus === 'refunded' || normalized.includes('refund')) return '已退款'
  if (order.paymentStatus === 'refunding') return '退款中'
  return normalized ? '处理中' : ''
}

function formatAuditStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return auditStatusText[normalized] || (normalized ? '处理中' : '')
}

function formatPaymentStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return paymentStatusText[normalized] || (normalized ? '处理中' : '')
}

function formatRefundStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return refundStatusText[normalized] || (normalized ? '退款处理中' : '')
}

function formatStaffLevel(level) {
  const normalized = String(level || '').toLowerCase().trim()
  return staffLevelText[normalized] || staffLevelText.applicant
}

function formatOnboardingStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return onboardingStatusText[normalized] || onboardingStatusText.application_pending
}

function formatVideoAuditStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return videoAuditStatusText[normalized] || videoAuditStatusText.not_started
}

function formatPromotionStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return promotionStatusText[normalized] || promotionStatusText.none
}

function formatIncidentStatus(status) {
  const normalized = String(status || '').toLowerCase().trim()
  return incidentStatusText[normalized] || (normalized ? '处理中' : '')
}

function formatCheckinEvent(eventType) {
  const normalized = String(eventType || '').toLowerCase().trim()
  return checkinEventText[normalized] || (normalized ? '照护打卡' : '')
}

function formatAssignmentSource(source) {
  const normalized = String(source || '').toLowerCase().trim()
  return assignmentSourceText[normalized] || (normalized ? '系统分配' : '')
}

function formatIncidentType(type) {
  const normalized = String(type || '').toLowerCase().trim()
  return incidentTypeText[normalized] || '异常事件'
}

function formatIncidentAction(action) {
  const normalized = String(action || '').toLowerCase().trim()
  return incidentActionText[normalized] || '操作记录'
}

function toBeijingDate(value) {
  if (!value) return null
  if (value instanceof Date) return new Date(value.getTime() + 8 * 60 * 60 * 1000)
  if (typeof value === 'number') return new Date(value + 8 * 60 * 60 * 1000)
  const text = String(value).trim()
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text)
    return new Date((text.length === 10 ? num * 1000 : num) + 8 * 60 * 60 * 1000)
  }
  const localMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localMatch
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
  }
  const normalizedText = text.replace(/-/g, '/').replace('T', ' ')
  const time = new Date(normalizedText).getTime()
  return Number.isFinite(time) ? new Date(time + 8 * 60 * 60 * 1000) : null
}

function formatDateTime(value) {
  if (!value) return ''
  const date = toBeijingDate(value)
  if (!date) return String(value || '')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function formatAppointmentTime(order = {}) {
  const start = order.startTime || ''
  const end = order.endTime || ''
  if (!start && !end) return ''
  if (!end) return formatDateTime(start)
  const startText = formatDateTime(start)
  const endText = formatDateTime(end)
  if (!startText) return endText
  if (!endText) return startText
  return `${startText} 至 ${endText.slice(6)}`
}

function withOrderText(order) {
  if (!order) return order
  const autoCompleted = order.autoCompleted === true
  const isOverdue = order.isOverdue === true || order.isStartOverdue === true || order.isFinishOverdue === true
  return {
    ...order,
    autoCompleted,
    isOverdue,
    autoCompletedText: autoCompleted ? '系统自动结算' : '',
    statusText: formatOrderStatus(order.status, order),
    paymentStatusText: formatPaymentStatus(order.paymentStatus || 'unpaid'),
    refundStatusText: formatRefundStatus(order.refundStatus),
    assignmentSourceText: formatAssignmentSource(order.assignmentSource),
    urgentGrabDurationText: order.urgentGrabDurationSeconds != null
      ? (order.urgentGrabDurationSeconds < 60
          ? `${order.urgentGrabDurationSeconds}秒`
          : `${Math.ceil(order.urgentGrabDurationSeconds / 60)}分钟`)
      : '',
    createdAtText: formatDateTime(order.createdAt),
    appointmentTimeText: formatAppointmentTime(order)
  }
}

function withAuditText(item) {
  if (!item) return item
  return { ...item, auditStatusText: formatAuditStatus(item.auditStatus) }
}

function withStaffWorkflowText(item) {
  if (!item) return item
  const staffLevel = item.staffLevel || (item.auditStatus === 'approved' ? 'certified' : 'applicant')
  const onboardingStatus = item.onboardingStatus || (item.auditStatus === 'approved' ? 'intern' : 'application_pending')
  const videoAuditStatus = item.videoAuditStatus || 'not_started'
  const promotionStatus = item.promotionStatus || 'none'
  return {
    ...item,
    auditStatusText: formatAuditStatus(item.auditStatus),
    staffLevel,
    staffLevelText: formatStaffLevel(staffLevel),
    onboardingStatus,
    onboardingStatusText: formatOnboardingStatus(onboardingStatus),
    videoAuditStatus,
    videoAuditStatusText: formatVideoAuditStatus(videoAuditStatus),
    promotionStatus,
    promotionStatusText: formatPromotionStatus(promotionStatus)
  }
}

function withIncidentText(item) {
  if (!item) return item
  return { ...item, statusText: formatIncidentStatus(item.status), incidentTypeText: formatIncidentType(item.incidentType) }
}

function withIncidentActionText(item) {
  if (!item) return item
  const detail = item.detail || {}
  const detailParts = []
  if (detail.status) detailParts.push(formatIncidentStatus(detail.status))
  if (detail.refundAmount) detailParts.push(`退款 ¥${detail.refundAmount}`)
  if (detail.deductedAmount) detailParts.push(`扣减 ¥${detail.deductedAmount}`)
  if (detail.couponTemplateId) detailParts.push('优惠券补偿')
  if (detail.closeRemark) detailParts.push(detail.closeRemark)
  if (detail.remark) detailParts.push(detail.remark)
  return { ...item, actionText: formatIncidentAction(item.action), actorRoleText: ({ admin: '后台', staff: '宠托师', client: '宠物主', system: '系统' })[item.actorRole] || item.actorRole || '', detailText: detailParts.join(' · ') }
}

function withCheckinText(item) {
  if (!item) return item
  return { ...item, eventTypeText: formatCheckinEvent(item.eventType), recordedAtText: formatDateTime(item.recordedAt || item.createdAt || item.serverTime) }
}

module.exports = {
  formatOrderStatus,
  formatAuditStatus,
  formatPaymentStatus,
  formatRefundStatus,
  formatStaffLevel,
  formatOnboardingStatus,
  formatVideoAuditStatus,
  formatPromotionStatus,
  formatIncidentStatus,
  formatCheckinEvent,
  formatAssignmentSource,
  formatIncidentType,
  formatIncidentAction,
  toBeijingDate,
  formatDateTime,
  formatAppointmentTime,
  withOrderText,
  withAuditText,
  withStaffWorkflowText,
  withIncidentText,
  withIncidentActionText,
  withCheckinText
}
