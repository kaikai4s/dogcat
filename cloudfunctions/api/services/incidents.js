module.exports = function createService({
  appendFinanceLog,
  checkTextSecurity,
  db,
  getUser,
  now,
  parseDateValue,
  safeText
}) {
  function normalizeIncidentStatus(value, fallback = 'open') {
    const status = safeText(value).trim()
    const allowed = ['open', 'triaging', 'waiting_client', 'waiting_staff', 'processing', 'refund_pending', 'resolved', 'rejected', 'closed']
    return allowed.includes(status) ? status : fallback
  }

  function normalizeIncidentType(value, fallback = 'complaint') {
    const type = safeText(value).trim()
    return ['sos', 'complaint', 'service_issue', 'refund_dispute', 'safety'].includes(type) ? type : fallback
  }

  async function recordIncidentAction(incidentId, action, actorRole, actorOpenid, detail = {}) {
    const time = now()
    await db.collection('incident_actions').add({ data: { incidentId, action, actorRole, actorOpenid, detail, createdAt: time } })
  }

  async function getIncidentForAccess(openid, incidentId) {
    const user = await getUser(openid)
    const incident = (await db.collection('order_incidents').doc(incidentId).get()).data
    if (!incident) throw new Error('纠纷不存在')
    if (user.roles.includes('admin') || incident.clientOpenid === openid || incident.staffOpenid === openid) return { user, incident }
    throw new Error('无权访问纠纷')
  }

  async function appendIncidentComment(incidentId, actorRole, actorOpenid, content, mediaFileIds = []) {
    const text = safeText(content).trim()
    const files = Array.isArray(mediaFileIds) ? mediaFileIds.filter(Boolean).slice(0, 9) : []
    if (!text && !files.length) throw new Error('请填写留言或上传证据')
    if (text) {
      await checkTextSecurity(actorOpenid, text, { scene: 2, label: '留言内容' })
    }
    const time = now()
    const comment = { incidentId, actorRole, actorOpenid, content: text, mediaFileIds: files, createdAt: time }
    const created = await db.collection('incident_comments').add({ data: comment })
    return { _id: created._id, ...comment }
  }

  async function freezeOrderEarnings(orderId, incidentId, time = now()) {
    const res = await db.collection('staff_earnings').where({ orderId }).get()
    const frozen = []
    for (const earning of res.data || []) {
      if (!['pending', 'available'].includes(earning.status)) continue
      await db.collection('staff_earnings').doc(earning._id).update({ data: { status: 'frozen', frozenIncidentId: incidentId, frozenFromStatus: earning.status, updatedAt: time } })
      frozen.push(earning._id)
    }
    if (frozen.length) await appendFinanceLog('staff_earning_frozen', { targetType: 'incident', targetId: incidentId, amountDelta: 0, detail: { orderId, earningIds: frozen } })
    return frozen
  }

  function releasedEarningStatus(earning, time = now()) {
    if (earning.frozenFromStatus && earning.frozenFromStatus !== 'frozen') return earning.frozenFromStatus
    const availableAt = parseDateValue(earning.availableAt)
    return availableAt && availableAt.getTime() > time.getTime() ? 'pending' : 'available'
  }

  async function finalizeIncidentEarnings(incident, decision, deductAmount = 0, remark = '') {
    const earningIds = Array.isArray(incident.frozenEarningIds) ? incident.frozenEarningIds : []
    if (!earningIds.length) return { decision: '', earningIds: [], deductedAmount: 0 }
    const time = now()
    const normalizedDecision = ['release', 'deduct', 'keep_frozen'].includes(decision) ? decision : ''
    if (!normalizedDecision) return { decision: '', earningIds, deductedAmount: 0 }

    let remainingDeduct = normalizedDecision === 'deduct' ? Math.max(Number(deductAmount || 0), 0) : 0
    const frozenEarnings = []
    for (const id of earningIds) {
      try {
        const earning = (await db.collection('staff_earnings').doc(id).get()).data
        if (earning && earning.status === 'frozen') frozenEarnings.push(earning)
      } catch (error) {}
    }
    if (normalizedDecision === 'deduct' && remainingDeduct <= 0) remainingDeduct = frozenEarnings.reduce((sum, earning) => sum + Number(earning.amount || 0), 0)

    const updated = []
    let deductedAmount = 0
    for (const earning of frozenEarnings) {
      const amount = Number(earning.amount || 0)
      let update = { updatedAt: time }
      if (normalizedDecision === 'release') {
        update = { ...update, status: releasedEarningStatus(earning, time), frozenIncidentId: '', frozenFromStatus: '', frozenResolvedAt: time, frozenResolveRemark: remark }
      } else if (normalizedDecision === 'keep_frozen') {
        update = { ...update, frozenResolveRemark: remark }
      } else {
        const currentDeduct = Math.min(amount, remainingDeduct)
        remainingDeduct = Math.max(remainingDeduct - currentDeduct, 0)
        deductedAmount += currentDeduct
        const leftAmount = Math.round((amount - currentDeduct) * 100) / 100
        update = {
          ...update,
          amount: leftAmount,
          deductedAmount: Math.round((Number(earning.deductedAmount || 0) + currentDeduct) * 100) / 100,
          status: leftAmount > 0 ? releasedEarningStatus(earning, time) : 'deducted',
          frozenIncidentId: '',
          frozenFromStatus: '',
          frozenResolvedAt: time,
          frozenResolveRemark: remark
        }
      }
      await db.collection('staff_earnings').doc(earning._id).update({ data: update })
      updated.push(earning._id)
    }
    deductedAmount = Math.round(deductedAmount * 100) / 100
    await appendFinanceLog(`staff_earning_${normalizedDecision}`, { targetType: 'incident', targetId: incident._id, orderId: incident.orderId, amountDelta: normalizedDecision === 'deduct' ? -deductedAmount : 0, detail: { earningIds: updated, deductedAmount, remark } })
    return { decision: normalizedDecision, earningIds: updated, deductedAmount }
  }

  return {
    normalizeIncidentStatus,
    normalizeIncidentType,
    recordIncidentAction,
    getIncidentForAccess,
    appendIncidentComment,
    freezeOrderEarnings,
    releasedEarningStatus,
    finalizeIncidentEarnings
  }
}
