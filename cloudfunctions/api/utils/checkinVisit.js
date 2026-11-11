const { toTimeValue } = require('./time')

function sanitizationVisit(order = {}) {
  const source = Array.isArray(order.serviceSessions) && order.serviceSessions.length
    ? order.serviceSessions : [{ index: 1, startTime: order.startTime }]
  const sessions = source.map((session, index) => ({ ...session, index: Number(session.index || index + 1),
    status: session.status || (Number(order.lastCompletedSessionIndex || 0) >= Number(session.index || index + 1) ? 'completed' : 'pending') }))
  const beforeStart = ['assigned', 'on_the_way', 'day_completed'].includes(order.status)
  const pending = sessions.find(session => !['completed', 'cancelled'].includes(session.status))
  const session = (beforeStart && pending) ||
    sessions.find(session => session.index === Number(order.activeSessionIndex) || session.status === 'in_service') ||
    sessions.find(session => session.index === Number(order.lastCompletedSessionIndex)) ||
    sessions.filter(session => session.status === 'completed').slice(-1)[0] || sessions[0]
  const previous = sessions.filter(item => item.index < session.index && item.status !== 'cancelled')
  return { index: session.index, scheduledAt: session.startTime || '',
    startedAt: beforeStart && pending ? '' : (session.startedAt || order.currentSessionStartedAt || (session.index === 1 ? order.startedAt : '') || ''),
    previous, hasPrevious: previous.length > 0 || session.index > 1 }
}

function serviceVisit(order = {}) {
  const sessions = (Array.isArray(order.serviceSessions) ? order.serviceSessions : []).map((session, index) => ({ ...session, index: Number(session.index || index + 1) }))
  const active = sessions.find(session => Number(order.activeSessionIndex) === session.index) || sessions.find(session => session.status === 'in_service')
  return {
    index: Number(order.activeSessionIndex || active?.index || order.lastCompletedSessionIndex || 1),
    startedAt: order.currentSessionStartedAt || active?.startedAt || order.startedAt || ''
  }
}

function checkinMatchesVisit(item, order, startedAt = serviceVisit(order).startedAt) {
  const visit = serviceVisit(order)
  if (item.staffOpenid && item.staffOpenid !== order.staffOpenid) return false
  if (item.serviceSessionIndex != null && Number(item.serviceSessionIndex) !== visit.index) return false
  const start = toTimeValue(startedAt)
  if (item.serviceSessionStartedAt && toTimeValue(item.serviceSessionStartedAt) !== start) return false
  return !start || toTimeValue(item.recordedAt || item.serverTime || item.createdAt) >= start - 60000
}

function assertServiceVisit(current, expected) {
  if (current.status !== 'in_service') return
  const actual = serviceVisit(current)
  const snapshot = serviceVisit(expected)
  if (actual.index !== snapshot.index || toTimeValue(actual.startedAt) !== toTimeValue(snapshot.startedAt)) throw Object.assign(new Error('服务场次已变化，请刷新订单'), { code: 'SERVICE_VISIT_CHANGED' })
}

function assertCompletionSnapshot(current, expected) {
  if (Number(current.checkinRevision || 0) !== Number(expected.checkinRevision || 0)) throw Object.assign(new Error('打卡凭证已变化，请刷新并重新确认完成'), { code: 'SERVICE_PROOF_CHANGED' })
  assertServiceVisit(current, expected)
}

module.exports = { serviceVisit, sanitizationVisit, checkinMatchesVisit, assertServiceVisit, assertCompletionSnapshot }
