const { readDocuments, readOptionalDocument } = require('../utils/documentPages')
const { readManualRedemption } = require('../utils/staffEarningsMode')

module.exports = function createService({ db, crypto, now, safeText, getSystemSettings, refreshStaffEarnings, checkImageSecurity, checkTextSecurity }) {
  const maxEarnings = 50
  const reviewError = message => Object.assign(new Error(message), { code: 'STAFF_REDEMPTION_REVIEW_REQUIRED' })
  function cents(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value))) throw reviewError('兑换金额必须是最多两位小数的有效金额')
    const amount = Number(value), result = Math.round(amount * 100)
    if (value == null || value === '' || !Number.isSafeInteger(result) || result < 0 || Math.abs(amount * 100 - result) > 1e-6) throw reviewError('兑换金额必须是最多两位小数的有效金额')
    return result
  }
  function resolveOriginalAmount(row) {
    if (row.originalAmount != null) return row.originalAmount
    // Legacy entries may already have refunds or penalties before their first
    // redemption. Preserve those components in the original refund basis.
    const original = [row.amount, row.redeemedAmount ?? 0, row.deductAmount ?? 0, row.deductedAmount ?? 0]
      .reduce((total, value) => total + cents(value), 0)
    if (!Number.isSafeInteger(original)) throw reviewError('原始收益金额异常，请先核对账目')
    return original / 100
  }
  const eligible = row => row.status === 'available' && row.isMock !== true && row.paymentChannel !== 'mock' && !row.withdrawRequestId && !row.frozenIncidentId && !row.pendingRefundIds?.length

  async function getStaffRedemptionPreview(staffProfileId) {
    const profile = await readOptionalDocument(db, 'staff_profiles', staffProfileId)
    if (!profile?.openid) throw reviewError('宠托师不存在')
    const enabled = await readManualRedemption(db, await getSystemSettings())
    await refreshStaffEarnings(profile.openid)
    const rows = await readDocuments(db, db.command, 'staff_earnings', { staffOpenid: profile.openid })
    let available = 0, pending = 0, redeemed = 0, maxRedemption = 0, eligibleCount = 0
    for (const row of rows) {
      if (row.isMock === true || row.paymentChannel === 'mock') continue
      if (eligible(row)) {
        const amount = cents(row.amount)
        available += amount
        // Match the ordered, positive entries consumed by record redemption.
        if (amount > 0 && eligibleCount++ < maxEarnings) maxRedemption += amount
      }
      if (row.status === 'pending') pending += cents(row.amount)
      redeemed += cents(row.redeemedAmount || 0)
    }
    return { staffProfileId, staffName: profile.realName || '宠托师', enabled,
      available: available / 100, maxRedemptionAmount: maxRedemption / 100,
      pending: pending / 100, estimated: (available + pending) / 100, redeemed: redeemed / 100 }
  }

  async function recordStaffEarningRedemption(admin, data = {}) {
    const staffProfileId = safeText(data.staffProfileId).trim()
    const clientRequestId = safeText(data.clientRequestId).trim()
    const amountFen = cents(data.amount)
    const paymentProofImage = safeText(data.paymentProofImage).trim()
    const remark = safeText(data.remark).trim()
    if (!staffProfileId || !clientRequestId || clientRequestId.length > 100 || !amountFen || data.paymentConfirmed !== true) throw reviewError('请填写兑换金额并确认已完成转账')
    if (!/^cloud:\/\/[^\s]+\/(?:[^\s]+)\.(?:png|jpe?g|webp)$/i.test(paymentProofImage)) throw reviewError('请上传转账截图（PNG、JPG 或 WebP）')
    if (remark.length > 500) throw reviewError('兑换备注不能超过500字')
    const id = `w_redeem_${crypto.createHash('sha256').update(JSON.stringify([staffProfileId, clientRequestId])).digest('hex').slice(0, 32)}`
    const validateExisting = record => {
      if (record.source !== 'admin_earning_redemption' || record.staffProfileId !== staffProfileId || cents(record.amount) !== amountFen || record.paymentProofImage !== paymentProofImage || record.payRemark !== remark) throw new Error('此兑换请求已登记，金额或凭证不可更改')
      return { ...record, _id: id }
    }
    const previous = await readOptionalDocument(db, 'withdraw_requests', id)
    if (previous) return validateExisting(previous)
    try {
      const settings = await getSystemSettings()
      if (!await readManualRedemption(db, settings)) throw reviewError('请先开启后台兑换收益方式')
      try {
        if (typeof checkImageSecurity === 'function') await checkImageSecurity(admin.openid, paymentProofImage, { scene: 1, label: '收益兑换转账截图' })
        if (remark && typeof checkTextSecurity === 'function') await checkTextSecurity(admin.openid, remark, { scene: 2, label: '收益兑换备注' })
      } catch (error) {
        if (error.code === 'IMAGE_TOO_LARGE' || /包含.*(敏感|不合规)/.test(error.message || '')) throw reviewError(error.message)
        throw error
      }
      const profile = await readOptionalDocument(db, 'staff_profiles', staffProfileId)
      if (!profile?.openid) throw reviewError('宠托师不存在')
      await refreshStaffEarnings(profile.openid)
      return await db.runTransaction(async tx => {
        const previous = await readOptionalDocument(tx, 'withdraw_requests', id)
        if (previous) return validateExisting(previous)
        if (!await readManualRedemption(tx, settings)) throw reviewError('收益方式已变更，请刷新后重试')
        const current = await readOptionalDocument(tx, 'staff_profiles', staffProfileId)
        if (!current?.openid || current.openid !== profile.openid) throw reviewError('宠托师资料已变化，请刷新后重试')
        const rows = await readDocuments(tx, db.command, 'staff_earnings', { staffOpenid: current.openid, status: 'available' })
        const allocations = []
        let remaining = amountFen
        for (const row of rows) {
          if (!eligible(row) || !remaining) continue
          const amount = Math.min(remaining, cents(row.amount))
          if (!amount) continue
          allocations.push({ row, amount })
          remaining -= amount
        }
        if (remaining) throw reviewError('兑换金额超过当前可兑换收益，请刷新后核对')
        if (allocations.length > maxEarnings) throw reviewError(`单次兑换最多涉及${maxEarnings}笔订单收益，请减少金额后分次登记`)
        const time = now()
        const record = { staffProfileId, staffOpenid: current.openid, openid: current.openid,
          amount: amountFen / 100, amountFen, status: 'paid', payoutChannel: 'manual', source: 'admin_earning_redemption',
          clientRequestId, earningIds: allocations.map(item => item.row._id),
          allocations: allocations.map(item => ({ earningId: item.row._id, amount: item.amount / 100 })),
          paymentProofImage, paymentReference: id, paymentChannel: 'MANUAL_CONFIRMED', payRemark: remark,
          recipientName: current.realName || '', accountName: current.realName || '',
          paidByOpenid: admin.openid, paidByUserId: admin._id || '', paidAt: time, createdAt: time, updatedAt: time }
        for (const { row, amount } of allocations) {
          const balance = cents(row.amount) - amount
          await tx.collection('staff_earnings').doc(row._id).update({ data: {
            originalAmount: resolveOriginalAmount(row),
            amount: balance / 100, redeemedAmount: (cents(row.redeemedAmount || 0) + amount) / 100,
            status: balance ? 'available' : 'redeemed', lastRedemptionId: id, updatedAt: time
          } })
        }
        await tx.collection('withdraw_requests').doc(id).set({ data: record })
        await tx.collection('finance_logs').doc(id).set({ data: {
          action: 'staff_earning_redeemed', targetType: 'withdraw_request', targetId: id, staffOpenid: current.openid,
          amountDelta: -record.amount, detail: { staffProfileId, allocations: record.allocations, paymentProofImage, remark }, createdAt: time
        } })
        await tx.collection('admin_operation_logs').doc(id).set({ data: {
          action: 'recordStaffEarningRedemption', targetType: 'staff_profile', targetId: staffProfileId,
          adminUserId: admin._id || '', adminOpenid: admin.openid,
          detail: { withdrawId: id, amount: record.amount, paymentProofImage, remark }, createdAt: time
        } })
        return { _id: id, ...record }
      })
    } catch (error) {
      // A concurrent retry or a lost transaction response may have committed
      // this exact request. Confirm the durable result before unlocking input.
      const committed = await readOptionalDocument(db, 'withdraw_requests', id)
      if (committed) return validateExisting(committed)
      throw error
    }
  }
  return { getStaffRedemptionPreview, recordStaffEarningRedemption }
}
