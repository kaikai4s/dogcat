module.exports = function createHandler(context) {
  const {
    ORDER_STATUS,
    RETIRED_SERVICE_KEYS,
    VISIT_FEE_SERVICE_KEY,
    addPoints,
    appendOrderClientMessage,
    appendOrderStaffMessage,
    appendOrderTimeline,
    assertAdminRoleChangeAllowed,
    assertUserDeleteAllowed,
    attachAdminOrderContactData,
    auditStatusText,
    buildDateRange,
    aggregateFinanceDashboard,
    buildMonthlyDashboard,
    buildSubscriptionData,
    calculateStaffEarningForOrder,
    cleanupUserPersonalData,
    couponUsageScopeText,
    createRefundForOrder,
    db,
    defaultCheckinDays,
    defaultServiceCheckinRules,
    defaultServicePrices,
    detachUserFromHistoricalRecords,
    ensureMonthConfig,
    ensureStaffEarning,
    expireDueUnacceptedOrders,
    getClientRequestId,
    getUser,
    getAdminNotificationBadge,
    getMemberLevels,
    getMonthConfig,
    getMonthDays,
    getSystemSettings,
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
    now,
    paginateList,
    recalcUsersForDeletedLevel,
    refreshStaffEarnings,
    removeByQuery,
    requireAdmin,
    resolveRewardMailTargets,
    resolveTargetLevels,
    resolveUserMemberLevel,
    safeText,
    settleWithdrawal,
    settleStaffDeposit,
    settleSupplyReimbursement,
    safeUserSummary,
    saveSystemSettings,
    sendSubscribeMessage,
    syncUsersMemberLevelName,
    updateOrderWhenStatus,
    validateStaffAvailabilityForSessions,
    assignOrderAtomically,
    updateOrderStatusWithScheduling,
    getOrderTimeRanges,
    validateStaffTakeOrderAbility
  } = context
  return async function admin(openid, action, data) {
    const admin = await requireAdmin(openid)
    if (action === 'dashboard') {
      await expireDueUnacceptedOrders()
      const statuses = ['paid', 'assigned', 'in_service', 'completed']
      const counts = {}
      for (let i = 0; i < statuses.length; i += 1) counts[statuses[i]] = (await db.collection('orders').where({ status: statuses[i] }).count()).total
      const staffPending = await db.collection('staff_profiles').where({ auditStatus: 'pending' }).count()
      const incidentsOpen = await db.collection('order_incidents').where({ status: 'open' }).count()
      const ordersRes = await db.collection('orders').get()
      const usersRes = await db.collection('users').get()
      return { orders: counts, staffPending: staffPending.total, incidentsOpen: incidentsOpen.total, monthly: buildMonthlyDashboard(ordersRes.data || [], usersRes.data || []) }
    }
    if (action === 'financeDashboard') {
      await refreshStaffEarnings()
      return aggregateFinanceDashboard(data)
    }
    if (action === 'listFinanceLogs') {
      const range = buildDateRange(data)
      const targetType = safeText(data.targetType).trim()
      const res = await db.collection('finance_logs').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!targetType || item.targetType === targetType) && inDateRange(item, range, ['createdAt'])), data.pageSize || 50)
    }
    if (action === 'listPayments') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('payments').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['paidAt', 'updatedAt', 'createdAt'])), data.pageSize || 50)
    }
    if (action === 'listRefunds') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('refunds').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'updatedAt'])), data.pageSize || 50)
    }
    if (action === 'listStaffEarnings') {
      await refreshStaffEarnings()
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_earnings').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'completedAt'])), data.pageSize || 50)
    }
    if (action === 'listWithdrawRequests') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('withdraw_requests').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'paidAt'])), data.pageSize || 50)
    }
    if (action === 'auditWithdrawRequest') {
      const approved = data.approved === true
      const nextStatus = approved ? 'approved' : 'rejected'
      const { request, changed } = await settleWithdrawal({ ...admin, openid }, data)
      if (changed) await sendSubscribeMessage(request.staffOpenid, 'withdrawResult', 'pages/staff/earnings/index', buildSubscriptionData('withdrawResult', { orderNo: data.id }, { amount: request.amount, statusText: approved ? '已审核' : '已驳回' }), '')
      return { id: data.id, status: nextStatus }
    }
    if (action === 'markWithdrawPaid') {
      const { request, changed } = await settleWithdrawal({ ...admin, openid }, data, true)
      if (changed) await sendSubscribeMessage(request.staffOpenid, 'withdrawResult', 'pages/staff/earnings/index', buildSubscriptionData('withdrawResult', { orderNo: data.id }, { amount: request.amount, statusText: '已打款' }), '')
      return { id: data.id, status: 'paid' }
    }
    if (action === 'getSystemSettings') {
      return getSystemSettings({ includeSecrets: data.includeSecrets === true })
    }
    if (action === 'saveSystemSettings') {
      const saved = await saveSystemSettings(data)
      const publicValue = normalizeSystemSettings(saved.value)
      await logAdmin(admin, 'platform_config', 'system_settings', 'saveSystemSettings', publicValue)
      return publicValue
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
      const res = await db.collection('users').orderBy('createdAt', 'desc').get()
      const list = (res.data || [])
        .filter((user) => !role || (Array.isArray(user.roles) && user.roles.includes(role)))
        .filter((user) => !status || user.status === status)
        .filter((user) => !keyword || [user.openid, user.nickname, user.phone].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .map((user) => safeUserSummary(user))
      return paginateList(list, data)
    }
    if (action === 'getUserDetail') {
      const targetOpenid = safeText(data.openid).trim()
      const targetUserId = safeText(data.userId || data._id).trim()
      let target = null
      if (targetOpenid) target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      else if (targetUserId) target = (await db.collection('users').doc(targetUserId).get()).data
      if (!target) throw new Error('用户不存在')
      const stats = await getUserManageStats(target)
      return { ...safeUserSummary(target, { isSelf: target.openid === openid }), inviteCode: target.inviteCode || '', retroCardCount: Number(target.retroCardCount || 0), completedOrderCount: Number(target.completedOrderCount || 0), stats }
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
      const time = now()
      const cleanup = await cleanupUserPersonalData(targetOpenid)
      cleanup.historicalRecordsDetached = await detachUserFromHistoricalRecords(targetOpenid, time)
      await db.collection('users').doc(target._id).remove()
      await logAdmin(admin, 'user', targetOpenid, 'hardDeleteUser', { userId: target._id, cleanup })
      return { openid: targetOpenid, userId: target._id, cleanup }
    }
    if (action === 'listStaffProfiles') {
      const auditStatus = safeText(data.auditStatus).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const profilesRes = await db.collection('staff_profiles').orderBy('updatedAt', 'desc').get()
      const usersRes = await db.collection('users').get()
      const userMap = new Map((usersRes.data || []).map((user) => [user.openid, user]))

      const evidencesRes = await db.collection('staff_deposit_evidences').orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const allEvidences = evidencesRes.data || []
      const evidenceByStaff = {}
      for (const ev of allEvidences) {
        if (!evidenceByStaff[ev.staffOpenid]) evidenceByStaff[ev.staffOpenid] = []
        evidenceByStaff[ev.staffOpenid].push(ev)
      }

      const depositsRes = await db.collection('staff_deposits').orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const allDeposits = depositsRes.data || []
      const depositByStaff = {}
      for (const d of allDeposits) {
        if (!depositByStaff[d.staffOpenid]) depositByStaff[d.staffOpenid] = d
      }

      const list = (profilesRes.data || [])
        .filter((profile) => !auditStatus || profile.auditStatus === auditStatus)
        .map((profile) => {
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

          const deposit = depositByStaff[profile.openid] || null
          const depositBalance = deposit ? Number(deposit.availableRefundAmount || 0) : 0
          const depositPaidAmount = deposit ? Number(deposit.paidAmount || 0) : 0
          const depositForfeitedAmount = deposit ? Number(deposit.forfeitedAmount || 0) : 0
          const depositStatus = profile.depositStatus || (deposit ? deposit.status : 'unpaid')
          const requireDepositRepay = profile.requireDepositRepay === true

          return {
            _id: profile._id,
            depositId: deposit ? (deposit._id || deposit.id) : '',
            openid: profile.openid || '',
            realName: profile.realName || '',
            phone: profile.phone || user.phone || '',
            serviceCity: profile.serviceCity || '',
            serviceAreas: profile.serviceAreas || '',
            auditStatus: profile.auditStatus || 'pending',
            auditStatusText: auditStatusText(profile.auditStatus || 'pending'),
            auditRemark: profile.auditRemark || '',
            staffLevel: workflow.staffLevel,
            staffLevelText: workflow.staffLevelText,
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
            depositPaidAmount,
            depositForfeitedAmount,
            depositStatus,
            requireDepositRepay,
            requireDepositRepayReason: profile.requireDepositRepayReason || '',
            requireDepositRepayAt: profile.requireDepositRepayAt || ''
          }
        })
        .filter((item) => {
          if (keyword && ![item.openid, item.realName, item.phone, item.serviceCity, item.serviceAreas, item.userNickname].some((value) => safeText(value).toLowerCase().includes(keyword))) {
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
          if (data.requireRepayStatus === 'yes') {
            if (!item.requireDepositRepay) return false
          } else if (data.requireRepayStatus === 'no') {
            if (item.requireDepositRepay) return false
          }
          return true
        })
      return paginateList(list, data)
    }
    if (action === 'batchRequireDepositRepay') {
      const ids = Array.isArray(data.staffProfileIds) ? data.staffProfileIds.filter(Boolean) : (data.staffProfileId ? [data.staffProfileId] : [])
      const openids = Array.isArray(data.staffOpenids) ? data.staffOpenids.filter(Boolean) : (data.staffOpenid ? [data.staffOpenid] : [])
      const reason = safeText(data.reason).trim() || '保证金余额不足或存在违规出险记录，平台要求重新足额缴纳履约保证金后方可继续接单'
      const time = now()
      let count = 0
      for (const id of ids) {
        await db.collection('staff_profiles').doc(id).update({
          data: {
            requireDepositRepay: true,
            requireDepositRepayReason: reason,
            requireDepositRepayAt: time,
            depositStatus: 'supplement_required',
            updatedAt: time
          }
        })
        count++
      }
      for (const staffOpenid of openids) {
        const pRes = await db.collection('staff_profiles').where({ openid: staffOpenid }).limit(1).get().catch(() => ({ data: [] }))
        if (pRes.data && pRes.data[0]) {
          await db.collection('staff_profiles').doc(pRes.data[0]._id).update({
            data: {
              requireDepositRepay: true,
              requireDepositRepayReason: reason,
              requireDepositRepayAt: time,
              depositStatus: 'supplement_required',
              updatedAt: time
            }
          })
          count++
        }
      }
      await logAdmin(admin, 'staff_profile', 'batch', 'batchRequireDepositRepay', { count, reason, ids, openids })
      return { success: true, count, reason }
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
    if (action === 'setSitterFeatured') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      const profile = profileRes.data
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
      const usersRes = await db.collection('users').get()
      const list = (usersRes.data || [])
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
      const usersRes = await db.collection('users').get()
      const admins = (usersRes.data || []).filter((user) => Array.isArray(user.roles) && user.roles.includes('admin'))
      if (admins.length <= 1) throw new Error('至少保留一个管理员')
      const target = (usersRes.data || []).find((user) => user.openid === targetOpenid)
      if (!target) throw new Error('目标用户不存在')
      const roles = (Array.isArray(target.roles) ? target.roles : []).filter((role) => role !== 'admin')
      const update = { roles, updatedAt: now() }
      if (target.activeRole === 'admin') update.activeRole = 'client'
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'revokeAdmin', {})
      return safeUserSummary({ ...target, ...update })
    }
    if (action === 'listOrders') {
      await expireDueUnacceptedOrders()
      const rawStatus = safeText(data.status).trim()
      const specialFilter = safeText(data.specialFilter).trim()
      const isAutoFilter = rawStatus === 'auto_completed' || specialFilter === 'auto_completed'
      const isOverdueFilter = rawStatus === 'overdue' || specialFilter === 'overdue'
      const isNormalStatus = rawStatus && !['all', 'overdue', 'auto_completed'].includes(rawStatus)
      const where = isNormalStatus ? { status: rawStatus } : {}
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      const orderKeyword = safeText(data.orderKeyword || data.keyword).trim().toLowerCase()
      const clientPhone = safeText(data.clientPhone || data.phone).trim()
      const staffPhone = safeText(data.staffPhone).trim()
      const usersRes = (clientPhone || staffPhone) ? await db.collection('users').get() : { data: [] }
      let clientOpenids = null
      if (clientPhone) {
        clientOpenids = new Set((usersRes.data || [])
          .filter((user) => safeText(user.phone).includes(clientPhone))
          .map((user) => safeText(user.openid))
          .filter(Boolean))
      }
      let staffOpenids = null
      let staffProfileIds = null
      if (staffPhone) {
        staffOpenids = new Set((usersRes.data || [])
          .filter((user) => safeText(user.phone).includes(staffPhone))
          .map((user) => safeText(user.openid))
          .filter(Boolean))
        const profilesRes = await db.collection('staff_profiles').get()
        staffProfileIds = new Set()
        ;(profilesRes.data || []).forEach((profile) => {
          if (!safeText(profile.phone).includes(staffPhone)) return
          const profileOpenid = safeText(profile.openid).trim()
          const profileId = safeText(profile._id).trim()
          if (profileOpenid) staffOpenids.add(profileOpenid)
          if (profileId) staffProfileIds.add(profileId)
        })
      }
      let orders = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
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
      const page = paginateList(orders, data)
      return { ...page, list: await Promise.all(page.list.map(attachAdminOrderContactData)) }
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
      const id = data.id || data.orderId
      const order = await db.collection('orders').doc(id).get()
      if (!order.data) throw new Error('订单不存在')
      const tracks = await db.collection('track_logs').where({ orderId: id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: id }).orderBy('createdAt', 'asc').get()
      const unlockLogs = await db.collection('unlock_code_logs').where({ orderId: id }).orderBy('createdAt', 'desc').get()
      const displayOrder = await attachAdminOrderContactData(order.data)
      const payAmount = Number(order.data.payAmount || 0)
      const existingRefundsRes = await db.collection('refunds').where({ orderId: id }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.data.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
      displayOrder.maxRefundable = maxRefundable
      displayOrder.alreadyRefunded = alreadyRefunded

      const penaltyEvidencesRes = await db.collection('staff_deposit_evidences').where({ orderId: id }).orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const penaltyEvidences = (penaltyEvidencesRes.data || []).map((e) => {
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

      if (action === 'getEvidence') await logAdmin(admin, 'order', id, 'getEvidence', { trackCount: (tracks.data || []).length, checkinCount: (checkins.data || []).filter(isActiveCheckin) })
      return { order: displayOrder, tracks: tracks.data, checkins: (checkins.data || []).filter(isActiveCheckin), unlockLogs: unlockLogs.data, depositPenaltyEvidences: penaltyEvidences }
    }
    if (action === 'assignOrder') {
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      if (orderRes.data.status !== 'paid') throw new Error('仅已支付订单可派单')
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = normalizeStaffWorkflow(profileRes.data)
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) {
        if (ability.reason === 'deposit_unpaid') {
          throw new Error('该宠托师尚未缴纳履约保证金，不能派单')
        }
        throw new Error(ability.message || '该宠托师尚未完成培训/视频审核，不能派单')
      }
      await validateStaffAvailabilityForSessions(profile, getOrderTimeRanges(orderRes.data), { excludeOrderId: data.orderId })
      const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = staffUserRes.data[0]
      if (!staffUser) throw new Error('员工用户不存在')
      const time = now()
      const assignmentUpdate = { staffUserId: staffUser._id, staffOpenid: staffUser.openid, staffProfileId: profile._id, status: 'assigned', assignmentSource: 'admin_assign', assignedAt: time, updatedAt: time }
      const assignedOrder = await assignOrderAtomically(data.orderId, orderRes.data, assignmentUpdate, { admin: true, depositConfig: settings.staffDeposit })
      await appendOrderTimeline(data.orderId, 'assigned', '管理员已派单', maskStaffName(profile.realName), 'admin')
      await appendOrderClientMessage(assignedOrder, { eventType: 'assigned', title: '平台已派单', detail: maskStaffName(profile.realName), actorRole: 'admin' })
      await notifyOrder(orderRes.data.clientOpenid, 'orderAssigned', { ...orderRes.data, _id: data.orderId }, { statusText: '已派单' })
      await logAdmin(admin, 'order', data.orderId, 'assignOrder', { staffProfileId: data.staffProfileId })
      return { orderId: data.orderId }
    }
    if (action === 'updateOrderStatus') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const targetStatus = safeText(data.status).trim()
      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写操作说明')
      const allowedStatuses = ['pending_pay', 'paid', 'assigned', 'in_service', 'completed', 'cancelled', 'refunded']
      if (!allowedStatuses.includes(targetStatus)) throw new Error('目标状态无效')

      const orderRes = await db.collection('orders').doc(orderId).get()
      if (!orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data
      const prevStatus = order.status
      if (prevStatus === targetStatus) throw new Error(`订单当前已处于该状态(${targetStatus})`)

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
      const orderRes = await db.collection('orders').doc(orderId).get()
      if (!orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data

      if (order.status === 'completed') {
        throw new Error('订单当前已经是已完成状态')
      }
      if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) {
        throw new Error(`当前订单状态（${order.status}）不可执行手动核实完单`)
      }

      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写核实完单说明')

      const standardEarning = await calculateStaffEarningForOrder(order).catch(() => ({ earningAmount: 0 }))
      const baseReward = Number(standardEarning.earningAmount || 0)

      let deductAmount = Number(data.deductAmount)
      if (isNaN(deductAmount) || deductAmount < 0) deductAmount = 0
      if (deductAmount > baseReward) {
        throw new Error(`违规扣除金额（¥${deductAmount.toFixed(2)}）不能大于宠托师原本应得收益（¥${baseReward.toFixed(2)}）`)
      }
      const finalStaffReward = Math.max(0, Math.round((baseReward - deductAmount) * 100) / 100)
      const evidenceImages = Array.isArray(data.evidenceImages) ? data.evidenceImages : []

      const time = now()
      const updateData = {
        status: 'completed',
        completionType: 'admin_manual',
        completedAt: time,
        adminManualCompletedAt: time,
        adminManualCompletedBy: openid,
        adminManualRemark: remark,
        adminManualDeductEarning: deductAmount,
        adminManualDeductReason: deductAmount > 0 ? (safeText(data.deductReason).trim() || remark) : '',
        adminManualStaffReward: finalStaffReward,
        adminManualEvidenceImages: evidenceImages,
        activeSessionIndex: 0,
        activeSessionDate: '',
        currentSessionStartedAt: '',
        isStartOverdue: false,
        isFinishOverdue: false,
        updatedAt: time
      }

      if (evidenceImages.length > 0) {
        try {
          await Promise.all(evidenceImages.map((imgUrl, idx) => {
            return db.collection('checkin_logs').add({
              data: {
                orderId,
                eventType: 'admin_supplement',
                eventText: '平台核实补录凭证',
                mediaFileId: imgUrl,
                remark: `管理员线下核实补录图片 #${idx + 1}`,
                recordedAt: time,
                createdAt: time,
                createdBy: openid,
                source: 'admin'
              }
            })
          }))
        } catch (err) {
          // ignore error
        }
      }

      await db.collection('orders').doc(orderId).update({ data: updateData })

      if (order.staffOpenid) {
        await ensureStaffEarning(
          { ...order, _id: orderId, completionType: 'admin_manual' },
          time,
          {
            deductAmount,
            deductReason: deductAmount > 0 ? (safeText(data.deductReason).trim() || remark) : '',
            overrideAmount: finalStaffReward,
            completionType: 'admin_manual'
          }
        )
      }

      const pointsDelta = Math.max(Math.floor(Number(order.payAmount || 0) / 10), 1)
      await addPoints(order.clientOpenid, order.clientUserId, pointsDelta, 'order_complete', orderId, `完成订单 +${pointsDelta} 积分`, { applyMultiplier: true, baseDelta: pointsDelta }).catch(() => {})

      try {
        const clientUser = await getUser(order.clientOpenid)
        if (clientUser && clientUser._id) {
          const completedOrderCount = Number(clientUser.completedOrderCount || 0) + 1
          await db.collection('users').doc(clientUser._id).update({ data: { completedOrderCount, updatedAt: time } })
        }
      } catch (err) {}

      if (order.staffProfileId) {
        try {
          const pRes = await db.collection('staff_profiles').doc(order.staffProfileId).get()
          if (pRes.data) {
            const completedCount = Number(pRes.data.completedOrderCount || 0) + 1
            await db.collection('staff_profiles').doc(order.staffProfileId).update({ data: { completedOrderCount: completedCount, updatedAt: time } })
          }
        } catch (err) {}
      }

      const timelineTitle = deductAmount > 0
        ? `管理员核实并手动完单（扣减收益 ¥${deductAmount.toFixed(2)}）`
        : `管理员核实并手动完单`
      const timelineDesc = `核实说明：${remark}。宠托师原应得 ¥${baseReward.toFixed(2)}${deductAmount > 0 ? `，因未规范打卡扣除 ¥${deductAmount.toFixed(2)}，实发收益 ¥${finalStaffReward.toFixed(2)}` : `，全额入账收益 ¥${finalStaffReward.toFixed(2)}`}。`
      await appendOrderTimeline(orderId, 'admin_manual_completed', timelineTitle, timelineDesc, 'admin')

      await appendOrderClientMessage({ ...order, _id: orderId, status: 'completed' }, {
        eventType: 'completed',
        title: '订单已由平台核实完成',
        detail: `平台管理员已协助核实履约并确认完单：${remark}。您的实付金额与权益不受影响，如有疑问可联系客服。`,
        actorRole: 'admin'
      })

      if (order.staffOpenid) {
        const staffMsgDetail = deductAmount > 0
          ? `您的订单（${order.serviceSummary || order.orderNo}）由于未按规范在小程序内完成全部打卡，经平台核实后手动确认完单。本单原本应得收益 ¥${baseReward.toFixed(2)}，扣减违规收益 ¥${deductAmount.toFixed(2)}（原因：${safeText(data.deductReason).trim() || remark}），实际入账收益 ¥${finalStaffReward.toFixed(2)} 已结算记入您的收益中心。请在后续履约中规范打卡。`
          : `您的订单（${order.serviceSummary || order.orderNo}）已由平台管理员核实完成，应得收益 ¥${finalStaffReward.toFixed(2)} 已全额结算记入您的收益中心。`
        await appendOrderStaffMessage({ ...order, _id: orderId, status: 'completed' }, {
          eventType: 'admin_manual_completed',
          title: deductAmount > 0 ? '订单已核实完单（违规扣减收益通知）' : '订单已由管理员核实完单',
          detail: staffMsgDetail,
          actorRole: 'admin',
          idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'admin_manual_complete', String(time.getTime()))
        })
      }

      await logAdmin(admin, 'order', orderId, 'manualCompleteOrder', {
        baseReward,
        deductAmount,
        finalStaffReward,
        remark,
        evidenceImagesCount: evidenceImages.length
      })

      return {
        orderId,
        status: 'completed',
        baseReward,
        deductAmount,
        finalStaffReward,
        remark
      }
    }
    if (action === 'refundOrder') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get()
      if (!orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data
      const payAmount = Number(order.payAmount || 0)
      if (payAmount <= 0) throw new Error('该订单无需退款（实付金额为0）')
      if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding' && order.status !== 'paid' && !order.paidAt) {
        throw new Error('订单未支付或状态不支持退款')
      }

      const existingRefundsRes = await db.collection('refunds').where({ orderId }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)

      if (maxRefundable <= 0) throw new Error('该订单已全额退款，无剩余可退金额')

      const refundAmount = Number(data.refundAmount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')
      if (refundAmount > maxRefundable) throw new Error(`退款金额不能超过可退金额上限 ¥${maxRefundable.toFixed(2)}`)

      const reason = safeText(data.reason || data.remark).trim()
      if (!reason) throw new Error('请填写退款说明')

      const refund = await createRefundForOrder(order, refundAmount, reason, 'admin_manual', openid, getClientRequestId(data))
      const totalRefundAmount = Math.round((alreadyRefunded + refundAmount) * 100) / 100
      const isFullRefund = totalRefundAmount >= payAmount

      const time = now()
      const orderUpdate = {
        refundAmount: totalRefundAmount,
        refundNo: refund.refundNo,
        refundStatus: isFullRefund ? 'full_refunded' : 'partially_refunded',
        paymentStatus: isFullRefund ? 'refunded' : 'refunding',
        refundRemark: reason,
        adminManualRefundByOpenid: openid,
        adminManualRefundAt: time,
        updatedAt: time
      }
      if (isFullRefund && !['completed'].includes(order.status)) {
        orderUpdate.status = 'refunded'
      }
      await db.collection('orders').doc(orderId).update({ data: orderUpdate })
      await appendOrderTimeline(orderId, 'refund', `管理员手动退款 ¥${refundAmount.toFixed(2)}`, `说明：${reason}${isFullRefund ? '（已全额退款）' : ''}`, 'admin')
      await logAdmin(admin, 'order', orderId, 'refundOrder', { refundAmount, reason, refundNo: refund.refundNo, isFullRefund })
      return {
        orderId,
        refundNo: refund.refundNo,
        refundAmount,
        totalRefundAmount,
        isFullRefund,
        status: orderUpdate.status || order.status
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
      const existing = await db.collection('service_prices').where({ key }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('service_prices').doc(existing.data[0]._id).update({ data: { ...payload, updatedAt: time } })
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
      const existing = await db.collection('service_prices').where({ key }).limit(1).get()
      if (isPresetServiceKey(key)) {
        const payload = { enabled: false, showOnHome: false, updatedAt: time }
        if (existing.data[0]) await db.collection('service_prices').doc(existing.data[0]._id).update({ data: payload })
        else await db.collection('service_prices').add({ data: { key, label: (defaultServicePrices.find((item) => item.key === key) || {}).label || key, price: 0, ...payload, createdAt: time } })
      } else if (existing.data[0]) {
        await db.collection('service_prices').doc(existing.data[0]._id).remove()
        await removeByQuery('service_checkin_rules', { serviceType: key })
      }
      await logAdmin(admin, 'service_price', key, 'deleteServicePrice', {})
      return listServicePrices(true)
    }
    if (action === 'resetDefaultServicePrices') {
      const time = now()
      await Promise.all(defaultServicePrices.map(async (preset) => {
        const existing = await db.collection('service_prices').where({ key: preset.key }).limit(1).get()
        const existingItem = existing.data[0] || {}
        const payload = {
          ...normalizeServicePrice({
            ...preset,
            detailDescription: existingItem.detailDescription || '',
            caseImageFileIds: existingItem.caseImageFileIds || []
          }),
          updatedAt: time
        }
        if (existing.data[0]) return db.collection('service_prices').doc(existing.data[0]._id).update({ data: payload })
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
        const existing = await db.collection('coupon_templates').doc(data._id).get()
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
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const targetUser = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!targetUser || targetUser.status !== 'active') throw new Error('目标用户不存在')
      const issued = await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponToUser', { targetOpenid, couponId: issued._id })
      return { _id: issued._id, templateId, openid: targetOpenid, status: 'available', templateSnapshot: issued.templateSnapshot, validFrom: issued.validFrom, validTo: issued.validTo }
    }
    if (action === 'listFeedback') {
      const status = safeText(data.status).trim()
      const category = safeText(data.category).trim()
      const res = await db.collection('user_feedback').orderBy('createdAt', 'desc').get()
      const list = (res.data || [])
        .filter((item) => !status || item.status === status)
        .filter((item) => !category || item.category === category)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'replyFeedback') {
      const id = safeText(data.id || data.feedbackId).trim()
      const replyContent = safeText(data.replyContent || data.reply).trim()
      const status = safeText(data.status).trim() || 'resolved'
      if (!id) throw new Error('请选择反馈')
      if (!replyContent) throw new Error('请输入回复内容')
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
    if (action === 'listStaffAudits') {
      const status = safeText(data.auditStatus).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const where = status ? { auditStatus: status } : {}
      const res = await db.collection('staff_profiles').where(where).orderBy('updatedAt', 'desc').get()

      const evidencesRes = await db.collection('staff_deposit_evidences').orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const allEvidences = evidencesRes.data || []
      const evidenceByStaff = {}
      for (const ev of allEvidences) {
        if (!evidenceByStaff[ev.staffOpenid]) evidenceByStaff[ev.staffOpenid] = []
        evidenceByStaff[ev.staffOpenid].push(ev)
      }

      const list = (res.data || []).map((p) => {
        const staffEvidences = evidenceByStaff[p.openid] || []
        return {
          ...p,
          problemOrderCount: staffEvidences.length,
          pendingPenaltyCount: staffEvidences.filter((e) => e.status === 'pending').length,
          problemOrders: staffEvidences
        }
      }).filter((item) => !keyword || [item.realName, item.phone, item.serviceCity, item.serviceAreas].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'auditStaff') {
      const status = data.auditStatus === 'approved' ? 'approved' : 'rejected'
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      const identityStatus = status === 'approved' ? 'verified' : 'failed'
      const faceVerifyStatus = status === 'approved' ? 'verified' : 'failed'
      const time = now()
      const workflowUpdate = status === 'approved'
        ? { staffLevel: 'applicant', onboardingStatus: 'training_pending', videoAuditStatus: 'not_started', promotionStatus: 'none' }
        : { staffLevel: 'applicant', onboardingStatus: 'application_pending', videoAuditStatus: 'not_started', promotionStatus: 'none' }
      await db.collection('staff_profiles').doc(data.staffProfileId).update({ data: { auditStatus: status, auditRemark: data.auditRemark || '', identityStatus, faceVerifyStatus, ...workflowUpdate, updatedAt: time } })
      const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: data.staffProfileId }).limit(1).get()
      if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: { auditStatus: status, auditRemark: data.auditRemark || '', identityStatus, faceVerifyStatus, auditedByOpenid: openid, auditedAt: time, updatedAt: time } })
      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
      if (staffUser && status === 'rejected') {
        const existingRoles = Array.isArray(staffUser.roles) ? staffUser.roles : ['client']
        const roles = existingRoles.filter((role) => role !== 'staff')
        const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
        if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
        await db.collection('users').doc(staffUser._id).update({ data: userUpdate })
      }
      await logAdmin(admin, 'staff_profile', data.staffProfileId, 'auditStaff', { status })
      return { staffProfileId: data.staffProfileId, auditStatus: status }
    }
    if (action === 'revokeStaff') {
      const staffProfileId = safeText(data.staffProfileId || data.id).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      const profile = profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      const time = now()
      const auditRemark = safeText(data.auditRemark || data.remark).trim() || '管理员移除宠托师身份'
      const update = {
        auditStatus: 'revoked',
        auditRemark,
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
      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
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
      const res = await db.collection('staff_profiles').where({ auditStatus: 'approved', videoAuditStatus: 'pending' }).orderBy('videoAuditRequestedAt', 'desc').get()
      const list = (res.data || []).map(normalizeStaffWorkflow).filter((item) => !keyword || [item.realName, item.phone, item.serviceCity, item.serviceAreas].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'auditTrainingVideo') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      const status = data.status === 'approved' ? 'approved' : 'rejected'
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      const profile = profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      const time = now()
      const update = status === 'approved'
        ? { videoAuditStatus: 'approved', onboardingStatus: 'intern', staffLevel: 'intern', internStartedAt: profile.internStartedAt || time, videoAuditRemark: safeText(data.remark).trim(), updatedAt: time }
        : { videoAuditStatus: 'rejected', onboardingStatus: 'videos_completed', videoAuditRemark: safeText(data.remark).trim(), updatedAt: time }
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
      const appsRes = await db.collection('staff_promotion_applications').orderBy('createdAt', 'desc').get()
      const profilesRes = await db.collection('staff_profiles').get()
      const profileMap = new Map((profilesRes.data || []).map((item) => [item._id, normalizeStaffWorkflow(item)]))
      const list = (appsRes.data || [])
        .filter((item) => !status || item.status === status)
        .map((item) => ({ ...item, profile: profileMap.get(item.staffProfileId) || null }))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'getPromotionApplicationDetail') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      if (!applicationId) throw new Error('请选择晋升申请')
      const app = (await db.collection('staff_promotion_applications').doc(applicationId).get()).data
      if (!app) throw new Error('晋升申请不存在')
      const profile = normalizeStaffWorkflow((await db.collection('staff_profiles').doc(app.staffProfileId).get()).data)
      const orders = []
      for (const orderId of (app.orderIds || [])) {
        const order = (await db.collection('orders').doc(orderId).get()).data
        if (!order) continue
        const tracks = await db.collection('track_logs').where({ orderId }).orderBy('recordedAt', 'asc').get()
        const checkins = await db.collection('checkin_logs').where({ orderId }).orderBy('createdAt', 'asc').get()
        const reviews = await db.collection('service_reviews').where({ orderId }).get()
        orders.push({ order: await attachAdminOrderContactData({ ...order, _id: orderId }), tracks: tracks.data || [], checkins: (checkins.data || []).filter(isActiveCheckin), review: (reviews.data || [])[0] || null })
      }
      return { application: app, profile, orders }
    }
    if (action === 'auditPromotionApplication') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      const status = data.status === 'approved' ? 'approved' : 'rejected'
      if (!applicationId) throw new Error('请选择晋升申请')
      const app = (await db.collection('staff_promotion_applications').doc(applicationId).get()).data
      if (!app) throw new Error('晋升申请不存在')
      const time = now()
      const appUpdate = { status, adminRemark: safeText(data.remark).trim(), reviewedByOpenid: openid, reviewedAt: time, updatedAt: time }
      await db.collection('staff_promotion_applications').doc(applicationId).update({ data: appUpdate })
      const profileUpdate = status === 'approved'
        ? { staffLevel: 'certified', promotionStatus: 'approved', certifiedAt: time, updatedAt: time }
        : { promotionStatus: 'rejected', promotionRejectReason: safeText(data.remark).trim(), updatedAt: time }
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
      const saved = await savePetTitle(data)
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const grants = await grantEligiblePetTitlesForUsers(usersRes.data || [])
      await logAdmin(admin, 'pet_title', saved._id, 'savePetTitle', { name: saved.name, autoGrantLevelIds: saved.autoGrantLevelIds, autoGrantCount: grants.length })
      return { ...saved, autoGrantCount: grants.length }
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
      const reason = safeText(data.reason).trim() || '管理员操作'
      await addPoints(targetOpenid, '', delta, 'admin_grant', admin._id, reason)
      await logAdmin(admin, 'user', targetOpenid, 'grantPoints', { delta, reason })
      return { openid: targetOpenid, delta }
    }
    if (action === 'listPointLogs') {
      const where = data.openid ? { openid: safeText(data.openid).trim() } : {}
      const res = await db.collection('point_logs').where(where).orderBy('createdAt', 'desc').get()
      return res.data || []
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
        const template = (await db.collection('coupon_templates').doc(couponId).get()).data
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
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const eligible = (usersRes.data || []).filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      let issued = 0; let skipped = 0
      const skippedReasons = {}
      for (const targetUser of eligible) {
        try {
          await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
          issued++
        } catch (error) {
          skipped++
          const reason = safeText(error.message).trim() || '发放失败'
          skippedReasons[reason] = (skippedReasons[reason] || 0) + 1
        }
      }
      const skippedReasonText = Object.keys(skippedReasons).map((reason) => `${reason}：${skippedReasons[reason]}人`).join('\n')
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponByLevels', { targetLevelIds, targetLevelNamesSnapshot, issued, skipped, skippedReasons, eligibleCount: eligible.length })
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
      const content = safeText(data.content).trim()
      const reward = { type: rewardType }
      if (rewardType === 'coupon') {
        const couponTemplateId = safeText(data.couponTemplateId).trim()
        if (!couponTemplateId) throw new Error('请选择奖励优惠券')
        const template = (await db.collection('coupon_templates').doc(couponTemplateId).get()).data
        if (!template || template.enabled === false) throw new Error('奖励优惠券不可用')
        reward.couponTemplateId = couponTemplateId
        reward.couponSnapshot = normalizeCouponSnapshot(template)
      } else {
        reward.points = Math.max(Math.round(Number(data.points || 0)), 0)
        if (!reward.points) throw new Error('奖励积分必须大于 0')
      }
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const eligible = (usersRes.data || []).filter((u) => targetLevelIds.includes(u.memberLevel || ''))
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
      const target = await resolveRewardMailTargets(data)
      if (!target.users.length) throw new Error('没有符合条件的用户')
      const title = safeText(data.title).trim() || '补签卡奖励到账'
      const content = safeText(data.content).trim() || `你获得 ${count} 张补签卡，请及时领取。`
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
      const content = safeText(data.content).trim() || `平台已向你发放宠物头衔【${petTitle.name}】，请前往奖励邮箱领取。`
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
          const text = type === 'text' ? safeText(p.text || p.name).trim() : ''
          let petTitle = null
          if (type === 'pet_title') {
            petTitle = await getPetTitle(titleId, { includeDeleted: true })
            if (petTitle.deletedAt || petTitle.enabled === false) throw new Error('请选择有效的宠物头衔奖品')
          }
          let prizeName = safeText(p.name).trim()
          if (!prizeName) {
            if (type === 'points') prizeName = `${points} 积分`
            else if (type === 'text') prizeName = text || '谢谢参与'
            else if (type === 'pet_title') prizeName = `宠物头衔：${petTitle.name}`
            else prizeName = '优惠券'
          }
          if (!prizeName) continue
          prizes.push({
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
      const activityRes = await db.collection('lottery_activities').doc(data._id).get()
      const enabled = !activityRes.data.enabled
      await db.collection('lottery_activities').doc(data._id).update({ data: { enabled, updatedAt: now() } })
      await logAdmin(admin, 'lottery_activity', data._id, 'toggleLotteryActivity', { enabled })
      return { _id: data._id, enabled }
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
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_deposits').orderBy('createdAt', 'desc').get()
      const users = (await db.collection('users').get()).data || []
      const profiles = (await db.collection('staff_profiles').get()).data || []
      const evidencesRes = await db.collection('staff_deposit_evidences').orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const allEvidences = evidencesRes.data || []
      const evidenceByStaff = {}
      for (const ev of allEvidences) {
        if (!evidenceByStaff[ev.staffOpenid]) evidenceByStaff[ev.staffOpenid] = []
        evidenceByStaff[ev.staffOpenid].push(ev)
      }
      const userMap = users.reduce((m, u) => ({ ...m, [u.openid]: u }), {})
      const profileMap = profiles.reduce((m, p) => ({ ...m, [p.openid]: p }), {})
      const list = (res.data || [])
        .filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'paidAt']))
        .map((item) => {
          const u = userMap[item.staffOpenid] || {}
          const p = profileMap[item.staffOpenid] || {}
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
            staffPhone: p.phone || u.phone || '',
            staffRealName: p.realName || '',
            staffLevel: p.staffLevel || '',
            problemOrders
          }
        })
      return limitList(list, data.pageSize || 50)
    }
    if (action === 'auditDepositRefund') {
      return settleStaffDeposit({ ...admin, openid }, action, data)
    }
    if (action === 'confirmDepositRefund') {
      return settleStaffDeposit({ ...admin, openid }, action, data)
    }
    if (action === 'forfeitStaffDeposit') {
      return settleStaffDeposit({ ...admin, openid }, action, data)
    }
    if (action === 'listSupplyReimbursements') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_supply_reimbursements').orderBy('createdAt', 'desc').get()
      const users = (await db.collection('users').get()).data || []
      const profiles = (await db.collection('staff_profiles').get()).data || []
      const userMap = users.reduce((m, u) => ({ ...m, [u.openid]: u }), {})
      const profileMap = profiles.reduce((m, p) => ({ ...m, [p.openid]: p }), {})
      const list = (res.data || [])
        .filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'paidAt']))
        .map((item) => {
          const u = userMap[item.staffOpenid] || {}
          const p = profileMap[item.staffOpenid] || {}
          return {
            ...item,
            staffNickname: u.nickname || '',
            staffPhone: p.phone || u.phone || '',
            staffRealName: p.realName || '',
            staffLevel: p.staffLevel || ''
          }
        })
      return limitList(list, data.pageSize || 50)
    }
    if (action === 'auditSupplyReimbursement') {
      return settleSupplyReimbursement({ ...admin, openid }, action, data)
    }
    if (action === 'paySupplyReimbursement') {
      return settleSupplyReimbursement({ ...admin, openid }, action, data)
    }
    if (action === 'republishOrderAsUrgent') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get()
      const order = orderRes.data
      if (!order) throw new Error('订单不存在')

      if (!['paid', 'assigned'].includes(order.status)) {
        throw new Error(`当前订单状态（${order.status}）不可转为加急公共抢单，宠托师可能已开始服务或订单状态已变更，请刷新确认`)
      }

      const checkinRes = await db.collection('checkin_logs').where({ orderId }).get().catch(() => ({ data: [] }))
      const staffCheckins = (checkinRes.data || []).filter((item) => isActiveCheckin(item) && item.source !== 'admin' && item.eventType !== 'admin_supplement' && (!order.staffOpenid || item.staffOpenid === order.staffOpenid))
      if (staffCheckins.length > 0) {
        throw new Error('原宠托师已到场开始打卡履约，不可转为加急公共抢单，请刷新核实')
      }

      const staffReward = Number(data.staffReward)
      if (isNaN(staffReward) || staffReward <= 0) {
        throw new Error('请设置有效的宠托师加急收益金额')
      }

      const newStartTime = safeText(data.startTime).trim() || order.startTime
      const newEndTime = safeText(data.endTime).trim() || order.endTime
      const urgentRemark = safeText(data.urgentRemark || data.remark || data.notes).trim()

      const time = now()
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
        startTime: newStartTime,
        endTime: newEndTime,
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
      if (prevStaffOpenid && (data.recordDepositEvidence === true || data.autoRecordDepositEvidence === true)) {
        const profileRes = await db.collection('staff_profiles').where({ openid: prevStaffOpenid }).limit(1).get().catch(() => ({ data: [] }))
        const p = profileRes.data && profileRes.data[0]
        const evidenceDoc = {
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
        const createdEvidence = await db.collection('staff_deposit_evidences').add({ data: evidenceDoc })
        createdEvidenceId = createdEvidence._id
        updateData.hasDepositPenaltyEvidence = true
        updateData.depositPenaltyEvidenceIds = [...(Array.isArray(order.depositPenaltyEvidenceIds) ? order.depositPenaltyEvidenceIds : []), createdEvidenceId]
      }

      const updateRes = await db.collection('orders').where({ _id: orderId, status: order.status }).update({ data: updateData })
      if (!updateRes || !updateRes.stats || updateRes.stats.updated === 0) {
        if (createdEvidenceId) {
          await db.collection('staff_deposit_evidences').doc(createdEvidenceId).remove().catch(() => {})
        }
        throw new Error('订单状态已被并发更新或已被宠托师抢先开始，转加急单失败，请刷新确认最新状态')
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

      await appendOrderTimeline(
        orderId,
        'urgent_republished',
        '已转为加急公共单',
        `管理员已将订单发布至加急公共抢单池。宠托师收益调整为 ¥${staffReward.toFixed(2)}（含平台补贴加价 ¥${urgentBonus.toFixed(2)}），新服务时间：${newStartTime}。用户支付金额不受影响。`,
        'admin'
      )

      await logAdmin(admin, 'order', orderId, 'republishOrderAsUrgent', {
        prevStaffOpenid,
        staffReward,
        urgentBonus,
        newStartTime,
        newEndTime,
        urgentRemark
      })

      if (typeof notifyAdmins === 'function') {
        await notifyAdmins({
          type: 'order_urgent_republished',
          level: 'info',
          title: `【加急单发布】订单 ${order.orderNo || orderId} 已发布到加急抢单池`,
          content: `管理员已将订单重新发布为加急公共抢单。宠托师收益：¥${staffReward.toFixed(2)}（加价补贴 ¥${urgentBonus.toFixed(2)}），约定开始时间调整为 ${newStartTime}。`,
          orderId,
          orderNo: order.orderNo || '',
          actionUrl: `/pages/admin/orders/detail/index?id=${orderId}`
        })
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
      const orderRes = await db.collection('orders').doc(orderId).get()
      const order = orderRes.data
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
      const res = await db.collection('staff_deposit_evidences').where(where).orderBy('createdAt', 'desc').get()
      const list = res.data || []
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
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
    throw new Error('未知 admin 操作')
  }
}
