const orderStatusText = {
  pending_pay: '待支付',
  paid: '待接单',
  assigned: '已接单',
  in_service: '服务中',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期'
}

const auditStatusText = {
  pending: '待审核',
  approved: '已通过',
  rejected: '未通过'
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
  enter_door: '入户打卡',
  leash_on: '牵引出门',
  feed: '喂食',
  water: '饮水',
  clean: '清洁打卡',
  medicine: '喂药打卡',
  pet_status: '宠物状态',
  return_home: '回家入户',
  leave_door: '离户闭锁',
  video_checkin: '视频打卡'
}

const assignmentSourceText = {
  staff_accept: '宠托师抢单',
  admin_assign: '管理员派单',
  direct_accept: '指定宠托师接单'
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

function formatOrderStatus(status, order = {}) {
  if (status === 'paid' && order.publishMode === 'direct') return '待指定宠托师接单'
  if (status === 'paid') return '待附近宠托师接单'
  return orderStatusText[status] || status || ''
}

function formatAuditStatus(status) {
  return auditStatusText[status] || status || ''
}

function formatIncidentStatus(status) {
  return incidentStatusText[status] || status || ''
}

function formatCheckinEvent(eventType) {
  return checkinEventText[eventType] || eventType || ''
}

function formatAssignmentSource(source) {
  return assignmentSourceText[source] || source || ''
}

function formatIncidentType(type) {
  return incidentTypeText[type] || type || '异常事件'
}

function formatIncidentAction(action) {
  return incidentActionText[action] || action || '操作记录'
}

function formatDateTime(value) {
  if (!value) return ''
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return String(value || '')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
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
  return {
    ...order,
    statusText: formatOrderStatus(order.status, order),
    assignmentSourceText: formatAssignmentSource(order.assignmentSource),
    createdAtText: formatDateTime(order.createdAt),
    appointmentTimeText: formatAppointmentTime(order)
  }
}

function withAuditText(item) {
  if (!item) return item
  return { ...item, auditStatusText: formatAuditStatus(item.auditStatus) }
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
  return { ...item, eventTypeText: formatCheckinEvent(item.eventType) }
}

module.exports = {
  formatOrderStatus,
  formatAuditStatus,
  formatIncidentStatus,
  formatCheckinEvent,
  formatAssignmentSource,
  formatIncidentType,
  formatIncidentAction,
  formatDateTime,
  formatAppointmentTime,
  withOrderText,
  withAuditText,
  withIncidentText,
  withIncidentActionText,
  withCheckinText
}
