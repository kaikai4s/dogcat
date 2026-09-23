module.exports = function createService({
  db,
  getOptionalUser,
  grantRetroCards,
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
    const inviter = await resolveInviter(data)
    if (!inviter || inviter.openid === currentUser.openid) return currentUser
    const existing = (await db.collection('user_invites').where({ invitedOpenid: currentUser.openid }).limit(1).get()).data[0]
    if (existing) return { ...currentUser, inviterOpenid: existing.inviterOpenid || currentUser.inviterOpenid || '' }
    await db.collection('user_invites').add({
      data: {
        inviterUserId: inviter._id,
        inviterOpenid: inviter.openid,
        invitedUserId: currentUser._id,
        invitedOpenid: currentUser.openid,
        rewarded: true,
        rewardType: 'retro_card',
        rewardCount: 1,
        createdAt: time,
        updatedAt: time
      }
    })
    await db.collection('users').doc(currentUser._id).update({ data: { inviterOpenid: inviter.openid, updatedAt: time } })
    await grantRetroCards(inviter.openid, inviter._id, 1, 'invite_first_login', currentUser.openid, '邀请新用户首登奖励补签卡 +1')
    return { ...currentUser, inviterOpenid: inviter.openid, updatedAt: time }
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
