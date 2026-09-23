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

  async function readAllUsers(where = {}, maxLimit = 5000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection('users').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
    return rows
  }

  async function resolveRewardMailTargets(data = {}) {
    const targetType = safeText(data.targetType).trim() || 'openid_list'

    if (targetType === 'all_active') {
      const users = await readAllUsers({ status: 'active' }, 5000)
      return { targetType, users }
    }

    if (targetType === 'role') {
      const role = safeText(data.role).trim()
      if (!['client', 'staff', 'admin'].includes(role)) throw new Error('请选择有效角色')
      const where = {
        status: 'active',
        roles: db.command && typeof db.command.in === 'function' ? db.command.in([role]) : role
      }
      const users = await readAllUsers(where, 5000)
      const filtered = users.filter((user) => Array.isArray(user.roles) && user.roles.includes(role))
      return { targetType, role, users: filtered }
    }

    if (targetType === 'member_level') {
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const where = {
        status: 'active',
        memberLevel: db.command && typeof db.command.in === 'function' ? db.command.in(targetLevelIds) : targetLevelIds
      }
      const users = await readAllUsers(where, 5000)
      const filtered = users.filter((user) => targetLevelIds.includes(user.memberLevel || ''))
      return { targetType, targetLevelIds, targetLevelNamesSnapshot, users: filtered }
    }

    const openids = Array.from(new Set(parseOpenidList(data.openids)))
    if (!openids.length) throw new Error('请输入至少一个用户 openid')
    const targetUsers = []
    const chunkSize = 50
    for (let i = 0; i < openids.length; i += chunkSize) {
      const chunk = openids.slice(i, i + chunkSize)
      try {
        const condition = {
          status: 'active',
          openid: db.command && typeof db.command.in === 'function' ? db.command.in(chunk) : chunk
        }
        const res = await db.collection('users').where(condition).get()
        targetUsers.push(...(res.data || []))
      } catch (_) {
        for (const id of chunk) {
          try {
            const single = await db.collection('users').where({ status: 'active', openid: id }).limit(1).get()
            targetUsers.push(...(single.data || []))
          } catch (err) {}
        }
      }
    }
    return { targetType: 'openid_list', openids, users: targetUsers }
  }

  return {
    rewardMailStatusText,
    formatRewardMail,
    parseOpenidList,
    resolveRewardMailTargets
  }
}
