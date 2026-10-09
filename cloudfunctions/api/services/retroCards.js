const crypto = require('crypto')

module.exports = function createService({
  db,
  now
}) {
  async function getRewardMailRetroCardGrant(openid, sourceId) {
    const log = (await db.collection('retro_card_logs').where({ openid, sourceType: 'reward_mail', sourceId }).limit(1).get()).data[0]
    if (!log) return null
    return { balance: Number(log.balance || 0), delta: Number(log.delta || 0) }
  }

  async function resetRewardClaimResultField(mailId) {
    const command = db.command || {}
    if (typeof command.remove === 'function') {
      await db.collection('reward_mails').doc(mailId).update({ data: { rewardClaimResult: command.remove() } })
      return
    }
    if (typeof command.set === 'function') {
      await db.collection('reward_mails').doc(mailId).update({ data: { rewardClaimResult: command.set({}) } })
      return
    }
    await db.collection('reward_mails').doc(mailId).update({ data: { rewardClaimResult: {} } })
  }

  async function grantRetroCards(openid, userId, delta, sourceType, sourceId, reason, options = {}) {
    const userRes = await db.collection('users').where({ openid }).limit(1).get()
    const user = userRes.data[0]
    if (!user) return { balance: 0 }
    const amount = Number(delta || 0)
    if (!amount) return { balance: Number(user.retroCardCount || 0) }
    if (!Number.isSafeInteger(amount)) throw new Error('补签卡数量不正确')
    const businessKey = options.idempotencyKey || (amount > 0 && sourceType && sourceId ? `${sourceType}:${sourceId}` : '')
    const id = `rc_${businessKey ? crypto.createHash('sha256').update(JSON.stringify([openid, businessKey])).digest('hex').slice(0, 32) : crypto.randomBytes(16).toString('hex')}`
    const execute = async tx => {
      const latest = (await tx.collection('users').doc(user._id).get()).data
      if (!latest || latest.openid !== openid) throw new Error('补签卡用户不存在')
      if (businessKey) {
        let existing
        try { existing = (await tx.collection('retro_card_logs').doc(id).get()).data } catch (error) {
          if (!String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) throw error
        }
        if (!existing) {
          const legacy = (await db.collection('retro_card_logs').where({ openid, sourceType, sourceId }).limit(1).get()).data[0]
          if (legacy) existing = (await tx.collection('retro_card_logs').doc(legacy._id).get()).data
        }
        if (existing) return { balance: existing.balance, duplicate: true }
      }
      const balance = Number(latest.retroCardCount || 0) + amount
      if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('补签卡不足或余额异常')
      const time = now()
      await tx.collection('users').doc(user._id).update({ data: { retroCardCount: balance, updatedAt: time } })
      await tx.collection('retro_card_logs').doc(id).set({
        data: { userId: latest._id, openid, delta: amount, balance, sourceType: sourceType || '', sourceId: sourceId || '', reason: reason || '', createdAt: time }
      })
      return { balance }
    }
    return options.transaction ? execute(options.transaction) : db.runTransaction(execute)
  }

  return {
    getRewardMailRetroCardGrant,
    resetRewardClaimResultField,
    grantRetroCards
  }
}
