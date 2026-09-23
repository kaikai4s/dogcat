module.exports = function createService({
  addPoints,
  db,
  defaultCheckinDays,
  getSystemSettings,
  getUser,
  issueCouponToTargetUser,
  now,
  safeText,
  toCstParts
}) {
  async function getMonthConfig(monthKey) {
    const configRes = await db.collection('checkin_month_configs').where({ monthKey }).limit(1).get()
    return configRes.data[0] || null
  }

  async function ensureMonthConfig(monthKey) {
    const existing = await getMonthConfig(monthKey)
    if (existing) return existing
    const time = now()
    const created = await db.collection('checkin_month_configs').add({ data: { monthKey, days: defaultCheckinDays(monthKey), status: 'draft', createdAt: time, updatedAt: time } })
    return { _id: created._id, monthKey, days: defaultCheckinDays(monthKey), status: 'draft', createdAt: time, updatedAt: time }
  }

  function normalizeCheckinReward(dayConfig, day) {
    const rewardType = ['points', 'coupon', 'none'].includes(dayConfig && dayConfig.rewardType) ? dayConfig.rewardType : 'points'
    return {
      day,
      rewardType,
      points: Math.max(Math.round(Number((dayConfig && dayConfig.points) || 0)), 0),
      couponTemplateId: safeText(dayConfig && dayConfig.couponTemplateId).trim(),
      couponSnapshot: dayConfig && dayConfig.couponSnapshot ? dayConfig.couponSnapshot : null,
      title: safeText(dayConfig && dayConfig.title).trim() || `第${day}天奖励`,
      desc: safeText(dayConfig && dayConfig.desc).trim()
    }
  }

  async function claimCheckinReward(user, reward, dateInfo, checkinType, options = {}) {
    const rewardSnapshot = { ...reward }
    let pointsDelta = 0
    let couponId = ''
    const idempotencyKey = options.idempotencyKey || `checkin_${user.openid}_${dateInfo.dateKey}`
    if (reward.rewardType === 'points' && reward.points > 0) {
      const result = await addPoints(
        user.openid,
        user._id,
        reward.points,
        'checkin_daily',
        dateInfo.dateKey,
        `签到奖励 +${reward.points} 积分`,
        { applyMultiplier: true, baseDelta: reward.points, idempotencyKey }
      )
      pointsDelta = result.delta
      rewardSnapshot.finalPoints = result.delta
      rewardSnapshot.multiplier = result.multiplier
    }
    if (reward.rewardType === 'coupon' && reward.couponTemplateId) {
      const template = (await db.collection('coupon_templates').doc(reward.couponTemplateId).get()).data
      const issued = await issueCouponToTargetUser(template, user, {
        idempotencyKey,
        sourceType: 'checkin',
        sourceId: dateInfo.dateKey
      })
      couponId = issued._id
      rewardSnapshot.couponSnapshot = issued.templateSnapshot
    }
    return { rewardSnapshot, pointsDelta, couponId, checkinType }
  }

  async function executeDailyCheckin(openid, options = {}) {
    const allowAlreadyCheckedIn = options.allowAlreadyCheckedIn === true
    const user = await getUser(openid)
    const todayInfo = toCstParts()
    const checkinId = `checkin_${openid}_${todayInfo.dateKey}`

    // 1. 快速检查是否已签到
    let existing = null
    try {
      const doc = await db.collection('user_checkins').doc(checkinId).get()
      existing = doc && doc.data ? doc.data : null
    } catch (e) {
      existing = null
    }

    if (!existing) {
      // 兼容历史未采用固定 checkinId 的签到记录
      const legacy = (await db.collection('user_checkins').where({
        openid,
        dateKey: todayInfo.dateKey
      }).limit(1).get()).data[0]
      if (legacy) {
        existing = legacy
      }
    }

    if (existing) {
      if (existing.status !== 'processing') {
        if (!allowAlreadyCheckedIn) {
          throw new Error('今天已签到')
        }
        return {
          alreadyCheckedIn: true,
          checkinRecord: existing,
          user,
          claimed: {
            pointsDelta: existing.pointsDelta || 0,
            couponId: existing.couponId || '',
            rewardSnapshot: existing.rewardSnapshot || {}
          }
        }
      }
    }

    const config = await ensureMonthConfig(todayInfo.monthKey)
    const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === todayInfo.dayNumber) || {}, todayInfo.dayNumber)
    const time = now()

    let isPlaceHolderClaimed = false
    let txExistingDoc = null

    // 2. 事务并发占位（使用 用户 + 日期 确定性 ID 占位）
    if (!existing) {
      const txResult = await db.runTransaction(async (tx) => {
        let txDoc = null
        try {
          const rec = await tx.collection('user_checkins').doc(checkinId).get()
          txDoc = rec && rec.data ? rec.data : null
        } catch (e) {
          txDoc = null
        }

        if (txDoc) {
          if (!allowAlreadyCheckedIn) {
            throw new Error('今天已签到')
          }
          return { isOwner: false, existingDoc: txDoc }
        }

        await tx.collection('user_checkins').doc(checkinId).set({
          data: {
            _id: checkinId,
            userId: user._id,
            openid,
            monthKey: todayInfo.monthKey,
            dateKey: todayInfo.dateKey,
            day: todayInfo.dayNumber,
            checkinType: 'normal',
            usedRetroCard: false,
            status: 'processing',
            rewardSnapshot: reward,
            pointsDelta: 0,
            couponId: '',
            createdAt: time,
            updatedAt: time
          }
        })

        return { isOwner: true, existingDoc: null }
      })

      isPlaceHolderClaimed = txResult?.isOwner === true
      txExistingDoc = txResult?.existingDoc
    }

    // 若不是当前请求占位成功的，说明已被其他并发占位或已签到
    if (!isPlaceHolderClaimed) {
      if (!allowAlreadyCheckedIn) {
        throw new Error('今天已签到')
      }
      const finalDoc = txExistingDoc || existing || (await db.collection('user_checkins').doc(checkinId).get().catch(() => null))?.data
      return {
        alreadyCheckedIn: true,
        checkinRecord: finalDoc || { _id: checkinId, monthKey: todayInfo.monthKey, dateKey: todayInfo.dateKey },
        user: await getUser(openid),
        claimed: {
          pointsDelta: finalDoc?.pointsDelta || 0,
          couponId: finalDoc?.couponId || '',
          rewardSnapshot: finalDoc?.rewardSnapshot || {}
        }
      }
    }

    // 3. 履约发奖（带幂等 key checkinId）
    let claimed = null
    try {
      claimed = await claimCheckinReward(user, reward, todayInfo, 'normal', { idempotencyKey: checkinId })
      await db.collection('user_checkins').doc(checkinId).update({
        data: {
          status: 'completed',
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          updatedAt: now()
        }
      })
    } catch (err) {
      const checkDoc = (await db.collection('user_checkins').doc(checkinId).get().catch(() => null))?.data
      if (checkDoc && checkDoc.status === 'processing' && !checkDoc.couponId && !checkDoc.pointsDelta) {
        await db.collection('user_checkins').doc(checkinId).remove().catch(() => {})
      }
      throw err
    }

    const updatedUser = await getUser(openid)
    return {
      alreadyCheckedIn: false,
      checkinRecord: {
        _id: checkinId,
        monthKey: todayInfo.monthKey,
        dateKey: todayInfo.dateKey,
        day: todayInfo.dayNumber,
        checkinType: 'normal',
        usedRetroCard: false,
        status: 'completed',
        rewardSnapshot: claimed.rewardSnapshot,
        pointsDelta: claimed.pointsDelta,
        couponId: claimed.couponId || '',
        createdAt: time,
        updatedAt: now()
      },
      user: updatedUser,
      claimed
    }
  }

  async function buildMonthCalendar(openid, monthKey) {
    const user = await getUser(openid)
    const config = await ensureMonthConfig(monthKey)
    const checkinsRes = await db.collection('user_checkins').where({ openid, monthKey }).get()
    const checkinMap = (checkinsRes.data || [])
      .filter((item) => item.status !== 'failed')
      .reduce((map, item) => ({ ...map, [item.day]: item }), {})
    const todayInfo = toCstParts()
    const days = defaultCheckinDays(monthKey).map((fallback) => {
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === fallback.day) || fallback, fallback.day)
      const checkin = checkinMap[fallback.day]
      const isPast = monthKey < todayInfo.monthKey || (monthKey === todayInfo.monthKey && fallback.day < todayInfo.dayNumber)
      const isToday = monthKey === todayInfo.monthKey && fallback.day === todayInfo.dayNumber
      return {
        ...reward,
        checked: Boolean(checkin),
        checkinType: checkin ? checkin.checkinType : '',
        rewardSnapshot: checkin ? (checkin.rewardSnapshot || reward) : reward,
        canCheckin: isToday && !checkin,
        canRetro: isPast && !checkin && Number(user.retroCardCount || 0) > 0,
        rewardStatus: checkin ? 'claimed' : (isToday ? 'today' : (isPast ? 'missed' : 'future'))
      }
    })
    const settings = await getSystemSettings()
    return {
      monthKey,
      retroCardCount: Number(user.retroCardCount || 0),
      points: Number(user.points || 0),
      memberLevelName: user.memberLevelName || '普通会员',
      days,
      shareTitle: (settings.checkinShare && settings.checkinShare.title) || '来签到领福利，补签卡也能拿',
      shareImageUrl: (settings.checkinShare && settings.checkinShare.imageUrl) || ''
    }
  }

  return {
    getMonthConfig,
    ensureMonthConfig,
    normalizeCheckinReward,
    claimCheckinReward,
    buildMonthCalendar,
    executeDailyCheckin
  }
}
