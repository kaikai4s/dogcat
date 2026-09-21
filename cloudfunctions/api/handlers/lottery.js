module.exports = function createHandler(context) {
  const {
    cstTodayStart,
    db,
    getUser,
    incUpdateValue,
    normalizeCouponSnapshot,
    now
  } = context
  return async function lottery(openid, action, data) {
    if (action === 'getActiveActivity') {
      // 不要求登录，首页可公开展示活动信息；已登录时返回今日剩余抽奖次数
      const res = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = res.data[0] || null
      if (!activity) return null

      let remainingDrawCount = openid ? 1 : 0
      if (openid) {
        const todayStart = cstTodayStart()
        const todayRecord = await db.collection('lottery_records')
          .where({ openid, activityId: activity._id })
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get()
        if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
          remainingDrawCount = 0
        }
      }

      return {
        _id: activity._id,
        name: activity.name,
        description: activity.description || '',
        prizeCount: (activity.prizes || []).length,
        remainingDrawCount,
        canDraw: remainingDrawCount > 0
      }
    }
    if (action === 'listMyRecords') {
      const user = await getUser(openid)
      const pageSize = Math.min(Math.max(Math.round(Number(data.pageSize || 20)), 1), 50)
      const records = await db.collection('lottery_records')
        .where({ openid: user.openid || openid })
        .orderBy('createdAt', 'desc')
        .limit(pageSize)
        .get()
      return (records.data || []).map((item) => ({
        _id: item._id,
        activityId: item.activityId || '',
        prizeName: item.prizeName || '谢谢参与',
        couponId: item.couponId || '',
        createdAt: item.createdAt || ''
      }))
    }
    if (action === 'draw') {
      const user = await getUser(openid)
      const activityRes = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = activityRes.data[0]
      if (!activity) throw new Error('当前没有进行中的抽奖活动')

      // 防竞态：先写抽奖记录占位，再判断今日是否已抽
      const todayStart = cstTodayStart()
      const todayRecord = await db.collection('lottery_records')
        .where({ openid, activityId: activity._id })
        .orderBy('createdAt', 'desc').limit(1).get()
      if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
        throw new Error('今天已参与过本次抽奖')
      }

      // 重新从数据库读取最新 activity 数据，防止库存基于旧内存
      const freshActivity = (await db.collection('lottery_activities').doc(activity._id).get()).data
      const prizes = (freshActivity.prizes || []).filter((p) => Number(p.stockLeft || 0) > 0)
      if (!prizes.length) throw new Error('奖品已被领完')

      // 按概率抽取，用 index 而非 templateId 匹配，避免同模板多奖品误扣
      const rand = Math.random() * prizes.reduce((sum, p) => sum + Number(p.probability || 0), 0)
      let cumulative = 0
      let prizeIndex = prizes.length - 1
      for (let i = 0; i < prizes.length; i++) {
        cumulative += Number(prizes[i].probability || 0)
        if (rand <= cumulative) { prizeIndex = i; break }
      }
      const prize = prizes[prizeIndex]

      // 找到该奖品在原始 prizes 数组中的位置（按 name+templateId 精确匹配第一个库存>0的）
      let originalIndex = -1
      let matchCount = 0
      for (let i = 0; i < freshActivity.prizes.length; i++) {
        const p = freshActivity.prizes[i]
        if (p.name === prize.name && p.templateId === prize.templateId && Number(p.stockLeft || 0) > 0) {
          if (matchCount === prizeIndex - prizes.indexOf(prize)) { originalIndex = i; break }
          matchCount++
        }
      }
      // 降级：找第一个匹配
      if (originalIndex === -1) {
        originalIndex = freshActivity.prizes.findIndex(
          (p) => p.name === prize.name && p.templateId === prize.templateId && Number(p.stockLeft || 0) > 0
        )
      }

      const time = now()
      const validDays = 30
      const validTo = new Date(time.getTime() + validDays * 86400000)
      let couponId = ''
      let templateSnapshot = null

      if (prize.templateId) {
        const template = (await db.collection('coupon_templates').doc(prize.templateId).get()).data
        if (template && template.enabled !== false) {
          templateSnapshot = normalizeCouponSnapshot(template)
          const coupon = await db.collection('user_coupons').add({
            data: { templateId: prize.templateId, templateSnapshot, userId: user._id, openid, status: 'available', validFrom: time, validTo, lockedOrderId: '', lockedAt: null, usedOrderId: '', usedAt: null, issuedAt: time, createdAt: time, updatedAt: time }
          })
          couponId = coupon._id
          await db.collection('coupon_templates').doc(prize.templateId).update({
            data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time }
          })
        }
      }

      // 用原子操作更新指定奖品库存，避免竞态超发
      if (originalIndex !== -1) {
        const updatedPrizes = freshActivity.prizes.map((p, i) =>
          i === originalIndex ? { ...p, stockLeft: Math.max(Number(p.stockLeft || 0) - 1, 0) } : p
        )
        await db.collection('lottery_activities').doc(activity._id).update({
          data: { prizes: updatedPrizes, updatedAt: time }
        })
      }

      await db.collection('lottery_records').add({
        data: { userId: user._id, openid, activityId: activity._id, prizeTemplateId: prize.templateId || '', prizeName: prize.name || '谢谢参与', couponId, createdAt: time }
      })
      return { prizeName: prize.name || '谢谢参与', couponId, templateSnapshot }
    }
    throw new Error('未知 lottery 操作')
  }
}
