const { readDocuments, readOptionalDocument } = require('../utils/documentPages')
const { WECHAT_MIN_TRANSFER_CENTS } = require('../utils/wechatTransferLimits')

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
    // Move whole earnings across the last boundary when the fifty-record cap
    // would otherwise leave a batch below WeChat's minimum transfer amount.
    const tail = groups[groups.length - 1], donor = groups[groups.length - 2]
    const amountById = new Map(eligible.map(row => [row._id, cents(row.amount)]))
    while (tail && donor && tail.amountFen < WECHAT_MIN_TRANSFER_CENTS && tail.earningIds.length < 50) {
      const index = donor.earningIds.findIndex(id => {
        const amount = amountById.get(id)
        return donor.amountFen - amount >= WECHAT_MIN_TRANSFER_CENTS && tail.amountFen + amount <= maxFen
      })
      if (index < 0) break
      const [id] = donor.earningIds.splice(index, 1)
      donor.amountFen -= amountById.get(id)
      tail.earningIds.unshift(id)
      tail.amountFen += amountById.get(id)
    }
    if (!unavailableReason && groups.some(group => group.amountFen < WECHAT_MIN_TRANSFER_CENTS)) unavailableReason = '微信零钱单笔最低 ¥0.10，请合并其他收益后结清；当前小额余额将保留'
    const unresolvedWithdrawals = summary.available > 0 && summary.available < WECHAT_MIN_TRANSFER_CENTS
      ? (await readDocuments(db, db.command, 'withdraw_requests', { staffOpenid: profile.openid }))
        .some(row => ['pending', 'approved', 'processing', 'transferring', 'transfer_failed'].includes(row.status))
      : false
    const canSettleManualTail = summary.available > 0 && summary.available < WECHAT_MIN_TRANSFER_CENTS &&
      summary.pending === 0 && summary.frozen === 0 && summary.withdrawing === 0 && !unresolvedWithdrawals
    return { staffProfileId, staffOpenid: profile.openid, staffName: profile.realName || '宠托师',
      ...Object.fromEntries(Object.entries(summary).map(([key, amount]) => [key, amount / 100])),
      batchCount: groups.length, maxAmount: maxFen / 100, unavailableReason,
      canSettle: summary.available > 0 && !unavailableReason, canSettleManualTail,
      manualTailUnavailableReason: canSettleManualTail ? '' : '仅可人工结清不足 ¥0.10 的全部尾款，请先处理待结算、冻结及在途提现', groups }
  }

  async function createStaffManualTailSettlement(admin, data = {}) {
    const staffProfileId = safeText(data.staffProfileId).trim()
    const clientRequestId = safeText(data.clientRequestId).trim()
    const amountFen = cents(data.expectedAmount)
    if (!staffProfileId || !clientRequestId || clientRequestId.length > 100 || data.confirmed !== true) throw new Error('请核对金额并确认发起人工尾款结清')
    if (amountFen <= 0 || amountFen >= WECHAT_MIN_TRANSFER_CENTS) throw new Error('人工尾款入口仅处理不足 ¥0.10 的余额')
    const id = `w_tail_${hash([staffProfileId, clientRequestId])}`
    const reviewError = message => Object.assign(new Error(message), { code: 'STAFF_TAIL_REVIEW_REQUIRED' })
    function validateExisting(request) {
      if (request.source !== 'admin_manual_tail_settlement' || request.staffProfileId !== staffProfileId ||
          request.clientRequestId !== clientRequestId || request.payoutChannel !== 'manual' || cents(request.amount) !== amountFen) throw new Error('已有尾款结清记录与本次核对信息不一致')
      return { ...request, _id: id }
    }
    let request = await readOptionalDocument(db, 'withdraw_requests', id)
    if (!request) {
      const preview = await getStaffSettlementPreview(staffProfileId)
      if (!preview.canSettleManualTail) throw reviewError(preview.manualTailUnavailableReason)
      if (cents(preview.available) !== amountFen) throw reviewError('尾款余额已变化，请刷新后重新核对')
      request = await db.runTransaction(async tx => {
        const previous = await readOptionalDocument(tx, 'withdraw_requests', id)
        if (previous) return validateExisting(previous)
        const profile = (await tx.collection('staff_profiles').doc(staffProfileId).get()).data
        if (!profile?.openid || profile.openid !== preview.staffOpenid) throw reviewError('宠托师资料已变化，请重新核对')
        const rows = await readDocuments(tx, db.command, 'staff_earnings', { staffOpenid: profile.openid })
        const earnings = []
        let total = 0
        for (const row of rows) {
          if (row.isMock === true || row.paymentChannel === 'mock') continue
          const amount = cents(row.amount)
          if (!amount || !['pending', 'available', 'withdrawing', 'frozen'].includes(row.status)) continue
          if (row.status !== 'available' || row.withdrawRequestId || row.frozenIncidentId || row.pendingRefundIds?.length) throw reviewError('尚有待结算、冻结或提现占用，请先处理原记录')
          earnings.push(row)
          total += amount
        }
        if (!earnings.length || earnings.length > 50 || total !== amountFen || total >= WECHAT_MIN_TRANSFER_CENTS) throw reviewError('尾款收益已变化，请刷新后重新核对')
        const withdrawals = await readDocuments(tx, db.command, 'withdraw_requests', { staffOpenid: profile.openid })
        if (withdrawals.some(row => ['pending', 'approved', 'processing', 'transferring', 'transfer_failed'].includes(row.status))) throw reviewError('尚有未完成提现，请先核对原单并处理')
        const time = now()
        const record = { staffOpenid: profile.openid, openid: profile.openid, staffProfileId,
          amount: total / 100, amountFen: total, earningIds: earnings.map(row => row._id),
          payoutChannel: 'manual', source: 'admin_manual_tail_settlement', status: 'pending',
          recipientOpenid: profile.openid, recipientName: profile.realName || '', accountName: profile.realName || '', accountNo: '',
          clientRequestId, initiatedByAdminOpenid: admin.openid,
          remark: '不足微信零钱最低转账金额的人工尾款结清', createdAt: time, updatedAt: time }
        await tx.collection('withdraw_requests').doc(id).set({ data: record })
        for (const earning of earnings) await tx.collection('staff_earnings').doc(earning._id).update({ data: {
          status: 'withdrawing', withdrawRequestId: id, updatedAt: time
        } })
        await tx.collection('finance_logs').doc(`withdraw_${id}`).set({ data: {
          action: 'withdraw_requested', targetType: 'withdraw_request', targetId: id, staffOpenid: profile.openid,
          amountDelta: -record.amount, detail: { earningIds: record.earningIds, source: record.source }, createdAt: time
        } })
        await tx.collection('admin_operation_logs').doc(`manual_tail_${id}`).set({ data: {
          action: 'createStaffManualTailSettlement', adminUserId: admin._id, adminOpenid: admin.openid,
          targetType: 'staff_profile', targetId: staffProfileId, detail: { withdrawId: id, amount: record.amount }, createdAt: time
        } })
        return { _id: id, ...record }
      })
    }
    request = validateExisting(request)
    return { withdrawId: id, staffOpenid: request.staffOpenid, amount: request.amount, status: request.status,
      needsHandling: request.status === 'rejected' }
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
      wechatTransferState: current.wechatTransferState || '',
      lastTransferError: current.lastTransferError || '', lastTransferErrorCode: current.lastTransferErrorCode || '',
      needsHandling: ['transfer_failed', 'rejected', 'failed'].includes(current.status) || Boolean(current.lastTransferError),
      hasMore: index + 1 < intent.groups.length }
  }

  return { getStaffSettlementPreview, settleStaffEarningsByWechat, createStaffManualTailSettlement }
}
