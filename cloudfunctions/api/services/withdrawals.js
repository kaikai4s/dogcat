module.exports = function createService({
  crypto, db, findByClientRequestId, getClientRequestId, getSystemSettings,
  getUser, now, refreshStaffEarnings, safeText
}) {
  const maxEarnings = 50

  async function readRequest(transaction, id) {
    try {
      return (await transaction.collection('withdraw_requests').doc(id).get()).data || null
    } catch (error) {
      // Only absence is recoverable; network/permission errors must abort.
      if (String(error.message || error.errMsg || error).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }

  function cents(value) {
    const number = Number(value)
    const result = Math.round(number * 100)
    if (!Number.isFinite(number) || !Number.isSafeInteger(result) || result <= 0) throw new Error('提现金额不正确')
    return result
  }

  async function createWithdrawRequest(openid, data = {}) {
    await getUser(openid)
    const clientRequestId = getClientRequestId(data)
    // Preserve idempotency for requests created before deterministic IDs were introduced.
    const previous = await findByClientRequestId('withdraw_requests', { staffOpenid: openid, clientRequestId })
    if (previous) return previous

    const accountName = safeText(data.accountName).trim()
    const accountNo = safeText(data.accountNo).trim()
    if (!accountName || accountName.length < 2 || accountName.length > 50) {
      throw new Error('请填写正确的提现收款人姓名（2-50个字符）')
    }
    if (!accountNo || accountNo.length < 4 || accountNo.length > 50) {
      throw new Error('请填写正确的提现收款账号（4-50个字符）')
    }

    const id = `w_${clientRequestId
      ? crypto.createHash('sha256').update(JSON.stringify([openid, clientRequestId])).digest('hex').slice(0, 32)
      : crypto.randomBytes(16).toString('hex')}`
    const targetCents = data.amount === undefined ? Infinity : cents(data.amount)
    await refreshStaffEarnings(openid)
    const settings = await getSystemSettings()
    const earnings = (await db.collection('staff_earnings')
      .where({ staffOpenid: openid, status: 'available' })
      .orderBy('_id', 'asc').limit(maxEarnings + 1).get()).data || []
    const selected = []
    let totalCents = 0
    for (const earning of earnings) {
      if (totalCents >= targetCents) break
      selected.push(earning)
      totalCents += cents(earning.amount)
      if (!Number.isSafeInteger(totalCents)) throw new Error('提现金额不正确')
    }
    const time = now()

    return db.runTransaction(async transaction => {
      const existing = await readRequest(transaction, id)
      if (existing) return { ...existing, _id: id }
      if (!selected.length) throw new Error('暂无可提现收益')
      if (selected.length > maxEarnings) throw new Error('单次提现最多包含50笔收益，请减少提现金额后分批申请')
      if (totalCents < Math.round(Number(settings.settlement.minWithdrawAmount || 0) * 100)) {
        throw new Error(`最低提现金额 ¥${settings.settlement.minWithdrawAmount}`)
      }
      // Read every record before writing. A competing transaction must retry and revalidate.
      for (const earning of selected) {
        const current = (await transaction.collection('staff_earnings').doc(earning._id).get().catch(() => ({ data: null }))).data
        if (!current || current.staffOpenid !== openid || current.status !== 'available' || current.withdrawRequestId || current.frozenIncidentId || cents(current.amount) !== cents(earning.amount)) {
          throw new Error('收益状态已变化，请刷新后重试')
        }
      }
      const request = {
        staffOpenid: openid, openid, clientRequestId, idempotencyKey: clientRequestId || id,
        amount: totalCents / 100, status: 'pending', earningIds: selected.map(item => item._id),
        accountName,
        accountNo,
        remark: safeText(data.remark).trim(), auditRemark: '', createdAt: time, updatedAt: time
      }
      await transaction.collection('withdraw_requests').doc(id).set({ data: request })
      for (const earning of selected) {
        await transaction.collection('staff_earnings').doc(earning._id).update({
          data: { status: 'withdrawing', withdrawRequestId: id, updatedAt: time }
        })
      }
      await transaction.collection('finance_logs').doc(`withdraw_${id}`).set({ data: {
        action: 'withdraw_requested', targetType: 'withdraw_request', targetId: id,
        orderId: '', staffOpenid: openid, amountDelta: -request.amount,
        detail: { earningIds: request.earningIds }, createdAt: time
      } })
      return { _id: id, ...request }
    })
  }

  return { createWithdrawRequest }
}
