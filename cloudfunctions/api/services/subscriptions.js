module.exports = function createService({
  ORDER_STATUS,
  appendOrderStaffMessage,
  appendOrderTimeline,
  beijingClockText,
  buildMallOrderTitle,
  cloud,
  db,
  formatDateTime,
  getActiveServiceSession,
  getNextPendingServiceSession,
  getSystemSettings,
  isMallOrder,
  makeIdempotencyKey,
  now,
  nowText,
  safeText,
  toTimeValue
}) {
  function buildSubscriptionPage(order = {}, role = 'client') {
    const orderId = order && order._id || ''
    if (!orderId) return role === 'staff' ? 'pages/staff/home/index' : 'pages/client/home/index'
    if (role === 'staff') {
      return `pages/staff/orders/service/index?id=${orderId}`
    }
    return isMallOrder(order) ? `pages/client/mall/orders/detail/index?id=${orderId}` : `pages/client/orders/detail/index?id=${orderId}`
  }

  function getClockText(value) {
    const text = safeText(value).trim()
    const matched = text.match(/(?:^|\s|T)(\d{1,2}:\d{2})/)
    if (matched) return matched[1]
    return beijingClockText(value)
  }

  function buildSubscriptionData(templateKey, order = {}, detail = {}) {
    const serviceName = isMallOrder(order) ? buildMallOrderTitle(order) : (order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务')
    const orderNo = order.orderNo || order._id || ''
    const statusText = safeText(detail.statusText || templateKey)
    if (templateKey === 'orderAccepted') {
      return {
        character_string1: { value: safeText(orderNo).slice(0, 32) },
        thing2: { value: safeText(detail.orderDemand || serviceName).slice(0, 20) },
        name3: { value: safeText(detail.staffName || order.staffName || order.requestedStaffName || '宠托师').slice(0, 10) },
        thing4: { value: safeText(detail.serviceArea || order.serviceAddress || '服务地址').slice(0, 20) },
        time17: { value: safeText(detail.serviceTime || getClockText(order.startTime) || beijingClockText()).slice(0, 20) }
      }
    }
    if (templateKey === 'remoteUnlock') {
      return {
        thing1: { value: safeText(detail.deviceName || '入户门锁').slice(0, 20) },
        character_string2: { value: safeText(orderNo).slice(0, 32) },
        time3: { value: safeText(detail.requestTime || nowText()).slice(0, 20) }
      }
    }
    if (templateKey === 'upcomingServiceReminder') {
      return {
        thing9: { value: safeText(detail.tip || '订单即将开始，请前往服务').slice(0, 20) },
        thing4: { value: '即将开始' },
        character_string5: { value: safeText(orderNo).slice(0, 32) },
        thing10: { value: safeText(serviceName).slice(0, 20) },
        date3: { value: safeText(detail.startTimeText || order.startTime || nowText()).slice(0, 20) }
      }
    }
    return {
      thing9: { value: safeText(detail.tip || '订单状态已更新').slice(0, 20) },
      thing4: { value: statusText.slice(0, 20) },
      character_string5: { value: safeText(orderNo).slice(0, 32) },
      thing10: { value: safeText(serviceName).slice(0, 20) },
      date3: { value: safeText(order.startTime || nowText()).slice(0, 20) }
    }
  }

  async function recordSubscriptionLog(log) {
    await db.collection('subscription_logs').add({
      data: {
        openid: log.openid || '',
        templateKey: log.templateKey || '',
        templateId: log.templateId || '',
        orderId: log.orderId || '',
        status: log.status || 'skipped',
        page: log.page || '',
        data: log.data || {},
        error: log.error || '',
        createdAt: now()
      }
    })
  }

  async function sendSubscribeMessage(openid, templateKey, page, messageData = {}, orderId = '') {
    if (!openid || !templateKey) return { status: 'skipped', error: 'missing_recipient_or_template_key' }
    try {
      const settings = await getSystemSettings()
      let templateId = settings.subscription.templates[templateKey] || ''
      if (!templateId && templateKey === 'upcomingServiceReminder') {
        templateId = settings.subscription.templates.serviceStart || ''
      }
      console.log('[subscription] send prepare', { openid, templateKey, templateId, enabled: settings.subscription.enabled, orderId, page, data: messageData })
      if (!settings.subscription.enabled || !templateId) {
        const result = { status: 'skipped', error: !settings.subscription.enabled ? 'subscription_disabled' : 'template_not_configured', templateKey, templateId }
        console.log('[subscription] send skipped', { openid, templateKey, templateId, orderId, result })
        await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: result.status, error: result.error })
        return result
      }
      if (!cloud.openapi || !cloud.openapi.subscribeMessage || typeof cloud.openapi.subscribeMessage.send !== 'function') {
        const result = { status: 'skipped', error: 'openapi_unavailable', templateKey, templateId }
        console.log('[subscription] send skipped', { openid, templateKey, templateId, orderId, result })
        await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: result.status, error: result.error })
        return result
      }
      await cloud.openapi.subscribeMessage.send({ touser: openid, templateId, page, data: messageData })
      console.log('[subscription] send success', { openid, templateKey, templateId, orderId })
      await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: 'sent' })
      return { status: 'sent', error: '', templateKey, templateId }
    } catch (error) {
      const message = error && (error.message || error.errMsg) || String(error)
      console.error('[subscription] send failed', { openid, templateKey, orderId, error: message })
      await recordSubscriptionLog({ openid, templateKey, orderId, page, data: messageData, status: 'failed', error: message })
      return { status: 'failed', error: message, templateKey }
    }
  }

  function notifyOrder(openid, templateKey, order, detail = {}, role = '') {
    const targetRole = role || (order && order.staffOpenid && openid === order.staffOpenid ? 'staff' : 'client')
    return sendSubscribeMessage(openid, templateKey, buildSubscriptionPage(order, targetRole), buildSubscriptionData(templateKey, order, detail), order && order._id)
  }

  function notifyOrderAccepted(order, staffName = '') {
    const detail = {
      staffName: staffName || order.staffName || order.requestedStaffName || '宠托师',
      orderDemand: order.serviceSummary || '宠护服务',
      serviceArea: order.serviceAddress || order.city || '服务地址',
      serviceTime: getClockText(order.startTime)
    }
    console.log('[orderAccepted] prepare notify', {
      orderId: order && order._id,
      orderNo: order && order.orderNo,
      clientOpenid: order && order.clientOpenid,
      templateKey: 'orderAccepted',
      detail
    })
    return notifyOrder(order.clientOpenid, 'orderAccepted', order, detail)
      .then((result) => {
        console.log('[orderAccepted] notify result', {
          orderId: order && order._id,
          orderNo: order && order.orderNo,
          result
        })
        return result
      })
      .catch((error) => {
        console.error('[orderAccepted] notify error', {
          orderId: order && order._id,
          orderNo: order && order.orderNo,
          message: error && (error.message || error.errMsg) || String(error)
        })
        throw error
      })
  }

  async function sendUpcomingServiceRemindersToStaff(currentTime = now()) {
    const currentTs = toTimeValue(currentTime)
    if (!currentTs) return []
    const [assignedRes, dayCompletedRes] = await Promise.all([
      db.collection('orders').where({ status: ORDER_STATUS.ASSIGNED }).get(),
      db.collection('orders').where({ status: ORDER_STATUS.DAY_COMPLETED }).get()
    ])
    const candidates = [...(assignedRes.data || []), ...(dayCompletedRes.data || [])]
    const remindedOrders = []

    for (const order of candidates) {
      if (!order.staffOpenid) continue
      const activeSession = getActiveServiceSession(order)
      const nextSession = getNextPendingServiceSession(order)
      const targetSession = activeSession || nextSession || (Array.isArray(order.serviceSessions) && order.serviceSessions[0]) || { index: 1, startTime: order.startTime }
      const sessionIndex = Number(targetSession.index || 1)
      const sessionStartTime = toTimeValue((targetSession && targetSession.startTime) || order.startTime)
      if (!sessionStartTime) continue

      const diff = sessionStartTime - currentTs
      // 任务开始前 1 小时内（0 <= diff <= 3600000），或到达开始时间但在30分钟内尚未开始（-1800000 <= diff <= 0）
      if (diff > 60 * 60 * 1000 || diff < -30 * 60 * 1000) continue

      const remindedSessions = Array.isArray(order.staffUpcomingRemindedSessions) ? order.staffUpcomingRemindedSessions : []
      if (remindedSessions.includes(sessionIndex)) continue
      if (order.staffUpcomingRemindedAt && sessionIndex === 1 && toTimeValue(order.staffUpcomingRemindedAt) >= sessionStartTime - 2 * 3600 * 1000) {
        continue
      }

      const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
      const address = order.serviceAddress || order.city || '服务地址'
      const timeText = (targetSession && targetSession.startTime) || order.startTime || formatDateTime(sessionStartTime)

      // 发送订阅消息（指定角色为 staff，跳转服务执行页面）
      const notifyRes = await notifyOrder(order.staffOpenid, 'upcomingServiceReminder', order, {
        statusText: '即将开始',
        tip: '订单即将开始，请前往服务',
        startTimeText: timeText,
        serviceAddress: address
      }, 'staff')

      // 写入宠托师站内消息
      const messageDetail = `您的订单（${serviceName}）约定于 ${timeText} 开始，距当前已不足 1 小时。请提前规划行程并前往服务地点：${address}。到达后请按要求完成打卡。`
      await appendOrderStaffMessage(order, {
        eventType: 'upcoming_service_reminder',
        title: '订单即将开始，请前往服务',
        detail: messageDetail,
        actorRole: 'system',
        idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'upcoming_service_reminder', String(sessionIndex))
      })

      // 写入订单时间线
      await appendOrderTimeline(order._id, 'upcoming_service_reminder', '即将开始服务提醒已发送', `第${sessionIndex}天服务即将在 1 小时内开始，系统已提醒宠托师前往服务。`, 'system')

      // 更新订单防重字段
      const newRemindedSessions = Array.from(new Set([...remindedSessions, sessionIndex]))
      const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
      await db.collection('orders').doc(order._id).update({
        data: {
          staffUpcomingRemindedSessions: newRemindedSessions,
          staffUpcomingRemindedAt: time,
          updatedAt: time
        }
      })

      remindedOrders.push({
        orderId: order._id,
        sessionIndex,
        staffOpenid: order.staffOpenid,
        notifyResult: notifyRes
      })
    }

    return remindedOrders
  }

  return {
    buildSubscriptionPage,
    getClockText,
    buildSubscriptionData,
    recordSubscriptionLog,
    sendSubscribeMessage,
    notifyOrder,
    notifyOrderAccepted,
    sendUpcomingServiceRemindersToStaff
  }
}
