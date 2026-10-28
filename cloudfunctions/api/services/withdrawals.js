const { documentPages } = require('../utils/documentPages')
const { WECHAT_MIN_TRANSFER_CENTS, WECHAT_MAX_TRANSFER_CENTS } = require('../utils/wechatTransferLimits')

module.exports = function createService({
  checkTextSecurity, crypto, db, findByClientRequestId, getClientRequestId, getSystemSettings,
  getUser, now, refreshStaffEarnings, reserveWechatApplicationQuota, safeText
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

  async function createWithdrawRequest(openid, data = {}, internal = {}) {
    const user = await getUser(openid)
    if (user && Array.isArray(user.roles) && !user.roles.includes('staff')) {
      throw new Error('仅宠托师可申请提现')
    }
    if (user && user.status && user.status !== 'active') {
      throw new Error('账号已被停用，无法申请提现')
    }
    const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
    const profile = profileRes && profileRes.data && profileRes.data[0]
    if (!internal.adminSettlementId && profile && ['revoked', 'suspended', 'rejected', 'banned'].includes(profile.auditStatus)) {
      throw new Error('宠托师资质已被平台暂停或撤销，暂不可申请提现')
    }

    const clientRequestId = getClientRequestId(data)
    // Preserve idempotency for requests created before deterministic IDs were introduced.
    const previous = await findByClientRequestId('withdraw_requests', { staffOpenid: openid, clientRequestId })
    const validateInternalRequest = request => {
      if (internal.adminSettlementId && (request.adminSettlementId !== internal.adminSettlementId ||
          request.payoutChannel !== 'wechat_wallet' || request.recipientOpenid !== openid ||
          cents(request.amount) !== cents(data.amount) ||
          JSON.stringify(request.earningIds) !== JSON.stringify(internal.earningIds))) throw new Error('已有结清提现记录与当前任务不一致，请人工核对')
      return request
    }
    if (previous) return validateInternalRequest(previous)

    const remark = safeText(data.remark).trim()
    if (remark && typeof checkTextSecurity === 'function') {
      await checkTextSecurity(openid, remark, { scene: 2, label: '提现申请备注' })
    }

    const accountName = safeText(data.accountName).trim()
    const accountNo = safeText(data.accountNo).trim()
    const payoutChannel = safeText(data.payoutChannel).trim()
    if (payoutChannel !== 'wechat_wallet' && (!accountName || accountName.length < 2 || accountName.length > 50)) {
      throw new Error('请填写正确的提现收款人姓名（2-50个字符）')
    }
    // 微信零钱转账使用当前登录用户的 openid，不需要银行卡/收款账号。
    // 未指定或其他渠道的历史人工打款请求仍按旧规则校验 accountNo。
    if (payoutChannel !== 'wechat_wallet' && (!accountNo || accountNo.length < 4 || accountNo.length > 50)) {
      throw new Error('请填写正确的提现收款账号（4-50个字符）')
    }

    const id = `w_${clientRequestId
      ? crypto.createHash('sha256').update(JSON.stringify([openid, clientRequestId])).digest('hex').slice(0, 32)
      : crypto.randomBytes(16).toString('hex')}`
    const requestedCents = data.amount === undefined ? null : cents(data.amount)
    if (payoutChannel === 'wechat_wallet' && requestedCents !== null) {
      if (requestedCents < WECHAT_MIN_TRANSFER_CENTS) throw new Error('微信零钱单笔最低 ¥0.10，请合并收益后提现')
      if (requestedCents > WECHAT_MAX_TRANSFER_CENTS) throw new Error('微信提现金额不能超过单笔上限 ¥200.00')
    }
    const targetCents = requestedCents === null ? Infinity : requestedCents
    await refreshStaffEarnings(openid)
    const settings = await getSystemSettings()
    const selected = []
    let totalCents = 0
    if (internal.adminSettlementId) {
      if (!Array.isArray(internal.earningIds) || !internal.earningIds.length || internal.earningIds.length > maxEarnings || new Set(internal.earningIds).size !== internal.earningIds.length) throw new Error('结清收益明细异常')
      for (const id of internal.earningIds) {
        const earning = (await db.collection('staff_earnings').doc(id).get()).data
        if (!earning) throw new Error('收益记录不存在')
        selected.push(earning)
        totalCents += cents(earning.amount)
      }
      if (totalCents !== requestedCents) throw new Error('结清收益金额已变化，请重新核对')
    } else {
    selectEarnings: for await (const earnings of documentPages(db, db.command, 'staff_earnings', { staffOpenid: openid, status: 'available' })) {
      for (const earning of earnings) {
        if (earning.isMock === true || earning.paymentChannel === 'mock' || earning.status === 'mock_settled' || earning.pendingRefundIds?.length || earning.frozenIncidentId) continue
        if (earning.withdrawRequestId) {
          const boundReq = (await db.collection('withdraw_requests').doc(earning.withdrawRequestId).get().catch(() => ({ data: null }))).data
          if (boundReq && boundReq.status === 'pending') continue
        }
        if (totalCents >= targetCents || selected.length > maxEarnings) break selectEarnings
        selected.push(earning)
        totalCents += cents(earning.amount)
        if (!Number.isSafeInteger(totalCents)) throw new Error('提现金额不正确')
      }
    }
    }
    // Earnings are indivisible ledger entries. Never silently turn a smaller
    // requested amount into a larger withdrawal by selecting the next entry.
    if (requestedCents !== null && totalCents > requestedCents) {
      throw new Error('提现金额需按收益记录整笔申请，请调整为不超过可选收益的金额')
    }
    const time = now()

    return db.runTransaction(async transaction => {
      const existing = await readRequest(transaction, id)
      if (existing) return validateInternalRequest({ ...existing, _id: id })
      if (!selected.length) throw new Error('暂无可提现收益')
      if (selected.length > maxEarnings) throw new Error('单次提现最多包含50笔收益，请减少提现金额后分批申请')
      if (payoutChannel === 'wechat_wallet') {
        if (totalCents < WECHAT_MIN_TRANSFER_CENTS) throw new Error('微信零钱单笔最低 ¥0.10，请合并收益后提现')
        if (totalCents > WECHAT_MAX_TRANSFER_CENTS) throw new Error('微信提现金额不能超过单笔上限 ¥200.00')
      }
      if (!internal.adminSettlementId && totalCents < Math.round(Number(settings.settlement.minWithdrawAmount || 0) * 100)) {
        throw new Error(`最低提现金额 ¥${settings.settlement.minWithdrawAmount}`)
      }
      // 微信云开发事务内禁止使用 Promise.all 并发调用 transaction 操作，改用串行依次读取和写入
      const currentSnapshots = []
      for (const earning of selected) {
        const snap = await transaction.collection('staff_earnings').doc(earning._id).get().catch(() => ({ data: null }))
        currentSnapshots.push(snap)
      }
      for (let i = 0; i < selected.length; i++) {
        const earning = selected[i]
        const current = (currentSnapshots[i] && currentSnapshots[i].data) || null
        if (!current) {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益记录不存在或无法读取（ID: ${earning._id}）`)
        }
        if (current.staffOpenid !== openid) {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益归属异常（ID: ${earning._id}）`)
        }
        if (current.status !== 'available') {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益状态已变更为 ${current.status}（ID: ${earning._id}）`)
        }
        if (current.isMock === true || current.paymentChannel === 'mock' || current.status === 'mock_settled') {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 包含不可提现的模拟测试收益（ID: ${earning._id}）`)
        }
        if (current.frozenIncidentId) {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益已被售后纠纷冻结（ID: ${earning._id}）`)
        }
        if (current.pendingRefundIds?.length) {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益存在未决退款纠纷（ID: ${earning._id}）`)
        }
        if (cents(current.amount) !== cents(earning.amount)) {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益金额已变动（ID: ${earning._id}）`)
        }
        // 并发防抢占：如果该收益在事务开启前没有被占用，而在进入事务后被其他并发请求写入了新的 withdrawRequestId
        if (current.withdrawRequestId && current.withdrawRequestId !== earning.withdrawRequestId) {
          throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益已被其他提现申请锁定（ID: ${earning._id}）`)
        }
        if (current.withdrawRequestId) {
          const activeReq = (await db.collection('withdraw_requests').doc(current.withdrawRequestId).get().catch(() => ({ data: null }))).data
          if (activeReq && activeReq.status === 'pending') {
            throw new Error(`收益状态已变化或包含不可提现的模拟测试收益: 收益正处于提现审核排队中（申请单号: ${current.withdrawRequestId}）`)
          }
        }
      }
      const request = {
        staffOpenid: openid, openid, clientRequestId, idempotencyKey: clientRequestId || id,
        amount: totalCents / 100, status: 'pending', earningIds: selected.map(item => item._id),
        accountName,
        accountNo,
        ...(internal.adminSettlementId ? { adminSettlementId: internal.adminSettlementId, initiatedByAdminOpenid: internal.adminOpenid, source: 'admin_wechat_settlement' } : {}),
        remark, auditRemark: '', createdAt: time, updatedAt: time
      }
      if (payoutChannel) {
        request.payoutChannel = payoutChannel
        request.amountFen = totalCents
        request.recipientOpenid = openid
        request.recipientName = accountName
        request.transferStatus = 'not_started'
      }
      if (payoutChannel === 'wechat_wallet' && typeof reserveWechatApplicationQuota === 'function') {
        await reserveWechatApplicationQuota(transaction, { _id: id, ...request }, { settings })
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
