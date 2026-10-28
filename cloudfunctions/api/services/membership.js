module.exports = function createService({
  db,
  getOptionalUser,
  getSystemSettings,
  grantInviteReward,
  grantRetroCards,
  incUpdateValue,
  normalizeMemberBadgeStyle,
  normalizeMemberBadgeTag,
  normalizeMemberNameColor,
  normalizeMemberNameEffect,
  now,
  safeText,
  toCstParts
}) {
  function normalizeBenefits(value) {
    if (Array.isArray(value)) return value.map((item) => safeText(item).trim()).filter(Boolean)
    return safeText(value).split(/[\n,，；;]+/).map((item) => item.trim()).filter(Boolean)
  }

  function invitationRewardSnapshot(settings = {}) {
    const invitation = settings.invitation || settings.userAssets || settings
    const amount = Number(invitation.rewardAmount || 0)
    return invitation.enabled === true && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0
  }

  function invitationSettings(settings = {}) {
    return settings.invitation || settings.userAssets || settings
  }

  function calcMemberLevel(totalPoints, levels) {
    if (!Array.isArray(levels) || !levels.length) return { memberLevel: '', memberLevelName: '普通会员', badgeTag: 'V1', nameColor: '', nameEffect: '', badgeStyle: 'gold', pointMultiplier: 1, description: '', benefits: [] }
    const sorted = levels.slice().sort((a, b) => Number(b.minPoints || 0) - Number(a.minPoints || 0))
    const matched = sorted.find((level) => totalPoints >= Number(level.minPoints || 0))
    if (!matched) return { memberLevel: '', memberLevelName: '普通会员', badgeTag: 'V1', nameColor: '', nameEffect: '', badgeStyle: 'gold', pointMultiplier: 1, description: '', benefits: [] }
    const idx = levels.findIndex((l) => l._id === matched._id)
    return {
      memberLevel: matched._id,
      memberLevelName: matched.name,
      badgeTag: normalizeMemberBadgeTag(matched.badgeTag) || `V${idx >= 0 ? idx + 1 : 1}`,
      nameColor: normalizeMemberNameColor(matched.nameColor),
      nameEffect: normalizeMemberNameEffect(matched.nameEffect),
      badgeStyle: normalizeMemberBadgeStyle(matched.badgeStyle),
      pointMultiplier: Math.max(Number(matched.pointMultiplier || 1), 1),
      description: safeText(matched.description).trim(),
      benefits: normalizeBenefits(matched.benefits)
    }
  }

  function resolveUserMemberLevel(user = {}, levels = []) {
    if (!Array.isArray(levels) || !levels.length) {
      return {
        memberLevel: safeText(user.memberLevel),
        memberLevelName: safeText(user.memberLevelName).trim() || '普通会员',
        badgeTag: normalizeMemberBadgeTag(user.badgeTag) || 'V1',
        nameColor: normalizeMemberNameColor(user.nameColor),
        nameEffect: normalizeMemberNameEffect(user.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(user.badgeStyle),
        pointMultiplier: 1,
        description: safeText(user.description).trim(),
        benefits: normalizeBenefits(user.benefits)
      }
    }

    // 1. 优先按 user.memberLevel 匹配已有的等级ID
    let matched = user.memberLevel ? levels.find((l) => l._id === user.memberLevel) : null

    // 2. 如果没匹配到，按 user.memberLevelName 匹配等级名称
    if (!matched && user.memberLevelName) {
      matched = levels.find((l) => safeText(l.name).trim() === safeText(user.memberLevelName).trim())
    }

    // 3. 如果没匹配到，按累计积分或当前积分计算最高达标等级
    if (!matched && (user.totalPoints !== undefined || user.points !== undefined)) {
      const pointsToUse = Number(user.totalPoints !== undefined ? user.totalPoints : user.points) || 0
      const sorted = levels.slice().sort((a, b) => Number(b.minPoints || 0) - Number(a.minPoints || 0))
      matched = sorted.find((l) => pointsToUse >= Number(l.minPoints || 0))
    }

    if (matched) {
      const idx = levels.findIndex((l) => l._id === matched._id)
      return {
        memberLevel: matched._id,
        memberLevelName: matched.name,
        badgeTag: normalizeMemberBadgeTag(user.badgeTag) || normalizeMemberBadgeTag(matched.badgeTag) || `V${idx >= 0 ? idx + 1 : 1}`,
        nameColor: normalizeMemberNameColor(user.nameColor) || normalizeMemberNameColor(matched.nameColor),
        nameEffect: (user.nameEffect && normalizeMemberNameEffect(user.nameEffect) !== 'none') ? normalizeMemberNameEffect(user.nameEffect) : normalizeMemberNameEffect(matched.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(user.badgeStyle) || normalizeMemberBadgeStyle(matched.badgeStyle),
        pointMultiplier: Math.max(Number(matched.pointMultiplier || 1), 1),
        description: safeText(matched.description).trim() || safeText(user.description).trim(),
        benefits: normalizeBenefits(matched.benefits)
      }
    }

    const baselineLevel = levels.length ? levels[0] : null
    return {
      memberLevel: '',
      memberLevelName: safeText(user.memberLevelName).trim() || (baselineLevel ? baselineLevel.name : '普通会员'),
      badgeTag: normalizeMemberBadgeTag(user.badgeTag) || (baselineLevel ? normalizeMemberBadgeTag(baselineLevel.badgeTag) : 'V1'),
      nameColor: normalizeMemberNameColor(user.nameColor) || (baselineLevel ? normalizeMemberNameColor(baselineLevel.nameColor) : ''),
      nameEffect: (user.nameEffect && normalizeMemberNameEffect(user.nameEffect) !== 'none') ? normalizeMemberNameEffect(user.nameEffect) : (baselineLevel ? normalizeMemberNameEffect(baselineLevel.nameEffect) : 'none'),
      badgeStyle: normalizeMemberBadgeStyle(user.badgeStyle) || (baselineLevel ? normalizeMemberBadgeStyle(baselineLevel.badgeStyle) : 'gold'),
      pointMultiplier: 1,
      description: '',
      benefits: []
    }
  }

  async function enrichUserMemberLevel(user, levelsCache = null) {
    if (!user) return user
    try {
      const levels = levelsCache || await getMemberLevels()
      const levelInfo = resolveUserMemberLevel(user, levels)
      return {
        ...user,
        memberLevel: levelInfo.memberLevel,
        memberLevelName: levelInfo.memberLevelName,
        badgeTag: levelInfo.badgeTag,
        badgeStyle: levelInfo.badgeStyle,
        nameColor: levelInfo.nameColor,
        nameEffect: levelInfo.nameEffect,
        pointMultiplier: levelInfo.pointMultiplier
      }
    } catch (e) {
      return user
    }
  }

  async function getMemberLevels() {
    const levelsRes = await db.collection('member_levels').orderBy('minPoints', 'asc').get()
    return levelsRes.data || []
  }

  function normalizeTargetLevelIds(targetLevelIds) {
    return Array.from(new Set((Array.isArray(targetLevelIds) ? targetLevelIds : []).map((item) => safeText(item).trim()).filter(Boolean)))
  }

  async function resolveTargetLevels(targetLevelIds) {
    const ids = normalizeTargetLevelIds(targetLevelIds)
    const levels = await getMemberLevels()
    const levelMap = new Map(levels.map((level) => [level._id, level]))
    return ids.map((id) => levelMap.get(id)).filter(Boolean)
  }

  async function syncUsersMemberLevelName(levelId, levelName) {
    let cursor = ''
    const time = now()
    while (true) {
      const condition = { memberLevel: levelId }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection('users').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      for (const user of page) {
        await db.collection('users').doc(user._id).update({ data: { memberLevelName: levelName || '普通会员', updatedAt: time } })
      }
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
  }

  async function recalcUsersForDeletedLevel(levelId) {
    const levels = await getMemberLevels()
    const time = now()
    let cursor = ''
    while (true) {
      const condition = { memberLevel: levelId }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection('users').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      for (const user of page) {
        const levelInfo = calcMemberLevel(Number(user.totalPoints || 0), levels)
        await db.collection('users').doc(user._id).update({
          data: {
            memberLevel: levelInfo.memberLevel,
            memberLevelName: levelInfo.memberLevelName,
            updatedAt: time
          }
        })
      }
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
  }

  function createInviteCode(user) {
    return `INV${safeText((user && (user._id || user.openid)) || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase() || Date.now()}`
  }

  function normalizeMonthKey(monthKey) {
    const text = safeText(monthKey).trim()
    return /^\d{4}-\d{2}$/.test(text) ? text : toCstParts().monthKey
  }

  async function resolveInviter(data = {}) {
    const inviterOpenid = safeText(data.inviterOpenid).trim()
    if (inviterOpenid) {
      const inviter = await getOptionalUser(inviterOpenid)
      return inviter || null
    }
    const inviteCode = safeText(data.inviteCode).trim().toUpperCase()
    if (!inviteCode) return null
    const inviterRes = await db.collection('users').where({ inviteCode }).limit(1).get()
    return inviterRes.data[0] || null
  }

  async function bindInviteRelation(user, data = {}) {
    if (!user || !user._id) return user
    const time = now()
    let currentUser = user
    if (!safeText(user.inviteCode).trim()) {
      const inviteCode = createInviteCode(user)
      await db.collection('users').doc(user._id).update({ data: { inviteCode, updatedAt: time } })
      currentUser = { ...currentUser, inviteCode, updatedAt: time }
    }
    if (safeText(currentUser.inviterOpenid).trim()) {
      // The binding is immutable, but a transient ledger write failure should be
      // repairable on a later login without creating a second reward.
      if (typeof grantInviteReward === 'function') {
        try {
          const inviteDocId = `invite_${currentUser.openid}`
          const existingRes = await db.collection('user_invites').where({ invitedOpenid: currentUser.openid }).limit(1).get()
          let existingInvite = existingRes.data && existingRes.data[0]
          if (!existingInvite) {
            const inviter = await getOptionalUser(currentUser.inviterOpenid)
            if (inviter && inviter.openid !== currentUser.openid) {
              const repairRecord = {
                inviterUserId: inviter._id,
                inviterOpenid: inviter.openid,
                invitedUserId: currentUser._id,
                invitedOpenid: currentUser.openid,
                inviteCode: safeText(inviter.inviteCode).trim().toUpperCase(),
                bindingSource: 'repair',
                rewarded: false,
                createdAt: currentUser.createdAt || time,
                updatedAt: time
              }
              await db.collection('user_invites').doc(inviteDocId).set({ data: repairRecord })
              existingInvite = { ...repairRecord, _id: inviteDocId }
            }
          }
          if (existingInvite) {
            const settings = await getSystemSettings()
            await grantInviteReward({ ...existingInvite, _id: existingInvite._id || inviteDocId }, { settings: settings.invitation || settings.userAssets || settings })
          }
        } catch (_) {}
      }
      return currentUser
    }
    if (!data.inviteCode && !data.inviterOpenid) return currentUser
    const systemSettings = await getSystemSettings()
    if (systemSettings.maintenance?.invitation === true) return currentUser
    const inviter = await resolveInviter(data)
    if (!inviter || inviter.openid === currentUser.openid) return currentUser

    const inviteDocId = `invite_${currentUser.openid}`
    const bindingSource = safeText(data.bindingSource || (data.inviteCode ? 'share' : 'manual')).trim() || 'manual'
    const rewardAmount = invitationRewardSnapshot(systemSettings)
    let inviterStaffEligibleAt = ''
    try {
      const profileRes = await db.collection('staff_profiles').where({ openid: inviter.openid }).limit(1).get()
      const profile = profileRes.data && profileRes.data[0]
      const depositOkay = profile && (profile.depositRequired !== true || profile.depositStatus === 'paid')
      if (profile && profile.auditStatus === 'approved' && profile.staffLevel === 'certified' && depositOkay && !['requested', 'approved', 'exited'].includes(profile.exitStatus)) {
        inviterStaffEligibleAt = profile.certifiedAt || profile.certificationLockedAt || profile.updatedAt || time
      }
    } catch (_) {}

    const executeBind = async (tx) => {
      const reader = tx || db
      let existing = null
      try {
        const docRes = await reader.collection('user_invites').doc(inviteDocId).get()
        existing = docRes && (docRes.data || docRes)
      } catch (e) {
        existing = null
      }
      if (!existing) {
        const queryRes = await reader.collection('user_invites').where({ invitedOpenid: currentUser.openid }).limit(1).get().catch(() => ({ data: [] }))
        existing = queryRes.data && queryRes.data[0]
      }
      if (existing) {
        return { bound: false, inviterOpenid: existing.inviterOpenid || currentUser.inviterOpenid || '', existing }
      }

      const inviteRecord = {
        inviterUserId: inviter._id,
        inviterOpenid: inviter.openid,
        invitedUserId: currentUser._id,
        invitedOpenid: currentUser.openid,
        inviteCode: safeText(data.inviteCode || inviter.inviteCode).trim().toUpperCase(),
        rewarded: true,
        rewardType: 'retro_card',
        rewardCount: 1,
        bindingSource,
        inviterStaffEligibleAt,
        eligibleForSupplyReimbursement: Boolean(inviterStaffEligibleAt),
        rewardAmount,
        rewardEarningId: '',
        createdAt: time,
        updatedAt: time
      }

      const clientWriter = tx ? tx.collection('user_invites') : db.collection('user_invites')
      const userWriter = tx ? tx.collection('users') : db.collection('users')
      const logWriter = tx ? tx.collection('retro_card_logs') : db.collection('retro_card_logs')
      const bonusVoteWriter = tx ? tx.collection('pet_beauty_bonus_votes') : db.collection('pet_beauty_bonus_votes')

      await clientWriter.doc(inviteDocId).set({ data: inviteRecord })
      await userWriter.doc(currentUser._id).update({ data: { inviterOpenid: inviter.openid, updatedAt: time } })

      let inviterDoc = null
      try {
        const inviterRes = await (tx || db).collection('users').doc(inviter._id).get()
        inviterDoc = inviterRes && (inviterRes.data || inviterRes)
      } catch (_) {}
      const currentCards = Number((inviterDoc && inviterDoc.retroCardCount) !== undefined ? inviterDoc.retroCardCount : (inviter.retroCardCount || 0))
      const nextCards = currentCards + 1
      const updateValue = typeof incUpdateValue === 'function'
        ? incUpdateValue(inviterDoc && inviterDoc.retroCardCount, 1)
        : (db.command && typeof db.command.inc === 'function' ? db.command.inc(1) : nextCards)
      await userWriter.doc(inviter._id).update({ data: { retroCardCount: updateValue, updatedAt: time } })
      await logWriter.add({
        data: {
          userId: inviter._id,
          openid: inviter.openid,
          delta: 1,
          balance: nextCards,
          sourceType: 'invite_first_login',
          sourceId: currentUser.openid,
          reason: '邀请新用户首登奖励补签卡 +1',
          createdAt: time
        }
      })

      // 邀请新用户成功首登绑定，为邀请人额外发放当日最美大赛投票数 +1 (当日有效，多邀多得)
      const currentDayKey = (typeof toCstParts === 'function' ? toCstParts(time) : {}).dateKey || time.slice(0, 10)
      const bonusVoteDocId = `bonus_vote_${inviter.openid}_${currentUser.openid}`
      await bonusVoteWriter.doc(bonusVoteDocId).set({
        data: {
          openid: inviter.openid,
          userId: inviter._id,
          invitedOpenid: currentUser.openid,
          invitedUserId: currentUser._id,
          dateKey: currentDayKey,
          source: 'invite_new_user',
          createdAt: time
        }
      })

      return { bound: true, inviterOpenid: inviter.openid, inviteRecord }
    }

    let result = null
    if (typeof db.runTransaction === 'function') {
      try {
        result = await db.runTransaction(executeBind)
      } catch (err) {
        const fallbackRes = await db.collection('user_invites').where({ invitedOpenid: currentUser.openid }).limit(1).get().catch(() => ({ data: [] }))
        const existing = fallbackRes.data && fallbackRes.data[0]
        return { ...currentUser, inviterOpenid: (existing && existing.inviterOpenid) || currentUser.inviterOpenid || '', updatedAt: time }
      }
    } else {
      result = await executeBind(null)
    }

    const persistedInvite = await db.collection('user_invites').doc(inviteDocId).get().catch(() => ({ data: null }))
    const rawBoundInvite = (result && (result.inviteRecord || result.existing)) || (persistedInvite && persistedInvite.data)
    const boundInvite = rawBoundInvite && { ...rawBoundInvite, _id: rawBoundInvite._id || inviteDocId }
    if (boundInvite && typeof grantInviteReward === 'function') {
      try {
        await grantInviteReward(boundInvite, { settings: invitationSettings(systemSettings) })
      } catch (rewardError) {
        // Binding remains durable; deterministic reward record will be retried on next login.
      }
    }
    return { ...currentUser, inviterOpenid: (result && result.inviterOpenid) || currentUser.inviterOpenid || '', updatedAt: time }
  }

  return {
    normalizeBenefits,
    calcMemberLevel,
    resolveUserMemberLevel,
    enrichUserMemberLevel,
    getMemberLevels,
    normalizeTargetLevelIds,
    resolveTargetLevels,
    syncUsersMemberLevelName,
    recalcUsersForDeletedLevel,
    createInviteCode,
    normalizeMonthKey,
    resolveInviter,
    bindInviteRelation
  }
}
