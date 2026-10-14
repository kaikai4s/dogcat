module.exports = function createService({
  commitWechatTransferSuccessQuota,
  crypto,
  db,
  getSystemSettings,
  getUser,
  getWechatTransferQuotaSnapshot,
  now,
  releaseWechatTransferQuota,
  reserveWechatApplicationQuota,
  safeText
}) {
  const MAX_EARNINGS_PER_WITHDRAW = 1000

  function cents(value, positive = false) {
    const amount = Number(value)
    const result = Math.round(amount * 100)
    if (value == null || value === '' || !Number.isFinite(amount) || !Number.isSafeInteger(result) ||
      Math.abs(amount * 100 - result) > 0.000001 || amount < 0 || (positive && result <= 0)) {
      throw new Error('金额不正确，最多两位小数')
    }
    return result
  }

  function idFor(prefix, parts) {
    return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`
  }

  async function getInviteSettings() {
    const settings = await getSystemSettings().catch(() => ({}))
    return settings.invitation || settings.userAssets || {
      enabled: false,
      rewardAmount: 0,
      userMinWithdrawAmount: 10
    }
  }

  async function grantInviteReward(invite, options = {}) {
    if (!invite || !invite._id || !invite.inviterOpenid) return null
    const settings = options.settings || await getInviteSettings()
    const amount = Number(settings.rewardAmount || 0)
    if (settings.enabled !== true || !Number.isFinite(amount) || amount <= 0) return null
    const earningId = invite.rewardEarningId || idFor('invite_reward', [invite._id, amount])
    const time = now()
    const write = async (tx) => {
      const reader = tx || db
      const existing = await reader.collection('user_asset_earnings').doc(earningId).get().catch(() => ({ data: null }))
      if (existing && existing.data) return existing.data
      const earning = {
        _id: earningId,
        userOpenid: invite.inviterOpenid,
        sourceType: 'invite_binding',
        sourceId: invite._id,
        invitedOpenid: invite.invitedOpenid || '',
        amount,
        status: 'available',
        activityEnabled: true,
        createdAt: time,
        availableAt: time,
        updatedAt: time
      }
      const { _id: ignoredId, ...earningData } = earning
      await reader.collection('user_asset_earnings').doc(earningId).set({ data: earningData })
      await reader.collection('user_invites').doc(invite._id).update({ data: {
        rewardEarningId: earningId,
        rewardAmount: amount,
        rewarded: true,
        rewardedAt: time,
        updatedAt: time
      } })
      return earning
    }
    if (options.tx) return write(options.tx)
    if (typeof db.runTransaction === 'function') return db.runTransaction(write)
    return write(null)
  }

  async function summarizeUserAssets(openid) {
    const rows = (await db.collection('user_asset_earnings').where({ userOpenid: openid }).limit(1000).get().catch(() => ({ data: [] }))).data || []
    const totals = { available: 0, withdrawing: 0, withdrawn: 0, pending: 0, total: 0 }
    rows.forEach((row) => {
      const amount = Number(row.amount || 0)
      totals.total += amount
      if (row.status === 'available') totals.available += amount
      else if (row.status === 'withdrawing') totals.withdrawing += amount
      else if (row.status === 'withdrawn') totals.withdrawn += amount
      else totals.pending += amount
    })
    Object.keys(totals).forEach((key) => { totals[key] = Math.round(totals[key] * 100) / 100 })
    return { ...totals, rows: rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) }
  }

  async function getUserAssetSummary(openid) {
    const user = await getUser(openid)
    // Older accounts may predate invitation codes. Allocate the same stable
    // deterministic code used by the login path when the asset page is opened.
    if (!safeText(user.inviteCode).trim() && user._id) {
      const generated = `INV${safeText(user._id || user.openid).replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase() || Date.now()}`
      await db.collection('users').doc(user._id).update({ data: { inviteCode: generated, updatedAt: now() } }).catch(() => {})
      user.inviteCode = generated
    }
    const summary = await summarizeUserAssets(openid)
    const settings = await getInviteSettings()
    const withdraws = (await db.collection('withdraw_requests').where({ assetType: 'user', userOpenid: openid }).limit(200).get().catch(() => ({ data: [] }))).data || []
    const invites = (await db.collection('user_invites').where({ inviterOpenid: openid }).limit(1000).get().catch(() => ({ data: [] }))).data || []
    const boundInvite = ((await db.collection('user_invites').where({ invitedOpenid: openid }).limit(1).get().catch(() => ({ data: [] }))).data || [])[0] || null
    const boundInviterOpenid = (boundInvite && boundInvite.inviterOpenid) || user.inviterOpenid || ''
    let boundInviteCode = safeText(boundInvite && boundInvite.inviteCode).trim().toUpperCase()
    if (!boundInviteCode && boundInviterOpenid) {
      const inviter = ((await db.collection('users').where({ openid: boundInviterOpenid }).limit(1).get().catch(() => ({ data: [] }))).data || [])[0]
      boundInviteCode = safeText(inviter && inviter.inviteCode).trim().toUpperCase()
    }
    const wechatTransferQuota = typeof getWechatTransferQuotaSnapshot === 'function'
      ? await getWechatTransferQuotaSnapshot(openid, Math.round(summary.available * 100)).catch(() => null)
      : null
    return {
      userOpenid: openid,
      inviteCode: user.inviteCode || '',
      inviterOpenid: boundInviterOpenid,
      boundInviteCode,
      boundInvite,
      availableAmount: summary.available,
      withdrawingAmount: summary.withdrawing,
      withdrawnAmount: summary.withdrawn,
      totalAmount: summary.total,
      minWithdrawAmount: Number(settings.userMinWithdrawAmount ?? settings.minWithdrawAmount ?? 10),
      invitationEnabled: settings.enabled === true,
      wechatTransferQuota,
      earnings: summary.rows,
      invites: invites.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
      withdraws: withdraws.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    }
  }

  async function bindInviteCode(openid, data = {}) {
    const user = await getUser(openid)
    if (user.inviterOpenid) throw new Error('每个用户只能绑定一次邀请码，绑定后不能修改')
    const code = safeText(data.inviteCode).trim().toUpperCase()
    if (!code) throw new Error('请输入邀请码')
    const inviterRes = await db.collection('users').where({ inviteCode: code }).limit(1).get()
    const inviter = inviterRes.data && inviterRes.data[0]
    if (!inviter || inviter.openid === openid) throw new Error('邀请码无效或不能绑定自己的邀请码')
    const inviteId = `invite_${openid}`
    const time = now()
    const record = { inviterUserId: inviter._id, inviterOpenid: inviter.openid, invitedUserId: user._id, invitedOpenid: openid, inviteCode: code, bindingSource: safeText(data.bindingSource).trim() || 'manual', rewarded: false, createdAt: time, updatedAt: time }
    const result = await db.runTransaction(async tx => {
      const current = (await tx.collection('users').doc(user._id).get()).data
      if (current.inviterOpenid) throw new Error('每个用户只能绑定一次邀请码，绑定后不能修改')
      const existing = (await tx.collection('user_invites').doc(inviteId).get().catch(() => ({ data: null }))).data
      if (existing) {
        if (!current.inviterOpenid && existing.inviterOpenid) await tx.collection('users').doc(user._id).update({ data: { inviterOpenid: existing.inviterOpenid, updatedAt: time } })
        return { ...existing, _id: inviteId }
      }
      await tx.collection('user_invites').doc(inviteId).set({ data: record })
      await tx.collection('users').doc(user._id).update({ data: { inviterOpenid: inviter.openid, updatedAt: time } })
      return { ...record, _id: inviteId }
    })
    await grantInviteReward({ ...result, _id: result._id || inviteId, inviteCode: result.inviteCode || code })
    return { ...user, inviterOpenid: result.inviterOpenid || inviter.openid, boundInviteCode: result.inviteCode || code }
  }

  async function createUserAssetWithdraw(openid, data = {}) {
    const user = await getUser(openid)
    if (user.status && user.status !== 'active') throw new Error('账号已被停用，无法申请提现')
    const settings = await getInviteSettings()
    const minAmount = Number(settings.userMinWithdrawAmount ?? settings.minWithdrawAmount ?? 10)
    const requested = cents(data.amount, true)
    if (requested < Math.round(minAmount * 100)) throw new Error(`最低提现金额 ¥${minAmount}`)
    const clientRequestId = safeText(data.clientRequestId).trim()
    const requestId = clientRequestId ? idFor('uw', [openid, clientRequestId]) : idFor('uw', [openid, requested, Date.now(), Math.random()])
    const existing = await db.collection('withdraw_requests').doc(requestId).get().catch(() => ({ data: null }))
    if (existing && existing.data) return existing.data
    const available = (await db.collection('user_asset_earnings').where({ userOpenid: openid, status: 'available' }).orderBy('_id', 'asc').limit(MAX_EARNINGS_PER_WITHDRAW + 1).get()).data || []
    const selected = []
    let total = 0
    for (const row of available) {
      if (total >= requested) break
      const rowAmount = cents(row.amount, true)
      const allocation = Math.min(rowAmount, requested - total)
      selected.push({ row, amountFen: allocation })
      total += allocation
    }
    if (!selected.length || total < requested) throw new Error('可提现余额不足')
    const time = now()
    return db.runTransaction(async tx => {
      const current = (await tx.collection('withdraw_requests').doc(requestId).get().catch(() => ({ data: null }))).data
      if (current) return current
      const earningIds = []
      for (const selection of selected) {
        const row = selection.row
        const currentEarning = (await tx.collection('user_asset_earnings').doc(row._id).get()).data
        const currentAmount = currentEarning && cents(currentEarning.amount, true)
        if (!currentEarning || currentEarning.userOpenid !== openid || currentEarning.status !== 'available' || selection.amountFen > currentAmount) throw new Error('收益状态已变化，请刷新后重试')
        if (selection.amountFen === currentAmount) {
          await tx.collection('user_asset_earnings').doc(row._id).update({ data: { status: 'withdrawing', withdrawRequestId: requestId, updatedAt: time } })
          earningIds.push(row._id)
          continue
        }
        const remainderAmount = (currentAmount - selection.amountFen) / 100
        const sliceId = idFor('asset_slice', [row._id, requestId])
        const { _id: ignoredId, ...sliceData } = {
          ...currentEarning,
          amount: selection.amountFen / 100,
          status: 'withdrawing',
          withdrawRequestId: requestId,
          splitFromEarningId: row._id,
          createdAt: currentEarning.createdAt || time,
          updatedAt: time
        }
        await tx.collection('user_asset_earnings').doc(row._id).update({ data: { amount: remainderAmount, updatedAt: time } })
        await tx.collection('user_asset_earnings').doc(sliceId).set({ data: sliceData })
        earningIds.push(sliceId)
      }
      const request = {
        _id: requestId,
        assetType: 'user',
        userOpenid: openid,
        openid,
        amount: total / 100,
        amountFen: total,
        earningIds,
        status: 'pending',
        payoutChannel: 'wechat_wallet',
        recipientOpenid: openid,
        transferStatus: 'not_started',
        clientRequestId,
        createdAt: time,
        updatedAt: time
      }
      await reserveWechatApplicationQuota(tx, request)
      const { _id: ignoredId, ...requestData } = request
      await tx.collection('withdraw_requests').doc(requestId).set({ data: requestData })
      return request
    })
  }

  async function settleUserAssetWithdrawal(admin, data, paid = false) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (!request || request.assetType !== 'user') throw new Error('用户资产提现申请不存在')
      const target = paid ? 'paid' : (data.approved === true ? 'approved' : 'rejected')
      if (request.status === target) return { request, changed: false }
      const allowedStatuses = paid ? ['approved', 'transferring'] : ['pending']
      if (!allowedStatuses.includes(request.status)) throw new Error('当前用户资产提现状态不可操作')
      const earningIds = Array.isArray(request.earningIds) ? request.earningIds : []
      let total = 0
      for (const id of earningIds) {
        const row = (await tx.collection('user_asset_earnings').doc(id).get()).data
        if (!row || row.userOpenid !== request.userOpenid || row.withdrawRequestId !== (request._id || data.id) || row.status !== 'withdrawing') throw new Error('用户收益归属或状态异常')
        total += cents(row.amount, true)
      }
      if (total !== cents(request.amount, true)) throw new Error('用户提现金额与收益合计不一致')
      const time = now()
      if (paid) await commitWechatTransferSuccessQuota(tx, { _id: data.id, ...request }, data)
      if (!paid && target === 'rejected') await releaseWechatTransferQuota(tx, { _id: data.id, ...request }, 'rejected')
      const patch = paid ? {
        status: 'paid',
        transferStatus: 'success',
        transferSucceededAt: time,
        paidAt: time,
        paidByOpenid: admin.openid,
        paymentReference: safeText(data.paymentReference || data.transferBillNo || data.transfer_bill_no).trim(),
        wechatTransferBillNo: safeText(data.transferBillNo || data.transfer_bill_no).trim(),
        wechatTransferState: safeText(data.state || data.transferState || data.transfer_state || 'SUCCESS').trim() || 'SUCCESS',
        rawTransferResponse: data.rawTransferResponse || data.raw || {},
        updatedAt: time
      } : { status: target, auditedAt: time, auditedByOpenid: admin.openid, auditRemark: safeText(data.auditRemark || data.remark).trim(), updatedAt: time }
      await tx.collection('withdraw_requests').doc(request._id).update({ data: patch })
      for (const id of earningIds) await tx.collection('user_asset_earnings').doc(id).update({ data: { status: paid ? 'withdrawn' : target === 'rejected' ? 'available' : 'withdrawing', withdrawRequestId: target === 'rejected' ? '' : request._id, updatedAt: time } })
      await tx.collection('finance_logs').doc(`user_withdraw_${request._id}_${target}`).set({ data: { action: `user_withdraw_${target}`, targetType: 'user_asset_withdrawal', targetId: request._id, userOpenid: request.userOpenid, amountDelta: paid ? -total / 100 : 0, createdAt: time, detail: { earningIds, auditRemark: patch.auditRemark || '' } } })
      return { request: { ...request, ...patch }, changed: true }
    })
  }

  async function markUserAssetPaid(withdrawId, result = {}) {
    return settleUserAssetWithdrawal({ openid: 'wechat-transfer' }, {
      id: withdrawId,
      paymentReference: result.transferBillNo || result.outBillNo,
      transferBillNo: result.transferBillNo || result.transfer_bill_no,
      state: result.state || result.transfer_state,
      rawTransferResponse: result.rawTransferResponse || result.raw || {}
    }, true)
  }

  async function markUserAssetFailed(withdrawId, result = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request || request.assetType !== 'user') throw new Error('用户资产提现申请不存在')
      if (request.status === 'rejected') return { request, changed: false }
      if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('当前用户资产提现状态不可失败回退')
      const time = now()
      await releaseWechatTransferQuota(tx, { _id: withdrawId, ...request }, 'transfer_failed')
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: { status: 'transfer_failed', transferStatus: 'failed', failureReason: safeText(result.failReason || result.message).slice(0, 500), updatedAt: time } })
      return { request: { ...request, status: 'transfer_failed' }, changed: true }
    })
  }

  async function releaseUserAssetWithdrawal(admin, data = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (!request || request.assetType !== 'user' || request.status !== 'transfer_failed') throw new Error('仅用户资产微信提现失败单可释放收益')
      const time = now()
      const remark = safeText(data.remark || data.auditRemark).trim()
      await releaseWechatTransferQuota(tx, { _id: data.id, ...request }, 'released')
      await tx.collection('withdraw_requests').doc(data.id).update({ data: { status: 'rejected', transferStatus: 'released', releasedAt: time, releasedByOpenid: admin.openid, auditRemark: remark || request.auditRemark || '微信提现失败后释放收益', updatedAt: time } })
      for (const id of (request.earningIds || [])) await tx.collection('user_asset_earnings').doc(id).update({ data: { status: 'available', withdrawRequestId: '', updatedAt: time } })
      return { request: { ...request, status: 'rejected', transferStatus: 'released' }, changed: true }
    })
  }

  return { getInviteSettings, grantInviteReward, summarizeUserAssets, getUserAssetSummary, bindInviteCode, createUserAssetWithdraw, settleUserAssetWithdrawal, markUserAssetPaid, markUserAssetFailed, releaseUserAssetWithdrawal }
}
