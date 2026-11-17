const LOYALTY_ACTIONS = new Set([
  'listMemberLevels',
  'saveMemberLevel',
  'deleteMemberLevel',
  'listPetTitles',
  'savePetTitle',
  'deletePetTitle',
  'grantPoints',
  'grantUserAssetCash',
  'listPointLogs',
  'getCheckinMonthConfig',
  'saveCheckinMonthConfig',
  'issueCouponByLevels',
  'publishRewardMailByLevels',
  'publishRetroCardMail',
  'publishPetTitleMail',
  'saveLotteryActivity',
  'listLotteryActivities',
  'toggleLotteryActivity',
  'deleteLotteryActivity'
])

function createAdminLoyaltyHandler(context, helpers) {
  const {
    db,
    now,
    safeText,
    toTimeValue,
    readScopedDocuments,
    getClientRequestId,
    checkTextSecurity,
    getMemberLevels,
    normalizeMemberBadgeTag,
    normalizeMemberNameColor,
    normalizeMemberNameEffect,
    normalizeMemberBadgeStyle,
    normalizeBenefits,
    syncUsersMemberLevelName,
    recalcUsersForDeletedLevel,
    listPetTitles,
    savePetTitle,
    deletePetTitle,
    getPetTitle,
    grantEligiblePetTitlesForUsers,
    titleSnapshot,
    addPoints,
    normalizeMonthKey,
    ensureMonthConfig,
    defaultCheckinDays,
    normalizeCheckinReward,
    getMonthDays,
    normalizeCouponSnapshot,
    getMonthConfig,
    normalizeTargetLevelIds,
    resolveTargetLevels,
    issueCouponToTargetUser,
    resolveRewardMailTargets,
    resolvePetBlessing,
    logAdmin
  } = context
  const { readAll } = helpers

  return async function handleLoyaltyAction(openid, admin, action, data) {
    if (!LOYALTY_ACTIONS.has(action)) return undefined

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
      if (typeof readScopedDocuments === 'function') {
        return readScopedDocuments('lottery_activities', {}, 'createdAt', 'desc')
      }
      const res = await db.collection('lottery_activities').orderBy('createdAt', 'desc').limit(1000).get()
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

    return undefined
  }
}

module.exports = {
  LOYALTY_ACTIONS,
  createAdminLoyaltyHandler
}
