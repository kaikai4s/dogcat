const { readOptionalDocument } = require('../utils/documentPages')
const { transaction } = require('./playground-transaction')
const world = require('./playground-world')
const inventoryOf = user => Array.isArray(user?.userTitleInventory) ? user.userTitleInventory.filter(item => item && typeof item.id === 'string') : []
const displayState = actor => ({ sceneId: actor?.communityId || '', session: actor?.session || '',
  version: actor ? { epoch: actor.sessionStarted || actor.lastSeen || 0, seq: actor.seq || 0 } : null })

function publicUserTitle(user, sceneId) {
  const title = inventoryOf(user).find(item => item.id === user.equippedUserTitleId && item.enabled !== false)
  if (!title || (title.communityId && world.communityId({ residentialCommunity: { name: title.communityName, serviceCommunityId: title.communityId } }) !== sceneId)) return null
  return { id: title.id, name: title.name, communityName: title.communityName || '', color: '#98661d' }
}

module.exports = function createUserTitles({ db, now, checkRateLimit }) {
  async function grantCommunityFounder(tx, application, community) {
    if (!application.firstApplicantOpenid) return null
    const user = (await tx.collection('users').where({ openid: application.firstApplicantOpenid }).limit(1).get()).data?.[0]
    if (!user || user.status !== 'active') return null
    const id = 'community_founder_' + community._id
    const inventory = inventoryOf(user)
    if (!inventory.some(item => item.id === id)) {
      if (inventory.length >= 200) throw new Error('用户头衔数量达到上限，请联系平台处理')
      await tx.collection('users').doc(user._id).update({ data: { userTitleInventory: [...inventory, {
        id, name: '小区初创者', type: 'community_founder', communityId: community._id,
        communityName: community.name, applicationId: application._id, grantedAt: now(), enabled: true
      }] } })
    }
    return user._id
  }
  function ownTitles(user) {
    const list = inventoryOf(user).filter(item => item.enabled !== false).map(item => ({
      id: item.id, name: item.name, communityId: item.communityId || '', communityName: item.communityName || '',
      grantedAt: item.grantedAt, equipped: item.id === user.equippedUserTitleId
    }))
    return { list, equippedTitle: list.find(item => item.equipped) || null }
  }
  async function state(user) {
    // Read equipment and its scene projection together, rather than mixing
    // an earlier getUser snapshot with a later presence version.
    return transaction(db, async tx => {
      const current = await readOptionalDocument(tx, 'users', user._id)
      if (!current || current.openid !== user.openid || current.status !== 'active') throw new Error('账号不可用')
      const presence = await readOptionalDocument(tx, 'pet_playground_plots', 'presence_' + world.hash(user.openid))
      const actor = presence?.ownerOpenid === user.openid ? presence : null
      return { ...ownTitles(current), ...displayState(actor), publicTitle: publicUserTitle(current, actor?.communityId || '') }
    })
  }
  async function equip(user, titleId) {
    if (typeof titleId !== 'string' || titleId.length > 160) throw new Error('请选择有效头衔')
    if (checkRateLimit) await checkRateLimit(user.openid, 'playground.equipUserTitle', { max: 20 })
    return transaction(db, async tx => {
      const current = await readOptionalDocument(tx, 'users', user._id)
      if (!current || current.openid !== user.openid || current.status !== 'active') throw new Error('账号不可用')
      if (titleId && !inventoryOf(current).some(item => item.id === titleId && item.enabled !== false)) throw new Error('尚未获得该头衔或头衔已停用')
      const updated = { ...current, equippedUserTitleId: titleId }
      await tx.collection('users').doc(user._id).update({ data: { equippedUserTitleId: titleId } })
      const actorId = 'presence_' + world.hash(user.openid)
      const actor = await readOptionalDocument(tx, 'pet_playground_plots', actorId)
      let record = null
      if (actor && actor.ownerOpenid === user.openid) {
        const patch = { userTitle: publicUserTitle(updated, actor.communityId), sessionStarted: Math.max(Date.now(), Number(actor.sessionStarted || 0) + 1) }
        await tx.collection('pet_playground_plots').doc(actorId).update({ data: { ...patch, userTitle: db.command.set(patch.userTitle) } })
        record = { ...actor, ...patch, _id: actorId }
      }
      return { ...ownTitles(updated), publicTitle: record?.userTitle || null, ...displayState(record), record }
    })
  }
  return { grantCommunityFounder, ownUserTitles: ownTitles, getUserTitleState: state, equipUserTitle: equip }
}
module.exports.publicUserTitle = publicUserTitle
