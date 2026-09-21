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

  async function claimCheckinReward(user, reward, dateInfo, checkinType) {
    const rewardSnapshot = { ...reward }
    let pointsDelta = 0
    let couponId = ''
    if (reward.rewardType === 'points' && reward.points > 0) {
      const result = await addPoints(user.openid, user._id, reward.points, 'checkin_daily', dateInfo.dateKey, `签到奖励 +${reward.points} 积分`, { applyMultiplier: true, baseDelta: reward.points })
      pointsDelta = result.delta
      rewardSnapshot.finalPoints = result.delta
      rewardSnapshot.multiplier = result.multiplier
    }
    if (reward.rewardType === 'coupon' && reward.couponTemplateId) {
      const template = (await db.collection('coupon_templates').doc(reward.couponTemplateId).get()).data
      const issued = await issueCouponToTargetUser(template, user)
      couponId = issued._id
      rewardSnapshot.couponSnapshot = issued.templateSnapshot
    }
    return { rewardSnapshot, pointsDelta, couponId, checkinType }
  }

  async function buildMonthCalendar(openid, monthKey) {
    const user = await getUser(openid)
    const config = await ensureMonthConfig(monthKey)
    const checkinsRes = await db.collection('user_checkins').where({ openid, monthKey }).get()
    const checkinMap = (checkinsRes.data || []).reduce((map, item) => ({ ...map, [item.day]: item }), {})
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
    buildMonthCalendar
  }
}
