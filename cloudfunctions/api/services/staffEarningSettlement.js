const { readDocuments, readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService({ db, crypto, now, safeText, refreshStaffEarnings,
  getSystemSettings, getWechatTransferConfig, createWithdrawRequest, settleWithdrawal,
  submitWechatWithdrawalTransfer, queryWechatWithdrawalTransfer }) {
  const cents = value => {
    const amount = Number(value)
    const result = Math.round(amount * 100)
    if (!Number.isSafeInteger(result) || result < 0 || Math.abs(amount * 100 - result) > 1e-6) throw new Error('收益金额异常，请先核对账目')
    return result
  }
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)

  async function getStaffSettlementPreview(staffProfileId) {
    const profile = (await db.collection('staff_profiles').doc(staffProfileId).get()).data
    if (!profile?.openid) throw new Error('宠托师不存在')
    await refreshStaffEarnings(profile.openid)
    const rows = await readDocuments(db, db.command, 'staff_earnings', { staffOpenid: profile.openid })
    const summary = { available: 0, pending: 0, frozen: 0, withdrawing: 0 }
    const eligible = []
    for (const row of rows) {
      if (row.isMock === true || row.paymentChannel === 'mock') continue
      const amount = cents(row.amount)
      if (row.status === 'available' && (row.withdrawRequestId || row.frozenIncidentId || row.pendingRefundIds?.length)) {
        summary.frozen += amount
      } else if (Object.prototype.hasOwnProperty.call(summary, row.status)) {
        summary[row.status] += amount
        if (row.status === 'available' && amount > 0) eligible.push(row)
      }
    }
    const settings = await getSystemSettings({ includeSecrets: true })
    let maxFen = 20000, unavailableReason = ''
    try {
      const config = getWechatTransferConfig(settings)
      if (!config.transferEnabled) throw new Error('请先在后台配置并开启商家微信转账')
      maxFen = Math.min(maxFen, cents(config.transferMaxAmount))
      if (!maxFen) throw new Error('商家微信转账单笔限额配置无效')
    } catch (error) { unavailableReason = error.message }
    const groups = []
    for (const earning of eligible) {
      const amount = cents(earning.amount)
      if (amount > maxFen) unavailableReason = `单笔收益 ¥${(amount / 100).toFixed(2)} 超过当前转账上限 ¥${(maxFen / 100).toFixed(2)}，请先核对打款方案；系统不会拆改收益账目`
      let group = groups[groups.length - 1]
      if (!group || group.amountFen + amount > maxFen || group.earningIds.length >= 50) {
        group = { earningIds: [], amountFen: 0 }
        groups.push(group)
      }
      group.earningIds.push(earning._id)
      group.amountFen += amount
    }
    return { staffProfileId, staffOpenid: profile.openid, staffName: profile.realName || '宠托师',
      ...Object.fromEntries(Object.entries(summary).map(([key, amount]) => [key, amount / 100])),
      batchCount: groups.length, maxAmount: maxFen / 100, unavailableReason,
      canSettle: summary.available > 0 && !unavailableReason, groups }
  }

  async function settleStaffEarningsByWechat(admin, data) {
    const staffProfileId = safeText(data.staffProfileId).trim()
    const requestId = safeText(data.clientRequestId).trim()
    if (!staffProfileId || !requestId || requestId.length > 100 || data.confirmed !== true) throw new Error('请核对金额并确认商家微信转账')
    const index = Number(data.batchIndex || 0)
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('结清批次不正确')
    const intentId = `staff_settlement_${hash([staffProfileId, requestId])}`
    let intent = await readOptionalDocument(db, 'finance_logs', intentId)
    if (!intent) {
      const reviewError = message => Object.assign(new Error(message), { code: 'STAFF_SETTLEMENT_REVIEW_REQUIRED' })
      if (index !== 0) throw new Error('结清任务不存在，请重新核对')
      const preview = await getStaffSettlementPreview(staffProfileId)
      if (!preview.canSettle) throw reviewError(preview.unavailableReason || '暂无可转账结清的收益')
      if (cents(data.expectedAmount) !== cents(preview.available)) throw reviewError('可提现收益已变化，请刷新并重新核对金额')
      const plan = { action: 'admin_staff_settlement', targetType: 'staff_profile', targetId: staffProfileId,
        staffOpenid: preview.staffOpenid, amountDelta: 0, amount: preview.available,
        clientRequestId: requestId, initiatedByAdminOpenid: admin.openid, groups: preview.groups, createdAt: now() }
      intent = await db.runTransaction(async tx => {
        const previous = await readOptionalDocument(tx, 'finance_logs', intentId)
        if (previous) return previous
        await tx.collection('finance_logs').doc(intentId).set({ data: plan })
        await tx.collection('admin_operation_logs').doc(intentId).set({ data: {
          adminUserId: admin._id, adminOpenid: admin.openid, action: 'settleStaffEarningsByWechat',
          targetType: 'staff_profile', targetId: staffProfileId, detail: { amount: plan.amount, batchCount: plan.groups.length }, createdAt: now()
        } })
        return plan
      })
    }
    if (intent.targetId !== staffProfileId || intent.clientRequestId !== requestId || cents(intent.amount) !== cents(data.expectedAmount)) throw new Error('结清任务参数不一致')
    const group = intent.groups[index]
    if (!group) throw new Error('结清批次不存在')
    const batchRequestId = `admin_settle_${hash([intentId, index])}`
    const request = await createWithdrawRequest(intent.staffOpenid, {
      clientRequestId: batchRequestId, amount: group.amountFen / 100, payoutChannel: 'wechat_wallet', remark: '后台结清宠托师服务收益'
    }, { adminSettlementId: intentId, adminOpenid: admin.openid, earningIds: group.earningIds })
    let current = request
    if (current.status === 'pending') current = (await settleWithdrawal(admin, { id: request._id, approved: true, auditRemark: '管理员确认结清可提现收益' })).request
    if (current.status === 'approved') {
      const result = await submitWechatWithdrawalTransfer(request._id, admin)
      current = result.request || result
    } else if (current.status === 'transferring') {
      const result = await queryWechatWithdrawalTransfer(request._id)
      current = result.request || result
    }
    // Failed/rejected requests require their existing finance handling path;
    // never create a fresh bill or mark money paid on a client assertion.
    return { settlementId: intentId, withdrawId: request._id, amount: request.amount,
      totalAmount: intent.amount, batchIndex: index, batchCount: intent.groups.length,
      status: current.status, transferStatus: current.transferStatus || '',
      needsHandling: ['transfer_failed', 'rejected', 'failed'].includes(current.status),
      hasMore: index + 1 < intent.groups.length }
  }

  return { getStaffSettlementPreview, settleStaffEarningsByWechat }
}
