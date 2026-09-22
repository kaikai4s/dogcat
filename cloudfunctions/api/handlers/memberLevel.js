module.exports = function createHandler(context) {
  const {
    db,
    getMemberLevels,
    getUser,
    grantEligiblePetTitlesForUser,
    normalizeBenefits,
    normalizeMemberBadgeStyle,
    normalizeMemberBadgeTag,
    normalizeMemberNameColor,
    normalizeMemberNameEffect,
    safeText
  } = context
  return async function memberLevel(openid, action, data) {
    if (action === 'listLevels') {
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
    if (action === 'myInfo') {
      const user = await getUser(openid)
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = 20
      const logsRes = await db.collection('point_logs').where({ openid }).orderBy('createdAt', 'desc').limit(page * pageSize).get()
      const countRes = await db.collection('point_logs').where({ openid }).count()
      const allLogs = logsRes.data || []
      const logs = allLogs.slice((page - 1) * pageSize, page * pageSize)
      const levels = (await getMemberLevels()).map((level, idx) => ({
        ...level,
        badgeTag: normalizeMemberBadgeTag(level.badgeTag) || `V${idx + 1}`,
        nameColor: normalizeMemberNameColor(level.nameColor),
        nameEffect: normalizeMemberNameEffect(level.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(level.badgeStyle),
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
      const currentLevel = levels.find((level) => level._id === user.memberLevel) || null
      const nextLevel = levels.find((level) => Number(level.minPoints || 0) > Number(user.totalPoints || 0)) || null
      await grantEligiblePetTitlesForUser(user)
      return {
        points: Number(user.points || 0),
        totalPoints: Number(user.totalPoints || 0),
        memberLevel: user.memberLevel || '',
        memberLevelName: user.memberLevelName || '普通会员',
        pointMultiplier: currentLevel ? Math.max(Number(currentLevel.pointMultiplier || 1), 1) : 1,
        retroCardCount: Number(user.retroCardCount || 0),
        inviteCode: safeText(user.inviteCode).trim(),
        inviterOpenid: safeText(user.inviterOpenid).trim(),
        currentLevel,
        nextLevel,
        levels,
        logs,
        total: countRes.total || 0,
        page,
        pageSize
      }
    }
    throw new Error('未知 memberLevel 操作')
  }
}
