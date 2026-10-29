const { readDocuments, readOptionalDocument } = require('../utils/documentPages')

const { WECHAT_MIN_TRANSFER_CENTS, isAbsentSmallTransfer } = require('../utils/wechatTransferLimits')

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
  const MAX_EARNINGS_PER_WITHDRAW = 50

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

  function maskOpenid(openid) {
    const text = safeText(openid).trim()
    if (!text) return ''
    if (text.length <= 8) return text
    return `${text.slice(0, 4)}...${text.slice(-4)}`
  }

  function invitedUserLabel(user, openid) {
    return safeText(user && (user.nickname || user.nickName || user.realName || user.name)).trim() || maskOpenid(openid) || '好友'
  }

  async function getUsersByOpenids(openids) {
    const unique = Array.from(new Set((openids || []).map(openid => safeText(openid).trim()).filter(Boolean)))
    const usersByOpenid = new Map()
    for (let i = 0; i < unique.length; i += 20) {
      const chunk = unique.slice(i, i + 20)
      const rows = db.command && typeof db.command.in === 'function'
        ? ((await db.collection('users').where({ openid: db.command.in(chunk) }).limit(100).get().catch(() => ({ data: [] }))).data || [])
        : (await Promise.all(chunk.map(openid => db.collection('users').where({ openid }).limit(1).get().catch(() => ({ data: [] }))))).flatMap(res => res.data || [])
      rows.forEach(user => {
        if (user && user.openid) usersByOpenid.set(user.openid, user)
      })
    }
    return usersByOpenid
  }

  async function getInviteSettings() {
    const settings = await getSystemSettings()
    return settings.invitation || settings.userAssets || {
      enabled: false,
      rewardAmount: 0,
      userMinWithdrawAmount: 10
    }
  }

  async function grantInviteReward(invite, options = {}) {
    if (!invite || !invite._id || !invite.inviterOpenid) return null
    const settings = options.settings || await getInviteSettings()
    const time = now()
    const write = async (tx) => {
      const reader = tx || db
      const current = await readOptionalDocument(reader, 'user_invites', invite._id)
      if (!current || current.inviterOpenid !== invite.inviterOpenid || current.invitedOpenid !== invite.invitedOpenid) throw new Error('邀请关系已变化，请刷新后重试')
      const amount = Object.prototype.hasOwnProperty.call(current, 'rewardAmount') ? Number(current.rewardAmount) : Number(settings.rewardAmount || 0)
      const priorRows = await readDocuments(reader, db.command, 'user_asset_earnings', { sourceType: 'invite_binding', sourceId: invite._id })
      const roots = priorRows.filter(row => !row.splitFromEarningId)
      if (roots.length > 1 || (priorRows.length && roots.length !== 1)) throw new Error('邀请奖励存在重复记录，请联系平台核对')
      const earningId = current.rewardEarningId || (roots[0] && roots[0]._id) || idFor('invite_reward', [invite._id, amount])
      const existing = await readOptionalDocument(reader, 'user_asset_earnings', earningId)
      if (existing) {
        if (existing.userOpenid !== current.inviterOpenid || existing.sourceId !== invite._id || existing.sourceType !== 'invite_binding') throw new Error('邀请奖励归属异常')
        const parts = new Set([roots[0]._id])
        let previousSize = 0
        while (parts.size !== previousSize) {
          previousSize = parts.size
          priorRows.forEach(row => { if (parts.has(row.splitFromEarningId)) parts.add(row._id) })
        }
        if (parts.size !== priorRows.length || priorRows.some(row => row.userOpenid !== current.inviterOpenid)) throw new Error('邀请奖励记录归属异常')
        const totalFen = priorRows.reduce((total, row) => total + cents(row.amount, true), 0)
        if (!Number.isSafeInteger(totalFen)) throw new Error('邀请佣金累计金额超出安全范围')
        await reader.collection('user_invites').doc(invite._id).update({ data: {
          rewardEarningId: earningId,
          rewardAmount: totalFen / 100,
          rewarded: true,
          rewardedAt: current.rewardedAt || existing.createdAt || time,
          updatedAt: time
        } })
        return { ...existing, _id: earningId }
      }
      if (current.rewardEarningId) throw new Error('邀请奖励记录缺失，请联系平台核对')
      if (settings.enabled !== true || !Number.isFinite(amount) || amount <= 0) return null
      const pets = await readDocuments(reader, db.command, 'pets', { openid: current.invitedOpenid })
      const firstPet = pets.find(pet => !pet.deletedAt)
      if (!firstPet) return null
      let awardFen = cents(amount, true)
      const maxFen = cents(settings.maxRewardPerUser || 0)
      if (maxFen > 0) {
        const inviters = (await reader.collection('users').where({ openid: current.inviterOpenid }).limit(1).get()).data || []
        const inviter = inviters[0]
        if (!inviter) throw new Error('邀请人账户不存在，无法计算累计佣金')
        const earlier = await readDocuments(reader, db.command, 'user_asset_earnings', { userOpenid: current.inviterOpenid, sourceType: 'invite_binding' })
        const ledgerFen = earlier.reduce((total, row) => total + cents(row.amount), 0)
        if (!Number.isSafeInteger(ledgerFen)) throw new Error('邀请佣金累计金额超出安全范围')
        const recordedFen = inviter.inviteCommissionEarnedFen
        const earnedFen = Math.max(ledgerFen, Number.isSafeInteger(recordedFen) && recordedFen >= 0 ? recordedFen : 0)
        awardFen = Math.min(awardFen, Math.max(0, maxFen - earnedFen))
        if (awardFen === 0) {
          await reader.collection('user_invites').doc(invite._id).update({ data: {
            petProfileCreatedAt: current.petProfileCreatedAt || firstPet.createdAt || time,
            rewardLimitReached: true, updatedAt: time
          } })
          return null
        }
        await reader.collection('users').doc(inviter._id).update({ data: {
          inviteCommissionEarnedFen: earnedFen + awardFen, updatedAt: time
        } })
      }
      const grantedAmount = awardFen / 100
      const earning = {
        _id: earningId,
        userOpenid: invite.inviterOpenid,
        sourceType: 'invite_binding',
        sourceId: invite._id,
        invitedOpenid: invite.invitedOpenid || '',
        amount: grantedAmount,
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
        rewardAmount: grantedAmount,
        petProfileCreatedAt: current.petProfileCreatedAt || firstPet.createdAt || time,
        rewardLimitReached: false,
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
    const rows = await readDocuments(db, db.command, 'user_asset_earnings', { userOpenid: openid })
    const totals = { available: 0, withdrawing: 0, withdrawn: 0, pending: 0, total: 0 }
    rows.forEach((row) => {
      const amount = cents(row.amount)
      totals.total += amount
      if (row.status === 'available') totals.available += amount
      else if (row.status === 'withdrawing') totals.withdrawing += amount
      else if (row.status === 'withdrawn') totals.withdrawn += amount
      else totals.pending += amount
    })
    Object.keys(totals).forEach((key) => {
      if (!Number.isSafeInteger(totals[key])) throw new Error('用户资产金额超出安全范围')
      totals[key] /= 100
    })
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
    const withdraws = await readDocuments(db, db.command, 'withdraw_requests', { assetType: 'user', userOpenid: openid })
    const invites = await readDocuments(db, db.command, 'user_invites', { inviterOpenid: openid })
    const earningsByInviteId = new Map()
    summary.rows.filter(row => row.sourceType === 'invite_binding' && row.sourceId).forEach(row => {
      const recorded = earningsByInviteId.get(row.sourceId) || { amountFen: 0 }
      recorded.amountFen += cents(row.amount)
      earningsByInviteId.set(row.sourceId, recorded)
    })
    const invitedUsersByOpenid = await getUsersByOpenids(invites.map(invite => invite.invitedOpenid))
    const invitationRewardAmount = Number(settings.rewardAmount || 0)
    const decoratedInvites = invites.map((invite) => {
      const earning = earningsByInviteId.get(invite._id)
      const invitedUser = invitedUsersByOpenid.get(invite.invitedOpenid) || null
      const rewardAmount = earning ? earning.amountFen / 100 : Number(invite.rewardAmount ?? 0)
      let rewardStatus = 'pending'
      let rewardStatusText = '待入账'
      if (invite.rewardEarningId || earning) {
        rewardStatus = 'success'
        rewardStatusText = '已入账'
      } else if (invite.rewardLimitReached) {
        rewardStatus = 'muted'
        rewardStatusText = '已达累计上限'
      } else if (settings.enabled !== true) {
        rewardStatus = 'muted'
        rewardStatusText = '活动未开启'
      } else if (!Number.isFinite(invitationRewardAmount) || invitationRewardAmount <= 0) {
        rewardStatus = 'muted'
        rewardStatusText = '无现金奖励'
      } else if (!invite.petProfileCreatedAt) {
        rewardStatusText = '待好友建档'
      }
      return {
        ...invite,
        invitedNickname: invitedUserLabel(invitedUser, invite.invitedOpenid),
        invitedAvatarUrl: safeText(invitedUser && invitedUser.avatarUrl).trim(),
        invitedOpenidMasked: maskOpenid(invite.invitedOpenid),
        rewardAmount: Number.isFinite(rewardAmount) ? Math.round(rewardAmount * 100) / 100 : 0,
        rewardStatus,
        rewardStatusText
      }
    })
    const boundInvite = ((await db.collection('user_invites').where({ invitedOpenid: openid }).limit(1).get().catch(() => ({ data: [] }))).data || [])[0] || null
    const boundInviterOpenid = (boundInvite && boundInvite.inviterOpenid) || user.inviterOpenid || ''
    let boundInviteCode = safeText(boundInvite && boundInvite.inviteCode).trim().toUpperCase()
    if (!boundInviteCode && boundInviterOpenid) {
      const inviter = ((await db.collection('users').where({ openid: boundInviterOpenid }).limit(1).get().catch(() => ({ data: [] }))).data || [])[0]
      boundInviteCode = safeText(inviter && inviter.inviteCode).trim().toUpperCase()
    }
    const withdrawStatusTextMap = {
      pending: '审核中',
      approved: '待打款',
      transferring: '打款中',
      paid: '已到账',
      rejected: '已驳回',
      transfer_failed: '打款失败'
    }
    const wechatTransferStateTextMap = {
      WAIT_USER_CONFIRM: '待收款人确认收款',
      ACCEPTED: '微信已受理',
      TRANSFERING: '微信转账处理中',
      PROCESSING: '微信转账处理中',
      SUCCESS: '已到账',
      FAIL: '转账失败',
      CANCELLED: '已撤销'
    }
    const decoratedWithdraws = withdraws.map((w) => {
      const status = safeText(w.status).toLowerCase()
      const transferState = safeText(w.wechatTransferState).toUpperCase()
      const canConfirmTransfer = w.payoutChannel === 'wechat_wallet' && transferState === 'WAIT_USER_CONFIRM'
      let statusText = withdrawStatusTextMap[status] || '处理中'
      if (canConfirmTransfer) {
        statusText = '待确认收款'
      } else if (status === 'transferring') {
        statusText = '微信转账中'
      }
      return {
        ...w,
        amountText: Number(w.amount || 0).toFixed(2),
        statusText,
        wechatTransferStateText: wechatTransferStateTextMap[transferState] || transferState,
        canConfirmTransfer
      }
    })
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
      minWithdrawAmount: Math.max(0.10, Number(settings.userMinWithdrawAmount ?? settings.minWithdrawAmount ?? 10)),
      invitationEnabled: settings.enabled === true,
      invitationRewardAmount,
      invitationMaxRewardPerUser: Number(settings.maxRewardPerUser || 0),
      invitationShareImageUrl: safeText(settings.shareImageUrl).trim(),
      wechatTransferQuota,
      hasPendingWithdrawConfirm: decoratedWithdraws.some(w => w.canConfirmTransfer),
      earnings: summary.rows,
      invites: decoratedInvites.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
      withdraws: decoratedWithdraws.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    }
  }

  async function bindInviteCode(openid, data = {}) {
    const user = await getUser(openid)
    const settings = await getSystemSettings()
    if (settings.maintenance?.invitation === true) {
      const error = new Error('分享赚取佣金功能暂时不可使用，正在维护中')
      error.code = 'MODULE_MAINTENANCE'
      throw error
    }
    if (user.inviterOpenid) throw new Error('每个用户只能绑定一次邀请码，绑定后不能修改')
    const code = safeText(data.inviteCode).trim().toUpperCase()
    if (!code) throw new Error('请输入邀请码')
    const inviterRes = await db.collection('users').where({ inviteCode: code }).limit(1).get()
    const inviter = inviterRes.data && inviterRes.data[0]
    if (!inviter || inviter.openid === openid) throw new Error('邀请码无效或不能绑定自己的邀请码')
    const invitation = settings.invitation || settings.userAssets || {}
    const configuredRewardAmount = Number(invitation.rewardAmount || 0)
    const rewardAmount = invitation.enabled === true && Number.isFinite(configuredRewardAmount) && configuredRewardAmount > 0 ? Math.round(configuredRewardAmount * 100) / 100 : 0
    const inviteId = `invite_${openid}`
    const time = now()
    const record = { inviterUserId: inviter._id, inviterOpenid: inviter.openid, invitedUserId: user._id, invitedOpenid: openid, inviteCode: code, bindingSource: safeText(data.bindingSource).trim() || 'manual', rewarded: false, rewardAmount, createdAt: time, updatedAt: time }
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
    try {
      await grantInviteReward({ ...result, _id: result._id || inviteId, inviteCode: result.inviteCode || code })
    } catch (error) {
      console.error('[invite-reward-after-bind]', { invitedOpenid: openid, message: error.message })
    }
    return { ...user, inviterOpenid: result.inviterOpenid || inviter.openid, boundInviteCode: result.inviteCode || code }
  }

  async function createUserAssetWithdraw(openid, data = {}) {
    const user = await getUser(openid)
    if (user.status && user.status !== 'active') throw new Error('账号已被停用，无法申请提现')
    const settings = await getInviteSettings()
    const minAmount = Number(settings.userMinWithdrawAmount ?? settings.minWithdrawAmount ?? 10)
    const requested = cents(data.amount, true)
    if (requested < WECHAT_MIN_TRANSFER_CENTS) throw new Error('微信零钱单笔最低 ¥0.10，请合并收益后提现')
    if (requested < Math.round(minAmount * 100)) throw new Error(`最低提现金额 ¥${minAmount}`)
    const clientRequestId = safeText(data.clientRequestId).trim()
    const requestId = clientRequestId ? idFor('uw', [openid, clientRequestId]) : idFor('uw', [openid, requested, Date.now(), Math.random()])
    const existing = await readOptionalDocument(db, 'withdraw_requests', requestId)
    function replay(request) {
      if (request.assetType !== 'user' || request.userOpenid !== openid || cents(request.amount, true) !== requested) throw new Error('请求编号已用于其他提现金额，请刷新后重试')
      return request
    }
    if (existing) return replay(existing)
    const available = await readDocuments(db, db.command, 'user_asset_earnings', { userOpenid: openid, status: 'available' }, MAX_EARNINGS_PER_WITHDRAW + 1)
    const selected = []
    let total = 0
    for (const row of available) {
      if (total >= requested) break
      if (selected.length >= MAX_EARNINGS_PER_WITHDRAW) throw new Error(`单次最多合并${MAX_EARNINGS_PER_WITHDRAW}笔收益，请减少提现金额后分批申请`)
      const rowAmount = cents(row.amount, true)
      const allocation = Math.min(rowAmount, requested - total)
      selected.push({ row, amountFen: allocation })
      total += allocation
    }
    if (!selected.length || total < requested) throw new Error('可提现余额不足')
    const time = now()
    return db.runTransaction(async tx => {
      const current = await readOptionalDocument(tx, 'withdraw_requests', requestId)
      if (current) return replay(current)
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

  async function settleUserAssetWithdrawal(admin, data, paid = false, options = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (!request || request.assetType !== 'user') throw new Error('用户资产提现申请不存在')
      if (!paid && data.approved === true && request.payoutChannel === 'wechat_wallet' && cents(request.amount, true) < WECHAT_MIN_TRANSFER_CENTS) throw new Error('微信零钱单笔最低 ¥0.10，请驳回此笔小额申请后合并收益提现')
      if (paid && options.wechatResult !== true) {
        if (request.payoutChannel === 'wechat_wallet') throw new Error('微信提现单须以微信转账成功结果为准，不能手动标记打款')
        if (data.paymentConfirmed !== true || !safeText(data.paymentReference).trim()) throw new Error('请确认实际付款成功并填写付款凭证号')
      }
      const target = paid ? 'paid' : (data.approved === true ? 'approved' : 'rejected')
      if (request.status === target) return { request, changed: false }
      const allowedStatuses = paid ? ['approved', 'transferring', ...(options.wechatResult === true ? ['transfer_failed'] : [])] : ['pending']
      if (!allowedStatuses.includes(request.status)) throw new Error('当前用户资产提现状态不可操作')
      const { earningIds, total } = await validateWithdrawalEarnings(tx, request, data.id)
      const time = now()
      if (paid) await commitWechatTransferSuccessQuota(tx, { _id: data.id, ...request }, data)
      if (!paid && target === 'rejected') await releaseWechatTransferQuota(tx, { _id: data.id, ...request }, 'rejected')
      const patch = paid ? {
        status: 'paid',
        transferStatus: 'success',
        lastTransferError: '',
        lastTransferErrorCode: '',
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
    }, true, { wechatResult: true })
  }

  async function markUserAssetFailed(withdrawId, result = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request || request.assetType !== 'user') throw new Error('用户资产提现申请不存在')
      if (['paid', 'rejected'].includes(request.status)) return { request, changed: false }
      if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('当前用户资产提现状态不可失败回退')
      const time = now()
      await releaseWechatTransferQuota(tx, { _id: withdrawId, ...request }, 'transfer_failed')
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: { status: 'transfer_failed', transferStatus: 'failed',
        gatewayFailureConfirmed: result.gatewayTerminalConfirmed === true,
        wechatTransferState: safeText(result.state || result.transfer_state || 'FAIL'),
        failureReason: safeText(result.failReason || result.message).slice(0, 500), updatedAt: time } })
      return { request: { ...request, status: 'transfer_failed' }, changed: true }
    })
  }

  async function releaseUserAssetWithdrawal(admin, data = {}, internal = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (request?.assetType === 'user' && request.status === 'rejected' && request.transferStatus === 'released') return { request, changed: false }
      const absentSmallTransfer = isAbsentSmallTransfer(request, internal.gatewayAbsence)
      if (!request || request.assetType !== 'user' || (!absentSmallTransfer && request.status !== 'transfer_failed')) throw new Error('仅用户资产微信提现失败单可释放收益')
      if (!absentSmallTransfer && request.gatewayFailureConfirmed !== true) throw new Error('请先查询并确认微信转账已失败，再释放收益')
      const { earningIds } = await validateWithdrawalEarnings(tx, request, data.id)
      const time = now()
      const remark = safeText(data.remark || data.auditRemark).trim()
      await releaseWechatTransferQuota(tx, { _id: data.id, ...request }, 'released')
      const patch = { status: 'rejected', transferStatus: 'released', releasedAt: time, releasedByOpenid: admin.openid, auditRemark: remark || request.auditRemark || '微信提现失败后释放收益', updatedAt: time,
        ...(absentSmallTransfer ? { releaseReason: 'below_wechat_minimum', gatewayAbsenceConfirmedAt: time, lastTransferError: '', lastTransferErrorCode: '' } : {}) }
      await tx.collection('withdraw_requests').doc(data.id).update({ data: patch })
      for (const id of earningIds) await tx.collection('user_asset_earnings').doc(id).update({ data: { status: 'available', withdrawRequestId: '', updatedAt: time } })
      await tx.collection('finance_logs').doc(`user_withdraw_${data.id}_released`).set({ data: { action: 'user_withdraw_released', targetType: 'user_asset_withdrawal', targetId: data.id, userOpenid: request.userOpenid, amountDelta: 0, createdAt: time, detail: { earningIds, releasedByOpenid: admin.openid, remark } } })
      return { request: { ...request, ...patch }, changed: true }
    })
  }

  async function validateWithdrawalEarnings(tx, request, requestId) {
    const earningIds = request.earningIds
    if (typeof request.userOpenid !== 'string' || !request.userOpenid.trim() || request._id !== requestId) throw new Error('用户提现归属异常')
    // Retain support for already-created historical requests (previous cap: 1000).
    if (!Array.isArray(earningIds) || !earningIds.length || earningIds.length > 1000 ||
      earningIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(earningIds).size !== earningIds.length) throw new Error('用户提现收益记录异常')
    let total = 0
    for (const id of earningIds) {
      const row = (await tx.collection('user_asset_earnings').doc(id).get()).data
      if (!row || row.userOpenid !== request.userOpenid || row.withdrawRequestId !== requestId || row.status !== 'withdrawing') throw new Error('用户收益归属或状态异常')
      total += cents(row.amount, true)
    }
    if (!Number.isSafeInteger(total) || total !== cents(request.amount, true)) throw new Error('用户提现金额与收益合计不一致')
    return { earningIds, total }
  }

  return { getInviteSettings, grantInviteReward, summarizeUserAssets, getUserAssetSummary, bindInviteCode, createUserAssetWithdraw, settleUserAssetWithdrawal, markUserAssetPaid, markUserAssetFailed, releaseUserAssetWithdrawal }
}
