module.exports = function createService({
  ORDER_STATUS,
  authorizeAdmin,
  db,
  expireUnacceptedOrder,
  getSystemSettings,
  getUser,
  isAdminDeletedOrder,
  isOpenOrder,
  normalizeStaffWorkflow,
  now,
  toPublicSitter,
  validateStaffTakeOrderAbility,
  withSitterUserProfile
}) {
  async function getOrderForAccess(openid, orderId) {
    const user = await getUser(openid)
    if (user.roles.includes('admin')) await authorizeAdmin(user, 'admin.getOrderDetail')
    const res = await db.collection('orders').doc(orderId).get()
    let order = res.data ? { ...res.data, _id: orderId } : null
    if (!order || (isAdminDeletedOrder(order) && !user.roles.includes('admin'))) throw new Error('订单不存在')
    order = await expireUnacceptedOrder(orderId, order)
    const isPreviousStaff = user.roles.includes('staff') && ((Array.isArray(order.previousStaffRecords) && order.previousStaffRecords.some((r) => r.staffOpenid === openid)) || order.originalStaffOpenid === openid)
    const canPreviewForStaff = user.roles.includes('staff') && order.status === ORDER_STATUS.PAID && (isOpenOrder(order) || order.requestedStaffOpenid === openid)
    const allowed = order.clientOpenid === openid || order.staffOpenid === openid || order.requestedStaffOpenid === openid || user.roles.includes('admin') || canPreviewForStaff || isPreviousStaff
    if (!allowed) throw new Error('无权访问订单')
    return { user, order }
  }

  async function requireClientOrder(openid, orderId, message = '无权操作该订单') {
    const { user, order } = await getOrderForAccess(openid, orderId)
    if (order.clientOpenid !== openid) throw new Error(message)
    return { user, order }
  }

  async function requireStaffOrder(openid, orderId, message = '仅订单员工可操作') {
    const { user, order } = await getOrderForAccess(openid, orderId)
    if (!user.roles.includes('staff') || order.staffOpenid !== openid) throw new Error(message)
    return { user, order }
  }

  async function requireServiceReportAccess(openid, orderId) {
    const { user, order } = await getOrderForAccess(openid, orderId)
    const allowed = order.clientOpenid === openid || user.roles.includes('admin') || (user.roles.includes('staff') && order.staffOpenid === openid)
    if (!allowed) throw new Error('无权查看服务报告')
    return { user, order }
  }

  async function getRequestedStaff(data) {
    const publishMode = data.publishMode === 'direct' ? 'direct' : 'open'
    if (publishMode === 'open') {
      return {
        publishMode,
        requestedStaffProfileId: '',
        requestedStaffUserId: '',
        requestedStaffOpenid: '',
        requestedStaffName: '',
        requestedStaffSnapshot: null
      }
    }
    const staffProfileId = data.staffProfileId || data.requestedStaffProfileId
    if (!staffProfileId) throw new Error('请选择指定宠托师')
    const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
    const profile = normalizeStaffWorkflow(profileRes.data)
    const settings = await getSystemSettings()
    const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
    if (!ability.can) {
      if (ability.reason === 'deposit_unpaid') {
        throw new Error('指定宠托师尚未缴纳履约保证金，暂不可指定接单')
      }
      throw new Error('指定宠托师未审核通过')
    }
    const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
    const staffUser = userRes.data[0]
    if (!staffUser) throw new Error('指定宠托师账号不存在')
    const publicSitter = toPublicSitter(await withSitterUserProfile(profile))
    return {
      publishMode,
      requestedStaffProfileId: profile._id,
      requestedStaffUserId: staffUser._id,
      requestedStaffOpenid: profile.openid,
      requestedStaffName: publicSitter.displayName,
      requestedStaffSnapshot: {
        profileId: profile._id,
        displayName: publicSitter.displayName,
        serviceCity: publicSitter.serviceCity,
        serviceAreas: publicSitter.serviceAreas
      }
    }
  }

  function getCancelQuoteForOrder(order) {
    if (order.status === 'pending_pay') return { canCancel: true, refundAmount: 0, refundStatus: 'not_required', ruleText: '待支付订单可直接取消' }
    if (order.status === 'paid') return { canCancel: true, refundAmount: Number(order.payAmount || 0), refundStatus: 'processing', ruleText: '已支付未接单订单可全额退款' }
    if (order.status === 'expired') return { canCancel: true, refundAmount: Number(order.payAmount || 0), refundStatus: 'processing', ruleText: '过期未接单订单可全额退款' }
    if (order.status === 'assigned') {
      const start = new Date(String(order.startTime || '').replace(/-/g, '/')).getTime()
      const hoursBeforeStart = start ? (start - now().getTime()) / 36e5 : 0

      // 【新增】指定订单免责取消机制
      // 如果是指定订单（direct模式），检查是否在免责取消时间窗口内（接单后2小时）
      const isDirectOrder = order.publishMode === 'direct' || order.assignmentSource === 'direct_accept'
      if (isDirectOrder && order.assignedAt) {
        const hoursAfterAccept = (now().getTime() - new Date(order.assignedAt).getTime()) / 36e5
        const freeGracePeriodHours = 2 // 免责取消时间窗口：2小时

        if (hoursAfterAccept <= freeGracePeriodHours) {
          // 在免责时间窗口内，指定订单可免费取消
          return {
            canCancel: true,
            refundAmount: Number(order.payAmount || 0),
            refundStatus: 'processing',
            ruleText: `指定订单接单后${freeGracePeriodHours}小时内可免责取消并全额退款`,
            isFreeGracePeriod: true
          }
        }
      }

      // 普通取消规则
      const rate = hoursBeforeStart >= 24 ? 1 : 0.8
      return {
        canCancel: true,
        refundAmount: Math.round(Number(order.payAmount || 0) * rate),
        refundStatus: 'processing',
        ruleText: hoursBeforeStart >= 24 ? '距服务开始超过24小时，可全额退款' : '距服务开始不足24小时，可退80%',
        needsNegotiation: isDirectOrder && hoursBeforeStart < 24 // 指定订单超时取消需要协商
      }
    }
    return { canCancel: false, refundAmount: 0, refundStatus: 'pending_manual', ruleText: '服务中或已完成订单需申请平台介入' }
  }

  return {
    getOrderForAccess,
    requireClientOrder,
    requireStaffOrder,
    requireServiceReportAccess,
    getRequestedStaff,
    getCancelQuoteForOrder
  }
}
