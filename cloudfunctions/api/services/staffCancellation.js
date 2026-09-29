module.exports = function createService({ db, crypto, now, toTimeValue, createRefundForOrder, appendOrderClientMessage, notifyOrder }) {
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const tokenFor = order => hash(['staff_assignment', order._id, order.staffOpenid, toTimeValue(order.assignedAt)])
  const eventIdFor = (openid, data) => `staff_cancel_${hash([data.orderId, openid, data.assignmentToken]).slice(0, 32)}`
  async function read(store, collection, id) {
    try { return (await store.collection(collection).doc(id).get()).data || null } catch (error) {
      if (String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  function required(value, name, max = 200) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不正确`)
    return value.trim()
  }
  async function staff(openid, tx = db, userId = '') {
    const user = userId ? await read(tx, 'users', userId) : ((await db.collection('users').where({ openid }).limit(1).get()).data || [])[0]
    if (!user || user.openid !== openid || user.status !== 'active' || !Array.isArray(user.roles) || !user.roles.includes('staff')) throw new Error('仅当前有效宠托师可取消接单')
    return user
  }
  function quote(order, openid, time = now()) {
    if (!order || order.adminDeletedAt || order.staffOpenid !== openid) throw new Error('仅订单当前宠托师可取消接单')
    const assigned = toTimeValue(order.assignedAt)
    const elapsed = time.getTime() - assigned
    const direct = order.publishMode === 'direct' || order.assignmentSource === 'direct_accept' || order.assignmentSource === 'direct_auto_accept'
    const start = toTimeValue(order.startTime)
    let blocked = ''
    if (order.status !== 'assigned' || order.paymentStatus !== 'paid') blocked = '仅已支付且未开始履约的已接单订单可取消'
    else if (!assigned || elapsed < 0) blocked = '接单时间异常，请联系平台'
    else if (direct && elapsed > 600000) blocked = '指定订单接单已超过10分钟，不可取消，请联系平台客服'
    else if (!start || start - time.getTime() <= 1800000) blocked = '距服务开始不足或等于30分钟，请联系平台'
    const pending = !blocked && !direct && elapsed > 600000
    return {
      orderId: order._id, assignmentToken: assigned ? tokenFor(order) : '', publishMode: direct ? 'direct' : 'open',
      canCancel: !blocked, isFree: !blocked && !pending, amountPendingReview: pending,
      deductAmount: 0, refundAmount: direct && !blocked ? Number(order.payAmount || 0) : 0,
      returnsToPool: !direct, ruleText: blocked || (direct ? '接单10分钟内免费取消，订单全额退款' : pending ? '取消后订单返回接单大厅，保证金扣除金额待平台审核' : '接单10分钟内免费取消，订单返回接单大厅')
    }
  }
  async function getStaffCancellationQuote(openid, data = {}) {
    await staff(openid)
    const orderId = required(data.orderId, '订单编号')
    const order = await read(db, 'orders', orderId)
    return quote(order && { ...order, _id: orderId }, openid)
  }
  function cleanup(order, openid) {
    const patch = {
      staffOpenid: '', staffUserId: '', staffProfileId: '', staffName: '', staffPhone: '', staffSnapshot: null,
      requestedStaffOpenid: '', requestedStaffUserId: '', requestedStaffProfileId: '', requestedStaffName: '', requestedStaffSnapshot: null,
      assignedAt: null, assignmentSource: '', acceptLocationLatitude: null, acceptLocationLongitude: null,
      travelDeparted: false, travelDepartedAt: null, travelLocation: null, travelEtaMinutes: 0, radarProximityNotified: false,
      departedAt: null, departureLocation: null, currentLocation: null, distanceFromDestinationKm: null,
      travelDistanceKm: null, estimatedTravelMinutes: 0, estimatedArrivalTime: null,
      radarApproachingNotified: false, radarApproachingNotifiedAt: null,
      earlyStartRequest: null, remoteUnlockRequest: null, startedAt: null, completedAt: null,
      currentSessionStartedAt: null, currentSessionDate: '', finishedAt: null,
      activeSessionIndex: 0, lastCompletedSessionIndex: 0, staffUpcomingRemindedAt: null, staffUpcomingRemindedSessions: [],
      staffOverdueStartRemindedSessions: [], clientOverdueStartAlertedSessions: [], overdueFinishReminded: false,
      isStartOverdue: false, isFinishOverdue: false,
      cancelledStaffOpenids: [...new Set([...(order.cancelledStaffOpenids || []), openid])]
    }
    // Never grant historical access to the cancelling staff, including legacy aliases.
    if (order.originalStaffOpenid === openid) Object.assign(patch, { originalStaffOpenid: '', originalStaffUserId: '', originalStaffProfileId: '', originalStaffName: '', originalStaffPhone: '' })
    if (Array.isArray(order.previousStaffRecords)) patch.previousStaffRecords = order.previousStaffRecords.filter(row => row.staffOpenid !== openid)
    if (Array.isArray(order.serviceSessions)) patch.serviceSessions = order.serviceSessions.map((s, i) => ({ index: s.index || i + 1, date: s.date || '', startTime: s.startTime || '', endTime: s.endTime || '', status: 'pending' }))
    return patch
  }
  function result(event) {
    return { orderId: event.orderId, cancelled: true, status: event.publishMode === 'direct' ? 'cancelled' : 'paid', publishMode: event.publishMode,
      amountPendingReview: event.amountPendingReview, deductAmount: 0, refundAmount: event.refundAmount, returnsToPool: event.publishMode === 'open' }
  }
  function assertReplay(event, openid, data) {
    if (event.staffOpenid !== openid || event.assignmentToken !== data.assignmentToken || event.orderId !== data.orderId) throw new Error('取消请求不匹配')
    if (event.reason !== data.reason) throw new Error('同一接单取消请求不可更改原因')
  }
  async function commitCancellation(tx, current, user, openid, data, eventId, expectedMode) {
    await staff(openid, tx, user._id)
    const order = { ...current, _id: data.orderId }
    const q = quote(order, openid)
    if (!q.canCancel) throw new Error(q.ruleText)
    if (q.assignmentToken !== data.assignmentToken) throw new Error('接单记录已变化，请刷新后重试')
    if (q.publishMode !== expectedMode) throw new Error('订单发布方式已变化，请刷新后重试')
    const time = now()
    const patch = { ...cleanup(order, openid), updatedAt: time,
      ...(q.publishMode === 'open' ? { status: 'paid', publishMode: 'open' } : { status: 'cancelled', cancelReason: data.reason, cancelledAt: time }) }
    const event = { eventType: 'staff_cancellation', orderId: data.orderId, staffOpenid: openid, assignmentToken: data.assignmentToken,
      assignedAt: order.assignedAt, requestId: data.requestId, reason: data.reason, publishMode: q.publishMode,
      amountPendingReview: q.amountPendingReview, refundAmount: q.refundAmount,
      notificationStatus: 'pending', messageDone: false, subscriptionDone: false, createdAt: time, updatedAt: time,
      // Minimal immutable client notification snapshot; never include staff identities or the private reason.
      notificationOrder: { _id: data.orderId, orderNo: order.orderNo || '', clientOpenid: order.clientOpenid || '', clientUserId: order.clientUserId || '',
        serviceSummary: order.serviceSummary || '', startTime: order.startTime || '', status: patch.status } }
    if (q.amountPendingReview) {
      await tx.collection('staff_deposit_evidences').doc(eventId).set({ data: {
        orderId: data.orderId, orderNo: order.orderNo || '', staffOpenid: openid, staffUserId: user._id,
        staffProfileId: order.staffProfileId || '', staffRealName: order.staffName || '',
        reasonType: 'staff_cancellation', reasonTypeName: '宠托师接单后取消', reasonText: data.reason,
        assignedAt: order.assignedAt, cancellationEventId: eventId, deductAmount: 0, amountPendingReview: true,
        status: 'pending', statusText: '待平台审核', evidenceImages: [], createdAt: time, updatedAt: time, createdBy: openid
      } })
      patch.hasDepositPenaltyEvidence = true
      patch.depositPenaltyEvidenceIds = [...new Set([...(order.depositPenaltyEvidenceIds || []), eventId])]
    }
    await tx.collection('payment_events').doc(eventId).set({ data: event })
    const timelineTitle = q.publishMode === 'direct' ? '宠托师已取消预约' : '宠托师已取消接单'
    const timelineDetail = q.publishMode === 'direct' ? '指定宠托师取消接单，订单已关闭并发起全额退款' : '宠托师取消接单，订单已重新放回抢单大厅等待接单'
    await tx.collection('order_timeline').doc(`cancel_${eventId}`).set({
      data: {
        orderId: data.orderId,
        type: 'staff_cancellation',
        title: timelineTitle,
        detail: timelineDetail,
        actorRole: 'staff',
        createdAt: time
      }
    })
    // Serialize with assignment and role revocation on the same staff document.
    await tx.collection('users').doc(user._id).update({ data: { staffAssignmentRevision: eventId } })
    return { patch, event }
  }
  async function cancelStaffAcceptedOrder(openid, input = {}) {
    const data = { orderId: required(input.orderId, '订单编号'), assignmentToken: required(input.assignmentToken, '接单凭证'),
      reason: required(input.reason, '取消原因', 500), requestId: required(input.requestId, '请求编号') }
    const user = await staff(openid)
    const eventId = eventIdFor(openid, data)
    let event = await read(db, 'payment_events', eventId)
    if (event) assertReplay(event, openid, data)
    else {
      const order = await read(db, 'orders', data.orderId)
      const q = quote(order && { ...order, _id: data.orderId }, openid)
      if (q.assignmentToken !== data.assignmentToken) throw new Error('接单记录已变化，请刷新后重试')
      if (!q.canCancel) throw new Error(q.ruleText)
      if (q.publishMode === 'direct') {
        try {
          await createRefundForOrder({ ...order, _id: data.orderId }, q.refundAmount, data.reason, 'staff_cancel', openid, eventId, {
            cancelStatus: 'cancelled',
            beforeReserve: async (tx, current, reservation) => {
              if (reservation.collectionName !== 'orders' || reservation.requested !== Math.round(Number(current.payAmount) * 100)) throw new Error('退款金额已变化，请刷新后重试')
              return (await commitCancellation(tx, current, user, openid, data, eventId, 'direct')).patch
            }
          })
        } catch (error) {
          // Dispatch may fail AFTER reservation. The durable refund reconciler owns retries.
          event = await read(db, 'payment_events', eventId)
          if (!event) throw error
          assertReplay(event, openid, data)
        }
        event = event || await read(db, 'payment_events', eventId)
        if (!event) throw new Error('取消事件未保存，请联系平台核对')
      } else {
        event = await db.runTransaction(async tx => {
          await staff(openid, tx, user._id)
          const existing = await read(tx, 'payment_events', eventId)
          if (existing) { assertReplay(existing, openid, data); return existing }
          const current = await read(tx, 'orders', data.orderId)
          const committed = await commitCancellation(tx, current, user, openid, data, eventId, 'open')
          await tx.collection('orders').doc(data.orderId).update({ data: committed.patch })
          return committed.event
        })
      }
    }
    await deliverCancellationNotification(eventId).catch(error => console.error('[staff-cancellation-notification]', { eventId, message: error.message }))
    return result(event)
  }
  async function deliverCancellationNotification(eventId) {
    const leaseToken = crypto.randomBytes(16).toString('hex')
    const event = await db.runTransaction(async tx => {
      const row = await read(tx, 'payment_events', eventId)
      if (!row || row.notificationStatus !== 'pending' || toTimeValue(row.leaseUntil) > now().getTime()) return null
      await tx.collection('payment_events').doc(eventId).update({ data: { leaseToken, leaseUntil: new Date(now().getTime() + 120000), updatedAt: now() } })
      return row
    })
    if (!event) return
    async function update(patch) {
      await db.runTransaction(async tx => {
        const row = await read(tx, 'payment_events', eventId)
        if (row && row.leaseToken === leaseToken) await tx.collection('payment_events').doc(eventId).update({ data: { ...patch, updatedAt: now() } })
      })
    }
    const direct = event.publishMode === 'direct'
    const title = direct ? '宠托师已取消，订单退款中' : '宠托师已取消，订单等待重新接单'
    const detail = direct ? '指定宠托师已取消接单，订单已取消并发起全额退款。' : '宠托师已取消接单，订单已返回接单大厅，等待其他宠托师接单。'
    try {
      if (!event.messageDone) {
        const message = await appendOrderClientMessage(event.notificationOrder, { eventType: 'staff_cancellation', title, detail,
          actorRole: 'system', unreadForClient: true, idempotencyKey: eventId, createdAt: event.createdAt })
        if (!message) throw new Error('客户订单消息未保存')
        await update({ messageDone: true })
      }
      if (!event.subscriptionDone) {
        const sent = await notifyOrder(event.notificationOrder.clientOpenid, 'staffCancellation', event.notificationOrder,
          { statusText: direct ? '订单已取消' : '等待重新接单', tip: direct ? '宠托师取消，已发起全额退款' : '宠托师取消，等待重新接单', cancelledAt: event.createdAt }, 'client')
        if (!sent || !['sent', 'skipped'].includes(sent.status)) throw new Error('订阅通知待重试')
        await update({ subscriptionDone: true })
      }
      await update({ notificationStatus: 'done', leaseToken: '', leaseUntil: null })
    } catch (error) {
      await update({ leaseToken: '', leaseUntil: null, lastNotificationError: String(error.message || error).slice(0, 300) })
      throw error
    }
  }
  async function retryStaffCancellationNotifications() {
    const rows = (await db.collection('payment_events').where({ eventType: 'staff_cancellation', notificationStatus: 'pending' }).orderBy('updatedAt', 'asc').limit(30).get()).data || []
    for (const row of rows) {
      try { await deliverCancellationNotification(row._id) } catch (error) { console.error('[staff-cancellation-retry]', { eventId: row._id, message: error.message }) }
    }
    return rows.length
  }
  return { getStaffCancellationQuote, cancelStaffAcceptedOrder, retryStaffCancellationNotifications }
}
