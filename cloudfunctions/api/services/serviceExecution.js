module.exports = function createService({
  ORDER_STATUS,
  addPoints,
  appendOrderClientMessage,
  appendOrderStaffMessage,
  appendOrderTimeline,
  checkinEventText,
  db,
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
  now,
  readScopedDocuments,
  requireSanitizationEvidence,
  toTimeValue,
  updateOrderWhenStatus
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

    if (!finalSession) {
      const dayUpdateData = {
        status: ORDER_STATUS.DAY_COMPLETED,
        serviceSessions: completedSessions,
        activeSessionIndex: 0,
        activeSessionDate: '',
        currentSessionStartedAt: '',
        lastCompletedSessionIndex: activeSession.index,
        updatedAt: time
      }
      if (isAuto) dayUpdateData.autoCompleted = true
      await updateOrderWhenStatus(orderId, ORDER_STATUS.IN_SERVICE, dayUpdateData, '订单状态不可完成当天服务')
      const dayCompletedOrder = { ...order, _id: orderId, status: ORDER_STATUS.DAY_COMPLETED, serviceSessions: completedSessions, autoCompleted: isAuto, updatedAt: time }
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
      await notifyOrder(order.clientOpenid, 'serviceFinish', order, { statusText: '当天已完成', tip: isAuto ? '今日服务打卡齐全，系统已确认完成' : '今日服务已完成' }, 'client')
      return { id: orderId, status: ORDER_STATUS.DAY_COMPLETED, activeSessionIndex: 0, autoCompleted: isAuto }
    }

    const updateData = {
      status: ORDER_STATUS.COMPLETED,
      serviceSessions: completedSessions,
      activeSessionIndex: 0,
      activeSessionDate: '',
      currentSessionStartedAt: '',
      lastCompletedSessionIndex: activeSession.index,
      completedAt: time,
      updatedAt: time
    }
    if (isAuto) updateData.autoCompleted = true

    await updateOrderWhenStatus(orderId, ORDER_STATUS.IN_SERVICE, updateData, '订单状态不可完成')
    const completedOrder = { ...order, _id: orderId, status: ORDER_STATUS.COMPLETED, serviceSessions: completedSessions, completedAt: time, updatedAt: time }

    await ensureStaffEarning(completedOrder, time)

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
      await notifyOrder(order.staffOpenid, 'serviceFinish', order, { statusText: '已自动结算完成', tip: '订单已自动完成，收益已结算' }, 'staff')
    }
    await notifyOrder(order.clientOpenid, 'serviceFinish', order, { statusText: '已完成', tip: isAuto ? '服务打卡齐全，系统已确认完成，可查看服务报告' : '服务已完成，可查看服务报告' }, 'client')

    const pointsDelta = Math.max(Math.floor(Number(order.payAmount || 0) / 10), 1)
    await addPoints(order.clientOpenid, order.clientUserId, pointsDelta, 'order_complete', orderId, `完成订单 +${pointsDelta} 积分`, { applyMultiplier: true, baseDelta: pointsDelta })
    const clientUser = await getUser(order.clientOpenid)
    const completedOrderCount = Number(clientUser.completedOrderCount || 0) + 1
    await db.collection('users').doc(clientUser._id).update({ data: { completedOrderCount, updatedAt: time } })
    if (order.staffProfileId) {
      try {
        const staffProfile = normalizeStaffWorkflow((await db.collection('staff_profiles').doc(order.staffProfileId).get()).data)
        if (staffProfile && staffProfile.staffLevel === 'intern') {
          const internOrders = await getCompletedStaffOrders(order.staffOpenid || '')
          await db.collection('staff_profiles').doc(staffProfile._id).update({ data: { internCompletedOrderCount: internOrders.length, updatedAt: time } })
        }
      } catch (error) {}
    }
    if (completedOrderCount % 3 === 0) {
      await grantRetroCards(order.clientOpenid, clientUser._id, 1, 'order_complete_milestone', orderId, '完成 3 次订单奖励补签卡 +1')
    }
    return { id: orderId, status: ORDER_STATUS.COMPLETED, completedOrderCount, autoCompleted: isAuto }
  }

  return {
    evaluateCheckinCompletion,
    completeOrderService
  }
}
