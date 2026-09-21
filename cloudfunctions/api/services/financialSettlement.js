module.exports = function createService({ db, now, parseDateValue, safeText }) {
  function cents(value, positive = false) {
    const amount = Number(value)
    const result = Math.round(amount * 100)
    if (value == null || value === '' || !Number.isFinite(amount) || !Number.isSafeInteger(result) || Math.abs(amount * 100 - result) > 0.000001 ||
        amount < 0 || (positive && result <= 0)) throw new Error('金额不正确，请核对财务记录')
    return result
  }

  function ids(value, required = false) {
    if (!Array.isArray(value) || value.length > 50 || (required && !value.length) ||
        value.some(id => typeof id !== 'string' || !id) || new Set(value).size !== value.length) {
      throw new Error('收益关联记录异常或超过50笔，请人工核对')
    }
    return value
  }

  function releasedStatus(earning, time) {
    const availableAt = parseDateValue(earning.availableAt)
    return availableAt && availableAt > time ? 'pending' : 'available'
  }

  async function financeLog(tx, id, action, targetType, targetId, time, payload = {}) {
    await tx.collection('finance_logs').doc(id).set({ data: {
      action, targetType, targetId, amountDelta: 0, createdAt: time, ...payload
    } })
  }

  async function settleWithdrawal(admin, data, paid = false) {
    const target = paid ? 'paid' : (data.approved === true ? 'approved' : 'rejected')
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.status === target) return { request, changed: false }
      if (request.status !== (paid ? 'approved' : 'pending')) throw new Error(paid ? '仅已审核提现可标记打款' : '当前状态不可审核')
      const earningIds = ids(request.earningIds, true)
      const earnings = []
      let total = 0
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || !request.staffOpenid || earning.staffOpenid !== request.staffOpenid ||
            earning.withdrawRequestId !== data.id || earning.status !== 'withdrawing' || earning.frozenIncidentId) {
          throw new Error('收益状态或提现归属异常，请核对后重试')
        }
        total += cents(earning.amount, true)
        earnings.push(earning)
      }
      if (!Number.isSafeInteger(total) || total !== cents(request.amount, true)) throw new Error('提现金额与收益合计不一致')
      const time = now()
      const patch = paid
        ? { status: target, paidAt: time, paidByOpenid: admin.openid, payRemark: safeText(data.payRemark).trim(), updatedAt: time }
        : { status: target, auditedAt: time, auditedByOpenid: admin.openid, auditRemark: safeText(data.auditRemark).trim(), updatedAt: time }
      await tx.collection('withdraw_requests').doc(data.id).update({ data: patch })
      // Approval also writes the earnings, making it conflict with concurrent freezes.
      for (const earning of earnings) {
        await tx.collection('staff_earnings').doc(earning._id).update({ data: {
          status: paid ? 'withdrawn' : target === 'rejected' ? releasedStatus(earning, time) : 'withdrawing',
          withdrawRequestId: target === 'rejected' ? '' : data.id, updatedAt: time
        } })
      }
      const action = `withdraw_${target}`
      await financeLog(tx, `${action}_${data.id}`, action, 'withdraw_request', data.id, time, {
        staffOpenid: request.staffOpenid, amountDelta: paid ? -total / 100 : 0,
        detail: { earningIds, auditRemark: patch.auditRemark || '', payRemark: patch.payRemark || '' }
      })
      await tx.collection('admin_operation_logs').doc(`${action}_${data.id}`).set({ data: {
        adminUserId: admin._id, adminOpenid: admin.openid, targetType: 'withdraw_request', targetId: data.id,
        action: paid ? 'markWithdrawPaid' : 'auditWithdrawRequest', detail: { amount: total / 100, approved: data.approved === true }, createdAt: time
      } })
      return { request: { ...request, ...patch }, changed: true }
    })
  }

  async function freezeIncidentEarnings(incidentId, actorOpenid) {
    return db.runTransaction(async tx => {
      const incident = (await tx.collection('order_incidents').doc(incidentId).get()).data
      if (!incident) throw new Error('纠纷不存在')
      if (['closed', 'resolved', 'rejected'].includes(incident.status)) throw new Error('已结案纠纷不可新增冻结')
      if (['release', 'deduct'].includes(incident.earningResolution?.decision)) throw new Error('收益已处理，请新建纠纷后再操作')
      // Candidate discovery is bounded; point reads inside the transaction revalidate ownership.
      const rows = (await db.collection('staff_earnings').where({ orderId: incident.orderId }).orderBy('_id', 'asc').limit(51).get()).data || []
      const earningIds = ids([...new Set([...(incident.frozenEarningIds || []), ...rows.map(row => row._id)])])
      const earnings = []
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || !incident.staffOpenid || earning.orderId !== incident.orderId || earning.staffOpenid !== incident.staffOpenid) throw new Error('收益归属异常')
        if (earning.withdrawRequestId || ['withdrawing', 'withdrawn'].includes(earning.status)) throw new Error('收益正在提现或已打款，请先核对提现单，不能直接冻结')
        if (earning.status === 'frozen' && earning.frozenIncidentId === incidentId) continue
        if (!['pending', 'available'].includes(earning.status) || earning.frozenIncidentId) throw new Error('收益已被其他纠纷冻结或不可冻结')
        earnings.push(earning)
      }
      if (!earnings.length) return { id: incidentId, frozenEarningIds: earningIds }
      const time = now()
      const revision = Number(incident.earningRevision || 0) + 1
      for (const earning of earnings) {
        await tx.collection('staff_earnings').doc(earning._id).update({ data: {
          status: 'frozen', frozenIncidentId: incidentId, frozenFromStatus: earning.status, updatedAt: time
        } })
      }
      await tx.collection('order_incidents').doc(incidentId).update({ data: { frozenEarningIds: earningIds, earningRevision: revision, updatedAt: time } })
      await financeLog(tx, `freeze_${incidentId}_${revision}`, 'staff_earning_frozen', 'incident', incidentId, time, { orderId: incident.orderId, detail: { earningIds } })
      await tx.collection('incident_actions').doc(`freeze_${incidentId}_${revision}`).set({ data: {
        incidentId, action: 'earning_frozen', actorRole: 'admin', actorOpenid, detail: { earningIds }, createdAt: time
      } })
      return { id: incidentId, frozenEarningIds: earningIds }
    })
  }

  async function closeIncidentFinancially(incidentId, data, actorOpenid) {
    const decision = safeText(data.earningDecision).trim()
    if (decision && !['release', 'deduct', 'keep_frozen'].includes(decision)) throw new Error('收益处理方式不正确')
    const requested = decision === 'deduct' ? cents(data.deductAmount === undefined ? 0 : data.deductAmount) : 0
    return db.runTransaction(async tx => {
      const incident = (await tx.collection('order_incidents').doc(incidentId).get()).data
      if (!incident) throw new Error('纠纷不存在')
      const previous = incident.earningResolution
      if (previous && ['release', 'deduct'].includes(previous.decision)) {
        if (decision !== previous.decision || (decision === 'deduct' && requested !== incident.requestedDeductCents)) throw new Error('收益已处理，不能重复变更')
        return { id: incidentId, status: incident.status, earningResolution: previous }
      }
      if (incident.closedAt && decision === (previous?.decision || '') && incident.status === data.status &&
          incident.closeRemark === safeText(data.closeRemark).trim()) {
        return { id: incidentId, status: incident.status, earningResolution: previous || null }
      }
      const earningIds = ids(incident.frozenEarningIds || [])
      const earnings = []
      let total = 0
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || !incident.staffOpenid || earning.orderId !== incident.orderId || earning.staffOpenid !== incident.staffOpenid ||
            earning.status !== 'frozen' || earning.frozenIncidentId !== incidentId || earning.withdrawRequestId) throw new Error('冻结收益归属或状态异常，请核对后重试')
        total += cents(earning.amount)
        earnings.push(earning)
      }
      if (!Number.isSafeInteger(total)) throw new Error('金额不正确')
      if (decision === 'deduct' && !earningIds.length) throw new Error('没有可扣减的冻结收益')
      if (decision === 'deduct' && requested > total) throw new Error('扣减金额不能超过冻结收益')
      const deduction = decision === 'deduct' ? (requested || total) : 0
      let remaining = deduction
      const time = now()
      const remark = safeText(data.earningRemark || data.closeRemark).trim()
      for (const earning of earnings) {
        if (!decision || decision === 'keep_frozen') continue
        const amount = cents(earning.amount)
        const taken = Math.min(amount, remaining)
        remaining -= taken
        const patch = { status: releasedStatus(earning, time), frozenIncidentId: '', frozenFromStatus: '', frozenResolvedAt: time, frozenResolveRemark: remark, updatedAt: time }
        if (decision === 'deduct') {
          const accumulated = cents(earning.deductedAmount || 0) + taken
          if (!Number.isSafeInteger(accumulated)) throw new Error('金额不正确')
          Object.assign(patch, { amount: (amount - taken) / 100, deductedAmount: accumulated / 100, status: amount > taken ? patch.status : 'deducted' })
        }
        await tx.collection('staff_earnings').doc(earning._id).update({ data: patch })
      }
      const resolution = decision ? { decision, earningIds, deductedAmount: deduction / 100 } : null
      const revision = Number(incident.earningRevision || 0) + 1
      const patch = { status: data.status, closeRemark: safeText(data.closeRemark).trim(), closedAt: time, updatedAt: time, earningRevision: revision }
      if (resolution) Object.assign(patch, { earningResolution: resolution, requestedDeductCents: requested })
      await tx.collection('order_incidents').doc(incidentId).update({ data: patch })
      if (resolution) await financeLog(tx, `resolve_${incidentId}_${revision}`, `staff_earning_${decision}`, 'incident', incidentId, time, { orderId: incident.orderId, amountDelta: -deduction / 100, detail: { ...resolution, remark } })
      if (resolution) await tx.collection('incident_actions').doc(`resolve_${incidentId}_${revision}`).set({ data: {
        incidentId, action: `earning_${decision}`, actorRole: 'admin', actorOpenid, detail: resolution, createdAt: time
      } })
      await tx.collection('incident_actions').doc(`close_${incidentId}_${revision}`).set({ data: {
        incidentId, action: 'closed', actorRole: 'admin', actorOpenid, detail: { ...patch }, createdAt: time
      } })
      await tx.collection('order_timeline').doc(`incident_${incidentId}_${revision}`).set({ data: {
        orderId: incident.orderId, type: 'incident_closed', title: '纠纷已结案', detail: patch.closeRemark || patch.status, actorRole: 'admin', createdAt: time
      } })
      return { id: incidentId, status: patch.status, earningResolution: resolution }
    })
  }

  return { settleWithdrawal, freezeIncidentEarnings, closeIncidentFinancially }
}
