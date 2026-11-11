const { toTimeValue } = require('./time')

function keyReturnScope(order = {}) {
  const sessions = (Array.isArray(order.serviceSessions) ? order.serviceSessions : [])
    .map((session, index) => ({ ...session, index: Number(session.index || index + 1) }))
  const activeIndex = Number(order.activeSessionIndex || 0)
  const active = sessions.find(session => session.index === activeIndex) ||
    sessions.find(session => session.status === 'in_service')
  const sessionIndex = Number(active?.index || activeIndex || 1)
  return { sessionIndex, sessionStartedAt: order.currentSessionStartedAt || active?.startedAt ||
    (sessionIndex === 1 ? order.startedAt : '') }
}

function keyReturnRecords(key = {}) {
  const records = Array.isArray(key.returnRecords) ? key.returnRecords : []
  if (!key.returnedAt || records.some(record => record.returnedAt === key.returnedAt &&
      Number(record.sessionIndex || 0) === Number(key.returnedSessionIndex || 0))) return records
  return [...records, { sessionIndex: Number(key.returnedSessionIndex || 0),
    sessionStartedAt: key.returnedSessionStartedAt || '', staffOpenid: key.returnedStaffOpenid || '',
    returnedAt: key.returnedAt, returnImageFileIds: key.returnImageFileIds || [], returnNote: key.returnNote || '' }]
}

function findKeyReturn(key, scope, staffOpenid) {
  const startedAt = toTimeValue(scope.sessionStartedAt)
  return keyReturnRecords(key).find(record => {
    const returnedAt = toTimeValue(record.returnedAt)
    return returnedAt > 0 && (!startedAt || returnedAt >= startedAt) &&
      (!record.sessionIndex || Number(record.sessionIndex) === Number(scope.sessionIndex)) &&
      (!record.sessionStartedAt || toTimeValue(record.sessionStartedAt) === startedAt) &&
      (!record.staffOpenid || record.staffOpenid === staffOpenid) &&
      Array.isArray(record.returnImageFileIds) && record.returnImageFileIds.length > 0
  }) || null
}

function currentKeyReturn(key, order, sessionStartedAt) {
  const scope = keyReturnScope(order)
  if (sessionStartedAt) scope.sessionStartedAt = sessionStartedAt
  // A historical multi-day receipt without an active visit start is ambiguous.
  if ((order.serviceSessions || []).length > 1 && !toTimeValue(scope.sessionStartedAt)) return null
  return findKeyReturn(key, scope, order.staffOpenid)
}

module.exports = { keyReturnScope, keyReturnRecords, findKeyReturn, currentKeyReturn }
