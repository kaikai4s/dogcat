module.exports = function createService({
  ORDER_STATUS,
  appendOrderClientMessage,
  appendOrderStaffMessage,
  appendOrderTimeline,
  completeOrderService,
  db,
  evaluateCheckinCompletion,
  formatDateTime,
  getActiveServiceSession,
  getNextPendingServiceSession,
  makeIdempotencyKey,
  normalizeServiceSessions,
  notifyAdmins,
  notifyOrder,
  now,
  toTimeValue
}) {
  async function readActiveOrders(condition = {}, maxLimit = 1000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const query = { ...condition }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        query._id = db.command.gt(cursor)
      }
      const page = (await db.collection('orders').where(query).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
    return rows
  }

  async function processOverdueUnstartedOrders(currentTime = now()) {
    const currentTs = toTimeValue(currentTime)
    if (!currentTs) return []
    const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
    const windowStartTs = currentTs - ACTIVE_WINDOW_MS
    const windowStartText = `${formatDateTime(windowStartTs).slice(0, 10)} 00:00`

    const _ = db.command
    const whereAssigned = { status: ORDER_STATUS.ASSIGNED }
    const whereDayCompleted = { status: ORDER_STATUS.DAY_COMPLETED }
    if (_ && typeof _.gte === 'function') {
      whereAssigned.startTime = _.gte(windowStartText)
      whereDayCompleted.startTime = _.gte(windowStartText)
    }

    const [assignedOrders, dayCompletedOrders] = await Promise.all([
      readActiveOrders(whereAssigned),
      readActiveOrders(whereDayCompleted)
    ])
    const candidates = [...assignedOrders, ...dayCompletedOrders]
    const processed = []

    for (const order of candidates) {
      if (!order.staffOpenid) continue
      const activeSession = getActiveServiceSession(order)
      const nextSession = getNextPendingServiceSession(order)
      const targetSession = activeSession || nextSession || (Array.isArray(order.serviceSessions) && order.serviceSessions[0]) || { index: 1, startTime: order.startTime }
      const sessionIndex = Number(targetSession.index || 1)
      const sessionStartTime = toTimeValue((targetSession && targetSession.startTime) || order.startTime)
      if (!sessionStartTime || sessionStartTime < windowStartTs) continue

      const overdueMs = currentTs - sessionStartTime
      if (overdueMs < 15 * 60 * 1000) continue

      const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
      const timeText = (targetSession && targetSession.startTime) || order.startTime || formatDateTime(sessionStartTime)
      const remindedSessions = Array.isArray(order.staffOverdueStartRemindedSessions) ? order.staffOverdueStartRemindedSessions : []
      const clientAlertedSessions = Array.isArray(order.clientOverdueStartAlertedSessions) ? order.clientOverdueStartAlertedSessions : []
      const updates = {}

      // 阶段 1：超时 15 分钟未开始 -> 催促宠托师尽快履约
      if (overdueMs >= 15 * 60 * 1000 && !remindedSessions.includes(sessionIndex)) {
        await notifyOrder(order.staffOpenid, 'serviceStart', order, {
          statusText: '服务已超时未开始',
          tip: `约定于 ${timeText} 开始，已超时 15 分钟，请尽快打卡开始`
        }, 'staff')

        await appendOrderStaffMessage(order, {
          eventType: 'overdue_unstarted_warning',
          title: '服务已超时未开始提醒',
          detail: `您的订单（${serviceName}）约定于 ${timeText} 开始，现已超时超过 15 分钟尚未开始服务。请尽快到达服务地点并打卡开始，以免产生爽约客诉或违约处罚。`,
          actorRole: 'system',
          idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'overdue_unstarted_warning', String(sessionIndex))
        })

        await appendOrderTimeline(order._id, 'overdue_unstarted_warning', '服务超时未开始催促', `第${sessionIndex}天服务已超时 15 分钟尚未开始，系统已提醒催促宠托师尽快到场履约。`, 'system')

        updates.staffOverdueStartRemindedSessions = [...remindedSessions, sessionIndex]
      }

      // 阶段 2：超时 30 分钟未开始 -> 提醒宠物主并标记异常预警
      if (overdueMs >= 30 * 60 * 1000 && !clientAlertedSessions.includes(sessionIndex)) {
        await notifyOrder(order.clientOpenid, 'serviceStart', order, {
          statusText: '服务未按时开始',
          tip: '宠托师尚未开始服务，平台已介入催促跟进'
        }, 'client')

        await appendOrderClientMessage(order, {
          eventType: 'overdue_unstarted_client_notice',
          title: '服务未按时开始提醒',
          detail: `您预约于 ${timeText} 的服务（${serviceName}）已超时 30 分钟尚未开始。系统已多次催促宠托师，您可在订单页面联系宠托师或在线客服协助处理。`,
          actorRole: 'system',
          unreadForClient: true
        })

        await appendOrderTimeline(order._id, 'overdue_unstarted_alert', '服务严重超时异常预警', `服务已超时 30 分钟仍未开始，系统已提醒宠物主并触发异常跟进。`, 'system')

        if (typeof notifyAdmins === 'function') {
          const staffUserRes = order.staffOpenid ? await db.collection('users').where({ openid: order.staffOpenid }).limit(1).get() : { data: [] }
          const staffUser = (staffUserRes.data && staffUserRes.data[0]) || {}
          const staffProfileRes = order.staffProfileId ? await db.collection('staff_profiles').doc(order.staffProfileId).get() : { data: null }
          const staffProfile = staffProfileRes.data || {}
          const staffName = staffProfile.name || staffUser.name || order.staffName || '已指派宠托师'
          const staffPhone = staffProfile.phone || staffUser.phone || '未填写'
          const clientPhone = (order.clientSnapshot && order.clientSnapshot.phoneMasked) || (order.clientContact && order.clientContact.phone) || '未填写'

          await notifyAdmins({
            type: 'order_start_overdue',
            level: 'urgent',
            title: `【超时未开始预警】订单 ${order.orderNo || order._id} 超时30分钟未开始`,
            content: `订单（${serviceName}）原约定于 ${timeText} 开始，已超时 30 分钟。当前宠托师：${staffName}（电话：${staffPhone}），客户电话：${clientPhone}。请立即电话联系宠托师；如无法继续履约，可在后台将其转为【加急公共抢单】重新调度！`,
            orderId: order._id,
            orderNo: order.orderNo || '',
            actionUrl: `/pages/admin/orders/detail/index?id=${order._id}`,
            extra: {
              sessionIndex,
              serviceName,
              startTime: timeText,
              staffName,
              staffPhone,
              clientPhone
            },
            idempotencyKey: makeIdempotencyKey('admin_notice_start_overdue', order._id, String(sessionIndex))
          })
        }

        updates.clientOverdueStartAlertedSessions = [...clientAlertedSessions, sessionIndex]
        updates.isStartOverdue = true
      }

      if (Object.keys(updates).length > 0) {
        const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
        updates.updatedAt = time
        await db.collection('orders').doc(order._id).update({ data: updates })
        processed.push({ orderId: order._id, sessionIndex, updates })
      }
    }

    return processed
  }

  async function processOverdueUnfinishedOrders(currentTime = now()) {
    const currentTs = toTimeValue(currentTime)
    if (!currentTs) return []
    const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
    const windowStartTs = currentTs - ACTIVE_WINDOW_MS
    const windowStartText = `${formatDateTime(windowStartTs).slice(0, 10)} 00:00`

    const _ = db.command
    const whereInService = { status: ORDER_STATUS.IN_SERVICE }
    if (_ && typeof _.gte === 'function') {
      whereInService.startTime = _.gte(windowStartText)
    }

    const orders = await readActiveOrders(whereInService)
    const processed = []

    for (const order of orders) {
      const activeSession = getActiveServiceSession(order) || normalizeServiceSessions(order)[0] || { index: 1 }
      const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
      if (sessionStartedAt && sessionStartedAt < windowStartTs) continue
      const sessionEndTime = toTimeValue((activeSession && activeSession.endTime) || order.endTime)
      const durationMs = (Math.max(Number(order.durationMinutes || 60), 30)) * 60 * 1000
      const estimatedEndTime = sessionEndTime || (sessionStartedAt ? sessionStartedAt + durationMs : 0)
      if (!estimatedEndTime) continue

      const overdueMs = currentTs - estimatedEndTime
      if (overdueMs < 15 * 60 * 1000) continue

      const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
      const checkinResult = await evaluateCheckinCompletion({ ...order, _id: order._id }, sessionStartedAt || currentTs)

      const sessionIndex = Number(activeSession.index || 1)
      const autoCompletedSessions = Array.isArray(order.autoCompletedSessions) ? order.autoCompletedSessions : []
      const isAutoCompletedForSession = autoCompletedSessions.includes(sessionIndex) || (sessionIndex === 1 && order.autoCompleted === true && !order.autoCompletedSessions)

      // 情况 1：打卡凭证齐全，超时 30 分钟未结束 -> 智能自动完成服务并结算
      if (overdueMs >= 30 * 60 * 1000 && checkinResult.isComplete && !isAutoCompletedForSession) {
        const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
        const completeRes = await completeOrderService({ ...order, _id: order._id }, activeSession, time, { isAuto: true, actor: 'system' })
        processed.push({ orderId: order._id, sessionIndex, type: 'auto_completed', result: completeRes })
        continue
      }

      // 情况 2：严重超时 60 分钟且打卡缺失 -> 自动创建异常工单介入跟进
      const incidentSessions = Array.isArray(order.finishOverdueIncidentSessions) ? order.finishOverdueIncidentSessions : []
      const hasCreatedIncidentForSession = incidentSessions.includes(sessionIndex) || (sessionIndex === 1 && order.finishOverdueIncidentCreated === true && !order.finishOverdueIncidentSessions)
      if (overdueMs >= 60 * 60 * 1000 && !checkinResult.isComplete && !hasCreatedIncidentForSession) {
        const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
        await appendOrderTimeline(order._id, 'finish_overdue_incident', '服务严重超时未结束告警', `服务已超时 60 分钟且打卡凭证缺失（${checkinResult.missing.join('、')}），系统已转平台客服紧急跟进。`, 'system')
        await appendOrderClientMessage(order, {
          eventType: 'service_finish_overdue_notice',
          title: '服务进行中超时提醒',
          detail: `您的订单（${serviceName}）已超出预计服务时间，平台客服已介入跟进宠托师现场服务进展，确保宠物与家庭安全。`,
          actorRole: 'system',
          unreadForClient: true
        })

        if (order.staffOpenid) {
          await appendOrderStaffMessage(order, {
            eventType: 'finish_overdue_incident',
            title: '服务严重超时警报',
            detail: `您的订单（${serviceName}）已超出预计结束时间 60 分钟以上，且仍缺少打卡凭证（${checkinResult.missing.join('、')}）。平台已生成客服异常工单跟进，请立即核实打卡或联系客服！`,
            actorRole: 'system',
            idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'finish_overdue_incident', String(sessionIndex))
          })
        }

        const incidentId = `inc_${order._id}_${sessionIndex}_finish_overdue`
        await db.collection('order_incidents').doc(incidentId).set({
          data: {
            orderId: order._id,
            orderNo: order.orderNo || '',
            sessionIndex,
            clientOpenid: order.clientOpenid,
            staffOpenid: order.staffOpenid,
            type: 'service_finish_overdue',
            title: '服务严重超时未结束且缺少打卡',
            detail: `订单第${sessionIndex}场服务已超出预计结束时间 60 分钟以上，仍缺少必要打卡：${checkinResult.missing.join('、')}，请平台客服紧急联系宠托师与客户核实情况。`,
            status: 'open',
            createdAt: time,
            updatedAt: time
          }
        })

        if (typeof notifyAdmins === 'function') {
          await notifyAdmins({
            type: 'order_finish_overdue',
            level: 'urgent',
            title: `【服务超时未完成告警】订单 ${order.orderNo || order._id} 第${sessionIndex}场服务缺少关键打卡`,
            content: `订单（${serviceName}）第${sessionIndex}场服务已超出预计时间 60 分钟以上，且缺少必要打卡（${checkinResult.missing.join('、')}），已自动创建异常工单介入跟进。`,
            orderId: order._id,
            orderNo: order.orderNo || '',
            actionUrl: `/pages/admin/orders/detail/index?id=${order._id}`,
            idempotencyKey: makeIdempotencyKey('admin_notice_finish_overdue', order._id, String(sessionIndex))
          })
        }

        const nextIncidentSessions = Array.from(new Set([...incidentSessions, sessionIndex]))
        const remindedSessions = Array.isArray(order.overdueFinishRemindedSessions) ? order.overdueFinishRemindedSessions : []
        const nextRemindedSessions = Array.from(new Set([...remindedSessions, sessionIndex]))

        await db.collection('orders').doc(order._id).update({
          data: {
            finishOverdueIncidentSessions: nextIncidentSessions,
            overdueFinishRemindedSessions: nextRemindedSessions,
            finishOverdueIncidentCreated: true,
            overdueFinishReminded: true,
            overdueFinishRemindedAt: time,
            isFinishOverdue: true,
            updatedAt: time
          }
        })
        processed.push({ orderId: order._id, sessionIndex, type: 'incident_created' })
        continue
      }

      // 情况 3：超时 15 分钟未结束 -> 发送催促提醒
      const remindedSessions = Array.isArray(order.overdueFinishRemindedSessions) ? order.overdueFinishRemindedSessions : []
      const hasRemindedForSession = remindedSessions.includes(sessionIndex) || (sessionIndex === 1 && order.overdueFinishReminded === true && !order.overdueFinishRemindedSessions)
      if (overdueMs >= 15 * 60 * 1000 && !hasRemindedForSession) {
        const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
        if (checkinResult.isComplete) {
          await appendOrderStaffMessage(order, {
            eventType: 'overdue_finish_reminder',
            title: '请及时确认完成服务',
            detail: `您的订单（${serviceName}）已超出约定服务时间，检测到打卡凭证已齐全。请及时在服务页点击【完成服务】进行结算。若超出 30 分钟仍未操作，系统将自动帮您结算完成。`,
            actorRole: 'system',
            idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'overdue_finish_reminder', String(sessionIndex))
          })
          await notifyOrder(order.staffOpenid, 'serviceFinish', order, {
            statusText: '请及时完成服务',
            tip: '订单打卡已齐全，请及时点击完成服务进行结算'
          }, 'staff')
        } else {
          await appendOrderStaffMessage(order, {
            eventType: 'overdue_finish_reminder',
            title: '服务超时未结束提醒',
            detail: `您的订单（${serviceName}）已超出预计服务时间，且尚缺少打卡凭证（${checkinResult.missing.join('、')}）。请确认服务进度并及时补全打卡与点击完成服务。`,
            actorRole: 'system',
            idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'overdue_finish_reminder', String(sessionIndex))
          })
        }

        await appendOrderTimeline(order._id, 'overdue_finish_reminder', '服务超时未结束催促', checkinResult.isComplete ? '打卡已齐全，系统已提醒宠托师尽快点击完成服务。' : `服务已超时，尚缺少打卡（${checkinResult.missing.join('、')}），已提醒宠托师。`, 'system')

        const nextRemindedSessions = Array.from(new Set([...remindedSessions, sessionIndex]))
        await db.collection('orders').doc(order._id).update({
          data: {
            overdueFinishRemindedSessions: nextRemindedSessions,
            overdueFinishReminded: true,
            overdueFinishRemindedAt: time,
            isFinishOverdue: true,
            updatedAt: time
          }
        })
        processed.push({ orderId: order._id, sessionIndex, type: 'reminded', checkinComplete: checkinResult.isComplete })
        continue
      }
    }

    return processed
  }

  return {
    processOverdueUnstartedOrders,
    processOverdueUnfinishedOrders
  }
}
