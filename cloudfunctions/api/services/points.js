module.exports = function createService({
  calcMemberLevel,
  db,
  getMemberLevels,
  now
}) {
  async function addPoints(openid, userId, delta, sourceType, sourceId, reason, options = {}) {
    const userRes = await db.collection('users').where({ openid }).limit(1).get()
    const user = userRes.data[0]
    if (!user) return { delta: 0, multiplier: 1, balance: 0 }
    const baseDelta = Number(options.baseDelta !== undefined ? options.baseDelta : delta)
    const currentPoints = Number(user.points || 0)
    const currentTotal = Number(user.totalPoints || 0)
    if (options.idempotencyKey) {
      const existing = (await db.collection('point_logs').where({ openid, idempotencyKey: options.idempotencyKey }).limit(1).get()).data[0]
      if (existing) {
        return { delta: existing.delta, multiplier: existing.multiplier, balance: existing.balance, totalPoints: currentTotal }
      }
    }
    const currentLevels = await getMemberLevels()
    const currentLevelInfo = calcMemberLevel(currentTotal, currentLevels)
    const multiplier = options.applyMultiplier && baseDelta > 0 ? Math.max(Number(currentLevelInfo.pointMultiplier || 1), 1) : 1
    const finalDelta = baseDelta > 0 ? Math.max(Math.round(baseDelta * multiplier), 1) : Number(delta || 0)
    const newPoints = Math.max(currentPoints + finalDelta, 0)
    const newTotal = finalDelta > 0 ? currentTotal + finalDelta : currentTotal
    const levelInfo = calcMemberLevel(newTotal, currentLevels)
    const time = now()
    await db.collection('point_logs').add({
      data: {
        userId: user._id,
        openid,
        delta: finalDelta,
        baseDelta,
        multiplier,
        balance: newPoints,
        reason: reason || '',
        sourceType: sourceType || '',
        sourceId: sourceId || '',
        idempotencyKey: options.idempotencyKey || '',
        lotteryRecordId: options.lotteryRecordId || '',
        createdAt: time
      }
    })
    await db.collection('users').doc(user._id).update({
      data: {
        points: newPoints,
        totalPoints: newTotal,
        memberLevel: levelInfo.memberLevel,
        memberLevelName: levelInfo.memberLevelName,
        badgeTag: levelInfo.badgeTag,
        badgeStyle: levelInfo.badgeStyle,
        nameColor: levelInfo.nameColor,
        nameEffect: levelInfo.nameEffect,
        updatedAt: time
      }
    })
    return { delta: finalDelta, multiplier, balance: newPoints, totalPoints: newTotal, memberLevelName: levelInfo.memberLevelName, badgeTag: levelInfo.badgeTag, badgeStyle: levelInfo.badgeStyle, nameColor: levelInfo.nameColor, nameEffect: levelInfo.nameEffect }
  }

  return {
    addPoints
  }
}
