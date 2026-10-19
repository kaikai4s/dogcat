// Unlocks use the existing membership, never a second garden experience balance.
async function memberAccess(db, openid) {
  const users = await db.collection('users').where({ openid }).limit(1).get()
  const user = (users.data || [])[0]
  if (!user || user.status === 'deleted') throw new Error('用户不存在，请重新登录')
  const levels = (await db.collection('member_levels').orderBy('minPoints', 'asc').get()).data || []
  const matched = levels.find((l) => l._id === user.memberLevel) ||
    levels.find((l)=>user.memberLevelName&&l.name===user.memberLevelName) ||
    levels.slice().reverse().find((l) => Number(user.totalPoints===undefined?user.points||0:user.totalPoints) >= Number(l.minPoints || 0))
  return { user, levels, memberLevel: matched ? matched._id : '', memberLevelName: matched ? matched.name : '普通会员' }
}
function levelIds(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== 'string' || !v || v.length > 128))
    throw new Error('请选择有效的会员等级')
  return [...new Set(value)]
}
function unlocked(item, access) {
  return item.enabled !== false && (!(item.unlockLevelIds || []).length || item.unlockLevelIds.includes(access.memberLevel))
}
function decorate(item, access) {
  const ids = item.unlockLevelIds || []
  return { ...item, unlocked: unlocked(item, access), unlockText: ids.length
    ? ids.map((id) => (access.levels.find((l) => l._id === id) || {}).name || '已移除的等级').join('、') + '可用'
    : '所有会员可用' }
}
async function validateLevels(db, ids) {
  const levels = (await db.collection('member_levels').get()).data || []
  if (ids.some((id) => !levels.some((l) => l._id === id))) throw new Error('所选会员等级已变化，请刷新后重新选择')
}
module.exports = { memberAccess, levelIds, unlocked, decorate, validateLevels }
