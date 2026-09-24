const crypto = require('crypto')

module.exports = function createService({
  calcMemberLevel,
  db,
  getMemberLevels,
  now,
  safeText
}) {
  function toSafeText(v) {
    return typeof safeText === 'function' ? safeText(v) : (v == null ? '' : String(v))
  }

  async function addPoints(openid, userId, delta, sourceType, sourceId, reason, options = {}) {
    // 1. 定位目标用户
    let targetUser = null
    if (userId) {
      targetUser = (await db.collection('users').doc(userId).get().catch(() => null))?.data
    }
    if (!targetUser && openid) {
      const userRes = await db.collection('users').where({ openid }).limit(1).get()
      targetUser = userRes.data[0]
    }
    if (!targetUser) return { delta: 0, multiplier: 1, balance: 0 }

    const targetUserId = targetUser._id
    const targetOpenid = targetUser.openid || openid

    // 2. 计算业务唯一 key (idempotencyKey / businessKey)
    const rawBusinessKey = options.idempotencyKey ||
      options.businessKey ||
      (sourceType && sourceId && sourceType !== 'admin_grant' ? `${sourceType}_${sourceId}` : '')
    const businessKey = toSafeText(rawBusinessKey).trim()

    // 3. 事前快速校验（避免进入事务，同时兼容历史流水记录）
    if (businessKey) {
      const existing = (await db.collection('point_logs').where({
        openid: targetOpenid,
        idempotencyKey: businessKey
      }).limit(1).get()).data[0]
      if (existing) {
        return {
          delta: existing.delta,
          multiplier: existing.multiplier,
          balance: existing.balance,
          totalPoints: Number(targetUser.totalPoints || 0),
          memberLevelName: targetUser.memberLevelName || '',
          badgeTag: targetUser.badgeTag || '',
          badgeStyle: targetUser.badgeStyle || '',
          nameColor: targetUser.nameColor || '',
          nameEffect: targetUser.nameEffect || '',
          duplicate: true
        }
      }

      // 兼容历史未记录 idempotencyKey 但有 sourceType 与 sourceId 的记录
      if (sourceType && sourceId && sourceType !== 'admin_grant') {
        const legacyLog = (await db.collection('point_logs').where({
          openid: targetOpenid,
          sourceType,
          sourceId
        }).limit(1).get()).data[0]
        if (legacyLog) {
          return {
            delta: legacyLog.delta,
            multiplier: legacyLog.multiplier,
            balance: legacyLog.balance,
            totalPoints: Number(targetUser.totalPoints || 0),
            memberLevelName: targetUser.memberLevelName || '',
            badgeTag: targetUser.badgeTag || '',
            badgeStyle: targetUser.badgeStyle || '',
            nameColor: targetUser.nameColor || '',
            nameEffect: targetUser.nameEffect || '',
            duplicate: true
          }
        }
      }
    }

    // 4. 确定 point_logs 主键 ID（若有 businessKey 则生成确定性 ID，利用主键唯一约束防并发重复）
    let logId = ''
    if (businessKey) {
      const keyComponent = `${targetUserId}_${businessKey}`.replace(/[^a-zA-Z0-9_-]/g, '_')
      if (keyComponent.length > 50) {
        const hash = crypto.createHash('md5').update(`${targetUserId}_${businessKey}`).digest('hex')
        logId = `pl_${hash}`
      } else {
        logId = `pl_${keyComponent}`
      }
    } else {
      logId = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    }

    // 5. 获取等级配置与计算基准
    const currentLevels = await getMemberLevels()
    const baseDelta = Number(options.baseDelta !== undefined ? options.baseDelta : delta)

    // 6. 事务核心逻辑：读最新余额 -> 校验幂等 -> 计算等级与变动 -> 写流水 -> 原子更新用户
    const executeTx = async (tx) => {
      // 6.1 事务内校验流水是否已存在（并发防重）
      if (businessKey) {
        let existingLog = null
        try {
          const logRes = await tx.collection('point_logs').doc(logId).get()
          existingLog = logRes && logRes.data ? logRes.data : null
        } catch (e) {
          existingLog = null
        }
        if (existingLog) {
          const freshUser = (await tx.collection('users').doc(targetUserId).get().catch(() => null))?.data || targetUser
          return {
            delta: existingLog.delta,
            multiplier: existingLog.multiplier,
            balance: existingLog.balance,
            totalPoints: Number(freshUser.totalPoints || 0),
            memberLevelName: freshUser.memberLevelName || '',
            badgeTag: freshUser.badgeTag || '',
            badgeStyle: freshUser.badgeStyle || '',
            nameColor: freshUser.nameColor || '',
            nameEffect: freshUser.nameEffect || '',
            duplicate: true
          }
        }
      }

      // 6.2 事务内读取用户最新余额，杜绝并发覆盖
      const userDocRes = await tx.collection('users').doc(targetUserId).get().catch(() => null)
      const latestUser = userDocRes && userDocRes.data ? userDocRes.data : null
      if (!latestUser) {
        throw new Error(`用户不存在：${targetUserId}`)
      }

      const currentPoints = Number(latestUser.points || 0)
      const currentTotal = Number(latestUser.totalPoints || 0)

      // 6.3 计算倍率、变动值与新余额
      const currentLevelInfo = calcMemberLevel(currentTotal, currentLevels)
      const multiplier = options.applyMultiplier && baseDelta > 0
        ? Math.max(Number(currentLevelInfo.pointMultiplier || 1), 1)
        : 1
      const finalDelta = baseDelta > 0
        ? Math.max(Math.round(baseDelta * multiplier), 1)
        : Number(delta || 0)
      if (finalDelta < 0 && currentPoints + finalDelta < 0) {
        throw new Error(`用户当前可用积分不足（当前剩余 ${currentPoints} 分），无法扣除 ${Math.abs(finalDelta)} 积分`)
      }
      const newPoints = currentPoints + finalDelta
      const newTotal = finalDelta > 0 ? currentTotal + finalDelta : currentTotal
      const levelInfo = calcMemberLevel(newTotal, currentLevels)
      const time = now()

      // 6.4 写入流水（使用确定的 logId 在事务内 set）
      await tx.collection('point_logs').doc(logId).set({
        data: {
          userId: latestUser._id,
          openid: targetOpenid,
          delta: finalDelta,
          baseDelta,
          multiplier,
          balance: newPoints,
          reason: reason || '',
          sourceType: sourceType || '',
          sourceId: sourceId || '',
          idempotencyKey: businessKey,
          lotteryRecordId: options.lotteryRecordId || '',
          createdAt: time
        }
      })

      // 6.5 原子更新用户余额、累计积分和会员等级
      await tx.collection('users').doc(targetUserId).update({
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

      return {
        delta: finalDelta,
        multiplier,
        balance: newPoints,
        totalPoints: newTotal,
        memberLevelName: levelInfo.memberLevelName,
        badgeTag: levelInfo.badgeTag,
        badgeStyle: levelInfo.badgeStyle,
        nameColor: levelInfo.nameColor,
        nameEffect: levelInfo.nameEffect
      }
    }

    if (typeof db.runTransaction === 'function') {
      return await db.runTransaction(executeTx)
    } else {
      return await executeTx(db)
    }
  }

  return {
    addPoints
  }
}
