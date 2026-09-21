module.exports = function createHandler(context) {
  const {
    CHECKIN_EVENT_TYPES,
    ORDER_STATUS,
    appendOrderTimeline,
    buildMonthCalendar,
    canStartOrderSession,
    checkImageSecurity,
    claimCheckinReward,
    db,
    ensureMonthConfig,
    getMonthDays,
    getNextPendingServiceSession,
    getOrderForAccess,
    getUser,
    grantRetroCards,
    hasCheckinPhoto,
    hasCoordinate,
    isActiveCheckin,
    isValidSanitization,
    normalizeCheckinReward,
    normalizeMonthKey,
    now,
    requireStaffOrder,
    safeText,
    toCstParts,
    validateSanitizationMedia
  } = context
  return async function checkin(openid, action, data) {
    if (action === 'getMonthCalendar') {
      await getUser(openid)
      const monthKey = normalizeMonthKey(data.monthKey)
      return buildMonthCalendar(openid, monthKey)
    }
    if (action === 'getMyRetroCards') {
      const user = await getUser(openid)
      const logsRes = await db.collection('retro_card_logs').where({ openid }).orderBy('createdAt', 'desc').get()
      return {
        retroCardCount: Number(user.retroCardCount || 0),
        completedOrderCount: Number(user.completedOrderCount || 0),
        logs: logsRes.data || []
      }
    }
    if (action === 'checkinToday') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const existing = (await db.collection('user_checkins').where({ openid, dateKey: todayInfo.dateKey }).limit(1).get()).data[0]
      if (existing) throw new Error('今天已签到')
      const config = await ensureMonthConfig(todayInfo.monthKey)
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === todayInfo.dayNumber) || {}, todayInfo.dayNumber)
      const claimed = await claimCheckinReward(user, reward, todayInfo, 'normal')
      const time = now()
      const created = await db.collection('user_checkins').add({
        data: {
          userId: user._id,
          openid,
          monthKey: todayInfo.monthKey,
          dateKey: todayInfo.dateKey,
          day: todayInfo.dayNumber,
          checkinType: 'normal',
          usedRetroCard: false,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          createdAt: time,
          updatedAt: time
        }
      })
      return {
        _id: created._id,
        monthKey: todayInfo.monthKey,
        dateKey: todayInfo.dateKey,
        day: todayInfo.dayNumber,
        rewardSnapshot: claimed.rewardSnapshot,
        pointsDelta: claimed.pointsDelta,
        couponId: claimed.couponId || '',
        retroCardCount: Number((await getUser(openid)).retroCardCount || 0)
      }
    }
    if (action === 'retroCheckin') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const monthKey = normalizeMonthKey(data.monthKey || todayInfo.monthKey)
      const day = Math.max(Math.round(Number(data.day || 0)), 1)
      if (monthKey !== todayInfo.monthKey) throw new Error('当前仅支持补签本月日期')
      if (day >= todayInfo.dayNumber) throw new Error('只能补签今天之前的日期')
      if (day > getMonthDays(monthKey)) throw new Error('补签日期无效')
      const dateKey = `${monthKey}-${String(day).padStart(2, '0')}`
      const clientRequestId = safeText(data.clientRequestId).trim()
      if (clientRequestId) {
        const sameRequest = (await db.collection('user_checkins').where({ openid, clientRequestId }).limit(1).get()).data[0]
        if (sameRequest) return { ...sameRequest, retroCardCount: Number((await getUser(openid)).retroCardCount || 0) }
      }
      const existing = (await db.collection('user_checkins').where({ openid, dateKey }).limit(1).get()).data[0]
      if (existing) throw new Error(existing.status === 'processing' ? '补签处理中，请稍后刷新' : '该日期已签到')

      const time = now()
      const checkinId = `checkin_${openid}_${dateKey}`
      let cardSpent = false
      let rewardClaimed = false
      try {
        await db.collection('user_checkins').add({
          data: {
            _id: checkinId,
            userId: user._id,
            openid,
            monthKey,
            dateKey,
            day,
            clientRequestId,
            checkinType: 'retro',
            usedRetroCard: true,
            status: 'processing',
            rewardSnapshot: {},
            pointsDelta: 0,
            couponId: '',
            createdAt: time,
            updatedAt: time
          }
        })
        await grantRetroCards(openid, user._id, -1, 'retro_checkin', dateKey, `补签 ${dateKey} 消耗补签卡 1 张`)
        cardSpent = true
        const config = await ensureMonthConfig(monthKey)
        const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === day) || {}, day)
        const claimed = await claimCheckinReward(user, reward, { monthKey, dateKey, dayNumber: day }, 'retro')
        rewardClaimed = true
        await db.collection('user_checkins').doc(checkinId).update({
          data: {
            status: 'completed',
            rewardSnapshot: claimed.rewardSnapshot,
            pointsDelta: claimed.pointsDelta,
            couponId: claimed.couponId || '',
            updatedAt: now()
          }
        })
        return {
          _id: checkinId,
          monthKey,
          dateKey,
          day,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          retroCardCount: Number((await getUser(openid)).retroCardCount || 0)
        }
      } catch (error) {
        const locked = (await db.collection('user_checkins').where({ openid, dateKey }).limit(1).get()).data[0]
        const isOwnProcessing = locked && locked._id === checkinId && locked.status === 'processing'
        if (cardSpent && !rewardClaimed) {
          await grantRetroCards(openid, user._id, 1, 'retro_checkin_rollback', dateKey, `补签 ${dateKey} 失败退回补签卡 1 张`)
        }
        if (isOwnProcessing && !rewardClaimed) {
          await db.collection('user_checkins').doc(checkinId).remove()
        }
        if (!isOwnProcessing && locked) throw new Error(locked.status === 'processing' ? '补签处理中，请稍后刷新' : '该日期已签到')
        throw error
      }
    }
    if (action === 'createCheckin') {
      const { user, order } = await requireStaffOrder(openid, data.orderId, '仅订单员工可打卡')
      const isSanitization = data.eventType === 'sanitization'
      if (isSanitization) {
        if (![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(order.status)) throw new Error('消毒打卡须在开始服务前完成')
        const session = getNextPendingServiceSession({ ...order, _id: data.orderId })
        if (!session || !(await canStartOrderSession({ ...order, _id: data.orderId }, session))) throw new Error('服务时间未到，可申请提前开始')
        if (data.isBackfilled === true) throw new Error('消毒打卡须现场拍照上传，不支持补传')
      } else if (order.status !== 'in_service') throw new Error('仅服务中可打卡')
      if (!data.eventType) throw new Error('请选择打卡类型')
      if (!CHECKIN_EVENT_TYPES.has(data.eventType)) throw new Error('打卡类型无效')
      if (!data.mediaFileId) throw new Error('请先上传打卡照片')
      if (data.eventType === 'pet_beauty_photo') {
        await checkImageSecurity(openid, data.mediaFileId, { scene: 3, label: '美照' })
      }
      const clientRequestId = safeText(data.clientRequestId).trim()
      if (clientRequestId) {
        const existing = await db.collection('checkin_logs').where({ orderId: data.orderId, clientRequestId }).limit(1).get()
        if (existing.data[0]) {
          if (isSanitization && (!isValidSanitization(existing.data[0], order) || existing.data[0].mediaFileId !== data.mediaFileId)) throw new Error('消毒打卡请求已失效，请重新拍照')
          if (isSanitization) await validateSanitizationMedia(data.mediaFileId, data.orderId, openid)
          return existing.data[0]
        }
      }
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('打卡定位无效')
      const time = now()
      if (isSanitization) {
        await validateSanitizationMedia(data.mediaFileId, data.orderId, openid)
        const parts = data.mediaFileId.slice(data.mediaFileId.lastIndexOf('/') + 1).split('_')
        const uploadedAt = Number(parts[0])
        if (Number.isFinite(uploadedAt) && uploadedAt > 0 && (uploadedAt > time.getTime() + 60000 || time.getTime() - uploadedAt > 15 * 60 * 1000)) {
          throw new Error('消毒照片已过期，请重新现场拍照')
        }
        const reused = await db.collection('checkin_logs').where({ mediaFileId: data.mediaFileId }).limit(1).get()
        if (reused.data.length) throw new Error('消毒照片已使用，请重新现场拍照')
      }
      const recordedAt = isSanitization ? time : (data.recordedAt || time)
      const existingEventPhotos = await db.collection('checkin_logs').where({ orderId: data.orderId, eventType: data.eventType }).get()
      const shouldWriteTimeline = !(existingEventPhotos.data || []).some(hasCheckinPhoto)
      const checkin = { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, clientRequestId, eventType: data.eventType, mediaFileId: data.mediaFileId || '', watermarkedMediaFileId: '', latitude, longitude, serverTime: time, recordedAt, isBackfilled: data.isBackfilled === true, remark: data.remark || data.note || '', createdAt: time, updatedAt: time, deletedAt: null, deletedByOpenid: '' }
      if (isSanitization) {
        checkin.preStart = true
        checkin.sanitizationVersion = 1
      }
      const created = await db.collection('checkin_logs').add({ data: checkin })
      if (shouldWriteTimeline) await appendOrderTimeline(data.orderId, 'checkin', data.isBackfilled === true ? '服务打卡已补传' : '服务打卡', data.eventType, 'staff')
      return { _id: created._id, ...checkin }
    }
    if (action === 'deleteCheckin') {
      const { order } = await requireStaffOrder(openid, data.orderId, '仅订单员工可删除打卡照片')
      if (order.status !== 'in_service') throw new Error('仅服务中可删除打卡照片')
      if (!data.checkinId) throw new Error('请选择要删除的照片')
      const checkin = (await db.collection('checkin_logs').doc(data.checkinId).get()).data
      if (!checkin || checkin.orderId !== data.orderId) throw new Error('打卡照片不存在')
      if (checkin.eventType === 'sanitization') throw new Error('服务前消毒凭证不可删除')
      if (checkin.deletedAt) return { _id: data.checkinId, deletedAt: checkin.deletedAt }
      const time = now()
      await db.collection('checkin_logs').doc(data.checkinId).update({ data: { deletedAt: time, deletedByOpenid: openid, updatedAt: time } })
      return { _id: data.checkinId, deletedAt: time }
    }
    if (action === 'listOrderCheckins') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('checkin_logs').where({ orderId: data.orderId }).orderBy('recordedAt', 'asc').get()
      return (res.data || []).filter(isActiveCheckin)
    }
    throw new Error('未知 checkin 操作')
  }
}
