const { readDocuments, readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService({ db, now, parseDateValue, releaseWechatTransferQuota }) {
  function cents(value) {
    const amount = Number(value)
    const result = Math.round(amount * 100)
    if (value == null || value === '' || !Number.isSafeInteger(result) || result < 0 || Math.abs(amount * 100 - result) > 0.000001) throw new Error('退款收益金额异常，请核对账务')
    return result
  }
  function releasedStatus(earning) {
    const availableAt = parseDateValue(earning.availableAt)
    return availableAt && availableAt > now() ? 'pending' : 'available'
  }
  async function pendingWithdrawal(tx, earning) {
    const request = earning.withdrawRequestId && await readOptionalDocument(tx, 'withdraw_requests', earning.withdrawRequestId)
    // Once a transfer intent exists, reconcile that payment before changing its ledger.
    if (!request || request.status !== 'pending' || request.outBillNo || request.outDetailNo || request.transferPreparedAt ||
        request.staffOpenid !== earning.staffOpenid || !Array.isArray(request.earningIds) || !request.earningIds.includes(earning._id)) {
      throw new Error('关联收益已进入提现打款流程，请先核实并处理提现后再退款')
    }
    return request
  }
  async function releaseWithdrawal(tx, earning, refundId) {
    const request = await pendingWithdrawal(tx, earning)
    if (!request.earningIds.length || request.earningIds.length > 50 || new Set(request.earningIds).size !== request.earningIds.length) throw new Error('提现关联收益异常')
    const rows = []
    let total = 0
    for (const id of request.earningIds) {
      const row = await readOptionalDocument(tx, 'staff_earnings', id)
      if (!row || row.status !== 'withdrawing' || row.staffOpenid !== request.staffOpenid || row.withdrawRequestId !== request._id || row.frozenIncidentId) throw new Error('提现关联收益状态异常')
      total += cents(row.amount)
      rows.push(row)
    }
    if (!Number.isSafeInteger(total) || total !== cents(request.amount)) throw new Error('提现金额与收益合计不一致')
    const time = now()
    await releaseWechatTransferQuota(tx, request, 'rejected')
    await tx.collection('withdraw_requests').doc(request._id).update({ data: {
      status: 'rejected', auditRemark: '关联订单退款，原提现已撤销，请按剩余收益重新申请',
      refundRejectedBy: refundId, auditedAt: time, updatedAt: time
    } })
    const released = new Map()
    for (const row of rows) {
      const patch = { status: releasedStatus(row), withdrawRequestId: '', updatedAt: time }
      await tx.collection('staff_earnings').doc(row._id).update({ data: patch })
      released.set(row._id, { ...row, ...patch })
    }
    await tx.collection('finance_logs').doc(`refund_withdraw_${request._id}`).set({ data: {
      action: 'withdraw_rejected_for_refund', targetType: 'withdraw_request', targetId: request._id,
      staffOpenid: request.staffOpenid, amountDelta: 0, detail: { refundId, earningIds: request.earningIds }, createdAt: time
    } })
    return released
  }

  async function adjustStaffEarningsForRefund(orderId, refundAmount, totalPayAmount, reason = '', transaction = null, options = {}) {
    if (!orderId) return null
    const phase = options.phase || 'success'
    const refundId = options.refundId || ''
    if (!['reserve', 'success', 'failed'].includes(phase) || (phase !== 'success' && !refundId)) throw new Error('退款收益处理参数异常')
    const execute = async tx => {
      // Read inside the same transaction; database failures must abort reservation/settlement.
      const earnings = await readDocuments(tx, db.command, 'staff_earnings', { orderId }, 51)
      if (earnings.length > 50) throw new Error('订单收益记录超过50笔，请人工核对')
      const refundCents = cents(refundAmount)
      const payCents = cents(totalPayAmount)
      if (!refundCents || !payCents || refundCents > payCents) throw new Error('退款收益金额异常')
      const released = new Map()
      const results = []
      for (const original of earnings) {
        let earning = released.get(original._id) || original
        const holds = Array.isArray(earning.pendingRefundIds) ? earning.pendingRefundIds : []
        if (phase === 'reserve') {
          if (earning.status === 'withdrawing') await pendingWithdrawal(tx, earning)
          await tx.collection('staff_earnings').doc(earning._id).update({ data: { pendingRefundIds: [...new Set([...holds, refundId])], updatedAt: now() } })
          continue
        }
        const remainingHolds = holds.filter(id => id !== refundId)
        if (phase === 'failed') {
          await tx.collection('staff_earnings').doc(earning._id).update({ data: { pendingRefundIds: remainingHolds, updatedAt: now() } })
          continue
        }
        if (earning.status === 'withdrawing') {
          for (const [id, row] of await releaseWithdrawal(tx, earning, refundId)) released.set(id, row)
          earning = released.get(earning._id)
        }
        const amount = cents(earning.amount)
        const base = cents(earning.originalAmount ?? earning.amount)
        const full = refundCents === payCents
        const priorDebt = earning.status === 'withdrawn' ? cents(earning.overpaidDebtAmount || 0) : 0
        const deduction = Math.min(Math.max(0, amount - priorDebt), full ? amount : Math.round(base * refundCents / payCents))
        const time = now()
        const patch = { pendingRefundIds: remainingHolds, updatedAt: time }
        let action
        if (earning.status === 'withdrawn') {
          Object.assign(patch, { hasOverpaidDebt: true, overpaidDebtAmount: (cents(earning.overpaidDebtAmount || 0) + deduction) / 100,
            refundVoidReason: reason || '订单退款，收益已提现转入待追缴' })
          action = 'staff_earning_withdrawn_debt'
        } else {
          Object.assign(patch, { amount: (amount - deduction) / 100, deductedAmount: (cents(earning.deductedAmount || 0) + deduction) / 100,
            status: amount === deduction ? (earning.status === 'frozen' ? 'frozen' : 'refunded_void') : earning.status,
            deductReason: reason ? `退款冲减：${reason}` : '订单退款冲减收益',
            ...(full ? { refundVoidAt: time, refundVoidReason: reason || '订单全额退款，收益作废' } : {}) })
          action = full ? 'staff_earning_voided' : 'staff_earning_partially_refunded'
        }
        await tx.collection('staff_earnings').doc(earning._id).update({ data: patch })
        if (deduction) await tx.collection('finance_logs').doc(`refund_earning_${earning._id}_${refundId || time.getTime()}`).set({ data: {
          action, targetType: 'staff_earning', targetId: earning._id, orderId, staffOpenid: earning.staffOpenid,
          amountDelta: -deduction / 100, detail: { refundId, refundAmount, totalPayAmount, reason }, createdAt: time
        } })
        results.push({ _id: earning._id, action, delta: deduction / 100 })
      }
      return results
    }
    return transaction ? execute(transaction) : db.runTransaction(execute)
  }
  return { adjustStaffEarningsForRefund }
}
