module.exports = function createService({
  ORDER_STATUS,
  appendOrderStaffMessage,
  appendOrderTimeline,
  beijingClockText,
  buildMallOrderTitle,
  cloud,
  db,
  deliverSubscription,
  enqueueSubscription,
  retrySubscriptionDeliveries,
  readScopedDocuments,
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
  function buildSubscriptionPage(order = {}, role = 'client', templateKey = '') {
    const orderId = order && order._id || ''
    const chatParam = templateKey === 'orderChat' ? '&openChat=1' : ''
    if (!orderId) return role === 'staff' ? 'pages/staff/home/index' : 'pages/client/home/index'
    if (role === 'staff') {
      return `pages/staff/orders/service/index?id=${orderId}${chatParam}`
    }
    return isMallOrder(order) ? `pages/client/mall/orders/detail/index?id=${orderId}` : `pages/client/orders/detail/index?id=${orderId}${chatParam}`
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
    if (templateKey === 'orderPaid') {
      const address = order.serviceAddress || (order.shippingAddress && (order.shippingAddress.serviceAddress || order.shippingAddress.addressDetail)) || order.city || '请查看订单地址'
      return {
        thing2: { value: safeText(serviceName).slice(0, 20) },
        character_string1: { value: safeText(orderNo).slice(0, 32) },
        amount3: { value: Number(order.payAmount || detail.amount || 0).toFixed(2) },
        time4: { value: formatDateTime(order.startTime || order.createdAt || now()) },
        thing5: { value: safeText(address).slice(0, 20) }
      }
    }
    if (templateKey === 'refundResult') {
      return {
        amount2: { value: Number(detail.refundAmount).toFixed(2) },
        thing3: { value: safeText(detail.refundStatus === 'success' ? '退款成功，请留意原支付账户' : (detail.failReason || '退款未成功，请联系平台处理')).slice(0, 20) },
        date4: { value: formatDateTime(detail.refundTime) },
        thing5: { value: safeText(serviceName).slice(0, 20) },
        character_string6: { value: safeText(orderNo).slice(0, 32) }
      }
    }
    if (templateKey === 'staffDirectOrder') {
      return {
        character_string2: { value: safeText(orderNo).slice(0, 32) },
        thing5: { value: safeText(detail.tip || '您有新的指定预约，请及时查看并确认').slice(0, 20) },
        thing9: { value: safeText(serviceName).slice(0, 20) },
        time10: { value: formatDateTime(order.startTime) },
        amount3: { value: Number(order.payAmount).toFixed(2) }
      }
    }
    if (templateKey === 'orderAccepted') {
      return {
        character_string1: { value: safeText(orderNo).slice(0, 32) },
        thing2: { value: safeText(detail.staffName || order.staffName || order.requestedStaffName || '宠托师').slice(0, 20) },
        // The platform phone is resolved from settings at delivery time, including retries.
        phone_number4: { value: '' },
        thing5: { value: safeText(detail.orderDemand || serviceName).slice(0, 20) }
      }
    }
    if (templateKey === 'serviceFinish') {
      return {
        character_string14: { value: safeText(orderNo).slice(0, 32) },
        thing6: { value: safeText(serviceName).slice(0, 20) },
        thing5: { value: safeText(detail.tip || '服务已完成，可查看服务报告').slice(0, 20) },
        time3: { value: formatDateTime(detail.completedAt || order.completedAt) }
      }
    }
    if (templateKey === 'serviceStart') {
      return {
        character_string1: { value: safeText(orderNo).slice(0, 32) },
        thing2: { value: '服务已开始，毛孩子正被贴心照顾' }
      }
    }
    if (templateKey === 'staffDeparture') {
      return {
        thing1: { value: safeText(serviceName).slice(0, 20) },
        time2: { value: formatDateTime(detail.appointmentTime || order.startTime) },
        time3: { value: formatDateTime(detail.departedAt || order.departedAt) },
        thing4: { value: safeText(detail.staffName || order.staffName || '宠托师').slice(0, 20) }
      }
    }
    if (templateKey === 'remoteUnlock') {
      return {
        character_string1: { value: safeText(orderNo).slice(0, 32) },
        thing4: { value: '宠托师请求远程开门' },
        thing10: { value: '请核实到访人员后，在门锁应用远程开门' },
        time5: { value: formatDateTime(detail.requestTime || order.orderHomeSecurity?.remoteUnlock?.lastRequestedAt) }
      }
    }
    if (templateKey === 'upcomingServiceReminder') {
      const pets = Array.isArray(order.petSnapshots) && order.petSnapshots.length ? order.petSnapshots : [order.petSnapshot].filter(Boolean)
      const types = [...new Set(pets.map(pet => ({ cat: '猫', dog: '狗', 猫: '猫', 狗: '狗' })[pet.species] || '其他'))]
      const names = pets.map(pet => pet.name).filter(Boolean).join('、') || order.petName || '请查看订单'
      const start = detail.startTimeText || order.startTime
      const end = detail.endTimeText || order.endTime
      return {
        time3: { value: beijingClockText(toTimeValue(start)) + '~' + beijingClockText(toTimeValue(end)) },
        thing4: { value: safeText(detail.serviceAddress || order.serviceAddress || order.city || '请查看订单地址').slice(0, 20) },
        short_thing6: { value: (types.join('、') || ({ cat: '猫', dog: '狗' })[order.petCategory] || '宠物').slice(0, 5) },
        thing7: { value: safeText(names).slice(0, 20) },
        thing5: { value: safeText(detail.tip || '请按时前往，完整地址及照护要求见订单').slice(0, 20) }
      }
    }

    if (templateKey === 'orderChat') {
      const rawSender = safeText(detail.senderName || (detail.senderRole === 'staff' ? '宠托师' : '宠物主'))
      const sender = rawSender.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 20) || '服务沟通'
      const rawContent = safeText(detail.content || '您有一条新的未读留言')
      const content = rawContent.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 20) || '您有一条未读留言'
      const sendTime = formatDateTime(detail.time || now()) || formatDateTime(now())
      return {
        thing1: { value: sender },
        thing2: { value: content },
        time3: { value: sendTime }
      }
    }

    return {
      thing9: { value: safeText(detail.tip || '订单状态已更新').slice(0, 20) },
      thing4: { value: statusText.slice(0, 20) },
      character_string5: { value: safeText(orderNo).slice(0, 32) },
      thing10: { value: safeText(serviceName).slice(0, 20) },
      date3: { value: safeText(templateKey === 'staffCancellation' ? formatDateTime(detail.cancelledAt) : (order.startTime || nowText())).slice(0, 20) }
    }
  }

  function sanitizeSubscriptionLogData(data = {}) {
    if (!data || typeof data !== 'object') return {}
    const sanitized = {}
    for (const key of Object.keys(data)) {
      const field = data[key]
      if (field && typeof field === 'object' && field.value !== undefined) {
        let val = String(field.value)
        if (key === 'thing4' || key === 'thing2' || key === 'character_string1') {
          val = val.replace(/(\d+[-—_号栋幢弄室单元层楼A-Za-z0-9]+.*$)/, '***')
        }
        sanitized[key] = { value: val }
      } else {
        sanitized[key] = field
      }
    }
    return sanitized
  }

  async function recordSubscriptionLog(log) {
    const time = now()
    const expiresAt = new Date(new Date(time).getTime() + 30 * 24 * 60 * 60 * 1000)
    await db.collection('subscription_logs').add({
      data: {
        openid: log.openid || '',
        templateKey: log.templateKey || '',
        templateId: log.templateId || '',
        orderId: log.orderId || '',
        status: log.status || 'skipped',
        page: log.page || '',
        data: sanitizeSubscriptionLogData(log.data),
        error: log.error || '',
        code: log.code || '',
        isQuotaExhausted: Boolean(log.isQuotaExhausted),
        expiresAt,
        createdAt: time
      }
    })
  }

  function getQueuedReminderSession(order, deliveryKey) {
    const parts = String(deliveryKey || '').split(':')
    if (parts.length < 4 || parts[0] !== 'upcoming_service') return null
    const sessionIndex = Number(parts[3])
    if (!Number.isInteger(sessionIndex) || sessionIndex < 1) return null
    const startTime = parts.length > 4 ? parts.slice(4).join(':') : ''
    const sessions = Array.isArray(order && order.serviceSessions) ? order.serviceSessions : []
    const session = sessions.find(item => Number(item && item.index) === sessionIndex) ||
      (!sessions.length && sessionIndex === 1 && order && order.startTime
        ? { index: 1, startTime: order.startTime, endTime: order.endTime, status: order.status === 'completed' ? 'completed' : 'pending' }
        : null)
    if (!session || session.status === 'completed' || session.status === 'cancelled') return null
    // New reminders carry the exact session start. Requiring it prevents a delayed
    // message for an earlier session from being sent after the order advances.
    if (startTime && String(session.startTime || '') !== startTime) return null
    if (!startTime && sessionIndex !== 1) return null
    return session
  }

  async function sendSubscribeMessageOnce(openid, templateKey, page, messageData = {}, orderId = '') {
    if (!openid || !templateKey) return { status: 'skipped', error: 'missing_recipient_or_template_key' }
    let templateId = ''
    try {
      const settings = await getSystemSettings()
      templateId = settings.subscription.templates[templateKey] || ''
      // Cancellation is an assignment-status update, not a service-start or payment-success event.
      if (!templateId && templateKey === 'staffCancellation') {
        templateId = settings.subscription.templates.orderAssigned || ''
      }
      if (!settings.subscription.enabled || !templateId) {
        const result = { status: 'skipped', error: !settings.subscription.enabled ? 'subscription_disabled' : 'template_not_configured', templateKey, templateId }
        console.log('[subscription] skipped', { orderId, templateKey, status: 'skipped', code: result.error })
        await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: result.status, error: result.error })
        return result
      }
      if (templateKey === 'refundResult' && !messageData.amount2) {
        // Old queued messages have neither the per-refund amount nor the result time.
        const result = { status: 'skipped', error: 'legacy_refund_payload', templateKey, templateId }
        await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, ...result })
        return result
      }
      if ((templateKey === 'upcomingServiceReminder' && !messageData.short_thing6) ||
          (templateKey === 'remoteUnlock' && !messageData.time5)) {
        const result = { status: 'skipped', error: 'legacy_reminder_payload', templateKey, templateId }
        await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, ...result })
        return result
      }
      if (templateKey === 'serviceFinish' && !messageData.character_string14) {
        const status = messageData.thing4 && messageData.thing4.value
        const completed = ['当天已完成', '已完成', '已自动结算完成'].includes(status)
        const order = completed && orderId ? (await db.collection('orders').doc(orderId).get()).data : null
        const finishedSessions = order && (order.serviceSessions || []).filter(item => item.finishedAt) || []
        // Old messages did not store a session index: do not guess once multiple sessions have completed.
        const session = finishedSessions.length === 1 ? finishedSessions[0] : null
        const completedAt = order && (status === '当天已完成' ? session && session.finishedAt : order.completedAt)
        if (!completed || !completedAt) {
          const result = { status: 'skipped', error: completed ? 'completion_time_missing' : 'legacy_service_finish_not_completed', templateKey, templateId }
          await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, ...result })
          return result
        }
        messageData = {
          character_string14: messageData.character_string5,
          thing6: messageData.thing10,
          thing5: { value: status === '当天已完成' ? '本场服务已完成，可查看服务记录' : '服务已完成，可查看订单详情' },
          time3: { value: formatDateTime(completedAt) }
        }
      }
      if (templateKey === 'serviceStart' && !messageData.character_string1) {
        // Old queued serviceStart messages also contained pre-start and overdue events.
        if (!messageData.thing4 || messageData.thing4.value !== '服务中') {
          const result = { status: 'skipped', error: 'legacy_service_start_not_started', templateKey, templateId }
          await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, ...result })
          return result
        }
        messageData = {
          character_string1: messageData.character_string5,
          thing2: { value: '服务已开始，毛孩子正被贴心照顾' }
        }
      }
      if (templateKey === 'orderAccepted') {
        const platformPhone = safeText(settings.customerService && settings.customerService.phone).trim()
        // Translate old queued payloads without changing their delivery identity.
        const legacy = !!messageData.name3
        messageData = {
          character_string1: messageData.character_string1,
          thing2: legacy ? messageData.name3 : messageData.thing2,
          phone_number4: { value: platformPhone },
          thing5: legacy ? messageData.thing2 : messageData.thing5
        }
        if (!platformPhone) {
          const result = { status: 'skipped', error: 'platform_phone_not_configured', templateKey, templateId }
          await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, ...result })
          return result
        }
      }
      if (!cloud.openapi || !cloud.openapi.subscribeMessage || typeof cloud.openapi.subscribeMessage.send !== 'function') {
        const result = { status: 'skipped', error: 'openapi_unavailable', templateKey, templateId }
        console.log('[subscription] skipped', { orderId, templateKey, status: 'skipped', code: result.error })
        await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: result.status, error: result.error })
        return result
      }
      console.log('[subscription] prepare send', { orderId, templateKey, templateId })
      await cloud.openapi.subscribeMessage.send({ touser: openid, templateId, page, data: messageData })
      console.log('[subscription] sent', { orderId, templateKey, status: 'sent' })
      await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: 'sent' }).catch(error => console.error('[subscription-log]', error.message))
      return { status: 'sent', error: '', templateKey, templateId }
    } catch (error) {
      const message = error && (error.message || error.errMsg) || String(error)
      const errCode = error && (error.errCode || error.code)
      const isQuotaExhausted = errCode === 43101 || String(message).includes('43101')
      console.error('[subscription] failed', { orderId, templateKey, status: 'failed', code: errCode || 'send_failed', isQuotaExhausted })
      await recordSubscriptionLog({ openid, templateKey, orderId, page, data: messageData, status: 'failed', error: message, code: errCode, isQuotaExhausted })
      return { status: 'failed', error: message, templateKey, templateId, code: errCode, isQuotaExhausted }
    }
  }

  const sendDelivery = async message => {
    // Earlier versions queued acceptance at payment time, before assigning staff.
    if (message.templateKey === 'orderAccepted' && message.deliveryKey === `order_accepted:${message.orderId}`) {
      return { status: 'skipped', error: 'legacy_order_not_accepted', templateKey: message.templateKey }
    }
    if (message.templateKey === 'upcomingServiceReminder' && (message.deliveryKey || '').startsWith('upcoming_service:')) {
      const order = (await db.collection('orders').doc(message.orderId).get()).data
      const session = order && getQueuedReminderSession(order, message.deliveryKey)
      const parts = String(message.deliveryKey || '').split(':')
      const sessionIndex = Number(parts[3])
      const startTime = parts.length > 4 ? parts.slice(4).join(':') : ''
      const currentKey = session && makeIdempotencyKey('upcoming_service', order._id, order.staffOpenid,
        String(session.index || sessionIndex), session.startTime || order.startTime)
      if (!order || order.adminDeletedAt || !['assigned', 'day_completed'].includes(order.status) || order.staffOpenid !== message.openid ||
          !session || (startTime && String(session.startTime || '') !== startTime) || currentKey !== message.deliveryKey) {
        return { status: 'skipped', error: 'service_reminder_obsolete', templateKey: message.templateKey }
      }
    }
    if (message.templateKey === 'staffDirectOrder') {
      const order = (await db.collection('orders').doc(message.orderId).get()).data
      const current = order && !order.adminDeletedAt && order.paymentStatus === 'paid' && (message.assignmentKind === 'request'
        ? order.status === 'paid' && !order.staffOpenid && order.publishMode === 'direct' && order.requestedStaffOpenid === message.openid && order.paymentNo === message.assignmentVersion
        : order.status === 'assigned' && order.staffOpenid === message.openid && order.assignmentNoticeRevision === message.assignmentVersion)
      if (!current) return { status: 'skipped', error: 'staff_assignment_obsolete', templateKey: message.templateKey }
    }
    return sendSubscribeMessageOnce(message.openid, message.templateKey, message.page, message.messageData, message.orderId)
  }
  async function sendSubscribeMessage(openid, templateKey, page, messageData = {}, orderId = '', deliveryKey = '') {
    try { return await deliverSubscription({ openid, templateKey, page, messageData, orderId: orderId || '', ...(deliveryKey ? { deliveryKey } : {}) }, sendDelivery) }
    catch (error) { return { status: 'failed', error: String(error.message || error), templateKey } }
  }
  async function retryFailedSubscriptions() { return retrySubscriptionDeliveries(sendDelivery) }

  function notifyOrder(openid, templateKey, order, detail = {}, role = '', deliveryKey = '') {
    const targetRole = role || (order && order.staffOpenid && openid === order.staffOpenid ? 'staff' : 'client')
    return sendSubscribeMessage(openid, templateKey, buildSubscriptionPage(order, targetRole, templateKey), buildSubscriptionData(templateKey, order, detail), order && order._id, deliveryKey)
  }

  function enqueueOrderNotification(tx, openid, templateKey, order, detail = {}, role = '', deliveryKey = '') {
    const targetRole = role || (order && order.staffOpenid && openid === order.staffOpenid ? 'staff' : 'client')
    return enqueueSubscription(tx, { openid, templateKey, page: buildSubscriptionPage(order, targetRole, templateKey),
      messageData: buildSubscriptionData(templateKey, order, detail), orderId: order && order._id || '', ...(deliveryKey ? { deliveryKey } : {}) })
  }

  function staffDirectOrderMessage(order, kind) {
    const request = kind === 'request'
    const version = request ? order.paymentNo : order.assignmentNoticeRevision
    const reassigned = Array.isArray(order.previousStaffRecords) && order.previousStaffRecords.length > 0
    const tip = request ? '您有新的指定预约，请及时查看并确认'
      : reassigned ? '您收到一笔改派订单，请查看并按时赴约' : '您有新的服务安排，请查看并按时赴约'
    return {
      openid: request ? order.requestedStaffOpenid : order.staffOpenid,
      templateKey: 'staffDirectOrder', orderId: order._id,
      page: request ? `pages/staff/orders/detail/index?id=${order._id}` : buildSubscriptionPage(order, 'staff'),
      messageData: buildSubscriptionData('staffDirectOrder', order, { tip }),
      assignmentKind: kind, assignmentVersion: version,
      deliveryKey: `staff_direct:${kind}:${version}`
    }
  }

  function enqueueStaffDirectOrder(tx, order, kind) {
    return enqueueSubscription(tx, staffDirectOrderMessage(order, kind))
  }

  async function notifyStaffDirectOrder(order, kind) {
    try { return await deliverSubscription(staffDirectOrderMessage(order, kind), sendDelivery) }
    catch (error) { return { status: 'failed', error: String(error.message || error) } }
  }

  function orderAcceptedDeliveryKey(order) {
    return makeIdempotencyKey('order_accepted', order._id, order.staffOpenid || '', String(toTimeValue(order.assignedAt) || ''))
  }

  function enqueueOrderAccepted(tx, order, staffName = '') {
    return enqueueOrderNotification(tx, order.clientOpenid, 'orderAccepted', order, {
      staffName: staffName || order.staffName || order.requestedStaffName || '宠托师',
      orderDemand: order.serviceSummary || '宠护服务', serviceArea: order.serviceAddress || order.city || '服务地址',
      serviceTime: getClockText(order.startTime)
    }, 'client', orderAcceptedDeliveryKey(order))
  }

  function notifyOrderAccepted(order, staffName = '') {
    const detail = {
      staffName: staffName || order.staffName || order.requestedStaffName || '宠托师',
      orderDemand: order.serviceSummary || '宠护服务',
      serviceArea: order.serviceAddress || order.city || '服务地址',
      serviceTime: getClockText(order.startTime)
    }
    console.log('[orderAccepted] notify prepare', {
      orderId: order && order._id,
      templateKey: 'orderAccepted'
    })
    return notifyOrder(order.clientOpenid, 'orderAccepted', order, detail, 'client', orderAcceptedDeliveryKey(order))
      .then((result) => {
        console.log('[orderAccepted] notify result', {
          orderId: order && order._id,
          templateKey: 'orderAccepted',
          status: result && result.status,
          code: result && result.error || ''
        })
        return result
      })
      .catch((error) => {
        console.error('[orderAccepted] notify error', {
          orderId: order && order._id,
          templateKey: 'orderAccepted',
          status: 'failed',
          code: error && (error.errCode || error.code) || 'notify_error'
        })
        throw error
      })
  }

  async function sendUpcomingServiceRemindersToStaff(currentTime = now()) {
    const currentTs = toTimeValue(currentTime)
    if (!currentTs) return []
    const [assignedRes, dayCompletedRes] = await Promise.all([
      readScopedDocuments('orders', { status: ORDER_STATUS.ASSIGNED }),
      readScopedDocuments('orders', { status: ORDER_STATUS.DAY_COMPLETED })
    ])
    const candidates = [...assignedRes, ...dayCompletedRes]
    const remindedOrders = []

    for (const order of candidates) {
      if (!order.staffOpenid || order.adminDeletedAt) continue
      const activeSession = getActiveServiceSession(order)
      const nextSession = getNextPendingServiceSession(order, currentTime)
      const targetSession = activeSession || nextSession || (Array.isArray(order.serviceSessions) && order.serviceSessions[0]) || { index: 1, startTime: order.startTime }
      if (targetSession.status === 'completed') continue
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

      const detail = { startTimeText: timeText, endTimeText: targetSession.endTime || order.endTime,
        serviceAddress: address, tip: '请按时前往，完整地址及照护要求见订单' }
      const deliveryKey = makeIdempotencyKey('upcoming_service', order._id, order.staffOpenid, String(sessionIndex), timeText)
      const claimed = await db.runTransaction(async tx => {
        const latest = (await tx.collection('orders').doc(order._id).get()).data
        if (!latest || latest.adminDeletedAt || ![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(latest.status) || latest.staffOpenid !== order.staffOpenid) return false
        if ((latest.staffUpcomingRemindedSessions || []).includes(sessionIndex)) return false
        const session = getNextPendingServiceSession(latest, currentTime)
        if (!session || session.status === 'completed' || Number(session.index) !== sessionIndex || toTimeValue(session.startTime) !== sessionStartTime) return false
        await enqueueOrderNotification(tx, latest.staffOpenid, 'upcomingServiceReminder', latest, detail, 'staff', deliveryKey)
        await tx.collection('orders').doc(order._id).update({ data: {
          staffUpcomingRemindedSessions: [...(latest.staffUpcomingRemindedSessions || []), sessionIndex],
          staffUpcomingRemindedAt: currentTime, updatedAt: currentTime
        } })
        return true
      })
      if (!claimed) continue
      const notifyRes = await notifyOrder(order.staffOpenid, 'upcomingServiceReminder', order, detail, 'staff', deliveryKey)

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
    enqueueStaffDirectOrder,
    notifyStaffDirectOrder,
    enqueueOrderNotification,
    enqueueOrderAccepted,
    buildSubscriptionPage,
    getClockText,
    buildSubscriptionData,
    recordSubscriptionLog,
    sendSubscribeMessage,
    retryFailedSubscriptions,
    notifyOrder,
    notifyOrderAccepted,
    sendUpcomingServiceRemindersToStaff
  }
}
