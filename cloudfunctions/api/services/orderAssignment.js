const { clockHours } = require('../utils/time')
const { assertStaffGenderMatches } = require('../utils/staffGender')
const { readDocuments, documentPages, readOptionalDocument } = require('../utils/documentPages')
const { isParticipatingGroupOrder } = require('../utils/groupBuyMembership')

module.exports = function createService(context) {
  const {
    assertStaffCanAcceptOrderVaccines, attachOrderDisplayData,
    crypto, db, findStaffOrderConflict, getOrderTimeRanges, isOrderConflictCandidate,
    now, toTimeValue, validateStaffTakeOrderAbility, validateStaffScheduleOnly, maskStaffName,
    getDateKeyFromTime, parseDateTimeParts, validateSitterScheduleTime,
    enqueueOrderAccepted, enqueueOrderNotification, enqueueStaffDirectOrder, notifyStaffDirectOrder
  } = context

  const safeGetDateKey = typeof getDateKeyFromTime === 'function' ? getDateKeyFromTime : (val) => String(val || '').slice(0, 10)
  const safeParseDateTimeParts = typeof parseDateTimeParts === 'function' ? parseDateTimeParts : (val) => {
    const m = String(val || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
    return m ? { hour: Number(m[4]), minute: Number(m[5]) } : null
  }
  function assignmentTerms(order) {
    return JSON.stringify([
      getOrderTimeRanges(order), order.publishMode, order.requestedStaffOpenid, order.staffGenderRequirement,
      order.addressLatitude, order.addressLongitude, order.serviceLatitude, order.serviceLongitude
    ])
  }

  async function lockStaff(transaction, id, openid) {
    const user = (await transaction.collection('users').doc(id).get().catch(() => ({ data: null }))).data
    if (!user || user.openid !== openid || user.status !== 'active' || !Array.isArray(user.roles) || !user.roles.includes('staff')) {
      throw new Error('宠托师账号不可接单')
    }
    return user
  }

  async function assertNoConflict(transaction, openid, order, orderId) {
    const ranges = getOrderTimeRanges(order)
    if (!ranges.length || ranges.some(range => !toTimeValue(range.startTime) || toTimeValue(range.endTime) <= toTimeValue(range.startTime))) {
      throw new Error('订单服务时间不完整，无法分配')
    }
    if (await findStaffOrderConflict(openid, order, orderId, transaction)) {
      throw new Error('宠托师该时间段已有订单，无法重复预约')
    }
  }

  async function assertStaffAssignmentLimits(transaction, staffOpenid, bundle, dispatchConfig = {}) {
    const ids = new Set(bundle.map(order => order._id))
    const statuses = ['assigned', 'on_the_way', 'in_service', 'day_completed', 'completed']
    const rows = (await readDocuments(transaction, db.command, 'orders', {
      staffOpenid, status: db.command.in(statuses)
    })).filter(order => order && !order.deletedAt && !order.adminDeletedAt && !ids.has(order._id))
    const activeCount = rows.filter(order => order.status !== 'completed').length
    const maxActiveOrders = Number(dispatchConfig.maxStaffActiveOrders || 8)
    if (activeCount + bundle.length > maxActiveOrders) {
      throw new Error(`您当前进行中订单已有 ${activeCount} 笔，已达接单上限（最多 ${maxActiveOrders} 笔），请先履约完成后再接新单`)
    }
    const datesOf = order => {
      const sessions = Array.isArray(order.serviceSessions) && order.serviceSessions.length
        ? order.serviceSessions : [{ startTime: order.startTime || order.serviceStartDate }]
      return new Set(sessions.filter(session => session.status !== 'cancelled')
        .map(session => safeGetDateKey(session.startTime) || session.date).filter(Boolean))
    }
    const incomingCounts = new Map()
    for (const order of bundle) {
      for (const date of datesOf(order)) incomingCounts.set(date, (incomingCounts.get(date) || 0) + 1)
    }
    const existingCounts = new Map()
    for (const order of rows) {
      for (const date of datesOf(order)) existingCounts.set(date, (existingCounts.get(date) || 0) + 1)
    }
    const maxDailyOrders = Number(dispatchConfig.maxStaffDailyOrders || 6)
    for (const [date, count] of incomingCounts) {
      const existing = existingCounts.get(date) || 0
      if (existing + count > maxDailyOrders) {
        throw new Error(`您在 ${date} 已接单 ${existing} 笔，已达单日接单上限（${maxDailyOrders} 笔），请合理规划时间避免服务延误`)
      }
    }
  }

  async function assertVaccinesStillAllowed(profile, order) {
    if (typeof assertStaffCanAcceptOrderVaccines !== 'function') return
    const orderForVaccineCheck = typeof attachOrderDisplayData === 'function' ? await attachOrderDisplayData(order) : order
    assertStaffCanAcceptOrderVaccines(profile, orderForVaccineCheck)
  }

  async function assignOrderAtomically(orderId, expectedOrder, patch, options = {}) {
    const assignedOrder = await db.runTransaction(async transaction => {
      // All assignment paths write the same user document, preventing cross-order write skew.
      await lockStaff(transaction, patch.staffUserId, patch.staffOpenid)
      const profile = (await transaction.collection('staff_profiles').doc(patch.staffProfileId).get().catch(() => ({ data: null }))).data
      if (!profile || profile.openid !== patch.staffOpenid) throw new Error('宠托师资料不匹配')
      const ability = validateStaffTakeOrderAbility(profile, options.depositConfig)
      if (!ability.can) throw new Error(ability.message || '宠托师当前不可接单')
      const order = (await transaction.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
      if (!order || order.status !== 'paid' || order.staffOpenid || order.adminDeletedAt) throw new Error('订单已被分配或状态不可接单')
      if (order.paymentStatus !== 'paid') throw new Error('订单支付或退款状态不可接单，请等待支付退款结果')
      if (assignmentTerms(order) !== assignmentTerms(expectedOrder)) throw new Error('订单预约信息已变化，请刷新后重新接单')
      let bundle = [order]
      if (order.groupBuyId) {
        if (order.groupBuyStatus !== 'formed') throw new Error('拼单尚未成团，暂不可接单')
        const rows = []
        let cursor = ''
        do {
          const page = (await transaction.collection('orders').where({ groupBuyId: order.groupBuyId,
            ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy('_id', 'asc').limit(100).get()).data || []
          rows.push(...page)
          cursor = page.length === 100 ? page[page.length - 1]._id : ''
        } while (cursor)
        bundle = rows.filter(isParticipatingGroupOrder)
        if (bundle.some(member => member.paymentStatus === 'refunding')) throw new Error('拼单住户退款处理中，请等待退款结果后再整团派单')
        if (!bundle.some(o => o._id === orderId)) throw new Error('拼单成员已变化，请刷新后重试')
        const group = (await transaction.collection('pet_playground_groups').doc(order.groupBuyId).get().catch(() => ({ data: null }))).data
        if (group) {
          if (group.status === 'cancelled' || !group.formedAt) throw new Error('拼单已取消或尚未成团')
          await transaction.collection('pet_playground_groups').doc(order.groupBuyId).update({ data: { assignmentRevision: crypto.randomBytes(16).toString('hex') } })
        }
      }
      if (options.enforceAcceptLimits) await assertStaffAssignmentLimits(transaction, patch.staffOpenid, bundle, options.dispatchConfig || {})
      for (const member of bundle) {
        if (member.status !== 'paid' || member.staffOpenid) throw new Error('拼单中有订单已被分配或状态不可接单')
        if (member.paymentStatus !== 'paid') throw new Error('订单支付或退款状态不可接单，请等待支付退款结果')
        assertStaffGenderMatches(member, profile)
        await assertVaccinesStillAllowed(profile, member)
        const start = toTimeValue(member.startTime || member.serviceSessions?.[0]?.startTime)
        if (start > 0 && start <= now().getTime()) throw new Error('订单服务时间已过，无法接单')
        if ((member.groupBuyId || member.source === 'community_groupbuy') && start > 0 && start - 2 * 3600000 <= now().getTime()) throw new Error('拼单已到服务开始前2小时截止时间，无法接单')
        if (!options.admin && member.requestedStaffOpenid && member.requestedStaffOpenid !== patch.staffOpenid) throw new Error('该订单指定了其他宠托师')
        await assertNoConflict(transaction, patch.staffOpenid, member, member._id)
        if (options.enforceAcceptLimits && !options.admin) {
          const lat = Number(member.serviceLatitude || member.addressLatitude), lng = Number(member.serviceLongitude || member.addressLongitude)
          if (!context.hasCoordinate(patch.acceptLocationLatitude, patch.acceptLocationLongitude) || !context.hasCoordinate(lat, lng)) throw new Error('缺少有效的实时位置或订单定位，无法接单')
          if (context.calcDistanceKm(patch.acceptLocationLatitude, patch.acceptLocationLongitude, lat, lng) > Number(profile.serviceRadiusKm || 5)) throw new Error('订单超出当前服务范围，无法接单')
        }
        for (const range of getOrderTimeRanges(member)) {
          try { await validateStaffScheduleOnly(profile, range.startTime, range.endTime) }
          catch (error) { if (!options.riskConfirmed) throw error }
        }
      }
      await transaction.collection('users').doc(patch.staffUserId).update({ data: { staffAssignmentRevision: crypto.randomBytes(16).toString('hex') } })
      const assignedMembers = []
      for (const member of bundle) {
        const assignmentPatch = { ...patch, assignmentNoticeRevision: Number(member.assignmentNoticeRevision || 0) + 1 }
        await transaction.collection('orders').doc(member._id).update({ data: assignmentPatch })
        const assigned = { ...member, ...assignmentPatch }
        if (options.admin && assigned.assignmentSource !== 'direct_auto_accept') await enqueueOrderNotification(transaction, member.clientOpenid, 'orderAssigned', assigned, { statusText: '已派单' })
        else await enqueueOrderAccepted(transaction, assigned, maskStaffName(profile.realName))
        if (options.admin) await enqueueStaffDirectOrder(transaction, assigned, 'assignment')
        assignedMembers.push(assigned)
      }
      return { ...assignedMembers.find(member => member._id === orderId), bundledCount: assignedMembers.length }
    })
    if (options.admin) await notifyStaffDirectOrder(assignedOrder, 'assignment')
    return assignedOrder
  }

  async function updateOrderStatusWithScheduling(orderId, expectedOrder, patch) {
    const user = expectedOrder.staffOpenid
      ? (await db.collection('users').where({ openid: expectedOrder.staffOpenid }).limit(1).get()).data[0]
      : null
    return db.runTransaction(async transaction => {
      const order = (await transaction.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
      if (!order || order.status !== expectedOrder.status || order.staffOpenid !== expectedOrder.staffOpenid || assignmentTerms(order) !== assignmentTerms(expectedOrder)) {
        throw new Error('订单状态已变化，请刷新后重试')
      }
      const updated = { ...order, ...patch }
      // 服务开始后订单归属和履约状态只能由正常服务流程推进，禁止管理员
      // 通过手动回退状态再走派单接口，变相重新指派订单。
      const serviceStartedStatuses = ['in_service', 'day_completed', 'completed']
      const assignmentChanged = ['staffOpenid', 'staffUserId', 'staffProfileId'].some((key) =>
        Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== order[key]
      )
      if (serviceStartedStatuses.includes(order.status) && (assignmentChanged || updated.status !== order.status)) {
        throw new Error('订单已开始履约，不允许修改状态或重新指派宠托师')
      }
      if (['assigned', 'on_the_way'].includes(order.status) && assignmentChanged && order.staffOpenid) {
        throw new Error('订单已指派，不允许直接修改宠托师归属，请使用受控改派流程')
      }
      if (['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(updated.status) && !updated.staffOpenid) throw new Error('请先为订单分配宠托师')
      if (updated.staffOpenid && isOrderConflictCandidate(updated)) {
        if (!user) throw new Error('宠托师账号不存在')
        await lockStaff(transaction, user._id, updated.staffOpenid)
        await assertNoConflict(transaction, updated.staffOpenid, updated, orderId)
        await transaction.collection('users').doc(user._id).update({ data: { staffAssignmentRevision: crypto.randomBytes(16).toString('hex') } })
      }
      await transaction.collection('orders').doc(orderId).update({ data: patch })
      return { ...updated, _id: orderId }
    })
  }

  function rangeOnBeijingDate(range, dateKey) {
    const dayStart = toTimeValue(dateKey)
    const start = Math.max(toTimeValue(range.startTime), dayStart)
    const end = Math.min(toTimeValue(range.endTime), dayStart + 86400000)
    return dayStart && start < end ? { startTime: new Date(start), endTime: new Date(end), endsAtMidnight: end === dayStart + 86400000 } : null
  }

  async function saveStaffScheduleException(user, payload, remove = false) {
    return db.runTransaction(async tx => {
      await lockStaff(tx, user._id, user.openid)
      const candidates = (await db.collection('staff_schedule_exceptions').where({ staffOpenid: user.openid, dateKey: payload.dateKey }).limit(2).get()).data || []
      if (candidates.length > 1) throw new Error('当日排班重复，请先核对')

      const activeStatuses = ['assigned', 'on_the_way', 'in_service', 'day_completed']
      const _ = db.command
      const inOp = _ && typeof _.in === 'function' ? _.in.bind(_) : (arr) => ({ $in: arr })
      const activeOrders = await readDocuments(tx, db.command, 'orders', {
        staffOpenid: user.openid,
        status: inOp(activeStatuses)
      })

      const activeOrdersOnDate = activeOrders.filter(order => {
        if (order.adminDeletedAt) return false
        const ranges = typeof getOrderTimeRanges === 'function' ? getOrderTimeRanges(order) : (order.startTime && order.endTime ? [{ startTime: order.startTime, endTime: order.endTime }] : [])
        return ranges.some(range => rangeOnBeijingDate(range, payload.dateKey))
      })

      if (activeOrdersOnDate.length > 0) {
        if (remove) {
          const profileRes = await db.collection('staff_profiles').where({ openid: user.openid }).limit(1).get().catch(() => ({ data: [] }))
          const profile = profileRes.data && profileRes.data[0]
          if (profile && typeof validateSitterScheduleTime === 'function') {
            for (const order of activeOrdersOnDate) {
              const ranges = typeof getOrderTimeRanges === 'function' ? getOrderTimeRanges(order) : (order.startTime && order.endTime ? [{ startTime: order.startTime, endTime: order.endTime }] : [])
              for (const range of ranges) {
                const segment = rangeOnBeijingDate(range, payload.dateKey)
                if (segment) {
                  try {
                    validateSitterScheduleTime(profile.weeklySchedule, segment.startTime, segment.endTime)
                  } catch (err) {
                    throw new Error('当日已有待履约服务订单，清除例外排班后常规周排班无法覆盖已有订单时段')
                  }
                }
              }
            }
          }
        } else if (payload.status === 'unavailable') {
          throw new Error('当日已有待履约服务订单，无法设置为休息，请先联系平台协调改派')
        } else if (payload.status === 'available') {
          const slots = Array.isArray(payload.slots) ? payload.slots : []
          for (const order of activeOrdersOnDate) {
            const ranges = typeof getOrderTimeRanges === 'function' ? getOrderTimeRanges(order) : (order.startTime && order.endTime ? [{ startTime: order.startTime, endTime: order.endTime }] : [])
            for (const range of ranges) {
              const segment = rangeOnBeijingDate(range, payload.dateKey)
              if (segment) {
                const sParts = safeParseDateTimeParts(segment.startTime)
                const eParts = safeParseDateTimeParts(segment.endTime)
                if (sParts && eParts) {
                  const sVal = clockHours(sParts)
                  const eVal = segment.endsAtMidnight ? 24 : clockHours(eParts)
                  const fits = slots.some(slot => sVal >= slot.start && eVal <= slot.end)
                  if (!fits) {
                    throw new Error('当日已有待履约服务订单不在调整后的接单时段内，无法修改排班')
                  }
                }
              }
            }
          }
        }
      }

      const id = candidates[0]?._id || `schedule_${crypto.createHash('sha256').update(`${user.openid}:${payload.dateKey}`).digest('hex').slice(0, 32)}`
      const time = now()
      await tx.collection('users').doc(user._id).update({ data: { staffAssignmentRevision: crypto.randomBytes(16).toString('hex') } })
      if (remove) {
        if (candidates[0]) await tx.collection('staff_schedule_exceptions').doc(id).remove()
        return { dateKey: payload.dateKey, deleted: true }
      }
      const value = { ...payload, staffOpenid: user.openid, createdAt: candidates[0]?.createdAt || time, updatedAt: time }
      await tx.collection('staff_schedule_exceptions').doc(id).set({ data: value })
      return { _id: id, ...value }
    })
  }

  async function autoAcceptDueDirectOrders() {
    const time = now()
    const currentTs = time.getTime()
    const acceptedList = []

    for await (const orders of documentPages(db, db.command, 'orders', { publishMode: 'direct', status: 'paid' })) {
      for (const order of orders) {
        if (!order.requestedStaffOpenid || order.staffOpenid || order.paymentStatus !== 'paid') continue
        const paidTs = toTimeValue(order.paidAt || order.createdAt)
        if (!paidTs) continue
        if (currentTs - paidTs >= 3600000) {
          const startTs = toTimeValue(order.startTime)
          if (startTs > 0 && startTs <= currentTs) continue

          try {
            const profileRes = await db.collection('staff_profiles').where({ openid: order.requestedStaffOpenid }).limit(1).get()
            const profile = profileRes.data && profileRes.data[0]
            const userRes = await db.collection('users').where({ openid: order.requestedStaffOpenid }).limit(1).get()
            const staffUser = userRes.data && userRes.data[0]

            const settings = typeof context.getSystemSettings === 'function' ? await context.getSystemSettings() : {}
            const ability = profile && (typeof validateStaffTakeOrderAbility === 'function' ? validateStaffTakeOrderAbility(profile, settings.staffDeposit) : { can: true })
            if (!profile || !staffUser || !ability.can || profile.auditStatus !== 'approved' || staffUser.status !== 'active' || !Array.isArray(staffUser.roles) || !staffUser.roles.includes('staff')) {
              const republished = await db.runTransaction(async tx => {
                const current = await readOptionalDocument(tx, 'orders', order._id)
                if (!current || current.status !== 'paid' || current.paymentStatus !== 'paid' || current.staffOpenid ||
                    current.publishMode !== 'direct' || current.requestedStaffOpenid !== order.requestedStaffOpenid ||
                    assignmentTerms(current) !== assignmentTerms(order)) return false
                const latestPaidAt = toTimeValue(current.paidAt || current.createdAt)
                if (!latestPaidAt || currentTs - latestPaidAt < 3600000) return false
                // Query the identity again so a restored/recreated record also preserves the appointment.
                const latestProfile = (await tx.collection('staff_profiles').where({ openid: current.requestedStaffOpenid }).limit(1).get()).data?.[0]
                const latestUser = (await tx.collection('users').where({ openid: current.requestedStaffOpenid }).limit(1).get()).data?.[0]
                const latestAbility = latestProfile && (typeof validateStaffTakeOrderAbility === 'function'
                  ? validateStaffTakeOrderAbility(latestProfile, settings.staffDeposit) : { can: true })
                if (latestProfile?.openid === order.requestedStaffOpenid && latestUser?.openid === order.requestedStaffOpenid &&
                    latestProfile.auditStatus === 'approved' && latestUser.status === 'active' &&
                    Array.isArray(latestUser.roles) && latestUser.roles.includes('staff') && latestAbility.can) return false
                await tx.collection('orders').doc(order._id).update({ data: {
                  publishMode: 'open',
                  requestedStaffOpenid: '',
                  requestedStaffProfileId: '',
                  requestedStaffUserId: '',
                  requestedStaffName: '',
                  requestedStaffSnapshot: null,
                  updatedAt: time
                } })
                if (latestUser) await tx.collection('users').doc(latestUser._id).update({ data: { staffAssignmentRevision: crypto.randomBytes(16).toString('hex') } })
                return true
              })
              if (republished && typeof context.appendOrderTimeline === 'function') {
                await context.appendOrderTimeline(order._id, 'republished_open', '指定单转公开派单', '指定宠托师资质状态变动或不可接单，系统已自动转为公开派单', 'system').catch(() => {})
              }
              continue
            }

            const assignmentUpdate = {
              staffUserId: staffUser._id,
              staffOpenid: order.requestedStaffOpenid,
              staffProfileId: profile._id,
              staffName: profile.realName || order.requestedStaffName || '宠托师',
              staffPhone: profile.phone || '',
              status: 'assigned',
              assignmentSource: 'direct_auto_accept',
              assignedAt: time,
              updatedAt: time
            }

            const assigned = await assignOrderAtomically(order._id, order, assignmentUpdate, { admin: true, riskConfirmed: true, depositConfig: settings.staffDeposit, dispatchConfig: settings.dispatch || {}, enforceAcceptLimits: true })
            if (assigned) {
              const title = '指定预约超时已自动接单'
              const detail = '指定宠托师超过1小时未手动操作，系统已自动接单。'
              if (typeof context.appendOrderTimeline === 'function') {
                await context.appendOrderTimeline(order._id, 'assigned', title, detail, 'system').catch(() => {})
              }
              if (typeof context.appendOrderClientMessage === 'function') {
                await context.appendOrderClientMessage(assigned, { eventType: 'assigned', title, detail, actorRole: 'system' }).catch(() => {})
              }
              if (typeof context.notifyOrderAccepted === 'function') {
                await context.notifyOrderAccepted(assigned, profile.realName || '').catch(() => {})
              }
              acceptedList.push(order._id)
            }
          } catch (e) {
            console.error('[autoAcceptDueDirectOrders] failed to accept', { orderId: order._id, error: e.message })
          }
        }
      }
    }
    return acceptedList
  }

  return { assignOrderAtomically, updateOrderStatusWithScheduling, saveStaffScheduleException, autoAcceptDueDirectOrders }
}
