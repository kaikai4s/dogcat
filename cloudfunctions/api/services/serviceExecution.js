module.exports = function createService({
  ORDER_STATUS,
  addPoints,
  appendOrderClientMessage,
  appendOrderStaffMessage,
  appendOrderTimeline,
  checkinEventText,
  db,
  destroyOrderHomeSecuritySecrets,
  ensureStaffEarning,
  getCompletedStaffOrders,
  getUser,
  grantRetroCards,
  hasCheckinPhoto,
  isFinalServiceSession,
  isValidSanitization,
  makeIdempotencyKey,
  markServiceSession,
  normalizeServiceSessions,
  normalizeStaffWorkflow,
  notifyOrder,
  enqueueOrderNotification,
  now,
  readScopedDocuments,
  requireSanitizationEvidence,
  toTimeValue
}) {
  async function evaluateCheckinCompletion(order, sessionStartedAt) {
    try {
      await requireSanitizationEvidence(order, sessionStartedAt)
    } catch (error) {
      return { isComplete: false, missing: ['隔离病菌/消毒打卡'] }
    }

    const checkins = await readScopedDocuments('checkin_logs', { orderId: order._id })
    const eventSet = checkins.filter((item) => {
      if (!hasCheckinPhoto(item)) return false
      if (item.eventType === 'sanitization') return isValidSanitization(item, order, sessionStartedAt)
      return !sessionStartedAt || toTimeValue(item.recordedAt || item.serverTime || item.createdAt) >= (sessionStartedAt - 60000)
    }).reduce((map, item) => ({ ...map, [item.eventType]: true }), {})

    const requirements = Array.isArray(order.checkinRequirements) && order.checkinRequirements.length
      ? order.checkinRequirements
      : (order.requiredCheckins || []).map((eventType) => ({ eventType, label: checkinEventText(eventType), required: true }))
    const missing = requirements.filter((item) => item.required && !eventSet[item.eventType]).map((item) => item.label || checkinEventText(item.eventType))

    const security = order.orderHomeSecurity || order.homeSecuritySnapshot || {}
    if (security.type === 'key' && security.key && security.key.returnRequired && !security.key.returnedAt) {
      missing.push('放回钥匙打卡')
    }

    return {
      isComplete: missing.length === 0,
      missing
    }
  }

  async function completeOrderService(order, activeSession, time = now(), options = {}) {
    const isAuto = options.isAuto === true
    const actor = options.actor || (isAuto ? 'system' : 'staff')
    const completedSessions = markServiceSession(normalizeServiceSessions(order), activeSession.index, { status: 'completed', finishedAt: time })
    const finalSession = isFinalServiceSession({ ...order, serviceSessions: completedSessions }, activeSession)
    const orderId = order._id

    const sessionIndex = Number(activeSession.index || 1)
    const autoCompletedSessions = Array.isArray(order.autoCompletedSessions) ? order.autoCompletedSessions : []
    const nextAutoCompletedSessions = isAuto ? Array.from(new Set([...autoCompletedSessions, sessionIndex])) : autoCompletedSessions

    if (!finalSession) {
      const dayUpdateData = {
        status: ORDER_STATUS.DAY_COMPLETED,
        serviceSessions: completedSessions,
        activeSessionIndex: 0,
        activeSessionDate: '',
        currentSessionStartedAt: '',
        lastCompletedSessionIndex: activeSession.index,
        isFinishOverdue: false,
        updatedAt: time
      }
      if (isAuto) {
        dayUpdateData.autoCompleted = true
        dayUpdateData.autoCompletedSessions = nextAutoCompletedSessions
      }
      await db.runTransaction(async tx => {
        const current = (await tx.collection('orders').doc(orderId).get()).data
        if (!current || current.status !== ORDER_STATUS.IN_SERVICE || current.staffOpenid !== order.staffOpenid) throw new Error('订单状态不可完成当天服务')
        if (Number(current.activeSessionIndex || 0) && Number(current.activeSessionIndex) !== sessionIndex) throw new Error('服务日期已变化，请刷新订单')
        await tx.collection('orders').doc(orderId).update({ data: dayUpdateData })
        await enqueueOrderNotification(tx, order.clientOpenid, 'serviceFinish', order, { statusText: '当天已完成', tip: isAuto ? '今日服务打卡齐全，系统已确认完成' : '今日服务已完成' }, 'client', `finish:day:${sessionIndex}`)
      })
      const dayCompletedOrder = { ...order, _id: orderId, status: ORDER_STATUS.DAY_COMPLETED, serviceSessions: completedSessions, autoCompletedSessions: nextAutoCompletedSessions, autoCompleted: isAuto, updatedAt: time }
      await appendOrderTimeline(orderId, isAuto ? 'system_auto_day_completed' : 'day_completed', isAuto ? `系统自动完成第${activeSession.index}天服务` : `第${activeSession.index}天服务已完成`, isAuto ? '检测到打卡凭证齐全且已超时，系统已自动完成今日服务。' : '', actor)
      await appendOrderClientMessage(dayCompletedOrder, {
        eventType: 'day_completed',
        title: `第${activeSession.index}天服务已完成`,
        detail: isAuto ? '今日服务打卡已齐全，系统已确认今日服务完成。' : '今日服务已完成，下一次服务需重新开始履约。',
        actorRole: actor
      })
      if (isAuto && order.staffOpenid) {
        await appendOrderStaffMessage(dayCompletedOrder, {
          eventType: 'system_auto_day_completed',
          title: '今日服务已自动完成',
          detail: `检测到您的第${activeSession.index}天服务打卡已齐全，由于未手动结束，系统已自动帮您确认今日服务完成。`,
          actorRole: 'system',
          idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'system_auto_day_completed', String(activeSession.index || 1))
        })
      }
      await notifyOrder(order.clientOpenid, 'serviceFinish', order, { statusText: '当天已完成', tip: isAuto ? '今日服务打卡齐全，系统已确认完成' : '今日服务已完成' }, 'client', `finish:day:${sessionIndex}`)
      if (typeof destroyOrderHomeSecuritySecrets === 'function') {
        await destroyOrderHomeSecuritySecrets(orderId, {
          sessionIndex,
          reason: isAuto ? 'system_auto_day_completed' : 'day_completed',
          actor,
          time
        }).catch((err) => console.error('[completeOrderService] destroy session secrets failed:', err))
      }
      return { id: orderId, status: ORDER_STATUS.DAY_COMPLETED, activeSessionIndex: 0, autoCompleted: isAuto, autoCompletedSessions: nextAutoCompletedSessions }
    }

    const updateData = {
      status: ORDER_STATUS.COMPLETED,
      serviceSessions: completedSessions,
      activeSessionIndex: 0,
      activeSessionDate: '',
      currentSessionStartedAt: '',
      lastCompletedSessionIndex: activeSession.index,
      isFinishOverdue: false,
      completedAt: time,
      updatedAt: time
    }
    if (isAuto) {
      updateData.autoCompleted = true
      updateData.autoCompletedSessions = nextAutoCompletedSessions
    }

    const completedOrder = { ...order, _id: orderId, status: ORDER_STATUS.COMPLETED, serviceSessions: completedSessions, completedAt: time, updatedAt: time }
    const notifications = [{ openid: order.clientOpenid, detail: { statusText: '已完成', tip: isAuto ? '服务打卡齐全，系统已确认完成，可查看服务报告' : '服务已完成，可查看服务报告' }, role: 'client' }]
    if (isAuto && order.staffOpenid) notifications.push({ openid: order.staffOpenid, detail: { statusText: '已自动结算完成', tip: '订单已自动完成，收益已结算' }, role: 'staff' })
    const rewardsRes = await ensureOrderCompletionRewards(completedOrder, time, { completionPatch: updateData, notifications })
    if (rewardsRes.alreadyCompleted) return { id: orderId, status: ORDER_STATUS.COMPLETED, completedOrderCount: rewardsRes.completedOrderCount, autoCompleted: isAuto }

    if (typeof destroyOrderHomeSecuritySecrets === 'function') {
      await destroyOrderHomeSecuritySecrets(orderId, {
        sessionIndex,
        isFinal: true,
        reason: isAuto ? 'system_auto_completed' : 'service_completed',
        actor,
        time
      }).catch((err) => console.error('[completeOrderService] destroy final secrets failed:', err))
    }

    const timelineTitle = isAuto ? '系统智能完成服务' : '服务已完成'
    const timelineDesc = isAuto ? '检测到宠托师已完成全套离户打卡凭证，因超时未手动结束，系统已自动帮宠托师确认完成服务并结算。' : ''
    await appendOrderTimeline(orderId, isAuto ? 'system_auto_completed' : 'completed', timelineTitle, timelineDesc, actor)

    await appendOrderClientMessage(completedOrder, {
      eventType: 'completed',
      title: '服务已完成',
      detail: '服务已完成，可查看服务报告或评价',
      actorRole: actor
    })
    if (isAuto && order.staffOpenid) {
      const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
      await appendOrderStaffMessage(completedOrder, {
        eventType: 'system_auto_completed',
        title: '系统已自动完成服务并结算',
        detail: `检测到您的订单（${serviceName}）打卡凭证已齐全，由于超时未手动点击结束，系统已自动帮您完成服务并结算收益。下次服务请注意及时点击【完成服务】。`,
        actorRole: 'system',
        idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'system_auto_completed')
      })
      await notifyOrder(order.staffOpenid, 'serviceFinish', order, { statusText: '已自动结算完成', tip: '订单已自动完成，收益已结算' }, 'staff', 'finish:final')
    }
    await notifyOrder(order.clientOpenid, 'serviceFinish', order, { statusText: '已完成', tip: isAuto ? '服务打卡齐全，系统已确认完成，可查看服务报告' : '服务已完成，可查看服务报告' }, 'client', 'finish:final')

    return { id: orderId, status: ORDER_STATUS.COMPLETED, completedOrderCount: rewardsRes.completedOrderCount, autoCompleted: isAuto }
  }

  async function ensureOrderCompletionRewards(order, time = now(), options = {}) {
    const orderId = order._id
    const result = await db.runTransaction(async transaction => {
      const currentOrder = (await transaction.collection('orders').doc(orderId).get()).data
      if (!currentOrder || ![ORDER_STATUS.COMPLETED, ...(options.completionPatch ? [ORDER_STATUS.IN_SERVICE] : [])].includes(currentOrder.status)) throw new Error('订单状态不可完成')
      if (options.completionPatch && currentOrder.staffOpenid !== order.staffOpenid) throw new Error('订单员工已变化')
      if (currentOrder.status === ORDER_STATUS.IN_SERVICE && Number(currentOrder.activeSessionIndex || 0) &&
          Number(options.completionPatch && options.completionPatch.lastCompletedSessionIndex) !== Number(currentOrder.activeSessionIndex)) throw new Error('服务日期已变化，请刷新订单')
      const clientOpenid = currentOrder.clientOpenid
      const candidate = await getUser(clientOpenid)
      if (!candidate) throw new Error('订单客户不存在')
      const clientUser = (await transaction.collection('users').doc(candidate._id).get()).data
      if (!clientUser || clientUser.openid !== clientOpenid) throw new Error('订单客户归属异常')
      const alreadyCompleted = currentOrder.status === ORDER_STATUS.COMPLETED
      const orderPatch = { ...(!alreadyCompleted ? options.completionPatch || {} : {}) }
      const completedAt = currentOrder.completedAt || time

      // 1. 积分补偿与发放（addPoints 内部依据 order_complete_${orderId} 进行日志查重防重）
      if (!currentOrder.pointsAwarded) {
        const pointsDelta = Math.max(Math.floor(Number(currentOrder.payAmount || 0) / 10), 1)
        await addPoints(
          clientOpenid,
          clientUser._id,
          pointsDelta,
          'order_complete',
          orderId,
          `完成订单 +${pointsDelta} 积分`,
          { applyMultiplier: true, baseDelta: pointsDelta, transaction }
        )
        orderPatch.pointsAwarded = true
      }

      // 2. 客户完单数防重累加
      let completedOrderCount = Number(clientUser.completedOrderCount || 0)
      if (!Number.isSafeInteger(completedOrderCount) || completedOrderCount < 0) throw new Error('客户完单次数异常，请核对')
      if (!currentOrder.clientOrderCounted) {
        completedOrderCount += 1
        await transaction.collection('users').doc(clientUser._id).update({
          data: { completedOrderCount, updatedAt: time }
        })
        orderPatch.clientOrderCounted = true
      }
      const completionOrdinal = currentOrder.completionOrdinal != null
        ? Number(currentOrder.completionOrdinal)
        : currentOrder.clientOrderCounted ? 0 : completedOrderCount
      if (!Number.isSafeInteger(completionOrdinal) || completionOrdinal < 0) throw new Error('订单完单序号异常，请核对')
      if (completionOrdinal) orderPatch.completionOrdinal = completionOrdinal
      else orderPatch.completionOrdinalNeedsReview = true

      // 每满 3 单奖励 1 张补签卡；本订单使用固定完单序号。
      if (completionOrdinal > 0 && completionOrdinal % 3 === 0 && !currentOrder.retroCardAwarded && !currentOrder.retroCardEvaluated) {
        const existingCardLog = (await db.collection('retro_card_logs').where({
          openid: clientOpenid,
          sourceType: 'order_complete_milestone',
          sourceId: orderId
        }).limit(1).get()).data?.[0]

        if (!existingCardLog) {
          await grantRetroCards(
            clientOpenid,
            clientUser._id,
            1,
            'order_complete_milestone',
            orderId,
            '完成 3 次订单奖励补签卡 +1',
            { transaction }
          )
        }
        orderPatch.retroCardAwarded = true
      }
      orderPatch.retroCardEvaluated = true

      if (Object.keys(orderPatch).length > 0) {
        orderPatch.updatedAt = time
        await transaction.collection('orders').doc(orderId).update({ data: orderPatch })
      }
      await ensureStaffEarning({ ...currentOrder, ...orderPatch }, completedAt, { transaction })
      if (!alreadyCompleted) {
        for (const notification of options.notifications || []) await enqueueOrderNotification(transaction, notification.openid, 'serviceFinish', currentOrder, notification.detail, notification.role, 'finish:final')
      }
      return { completedOrderCount, pointsAwarded: true, alreadyCompleted }
    })
    if (order.staffProfileId) {
      try {
        const profile = normalizeStaffWorkflow((await db.collection('staff_profiles').doc(order.staffProfileId).get()).data)
        if (profile && profile.staffLevel === 'intern') {
          const orders = await getCompletedStaffOrders(order.staffOpenid || '')
          await db.collection('staff_profiles').doc(profile._id).update({ data: { internCompletedOrderCount: orders.length, updatedAt: time } })
        }
      } catch (error) { console.error('[completion-profile]', { orderId, message: error.message }) }
    }
    return result
  }

  return {
    evaluateCheckinCompletion,
    completeOrderService,
    ensureOrderCompletionRewards
  }
}
