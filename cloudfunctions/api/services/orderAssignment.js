module.exports = function createService({
  crypto, db, findStaffOrderConflict, getOrderTimeRanges, isOrderConflictCandidate,
  now, toTimeValue, validateStaffTakeOrderAbility
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

  return { assignOrderAtomically, updateOrderStatusWithScheduling }
}
