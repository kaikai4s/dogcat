module.exports = function createService({
  db,
  normalizeTargetLevelIds,
  resolveTargetLevels,
  safeText
}) {
  function rewardMailStatusText(mail) {
    if (mail.claimedAt) return '已领取'
    if (mail.readAt) return '待领取'
    return '未读'
  }

  function formatRewardMail(mail) {
    const reward = mail.reward || {}
    return {
      _id: mail._id,
      title: safeText(mail.title).trim() || '奖励到账提醒',
      content: safeText(mail.content).trim(),
      targetLevels: Array.isArray(mail.targetLevels) ? mail.targetLevels : [],
      rewardType: reward.type || 'points',
      reward,
      readAt: mail.readAt || null,
      claimedAt: mail.claimedAt || null,
      rewardClaimResult: mail.rewardClaimResult || null,
      createdAt: mail.createdAt,
      updatedAt: mail.updatedAt,
      unread: !mail.readAt,
      claimable: !mail.claimedAt,
      statusText: rewardMailStatusText(mail)
    }
  }

  function parseOpenidList(value) {
    if (Array.isArray(value)) return value.map((item) => safeText(item).trim()).filter(Boolean)
    return safeText(value).split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)
  }

  async function resolveRewardMailTargets(data = {}) {
    const targetType = safeText(data.targetType).trim() || 'openid_list'
    const usersRes = await db.collection('users').where({ status: 'active' }).get()
    const users = usersRes.data || []
    if (targetType === 'all_active') return { targetType, users }
    if (targetType === 'role') {
      const role = safeText(data.role).trim()
      if (!['client', 'staff', 'admin'].includes(role)) throw new Error('请选择有效角色')
      return { targetType, role, users: users.filter((user) => Array.isArray(user.roles) && user.roles.includes(role)) }
    }
    if (targetType === 'member_level') {
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      return { targetType, targetLevelIds, targetLevelNamesSnapshot: targetLevels.map((level) => level.name), users: users.filter((user) => targetLevelIds.includes(user.memberLevel || '')) }
    }
    const openids = Array.from(new Set(parseOpenidList(data.openids)))
    if (!openids.length) throw new Error('请输入至少一个用户 openid')
    return { targetType: 'openid_list', openids, users: users.filter((user) => openids.includes(user.openid)) }
  }

  return {
    rewardMailStatusText,
    formatRewardMail,
    parseOpenidList,
    resolveRewardMailTargets
  }
}
