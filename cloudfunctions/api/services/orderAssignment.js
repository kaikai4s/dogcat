module.exports = function createService({
  crypto, db, findStaffOrderConflict, getOrderTimeRanges, isOrderConflictCandidate,
  now, toTimeValue, validateStaffTakeOrderAbility, validateStaffScheduleOnly
}) {
  function assignmentTerms(order) {
    return JSON.stringify([
      getOrderTimeRanges(order), order.publishMode, order.requestedStaffOpenid,
      order.addressLatitude, order.addressLongitude, order.serviceLatitude, order.serviceLongitude
    ])
  }

  async function lockStaff(transaction, id, openid) {
    const user = (await transaction.collection('users').doc(id).get()).data
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

  async function assignOrderAtomically(orderId, expectedOrder, patch, options = {}) {
    return db.runTransaction(async transaction => {
      // All assignment paths write the same user document, preventing cross-order write skew.
      await lockStaff(transaction, patch.staffUserId, patch.staffOpenid)
      const profile = (await transaction.collection('staff_profiles').doc(patch.staffProfileId).get()).data
      if (!profile || profile.openid !== patch.staffOpenid) throw new Error('宠托师资料不匹配')
      const ability = validateStaffTakeOrderAbility(profile, options.depositConfig)
      if (!ability.can) throw new Error(ability.message || '宠托师当前不可接单')
      const order = (await transaction.collection('orders').doc(orderId).get()).data
      if (!order || order.status !== 'paid' || order.staffOpenid || order.adminDeletedAt) throw new Error('订单已被分配或状态不可接单')
      if (assignmentTerms(order) !== assignmentTerms(expectedOrder)) throw new Error('订单预约信息已变化，请刷新后重新接单')
      if (toTimeValue(order.startTime) > 0 && toTimeValue(order.startTime) <= now().getTime()) throw new Error('订单服务时间已过，无法接单')
      if (!options.admin && order.requestedStaffOpenid && order.requestedStaffOpenid !== patch.staffOpenid) throw new Error('该订单指定了其他宠托师')
      await assertNoConflict(transaction, patch.staffOpenid, order, orderId)
      for (const range of getOrderTimeRanges(order)) {
        try { await validateStaffScheduleOnly(profile, range.startTime, range.endTime) }
        catch (error) { if (!options.riskConfirmed) throw error }
      }
      await transaction.collection('users').doc(patch.staffUserId).update({ data: { staffAssignmentRevision: crypto.randomBytes(16).toString('hex') } })
      await transaction.collection('orders').doc(orderId).update({ data: patch })
      return { ...order, ...patch, _id: orderId }
    })
  }

  async function updateOrderStatusWithScheduling(orderId, expectedOrder, patch) {
    const user = expectedOrder.staffOpenid
      ? (await db.collection('users').where({ openid: expectedOrder.staffOpenid }).limit(1).get()).data[0]
      : null
    return db.runTransaction(async transaction => {
      const order = (await transaction.collection('orders').doc(orderId).get()).data
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
      if (order.status === 'assigned' && assignmentChanged && order.staffOpenid) {
        throw new Error('订单已指派，不允许直接修改宠托师归属，请使用受控改派流程')
      }
      if (['assigned', 'in_service', 'day_completed'].includes(updated.status) && !updated.staffOpenid) throw new Error('请先为订单分配宠托师')
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

  async function saveStaffScheduleException(user, payload, remove = false) {
    return db.runTransaction(async tx => {
      await lockStaff(tx, user._id, user.openid)
      const candidates = (await db.collection('staff_schedule_exceptions').where({ staffOpenid: user.openid, dateKey: payload.dateKey }).limit(2).get()).data || []
      if (candidates.length > 1) throw new Error('当日排班重复，请先核对')
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

  return { assignOrderAtomically, updateOrderStatusWithScheduling, saveStaffScheduleException }
}
