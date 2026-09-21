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

  async function grantRetroCards(openid, userId, delta, sourceType, sourceId, reason) {
    const userRes = await db.collection('users').where({ openid }).limit(1).get()
    const user = userRes.data[0]
    if (!user) return { balance: 0 }
    const amount = Number(delta || 0)
    if (!amount) return { balance: Number(user.retroCardCount || 0) }
    const time = now()
    const command = db.command || {}
    const hasAtomicInc = typeof command.inc === 'function'
    const currentBalance = Number(user.retroCardCount || 0)

    if (amount < 0 && hasAtomicInc && typeof command.gte === 'function') {
      const updated = await db.collection('users').where({ openid, retroCardCount: command.gte(Math.abs(amount)) }).update({
        data: { retroCardCount: command.inc(amount), updatedAt: time }
      })
      if (!updated.stats || Number(updated.stats.updated || 0) <= 0) throw new Error('补签卡不足')
    } else {
      if (amount < 0 && currentBalance < Math.abs(amount)) throw new Error('补签卡不足')
      const nextBalance = Math.max(currentBalance + amount, 0)
      await db.collection('users').doc(user._id).update({
        data: { retroCardCount: hasAtomicInc ? command.inc(amount) : nextBalance, updatedAt: time }
      })
    }

    const latest = (await db.collection('users').doc(user._id).get()).data || {}
    const balance = Number(latest.retroCardCount || 0)
    await db.collection('retro_card_logs').add({
      data: { userId: userId || user._id, openid, delta: amount, balance, sourceType: sourceType || '', sourceId: sourceId || '', reason: reason || '', createdAt: time }
    })
    return { balance }
  }

  return {
    getRewardMailRetroCardGrant,
    resetRewardClaimResultField,
    grantRetroCards
  }
}
