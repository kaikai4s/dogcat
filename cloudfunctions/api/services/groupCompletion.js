const crypto = require('crypto')
const { readDocuments } = require('../utils/documentPages')

module.exports = function createGroupCompletion({ db, now, normalizeServiceSessions, markServiceSession,
  isFinalServiceSession, evaluateCheckinCompletion, completeSingleOrderService, appendOrderTimeline, appendOrderClientMessage, toTimeValue }) {
  function ready(order) {
    const sessions = normalizeServiceSessions(order)
    return order.status === 'completed' || (order.status === 'day_completed' && sessions.length > 0 && sessions.every(s => s.status === 'completed'))
  }

  function readySession(order) {
    const sessions = normalizeServiceSessions(order)
    return order.groupCompletionSession || sessions.find(s => s.index === Number(order.lastCompletedSessionIndex)) || sessions[sessions.length - 1]
  }

  async function finishGroup(order, activeSession, time = now(), options = {}) {
    const state = await db.runTransaction(async tx => {
      const current = (await tx.collection('orders').doc(order._id).get()).data
      if (!current || !current.staffOpenid || current.staffOpenid !== order.staffOpenid || current.groupBuyId !== order.groupBuyId) throw new Error('拼单归属已变化，请刷新后重试')
      const rows = await readDocuments(tx, db.command, 'orders', { groupBuyId: current.groupBuyId })
      let members = rows.filter(member => !member.deletedAt && !member.adminDeletedAt && !member.groupBuyRefundRequired &&
        member.paymentStatus === 'paid' && !['pending_pay', 'cancelled', 'closed', 'refunded', 'expired'].includes(member.status))
      if (!members.some(member => member._id === order._id) || members.some(member => member.staffOpenid !== order.staffOpenid)) throw new Error('拼单成员或宠托师归属异常，请联系平台')
      let staged = false
      if (!ready(current)) {
        if (current.status !== 'in_service' || !activeSession || !isFinalServiceSession(current, activeSession)) throw new Error('拼单住户还有未完成的服务场次')
        const currentIndex = Number(current.activeSessionIndex || 0)
        if ((currentIndex && currentIndex !== Number(activeSession.index)) ||
          toTimeValue(current.currentSessionStartedAt || current.startedAt) !== toTimeValue(order.currentSessionStartedAt || order.startedAt)) throw new Error('服务场次已变化，请刷新后重试')
        const checkins = await evaluateCheckinCompletion(current, toTimeValue(current.currentSessionStartedAt || activeSession.startedAt || current.startedAt))
        if (!checkins.isComplete) throw new Error(`缺少必打卡照片：${checkins.missing.join('、')}`)
        const session = { ...activeSession, startedAt: activeSession.startedAt || current.currentSessionStartedAt || current.startedAt || '', finishedAt: time }
        const patch = { status: 'day_completed', serviceSessions: markServiceSession(normalizeServiceSessions(current), session.index, { status: 'completed', finishedAt: time }),
          groupCompletionSession: session, groupCompletionPending: false, groupCompletionIsAuto: options.isAuto === true,
          activeSessionIndex: 0, activeSessionDate: '', currentSessionStartedAt: '', lastCompletedSessionIndex: session.index, updatedAt: time }
        await tx.collection('orders').doc(order._id).update({ data: patch })
        members = members.map(member => member._id === order._id ? { ...current, ...patch } : member)
        staged = true
      }
      // A common write prevents two simultaneous households both waiting forever.
      const group = (await tx.collection('pet_playground_groups').doc(current.groupBuyId).get().catch(error => {
        if (String(error.message || error.errMsg).includes(`document with _id ${current.groupBuyId} does not exist`)) return { data: null }
        throw error
      })).data
      if (group) await tx.collection('pet_playground_groups').doc(current.groupBuyId).update({ data: { completionRevision: crypto.randomBytes(16).toString('hex') } })
      const remaining = members.filter(member => !ready(member)).length
      if (!remaining) {
        for (const member of members) {
          if (member.status !== 'completed') await tx.collection('orders').doc(member._id).update({ data: { groupCompletionPending: true } })
        }
      }
      return { members, staged, remaining }
    })
    if (state.remaining) {
      if (state.staged) {
        await appendOrderTimeline(order._id, 'day_completed', '住户服务打卡已完成', '等待同拼单团其他住户打卡完毕后统一结算。', options.actor || 'staff')
        await appendOrderClientMessage({ ...order, status: 'day_completed' }, { eventType: 'day_completed', title: '服务打卡已完成', detail: '当前住户打卡已完成，等待同团住户完成后统一结算。', actorRole: options.actor || 'staff' })
      }
      return { id: order._id, status: 'day_completed', partialGroupCompleted: true, remainingCount: state.remaining,
        message: `当前住户打卡完成！同拼单团还有 ${state.remaining} 户未完成打卡，请切换至下一住户继续服务。` }
    }
    let currentResult
    for (const member of state.members) {
      const session = readySession(member)
      if (!session) throw new Error('拼单服务场次缺失，请联系平台')
      const isAuto = member.groupCompletionIsAuto === true
      // Each settlement is idempotent. A failure remains visible and retryable,
      // including when the entry household has already reached completed.
      const finishedAt = toTimeValue(session.finishedAt)
      const result = await completeSingleOrderService(member, session, finishedAt ? new Date(finishedAt) : time, { isAuto, actor: isAuto ? 'system' : 'staff' })
      if (member._id === order._id) currentResult = result
    }
    await db.runTransaction(async tx => {
      for (const member of state.members) {
        const current = (await tx.collection('orders').doc(member._id).get()).data
        if (!current || current.status !== 'completed' || current.staffOpenid !== order.staffOpenid) throw new Error('拼单结算状态已变化，请重试')
        await tx.collection('orders').doc(member._id).update({ data: { groupCompletionPending: false } })
      }
    })
    return { ...currentResult, allGroupCompleted: true, message: '同小区拼单全部住户服务已完成！收益已统一结算。' }
  }

  async function retryPendingGroupCompletions() {
    const rows = (await db.collection('orders').where({ groupCompletionPending: true, status: db.command.in(['day_completed', 'completed']) }).orderBy('updatedAt', 'asc').limit(30).get()).data || []
    const groups = new Set()
    for (const order of rows) {
      if (!order.groupBuyId || groups.has(order.groupBuyId)) continue
      groups.add(order.groupBuyId)
      try {
        if (ready(order)) await finishGroup(order, readySession(order), now(), { isAuto: order.groupCompletionIsAuto === true })
      } catch (error) {
        console.error('[group-completion-retry]', { groupId: order.groupBuyId, message: error.message })
        // Rotate failed rows so one damaged group cannot starve later retries.
        await db.collection('orders').doc(order._id).update({ data: { updatedAt: now() } })
      }
    }
    return groups.size
  }
  return { finishGroup, retryPendingGroupCompletions, isGroupMemberReady: ready }
}
