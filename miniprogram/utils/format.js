const orderStatusText = {
  pending_pay: '待支付',
  paid: '待接单',
  assigned: '已接单',
  in_service: '服务中',
  completed: '已完成',
  cancelled: '已取消'
}

const auditStatusText = {
  pending: '待审核',
  approved: '已通过',
  rejected: '未通过'
}

const incidentStatusText = {
  open: '待处理',
  processing: '处理中',
  resolved: '已解决',
  rejected: '已驳回'
}

const checkinEventText = {
  enter_door: '入户打卡',
  leash_on: '牵引出门',
  feed: '喂食',
  water: '饮水',
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
  client_complaint: '客户投诉',
  staff_sos: '宠托师SOS',
  service_issue: '服务异常'
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

function withOrderText(order) {
  if (!order) return order
  return {
    ...order,
    statusText: formatOrderStatus(order.status, order),
    assignmentSourceText: formatAssignmentSource(order.assignmentSource)
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
  withOrderText,
  withAuditText,
  withIncidentText,
  withCheckinText
}
