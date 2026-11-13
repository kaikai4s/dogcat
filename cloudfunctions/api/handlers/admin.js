const depositPolicy = require('../utils/staffDepositPolicy')
const { userAssetExpiryDate } = require('../utils/userAssetExpiry')
const { beijingDateText, parseDateValue: parseBeijingDateValue } = require('../utils/time')
const { DEFAULT_STAFF_TRAINING_QUIZ } = require('../config/constants')
const { requireStaffGender } = require('../utils/staffGender')
const { getOrderRefundState } = require('../utils/orderRefundState')
const { getOrderSessionPricing } = require('../utils/orderSessionPricing')
const crypto = require('crypto')

module.exports = function createHandler(context) {
  const {
    cancelUnpaidOrder,
    handleAdminAccess,
    protectAdminOwner,
    ORDER_STATUS,
    RETIRED_SERVICE_KEYS,
    VISIT_FEE_SERVICE_KEY,
    addPoints,
    appendOrderClientMessage,
    appendOrderStaffMessage,
    appendOrderTimeline,
    assertAdminRoleChangeAllowed,
    assertStaffCanServeOrderVaccines,
    attachOrderDisplayData,
    assertUserDeleteAllowed,
    attachAdminOrderContactData,
    auditStatusText,
    buildDateRange,
    aggregateFinanceDashboard,
    checkImageSecurity,
    checkTextSecurity,
    countActiveAdmins,
    buildMonthlyDashboard,
    buildOrderProfitSummary,
    notifyWithdrawal,
    calculateStaffEarningForOrder,
    resolveStaffCommissionRate,
    cleanupUserPersonalData,
    couponUsageScopeText,
    createRefundForOrder,
    db,
    defaultCheckinDays,
    destroyOrderHomeSecuritySecrets,
    defaultServiceCheckinRules,
    defaultServicePrices,
    detachUserFromHistoricalRecords,
    ensureMonthConfig,
    ensureStaffEarning,
    ensureOrderCompletionRewards,
    completeOrderService,
    normalizeServiceSessions,
    expireDueUnacceptedOrders,
    getClientRequestId,
    getUser,
    getAdminNotificationBadge,
    resolveOrderDispatchNotifications,
    getMemberLevels,
    getMonthConfig,
    getMonthDays,
    getSystemSettings,
    getWechatTransferQuotaOverview,
    getUserManageStats,
    inDateRange,
    isActiveCheckin,
    isAdminDeletedOrder,
    isCertifiedSitter,
    isOrderOverdue,
    isPresetServiceKey,
    issueCouponToTargetUser,
    limitList,
    listAdminNotifications,
    listAdminSystemNotifications,
    listPetTitles,
    listServiceCheckinRules,
    listServicePrices,
    logAdmin,
    makeIdempotencyKey,
    markAdminNotificationRead,
    maskStaffName,
    notifyAdmins,
    normalizeBenefits,
    normalizeCheckinReward,
    normalizeCouponSnapshot,
    normalizeCouponUsageScope,
    normalizeEditableRoles,
    normalizeMemberBadgeStyle,
    normalizeMemberBadgeTag,
    normalizeMemberNameColor,
    normalizeMemberNameEffect,
    normalizeMonthKey,
    savePetTitle,
    deletePetTitle,
    getPetTitle,
    grantEligiblePetTitlesForUsers,
    titleSnapshot,
    normalizeServiceCaseImageFileIds,
    normalizeServiceCheckinRule,
    normalizeServicePrice,
    normalizeStaffWorkflow,
    normalizeSystemSettings,
    normalizeTargetLevelIds,
    normalizeVideoAuditGuide,
    notifyOrder,
    enqueueOrderNotification,
    now,
    paginateList,
    parseDateValue,
    recalcUsersForDeletedLevel,
    refreshStaffEarnings,
    removeByQuery,
    resolvePetBlessing,
    requireAdmin,
    resolveRewardMailTargets,
    resolveTargetLevels,
    resolveUserMemberLevel,
    revokeSystemNotification,
    safeText,
    readScopedDocuments,
    refreshOrderRefunds,
    sendSystemNotification,
    settleWithdrawal,
    settleUserAssetWithdrawal,
    submitWechatWithdrawalTransfer,
    queryWechatWithdrawalTransfer,
    retryWechatWithdrawalTransfer,
    releaseFailedWithdrawal,
    markWechatWithdrawalFailed,
    settleStaffDeposit,
    shipStaffSupplies,
    settleSupplyReimbursement,
    safeUserSummary,
    saveSystemSettings,
    listSubscriptionDeliveries,
    requeueSubscriptionDelivery,
    syncUsersMemberLevelName,
    toCstParts,
    toTimeValue,
    updateOrderWhenStatus,
    validateStaffAvailabilityForSessions,
    assignOrderAtomically,
    updateOrderStatusWithScheduling,
    getOrderTimeRanges,
    validateStaffTakeOrderAbility,
    getInviteSettings
  } = context
  function transferResult(id, result) {
    const request = result.request || result
    return { id, status: request.status, transferStatus: request.transferStatus,
      wechatTransferState: request.wechatTransferState || '',
      lastTransferError: request.lastTransferError || '', lastTransferErrorCode: request.lastTransferErrorCode || '' }
  }
  async function startAuditedWechatTransfer(id, request, operator) {
    try {
      const submit = request.transferSubmittedAt ? retryWechatWithdrawalTransfer : submitWechatWithdrawalTransfer
      const transfer = await submit(id, operator)
      const current = { ...(transfer.request || transfer), _id: id }
      const event = current.status === 'paid' ? 'paid'
        : current.status === 'transfer_failed' ? 'transfer_failed'
        : current.wechatTransferState === 'WAIT_USER_CONFIRM' && current.transferMode !== 'auto_confirm' ? 'wait_confirm' : 'approved'
      await notifyWithdrawal(current, event)
      return transferResult(id, transfer)
    } catch (error) {
      // Approval is already committed. Keep that result and explain why the
      // transfer still needs attention instead of implying approval rolled back.
      const current = (await db.collection('withdraw_requests').doc(id).get()).data
      return { ...transferResult(id, current),
        lastTransferError: current.status === 'paid' ? '' : safeText(error.message) }
    }
  }
  async function readAll(collectionName, where = {}, maxLimit = 2000, projection = null) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor && db.command && typeof db.command.gt === 'function') condition._id = db.command.gt(cursor)
      let query = db.collection(collectionName).where(condition)
      if (projection && typeof query.field === 'function') {
        query = query.field(projection)
      }
      const page = (await query.orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) return rows
      cursor = page[page.length - 1]._id
    }
    return rows
  }
  const depositBalanceAmount = depositPolicy.balanceAmount
  const profileDepositStandard = depositPolicy.standardAmount
  async function freezeLegacyDepositStandards(amount) {
    const count = Number((await db.collection('staff_profiles').count()).total || 0)
    if (count > 2000) throw new Error('宠托师资料超过2000条，暂不能安全固定旧保证金标准')
    const profiles = await readAll('staff_profiles', {}, Math.max(count, 1))
    const time = now()
    for (const profile of profiles) {
      await db.runTransaction(async tx => {
        const current = (await tx.collection('staff_profiles').doc(profile._id).get()).data
        if (depositPolicy.hasStandard(current)) return
        const standard = profileDepositStandard(current, amount)
        await tx.collection('staff_profiles').doc(profile._id).update({ data: {
          depositStandardAmount: standard,
          depositEntryStandardAmount: standard,
          depositStandardAssignedAt: current.createdAt || time,
          depositStandardSource: 'legacy_current_config',
          updatedAt: time
        } })
      })
    }
  }
  async function staffDepositRecords(openid, tx) {
    return depositPolicy.readDeposits(db, openid, tx)
  }

  async function fetchFinanceRowsByOpenids(collectionName, openids = []) {
    const list = [...new Set((openids || []).filter(Boolean))]
    if (!list.length) return []
    const rows = []
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50)
      if (db.command && typeof db.command.in === 'function') {
        rows.push(...await readAll(collectionName, { staffOpenid: db.command.in(chunk) }, 5000))
      } else {
        for (const staffOpenid of chunk) rows.push(...await readAll(collectionName, { staffOpenid }, 5000))
      }
    }
    return rows
  }

  async function fetchUserAssetWithdrawsByOpenids(openids = []) {
    const list = [...new Set((openids || []).filter(Boolean))]
    if (!list.length) return []
    const rows = []
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50)
      if (db.command && typeof db.command.in === 'function') {
        rows.push(...await readAll('withdraw_requests', { assetType: 'user', userOpenid: db.command.in(chunk) }, 5000))
      } else {
        for (const userOpenid of chunk) rows.push(...await readAll('withdraw_requests', { assetType: 'user', userOpenid }, 5000))
      }
    }
    return rows
  }

  function buildStaffFinanceSummary(earnings = [], withdraws = []) {
    const summary = {}
    const ensure = (openid) => {
      if (!summary[openid]) summary[openid] = { available: 0, withdrawn: 0, withdrawHistory: [], withdrawCount: 0, hasUnsettledEarning: false, hasPendingWithdraw: false }
      return summary[openid]
    }
    const unsettledEarningStatuses = new Set(['pending', 'available', 'withdrawing', 'frozen'])
    for (const earning of earnings) {
      const openid = earning.staffOpenid
      if (!openid || earning.isMock === true || earning.paymentChannel === 'mock') continue
      const target = ensure(openid)
      if (earning.status === 'available' && !earning.withdrawRequestId && !earning.frozenIncidentId && !earning.pendingRefundIds?.length) target.available += Number(earning.amount || 0)
      if (earning.status === 'pending') target.pending = (target.pending || 0) + Number(earning.amount || 0)
      target.redeemed = (target.redeemed || 0) + Number(earning.redeemedAmount || 0)
      if (unsettledEarningStatuses.has(safeText(earning.status).trim()) && Math.round(Number(earning.amount || 0) * 100) > 0) {
        target.hasUnsettledEarning = true
      }
    }
    const pendingWithdrawStatuses = new Set(['pending', 'approved', 'processing', 'transferring', 'transfer_failed'])
    for (const request of withdraws) {
      const openid = request.staffOpenid
      if (!openid) continue
      const target = ensure(openid)
      target.withdrawCount += 1
      if (request.status === 'paid') target.withdrawn += Number(request.amount || 0)
      if (pendingWithdrawStatuses.has(safeText(request.status).trim())) {
        target.hasPendingWithdraw = true
      }
      target.withdrawHistory.push({
        _id: request._id,
        amount: Number(request.amount || 0),
        status: request.status || '',
        payoutChannel: request.payoutChannel || '',
        source: request.source || '',
        paymentProofImage: request.paymentProofImage || '',
        createdAt: request.createdAt || '',
        paidAt: request.paidAt || ''
      })
    }
    Object.values(summary).forEach((item) => {
      item.available = Math.round(item.available * 100) / 100
      item.withdrawn = Math.round(item.withdrawn * 100) / 100
      item.withdrawHistory.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      item.withdrawHistory = item.withdrawHistory.slice(0, 8)
    })
    return summary
  }

  function hasStaffRole(user) {
    return Array.isArray(user && user.roles) && user.roles.includes('staff')
  }

  async function assertStaffFundsSettledBeforeRoleRemoval(target, nextRoles = []) {
    if (!hasStaffRole(target) || nextRoles.includes('staff')) return

    const earnings = await readScopedDocuments('staff_earnings', { staffOpenid: target.openid }, '_id', 'asc')
    const unsettledEarningStatuses = new Set(['pending', 'available', 'withdrawing', 'frozen'])
    const unsettledEarnings = earnings.filter((earning) => unsettledEarningStatuses.has(safeText(earning.status).trim()) && earning.isMock !== true && earning.paymentChannel !== 'mock')
    const earningAmount = unsettledEarnings.reduce((sum, earning) => sum + Number(earning.amount || 0), 0)
    if (Math.round(earningAmount * 100) > 0) {
      throw new Error(`该宠托师收益尚未结清，可处理金额 ¥${earningAmount.toFixed(2)}。请先在财务管理完成提现打款、驳回、冻结处理或收益结算后再移除宠托师身份`)
    }

    const withdraws = await readScopedDocuments('withdraw_requests', { staffOpenid: target.openid }, '_id', 'asc')
    const pendingWithdraw = withdraws.find((item) => ['pending', 'approved', 'processing', 'transferring', 'transfer_failed'].includes(safeText(item.status).trim()))
    if (pendingWithdraw) {
      const amount = Number(pendingWithdraw.amount || 0).toFixed(2)
      throw new Error(`该宠托师存在未完成提现申请 ¥${amount}。请先在财务管理完成打款或驳回后再移除宠托师身份`)
    }

    const deposits = await readScopedDocuments('staff_deposits', { staffOpenid: target.openid }, '_id', 'asc')
    const unsettled = deposits.find((deposit) => {
      const netAvailable = deposit.availableRefundAmount != null
        ? Number(deposit.availableRefundAmount)
        : (Number(deposit.paidAmount || 0) - Number(deposit.refundedAmount || 0) - Number(deposit.forfeitedAmount || 0) - Number(deposit.supplyFeeDeductedAmount || 0))
      const available = Math.round(Math.max(0, netAvailable) * 100)
      const status = safeText(deposit.status).trim()
      const refundStatus = safeText(deposit.refundStatus).trim()
      const isRefundInFlight = ['refund_requested', 'refund_approved'].includes(status) || ['requested', 'approved', 'processing'].includes(refundStatus)
      return available > 0 || isRefundInFlight
    })
    if (unsettled) {
      const netAvailable = unsettled.availableRefundAmount != null
        ? Number(unsettled.availableRefundAmount)
        : (Number(unsettled.paidAmount || 0) - Number(unsettled.refundedAmount || 0) - Number(unsettled.forfeitedAmount || 0) - Number(unsettled.supplyFeeDeductedAmount || 0))
      const amount = Math.max(0, netAvailable).toFixed(2)
      throw new Error(`该宠托师保证金尚未处理完成，可退余额 ¥${amount}。请先在财务管理完成扣除/退款后再移除宠托师身份`)
    }
  }

  async function readMonthlyEntities(collectionName, monthStartDate, monthStartText, projection = null) {
    if (!db.command || typeof db.command.gte !== 'function') {
      return readAll(collectionName, {}, 2000, projection)
    }
    let dateRows = []
    let textRows = []
    let queryFailed = false
    try {
      dateRows = await readAll(collectionName, { createdAt: db.command.gte(monthStartDate) }, 2000, projection)
    } catch (e) {
      queryFailed = true
    }
    try {
      textRows = await readAll(collectionName, { createdAt: db.command.gte(monthStartText) }, 2000, projection)
    } catch (e) {
      queryFailed = true
    }

    const map = new Map()
    for (const item of [...dateRows, ...textRows]) {
      if (item && item._id) map.set(item._id, item)
    }

    if (map.size > 0 || !queryFailed) return Array.from(map.values())

    // 仅在条件读取抛出异常时，降级兜底读取表数据
    return readAll(collectionName, {}, 2000, projection)
  }

  function matchFinanceRecord(record, keyword, searchContext = {}) {
    if (!record || typeof record !== 'object') return false
    const kw = safeText(keyword).trim().toLowerCase()
    if (!kw) return true

    const openids = (searchContext && searchContext.matchedOpenids) || []
    const orderIds = (searchContext && searchContext.matchedOrderIds) || []

    const phoneValues = [
      record.staffPhone, record.accountPhone, record.certifiedPhone,
      record.phone, record.userPhone, record.contactPhone
    ]
    for (const v of phoneValues) {
      if (v && String(v).toLowerCase().includes(kw)) return true
    }

    const orderValues = [
      record._id, record.id, record.orderId, record.orderNo,
      record.paymentNo, record.refundNo, record.outBillNo, record.outTradeNo,
      record.transactionId, record.wechatTransferBillNo, record.paymentReference,
      record.targetId, record.withdrawRequestId
    ]
    for (const v of orderValues) {
      if (v && String(v).toLowerCase().includes(kw)) return true
    }

    if (Array.isArray(record.problemOrders)) {
      for (const p of record.problemOrders) {
        if (!p) continue
        if (p.orderId && String(p.orderId).toLowerCase().includes(kw)) return true
        if (p.orderNo && String(p.orderNo).toLowerCase().includes(kw)) return true
        if (orderIds.length && (orderIds.includes(String(p.orderId)) || orderIds.includes(String(p.orderNo)))) return true
      }
    }

    const recordOpenids = [
      record.applicantOpenid, record.staffOpenid, record.userOpenid, record.openid, record.recipientOpenid
    ].filter(Boolean)
    for (const v of recordOpenids) {
      if (v && String(v).toLowerCase().includes(kw)) return true
    }
    if (openids.length && recordOpenids.some((id) => openids.includes(id))) return true

    if (orderIds.length) {
      if (record.orderId && orderIds.includes(String(record.orderId))) return true
      if (record._id && orderIds.includes(String(record._id))) return true
      if (record.orderNo && orderIds.includes(String(record.orderNo))) return true
    }

    const textValues = [
      record.staffRealName, record.staffNickname, record.userNickname,
      record.accountName, record.recipientName, record.reason, record.action
    ]
    for (const v of textValues) {
      if (v && String(v).toLowerCase().includes(kw)) return true
    }

    return false
  }

  async function queryFinanceListSafely(collectionName, {
    baseWhere = {},
    dateRange,
    dateFields = ['createdAt'],
    pageSize = 50,
    page = 1,
    keyword = '',
    searchContext = null
  }) {
    const kw = safeText(keyword).trim()
    const limit = Math.min(Math.max(Number(pageSize || 50), 1), 100)
    const pageNum = Math.max(Number(page || 1), 1)
    const offset = (pageNum - 1) * limit
    const primaryDateField = dateFields[0] || 'createdAt'
    const where = { ...baseWhere }

    if (dateRange && (dateRange.start || dateRange.startDate) && db.command && typeof db.command.gte === 'function') {
      where[primaryDateField] = db.command.gte(dateRange.start || `${dateRange.startDate} 00:00:00`)
    }

    let dateList = []
    let queryFailed = false
    try {
      const res = await db.collection(collectionName)
        .where(where)
        .orderBy(primaryDateField, 'desc')
        .skip(offset)
        .limit(limit)
        .get()
      dateList = (res.data || []).filter((item) => inDateRange(item, dateRange, dateFields))
    } catch (e) {
      queryFailed = true
    }

    if (!dateList.length && (queryFailed || !dateRange || (!dateRange.startDate && !dateRange.endDate))) {
      const candidates = (await db.collection(collectionName)
        .where(baseWhere)
        .skip(offset)
        .limit(Math.min(limit * 3, 150))
        .get().catch(() => ({ data: [] }))).data || []

      const sorted = candidates.sort((a, b) => {
        const aDate = dateFields.map(f => parseDateValue(a[f])).find(Boolean) || 0
        const bDate = dateFields.map(f => parseDateValue(b[f])).find(Boolean) || 0
        return new Date(bDate) - new Date(aDate)
      })
      dateList = sorted.filter((item) => inDateRange(item, dateRange, dateFields))
    }

    if (!kw) {
      return limitList(dateList, limit)
    }

    const matchedInDate = dateList.filter((item) => matchFinanceRecord(item, kw, searchContext))
    const targetedRows = []
    const targetedWhereList = []

    if (searchContext && searchContext.matchedOrderIds && searchContext.matchedOrderIds.length > 0) {
      const ids = searchContext.matchedOrderIds.slice(0, 30)
      const inVal = db.command && typeof db.command.in === 'function' ? db.command.in(ids) : (ids.length === 1 ? ids[0] : null)
      if (inVal) {
        if (['payments', 'refunds', 'staff_earnings'].includes(collectionName)) {
          targetedWhereList.push({ ...baseWhere, orderId: inVal })
        }
        if (['payments', 'refunds', 'withdraw_requests', 'staff_deposits', 'staff_supply_reimbursements', 'finance_logs'].includes(collectionName)) {
          targetedWhereList.push({ ...baseWhere, _id: inVal })
        }
      }
    }

    if (searchContext && searchContext.matchedOpenids && searchContext.matchedOpenids.length > 0) {
      const openids = searchContext.matchedOpenids.slice(0, 30)
      const inVal = db.command && typeof db.command.in === 'function' ? db.command.in(openids) : (openids.length === 1 ? openids[0] : null)
      if (inVal) {
        if (['staff_earnings', 'withdraw_requests', 'staff_deposits', 'staff_supply_reimbursements'].includes(collectionName)) {
          targetedWhereList.push({ ...baseWhere, staffOpenid: inVal })
        }
        if (['withdraw_requests'].includes(collectionName)) {
          targetedWhereList.push({ ...baseWhere, userOpenid: inVal })
        }
      }
    }

    if (['payments'].includes(collectionName)) {
      targetedWhereList.push({ ...baseWhere, paymentNo: kw })
    } else if (['refunds'].includes(collectionName)) {
      targetedWhereList.push({ ...baseWhere, refundNo: kw })
    } else if (['withdraw_requests'].includes(collectionName)) {
      targetedWhereList.push({ ...baseWhere, outBillNo: kw })
      targetedWhereList.push({ ...baseWhere, wechatTransferBillNo: kw })
    } else if (['finance_logs'].includes(collectionName)) {
      targetedWhereList.push({ ...baseWhere, targetId: kw })
    }

    for (const tw of targetedWhereList) {
      try {
        const res = await db.collection(collectionName).where(tw).limit(limit).get()
        if (res.data && res.data.length) {
          targetedRows.push(...res.data)
        }
      } catch (_) {}
    }

    const mergedMap = new Map()
    for (const item of [...matchedInDate, ...targetedRows]) {
      if (item && item._id && !mergedMap.has(item._id)) {
        if (matchFinanceRecord(item, kw, searchContext)) {
          mergedMap.set(item._id, item)
        }
      }
    }

    const mergedList = Array.from(mergedMap.values()).sort((a, b) => {
      const aDate = dateFields.map(f => parseDateValue(a[f])).find(Boolean) || 0
      const bDate = dateFields.map(f => parseDateValue(b[f])).find(Boolean) || 0
      return new Date(bDate) - new Date(aDate)
    })

    return limitList(mergedList, limit)
  }

  async function fetchUsersByOpenids(openids = []) {
    const list = Array.from(new Set(openids.filter(Boolean)))
    if (!list.length) return []
    const users = []
    const chunkSize = 50
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize)
      const res = await db.collection('users').where({ openid: db.command.in(chunk) }).limit(chunk.length).get()
      users.push(...(res.data || []))
    }
    return users
  }

  async function fetchStaffProfilesByOpenids(openids = []) {
    const list = Array.from(new Set(openids.filter(Boolean)))
    if (!list.length) return []
    const profiles = []
    const chunkSize = 50
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize)
      const res = await db.collection('staff_profiles').where({ openid: db.command.in(chunk) }).limit(chunk.length).get()
      profiles.push(...(res.data || []))
    }
    return profiles
  }

  async function fetchStaffProfilesByIds(ids = []) {
    const list = Array.from(new Set(ids.filter(Boolean)))
    if (!list.length) return []
    const profiles = []
    const chunkSize = 50
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize)
      const res = await db.collection('staff_profiles').where({ _id: db.command.in(chunk) }).limit(chunk.length).get()
      profiles.push(...(res.data || []))
    }
    return profiles.map(normalizeStaffWorkflow)
  }

  async function fetchStaffEvidencesByOpenids(openids = []) {
    const list = Array.from(new Set(openids.filter(Boolean)))
    if (!list.length) return []
    const evidences = []
    const chunkSize = 50
    for (let i = 0; i < list.length; i += chunkSize) {
      const chunk = list.slice(i, i + chunkSize)
      const res = await db.collection('staff_deposit_evidences').where({ staffOpenid: db.command.in(chunk) }).get()
      evidences.push(...(res.data || []))
    }
    return evidences.sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
  }

  function staffPhoneFields(user = {}, profile = {}) {
    const accountPhone = safeText(user.phone).trim()
    const certifiedPhone = safeText(profile.phone).trim()
    return {
      // `phone` is the account binding phone shown in current admin views.
      phone: accountPhone || certifiedPhone,
      accountPhone,
      certifiedPhone
    }
  }

  async function searchUsersByPhoneSafely(phoneKeyword) {
    const raw = safeText(phoneKeyword).trim()
    if (!raw) return []
    if (db && typeof db.RegExp === 'function') {
      try {
        const res = await db.collection('users')
          .where({ phone: db.RegExp({ regexp: raw, options: 'i' }) })
          .limit(50)
          .get()
        if (res.data && res.data.length > 0) return res.data
      } catch (e) {
        // 降级保护
      }
    }
    try {
      const exactRes = await db.collection('users').where({ phone: raw }).limit(50).get()
      if (exactRes.data && exactRes.data.length > 0) return exactRes.data
    } catch (e) {
      // 降级保护
    }
    return []
  }

  async function searchStaffProfilesByPhoneSafely(phoneKeyword) {
    const raw = safeText(phoneKeyword).trim()
    if (!raw) return []
    if (db && typeof db.RegExp === 'function') {
      try {
        const res = await db.collection('staff_profiles')
          .where({ phone: db.RegExp({ regexp: raw, options: 'i' }) })
          .limit(50)
          .get()
        if (res.data && res.data.length > 0) return res.data
      } catch (e) {
        // 降级保护
      }
    }
    try {
      const exactRes = await db.collection('staff_profiles').where({ phone: raw }).limit(50).get()
      if (exactRes.data && exactRes.data.length > 0) return exactRes.data
    } catch (e) {
      // 降级保护
    }
    return []
  }

  async function searchOrdersByKeywordSafely(keyword) {
    const raw = safeText(keyword).trim()
    if (!raw) return []
    const orders = []
    const seen = new Set()
    const pushAll = (list) => {
      for (const item of (list || [])) {
        if (item && item._id && !seen.has(item._id)) {
          seen.add(item._id)
          orders.push(item)
        }
      }
    }

    try {
      const byId = await db.collection('orders').where({ _id: raw }).limit(1).get()
      pushAll(byId.data)
    } catch (_) {}
    try {
      const byNo = await db.collection('orders').where({ orderNo: raw }).limit(10).get()
      pushAll(byNo.data)
    } catch (_) {}

    if (/\d{3,}/.test(raw)) {
      if (db && typeof db.RegExp === 'function') {
        try {
          const res = await db.collection('orders').where({ contactPhone: db.RegExp({ regexp: raw, options: 'i' }) }).limit(50).get()
          pushAll(res.data)
        } catch (_) {}
        try {
          const res = await db.collection('orders').where({ phone: db.RegExp({ regexp: raw, options: 'i' }) }).limit(50).get()
          pushAll(res.data)
        } catch (_) {}
      }
      try {
        const exactContact = await db.collection('orders').where({ contactPhone: raw }).limit(50).get()
        pushAll(exactContact.data)
      } catch (_) {}
      try {
        const exactPhone = await db.collection('orders').where({ phone: raw }).limit(50).get()
        pushAll(exactPhone.data)
      } catch (_) {}
    }

    return orders
  }

  async function searchRelatedOpenidsAndOrderIds(keyword) {
    const raw = safeText(keyword).trim()
    if (!raw) return { matchedOpenids: [], matchedOrderIds: [], rawKeyword: '' }

    const matchedOpenids = new Set()
    const matchedOrderIds = new Set()
    matchedOrderIds.add(raw)

    const [users, profiles, orders] = await Promise.all([
      searchUsersByPhoneSafely(raw),
      searchStaffProfilesByPhoneSafely(raw),
      searchOrdersByKeywordSafely(raw)
    ])

    users.forEach((u) => u && u.openid && matchedOpenids.add(u.openid))
    profiles.forEach((p) => p && p.openid && matchedOpenids.add(p.openid))
    orders.forEach((o) => {
      if (o && o._id) matchedOrderIds.add(o._id)
      if (o && o.orderNo) matchedOrderIds.add(o.orderNo)
      if (o && o.userOpenid) matchedOpenids.add(o.userOpenid)
      if (o && o.staffOpenid) matchedOpenids.add(o.staffOpenid)
    })

    return {
      matchedOpenids: Array.from(matchedOpenids),
      matchedOrderIds: Array.from(matchedOrderIds),
      rawKeyword: raw
    }
  }

  return async function admin(openid, action, data) {
    const admin = await requireAdmin(openid)
    if (action === 'listSubscriptionDeliveries') return listSubscriptionDeliveries(data)
    if (action === 'retrySubscriptionDelivery') return requeueSubscriptionDelivery(safeText(data.id).trim(), openid)
    if (['getMyAdminAccess', 'enableAdminPermissions', 'listAdminGroups', 'saveAdminGroup', 'setAdminMembership', 'getAdminMembership', 'listAdminMembers', 'listOperationActors', 'listOperationLogs'].includes(action)) {
      return handleAdminAccess(admin, action, data)
    }
    if (action === 'dashboard') {
      await expireDueUnacceptedOrders()
      const statuses = ['paid', 'assigned', 'in_service', 'completed']
      const counts = {}
      for (let i = 0; i < statuses.length; i += 1) counts[statuses[i]] = (await db.collection('orders').where({ status: statuses[i] }).count()).total
      const countPending = async (collectionName, where) => {
        const counted = await db.collection(collectionName).where(where).count().catch(() => null)
        if (counted && Number.isFinite(counted.total)) return counted.total
        return (await readAll(collectionName, where, 1000).catch(() => [])).length
      }
      const [staffPending, trainingPending, promotionPending, vaccinePending, withdrawPending, depositRefundPending, supplyPending, incidentsOpen, appearancePending] = await Promise.all([
        countPending('staff_profiles', { auditStatus: 'pending' }),
        countPending('staff_profiles', { auditStatus: 'approved', videoAuditStatus: 'pending' }),
        countPending('staff_promotion_applications', { status: 'pending' }),
        countPending('pet_vaccine_certifications', { status: 'pending' }),
        countPending('withdraw_requests', { status: 'pending' }),
        countPending('staff_deposits', { refundStatus: 'requested' }),
        countPending('staff_supply_reimbursements', { status: 'pending' }),
        countPending('order_incidents', { status: 'open' }),
        countPending('pet_playground_appearance_requests', { status: db.command.in(['pending', 'processing']) })
      ])
      const pendingReviews = {
        staffAudit: staffPending,
        training: trainingPending,
        promotion: promotionPending,
        petVaccine: vaccinePending,
        playgroundCustomizations: appearancePending,
        withdrawals: withdrawPending,
        depositRefunds: depositRefundPending,
        supplyReimbursements: supplyPending,
        finance: withdrawPending + depositRefundPending + supplyPending,
        incidents: incidentsOpen,
        mallOrders: await context.countPendingMallOrders()
      }
      const todayParts = toCstParts()
      const monthStartText = `${todayParts.monthKey}-01 00:00:00`
      const monthStartDate = parseDateValue(monthStartText) || new Date(`${todayParts.monthKey}-01T00:00:00.000Z`)
      const orderProjection = { _id: true, createdAt: true, paidAt: true, paymentStatus: true, status: true, payAmount: true }
      const userProjection = { _id: true, createdAt: true }
      const [orders, users, availableCommissionRows, expiredCommissionRows, availableStaffEarningsRows] = await Promise.all([
        readMonthlyEntities('orders', monthStartDate, monthStartText, orderProjection),
        readMonthlyEntities('users', monthStartDate, monthStartText, userProjection),
        readAll('user_asset_earnings', { status: 'available' }, 5000).catch(() => []),
        readAll('user_asset_earnings', { status: 'expired' }, 5000).catch(() => []),
        readAll('staff_earnings', { status: 'available' }, 5000).catch(() => [])
      ])
      const pendingCommission = Math.round(availableCommissionRows.reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100
      const expiredCommission = Math.round(expiredCommissionRows.reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100
      const pendingStaffEarnings = Math.round(availableStaffEarningsRows
        .filter((r) => !r.isMock && r.paymentChannel !== 'mock')
        .reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100
      return {
        orders: counts,
        staffPending,
        incidentsOpen,
        pendingReviews,
        pendingCommission,
        pendingStaffEarnings,
        expiredCommission,
        platformFinance: {
          pendingCommission,
          pendingStaffEarnings,
          expiredCommission
        },
        monthly: buildMonthlyDashboard(orders, users)
      }
    }
    if (action === 'financeDashboard') {
      await refreshStaffEarnings()
      const dashboard = await aggregateFinanceDashboard(data)
      const wechatTransferQuota = typeof getWechatTransferQuotaOverview === 'function'
        ? await getWechatTransferQuotaOverview().catch(() => null)
        : null
      return { ...dashboard, wechatTransferQuota }
    }
    if (action === 'listFinanceLogs') {
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const targetType = safeText(data.targetType).trim()
      const baseWhere = targetType ? { targetType } : {}
      const logs = await queryFinanceListSafely('finance_logs', {
        baseWhere,
        dateRange: range,
        dateFields: ['createdAt'],
        pageSize: data.pageSize,
        keyword,
        searchContext
      })
      return logs.filter((l) => !keyword || matchFinanceRecord(l, keyword, searchContext))
    }
    if (action === 'listPayments') {
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const baseWhere = status ? { status } : {}
      const payments = await queryFinanceListSafely('payments', {
        baseWhere,
        dateRange: range,
        dateFields: ['paidAt', 'updatedAt', 'createdAt'],
        pageSize: data.pageSize,
        keyword,
        searchContext
      })
      const orderIds = [...new Set(payments.map((p) => p.orderId).filter(Boolean))]
      const orders = orderIds.length && db.command && typeof db.command.in === 'function'
        ? (await db.collection('orders').where({ _id: db.command.in(orderIds) }).limit(orderIds.length).get().catch(() => ({ data: [] }))).data || []
        : []
      const orderMap = new Map(orders.map((o) => [o._id, o]))
      return payments.map((p) => {
        const o = orderMap.get(p.orderId) || {}
        return {
          ...p,
          contactPhone: o.contactPhone || o.phone || '',
          orderNo: o.orderNo || ''
        }
      }).filter((p) => !keyword || matchFinanceRecord(p, keyword, searchContext))
    }
    if (action === 'listRefunds') {
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const baseWhere = status ? { status } : {}
      const refunds = await queryFinanceListSafely('refunds', {
        baseWhere,
        dateRange: range,
        dateFields: ['createdAt', 'updatedAt'],
        pageSize: data.pageSize,
        keyword,
        searchContext
      })
      const orderIds = [...new Set(refunds.map((r) => r.orderId).filter(Boolean))]
      const orders = orderIds.length && db.command && typeof db.command.in === 'function'
        ? (await db.collection('orders').where({ _id: db.command.in(orderIds) }).limit(orderIds.length).get().catch(() => ({ data: [] }))).data || []
        : []
      const orderMap = new Map(orders.map((o) => [o._id, o]))
      return refunds.map((r) => {
        const o = orderMap.get(r.orderId) || {}
        return {
          ...r,
          contactPhone: o.contactPhone || o.phone || '',
          orderNo: o.orderNo || ''
        }
      }).filter((r) => !keyword || matchFinanceRecord(r, keyword, searchContext))
    }
    if (action === 'listStaffEarnings') {
      await refreshStaffEarnings()
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const baseWhere = status ? { status } : {}
      const earnings = await queryFinanceListSafely('staff_earnings', {
        baseWhere,
        dateRange: range,
        dateFields: ['createdAt', 'completedAt'],
        pageSize: data.pageSize,
        keyword,
        searchContext
      })
      const staffOpenids = [...new Set(earnings.map((e) => e.staffOpenid).filter(Boolean))]
      const [users, profiles] = await Promise.all([
        fetchUsersByOpenids(staffOpenids),
        fetchStaffProfilesByOpenids(staffOpenids)
      ])
      const userMap = new Map(users.map((u) => [u.openid, u]))
      const profileMap = new Map(profiles.map((p) => [p.openid, p]))
      return earnings.map((e) => {
        const u = userMap.get(e.staffOpenid) || {}
        const p = profileMap.get(e.staffOpenid) || {}
        const phoneFields = staffPhoneFields(u, p)
        return {
          ...e,
          staffRealName: p.realName || '',
          staffNickname: u.nickname || '',
          staffPhone: phoneFields.phone,
          accountPhone: phoneFields.accountPhone,
          certifiedPhone: phoneFields.certifiedPhone
        }
      }).filter((e) => !keyword || matchFinanceRecord(e, keyword, searchContext))
    }
    if (action === 'listWithdrawRequests') {
      await refreshStaffEarnings()
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const staffOpenid = safeText(data.staffOpenid).trim()
      const baseWhere = { ...(status ? { status } : {}), ...(staffOpenid ? { staffOpenid } : {}) }
      const requests = staffOpenid
        ? await readScopedDocuments('withdraw_requests', baseWhere, 'createdAt', 'desc')
        : await queryFinanceListSafely('withdraw_requests', {
          baseWhere,
          dateRange: range,
          dateFields: ['createdAt', 'paidAt'],
          pageSize: data.pageSize,
          keyword,
          searchContext
        })
      const openids = [...new Set(requests.flatMap((item) => [item.staffOpenid, item.userOpenid]).filter(Boolean))]
      const [profiles, users, earnings, withdraws] = await Promise.all([
        fetchStaffProfilesByOpenids(openids),
        fetchUsersByOpenids(openids),
        fetchFinanceRowsByOpenids('staff_earnings', openids),
        fetchFinanceRowsByOpenids('withdraw_requests', openids)
      ])
      const profileMap = new Map(profiles.map((item) => [item.openid, item]))
      const userMap = new Map(users.map((item) => [item.openid, item]))
      const financeMap = buildStaffFinanceSummary(earnings, withdraws)
      const userAssetOpenids = [...new Set(requests.filter((item) => item.assetType === 'user').map((item) => item.userOpenid).filter(Boolean))]
      const userAssetRows = userAssetOpenids.length && db.command && typeof db.command.in === 'function'
        ? (await readAll('user_asset_earnings', { userOpenid: db.command.in(userAssetOpenids) }, 5000))
        : (await Promise.all(userAssetOpenids.map((id) => readAll('user_asset_earnings', { userOpenid: id }, 5000)))).flat()
      const userAssetWithdraws = await fetchUserAssetWithdrawsByOpenids(userAssetOpenids)
      const userAssetMap = {}
      userAssetRows.forEach((row) => {
        if (!userAssetMap[row.userOpenid]) userAssetMap[row.userOpenid] = { available: 0, withdrawn: 0, withdrawHistory: [], withdrawCount: 0 }
        if (row.status === 'available') userAssetMap[row.userOpenid].available += Number(row.amount || 0)
      })
      userAssetWithdraws.forEach((request) => {
        if (!userAssetMap[request.userOpenid]) userAssetMap[request.userOpenid] = { available: 0, withdrawn: 0, withdrawHistory: [], withdrawCount: 0 }
        const target = userAssetMap[request.userOpenid]
        target.withdrawCount += 1
        if (request.status === 'paid') target.withdrawn += Number(request.amount || 0)
        target.withdrawHistory.push({ _id: request._id, amount: Number(request.amount || 0), status: request.status || '', createdAt: request.createdAt || '', paidAt: request.paidAt || '' })
      })
      Object.values(userAssetMap).forEach((item) => {
        item.available = Math.round(item.available * 100) / 100
        item.withdrawn = Math.round(item.withdrawn * 100) / 100
        item.withdrawHistory.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        item.withdrawHistory = item.withdrawHistory.slice(0, 8)
      })
      const list = requests.map((item) => {
        if (item.assetType === 'user') {
          const user = userMap.get(item.userOpenid) || {}
          const asset = userAssetMap[item.userOpenid] || { available: 0, withdrawn: 0, withdrawHistory: [], withdrawCount: 0 }
          return {
            ...item,
            applicantOpenid: item.userOpenid || item.openid || '',
            staffNickname: user.nickname || '',
            userNickname: user.nickname || '',
            userPhone: user.phone || '',
            phone: user.phone || '',
            currentAvailableAmount: asset.available,
            withdrawnAmount: asset.withdrawn,
            withdrawCount: asset.withdrawCount,
            withdrawHistory: asset.withdrawHistory,
            assetLabel: '用户邀请收益'
          }
        }
        const profile = profileMap.get(item.staffOpenid) || {}
        const user = userMap.get(item.staffOpenid) || {}
        const finance = financeMap[item.staffOpenid] || { available: 0, withdrawn: 0, withdrawHistory: [], withdrawCount: 0 }
        const phoneFields = staffPhoneFields(user, profile)
        return {
          ...item,
          applicantOpenid: item.staffOpenid || item.openid || '',
          staffRealName: profile.realName || item.accountName || '',
          staffPhone: phoneFields.phone,
          accountPhone: phoneFields.accountPhone,
          certifiedPhone: phoneFields.certifiedPhone,
          phone: phoneFields.phone,
          recipientOpenid: item.recipientOpenid || item.staffOpenid || '',
          staffNickname: user.nickname || '',
          currentAvailableAmount: finance.available,
          withdrawnAmount: finance.withdrawn,
          withdrawCount: finance.withdrawCount,
          withdrawHistory: finance.withdrawHistory
        }
      })
      return list.filter((r) => !keyword || matchFinanceRecord(r, keyword, searchContext))
    }
    if (action === 'listUserAssetWithdrawals') {
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const status = safeText(data.status).trim()
      const where = { assetType: 'user' }
      if (status) where.status = status
      const rows = await queryFinanceListSafely('withdraw_requests', {
        baseWhere: where,
        dateRange: buildDateRange(data),
        dateFields: ['createdAt', 'paidAt'],
        pageSize: data.pageSize,
        keyword,
        searchContext
      })
      const openids = [...new Set(rows.map((row) => row.userOpenid).filter(Boolean))]
      const users = await fetchUsersByOpenids(openids)
      const userMap = new Map(users.map((user) => [user.openid, user]))
      const earnings = openids.length && db.command && typeof db.command.in === 'function'
        ? await readAll('user_asset_earnings', { userOpenid: db.command.in(openids) }, 5000)
        : (await Promise.all(openids.map((id) => readAll('user_asset_earnings', { userOpenid: id }, 5000)))).flat()
      const availableMap = {}
      earnings.forEach((earning) => {
        if (earning.status === 'available') availableMap[earning.userOpenid] = (availableMap[earning.userOpenid] || 0) + Number(earning.amount || 0)
      })
      return rows.map((row) => {
        const user = userMap.get(row.userOpenid) || {}
        return {
          ...row,
          userNickname: user.nickname || '',
          userPhone: user.phone || '',
          phone: user.phone || '',
          currentAvailableAmount: Math.round((availableMap[row.userOpenid] || 0) * 100) / 100
        }
      }).filter((r) => !keyword || matchFinanceRecord(r, keyword, searchContext))
    }
    if (action === 'getStaffSettlementPreview') {
      const result = await context.getStaffSettlementPreview(safeText(data.staffProfileId).trim())
      const { groups, ...preview } = result
      return preview
    }
    if (action === 'getStaffRedemptionPreview') return context.getStaffRedemptionPreview(safeText(data.staffProfileId).trim())
    if (action === 'recordStaffEarningRedemption') return context.recordStaffEarningRedemption({ ...admin, openid }, data)
    if (action === 'settleStaffEarningsByWechat') {
      return context.settleStaffEarningsByWechat({ ...admin, openid }, data)
    }
    if (action === 'createStaffManualTailSettlement') {
      return context.createStaffManualTailSettlement({ ...admin, openid }, data)
    }
    if (action === 'auditWithdrawRequest') {
      const approved = data.approved === true
      const auditRemark = safeText(data.auditRemark || data.remark).trim()
      if (auditRemark.length > 500) throw new Error('审核备注不能超过 500 字')
      if (auditRemark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, auditRemark, { scene: 2, label: '提现审核备注' })
      }
      const { request } = await settleWithdrawal({ ...admin, openid }, { ...data, auditRemark })
      if (approved && request.payoutChannel === 'wechat_wallet' && request.status !== 'paid') {
        return startAuditedWechatTransfer(data.id, request, { ...admin, openid })
      }
      await notifyWithdrawal({ ...request, _id: data.id }, approved ? 'approved' : 'rejected')
      return { id: data.id, status: request.status, transferStatus: request.transferStatus }
    }
    if (action === 'auditUserAssetWithdrawal') {
      const approved = data.approved === true
      const result = await settleUserAssetWithdrawal({ ...admin, openid }, { ...data, approved })
      if (approved && result.request && result.request.payoutChannel === 'wechat_wallet' && result.request.status !== 'paid') {
        return startAuditedWechatTransfer(data.id, result.request, { ...admin, openid })
      }
      await notifyWithdrawal({ ...result.request, _id: data.id }, approved ? 'approved' : 'rejected')
      return { id: data.id, status: result.request?.status || (approved ? 'approved' : 'rejected') }
    }
    if (action === 'queryWithdrawTransfer') {
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少提现申请 ID')
      const result = await queryWechatWithdrawalTransfer(id)
      return transferResult(id, result)
    }
    if (action === 'retryWithdrawTransfer') {
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少提现申请 ID')
      const result = await retryWechatWithdrawalTransfer(id, { ...admin, openid })
      return transferResult(id, result)
    }
    if (action === 'releaseFailedWithdraw') {
      const remark = safeText(data.remark || data.auditRemark).trim()
      if (remark.length > 500) throw new Error('处理备注不能超过 500 字')
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少提现申请 ID')
      const original = (await db.collection('withdraw_requests').doc(id).get()).data
      if (original && Number(original.amount) > 0 && Number(original.amount) < 0.10 && original.gatewayFailureConfirmed !== true) {
        return transferResult(id, await context.returnSmallWechatWithdrawal(id, { ...admin, openid }))
      }
      const { request } = await releaseFailedWithdrawal({ ...admin, openid }, { ...data, remark })
      return { id: data.id, status: request.status, transferStatus: request.transferStatus }
    }
    if (action === 'markWithdrawPaid') {
      const payRemark = safeText(data.payRemark || data.remark).trim()
      if (payRemark.length > 500) throw new Error('打款备注不能超过 500 字')
      if (payRemark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, payRemark, { scene: 2, label: '提现打款备注' })
      }
      const paymentProofImage = safeText(data.paymentProofImage || data.paymentProof || '').trim()
      if (paymentProofImage && typeof checkImageSecurity === 'function') {
        await checkImageSecurity(openid, paymentProofImage, { scene: 1, label: '付款凭证截图' })
      }
      const { request, changed } = await settleWithdrawal({ ...admin, openid }, { ...data, payRemark, paymentProofImage }, true)
      if (changed) await notifyWithdrawal({ ...request, _id: data.id }, 'paid')
      if (request.source === 'admin_manual_tail_settlement') {
        try {
          const deposits = (await readAll('staff_deposits', { staffOpenid: request.staffOpenid }))
            .filter(deposit => deposit.refundStatus === 'success' && deposit.refundExitPending === true)
          for (const deposit of deposits) await context.finalizeStaffDepositExit(deposit._id)
        } catch (error) {
          console.warn('[manual-tail-exit-sync]', { withdrawId: data.id, message: error.message })
        }
      }
      return { id: data.id, status: 'paid' }
    }
    if (action === 'getSystemSettings') {
      // The answer-bearing bank is returned only by this authorized administrator route.
      return { ...await getSystemSettings(), staffTrainingQuestionBank: DEFAULT_STAFF_TRAINING_QUIZ }
    }
    if (action === 'savePlaygroundSettings') {
      const current=await getSystemSettings({includeSecrets:true})
      const saved=await saveSystemSettings({...current,playground:data.playground,playgroundCare:data.playgroundCare,playgroundGroupBuy:data.playgroundGroupBuy})
      const result=normalizeSystemSettings(saved.value)
      await logAdmin(admin,'platform_config','playground','savePlaygroundSettings',{playground:result.playground,playgroundGroupBuy:result.playgroundGroupBuy,playgroundCare:result.playgroundCare})
      return result
    }
    if (action === 'saveSystemSettings') {
      const payload = (data && data.settings && typeof data.settings === 'object') ? data.settings : data
      if (payload && payload.staffDeposit && payload.staffDeposit.amount !== undefined) {
        const current = await getSystemSettings()
        const currentAmount = Number(current.staffDeposit && current.staffDeposit.amount || 0)
        const nextAmount = Number(payload.staffDeposit.amount)
        if (Number.isFinite(nextAmount) && Math.abs(nextAmount - currentAmount) >= 0.005) {
          await freezeLegacyDepositStandards(currentAmount)
        }
      }
      const saved = await saveSystemSettings(payload)
      const publicValue = normalizeSystemSettings(saved.value)
      await logAdmin(admin, 'platform_config', 'system_settings', 'saveSystemSettings', publicValue)
      return { ...publicValue, staffTrainingQuestionBank: DEFAULT_STAFF_TRAINING_QUIZ }
    }
    if (action === 'updateVideoAuditGuide') {
      const currentSettings = await getSystemSettings({ includeSecrets: true })
      const guide = normalizeVideoAuditGuide(data.guide || data)
      const staffTraining = {
        ...(currentSettings.staffTraining || {}),
        videoAuditGuide: guide
      }
      await saveSystemSettings({
        ...currentSettings,
        staffTraining
      })
      await logAdmin(admin, 'platform_config', 'video_audit_guide', 'updateVideoAuditGuide', guide)
      return { success: true, videoAuditGuide: guide }
    }
    if (action === 'listUsers') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const role = safeText(data.role).trim()
      const status = safeText(data.status).trim()
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
      const offset = (page - 1) * pageSize

      const where = {}
      if (status) where.status = status
      if (role) {
        where.roles = db.command && typeof db.command.in === 'function' ? db.command.in([role]) : role
      }

      if (!keyword) {
        const countRes = await db.collection('users').where(where).count()
        const total = Number(countRes?.total || 0)
        const res = await db.collection('users')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = (res.data || []).map((user) => safeUserSummary(user))
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + pageSize < total
        }
      }

      const allUsers = await readAll('users', where, 5000)
      const filtered = allUsers
        .filter((user) => !role || (Array.isArray(user.roles) && user.roles.includes(role)))
        .filter((user) => !status || user.status === status)
        .filter((user) => [user.openid, user.nickname, user.phone].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .map((user) => safeUserSummary(user))
      return paginateList(filtered, data)
    }
    if (action === 'getUserDetail') {
      const targetOpenid = safeText(data.openid).trim()
      const targetUserId = safeText(data.userId || data._id).trim()
      let target = null
      if (targetOpenid) target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get().catch(() => ({ data: [] }))).data[0]
      else if (targetUserId) target = (await db.collection('users').doc(targetUserId).get().catch(() => ({ data: null }))).data
      if (!target) throw new Error('用户不存在')
      const stats = await getUserManageStats(target)
      let commissionSummary = { available: 0, withdrawn: 0, expired: 0, total: 0 }
      const [earningsRows, withdrawRows] = await Promise.all([
        readAll('user_asset_earnings', { userOpenid: target.openid }, 2000).catch(() => []),
        readAll('withdraw_requests', { assetType: 'user', userOpenid: target.openid }, 500).catch(() => [])
      ])
      const currentTime = now()
      let commAvailable = 0
      let commExpired = 0
      earningsRows.forEach((r) => {
        const amt = Number(r.amount || 0)
        let status = r.status || 'available'
        if (status === 'available' && userAssetExpiryDate(r) && userAssetExpiryDate(r) <= currentTime) {
          status = 'expired'
        }
        if (status === 'available') commAvailable += amt
        else if (status === 'expired') commExpired += amt
      })
      const paidWithdrawTotal = withdrawRows
        .filter((w) => w.status === 'paid')
        .reduce((sum, w) => sum + Number(w.amount || 0), 0)
      const earningsWithdrawnTotal = earningsRows
        .filter((r) => r.status === 'withdrawn')
        .reduce((sum, r) => sum + Number(r.amount || 0), 0)
      const commWithdrawn = paidWithdrawTotal > 0 ? paidWithdrawTotal : earningsWithdrawnTotal
      commissionSummary = {
        available: Math.round(commAvailable * 100) / 100,
        withdrawn: Math.round(commWithdrawn * 100) / 100,
        expired: Math.round(commExpired * 100) / 100,
        total: Math.round((commAvailable + commWithdrawn + commExpired) * 100) / 100
      }
      return {
        ...safeUserSummary(target, { isSelf: target.openid === openid }),
        inviteCode: target.inviteCode || '',
        retroCardCount: Number(target.retroCardCount || 0),
        completedOrderCount: Number(target.completedOrderCount || 0),
        stats,
        commission: commissionSummary
      }
    }
    if (action === 'getUserRelatedDetails') {
      const targetOpenid = safeText(data.openid).trim()
      const targetUserId = safeText(data.userId || data._id).trim()
      const type = safeText(data.type).trim() || 'all'
      let target = null
      if (targetOpenid) target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get().catch(() => ({ data: [] }))).data[0]
      else if (targetUserId) target = (await db.collection('users').doc(targetUserId).get().catch(() => ({ data: null }))).data
      if (!target) throw new Error('用户不存在')
      const targetUserOpenid = target.openid

      const result = { openid: targetUserOpenid }

      // 1. 优惠券明细
      if (['all', 'coupons'].includes(type)) {
        const rawCoupons = await readAll('user_coupons', { openid: targetUserOpenid }, 500).catch(() => [])
        const sourceMap = {
          register_grant: '新用户注册赠送',
          admin_manual_grant: '管理员手动发放',
          lottery_reward: '幸运抽奖奖品',
          order_refund: '售后退款补偿',
          activity: '营销活动发放',
          invite_reward: '邀请好友奖励'
        }
        const currentTime = now()
        result.coupons = rawCoupons
          .map((item) => {
            const snap = item.templateSnapshot || {}
            let status = item.status || 'available'
            if (status === 'available' && parseBeijingDateValue(item.validTo) && parseBeijingDateValue(item.validTo) < currentTime) {
              status = 'expired'
            }
            const statusMap = { available: '可使用', used: '已使用', expired: '已过期', locked: '已锁定', void: '已作废' }
            return {
              _id: item._id,
              name: snap.name || item.name || '优惠券',
              discountAmount: snap.discountAmount !== undefined ? snap.discountAmount : (item.discountAmount || 0),
              minOrderAmount: snap.minOrderAmount !== undefined ? snap.minOrderAmount : (item.minOrderAmount || 0),
              usageScopeText: snap.usageScopeText || item.usageScopeText || '全场通用',
              sourceType: item.sourceType || '',
              sourceText: sourceMap[item.sourceType] || item.source || item.reason || (item.issuedByAdminOpenid ? '后台管理员发放' : '系统发放'),
              issuedAt: item.issuedAt || item.createdAt || '',
              validFrom: item.validFrom || '',
              validTo: item.validTo || '',
              status,
              statusText: statusMap[status] || status,
              usedAt: item.usedAt || '',
              usedOrderId: item.usedOrderId || ''
            }
          })
          .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))
      }

      // 2. 积分详细流水
      if (['all', 'pointLogs'].includes(type)) {
        const rawLogs = await readAll('point_logs', { openid: targetUserOpenid }, 1000).catch(() => [])
        result.pointLogs = rawLogs
          .map((item) => ({
            _id: item._id,
            delta: Number(item.delta || 0),
            balance: item.balance !== undefined ? Number(item.balance) : null,
            reason: item.reason || item.description || '积分变动',
            sourceType: item.sourceType || '',
            createdAt: item.createdAt || ''
          }))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      }

      // 3. 地址资料
      if (['all', 'addresses'].includes(type)) {
        const rawAddresses = await readAll('user_addresses', { openid: targetUserOpenid }, 100).catch(() => [])
        result.addresses = rawAddresses
          .map((item) => ({
            _id: item._id,
            contactName: item.contactName || '',
            contactPhone: item.contactPhone || '',
            serviceAddress: item.serviceAddress || '',
            addressDetail: item.addressDetail || '',
            doorplate: item.doorplate || '',
            fullAddress: `${item.serviceAddress || ''}${item.addressDetail ? ' ' + item.addressDetail : ''}${item.doorplate ? ' ' + item.doorplate : ''}`.trim(),
            label: item.label || '',
            isDefault: !!item.isDefault,
            createdAt: item.createdAt || ''
          }))
          .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      }

      // 4. 宠物资料
      if (['all', 'pets'].includes(type)) {
        const rawPets = await readAll('pets', { openid: targetUserOpenid }, 100).catch(() => [])
        result.pets = rawPets
          .map((item) => ({
            _id: item._id,
            name: item.name || '',
            species: item.species === 'cat' ? '猫咪' : item.species === 'dog' ? '狗狗' : (item.species || '爱宠'),
            breed: item.breed || '',
            age: item.age || item.ageText || '',
            gender: item.gender === 'male' ? '公' : item.gender === 'female' ? '母' : (item.gender || '未知'),
            weight: item.weight ? `${item.weight}kg` : '',
            sterilized: item.sterilized ? '已绝育' : (item.sterilized === false ? '未绝育' : '未知'),
            avatarUrl: item.avatarUrl || '',
            createdAt: item.createdAt || ''
          }))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      }

      // 5. 佣金全流程数据（获得明细、提现记录、过期记录）
      if (['all', 'commission', 'commission_earnings', 'commission_withdraws', 'commission_expired'].includes(type)) {
        const [earningsRows, withdrawRows] = await Promise.all([
          readAll('user_asset_earnings', { userOpenid: targetUserOpenid }, 2000).catch(() => []),
          readAll('withdraw_requests', { assetType: 'user', userOpenid: targetUserOpenid }, 500).catch(() => [])
        ])

        const currentTime = now()
        let available = 0
        let expired = 0
        let withdrawing = 0

        earningsRows.forEach((row) => {
          const amt = Number(row.amount || 0)
          let status = row.status || 'available'
          if (status === 'available' && userAssetExpiryDate(row) && userAssetExpiryDate(row) <= currentTime) {
            status = 'expired'
          }
          if (status === 'available') available += amt
          else if (status === 'expired') expired += amt
          else if (status === 'withdrawing') withdrawing += amt
        })

        const paidWithdrawTotal = withdrawRows
          .filter((w) => w.status === 'paid')
          .reduce((sum, w) => sum + Number(w.amount || 0), 0)
        const earningsWithdrawnTotal = earningsRows
          .filter((r) => r.status === 'withdrawn')
          .reduce((sum, r) => sum + Number(r.amount || 0), 0)
        const withdrawn = paidWithdrawTotal > 0 ? paidWithdrawTotal : earningsWithdrawnTotal

        const earningSourceMap = {
          invite_binding: '好友邀请奖励',
          order_commission: '订单分销佣金',
          beauty_prize: '美宠大赛奖金',
          admin_manual_grant: '管理员手动补贴'
        }

        const earnings = earningsRows
          .map((item) => {
            let status = item.status || 'available'
            if (status === 'available' && userAssetExpiryDate(item) && userAssetExpiryDate(item) <= currentTime) {
              status = 'expired'
            }
            return {
              _id: item._id,
              amount: Number(item.amount || 0),
              amountText: Number(item.amount || 0).toFixed(2),
              sourceType: item.sourceType || '',
              sourceTypeText: earningSourceMap[item.sourceType] || item.sourceType || '推广佣金',
              status,
              statusText: ({ available: '可提现', withdrawn: '已提现', withdrawing: '提现中', expired: '已过期' })[status] || status,
              invitedOpenid: item.invitedOpenid || '',
              sourceId: item.sourceId || '',
              orderId: item.orderId || '',
              createdAt: item.createdAt || '',
              expiresAt: userAssetExpiryDate(item) || ''
            }
          })
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

        const withdraws = withdrawRows
          .map((item) => ({
            _id: item._id,
            amount: Number(item.amount || 0),
            amountText: Number(item.amount || 0).toFixed(2),
            status: item.status || 'pending',
            statusText: ({ pending: '待审核', approved: '待打款', transferring: '转账中', paid: '已到账', rejected: '已驳回', transfer_failed: '转账失败' })[item.status] || item.status,
            payoutChannel: item.payoutChannel === 'wechat_wallet' ? '微信零钱' : '人工打款',
            paymentReference: item.paymentReference || item.outBillNo || '',
            auditRemark: item.auditRemark || '',
            createdAt: item.createdAt || '',
            paidAt: item.paidAt || ''
          }))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

        const expiredRecords = earnings.filter((item) => item.status === 'expired')

        result.commission = {
          available: Math.round(available * 100) / 100,
          withdrawn: Math.round(withdrawn * 100) / 100,
          withdrawing: Math.round(withdrawing * 100) / 100,
          expired: Math.round(expired * 100) / 100,
          total: Math.round((available + withdrawn + withdrawing + expired) * 100) / 100,
          availableText: (Math.round(available * 100) / 100).toFixed(2),
          withdrawnText: (Math.round(withdrawn * 100) / 100).toFixed(2),
          expiredText: (Math.round(expired * 100) / 100).toFixed(2),
          totalText: (Math.round((available + withdrawn + withdrawing + expired) * 100) / 100).toFixed(2),
          earnings,
          withdraws,
          expiredRecords
        }
      }

      // 6. 居家安全资料
      if (['all', 'homeSecurity'].includes(type)) {
        result.homeSecurity = await readAll('home_security', { openid: targetUserOpenid }, 50).catch(() => [])
      }

      // 7. 签到记录
      if (['all', 'checkins'].includes(type)) {
        const checkins = await readAll('user_checkins', { openid: targetUserOpenid }, 100).catch(() => [])
        result.checkins = checkins.sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')))
      }

      // 8. 奖励邮件
      if (['all', 'rewardMails'].includes(type)) {
        const mails = await readAll('reward_mails', { openid: targetUserOpenid }, 100).catch(() => [])
        result.rewardMails = mails.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      }

      // 9. 关注宠托师
      if (['all', 'favorites'].includes(type)) {
        result.favorites = await readAll('sitter_favorites', { openid: targetUserOpenid }, 100).catch(() => [])
      }

      return result
    }
    if (action === 'updateUserProfile') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('缺少用户 openid')
      const target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      if (target.status === 'deleted') throw new Error('已删除用户不可编辑')
      const status = safeText(data.status || target.status || 'active').trim()
      if (!['active', 'disabled'].includes(status)) throw new Error('用户状态无效')
      const roles = normalizeEditableRoles(data.roles)
      await assertStaffFundsSettledBeforeRoleRemoval(target, roles)
      await protectAdminOwner(target, roles, status)
      await assertAdminRoleChangeAllowed(target, roles, openid)
      const activeRole = roles.includes(data.activeRole) ? data.activeRole : (roles.includes(target.activeRole) ? target.activeRole : roles[0])
      const points = Math.max(Math.round(Number(data.points || 0)), 0)
      const totalPoints = Math.max(Math.round(Number(data.totalPoints || 0)), points)
      const levels = await getMemberLevels()
      const levelInfo = resolveUserMemberLevel({
        memberLevel: data.memberLevel,
        memberLevelName: data.memberLevelName,
        points,
        totalPoints
      }, levels)
      const update = {
        nickname: safeText(data.nickname).trim() || '微信用户',
        phone: safeText(data.phone).trim(),
        avatarUrl: safeText(data.avatarUrl).trim(),
        status,
        roles,
        activeRole,
        memberLevel: levelInfo.memberLevel,
        memberLevelName: levelInfo.memberLevelName,
        badgeTag: levelInfo.badgeTag,
        badgeStyle: levelInfo.badgeStyle,
        nameColor: levelInfo.nameColor,
        nameEffect: levelInfo.nameEffect,
        points,
        totalPoints,
        retroCardCount: Math.max(Math.round(Number(data.retroCardCount || 0)), 0),
        updatedAt: now()
      }
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'updateUserProfile', update)
      return safeUserSummary({ ...target, ...update }, { retroCardCount: update.retroCardCount })
    }
    if (action === 'deleteUser') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('缺少用户 openid')
      const target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      await assertUserDeleteAllowed(target, openid)
      await protectAdminOwner(target, [], 'deleted')
      const cleanup = await cleanupUserPersonalData(targetOpenid)
      const time = now()
      const update = {
        status: 'deleted',
        nickname: '已删除用户',
        avatarUrl: '',
        phone: '',
        roles: ['client'],
        activeRole: 'client',
        points: 0,
        totalPoints: 0,
        retroCardCount: 0,
        deletedAt: time,
        deletedByOpenid: openid,
        updatedAt: time
      }
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'deleteUser', { cleanup })
      return { openid: targetOpenid, cleanup, user: safeUserSummary({ ...target, ...update }) }
    }
    if (action === 'hardDeleteUser') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('缺少用户 openid')
      const target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      await assertUserDeleteAllowed(target, openid, '不能彻底删除自己的账号')
      await protectAdminOwner(target, [], 'deleted')
      const time = now()
      const cleanup = await cleanupUserPersonalData(targetOpenid)
      cleanup.historicalRecordsDetached = await detachUserFromHistoricalRecords(targetOpenid, time)
      await db.collection('users').doc(target._id).remove()
      await logAdmin(admin, 'user', targetOpenid, 'hardDeleteUser', { userId: target._id, cleanup })
      return { openid: targetOpenid, userId: target._id, cleanup }
    }
    if (action === 'listPets') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const species = safeText(data.species).trim().toLowerCase()
      const contestStatus = safeText(data.contestStatus || data.status).trim()
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)

      const allPets = await readAll('pets', {}, 5000)

      let matchedUserOpenids = null
      let userMap = {}
      if (keyword) {
        const allUsers = await readAll('users', {}, 5000)
        for (const u of allUsers) {
          userMap[u.openid] = {
            openid: u.openid,
            nickname: u.nickname || '微信用户',
            phone: u.phone || '',
            avatarUrl: u.avatarUrl || '',
            memberLevelName: u.memberLevelName || '普通会员'
          }
        }
        matchedUserOpenids = new Set(
          allUsers.filter((u) => [u.openid, u.nickname, u.phone].some((v) => safeText(v).toLowerCase().includes(keyword)))
            .map((u) => u.openid)
        )
      }

      const filtered = allPets.filter((pet) => {
        if (pet.deletedAt) return false
        const petSpecies = pet.species || 'dog'
        if (species && ['dog', 'cat', 'other'].includes(species) && petSpecies !== species) {
          return false
        }
        if (contestStatus === 'disqualified' && !pet.beautyContestDisqualified) {
          return false
        }
        if (contestStatus === 'qualified' && pet.beautyContestDisqualified) {
          return false
        }
        if (keyword) {
          const matchPet = [pet._id, pet.exclusiveId, pet.name, pet.breed, pet.openid].some((v) => safeText(v).toLowerCase().includes(keyword))
          const matchOwner = matchedUserOpenids && matchedUserOpenids.has(pet.openid)
          if (!matchPet && !matchOwner) return false
        }
        return true
      })

      filtered.sort((a, b) => {
        const aTime = (parseDateValue(a.createdAt) && parseDateValue(a.createdAt).getTime()) || 0
        const bTime = (parseDateValue(b.createdAt) && parseDateValue(b.createdAt).getTime()) || 0
        if (bTime !== aTime) return bTime - aTime
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      })

      const total = filtered.length
      const offset = (page - 1) * pageSize
      const slice = filtered.slice(offset, offset + pageSize)

      const missingOpenids = [...new Set(slice.map((p) => p.openid).filter((id) => id && !userMap[id]))]
      if (missingOpenids.length > 0) {
        if (db.command && typeof db.command.in === 'function') {
          for (let i = 0; i < missingOpenids.length; i += 50) {
            const chunk = missingOpenids.slice(i, i + 50)
            const uRes = await db.collection('users').where({ openid: db.command.in(chunk) }).get().catch(() => ({ data: [] }))
            for (const u of (uRes.data || [])) {
              userMap[u.openid] = {
                openid: u.openid,
                nickname: u.nickname || '微信用户',
                phone: u.phone || '',
                avatarUrl: u.avatarUrl || '',
                memberLevelName: u.memberLevelName || '普通会员'
              }
            }
          }
        } else {
          for (const oid of missingOpenids) {
            const uRes = await db.collection('users').where({ openid: oid }).limit(1).get().catch(() => ({ data: [] }))
            if (uRes.data && uRes.data[0]) {
              const u = uRes.data[0]
              userMap[u.openid] = {
                openid: u.openid,
                nickname: u.nickname || '微信用户',
                phone: u.phone || '',
                avatarUrl: u.avatarUrl || '',
                memberLevelName: u.memberLevelName || '普通会员'
              }
            }
          }
        }
      }

      const list = slice.map((pet) => {
        const owner = userMap[pet.openid] || {
          openid: pet.openid || '',
          nickname: '未知用户',
          phone: '',
          avatarUrl: '',
          memberLevelName: '普通会员'
        }
        const beautyPhotos = Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos : []
        const avatarFileId = pet.avatarFileId || (beautyPhotos[0] && (beautyPhotos[0].fileId || beautyPhotos[0].url)) || ''
        const rawWeight = Number(pet.weight)
        const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : ''
        const createdAt = pet.createdAt || ''
        const updatedAt = pet.updatedAt || ''
        return {
          _id: pet._id || '',
          exclusiveId: pet.exclusiveId || '',
          name: pet.name || '未命名',
          species: pet.species || 'dog',
          speciesText: pet.species === 'cat' ? '猫咪' : (pet.species === 'other' ? '异宠' : '狗狗'),
          breed: pet.breed || '混血/未知',
          gender: pet.gender || 'unknown',
          genderText: pet.gender === 'male' ? '弟弟 (公)' : (pet.gender === 'female' ? '妹妹 (母)' : '未知'),
          sterilized: Boolean(pet.sterilized),
          sterilizedText: pet.sterilized ? '已绝育' : '未绝育',
          weight,
          birthday: pet.birthday || '',
          avatarFileId,
          beautyPhotos,
          beautyPhotoCount: beautyPhotos.length,
          beautyTitle: pet.beautyTitle || null,
          personality: pet.personality || '',
          favoriteFood: pet.favoriteFood || '',
          dislikes: pet.dislikes || '',
          healthNotes: pet.healthNotes || '',
          specialNotes: pet.specialNotes || '',
          careTags: Array.isArray(pet.careTags) ? pet.careTags : [],
          feedingNotes: pet.feedingNotes || '',
          toiletNotes: pet.toiletNotes || '',
          walkingNotes: pet.walkingNotes || '',
          medicalCareNotes: pet.medicalCareNotes || '',
          emergencyContactNote: pet.emergencyContactNote || '',
          riskLevel: pet.riskLevel || 'normal',
          beautyContestDisqualified: Boolean(pet.beautyContestDisqualified),
          disqualifiedReason: pet.disqualifiedReason || '',
          disqualifiedAt: pet.disqualifiedAt || '',
          disqualifiedBy: pet.disqualifiedBy || '',
          createdAt,
          updatedAt,
          owner
        }
      })

      return {
        list,
        total,
        page,
        pageSize,
        hasMore: offset + pageSize < total
      }
    }
    if (action === 'listStaffProfiles') {
      await refreshStaffEarnings()
      const settings = await getSystemSettings()
      const defaultCommissionRate = Number(settings.settlement?.staffCommissionRate ?? 0.7)
      const defaultDepositStandard = Number(settings.staffDeposit?.amount || 0)
      const rawAuditStatus = safeText(data.auditStatus).trim()
      const isCanRevokeAuditStatus = rawAuditStatus === 'can_revoke'
      const auditStatus = isCanRevokeAuditStatus ? 'approved' : rawAuditStatus
      const canRevoke = safeText(data.canRevoke || (isCanRevokeAuditStatus ? 'yes' : '')).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
      const offset = (page - 1) * pageSize

      const where = {}
      if (auditStatus) where.auditStatus = auditStatus

      const hasAdvancedFilter = Boolean(
        keyword ||
        isCanRevokeAuditStatus ||
        canRevoke === 'yes' || canRevoke === 'no' ||
        (data.minDeposit !== undefined && data.minDeposit !== '' && !isNaN(Number(data.minDeposit))) ||
        (data.maxDeposit !== undefined && data.maxDeposit !== '' && !isNaN(Number(data.maxDeposit))) ||
        (data.hasViolations === 'yes' || data.hasViolations === true || data.hasViolations === 'no' || data.hasViolations === false) ||
        (data.requireRepayStatus === 'yes' || data.requireRepayStatus === 'no')
      )

      async function fetchByOpenids(collectionName, fieldName, openids = []) {
        if (!openids || !openids.length) return []
        const cleanOpenids = [...new Set(openids.filter(Boolean))]
        if (!cleanOpenids.length) return []
        const results = []
        const chunkSize = 50
        for (let i = 0; i < cleanOpenids.length; i += chunkSize) {
          const chunk = cleanOpenids.slice(i, i + chunkSize)
          if (db.command && typeof db.command.in === 'function') {
            results.push(...await readAll(collectionName, { [fieldName]: db.command.in(chunk) }, Infinity))
          } else {
            for (const id of chunk) {
              results.push(...await readAll(collectionName, { [fieldName]: id }, Infinity))
            }
          }
        }
        return results
      }

      function buildDecoratedProfiles(profiles, allUsers, allEvidences, allDeposits, financeSummary = {}) {
        const userMap = new Map((allUsers || []).map((user) => [user.openid, user]))

        const evidenceByStaff = {}
        const sortedEvidences = (allEvidences || []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        for (const ev of sortedEvidences) {
          const key = ev.staffOpenid || ev.openid
          if (!key) continue
          if (!evidenceByStaff[key]) evidenceByStaff[key] = []
          evidenceByStaff[key].push(ev)
        }

        const depositsByStaff = {}
        for (const d of (allDeposits || [])) {
          const key = d.staffOpenid || d.openid
          if (!key) continue
          if (!depositsByStaff[key]) depositsByStaff[key] = []
          depositsByStaff[key].push(d)
        }

        return profiles.map((profile) => {
          const user = userMap.get(profile.openid) || {}
          const workflow = normalizeStaffWorkflow(profile)
          const staffEvidences = evidenceByStaff[profile.openid] || []
          const problemOrders = staffEvidences.map((e) => {
            const actualDeductAmount = Number(e.actualDeductAmount ?? e.forfeitedAmount ?? 0)
            const status = e.status || 'pending'
            return {
              _id: e._id,
              orderId: e.orderId,
              orderNo: e.orderNo || '',
              serviceSummary: e.serviceSummary || '',
              reasonType: e.reasonType || '',
              reasonTypeName: e.reasonTypeName || '',
              reasonText: e.reasonText || '',
              deductAmount: Number(e.deductAmount || 0),
              actualDeductAmount,
              actualDeductAmountText: actualDeductAmount > 0 ? actualDeductAmount.toFixed(2) : '',
              status,
              statusText: status === 'forfeited' ? '已根据建议扣除保证金' : (status === 'dismissed' ? '已撤销免除' : '待执行扣除'),
              createdAt: e.createdAt || '',
              staffOpenid: e.staffOpenid || profile.openid
            }
          })

          const staffDeposits = depositsByStaff[profile.openid] || []
          staffDeposits.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

          const unsettledDeposit = staffDeposits.find((deposit) => {
            const netAvailable = deposit.availableRefundAmount != null
              ? Number(deposit.availableRefundAmount)
              : (Number(deposit.paidAmount || 0) - Number(deposit.refundedAmount || 0) - Number(deposit.forfeitedAmount || 0) - Number(deposit.supplyFeeDeductedAmount || 0))
            const available = Math.round(Math.max(0, netAvailable) * 100)
            const status = safeText(deposit.status).trim()
            const refundStatus = safeText(deposit.refundStatus).trim()
            const isRefundInFlight = ['refund_requested', 'refund_approved'].includes(status) || ['requested', 'approved', 'processing'].includes(refundStatus)
            return available > 0 || isRefundInFlight
          })
          const hasUnsettledDeposit = Boolean(unsettledDeposit)

          let depositBalance = 0
          for (const d of staffDeposits) {
            const netAvailable = d.availableRefundAmount != null
              ? Number(d.availableRefundAmount)
              : (Number(d.paidAmount || 0) - Number(d.refundedAmount || 0) - Number(d.forfeitedAmount || 0) - Number(d.supplyFeeDeductedAmount || 0))
            depositBalance += Math.max(0, netAvailable)
          }
          depositBalance = Math.round(depositBalance * 100) / 100

          const primaryDeposit = unsettledDeposit || staffDeposits[0] || null
          const depositPaidAmount = staffDeposits.reduce((sum, d) => sum + Number(d.paidAmount || 0), 0)
          const depositForfeitedAmount = staffDeposits.reduce((sum, d) => sum + Number(d.forfeitedAmount || 0), 0)
          const depositStandardAmount = profileDepositStandard(profile, defaultDepositStandard)
          const depositTopUpAmount = Math.max(0, Math.round((depositStandardAmount - depositBalance) * 100) / 100)
          const depositStatus = profile.depositStatus || (primaryDeposit ? primaryDeposit.status : 'unpaid')
          const requireDepositRepay = profile.requireDepositRepay === true
          const finance = financeSummary[profile.openid] || { available: 0, withdrawn: 0, withdrawHistory: [], withdrawCount: 0, hasUnsettledEarning: false, hasPendingWithdraw: false }
          const phoneFields = staffPhoneFields(user, profile)
          const withdrawableAmount = Math.round(Number(finance.available || 0) * 100) / 100

          const canRevokeStaff = (profile.auditStatus === 'approved') &&
            depositBalance <= 0 &&
            !hasUnsettledDeposit &&
            !finance.hasPendingWithdraw &&
            !finance.hasUnsettledEarning &&
            withdrawableAmount <= 0

          return {
            _id: profile._id,
            depositId: primaryDeposit ? (primaryDeposit._id || primaryDeposit.id) : '',
            openid: profile.openid || '',
            realName: profile.realName || '',
            phone: phoneFields.phone,
            accountPhone: phoneFields.accountPhone,
            certifiedPhone: phoneFields.certifiedPhone,
            serviceCity: profile.serviceCity || '',
            serviceAreas: profile.serviceAreas || '',
            auditStatus: profile.auditStatus || 'pending',
            auditStatusText: auditStatusText(profile.auditStatus || 'pending'),
            auditRemark: profile.auditRemark || '',
            staffLevel: workflow.staffLevel,
            staffLevelText: workflow.staffLevelText,
            commissionRateOverride: profile.commissionRateOverride ?? null,
            onboardingStatus: workflow.onboardingStatus,
            onboardingStatusText: workflow.onboardingStatusText,
            videoAuditStatus: workflow.videoAuditStatus,
            videoAuditStatusText: workflow.videoAuditStatusText,
            promotionStatus: workflow.promotionStatus,
            promotionStatusText: workflow.promotionStatusText,
            internCompletedOrderCount: workflow.internCompletedOrderCount,
            ratingAverage: Number(profile.ratingAverage || 0),
            reviewCount: Number(profile.reviewCount || 0),
            isFeatured: profile.isFeatured === true,
            featuredAt: profile.featuredAt || '',
            createdAt: profile.createdAt || '',
            updatedAt: profile.updatedAt || '',
            userNickname: user.nickname || '微信用户',
            userAvatarUrl: user.avatarUrl || '',
            userStatus: user.status || '',
            roles: Array.isArray(user.roles) ? user.roles : [],
            problemOrderCount: staffEvidences.length,
            pendingPenaltyCount: staffEvidences.filter((e) => e.status === 'pending').length,
            problemOrders,
            depositBalance,
            depositStandardAmount,
            depositEntryStandardAmount: profile.depositEntryStandardAmount ?? depositStandardAmount,
            depositTopUpAmount,
            depositPaidAmount,
            depositForfeitedAmount,
            depositStatus,
            hasUnsettledDeposit,
            canRevokeStaff,
            requireDepositRepay,
            requireDepositRepayReason: profile.requireDepositRepayReason || '',
            requireDepositRepayAt: profile.requireDepositRepayAt || '',
            manualRedemption: settings.settlement?.staffEarningsMode === 'manual_redemption',
            estimatedEarnings: Math.round((Number(finance.pending || 0) + withdrawableAmount) * 100) / 100,
            redeemedAmount: Math.round(Number(finance.redeemed || 0) * 100) / 100,
            withdrawableAmount,
            withdrawnAmount: Math.round(Number(finance.withdrawn || 0) * 100) / 100,
            withdrawCount: Number(finance.withdrawCount || 0),
            withdrawHistory: finance.withdrawHistory || []
          }
        })
      }

      if (!hasAdvancedFilter) {
        const countRes = await db.collection('staff_profiles').where(where).count()
        const total = Number(countRes?.total || 0)
        const profilesRes = await db.collection('staff_profiles')
          .where(where)
          .orderBy('updatedAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const pageProfiles = profilesRes.data || []
        const pageOpenids = [...new Set(pageProfiles.map((p) => p.openid).filter(Boolean))]

        const [pageUsers, pageEvidences, pageDeposits, pageEarnings, pageWithdraws] = await Promise.all([
          fetchByOpenids('users', 'openid', pageOpenids),
          fetchByOpenids('staff_deposit_evidences', 'staffOpenid', pageOpenids),
          fetchByOpenids('staff_deposits', 'staffOpenid', pageOpenids),
          fetchFinanceRowsByOpenids('staff_earnings', pageOpenids),
          fetchFinanceRowsByOpenids('withdraw_requests', pageOpenids)
        ])

        const list = buildDecoratedProfiles(pageProfiles, pageUsers, pageEvidences, pageDeposits, buildStaffFinanceSummary(pageEarnings, pageWithdraws))
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + pageSize < total,
          defaultCommissionRate
        }
      }

      const allProfiles = (await readAll('staff_profiles', where, 2000)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      const allOpenids = [...new Set(allProfiles.map((p) => p.openid).filter(Boolean))]

      const [allUsers, allEvidences, allDeposits, allEarnings, allWithdraws] = await Promise.all([
        fetchByOpenids('users', 'openid', allOpenids),
        fetchByOpenids('staff_deposit_evidences', 'staffOpenid', allOpenids),
        fetchByOpenids('staff_deposits', 'staffOpenid', allOpenids),
        fetchFinanceRowsByOpenids('staff_earnings', allOpenids),
        fetchFinanceRowsByOpenids('withdraw_requests', allOpenids)
      ])

      const decorated = buildDecoratedProfiles(allProfiles, allUsers, allEvidences, allDeposits, buildStaffFinanceSummary(allEarnings, allWithdraws))
      const filtered = decorated.filter((item) => {
        if (keyword && [item.openid, item.realName, item.phone, item.accountPhone, item.certifiedPhone, item.serviceCity, item.serviceAreas, item.userNickname].every((value) => !safeText(value).toLowerCase().includes(keyword))) {
          return false
        }
        if (data.minDeposit !== undefined && data.minDeposit !== '' && !isNaN(Number(data.minDeposit))) {
          if (item.depositBalance < Number(data.minDeposit)) return false
        }
        if (data.maxDeposit !== undefined && data.maxDeposit !== '' && !isNaN(Number(data.maxDeposit))) {
          if (item.depositBalance > Number(data.maxDeposit)) return false
        }
        if (data.hasViolations === 'yes' || data.hasViolations === true) {
          if (item.problemOrderCount <= 0) return false
        } else if (data.hasViolations === 'no' || data.hasViolations === false) {
          if (item.problemOrderCount > 0) return false
        }
        if (canRevoke === 'yes' || isCanRevokeAuditStatus) {
          if (!item.canRevokeStaff) return false
        } else if (canRevoke === 'no') {
          if (item.canRevokeStaff) return false
        }
        if (data.requireRepayStatus === 'yes') {
          if (!item.requireDepositRepay) return false
        } else if (data.requireRepayStatus === 'no') {
          if (item.requireDepositRepay) return false
        }
        return true
      })

      return { ...paginateList(filtered, data), defaultCommissionRate }
    }
    if (action === 'batchRequireDepositRepay') {
      const ids = Array.isArray(data.staffProfileIds) ? data.staffProfileIds.filter(Boolean) : (data.staffProfileId ? [data.staffProfileId] : [])
      const openids = Array.isArray(data.staffOpenids) ? data.staffOpenids.filter(Boolean) : (data.staffOpenid ? [data.staffOpenid] : [])
      const reason = safeText(data.reason).trim() || '保证金余额不足或存在违规出险记录，平台要求重新足额缴纳履约保证金后方可继续接单'
      const time = now()
      const config = (await getSystemSettings()).staffDeposit || { amount: 0 }
      const targets = new Map()
      for (const id of ids) {
        const profile = (await db.collection('staff_profiles').doc(id).get().catch(() => ({ data: null }))).data
        if (profile) targets.set(profile._id, profile)
      }
      for (const staffOpenid of openids) {
        const pRes = await db.collection('staff_profiles').where({ openid: staffOpenid }).limit(1).get().catch(() => ({ data: [] }))
        if (pRes.data && pRes.data[0]) targets.set(pRes.data[0]._id, pRes.data[0])
      }
      let count = 0
      let skippedCount = 0
      let totalTopUpAmount = 0
      for (const target of targets.values()) {
        const result = await db.runTransaction(async tx => {
          const profile = (await tx.collection('staff_profiles').doc(target._id).get()).data
          if (!profile || profile.auditStatus !== 'approved' || ['requested', 'approved', 'exited'].includes(profile.exitStatus)) return null
          const deposits = await staffDepositRecords(profile.openid, tx)
          if (depositPolicy.refundPending(deposits)) return null
          const standard = profileDepositStandard(profile, config.amount)
          const balance = depositBalanceAmount(deposits)
          const topUpAmount = Math.max(0, Math.round((standard - balance) * 100) / 100)
          const patch = {
            depositStandardAmount: standard,
            depositEntryStandardAmount: profile.depositEntryStandardAmount ?? standard,
            depositStandardAssignedAt: profile.depositStandardAssignedAt || profile.createdAt || time,
            depositStandardSource: profile.depositStandardSource || 'legacy_current_config',
            updatedAt: time
          }
          if (topUpAmount > 0) Object.assign(patch, {
            requireDepositRepay: true, requireDepositRepayReason: reason,
            requireDepositRepayAt: time, depositStatus: 'supplement_required'
          })
          else if (profile.requireDepositRepay === true || ['supplement_required', 'forfeited'].includes(profile.depositStatus)) Object.assign(patch, {
            requireDepositRepay: false, requireDepositRepayReason: '', requireDepositRepayAt: '', depositStatus: 'paid'
          })
          await tx.collection('staff_profiles').doc(profile._id).update({ data: patch })
          return { topUpAmount }
        })
        if (!result || result.topUpAmount <= 0) skippedCount++
        else { count++; totalTopUpAmount += result.topUpAmount }
      }
      totalTopUpAmount = Math.round(totalTopUpAmount * 100) / 100
      await logAdmin(admin, 'staff_profile', 'batch', 'batchRequireDepositRepay', { count, skippedCount, totalTopUpAmount, reason, ids, openids })
      return { success: true, count, skippedCount, totalTopUpAmount, reason }
    }
    if (action === 'setStaffDepositStandard') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      const amountText = safeText(data.amount).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) throw new Error('个人保证金标准须为正数，最多两位小数')
      const standard = Number(amountText)
      if (!Number.isFinite(standard) || standard <= 0 || !Number.isSafeInteger(Math.round(standard * 100))) throw new Error('个人保证金标准须为正数，最多两位小数')
      const depositConfig = (await getSystemSettings()).staffDeposit || { amount: 0 }
      const result = await db.runTransaction(async tx => {
        const profile = (await tx.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))).data
        if (!profile) throw new Error('宠托师资料不存在')
        if (['requested', 'approved', 'exited'].includes(profile.exitStatus)) throw new Error('退出退款流程中的宠托师不可修改保证金标准')
        const deposits = await staffDepositRecords(profile.openid, tx)
        if (deposits.some((deposit) => ['refund_requested', 'refund_approved', 'refunding'].includes(deposit.status) || ['requested', 'approved', 'processing'].includes(deposit.refundStatus))) {
          throw new Error('保证金退款处理中，暂不可修改个人标准')
        }
        const balance = depositBalanceAmount(deposits)
        const topUpAmount = Math.max(0, Math.round((standard - balance) * 100) / 100)
        const time = now()
        const patch = {
          depositStandardAmount: standard,
          depositEntryStandardAmount: profile.depositEntryStandardAmount ?? profileDepositStandard(profile, depositConfig.amount),
          depositStandardAssignedAt: profile.depositStandardAssignedAt || profile.createdAt || time,
          depositStandardUpdatedAt: time,
          depositStandardUpdatedBy: admin.openid || '',
          depositStandardSource: 'admin'
        }
        if (topUpAmount > 0) Object.assign(patch, {
          requireDepositRepay: true,
          requireDepositRepayReason: `个人保证金标准已调整为 ¥${standard.toFixed(2)}，请补足至标准后恢复接单`,
          requireDepositRepayAt: time,
          depositStatus: 'supplement_required'
        })
        else if (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited') Object.assign(patch, {
          requireDepositRepay: false,
          requireDepositRepayReason: '',
          requireDepositRepayAt: '',
          depositStatus: 'paid'
        })
        patch.updatedAt = time
        await tx.collection('staff_profiles').doc(staffProfileId).update({ data: patch })
        return { staffProfileId, depositStandardAmount: standard,
          depositEntryStandardAmount: patch.depositEntryStandardAmount,
          depositBalance: balance, topUpAmount, requiresRepayment: topUpAmount > 0,
          depositStatus: patch.depositStatus || profile.depositStatus,
          previousStandard: profileDepositStandard(profile, depositConfig.amount) }
      })
      await logAdmin(admin, 'staff_profile', staffProfileId, 'setStaffDepositStandard', result)
      return result
    }
    if (action === 'getStaffDepositRefundPreview') {
      const id = safeText(data.id).trim()
      if (!id) throw new Error('请选择保证金记录')
      return context.getStaffDepositRefundPreview(id)
    }
    if (action === 'getStaffDepositDetail') {
      const targetOpenid = safeText(data.staffOpenid || data.openid).trim()
      const staffProfileId = safeText(data.staffProfileId || data.id).trim()
      let staffOpenid = targetOpenid
      if (!staffOpenid && staffProfileId) {
        const pRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
        if (pRes.data) staffOpenid = pRes.data.openid
      }
      if (!staffOpenid) throw new Error('缺少宠托师身份信息')

      const profileRes = await db.collection('staff_profiles').where({ openid: staffOpenid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = profileRes.data && profileRes.data[0] || null

      const depositRes = await db.collection('staff_deposits').where({ staffOpenid }).orderBy('createdAt', 'desc').limit(1).get().catch(() => ({ data: [] }))
      const deposit = depositRes.data && depositRes.data[0] || null

      const eventsRes = await db.collection('staff_deposit_events').where({ staffOpenid }).orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const events = (eventsRes.data || []).map((e) => ({
        _id: e._id,
        type: e.type,
        amount: Number(e.amount || 0),
        reason: e.reason || '',
        evidenceImages: Array.isArray(e.evidenceImages) ? e.evidenceImages : [],
        createdAt: e.createdAt || ''
      }))

      const availableRefundAmount = deposit ? Number(deposit.availableRefundAmount || 0) : 0
      const paidAmount = deposit ? Number(deposit.paidAmount || 0) : 0
      const forfeitedAmount = deposit ? Number(deposit.forfeitedAmount || 0) : 0

      return {
        staffOpenid,
        profile,
        deposit,
        availableRefundAmount,
        paidAmount,
        forfeitedAmount,
        depositStatus: profile ? profile.depositStatus : (deposit ? deposit.status : 'unpaid'),
        requireDepositRepay: profile ? profile.requireDepositRepay === true : false,
        requireDepositRepayReason: profile ? (profile.requireDepositRepayReason || '') : '',
        events
      }
    }
    if (action === 'setStaffCommissionRate') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profile = (await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))).data
      if (!profile || !profile.openid) throw new Error('宠托师不存在')
      const reset = data.useDefault === true
      const text = safeText(data.commissionPercent).trim()
      const percent = Number(text)
      if (!reset && (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(percent) || percent < 0 || percent > 100)) {
        throw new Error('个人提成比例须为 0 至 100%，最多两位小数')
      }
      const rate = reset ? null : Math.round(percent * 100) / 10000
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: { commissionRateOverride: rate, updatedAt: now() } })
      await logAdmin(admin, 'staff_profile', staffProfileId, 'setStaffCommissionRate', { commissionRateOverride: rate, useDefault: reset })
      return { staffProfileId, commissionRateOverride: rate }
    }
    if (action === 'setSitterFeatured') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      if (!isCertifiedSitter(profile)) throw new Error('仅已审核通过的宠托师可设为精选')
      const time = now()
      const isFeatured = data.isFeatured === true
      const update = isFeatured
        ? { isFeatured: true, featuredAt: time, featuredByOpenid: openid, updatedAt: time }
        : { isFeatured: false, featuredAt: '', featuredByOpenid: '', updatedAt: time }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: update })
      await logAdmin(admin, 'staff_profile', staffProfileId, 'setSitterFeatured', { isFeatured })
      return { staffProfileId, ...update }
    }
    if (action === 'listAdmins') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const inOp = db.command && typeof db.command.in === 'function' ? db.command.in(['admin']) : 'admin'
      const users = await readAll('users', { roles: inOp })
      const list = users
        .filter((user) => Array.isArray(user.roles) && user.roles.includes('admin'))
        .filter((user) => !keyword || [user.openid, user.nickname, user.phone, user.status].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .map((user) => safeUserSummary(user, { isSelf: user.openid === openid }))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'grantAdmin') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const userRes = await db.collection('users').where({ openid: targetOpenid }).limit(1).get()
      const target = userRes.data[0]
      if (!target || target.status !== 'active') throw new Error('目标用户不存在或不可用')
      const roles = Array.from(new Set([...(Array.isArray(target.roles) ? target.roles : ['client']), 'admin']))
      await db.collection('users').doc(target._id).update({ data: { roles, updatedAt: now() } })
      await logAdmin(admin, 'user', targetOpenid, 'grantAdmin', {})
      return safeUserSummary({ ...target, roles })
    }
    if (action === 'revokeAdmin') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      if (targetOpenid === openid) throw new Error('不能移除自己的管理员权限')
      const adminCount = typeof countActiveAdmins === 'function' ? await countActiveAdmins(2) : 2
      if (adminCount <= 1) throw new Error('至少保留一个管理员')
      const targetRes = await db.collection('users').where({ openid: targetOpenid }).limit(1).get()
      const target = targetRes.data && targetRes.data[0]
      if (!target) throw new Error('目标用户不存在')
      const roles = (Array.isArray(target.roles) ? target.roles : []).filter((role) => role !== 'admin')
      await assertAdminRoleChangeAllowed(target, roles, openid)
      await protectAdminOwner(target, roles, target.status)
      const update = { roles, updatedAt: now() }
      if (target.activeRole === 'admin') update.activeRole = 'client'
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'revokeAdmin', {})
      return safeUserSummary({ ...target, ...update })
    }
    if (action === 'listOrders') {
      await expireDueUnacceptedOrders()
      const rawStatus = safeText(data.status).trim()
      const refundFilter = ['refunding', 'refunded'].includes(rawStatus) ? rawStatus : ''
      const specialFilter = safeText(data.specialFilter).trim()
      const isAutoFilter = rawStatus === 'auto_completed' || specialFilter === 'auto_completed'
      const isOverdueFilter = rawStatus === 'overdue' || specialFilter === 'overdue'
      const isNormalStatus = rawStatus && !['all', 'overdue', 'auto_completed'].includes(rawStatus)
      let where = {}
      if (rawStatus === 'assigned') {
        const _ = db.command
        const inOp = _ && typeof _.in === 'function' ? _.in.bind(_) : (arr) => ({ $in: arr })
        where = { status: inOp(['assigned', 'on_the_way']) }
      } else if (isNormalStatus && !refundFilter) {
        where = { status: rawStatus }
      }
      const allOrders = (await readAll('orders', where)).sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      const orderKeyword = safeText(data.orderKeyword || data.keyword).trim().toLowerCase()
      const clientPhone = safeText(data.clientPhone || data.phone).trim()
      const staffPhone = safeText(data.staffPhone).trim()
      let clientOpenids = null
      if (clientPhone) {
        const matchedUsers = await searchUsersByPhoneSafely(clientPhone)
        clientOpenids = new Set(matchedUsers
          .filter((user) => safeText(user.phone).includes(clientPhone))
          .map((user) => safeText(user.openid))
          .filter(Boolean))
      }
      let staffOpenids = null
      let staffProfileIds = null
      if (staffPhone) {
        const [matchedStaffUsers, matchedProfiles] = await Promise.all([
          searchUsersByPhoneSafely(staffPhone),
          searchStaffProfilesByPhoneSafely(staffPhone)
        ])
        staffOpenids = new Set(matchedStaffUsers
          .filter((user) => safeText(user.phone).includes(staffPhone))
          .map((user) => safeText(user.openid))
          .filter(Boolean))
        staffProfileIds = new Set()
        matchedProfiles.forEach((profile) => {
          if (!safeText(profile.phone).includes(staffPhone)) return
          const profileOpenid = safeText(profile.openid).trim()
          const profileId = safeText(profile._id).trim()
          if (profileOpenid) staffOpenids.add(profileOpenid)
          if (profileId) staffProfileIds.add(profileId)
        })
      }
      let orders = allOrders.filter((order) => !isAdminDeletedOrder(order))
      if (isAutoFilter) {
        orders = orders.filter((order) => order.autoCompleted === true)
      }
      if (isOverdueFilter) {
        orders = orders.filter((order) => isOrderOverdue(order))
      }
      if (orderKeyword) {
        orders = orders.filter((order) => [order._id, order.orderNo].some((value) => safeText(value).toLowerCase().includes(orderKeyword)))
      }
      if (clientOpenids) {
        orders = orders.filter((order) => clientOpenids.has(safeText(order.clientOpenid)) || safeText(order.contactPhone).includes(clientPhone))
      }
      if (staffOpenids && staffProfileIds) {
        orders = orders.filter((order) => staffOpenids.has(safeText(order.staffOpenid)) || staffOpenids.has(safeText(order.requestedStaffOpenid)) || staffProfileIds.has(safeText(order.staffProfileId)) || staffProfileIds.has(safeText(order.requestedStaffProfileId)))
      }
      orders = await refreshOrderRefunds(orders)
      if (refundFilter) orders = orders.filter(order => getOrderRefundState(order) === refundFilter)
      else if (isNormalStatus) orders = orders.filter(order => rawStatus === 'assigned' ? ['assigned', 'on_the_way'].includes(order.status) : order.status === rawStatus)
      const page = paginateList(orders, data)
      const settings = await getSystemSettings().catch(() => ({}))
      const commissionRate = Number(settings?.settlement?.staffCommissionRate ?? 0.7)
      const earningsByOrderId = new Map()
      const earningOrderIds = page.list.filter(item => item.staffOpenid).map(item => item._id)
      for (let i = 0; i < earningOrderIds.length; i += 20) {
        const rows = await readScopedDocuments('staff_earnings', { orderId: db.command.in(earningOrderIds.slice(i, i + 20)) }, 'createdAt', 'desc')
        rows.forEach(row => { if (!earningsByOrderId.has(row.orderId)) earningsByOrderId.set(row.orderId, row) })
      }
      const rateCache = new Map()
      const list = await Promise.all(page.list.map(async (item) => {
        const display = await attachAdminOrderContactData(item)
        const actualEarning = earningsByOrderId.get(item._id) || null
        const key = item.staffOpenid || ''
        let orderRate = actualEarning?.commissionRate ?? commissionRate
        let profitError = ''
        if (!actualEarning && key) {
          if (!rateCache.has(key)) rateCache.set(key, resolveStaffCommissionRate(item, commissionRate))
          try { orderRate = await rateCache.get(key) }
          catch (error) {
            console.error('[listOrders] commission rate unavailable:', { orderId: item._id, message: error.message })
            profitError = '宠托师提成比例待核对'
          }
        }
        const profitSummary = !profitError && typeof buildOrderProfitSummary === 'function'
          ? buildOrderProfitSummary(item, actualEarning, orderRate)
          : null
        return {
          ...display,
          profitSummary,
          profitError,
          staffReward: profitSummary ? profitSummary.staffReward : null,
          platformProfit: profitSummary ? profitSummary.platformProfit : null
        }
      }))
      return { ...page, list }
    }
    if (action === 'batchDeleteOrders') {
      const orderIds = Array.from(new Set((Array.isArray(data.orderIds) ? data.orderIds : []).map((id) => safeText(id).trim()).filter(Boolean)))
      if (!orderIds.length) throw new Error('请选择要删除的订单')
      if (orderIds.length > 100) throw new Error('单次最多删除 100 个订单')
      const reason = safeText(data.reason).trim()
      const time = now()
      const deletedIds = []
      const skippedIds = []
      for (const orderId of orderIds) {
        try {
          const orderRes = await db.collection('orders').doc(orderId).get()
          if (orderRes.data.adminDeletedAt) {
            skippedIds.push(orderId)
            continue
          }
          await db.collection('orders').doc(orderId).update({ data: { adminDeletedAt: time, adminDeletedByOpenid: openid, adminDeletedReason: reason, updatedAt: time } })
          await logAdmin(admin, 'order', orderId, 'batchDeleteOrders', { reason })
          deletedIds.push(orderId)
        } catch (error) {
          skippedIds.push(orderId)
        }
      }
      return { deletedIds, skippedIds, count: deletedIds.length }
    }
    if (action === 'getOrderDetail' || action === 'getEvidence') {
      const id = safeText(data.id || data.orderId).trim()
      if (!id) throw new Error('订单不存在')
      const order = await db.collection('orders').doc(id).get().catch(() => ({ data: null }))
      if (!order || !order.data) throw new Error('订单不存在')
      if (action === 'getOrderDetail') [order.data] = await refreshOrderRefunds([order.data])
      const displayOrder = await attachAdminOrderContactData(order.data)
      Object.assign(displayOrder, await require('../services/order-group-buy-view')(context).attach(displayOrder))
      const flags = await context.getAdminPermissionFlags(admin, ['admin.listOrderSessionMessages'])
      const canReadChat = flags['admin.listOrderSessionMessages']
      const payAmount = Number(order.data.payAmount || 0)
      const [timelineRows, trackRows, checkinRows, unlockRows, refundRows, penaltyRows, sessionMessageRows, riskBypassRows] = await Promise.all([
        readScopedDocuments('order_timeline', { orderId: id }, 'createdAt', 'asc').catch(() => []),
        readScopedDocuments('track_logs', { orderId: id }, 'recordedAt', 'asc').catch(() => []),
        readScopedDocuments('checkin_logs', { orderId: id }, 'createdAt', 'asc').catch(() => []),
        readScopedDocuments('unlock_code_logs', { orderId: id }, 'createdAt', 'desc').catch(() => []),
        readScopedDocuments('refunds', { orderId: id }, 'createdAt', 'desc').catch(() => []),
        readScopedDocuments('staff_deposit_evidences', { orderId: id }, 'createdAt', 'desc').catch(() => []),
        canReadChat ? readScopedDocuments('order_session_messages', { orderId: id }, 'createdAt', 'asc').catch(() => []) : Promise.resolve([]),
        canReadChat ? readScopedDocuments('risk_bypass_logs', { orderId: id }, 'createdAt', 'desc').catch(() => []) : Promise.resolve([])
      ])
      const successfulRefundsAmount = refundRows
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.data.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
      displayOrder.maxRefundable = maxRefundable
      displayOrder.alreadyRefunded = alreadyRefunded

      const penaltyEvidences = penaltyRows.map((e) => {
        const actualDeductAmount = Number(e.actualDeductAmount ?? e.forfeitedAmount ?? 0)
        const s = e.status || 'pending'
        return {
          ...e,
          actualDeductAmount,
          actualDeductAmountText: actualDeductAmount > 0 ? actualDeductAmount.toFixed(2) : '',
          statusText: s === 'forfeited' ? '已根据建议扣除保证金' : (s === 'dismissed' ? '已撤销免除' : '待执行扣除')
        }
      })
      displayOrder.depositPenaltyEvidences = penaltyEvidences
      displayOrder.hasDepositPenaltyEvidence = penaltyEvidences.length > 0 || displayOrder.hasDepositPenaltyEvidence === true

      const standardEarning = await calculateStaffEarningForOrder(order.data).catch(() => ({ earningAmount: 0 }))
      displayOrder.standardStaffReward = standardEarning.earningAmount || 0

      const earningRows = await readScopedDocuments('staff_earnings', { orderId: id }, 'createdAt', 'desc').catch(() => [])
      const actualEarning = earningRows[0] || null
      const settings = await getSystemSettings().catch(() => ({}))
      let commissionRate = actualEarning?.commissionRate ?? settings?.settlement?.staffCommissionRate ?? 0.7
      let profitError = ''
      if (!actualEarning && order.data.staffOpenid) {
        try { commissionRate = await resolveStaffCommissionRate(order.data, commissionRate) }
        catch (error) {
          console.error('[getOrderDetail] commission rate unavailable:', { orderId: id, message: error.message })
          profitError = '宠托师提成比例待核对'
        }
      }
      const profitSummary = !profitError && typeof buildOrderProfitSummary === 'function'
        ? buildOrderProfitSummary(order.data, actualEarning, commissionRate)
        : null
      displayOrder.profitSummary = profitSummary
      displayOrder.profitError = profitError
      displayOrder.staffReward = profitSummary ? profitSummary.staffReward : null
      displayOrder.platformProfit = profitSummary ? profitSummary.platformProfit : null
      displayOrder.actualStaffEarning = actualEarning

      if (action === 'getEvidence') await logAdmin(admin, 'order', id, 'getEvidence', { trackCount: trackRows.length, checkinCount: checkinRows.filter(isActiveCheckin).length })
      return {
        order: displayOrder,
        timeline: timelineRows,
        tracks: trackRows,
        checkins: checkinRows.filter(isActiveCheckin),
        unlockLogs: unlockRows,
        depositPenaltyEvidences: penaltyEvidences,
        sessionMessages: sessionMessageRows,
        riskBypassLogs: riskBypassRows
      }
    }

    if (action === 'listOrderSessionMessages') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单ID')
      const [allSessionMessages, riskBypassLogs] = await Promise.all([
        readScopedDocuments('order_session_messages', { orderId }, 'createdAt', 'asc').catch(() => []),
        readScopedDocuments('risk_bypass_logs', { orderId }, 'createdAt', 'desc').catch(() => [])
      ])
      const wantsPage = data.page !== undefined || data.pageSize !== undefined || data.before || data.after
      const page = Math.max(1, Math.floor(Number(data.page) || 1))
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(data.pageSize) || 50)))
      const cursorTime = data.before || data.after ? toTimeValue(data.before || data.after) : 0
      let sessionMessages = allSessionMessages
      if (cursorTime) {
        sessionMessages = sessionMessages.filter((item) => {
          const time = toTimeValue(item.createdAt)
          return data.before ? time < cursorTime : time > cursorTime
        })
      }
      const total = sessionMessages.length
      if (wantsPage) sessionMessages = sessionMessages.slice((page - 1) * pageSize, page * pageSize)
      return {
        sessionMessages,
        riskBypassLogs,
        ...(wantsPage ? { page, pageSize, total, hasMore: page * pageSize < total } : {})
      }
    }
    if (action === 'assignOrder') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      if (orderRes.data.status !== 'paid') throw new Error('仅已支付订单可派单')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      if (!profileRes || !profileRes.data) throw new Error('宠托师档案不存在')
      const profile = normalizeStaffWorkflow(profileRes.data)
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) {
        if (ability.reason === 'deposit_unpaid') {
          throw new Error('该宠托师尚未缴纳履约保证金，不能派单')
        }
        throw new Error(ability.message || '该宠托师尚未完成培训/视频审核，不能派单')
      }
      assertStaffCanServeOrderVaccines(profile, await attachOrderDisplayData(orderRes.data))
      await validateStaffAvailabilityForSessions(profile, getOrderTimeRanges(orderRes.data), { excludeOrderId: orderId })
      const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = staffUserRes.data[0]
      if (!staffUser) throw new Error('员工用户不存在')
      const time = now()
      const assignmentUpdate = { staffUserId: staffUser._id, staffOpenid: staffUser.openid, staffProfileId: profile._id, status: 'assigned', assignmentSource: 'admin_assign', assignedAt: time, updatedAt: time }
      const assignedOrder = await assignOrderAtomically(orderId, orderRes.data, assignmentUpdate, { admin: true, depositConfig: settings.staffDeposit })
      await appendOrderTimeline(orderId, 'assigned', '管理员已派单', maskStaffName(profile.realName), 'admin')
      await appendOrderClientMessage(assignedOrder, { eventType: 'assigned', title: '平台已派单', detail: maskStaffName(profile.realName), actorRole: 'admin' })
      await notifyOrder(orderRes.data.clientOpenid, 'orderAssigned', { ...orderRes.data, _id: orderId }, { statusText: '已派单' })
      await logAdmin(admin, 'order', orderId, 'assignOrder', { staffProfileId })
      return { orderId }
    }
    if (action === 'updateOrderStatus') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const targetStatus = safeText(data.status).trim()
      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写操作说明')
      const allowedStatuses = ['pending_pay', 'paid', 'assigned', 'on_the_way', 'in_service', 'completed', 'cancelled', 'refunded']
      if (!allowedStatuses.includes(targetStatus)) throw new Error('目标状态无效')

      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data
      const prevStatus = order.status
      if (prevStatus === targetStatus) throw new Error(`订单当前已处于该状态(${targetStatus})`)

      if (targetStatus === 'cancelled') {
        if (order.status !== 'pending_pay') throw new Error('已支付订单请通过退款流程处理，不能直接取消')
        if (!await cancelUnpaidOrder(order, { collectionName: 'orders', reason: remark, actorRole: 'admin' })) throw new Error('订单状态已变化，请刷新后重试')
        await logAdmin(admin, 'order', orderId, 'updateOrderStatus', { prevStatus, targetStatus, remark })
        return { orderId, status: targetStatus, prevStatus, remark }
      }
      if (targetStatus === 'refunded' && order.paymentStatus !== 'refunded') throw new Error('退款尚未到账，不能标记已退款')
      if (targetStatus === 'pending_pay' && order.paymentStatus !== 'unpaid') throw new Error('已创建支付或已付款订单不能恢复待支付')
      if (['paid', 'pending_ship', 'shipped', 'assigned', 'on_the_way', 'in_service', 'completed'].includes(targetStatus) && !['paid', 'refunding'].includes(order.paymentStatus)) throw new Error('订单未支付，不能手动推进状态')

      const time = now()
      const updateData = {
        status: targetStatus,
        adminManualStatusUpdatedAt: time,
        adminManualStatusRemark: remark,
        adminManualStatusByOpenid: openid,
        updatedAt: time
      }
      if (targetStatus === 'completed' && !order.completedAt) {
        updateData.completedAt = time
      }
      if (targetStatus === 'cancelled' && !order.cancelledAt) {
        updateData.cancelledAt = time
      }
      await updateOrderStatusWithScheduling(orderId, order, updateData)
      // 管理员核实完单也必须创建收益记录，否则订单已完成但宠托师永远收不到收益。
      // ensureStaffEarning 按 orderId 幂等，重复操作不会重复入账。
      if (targetStatus === 'completed' && order.staffOpenid) {
        await ensureStaffEarning({ ...order, ...updateData, _id: orderId }, time)
      }
      if (targetStatus === 'completed' && typeof destroyOrderHomeSecuritySecrets === 'function') {
        await destroyOrderHomeSecuritySecrets(orderId, {
          reason: 'admin_manual_status_completed',
          actor: 'admin',
          time
        }).catch(() => {})
      }

      const statusLabels = {
        pending_pay: '待支付',
        paid: '已支付/待接单',
        assigned: '已派单/待服务',
        in_service: '服务中',
        completed: '已完成',
        cancelled: '已取消',
        refunded: '已退款'
      }
      const fromLabel = statusLabels[prevStatus] || prevStatus
      const toLabel = statusLabels[targetStatus] || targetStatus

      await appendOrderTimeline(orderId, 'status_changed', `管理员手动修改状态：${fromLabel} ➔ ${toLabel}`, remark, 'admin')
      await appendOrderClientMessage({ ...order, _id: orderId }, {
        eventType: 'status_changed',
        title: `订单状态更新为：${toLabel}`,
        detail: `管理员操作说明：${remark}`,
        actorRole: 'admin'
      })
      await logAdmin(admin, 'order', orderId, 'updateOrderStatus', { prevStatus, targetStatus, remark })
      return { orderId, status: targetStatus, prevStatus, remark }
    }
    if (action === 'manualCompleteOrder') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data

      if (order.status === 'completed') {
        throw new Error('订单当前已经是已完成状态')
      }
      if (!['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(order.status)) {
        throw new Error(`当前订单状态（${order.status}）不可执行手动核实完单`)
      }

      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写核实完单说明')

      const deductionInput = data.deductAmount
      if (deductionInput != null && typeof deductionInput !== 'number' && typeof deductionInput !== 'string') throw new Error('违规扣除金额格式不正确')
      const deductAmount = deductionInput == null || deductionInput === '' ? 0 : Number(deductionInput)
      const deductCents = Math.round(deductAmount * 100)
      if (!Number.isFinite(deductAmount) || deductAmount < 0 || !Number.isSafeInteger(deductCents) || Math.abs(deductAmount * 100 - deductCents) > 1e-7) throw new Error('违规扣除金额必须为非负数，最多两位小数')
      const evidenceImages = data.evidenceImages == null ? [] : data.evidenceImages
      if (!Array.isArray(evidenceImages) || evidenceImages.length > 4 || evidenceImages.some(fileId => typeof fileId !== 'string' || !fileId.startsWith('cloud://'))) throw new Error('请先上传有效的核实凭证图片，最多4张')
      const time = now()
      const result = await db.runTransaction(async tx => {
        const latest = (await tx.collection('orders').doc(orderId).get()).data
        if (!latest || !['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(latest.status) || latest.status !== order.status || latest.staffOpenid !== order.staffOpenid) throw new Error('订单状态已变化，请刷新后重试')
        if (latest.adminManualAccountingVersion === 2) throw new Error('订单已核实，请等待拼单统一结算')
        if (latest.paymentStatus && !['paid', 'refunding'].includes(latest.paymentStatus)) throw new Error('订单支付状态不可核实完单')
        const standardEarning = await calculateStaffEarningForOrder(latest)
        const baseReward = Number(standardEarning.earningAmount || 0)
        if (!Number.isFinite(baseReward) || baseReward < 0 || !Number.isSafeInteger(Math.round(baseReward * 100))) throw new Error('宠托师应得收益金额异常，请核对')
        if (deductCents > Math.round(baseReward * 100)) throw new Error(`违规扣除金额（¥${deductAmount.toFixed(2)}）不能大于宠托师原本应得收益（¥${baseReward.toFixed(2)}）`)
        const sessions = normalizeServiceSessions(latest).map(session => ({ ...session, status: 'completed', finishedAt: session.finishedAt || time }))
        const finalSession = sessions[sessions.length - 1]
        if (latest.groupBuyId && !finalSession) throw new Error('拼单服务场次缺失，请联系平台')
        const updateData = {
          status: latest.groupBuyId ? 'day_completed' : 'completed',
          completionType: 'admin_manual',
          adminManualAccountingVersion: 2,
          adminManualCompletedAt: time,
          adminManualCompletedBy: openid,
          adminManualRemark: remark,
          adminManualDeductEarning: deductAmount,
          adminManualDeductReason: deductAmount > 0 ? (safeText(data.deductReason).trim() || remark) : '',
          adminManualEvidenceImages: evidenceImages,
          serviceSessions: sessions,
          lastCompletedSessionIndex: finalSession ? finalSession.index : 0,
          activeSessionIndex: 0,
          activeSessionDate: '',
          currentSessionStartedAt: '',
          isStartOverdue: false,
          isFinishOverdue: false,
          updatedAt: time
        }
        for (const [index, mediaFileId] of evidenceImages.entries()) {
          const proofId = `admin_proof_${crypto.createHash('sha256').update(JSON.stringify([orderId, index])).digest('hex').slice(0, 32)}`
          await tx.collection('checkin_logs').doc(proofId).set({ data: {
            orderId, eventType: 'admin_supplement', eventText: '平台核实补录凭证', mediaFileId,
            remark: `管理员线下核实补录图片 #${index + 1}`, recordedAt: time, createdAt: time, createdBy: openid, source: 'admin'
          } })
        }
        if (latest.groupBuyId) {
          Object.assign(updateData, { groupCompletionSession: { ...finalSession, finishedAt: time }, groupCompletionPending: true, groupCompletionIsAuto: false })
          await tx.collection('orders').doc(orderId).update({ data: updateData })
          return { order: { ...latest, ...updateData }, baseReward }
        }
        updateData.completedAt = time
        const rewards = await ensureOrderCompletionRewards(latest, time, {
          transaction: tx, manualVerification: true, completionPatch: updateData,
          notifications: [{ openid: latest.clientOpenid, detail: { completedAt: time, tip: '平台已核实完成，可查看订单详情' }, role: 'client' }]
        })
        return { order: { ...latest, ...updateData, adminManualStaffReward: rewards.earning ? rewards.earning.amount : 0 }, baseReward }
      })
      let completedOrder = result.order
      let completion = { status: 'completed' }
      if (completedOrder.groupBuyId) {
        completion = await completeOrderService(completedOrder, completedOrder.groupCompletionSession, time, { actor: 'admin' })
        completedOrder = (await db.collection('orders').doc(orderId).get()).data
      } else {
        await notifyOrder(completedOrder.clientOpenid, 'serviceFinish', completedOrder, { completedAt: time, tip: '平台已核实完成，可查看订单详情' }, 'client', 'finish:final')
          .catch(err => console.error('[manualCompleteOrder] finish notification deferred:', err))
      }
      const pendingGroup = completion.partialGroupCompleted === true
      const baseReward = result.baseReward
      const finalStaffReward = pendingGroup ? null : Number(completedOrder.adminManualStaffReward || 0)
      await resolveOrderDispatchNotifications(orderId, { reason: 'admin_manual_completed', actor: openid, time })
        .catch(err => console.error('[manualCompleteOrder] resolve dispatch notifications failed:', err))
      if (typeof destroyOrderHomeSecuritySecrets === 'function') {
        await destroyOrderHomeSecuritySecrets(orderId, { reason: 'admin_manual_completed', actor: 'admin', time })
          .catch(err => console.error('[manualCompleteOrder] destroy secrets failed:', err))
      }
      const settlementText = pendingGroup ? '等待同拼单团全部住户服务完成后统一结算' : `实际入账收益 ¥${finalStaffReward.toFixed(2)}`
      const timelineTitle = deductAmount > 0
        ? `管理员核实并手动完单（扣减收益 ¥${deductAmount.toFixed(2)}）` : '管理员核实并手动完单'
      await appendOrderTimeline(orderId, 'admin_manual_completed', timelineTitle,
        `核实说明：${remark}。宠托师原应得 ¥${baseReward.toFixed(2)}，违规扣除 ¥${deductAmount.toFixed(2)}；${settlementText}。`, 'admin')
      await appendOrderClientMessage(completedOrder, {
        eventType: pendingGroup ? 'day_completed' : 'completed',
        title: pendingGroup ? '住户服务已由平台核实' : '订单已由平台核实完成',
        detail: `平台管理员已协助核实履约：${remark}。${pendingGroup ? '等待同团全部住户完成后统一结算。' : '可查看订单详情。'}`,
        actorRole: 'admin'
      })
      if (completedOrder.staffOpenid) {
        await appendOrderStaffMessage(completedOrder, {
          eventType: 'admin_manual_completed',
          title: deductAmount > 0 ? '订单已核实完单（违规扣减收益通知）' : '订单已由管理员核实完单',
          detail: `您的订单（${completedOrder.serviceSummary || completedOrder.orderNo}）已由平台管理员核实服务凭证。原本应得收益 ¥${baseReward.toFixed(2)}，扣减违规收益 ¥${deductAmount.toFixed(2)}（原因：${safeText(data.deductReason).trim() || remark}）；${settlementText}。`,
          actorRole: 'admin',
          idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'admin_manual_complete')
        })
      }
      await logAdmin(admin, 'order', orderId, 'manualCompleteOrder', { baseReward, deductAmount, finalStaffReward, remark, evidenceImagesCount: evidenceImages.length, pendingGroup })
      return { orderId, ...completion, baseReward, deductAmount, finalStaffReward, remark }
    }
    if (action === 'refundOrder') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data
      const payAmount = Number(order.payAmount || 0)
      if (payAmount <= 0) throw new Error('该订单无需退款（实付金额为0）')
      if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding' && order.status !== 'paid' && !order.paidAt) {
        throw new Error('订单未支付或状态不支持退款')
      }

      const refundAmount = Number(data.refundAmount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')

      const reason = safeText(data.reason || data.remark).trim()
      if (!reason) throw new Error('请填写退款说明')

      const refund = await createRefundForOrder(order, refundAmount, reason, 'admin_manual', openid, getClientRequestId(data))
      const currentOrder = ((await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data) || order
      const totalRefundAmount = Number(currentOrder.refundAmount || 0)
      const isFullRefund = Number(currentOrder.refundedAmount || 0) >= payAmount
      await appendOrderTimeline(orderId, 'refund', `管理员发起退款 ¥${refundAmount.toFixed(2)}`, `说明：${reason}${isFullRefund ? '（已全额退款）' : ''}`, 'admin')
      await logAdmin(admin, 'order', orderId, 'refundOrder', { refundAmount, reason, refundNo: refund.refundNo, isFullRefund })
      return {
        orderId,
        refundNo: refund.refundNo,
        refundAmount,
        totalRefundAmount,
        isFullRefund,
        status: currentOrder.status
      }
    }
    if (action === 'listServicePrices') {
      return listServicePrices(true)
    }
    if (action === 'listServiceCheckinRules') {
      return listServiceCheckinRules()
    }
    if (action === 'saveServiceCheckinRules') {
      const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
      const rules = (Array.isArray(data.rules) ? data.rules : []).map((rule) => normalizeServiceCheckinRule(rule, validServiceKeys))
      const time = now()
      await removeByQuery('service_checkin_rules', {})
      await Promise.all(rules.map((rule) => db.collection('service_checkin_rules').add({ data: { ...rule, createdAt: time, updatedAt: time } })))
      await logAdmin(admin, 'service_checkin_rule', 'rules', 'saveServiceCheckinRules', { count: rules.length })
      return listServiceCheckinRules()
    }
    if (action === 'resetDefaultServiceCheckinRules') {
      const time = now()
      await removeByQuery('service_checkin_rules', {})
      await Promise.all(defaultServiceCheckinRules.map((rule) => db.collection('service_checkin_rules').add({ data: { ...normalizeServiceCheckinRule(rule), createdAt: time, updatedAt: time } })))
      await logAdmin(admin, 'service_checkin_rule', 'defaults', 'resetDefaultServiceCheckinRules', {})
      return listServiceCheckinRules()
    }
    if (action === 'saveServicePrice') {
      const key = String(data.key || '').trim()
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw new Error('服务标识格式不正确')
      if (RETIRED_SERVICE_KEYS.has(key)) throw new Error('该服务项目已下线')
      const preset = defaultServicePrices.find((item) => item.key === key)
      const label = safeText(data.label || (preset && preset.label)).trim()
      if (!label) throw new Error('服务名称不能为空')
      const price = Number(data.price)
      if (!Number.isFinite(price) || price < 0) throw new Error('价格不正确')
      const extraPetFee = Number(data.extraPetFee || 0)
      if (!Number.isFinite(extraPetFee) || extraPetFee < 0) throw new Error('多宠物加价不正确')
      const internPrice = data.internPrice === undefined || data.internPrice === '' ? price : Number(data.internPrice)
      if (!Number.isFinite(internPrice) || internPrice < 0) throw new Error('实习宠托师价格不正确')
      const internExtraPetFee = data.internExtraPetFee === undefined || data.internExtraPetFee === '' ? extraPetFee : Number(data.internExtraPetFee)
      if (!Number.isFinite(internExtraPetFee) || internExtraPetFee < 0) throw new Error('实习宠托师多宠物加价不正确')
      const extraHalfHourFee = data.extraHalfHourFee === undefined || data.extraHalfHourFee === '' ? 0 : Number(data.extraHalfHourFee)
      if (!Number.isFinite(extraHalfHourFee) || extraHalfHourFee < 0) throw new Error('续时加价不正确')
      const internExtraHalfHourFee = data.internExtraHalfHourFee === undefined || data.internExtraHalfHourFee === '' ? extraHalfHourFee : Number(data.internExtraHalfHourFee)
      if (!Number.isFinite(internExtraHalfHourFee) || internExtraHalfHourFee < 0) throw new Error('实习宠托师续时加价不正确')
      const time = now()
      const payload = normalizeServicePrice({
        ...(preset || {}),
        key,
        label,
        price,
        internPrice,
        extraPetFee,
        internExtraPetFee,
        extraHalfHourFee,
        internExtraHalfHourFee,
        extraPetRule: key === VISIT_FEE_SERVICE_KEY ? 'none' : data.extraPetRule,
        showOnHome: key === VISIT_FEE_SERVICE_KEY ? false : Boolean(data.showOnHome),
        enabled: data.enabled !== false,
        description: safeText(data.description || (preset && preset.description)).trim(),
        detailDescription: safeText(data.detailDescription).trim().slice(0, 5000),
        caseImageFileIds: normalizeServiceCaseImageFileIds(data.caseImageFileIds),
        coverUrl: (data.coverUrl !== undefined && !String(data.coverUrl).startsWith('/images/services/'))
          ? safeText(data.coverUrl).trim()
          : ((preset && typeof preset.coverUrl === 'string' && !preset.coverUrl.startsWith('/images/services/')) ? safeText(preset.coverUrl).trim() : ''),
        sortOrder: Number(data.sortOrder || (preset && preset.sortOrder) || 100),
        updatedAt: time
      })
      const existing = await db.collection('service_prices').where({ key }).limit(1).get().catch(() => ({ data: [] }))
      const existingDoc = existing && existing.data && existing.data[0]
      if (existingDoc) {
        await db.collection('service_prices').doc(existingDoc._id).update({ data: { ...payload, updatedAt: time } })
      } else {
        await db.collection('service_prices').add({ data: { ...payload, createdAt: time, updatedAt: time } })
      }
      await logAdmin(admin, 'service_price', key, 'saveServicePrice', { price, internPrice: payload.internPrice, extraPetFee: payload.extraPetFee, internExtraPetFee: payload.internExtraPetFee, extraHalfHourFee: payload.extraHalfHourFee, internExtraHalfHourFee: payload.internExtraHalfHourFee, extraPetRule: payload.extraPetRule, enabled: payload.enabled, showOnHome: payload.showOnHome })
      return payload
    }
    if (action === 'deleteServicePrice') {
      const key = String(data.key || '').trim()
      if (!key) throw new Error('服务标识不能为空')
      if (key === VISIT_FEE_SERVICE_KEY) throw new Error('上门费不能删除')
      const time = now()
      const existing = await db.collection('service_prices').where({ key }).limit(1).get().catch(() => ({ data: [] }))
      const existingDoc = existing && existing.data && existing.data[0]
      if (isPresetServiceKey(key)) {
        const payload = { enabled: false, showOnHome: false, updatedAt: time }
        if (existingDoc) await db.collection('service_prices').doc(existingDoc._id).update({ data: payload })
        else await db.collection('service_prices').add({ data: { key, label: (defaultServicePrices.find((item) => item.key === key) || {}).label || key, price: 0, ...payload, createdAt: time } })
      } else if (existingDoc) {
        await db.collection('service_prices').doc(existingDoc._id).remove()
        await removeByQuery('service_checkin_rules', { serviceType: key })
      }
      await logAdmin(admin, 'service_price', key, 'deleteServicePrice', {})
      return listServicePrices(true)
    }
    if (action === 'resetDefaultServicePrices') {
      const time = now()
      await Promise.all(defaultServicePrices.map(async (preset) => {
        const existing = await db.collection('service_prices').where({ key: preset.key }).limit(1).get().catch(() => ({ data: [] }))
        const existingItem = (existing && existing.data && existing.data[0]) || {}
        const payload = {
          ...normalizeServicePrice({
            ...preset,
            detailDescription: existingItem.detailDescription || '',
            caseImageFileIds: existingItem.caseImageFileIds || []
          }),
          updatedAt: time
        }
        if (existingItem._id) return db.collection('service_prices').doc(existingItem._id).update({ data: payload })
        return db.collection('service_prices').add({ data: { ...payload, createdAt: time } })
      }))
      await logAdmin(admin, 'service_price', 'defaults', 'resetDefaultServicePrices', {})
      return listServicePrices(true)
    }
    if (action === 'listCouponTemplates') {
      const res = await db.collection('coupon_templates').orderBy('sortOrder', 'asc').get()
      return (res.data || []).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    }
    if (action === 'saveCouponTemplate') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('优惠券名称不能为空')
      const couponText = [name, data.description, data.displayTag, data.claimNotice, data.useNotice].filter(Boolean).join(' ')
      if (couponText && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, couponText, { scene: 2, label: '优惠券模板资料' })
      }
      const discountAmount = Math.round(Number(data.discountAmount || 0))
      const minOrderAmount = Math.max(Math.round(Number(data.minOrderAmount || 0)), 0)
      const validType = data.validType === 'fixed_range' ? 'fixed_range' : 'relative_days'
      const validDays = Math.max(Math.round(Number(data.validDays || 30)), 1)
      const validFromFixed = safeText(data.validFromFixed).trim()
      const validToFixed = safeText(data.validToFixed).trim()
      if (!discountAmount || discountAmount < 0) throw new Error('优惠金额不正确')
      if (validType === 'fixed_range') {
        if (!validFromFixed || !validToFixed) throw new Error('请填写固定有效期')
        if (validToFixed < validFromFixed) throw new Error('固定有效期结束时间不能早于开始时间')
      }
      const usageScope = normalizeCouponUsageScope(data.usageScope || data.businessType)
      const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
      const applicableServiceTypes = usageScope === 'service' ? (Array.isArray(data.applicableServiceTypes) ? data.applicableServiceTypes.map((item) => String(item || '').trim()).filter(Boolean) : []) : []
      if (applicableServiceTypes.some((key) => !validServiceKeys.includes(key))) throw new Error('适用服务不正确')
      const time = now()
      const payload = {
        name,
        description: safeText(data.description).trim(),
        type: 'fixed',
        usageScope,
        usageScopeText: couponUsageScopeText(usageScope),
        discountAmount,
        minOrderAmount,
        applicableServiceTypes,
        validType,
        validDays,
        validFromFixed: validType === 'fixed_range' ? validFromFixed : '',
        validToFixed: validType === 'fixed_range' ? validToFixed : '',
        displayTag: safeText(data.displayTag).trim(),
        claimNotice: safeText(data.claimNotice).trim(),
        useNotice: safeText(data.useNotice).trim(),
        newbieOnly: data.newbieOnly === true,
        enabled: data.enabled !== false,
        totalIssueLimit: Math.max(Math.round(Number(data.totalIssueLimit || 0)), 0),
        perUserLimit: Math.max(Math.round(Number(data.perUserLimit || 1)), 1),
        sortOrder: Number(data.sortOrder || 100),
        updatedAt: time
      }
      if (data._id) {
        const existing = await db.collection('coupon_templates').doc(data._id).get().catch(() => ({ data: null }))
        if (!existing || !existing.data) throw new Error('优惠券模板不存在或已被删除')
        await db.collection('coupon_templates').doc(data._id).update({ data: payload })
        await logAdmin(admin, 'coupon_template', data._id, 'saveCouponTemplate', { name, discountAmount, validType })
        return { ...existing.data, ...payload, _id: data._id }
      }
      const created = await db.collection('coupon_templates').add({ data: { ...payload, issuedCount: 0, createdAt: time } })
      await logAdmin(admin, 'coupon_template', created._id, 'saveCouponTemplate', { name, discountAmount, validType })
      return { _id: created._id, ...payload, issuedCount: 0, createdAt: time }
    }
    if (action === 'deleteCouponTemplate') {
      const templateId = safeText(data._id || data.id || data.templateId).trim()
      if (!templateId) throw new Error('缺少优惠券模板ID')
      const templateRes = await db.collection('coupon_templates').doc(templateId).get().catch(() => ({ data: null }))
      const template = templateRes && templateRes.data
      if (!template) throw new Error('优惠券模板不存在或已被删除')

      // 先检查抽奖活动中是否正在使用该优惠券作为奖品
      const activities = (await db.collection('lottery_activities').get()).data || []
      const usedActivities = activities.filter((act) => {
        const prizes = Array.isArray(act.prizes) ? act.prizes : []
        return prizes.some((p) => String(p.templateId || p.couponId || '').trim() === templateId)
      })

      if (usedActivities.length > 0) {
        const names = usedActivities.map((a) => `【${a.name || '未命名抽奖活动'}】`).join('、')
        throw new Error(`该优惠券已被抽奖活动 ${names} 配置为奖品，无法直接删除。请先前往抽奖活动中移除该奖品后再删除。`)
      }

      await db.collection('coupon_templates').doc(templateId).remove()
      await logAdmin(admin, 'coupon_template', templateId, 'deleteCouponTemplate', { name: template.name })
      return { _id: templateId, success: true }
    }
    if (action === 'issueCouponToUser') {
      const templateId = safeText(data.templateId).trim()
      const targetOpenid = safeText(data.openid).trim()
      if (!templateId) throw new Error('请选择优惠券模板')
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const templateRes = await db.collection('coupon_templates').doc(templateId).get().catch(() => ({ data: null }))
      const template = templateRes && templateRes.data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const targetUser = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!targetUser || targetUser.status !== 'active') throw new Error('目标用户不存在')
      const clientRequestId = getClientRequestId(data)
      const issued = await issueCouponToTargetUser(template, targetUser, {
        adminUserId: admin._id,
        adminOpenid: openid,
        idempotencyKey: clientRequestId || '',
        sourceType: 'admin_issue',
        sourceId: clientRequestId || templateId
      })
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponToUser', { targetOpenid, couponId: issued._id, clientRequestId })
      return { _id: issued._id, templateId, openid: targetOpenid, status: 'available', templateSnapshot: issued.templateSnapshot, validFrom: issued.validFrom, validTo: issued.validTo }
    }
    if (action === 'listFeedback') {
      const status = safeText(data.status).trim()
      const category = safeText(data.category).trim()
      const where = {}
      if (status) where.status = status
      if (category) where.category = category
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const countRes = await db.collection('user_feedback').where(where).count()
        const total = (countRes && countRes.total) || 0
        const page = Math.max(1, Number(data.page || 1))
        const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
        const offset = (page - 1) * pageSize
        if (offset >= total) {
          return { list: [], total, page, pageSize, hasMore: false }
        }
        const res = await db.collection('user_feedback')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = res.data || []
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }
      const allFeedback = (await readAll('user_feedback', where, 2000))
        .sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      return allFeedback
    }
    if (action === 'replyFeedback') {
      const id = safeText(data.id || data.feedbackId).trim()
      if (!id) throw new Error('请选择反馈')
      const feedbackRes = await db.collection('user_feedback').doc(id).get().catch(() => null)
      const feedbackDoc = feedbackRes && feedbackRes.data
      if (!feedbackDoc) throw new Error('反馈记录不存在')
      const replyContent = safeText(data.replyContent || data.reply).trim()
      if (!replyContent) throw new Error('请输入回复内容')
      if (replyContent.length > 1000) throw new Error('回复内容不能超过 1000 字')
      if (typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, replyContent, { scene: 2, label: '反馈回复内容' })
      }
      const status = safeText(data.status).trim() || 'resolved'
      const time = now()
      const updateData = {
        replyContent,
        repliedByOpenid: openid,
        repliedAt: time,
        status,
        updatedAt: time
      }
      await db.collection('user_feedback').doc(id).update({ data: updateData })
      await logAdmin(admin, 'user_feedback', id, 'replyFeedback', { status })
      return { id, status }
    }
    if (action === 'listPetVaccineCertifications') {
      const status = safeText(data.status).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const where = {}
      if (status) where.status = status
      const page = Math.max(1, Number(data.page || 1))
      const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
      const offset = (page - 1) * pageSize
      let applications = []
      let total = 0
      if (!keyword) {
        const countRes = await db.collection('pet_vaccine_certifications').where(where).count().catch(() => ({ total: 0 }))
        total = countRes.total || 0
        if (offset < total) {
          const res = await db.collection('pet_vaccine_certifications').where(where).orderBy('createdAt', 'desc').skip(offset).limit(pageSize).get().catch(() => ({ data: [] }))
          applications = res.data || []
        }
      } else {
        const all = await readAll('pet_vaccine_certifications', where, 1000)
        const matched = all.filter((item) => [item.certificateNo, item.ownerRemark, item.rejectReason, item.adminRemark, item.petSnapshot && item.petSnapshot.name, item.petSnapshot && item.petSnapshot.breed].some((value) => safeText(value).toLowerCase().includes(keyword))).sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
        total = matched.length
        applications = matched.slice(offset, offset + pageSize)
      }
      const openids = Array.from(new Set(applications.map((item) => item.openid).filter(Boolean)))
      const userMap = {}
      await Promise.all(openids.map(async (targetOpenid) => {
        const userRes = await db.collection('users').where({ openid: targetOpenid }).limit(1).get().catch(() => ({ data: [] }))
        if (userRes.data && userRes.data[0]) userMap[targetOpenid] = safeUserSummary(userRes.data[0])
      }))
      return {
        list: applications.map((item) => ({ ...item, owner: userMap[item.openid] || {} })),
        total,
        page,
        pageSize,
        hasMore: offset + applications.length < total
      }
    }
    if (action === 'auditPetVaccineCertification') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      if (!applicationId) throw new Error('请选择疫苗认证申请')
      const approved = data.status === 'approved' || data.auditStatus === 'approved'
      const status = approved ? 'approved' : 'rejected'
      const rejectReason = safeText(data.rejectReason || data.reason).trim().slice(0, 200)
      const adminRemark = safeText(data.adminRemark || data.remark).trim().slice(0, 200)
      const validUntil = safeText(data.validUntil).trim()
      if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new Error('请选择有效的疫苗有效期')
      if (!approved && !rejectReason) throw new Error('请填写驳回原因')
      const textToCheck = [adminRemark, rejectReason].filter(Boolean).join(' ')
      if (textToCheck && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, textToCheck, { scene: 2, label: '疫苗审核备注' })
      }
      const applicationRes = await db.collection('pet_vaccine_certifications').doc(applicationId).get().catch(() => ({ data: null }))
      const application = applicationRes && applicationRes.data
      if (!application) throw new Error('疫苗认证申请不存在')
      if (application.status !== 'pending') throw new Error('该申请已审核，请勿重复操作')
      const petRes = await db.collection('pets').doc(application.petId).get().catch(() => ({ data: null }))
      const pet = petRes && petRes.data
      if (!pet) throw new Error('宠物不存在')
      const time = now()
      const appUpdate = { status, adminRemark, rejectReason: approved ? '' : rejectReason, reviewedByOpenid: openid, reviewedAt: time, updatedAt: time }
      await db.collection('pet_vaccine_certifications').doc(applicationId).update({ data: appUpdate })
      const previous = pet.vaccineCertification || {}
      const vaccineCertification = approved ? {
        status: 'approved',
        fileIds: application.fileIds || [],
        submittedAt: application.createdAt || previous.submittedAt || '',
        reviewedAt: time,
        reviewedByOpenid: openid,
        reviewRemark: adminRemark,
        rejectReason: '',
        validUntil: validUntil || application.validUntil || previous.validUntil || '',
        vaccineTypes: application.vaccineTypes || [],
        certificateNo: application.certificateNo || '',
        latestApplicationId: applicationId,
        renewalPending: false
      } : {
        ...previous,
        status: previous.status === 'approved' && previous.renewalPending === true ? 'approved' : 'rejected',
        reviewedAt: previous.status === 'approved' && previous.renewalPending === true ? previous.reviewedAt : time,
        reviewedByOpenid: previous.status === 'approved' && previous.renewalPending === true ? previous.reviewedByOpenid : openid,
        reviewRemark: adminRemark,
        rejectReason,
        latestApplicationId: applicationId,
        renewalPending: false
      }
      await db.collection('pets').doc(application.petId).update({ data: { vaccineCertification, updatedAt: time } })
      await logAdmin(admin, 'pet_vaccine_certification', applicationId, 'auditPetVaccineCertification', { status, petId: application.petId })
      return { applicationId, status, petId: application.petId }
    }
    if (action === 'listStaffAudits') {
      const status = safeText(data.auditStatus).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const where = {}
      if (status) where.auditStatus = status
      if (data.staffProfileId || data.id) {
        where._id = safeText(data.staffProfileId || data.id).trim()
      }

      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      let pagedProfiles = []
      let total = 0
      const page = Math.max(1, Number(data.page || 1))
      const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
      const offset = (page - 1) * pageSize

      if (!keyword) {
        if (wantsPage) {
          const countRes = await db.collection('staff_profiles').where(where).count()
          total = (countRes && countRes.total) || 0
          if (offset < total) {
            const res = await db.collection('staff_profiles')
              .where(where)
              .orderBy('updatedAt', 'desc')
              .skip(offset)
              .limit(pageSize)
              .get()
            pagedProfiles = res.data || []
          }
        } else {
          const res = await db.collection('staff_profiles')
            .where(where)
            .orderBy('updatedAt', 'desc')
            .limit(100)
            .get()
          pagedProfiles = res.data || []
          total = pagedProfiles.length
        }
      } else {
        const allProfiles = await readAll('staff_profiles', where, 1000)
        const profileUsers = await fetchUsersByOpenids(allProfiles.map((profile) => profile.openid))
        const profileUserMap = new Map(profileUsers.map((user) => [user.openid, user]))
        const allMatching = allProfiles
          .filter((item) => {
            const phoneFields = staffPhoneFields(profileUserMap.get(item.openid) || {}, item)
            return [item.realName, item.phone, phoneFields.accountPhone, phoneFields.certifiedPhone, item.serviceCity, item.serviceAreas]
              .some((value) => safeText(value).toLowerCase().includes(keyword))
          })
          .sort((a, b) => toTimeValue(b.updatedAt) - toTimeValue(a.updatedAt))
        total = allMatching.length
        pagedProfiles = wantsPage ? allMatching.slice(offset, offset + pageSize) : allMatching
      }

      const targetOpenids = Array.from(new Set(pagedProfiles.map((p) => p.openid).filter(Boolean)))
      const [auditUsers, evidences] = await Promise.all([
        fetchUsersByOpenids(targetOpenids),
        fetchStaffEvidencesByOpenids(targetOpenids)
      ])
      const auditUserMap = new Map(auditUsers.map((user) => [user.openid, user]))
      const evidenceByStaff = {}
      for (const ev of evidences) {
        if (!evidenceByStaff[ev.staffOpenid]) evidenceByStaff[ev.staffOpenid] = []
        evidenceByStaff[ev.staffOpenid].push(ev)
      }

      const list = pagedProfiles.map((p) => {
        const phoneFields = staffPhoneFields(auditUserMap.get(p.openid) || {}, p)
        const staffEvidences = evidenceByStaff[p.openid] || []
        return {
          ...p,
          phone: phoneFields.phone,
          accountPhone: phoneFields.accountPhone,
          certifiedPhone: phoneFields.certifiedPhone,
          problemOrderCount: staffEvidences.length,
          pendingPenaltyCount: staffEvidences.filter((e) => e.status === 'pending').length,
          problemOrders: staffEvidences
        }
      })

      if (wantsPage) {
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + pagedProfiles.length < total
        }
      }
      return list
    }
    if (action === 'completeStaffGender') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      const gender = requireStaffGender(data.gender)
      const reason = safeText(data.reason).trim()
      if (!staffProfileId || !reason) throw new Error('请选择宠托师并填写核实说明')
      const time = now()
      await db.runTransaction(async (tx) => {
        const profile = (await tx.collection('staff_profiles').doc(staffProfileId).get()).data
        if (!profile || profile.auditStatus !== 'approved') throw new Error('仅可为已审核通过的宠托师补录性别')
        if (['male', 'female'].includes(profile.gender)) throw new Error('性别已设置，不可重复补录')
        await tx.collection('staff_profiles').doc(staffProfileId).update({ data: {
          gender, certificationLockedAt: profile.certificationLockedAt || time,
          genderVerifiedBy: openid, genderVerifiedAt: time, genderVerificationReason: reason, updatedAt: time
        } })
      })
      const identities = await db.collection('staff_identity_verifications').where({ staffProfileId }).get()
      await Promise.all((identities.data || []).map((identity) => db.collection('staff_identity_verifications').doc(identity._id).update({ data: { gender, updatedAt: time } })))
      await logAdmin(admin, 'staff_profile', staffProfileId, 'completeStaffGender', { gender, reason })
      return { staffProfileId, gender }
    }
    if (action === 'auditStaff') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const status = data.auditStatus === 'approved' ? 'approved' : 'rejected'
      const auditRemark = safeText(data.auditRemark || data.remark).trim()
      if (auditRemark.length > 500) throw new Error('审核备注不能超过 500 字')
      if (auditRemark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, auditRemark, { scene: 2, label: '资质审核备注' })
      }
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile) throw new Error('宠托师档案不存在')
      if (profile.auditStatus === status) {
        throw new Error('该宠托师资质已处于该审核状态，请勿重复操作')
      }
      if (status === 'approved') requireStaffGender(profile.gender)
      const identityStatus = status === 'approved' ? 'verified' : 'failed'
      const faceVerifyStatus = status === 'approved' ? 'verified' : 'failed'
      const time = now()
      const workflowUpdate = status === 'approved'
        ? { staffLevel: 'applicant', onboardingStatus: 'training_pending', videoAuditStatus: 'not_started', promotionStatus: 'none' }
        : { staffLevel: 'applicant', onboardingStatus: 'application_pending', videoAuditStatus: 'not_started', promotionStatus: 'none' }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: { auditStatus: status, auditRemark, identityStatus, faceVerifyStatus, ...workflowUpdate, ...(status === 'approved' ? { certificationLockedAt: profile.certificationLockedAt || time } : {}), updatedAt: time } })
      const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId }).limit(1).get()
      if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: { auditStatus: status, auditRemark, identityStatus, faceVerifyStatus, auditedByOpenid: openid, auditedAt: time, updatedAt: time } })
      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
      if (staffUser && status === 'rejected') {
        const existingRoles = Array.isArray(staffUser.roles) ? staffUser.roles : ['client']
        const roles = existingRoles.filter((role) => role !== 'staff')
        await assertStaffFundsSettledBeforeRoleRemoval(staffUser, roles)
        const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
        if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
        await db.collection('users').doc(staffUser._id).update({ data: userUpdate })
      }
      if (typeof sendSystemNotification === 'function' && profile.openid) {
        const approved = status === 'approved'
        await sendSystemNotification({
          target: 'client',
          targetOpenid: profile.openid,
          type: 'notice',
          level: approved ? 'normal' : 'warning',
          title: approved ? '宠托师入驻审核通过' : '宠托师入驻审核未通过',
          content: approved
            ? '你的宠托师入驻资料审核已通过。请继续完成保证金、培训答题、视频学习和线上视频审核。'
            : `你的宠托师入驻资料审核未通过。${auditRemark ? `原因：${auditRemark}` : '请根据平台提示修改资料后重新提交。'}`,
          targetUrl: '/pages/staff/certification/index',
          extra: { staffProfileId, auditStatus: status },
          idempotencyKey: `staff_audit_result:${staffProfileId}:${status}:${time}`
        }, admin).catch(() => {})
      }
      await logAdmin(admin, 'staff_profile', staffProfileId, 'auditStaff', { status })
      return { staffProfileId, auditStatus: status }
    }
    if (action === 'revokeStaff') {
      const staffProfileId = safeText(data.staffProfileId || data.id).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile) throw new Error('宠托师不存在')

      const _ = db.command
      const inOp = _ && typeof _.in === 'function' ? _.in.bind(_) : (arr) => ({ $in: arr })
      const activeStaffStatuses = [
        (ORDER_STATUS && ORDER_STATUS.ASSIGNED) || 'assigned',
        (ORDER_STATUS && ORDER_STATUS.ON_THE_WAY) || 'on_the_way',
        (ORDER_STATUS && ORDER_STATUS.IN_SERVICE) || 'in_service',
        (ORDER_STATUS && ORDER_STATUS.DAY_COMPLETED) || 'day_completed'
      ]

      const activeOrdersRes = await db.collection('orders').where({
        staffOpenid: profile.openid,
        status: inOp(activeStaffStatuses)
      }).limit(1).get().catch(() => ({ data: [] }))

      if (activeOrdersRes.data && activeOrdersRes.data.length > 0) {
        throw new Error('该宠托师尚有未完成的履约订单，请先在订单管理中改派或处理相关订单后再撤销身份')
      }

      const activeIncidentStatuses = ['open', 'investigating', 'triaging', 'waiting_client', 'waiting_staff', 'processing', 'refund_pending']
      const activeIncidentsRes = await db.collection('order_incidents').where({
        staffOpenid: profile.openid,
        status: inOp(activeIncidentStatuses)
      }).limit(1).get().catch(() => ({ data: [] }))

      if (activeIncidentsRes.data && activeIncidentsRes.data.length > 0) {
        throw new Error('该宠托师存在尚未结案的客诉或纠纷，暂不可撤销身份')
      }

      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
      if (staffUser) {
        const rolesAfterRemoval = (Array.isArray(staffUser.roles) ? staffUser.roles : ['client']).filter((role) => role !== 'staff')
        await assertStaffFundsSettledBeforeRoleRemoval(staffUser, rolesAfterRemoval)
      }

      const time = now()
      const auditRemark = safeText(data.auditRemark || data.remark).trim() || '管理员移除宠托师身份'
      const update = {
        auditStatus: 'revoked',
        auditRemark,
        certificationLockedAt: null,
        staffLevel: 'applicant',
        onboardingStatus: 'application_pending',
        videoAuditStatus: 'not_started',
        promotionStatus: 'none',
        isFeatured: false,
        quizPassedAt: null,
        quizScore: 0,
        trainingVideoProgress: {},
        trainingVideosCompletedAt: null,
        videoAuditRequestedAt: null,
        videoAuditRemark: '',
        internStartedAt: null,
        internCompletedOrderCount: 0,
        promotionApplicationId: '',
        promotionAppliedAt: null,
        updatedAt: time
      }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: update })
      if (staffUser) {
        const roles = (Array.isArray(staffUser.roles) ? staffUser.roles : ['client']).filter((role) => role !== 'staff')
        const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
        if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
        await db.collection('users').doc(staffUser._id).update({ data: userUpdate })
      }
      await logAdmin(admin, 'staff_profile', staffProfileId, 'revokeStaff', { auditRemark })
      return { staffProfileId, auditStatus: 'revoked' }
    }
    if (action === 'listTrainingAudits') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const profiles = (await readAll('staff_profiles', { auditStatus: 'approved', videoAuditStatus: 'pending' }))
        .sort((a, b) => toTimeValue(b.videoAuditRequestedAt) - toTimeValue(a.videoAuditRequestedAt))
        .map(normalizeStaffWorkflow)
      const trainingUsers = await fetchUsersByOpenids(profiles.map((profile) => profile.openid))
      const trainingUserMap = new Map(trainingUsers.map((user) => [user.openid, user]))
      const list = profiles
        .map((profile) => ({ ...profile, ...staffPhoneFields(trainingUserMap.get(profile.openid) || {}, profile) }))
        .filter((item) => !keyword || [item.realName, item.phone, item.accountPhone, item.certifiedPhone, item.serviceCity, item.serviceAreas].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'auditTrainingVideo') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      const status = data.status === 'approved' ? 'approved' : 'rejected'
      if (!staffProfileId) throw new Error('请选择宠托师')
      const remark = safeText(data.remark).trim()
      if (remark.length > 500) throw new Error('审核备注不能超过 500 字')
      if (remark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, remark, { scene: 2, label: '培训审核备注' })
      }
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      if (profile.videoAuditStatus !== 'pending') {
        throw new Error('当前宠托师未处于视频待审核状态')
      }
      const time = now()
      const update = status === 'approved'
        ? { videoAuditStatus: 'approved', onboardingStatus: 'intern', staffLevel: 'intern', internStartedAt: profile.internStartedAt || time, videoAuditRemark: remark, updatedAt: time }
        : { videoAuditStatus: 'rejected', onboardingStatus: 'videos_completed', videoAuditRemark: remark, updatedAt: time }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: update })
      const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = staffUserRes.data[0]
      if (staffUser && status === 'approved') {
        const roles = Array.from(new Set([...(Array.isArray(staffUser.roles) ? staffUser.roles : ['client']), 'staff']))
        await db.collection('users').doc(staffUser._id).update({ data: { roles, updatedAt: time } })
      }
      await logAdmin(admin, 'staff_profile', staffProfileId, 'auditTrainingVideo', { status })
      return { staffProfileId, status, ...update }
    }
    if (action === 'listPromotionApplications') {
      const status = safeText(data.status).trim()
      const apps = (await readAll('staff_promotion_applications', status ? { status } : {})).sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      const filteredApps = apps.filter((item) => !status || item.status === status)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const pageMeta = paginateList(filteredApps, data)
        const profileIds = Array.from(new Set(pageMeta.list.map((item) => item.staffProfileId).filter(Boolean)))
        const profiles = await fetchStaffProfilesByIds(profileIds)
        const profileMap = new Map(profiles.map((item) => [item._id, item]))
        const users = await fetchUsersByOpenids(profiles.map((profile) => profile.openid))
        const userMap = new Map(users.map((user) => [user.openid, user]))
        return {
          ...pageMeta,
          list: pageMeta.list.map((item) => {
            const profile = profileMap.get(item.staffProfileId) || null
            return { ...item, profile: profile ? { ...profile, ...staffPhoneFields(userMap.get(profile.openid) || {}, profile) } : null }
          })
        }
      }
      const pagedList = limitList(filteredApps, data.pageSize || 50)
      const profileIds = Array.from(new Set(pagedList.map((item) => item.staffProfileId).filter(Boolean)))
      const profiles = await fetchStaffProfilesByIds(profileIds)
      const profileMap = new Map(profiles.map((item) => [item._id, item]))
      const users = await fetchUsersByOpenids(profiles.map((profile) => profile.openid))
      const userMap = new Map(users.map((user) => [user.openid, user]))
      return pagedList.map((item) => {
        const profile = profileMap.get(item.staffProfileId) || null
        return { ...item, profile: profile ? { ...profile, ...staffPhoneFields(userMap.get(profile.openid) || {}, profile) } : null }
      })
    }
    if (action === 'getPromotionApplicationDetail') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      if (!applicationId) throw new Error('请选择晋升申请')
      const appRes = await db.collection('staff_promotion_applications').doc(applicationId).get().catch(() => ({ data: null }))
      const app = appRes && appRes.data
      if (!app) throw new Error('晋升申请不存在')
      const pRes = await db.collection('staff_profiles').doc(app.staffProfileId).get().catch(() => ({ data: null }))
      const rawProfile = pRes && pRes.data
      const profileUser = rawProfile && (await db.collection('users').where({ openid: rawProfile.openid }).limit(1).get().catch(() => ({ data: [] }))).data?.[0]
      const profile = rawProfile ? { ...normalizeStaffWorkflow(rawProfile), ...staffPhoneFields(profileUser || {}, rawProfile) } : null
      const orders = []
      for (const orderId of (app.orderIds || [])) {
        const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
        const order = orderRes && orderRes.data
        if (!order) {
          orders.push({ order: { _id: orderId }, unavailable: true, tracks: [], checkins: [], review: null })
          continue
        }
        // Read every page: the default database limit hides later evidence.
        const [tracks, checkins, reviews] = await Promise.all([
          readScopedDocuments('track_logs', { orderId }, 'recordedAt'),
          readScopedDocuments('checkin_logs', { orderId }, 'createdAt'),
          readScopedDocuments('service_reviews', { orderId }, 'createdAt', 'desc')
        ])
        orders.push({ order: await attachAdminOrderContactData({ ...order, _id: orderId }), tracks, checkins: checkins.filter(isActiveCheckin), review: reviews[0] || null })
      }
      return { application: app, profile, orders }
    }
    if (action === 'auditPromotionApplication') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      const status = data.status === 'approved' ? 'approved' : 'rejected'
      if (!applicationId) throw new Error('请选择晋升申请')
      const remark = safeText(data.remark).trim()
      if (remark.length > 500) throw new Error('审核备注不能超过 500 字')
      if (remark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, remark, { scene: 2, label: '晋升审核备注' })
      }
      const appRes = await db.collection('staff_promotion_applications').doc(applicationId).get().catch(() => ({ data: null }))
      const app = appRes && appRes.data
      if (!app) throw new Error('晋升申请不存在')
      if (app.status !== 'pending') {
        throw new Error('该晋升申请已完成审核，无法重复处理')
      }
      const time = now()
      const appUpdate = { status, adminRemark: remark, reviewedByOpenid: openid, reviewedAt: time, updatedAt: time }
      await db.collection('staff_promotion_applications').doc(applicationId).update({ data: appUpdate })
      const profileUpdate = status === 'approved'
        ? { staffLevel: 'certified', promotionStatus: 'approved', certifiedAt: time, updatedAt: time }
        : { promotionStatus: 'rejected', promotionRejectReason: remark, updatedAt: time }
      await db.collection('staff_profiles').doc(app.staffProfileId).update({ data: profileUpdate })
      await logAdmin(admin, 'staff_promotion_application', applicationId, 'auditPromotionApplication', { status })
      return { applicationId, status }
    }
    if (action === 'listMemberLevels') {
      const levels = await getMemberLevels()
      return levels.map((level, idx) => ({
        ...level,
        badgeTag: normalizeMemberBadgeTag(level.badgeTag) || `V${idx + 1}`,
        nameColor: normalizeMemberNameColor(level.nameColor),
        nameEffect: normalizeMemberNameEffect(level.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(level.badgeStyle),
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
    }
    if (action === 'saveMemberLevel') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('等级名称不能为空')
      const benefitTexts = Array.isArray(data.benefits)
        ? data.benefits.map((b) => (typeof b === 'string' ? b : (b && (b.title || b.description || b.name)))).filter(Boolean)
        : []
      const memberLevelText = [name, data.badgeTag, data.description, ...benefitTexts].filter(Boolean).join(' ')
      if (memberLevelText && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, memberLevelText, { scene: 2, label: '会员等级资料' })
      }
      const existingLevels = await getMemberLevels()
      const duplicate = existingLevels.find((item) => item.name === name && item._id !== data._id)
      if (duplicate) throw new Error('已存在同名会员等级，请先编辑原等级或换一个名称')
      const minPoints = Math.max(Math.round(Number(data.minPoints || 0)), 0)
      const time = now()
      const payload = {
        name,
        badgeTag: normalizeMemberBadgeTag(data.badgeTag),
        nameColor: normalizeMemberNameColor(data.nameColor),
        nameEffect: normalizeMemberNameEffect(data.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(data.badgeStyle),
        minPoints,
        icon: safeText(data.icon).trim(),
        pointMultiplier: Math.max(Number(data.pointMultiplier || 1), 1),
        description: safeText(data.description).trim(),
        benefits: normalizeBenefits(data.benefits),
        sortOrder: Number(data.sortOrder || 0),
        updatedAt: time
      }
      if (data._id) {
        await db.collection('member_levels').doc(data._id).update({ data: payload })
        await syncUsersMemberLevelName(data._id, name)
        await logAdmin(admin, 'member_level', data._id, 'saveMemberLevel', { name, minPoints, pointMultiplier: payload.pointMultiplier })
        return { _id: data._id, ...payload }
      }
      const created = await db.collection('member_levels').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'member_level', created._id, 'saveMemberLevel', { name, minPoints, pointMultiplier: payload.pointMultiplier })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'deleteMemberLevel') {
      if (!data._id) throw new Error('缺少等级 ID')
      await db.collection('member_levels').doc(data._id).remove()
      await recalcUsersForDeletedLevel(data._id)
      await logAdmin(admin, 'member_level', data._id, 'deleteMemberLevel', {})
      return { _id: data._id }
    }
    if (action === 'listPetTitles') {
      return listPetTitles({ includeDeleted: data.includeDeleted === true })
    }
    if (action === 'savePetTitle') {
      const titleName = safeText(data.name).trim()
      const titleDesc = safeText(data.description).trim()
      const petTitleText = [titleName, titleDesc].filter(Boolean).join(' ')
      if (petTitleText && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, petTitleText, { scene: 2, label: '宠物头衔资料' })
      }
      const saved = await savePetTitle(data)
      let autoGrantCount = 0
      if (Array.isArray(saved.autoGrantLevelIds) && saved.autoGrantLevelIds.length > 0) {
        try {
          const where = {
            status: 'active',
            memberLevel: db.command && typeof db.command.in === 'function' ? db.command.in(saved.autoGrantLevelIds) : saved.autoGrantLevelIds
          }
          const allActive = await readAll('users', where, 5000)
          const matchedUsers = allActive.filter((u) => saved.autoGrantLevelIds.includes(u.memberLevel))
          const grants = await grantEligiblePetTitlesForUsers(matchedUsers)
          autoGrantCount = grants.length
        } catch (error) {
          console.warn('[savePetTitle] 预发会员等级头衔异常（客户端可在登录/进入会员中心时自动补发）:', error.message || error)
        }
      }
      await logAdmin(admin, 'pet_title', saved._id, 'savePetTitle', { name: saved.name, autoGrantLevelIds: saved.autoGrantLevelIds, autoGrantCount })
      return { ...saved, autoGrantCount }
    }
    if (action === 'deletePetTitle') {
      const id = safeText(data._id || data.id).trim()
      const deleted = await deletePetTitle(id)
      await logAdmin(admin, 'pet_title', id, 'deletePetTitle', {})
      return deleted
    }
    if (action === 'grantPoints') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const delta = Math.round(Number(data.delta || 0))
      if (!delta) throw new Error('积分变动不能为 0')
      if (delta > 50000 || delta < -50000) throw new Error('单次积分调整幅度不能超过 50000 分')
      const reason = safeText(data.reason).trim() || '管理员操作'
      if (reason.length > 200) throw new Error('操作原因不能超过 200 字')
      if (reason && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '积分变动原因' })
      }
      const targetUser = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!targetUser) throw new Error('目标用户不存在')
      if (delta < 0 && Number(targetUser.points || 0) + delta < 0) {
        throw new Error(`用户当前可用积分不足（当前剩余 ${Number(targetUser.points || 0)} 分），无法扣除 ${Math.abs(delta)} 积分`)
      }
      const clientRequestId = getClientRequestId(data)
      const options = clientRequestId ? { idempotencyKey: clientRequestId } : {}
      const pointResult = await addPoints(targetOpenid, targetUser._id, delta, 'admin_grant', admin._id, reason, options)
      await logAdmin(admin, 'user', targetOpenid, 'grantPoints', { delta, reason, clientRequestId })
      return { openid: targetOpenid, delta, balance: pointResult.balance }
    }

    if (action === 'grantUserAssetCash') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入目标用户的 openid')
      const targetUser = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!targetUser) throw new Error('目标用户不存在')

      const rawAmount = Number(data.amount)
      const amount = Math.round(rawAmount * 100) / 100
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('发放金额必须是大于 0 的数值，最多两位小数')
      if (amount > 100000) throw new Error('单次发放金额不能超过 100,000 元')

      const title = safeText(data.title).trim() || '管理员发放现金到可提现零钱'
      const reason = safeText(data.reason || data.remark).trim() || '系统人工发放'
      const sourceType = safeText(data.sourceType).trim() || 'admin_manual_grant'
      const clientRequestId = safeText(data.clientRequestId).trim()
      const time = now()
      const earningId = clientRequestId
        ? `manual_cash_${targetOpenid}_${clientRequestId}`
        : `manual_cash_${targetOpenid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

      const existing = await db.collection('user_asset_earnings').doc(earningId).get().catch(() => ({ data: null }))
      if (existing && existing.data) {
        return { earningId, amount: existing.data.amount, status: 'available', isDuplicate: true }
      }

      await db.collection('user_asset_earnings').doc(earningId).set({
        data: {
          userOpenid: targetOpenid,
          sourceType,
          sourceId: clientRequestId || earningId,
          title,
          amount,
          status: 'available',
          activityEnabled: true,
          reason,
          grantedBy: admin._id || openid,
          createdAt: time,
          availableAt: time,
          updatedAt: time
        }
      })

      if (typeof logAdmin === 'function') {
        await logAdmin(admin, 'user', targetOpenid, 'grantUserAssetCash', { amount, title, reason, clientRequestId })
      }

      return { openid: targetOpenid, amount, earningId, status: 'available', grantedAt: time }
    }
    if (action === 'listPointLogs') {
      const targetOpenid = safeText(data.openid).trim()
      const where = targetOpenid ? { openid: targetOpenid } : {}
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const countRes = await db.collection('point_logs').where(where).count()
        const total = (countRes && countRes.total) || 0
        const page = Math.max(1, Number(data.page || 1))
        const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
        const offset = (page - 1) * pageSize
        if (offset >= total) {
          return { list: [], total, page, pageSize, hasMore: false }
        }
        const res = await db.collection('point_logs')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = res.data || []
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }
      const allLogs = (await readAll('point_logs', where, 2000))
        .sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      return allLogs
    }
    if (action === 'getCheckinMonthConfig') {
      const monthKey = normalizeMonthKey(data.monthKey)
      const config = await ensureMonthConfig(monthKey)
      return {
        ...config,
        days: defaultCheckinDays(monthKey).map((fallback) => normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === fallback.day) || fallback, fallback.day))
      }
    }
    if (action === 'saveCheckinMonthConfig') {
      const monthKey = normalizeMonthKey(data.monthKey)
      const dayCount = getMonthDays(monthKey)
      const couponIds = Array.from(new Set((Array.isArray(data.days) ? data.days : []).map((item) => safeText(item.couponTemplateId).trim()).filter(Boolean)))
      const couponTemplates = {}
      for (const couponId of couponIds) {
        const templateRes = await db.collection('coupon_templates').doc(couponId).get().catch(() => ({ data: null }))
        const template = templateRes && templateRes.data
        if (!template || template.enabled === false) throw new Error('签到奖励优惠券不可用')
        couponTemplates[couponId] = normalizeCouponSnapshot(template)
      }
      const days = Array.from({ length: dayCount }, (_, index) => {
        const day = index + 1
        const raw = (Array.isArray(data.days) ? data.days : []).find((item) => Number(item.day) === day) || {}
        const reward = normalizeCheckinReward(raw, day)
        if (reward.rewardType === 'coupon') {
          if (!reward.couponTemplateId) throw new Error(`第 ${day} 天未选择优惠券模板`)
          reward.couponSnapshot = couponTemplates[reward.couponTemplateId] || null
        } else {
          reward.couponTemplateId = ''
          reward.couponSnapshot = null
        }
        if (reward.rewardType !== 'points') reward.points = 0
        return reward
      })
      const time = now()
      const payload = { monthKey, days, status: safeText(data.status).trim() || 'active', updatedAt: time }
      const existing = await getMonthConfig(monthKey)
      if (existing) {
        await db.collection('checkin_month_configs').doc(existing._id).update({ data: payload })
        await logAdmin(admin, 'checkin_month_config', existing._id, 'saveCheckinMonthConfig', { monthKey })
        return { _id: existing._id, ...existing, ...payload }
      }
      const created = await db.collection('checkin_month_configs').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'checkin_month_config', created._id, 'saveCheckinMonthConfig', { monthKey })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'issueCouponByLevels') {
      const templateId = safeText(data.templateId).trim()
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!templateId) throw new Error('请选择优惠券模板')
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const templateRes = await db.collection('coupon_templates').doc(templateId).get().catch(() => ({ data: null }))
      const template = templateRes && templateRes.data
      const couponUsersWhere = {
        status: 'active',
        memberLevel: db.command && typeof db.command.in === 'function' ? db.command.in(targetLevelIds) : targetLevelIds
      }
      const allCouponUsers = await readAll('users', couponUsersWhere, 5000)
      const eligible = allCouponUsers.filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      const clientRequestId = getClientRequestId(data)
      const batchKey = clientRequestId || safeText(data.batchKey).trim()
      let issued = 0; let skipped = 0
      const skippedReasons = {}
      for (const targetUser of eligible) {
        try {
          const idempotencyKey = batchKey ? `level_issue_${templateId}_${targetUser._id}_${batchKey}` : ''
          await issueCouponToTargetUser(template, targetUser, {
            adminUserId: admin._id,
            adminOpenid: openid,
            idempotencyKey,
            sourceType: 'admin_level_batch',
            sourceId: batchKey || templateId
          })
          issued++
        } catch (error) {
          skipped++
          const reason = safeText(error.message).trim() || '发放失败'
          skippedReasons[reason] = (skippedReasons[reason] || 0) + 1
        }
      }
      const skippedReasonText = Object.keys(skippedReasons).map((reason) => `${reason}：${skippedReasons[reason]}人`).join('\n')
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponByLevels', { targetLevelIds, targetLevelNamesSnapshot, issued, skipped, skippedReasons, eligibleCount: eligible.length, batchKey })
      return { issued, skipped, targetLevelIds, targetLevelNamesSnapshot, eligibleCount: eligible.length, skippedReasons, skippedReasonText }
    }
    if (action === 'publishRewardMailByLevels') {
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const rewardType = data.rewardType === 'coupon' ? 'coupon' : 'points'
      const title = safeText(data.title).trim() || '会员奖励到账'
      if (title.length > 50) throw new Error('邮件标题不能超过 50 字')
      const content = safeText(data.content).trim()
      if (content.length > 500) throw new Error('邮件内容不能超过 500 字')
      const mailTextToCheck = [title, content].filter(Boolean).join(' ')
      if (mailTextToCheck && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, mailTextToCheck, { scene: 2, label: '会员奖励邮件内容' })
      }
      const reward = { type: rewardType }
      if (rewardType === 'coupon') {
        const couponTemplateId = safeText(data.couponTemplateId).trim()
        if (!couponTemplateId) throw new Error('请选择奖励优惠券')
        const templateRes = await db.collection('coupon_templates').doc(couponTemplateId).get().catch(() => ({ data: null }))
        const template = templateRes && templateRes.data
        if (!template || template.enabled === false) throw new Error('奖励优惠券不可用')
        reward.couponTemplateId = couponTemplateId
        reward.couponSnapshot = normalizeCouponSnapshot(template)
      } else {
        reward.points = Math.max(Math.round(Number(data.points || 0)), 0)
        if (!reward.points) throw new Error('奖励积分必须大于 0')
        if (reward.points > 50000) throw new Error('单次奖励积分不能超过 50000')
      }
      const mailUsersWhere = {
        status: 'active',
        memberLevel: db.command && typeof db.command.in === 'function' ? db.command.in(targetLevelIds) : targetLevelIds
      }
      const allMailUsers = await readAll('users', mailUsersWhere, 5000)
      const eligible = allMailUsers.filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      const time = now()
      let issued = 0
      for (const targetUser of eligible) {
        await db.collection('reward_mails').add({
          data: {
            userId: targetUser._id,
            openid: targetUser.openid,
            targetLevelIds,
            targetLevelNamesSnapshot,
            title,
            content,
            reward,
            sentByAdminUserId: admin._id,
            sentByAdminOpenid: openid,
            readAt: null,
            claimedAt: null,
            rewardClaimResult: {},
            createdAt: time,
            updatedAt: time
          }
        })
        issued++
      }
      await logAdmin(admin, 'reward_mail', title, 'publishRewardMailByLevels', { targetLevelIds, targetLevelNamesSnapshot, rewardType, issued })
      return { issued, skipped: 0, targetLevelIds, targetLevelNamesSnapshot }
    }
    if (action === 'publishRetroCardMail') {
      const count = Math.max(Math.round(Number(data.count || 0)), 0)
      if (!count) throw new Error('补签卡数量必须大于 0')
      if (count > 100) throw new Error('单次群发补签卡数量不能超过 100 张')
      const target = await resolveRewardMailTargets(data)
      if (!target.users.length) throw new Error('没有符合条件的用户')
      const title = safeText(data.title).trim() || '补签卡奖励到账'
      if (title.length > 50) throw new Error('邮件标题不能超过 50 字')
      const content = safeText(data.content).trim() || `你获得 ${count} 张补签卡，请及时领取。`
      if (content.length > 500) throw new Error('邮件内容不能超过 500 字')
      const mailTextToCheck = [title, content].filter(Boolean).join(' ')
      if (mailTextToCheck && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, mailTextToCheck, { scene: 2, label: '补签卡邮件内容' })
      }
      const reward = { type: 'retro_card', count }
      const time = now()
      let issued = 0
      for (const targetUser of target.users) {
        await db.collection('reward_mails').add({
          data: {
            userId: targetUser._id,
            openid: targetUser.openid,
            targetType: target.targetType,
            targetOpenids: target.openids || [],
            targetRole: target.role || '',
            targetLevelIds: target.targetLevelIds || [],
            targetLevelNamesSnapshot: target.targetLevelNamesSnapshot || [],
            title,
            content,
            reward,
            sentByAdminUserId: admin._id,
            sentByAdminOpenid: openid,
            readAt: null,
            claimedAt: null,
            rewardClaimResult: {},
            createdAt: time,
            updatedAt: time
          }
        })
        issued++
      }
      await logAdmin(admin, 'reward_mail', title, 'publishRetroCardMail', { targetType: target.targetType, openids: target.openids || [], role: target.role || '', targetLevelIds: target.targetLevelIds || [], targetLevelNamesSnapshot: target.targetLevelNamesSnapshot || [], count, issued })
      return { issued, eligibleCount: target.users.length, targetType: target.targetType, count }
    }
    if (action === 'publishPetTitleMail') {
      const titleId = safeText(data.titleId).trim()
      const petTitle = await getPetTitle(titleId, { includeDeleted: true })
      if (petTitle.deletedAt || petTitle.enabled === false) throw new Error('宠物头衔已停用，不能发放')
      const target = await resolveRewardMailTargets(data)
      if (!target.users.length) throw new Error('没有符合条件的用户')
      const rewardSnapshot = titleSnapshot(petTitle)
      const title = safeText(data.title).trim() || `宠物头衔【${petTitle.name}】到账提醒`
      if (title.length > 50) throw new Error('邮件标题不能超过 50 字')
      const content = safeText(data.content).trim() || `平台已向你发放宠物头衔【${petTitle.name}】，请前往奖励邮箱领取。`
      if (content.length > 500) throw new Error('邮件内容不能超过 500 字')
      const mailTextToCheck = [title, content].filter(Boolean).join(' ')
      if (mailTextToCheck && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, mailTextToCheck, { scene: 2, label: '宠物头衔邮件内容' })
      }
      const reward = { type: 'pet_title', titleId: petTitle._id, titleSnapshot: rewardSnapshot, duplicatePoints: rewardSnapshot.duplicatePoints }
      const time = now()
      let issued = 0
      for (const targetUser of target.users) {
        await db.collection('reward_mails').add({
          data: {
            userId: targetUser._id,
            openid: targetUser.openid,
            targetType: target.targetType,
            targetOpenids: target.openids || [],
            targetRole: target.role || '',
            targetLevelIds: target.targetLevelIds || [],
            targetLevelNamesSnapshot: target.targetLevelNamesSnapshot || [],
            title,
            content,
            reward,
            sentByAdminUserId: admin._id,
            sentByAdminOpenid: openid,
            readAt: null,
            claimedAt: null,
            rewardClaimResult: {},
            createdAt: time,
            updatedAt: time
          }
        })
        issued++
      }
      await logAdmin(admin, 'reward_mail', titleId, 'publishPetTitleMail', { targetType: target.targetType, issued, titleName: petTitle.name })
      return { issued, eligibleCount: target.users.length, targetType: target.targetType, titleId }
    }
    if (action === 'saveLotteryActivity') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('活动名称不能为空')
      const prizes = []
      if (Array.isArray(data.prizes)) {
        for (const p of data.prizes) {
          const type = ['text', 'points', 'coupon', 'pet_title'].includes(p.type)
            ? p.type
            : (p.titleId ? 'pet_title' : (p.templateId ? 'coupon' : (Number(p.points) > 0 ? 'points' : 'text')))
          const points = type === 'points' ? Math.max(Math.round(Number(p.points || 0)), 0) : 0
          const templateId = type === 'coupon' ? safeText(p.templateId).trim() : ''
          const titleId = type === 'pet_title' ? safeText(p.titleId).trim() : ''
          let text = type === 'text' ? safeText(p.text).trim() : ''
          let petTitle = null
          if (type === 'pet_title') {
            petTitle = await getPetTitle(titleId, { includeDeleted: true })
            if (petTitle.deletedAt || petTitle.enabled === false) throw new Error('请选择有效的宠物头衔奖品')
          }
          let prizeName = safeText(p.name).trim()
          if (type === 'text') {
            const resolved = resolvePetBlessing({ name: prizeName, text, breed: p.breed })
            prizeName = prizeName || resolved.name
            text = resolved.text
          } else if (!prizeName) {
            if (type === 'points') prizeName = `${points} 积分`
            else if (type === 'pet_title') prizeName = `宠物头衔：${petTitle.name}`
            else prizeName = '优惠券'
          }
          if (!prizeName) continue
          prizes.push({
            id: safeText(p.id || p._id || '').trim() || `prize_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type,
            name: prizeName,
            text,
            points,
            templateId,
            couponName: safeText(p.couponName || '').trim(),
            titleId,
            titleName: petTitle ? petTitle.name : safeText(p.titleName || '').trim(),
            titleSnapshot: petTitle ? titleSnapshot(petTitle) : (p.titleSnapshot || null),
            probability: Math.max(Number(p.probability || 0), 0),
            stockLeft: Math.max(Math.round(Number(p.stockLeft || 0)), 0)
          })
        }
      }
      const prizeTexts = prizes.map((p) => [p.name, p.text].filter(Boolean).join(' ')).filter(Boolean)
      const activityText = [name, data.description, ...prizeTexts].filter(Boolean).join(' ')
      if (activityText && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, activityText, { scene: 2, label: '抽奖活动资料' })
      }
      const time = now()
      const payload = { name, description: safeText(data.description).trim(), prizes, enabled: data.enabled === true, updatedAt: time }
      if (data._id) {
        await db.collection('lottery_activities').doc(data._id).update({ data: payload })
        await logAdmin(admin, 'lottery_activity', data._id, 'saveLotteryActivity', { name })
        return { _id: data._id, ...payload }
      }
      const created = await db.collection('lottery_activities').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'lottery_activity', created._id, 'saveLotteryActivity', { name })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'listLotteryActivities') {
      const res = await db.collection('lottery_activities').orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'toggleLotteryActivity') {
      const activityId = safeText(data._id || data.id).trim()
      if (!activityId) throw new Error('缺少活动ID')
      const activityRes = await db.collection('lottery_activities').doc(activityId).get().catch(() => ({ data: null }))
      if (!activityRes || !activityRes.data) throw new Error('抽奖活动不存在')
      const enabled = !activityRes.data.enabled
      await db.collection('lottery_activities').doc(activityId).update({ data: { enabled, updatedAt: now() } })
      await logAdmin(admin, 'lottery_activity', activityId, 'toggleLotteryActivity', { enabled })
      return { _id: activityId, enabled }
    }
    if (action === 'deleteLotteryActivity') {
      const activityId = safeText(data._id || data.id).trim()
      if (!activityId) throw new Error('缺少活动ID')
      const activityRes = await db.collection('lottery_activities').doc(activityId).get().catch(() => ({ data: null }))
      const activity = activityRes && activityRes.data
      if (!activity) throw new Error('抽奖活动不存在或已被删除')

      await db.collection('lottery_activities').doc(activityId).remove()
      await logAdmin(admin, 'lottery_activity', activityId, 'deleteLotteryActivity', { name: activity.name })
      return { _id: activityId, success: true }
    }
    if (action === 'listStaffDeposits') {
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const staffOpenid = safeText(data.staffOpenid).trim()
      const baseWhere = { ...(status ? { status } : {}), ...(staffOpenid ? { staffOpenid } : {}) }
      const pagedDeposits = staffOpenid
        ? await readScopedDocuments('staff_deposits', baseWhere, 'createdAt', 'desc')
        : await queryFinanceListSafely('staff_deposits', {
          baseWhere, dateRange: range, dateFields: ['createdAt', 'paidAt'],
          pageSize: data.pageSize || 50, page: data.page || 1,
          keyword,
          searchContext
        })

      const targetOpenids = Array.from(new Set(pagedDeposits.map((item) => item.staffOpenid).filter(Boolean)))
      const [users, profiles, allEvidences] = await Promise.all([
        fetchUsersByOpenids(targetOpenids),
        fetchStaffProfilesByOpenids(targetOpenids),
        fetchStaffEvidencesByOpenids(targetOpenids)
      ])

      const evidenceByStaff = {}
      for (const ev of allEvidences) {
        if (!evidenceByStaff[ev.staffOpenid]) evidenceByStaff[ev.staffOpenid] = []
        evidenceByStaff[ev.staffOpenid].push(ev)
      }
      const userMap = users.reduce((m, u) => ({ ...m, [u.openid]: u }), {})
      const profileMap = profiles.reduce((m, p) => ({ ...m, [p.openid]: p }), {})
      const list = pagedDeposits.map((item) => {
        const u = userMap[item.staffOpenid] || {}
        const p = profileMap[item.staffOpenid] || {}
        const phoneFields = staffPhoneFields(u, p)
        const staffEvidences = evidenceByStaff[item.staffOpenid] || []
        const problemOrders = staffEvidences.map((e) => {
          const actualDeductAmount = Number(e.actualDeductAmount ?? e.forfeitedAmount ?? 0)
          const s = e.status || 'pending'
          return {
            _id: e._id,
            orderId: e.orderId,
            orderNo: e.orderNo || '',
            serviceSummary: e.serviceSummary || '',
            reasonType: e.reasonType || '',
            reasonTypeName: e.reasonTypeName || '',
            reasonText: e.reasonText || '',
            deductAmount: Number(e.deductAmount || 0),
            actualDeductAmount,
            actualDeductAmountText: actualDeductAmount > 0 ? actualDeductAmount.toFixed(2) : '',
            status: s,
            statusText: s === 'forfeited' ? '已根据建议扣除保证金' : (s === 'dismissed' ? '已撤销免除' : '待执行扣除'),
            createdAt: e.createdAt || '',
            staffOpenid: e.staffOpenid || item.staffOpenid
          }
        })
        return {
          ...item,
          staffNickname: u.nickname || '',
          staffPhone: phoneFields.phone,
          accountPhone: phoneFields.accountPhone,
          certifiedPhone: phoneFields.certifiedPhone,
          staffRealName: p.realName || '',
          staffLevel: p.staffLevel || '',
          problemOrders
        }
      })
      return list.filter((d) => !keyword || matchFinanceRecord(d, keyword, searchContext))
    }
    if (action === 'shipStaffSupplies') {
      const id = safeText(data.id).trim()
      const expressCompany = safeText(data.expressCompany).trim()
      const trackingNo = safeText(data.trackingNo).trim()
      if (!id || !expressCompany || !trackingNo || expressCompany.length > 40 || trackingNo.length > 80 || !/^[a-zA-Z0-9-]+$/.test(trackingNo)) throw new Error('请填写有效的快递公司和快递单号')
      return shipStaffSupplies({ ...admin, openid }, id, expressCompany, trackingNo)
    }
    if (action === 'requestStaffDepositRefund') {
      const id = safeText(data.id).trim()
      const reason = safeText(data.reason).trim()
      if (!id || !reason || reason.length > 200) throw new Error('请选择保证金记录并填写退还原因（最多200字）')
      if (typeof checkTextSecurity === 'function') await checkTextSecurity(openid, reason, { scene: 2, label: '管理员退还保证金原因' })
      const deposit = (await db.collection('staff_deposits').doc(id).get()).data
      if (!deposit) throw new Error('保证金记录不存在')
      await context.prepareStaffDepositRefund(deposit.staffOpenid, id)
      return context.requestStaffDepositRefund(deposit.staffOpenid, id, reason, { ...admin, openid })
    }
    if (action === 'auditDepositRefund') {
      const reason = safeText(data.reason || data.auditRemark).trim()
      if (reason.length > 200) throw new Error('审核说明不能超过 200 字')
      if (reason && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '保证金退款审核说明' })
      }
      const result = await settleStaffDeposit({ ...admin, openid }, action, { ...data, reason })
      if (data.approved === true) {
        // Preserve explicit mock checkout completion for isolated test environments,
        // after the same supply-fee audit as real refunds.
        if (data.autoRefund === true) {
          const payments = (await db.collection('payments').where({ orderId: result.id, targetType: 'staff_deposit' }).limit(2).get()).data
          if (payments.length === 1 && payments[0].channel === 'mock') return context.autoRefundStaffDeposit({ ...admin, openid }, result.id, reason)
        }
        return context.syncStaffDepositRefund(result.id)
      }
      return result
    }
    if (action === 'syncDepositRefund') {
      return context.syncStaffDepositRefund(safeText(data.id).trim())
    }
    if (action === 'autoRefundStaffDeposit') {
      let id = safeText(data.id || data.depositId).trim()
      const staffOpenid = safeText(data.staffOpenid).trim()
      if (!id && staffOpenid) {
        const dRes = await db.collection('staff_deposits').where({ staffOpenid }).orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
        const deposits = (dRes && dRes.data) || []
        const target = deposits.find((d) => Number(d.availableRefundAmount || 0) > 0 && ['paid', 'partially_refunded', 'refund_requested', 'refund_approved'].includes(d.status)) || deposits[0]
        if (target) id = target._id
      }
      const reason = safeText(data.reason || '管理员退还宠托师保证金').trim()
      if (!id) throw new Error('请选择需要退还的保证金记录')
      if (reason.length > 200) throw new Error('退还原因不能超过 200 字')
      if (typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '管理员自动退还保证金原因' })
      }
      if (typeof context.autoRefundStaffDeposit !== 'function') {
        throw new Error('系统尚未装配自动退款服务')
      }
      return context.autoRefundStaffDeposit({ ...admin, openid }, id, reason)
    }
    if (action === 'confirmDepositRefund') {
      const proof = safeText(data.paymentReference).trim()
      if (proof.length > 100) throw new Error('付款凭证号不能超过 100 字')
      return settleStaffDeposit({ ...admin, openid }, action, data)
    }
    if (action === 'forfeitStaffDeposit') {
      const reason = safeText(data.reason || data.auditRemark).trim()
      if (reason.length > 200) throw new Error('没收原因不能超过 200 字')
      if (reason && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '保证金没收原因' })
      }
      const evidenceImages = Array.isArray(data.evidenceImages) ? data.evidenceImages.filter(Boolean) : []
      if (evidenceImages.length && typeof checkImageSecurity === 'function') {
        for (const img of evidenceImages) {
          await checkImageSecurity(openid, img, { scene: 1, label: '保证金没收凭证' })
        }
      }
      return settleStaffDeposit({ ...admin, openid }, action, { ...data, reason, evidenceImages })
    }
    if (action === 'listSupplyReimbursements') {
      const keyword = safeText(data.keyword || data.orderId || data.phone).trim()
      const searchContext = keyword ? await searchRelatedOpenidsAndOrderIds(keyword) : null
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const baseWhere = status ? { status } : {}
      const pagedReimbursements = await queryFinanceListSafely('staff_supply_reimbursements', {
        baseWhere,
        dateRange: range,
        dateFields: ['createdAt', 'paidAt'],
        pageSize: data.pageSize || 50,
        page: data.page || 1,
        keyword,
        searchContext
      })

      const targetOpenids = Array.from(new Set(pagedReimbursements.map((item) => item.staffOpenid).filter(Boolean)))
      const [users, profiles] = await Promise.all([
        fetchUsersByOpenids(targetOpenids),
        fetchStaffProfilesByOpenids(targetOpenids)
      ])

      const userMap = users.reduce((m, u) => ({ ...m, [u.openid]: u }), {})
      const profileMap = profiles.reduce((m, p) => ({ ...m, [p.openid]: p }), {})
      const list = pagedReimbursements.map((item) => {
        const u = userMap[item.staffOpenid] || {}
        const p = profileMap[item.staffOpenid] || {}
        const phoneFields = staffPhoneFields(u, p)
        return {
          ...item,
          staffNickname: u.nickname || '',
          staffPhone: phoneFields.phone,
          accountPhone: phoneFields.accountPhone,
          certifiedPhone: phoneFields.certifiedPhone,
          staffRealName: p.realName || '',
          staffLevel: p.staffLevel || ''
        }
      })
      return list.filter((s) => !keyword || matchFinanceRecord(s, keyword, searchContext))
    }
    if (action === 'auditSupplyReimbursement') {
      const reason = safeText(data.rejectReason || data.reason || data.auditRemark).trim()
      if (reason.length > 200) throw new Error('审核说明不能超过 200 字')
      if (reason && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '报销审核说明' })
      }
      return settleSupplyReimbursement({ ...admin, openid }, action, { ...data, rejectReason: reason, auditRemark: reason })
    }
    if (action === 'paySupplyReimbursement') {
      const proof = safeText(data.paymentReference).trim()
      if (proof.length > 100) throw new Error('付款凭证号不能超过 100 字')
      return settleSupplyReimbursement({ ...admin, openid }, action, data)
    }
    if (action === 'republishOrderAsUrgent') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order) throw new Error('订单不存在')

      if (!['paid', 'assigned', 'on_the_way', 'day_completed'].includes(order.status)) {
        throw new Error(`当前订单状态（${order.status}）不可转为加急公共抢单，宠托师可能已开始服务或订单状态已变更，请刷新确认`)
      }
      if (order.groupBuyId || order.source === 'community_groupbuy') {
        throw new Error('拼单需要整团调整，不能通过单笔订单加急改派拆开同团服务')
      }
      if (order.status === 'day_completed' || Number(order.lastCompletedSessionIndex || 0) > 0 ||
          (order.serviceSessions || []).some(session => ['completed', 'in_service', 'cancelled'].includes(session.status))) {
        throw new Error('订单存在已履约或取消的服务场次，不可整单重新发布加急')
      }
      const originalSessions = Array.isArray(order.serviceSessions) && order.serviceSessions.length
        ? order.serviceSessions : [{index:1,startTime:order.startTime,endTime:order.endTime,status:'pending'}]
      const originalFirstSession = originalSessions[0]

      const checkinRes = await db.collection('checkin_logs').where({ orderId }).get().catch(() => ({ data: [] }))
      const staffCheckins = (checkinRes.data || []).filter((item) => isActiveCheckin(item) && item.source !== 'admin' && item.eventType !== 'admin_supplement' && (!order.staffOpenid || item.staffOpenid === order.staffOpenid))
      if (staffCheckins.length > 0) {
        throw new Error('原宠托师已到场开始打卡履约，不可转为加急公共抢单，请刷新核实')
      }
      const earningRes = await db.collection('staff_earnings').where({ orderId }).limit(1).get().catch(() => ({ data: [] }))
      if ((earningRes.data || []).length > 0) {
        throw new Error('订单已经生成宠托师收益，不可重新指派')
      }

      const staffReward = Number(data.staffReward)
      if (!Number.isFinite(staffReward) || staffReward <= 0) {
        throw new Error('请设置有效的宠托师加急收益金额')
      }

      const newStartTime = safeText(data.startTime).trim() || originalFirstSession.startTime
      let newEndTime = safeText(data.endTime).trim()
      const urgentRemark = safeText(data.urgentRemark || data.remark || data.notes).trim()

      if (!newStartTime) {
        throw new Error('请设置加急服务开始时间')
      }
      const startTs = toTimeValue(newStartTime)
      if (!startTs) {
        throw new Error('加急服务开始时间格式不正确')
      }

      const time = now()
      const currentTs = (time instanceof Date ? time.getTime() : new Date(time || 0).getTime()) || Date.now()
      if (startTs < currentTs) {
        throw new Error('加急服务开始时间不能早于当前时间')
      }
      // 至少是现在时间的30分钟后（预留1分钟网络传输宽限）
      if (startTs < currentTs + 30 * 60 * 1000 - 60000) {
        throw new Error('加急服务开始时间至少需在当前时间的30分钟后')
      }

      if (newEndTime) {
        const endTs = toTimeValue(newEndTime)
        if (!endTs) throw new Error('加急服务结束时间格式不正确')
        if (endTs <= startTs) {
          throw new Error('加急服务结束时间必须晚于开始时间')
        }
      } else {
        const origDurationMs = (toTimeValue(originalFirstSession.endTime) - toTimeValue(originalFirstSession.startTime)) || (Number(order.durationMinutes || 60) * 60000)
        const durationMs = origDurationMs > 0 ? origDurationMs : 3600000
        newEndTime = context.formatDateTimeParts(new Date(startTs + durationMs))
      }
      const serviceSessions = originalSessions.map((session,index) => index === 0
        ? {...session,date:beijingDateText(newStartTime),startTime:newStartTime,endTime:newEndTime,status:'pending'} : session)
      for (let index=1; index<serviceSessions.length; index+=1) {
        if (toTimeValue(serviceSessions[index-1].endTime) > toTimeValue(serviceSessions[index].startTime)) {
          throw new Error('加急服务时间不能与后续服务场次重叠或打乱场次顺序')
        }
      }
      const finalSession = serviceSessions[serviceSessions.length-1]
      // Admin rescheduling keeps the original charge for every visit.
      const sessionPricing = getOrderSessionPricing(order,originalSessions).map((row,index) => ({
        ...row,date:beijingDateText(serviceSessions[index].startTime),startTime:serviceSessions[index].startTime
      }))

      const prevStaffOpenid = order.staffOpenid || ''
      const prevStaffName = order.staffName || (order.staffContact && order.staffContact.displayName) || ''
      const prevStaffUserId = order.staffUserId || ''
      const prevStaffProfileId = order.staffProfileId || ''
      const prevStaffPhone = (order.staffContact && order.staffContact.phone) || ''

      const previousRecord = prevStaffOpenid ? {
        staffOpenid: prevStaffOpenid,
        staffName: prevStaffName,
        staffUserId: prevStaffUserId,
        staffProfileId: prevStaffProfileId,
        staffPhone: prevStaffPhone,
        assignedAt: order.assignedAt || '',
        reassignedAt: time,
        reason: 'admin_urgent_republish',
        urgentRemark: urgentRemark || '订单超时未按时履约，转加急公共抢单'
      } : null

      const previousStaffRecords = [
        ...(Array.isArray(order.previousStaffRecords) ? order.previousStaffRecords : []),
        ...(previousRecord ? [previousRecord] : [])
      ]

      const standardEarning = await calculateStaffEarningForOrder({ ...order, isUrgent: false })
      const originalReward = standardEarning.earningAmount || 0
      const urgentBonus = Math.max(0, Math.round((staffReward - originalReward) * 100) / 100)

      const updateData = {
        status: 'paid',
        publishMode: 'open',
        assignmentSource: 'admin_urgent_republish',
        isUrgent: true,
        urgentStaffReward: staffReward,
        urgentBonus,
        urgentRemark,
        urgentRepublishedAt: time,
        urgentRepublishedByOpenid: openid,
        urgentRepublishCount: (Number(order.urgentRepublishCount) || (order.isUrgent ? 1 : 0)) + 1,
        originalStaffOpenid: order.originalStaffOpenid || prevStaffOpenid,
        originalStaffName: order.originalStaffName || prevStaffName,
        originalStaffUserId: order.originalStaffUserId || prevStaffUserId,
        originalStaffProfileId: order.originalStaffProfileId || prevStaffProfileId,
        originalStaffPhone: order.originalStaffPhone || prevStaffPhone,
        hasReassignedStaff: Boolean(order.originalStaffOpenid || prevStaffOpenid),
        previousStaffRecords,
        staffUserId: '',
        staffOpenid: '',
        staffProfileId: '',
        staffName: '',
        requestedStaffOpenid: '',
        requestedStaffProfileId: '',
        requestedStaffName: '',
        acceptLocationLatitude: null,
        acceptLocationLongitude: null,
        travelDeparted: false,
        travelDepartedAt: null,
        travelLocation: null,
        travelEtaMinutes: 0,
        radarProximityNotified: false,
        startTime: newStartTime,
        endTime: finalSession.endTime,
        serviceStartDate: beijingDateText(newStartTime),
        serviceEndDate: beijingDateText(finalSession.startTime),
        serviceSessions,
        priceSnapshot: {...order.priceSnapshot,sessionPricing},
        isStartOverdue: false,
        isFinishOverdue: false,
        staffOverdueStartRemindedSessions: [],
        clientOverdueStartAlertedSessions: [],
        overdueFinishReminded: false,
        updatedAt: time
      }
      if (urgentRemark) {
        updateData.notes = order.notes ? `${order.notes}；【平台加急备注】${urgentRemark}` : `【平台加急备注】${urgentRemark}`
      }

      let createdEvidenceId = null
      let evidenceDoc = null
      if (prevStaffOpenid && (data.recordDepositEvidence === true || data.autoRecordDepositEvidence === true)) {
        const profileRes = await db.collection('staff_profiles').where({ openid: prevStaffOpenid }).limit(1).get().catch(() => ({ data: [] }))
        const p = profileRes.data && profileRes.data[0]
        evidenceDoc = {
          orderId,
          orderNo: order.orderNo || '',
          clientOpenid: order.clientOpenid || '',
          serviceSummary: order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养'),
          serviceType: order.serviceType || 'walk',
          startTime: order.startTime || '',
          staffOpenid: prevStaffOpenid,
          staffUserId: prevStaffUserId || (p && p.userId) || '',
          staffProfileId: prevStaffProfileId || (p && p._id) || '',
          staffRealName: prevStaffName || (p && p.realName) || '',
          staffPhone: prevStaffPhone || (p && p.phone) || '',
          reasonType: 'start_overdue',
          reasonTypeName: '接单超时未开始/爽约',
          reasonText: urgentRemark || '订单严重超时未到岗且无法继续履约，平台已介入并转加急调度',
          deductAmount: Number(data.deductAmount || 0),
          evidenceImages: Array.isArray(data.evidenceImages) ? data.evidenceImages : [],
          status: 'pending',
          statusText: '待扣除保证金',
          createdAt: time,
          createdBy: openid,
          updatedAt: time
        }
      }

      if (typeof db.runTransaction === 'function') {
        await db.runTransaction(async (tx) => {
          const currentOrder = (await tx.collection('orders').doc(orderId).get()).data
          const terms = row => JSON.stringify([row.staffOpenid,row.serviceSessions,row.startTime,row.endTime,
            row.payAmount,row.priceSnapshot,row.groupBuyId,row.groupBuyStatus,row.lastCompletedSessionIndex])
          if (!currentOrder || currentOrder.status !== order.status || terms(currentOrder) !== terms(order)) {
            throw new Error('订单状态已被并发更新或已被宠托师抢先开始，转加急单失败，请刷新确认最新状态')
          }
          if (evidenceDoc) {
            const createdEvidence = await tx.collection('staff_deposit_evidences').add({ data: evidenceDoc })
            createdEvidenceId = createdEvidence._id
            updateData.hasDepositPenaltyEvidence = true
            updateData.depositPenaltyEvidenceIds = [...(Array.isArray(currentOrder.depositPenaltyEvidenceIds) ? currentOrder.depositPenaltyEvidenceIds : []), createdEvidenceId]
          }
          await tx.collection('orders').doc(orderId).update({ data: updateData })
        })
      } else {
        try {
          if (evidenceDoc) {
            const createdEvidence = await db.collection('staff_deposit_evidences').add({ data: evidenceDoc })
            createdEvidenceId = createdEvidence._id
            updateData.hasDepositPenaltyEvidence = true
            updateData.depositPenaltyEvidenceIds = [...(Array.isArray(order.depositPenaltyEvidenceIds) ? order.depositPenaltyEvidenceIds : []), createdEvidenceId]
          }
          const updateRes = await db.collection('orders').where({ _id: orderId, status: order.status }).update({ data: updateData })
          if (!updateRes || !updateRes.stats || updateRes.stats.updated === 0) {
            throw new Error('订单状态已被并发更新或已被宠托师抢先开始，转加急单失败，请刷新确认最新状态')
          }
        } catch (err) {
          if (createdEvidenceId) {
            await db.collection('staff_deposit_evidences').doc(createdEvidenceId).remove().catch(() => {})
          }
          throw err
        }
      }

      if (prevStaffOpenid) {
        await appendOrderStaffMessage({ ...order, staffOpenid: prevStaffOpenid }, {
          eventType: 'order_cancelled_by_admin',
          title: '订单已被平台转加急调度',
          detail: `您的订单（${order.serviceSummary || order.orderNo}）由于超时未按时开始服务，平台管理员已介入处理并将该单转为加急公共抢单调度。`,
          actorRole: 'admin',
          idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'admin_urgent_cancel', String(time.getTime()))
        })
      }

      const isReUrgent = Boolean(order.isUrgent || order.assignmentSource === 'admin_urgent_republish')
      await appendOrderTimeline(
        orderId,
        'urgent_republished',
        isReUrgent ? '已重新发布加急抢单' : '已转为加急公共单',
        `管理员已将订单发布至加急公共抢单池。宠托师收益调整为 ¥${staffReward.toFixed(2)}（含平台补贴加价 ¥${urgentBonus.toFixed(2)}），新服务时间：${newStartTime}。用户支付金额不受影响。`,
        'admin'
      )

      await appendOrderClientMessage({ ...order, _id: orderId }, {
        eventType: 'urgent_republished',
        title: isReUrgent ? '加急订单重新调度中' : '平台加急调度中',
        detail: `您的订单约定服务时间已调整为 ${newStartTime}，平台正在加急调度更合适的宠托师上门服务，请耐心等待。`,
        actorRole: 'admin'
      })

      await logAdmin(admin, 'order', orderId, 'republishOrderAsUrgent', {
        prevStaffOpenid,
        staffReward,
        urgentBonus,
        newStartTime,
        newEndTime,
        urgentRemark,
        isReUrgent
      })

      if (typeof notifyAdmins === 'function') {
        await notifyAdmins({
          type: 'order_urgent_republished',
          level: 'info',
          title: isReUrgent
            ? `【加急单重新发布】订单 ${order.orderNo || orderId} 已重新发布到加急抢单池`
            : `【加急单发布】订单 ${order.orderNo || orderId} 已发布到加急抢单池`,
          content: `管理员已将订单${isReUrgent ? '重新发布' : '转'}为加急公共抢单。宠托师收益：¥${staffReward.toFixed(2)}（加价补贴 ¥${urgentBonus.toFixed(2)}），约定开始时间调整为 ${newStartTime}。`,
          orderId,
          orderNo: order.orderNo || '',
          actionUrl: `/pages/admin/orders/detail/index?id=${orderId}`
        })
      }

      try {
        const freshOrder = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
        if (freshOrder && typeof context.notifyEligibleSittersForPublicOrder === 'function') {
          await context.notifyEligibleSittersForPublicOrder(freshOrder)
        }
      } catch (grabErr) {
        console.error('[admin-urgent-republish-grab-notification]', { orderId, message: grabErr.message })
      }

      return {
        orderId,
        isUrgent: true,
        status: 'paid',
        staffReward,
        urgentBonus,
        startTime: newStartTime,
        endTime: newEndTime
      }
    }
    if (action === 'addOrderDepositPenaltyEvidence') {
      const orderId = safeText(data.orderId || data.id).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order) throw new Error('订单不存在')

      let targetStaffOpenid = safeText(data.staffOpenid).trim()
      if (!targetStaffOpenid) {
        targetStaffOpenid = order.originalStaffOpenid || order.staffOpenid || (Array.isArray(order.previousStaffRecords) && order.previousStaffRecords[0] && order.previousStaffRecords[0].staffOpenid) || ''
      }
      if (!targetStaffOpenid) throw new Error('该订单未关联有效的宠托师，无法录入证据')

      const profileRes = await db.collection('staff_profiles').where({ openid: targetStaffOpenid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = profileRes.data && profileRes.data[0] || {}
      const userRes = await db.collection('users').where({ openid: targetStaffOpenid }).limit(1).get().catch(() => ({ data: [] }))
      const user = userRes.data && userRes.data[0] || {}

      const reasonType = safeText(data.reasonType).trim() || 'start_overdue'
      const reasonTypeNames = {
        start_overdue: '接单超时未开始/爽约',
        checkin_missing: '超期未完成打卡',
        service_violation: '服务质量违规/客诉',
        private_order: '引导私下交易/私单',
        pet_safety: '宠物安全与失职问题',
        other: '其他服务违规'
      }
      const reasonTypeName = reasonTypeNames[reasonType] || '服务违规留证'
      const reasonText = safeText(data.reasonText || data.reason || data.remark).trim()
      if (!reasonText) throw new Error('请填写违规说明与留证原因')

      const deductAmount = Math.max(0, Number(data.deductAmount || 0))
      const evidenceImages = Array.isArray(data.evidenceImages) ? data.evidenceImages : []

      const time = now()
      const evidenceDoc = {
        orderId,
        orderNo: order.orderNo || '',
        clientOpenid: order.clientOpenid || '',
        serviceSummary: order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养'),
        serviceType: order.serviceType || 'walk',
        startTime: order.startTime || '',
        staffOpenid: targetStaffOpenid,
        staffUserId: user._id || profile.userId || order.originalStaffUserId || '',
        staffProfileId: profile._id || order.originalStaffProfileId || '',
        staffRealName: profile.realName || user.realName || order.originalStaffName || order.staffName || '',
        staffNickname: user.nickname || '',
        staffPhone: profile.phone || user.phone || order.originalStaffPhone || '',
        reasonType,
        reasonTypeName,
        reasonText,
        deductAmount,
        evidenceImages,
        status: 'pending',
        statusText: '待扣除保证金',
        createdAt: time,
        createdBy: openid,
        updatedAt: time
      }

      const created = await db.collection('staff_deposit_evidences').add({ data: evidenceDoc })
      const evidenceId = created._id

      const existingEvidenceIds = Array.isArray(order.depositPenaltyEvidenceIds) ? order.depositPenaltyEvidenceIds : []
      await db.collection('orders').doc(orderId).update({
        data: {
          hasDepositPenaltyEvidence: true,
          depositPenaltyEvidenceIds: [...existingEvidenceIds, evidenceId],
          updatedAt: time
        }
      })

      await appendOrderTimeline(
        orderId,
        'deposit_evidence_added',
        '已录入保证金扣除留证',
        `管理员已将该订单纳入宠托师（${evidenceDoc.staffRealName || targetStaffOpenid}）保证金扣除证据。原因：${reasonTypeName} - ${reasonText}。建议扣除金额：¥${deductAmount.toFixed(2)}。`,
        'admin'
      )

      await logAdmin(admin, 'order', orderId, 'addOrderDepositPenaltyEvidence', {
        evidenceId,
        targetStaffOpenid,
        reasonType,
        reasonText,
        deductAmount
      })

      return {
        evidenceId,
        ...evidenceDoc,
        _id: evidenceId
      }
    }
    if (action === 'listOrderDepositPenaltyEvidences') {
      const orderId = safeText(data.orderId).trim()
      const staffOpenid = safeText(data.staffOpenid).trim()
      const status = safeText(data.status).trim()
      const where = {}
      if (orderId) where.orderId = orderId
      if (staffOpenid) where.staffOpenid = staffOpenid
      if (status) where.status = status
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const countRes = await db.collection('staff_deposit_evidences').where(where).count()
        const total = (countRes && countRes.total) || 0
        const page = Math.max(1, Number(data.page || 1))
        const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
        const offset = (page - 1) * pageSize
        if (offset >= total) {
          return { list: [], total, page, pageSize, hasMore: false }
        }
        const res = await db.collection('staff_deposit_evidences')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = res.data || []
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }
      const allEvidences = (await readAll('staff_deposit_evidences', where, 2000))
        .sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      return allEvidences
    }
    if (action === 'listAdminNotifications') {
      return listAdminNotifications(data, openid)
    }
    if (action === 'markAdminNotificationRead') {
      return markAdminNotificationRead(data, openid)
    }
    if (action === 'getAdminNotificationBadge') {
      return getAdminNotificationBadge(openid)
    }
    if (action === 'sendSystemNotification') {
      const admin = await requireAdmin(openid)
      return sendSystemNotification(data, admin)
    }
    if (action === 'listSystemNotifications') {
      await requireAdmin(openid)
      return listAdminSystemNotifications(data)
    }
    if (action === 'revokeSystemNotification') {
      const admin = await requireAdmin(openid)
      return revokeSystemNotification(data, admin)
    }
    throw new Error('未知 admin 操作')
  }
}
