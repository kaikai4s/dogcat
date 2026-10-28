const { assertModuleAvailable } = require('../services/moduleMaintenance')

module.exports = function createHandler(context) {
  const {
    authorizeAdmin,
    ORDER_STATUS,
    amountYuanToFen,
    appendOrderTimeline,
    appendPaymentEvent,
    assertOrderTransition,
    assertPaymentModeAllowed,
    assertOrderPaymentOpen,
    buildMiniProgramPayParams,
    checkTextSecurity,
    createRefundForOrder,
    db,
    ensurePaymentRecord,
    getClientRequestId,
    getPayableOrder,
    getOrderPaymentDeadline,
    getSystemSettings,
    getUser,
    getWechatPayConfig,
    logAdmin,
    markOrderPaid,
    now,
    requireAdmin,
    requireClientPayableOrder,
    readScopedDocuments,
    safeText,
    sanitizeWechatPayload,
    syncOrderRefund,
    updateOrderWhenStatus,
    validatePaymentCallbackPayload,
    wechatPayRequest,
    syncWechatPaidOrder: contextSyncWechatPaidOrder
  } = context
  function publicPaymentStatus(payment = {}) {
    return {
      paymentNo: payment.paymentNo || '',
      amount: Number(payment.amount || 0),
      status: payment.status || 'pending',
      channel: payment.channel || '',
      createdAt: payment.createdAt || '',
      updatedAt: payment.updatedAt || '',
      paidAt: payment.paidAt || ''
    }
  }

  async function syncWechatPaidOrder(order, payments) {
    if (typeof contextSyncWechatPaidOrder === 'function') return contextSyncWechatPaidOrder(order, payments)
    if (!order || order.paymentStatus === 'paid') return order
    const paymentNo = order.paymentNo || (payments.find(item => item.channel === 'wechat' && item.paymentNo) || {}).paymentNo
    if (!paymentNo) return order
    const payment = payments.find(item => item.paymentNo === paymentNo) || { paymentNo, orderId: order._id, channel: 'wechat' }
    if (payment.channel === 'mock' || ['success', 'paid'].includes(payment.status)) return order
    const settings = await getSystemSettings({ includeSecrets: true })
    const config = getWechatPayConfig(settings)
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(paymentNo)}?mchid=${encodeURIComponent(config.mchId)}`
    let response
    try {
      response = await wechatPayRequest('GET', path, null, config)
    } catch (error) {
      await appendPaymentEvent('query_failed', { orderId: order._id, paymentNo, status: 'failed', detail: { message: error.message, code: error.code || '' } })
      return order
    }
    await appendPaymentEvent('query', { orderId: order._id, paymentNo, status: response.trade_state || 'UNKNOWN', detail: sanitizeWechatPayload(response) })
    if (response.trade_state !== 'SUCCESS') return order
    validatePaymentCallbackPayload(response, order, payment, config)
    await markOrderPaid(order._id, {
      paymentNo,
      wxTransactionId: response.transaction_id || '',
      channel: 'wechat',
      rawCallback: sanitizeWechatPayload(response)
    })
    const fresh = await getPayableOrder(order._id)
    return fresh.order || order
  }

  return async function payment(openid, action, data) {
    if (action === 'createPayment') {
      const { order, collectionName, orderType } = await requireClientPayableOrder(openid, data.orderId, '无权支付该订单')
      const settings = await getSystemSettings({ includeSecrets: true })
      if (orderType !== 'mall' && order.paymentStatus !== 'paid') await assertModuleAvailable(async () => settings, 'booking')
      if (settings.payment.enabled === false) throw new Error('支付功能暂未开启')
      assertPaymentModeAllowed(settings.payment)
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid', paid: true }
      assertOrderPaymentOpen(order)
      if (orderType === 'mall') {
        if (order.status !== 'pending_pay' || order.paymentStatus === 'closed') throw new Error('订单状态不可支付')
      } else {
        assertOrderTransition(order.status, ORDER_STATUS.PAID, '订单状态不可支付')
      }
      if (Number(order.payAmount || 0) <= 0) throw new Error('订单金额不正确')
      if (order.couponId) {
        const couponRes = await db.collection('user_coupons').doc(order.couponId).get().catch(() => ({ data: null }))
        const coupon = couponRes && couponRes.data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      const clientRequestId = getClientRequestId(data)
      const payment = await ensurePaymentRecord(order, openid, settings.payment.mode, clientRequestId)
      if (settings.payment.mode === 'mock') return { mock: true, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, message: '当前为模拟支付模式' }

      const config = getWechatPayConfig(settings)
      const PREPAY_TTL_MS = 90 * 60 * 1000
      const isPrepayExpired = payment.updatedAt && (Date.now() - new Date(payment.updatedAt).getTime() > PREPAY_TTL_MS)
      if (payment.prepayId && !isPrepayExpired) return { mock: false, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, payParams: buildMiniProgramPayParams(payment.prepayId, config) }
      const requestBody = {
        appid: config.appId,
        mchid: config.mchId,
        description: safeText(order.serviceSummary || order.petName || (orderType === 'mall' ? '宠物用品商城' : '上门宠护服务')).slice(0, 120) || (orderType === 'mall' ? '宠物用品商城' : '上门宠护服务'),
        out_trade_no: payment.paymentNo,
        notify_url: config.notifyUrl,
        amount: { total: amountYuanToFen(order.payAmount), currency: 'CNY' },
        payer: { openid }
      }
      if (getOrderPaymentDeadline(order)) {
        requestBody.time_expire = new Date(getOrderPaymentDeadline(order)).toISOString().replace(/\.\d{3}Z$/, '+00:00')
      }
      try {
        const response = await wechatPayRequest('POST', '/v3/pay/transactions/jsapi', requestBody, config)
        if (!response.prepay_id) throw new Error('微信支付未返回 prepay_id')
        await db.collection('payments').doc(payment._id).update({ data: { channel: 'wechat', prepayId: response.prepay_id, rawRequest: sanitizeWechatPayload(requestBody), rawResponse: sanitizeWechatPayload(response), updatedAt: now() } })
        await appendPaymentEvent('prepay_created', { orderId: data.orderId, paymentNo: payment.paymentNo, status: 'pending', detail: { channel: 'wechat', amount: payment.amount } })
        return { mock: false, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, payParams: buildMiniProgramPayParams(response.prepay_id, config) }
      } catch (error) {
        await appendPaymentEvent('prepay_failed', { orderId: data.orderId, paymentNo: payment.paymentNo, status: 'failed', detail: { message: error.message } })
        throw new Error(`微信支付下单失败：${error.message}`)
      }
    }
    if (action === 'getPaymentStatus') {
      const { order } = await requireClientPayableOrder(openid, data.orderId, '无权查看支付状态')
      let payments = await readScopedDocuments('payments', { orderId: data.orderId }, 'createdAt', 'desc')
      let currentOrder = order
      if (currentOrder.paymentStatus !== 'paid' && payments.some(item => item.channel === 'wechat' && item.paymentNo)) {
        currentOrder = await syncWechatPaidOrder(currentOrder, payments)
        payments = await readScopedDocuments('payments', { orderId: data.orderId }, 'createdAt', 'desc')
      }
      return { orderId: data.orderId, status: currentOrder.status, paymentStatus: currentOrder.paymentStatus || 'unpaid', paymentNo: currentOrder.paymentNo || '', paidAt: currentOrder.paidAt || '', payments: payments.map(publicPaymentStatus) }
    }
    if (action === 'paymentCallback') throw new Error('paymentCallback 仅限 HTTP 回调调用')
    if (action === 'mockPayOrder') {
      const { order, orderType } = await requireClientPayableOrder(openid, data.orderId, '无权支付该订单')
      const settings = await getSystemSettings()
      if (orderType !== 'mall' && order.paymentStatus !== 'paid') await assertModuleAvailable(async () => settings, 'booking')
      assertPaymentModeAllowed(settings.payment)
      if (settings.payment.mode !== 'mock') throw new Error('当前未开启模拟支付')
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid' }
      assertOrderPaymentOpen(order)
      if (order.status !== 'pending_pay' || order.paymentStatus === 'closed') throw new Error('订单状态不可支付')
      if (order.couponId) {
        const couponRes = await db.collection('user_coupons').doc(order.couponId).get().catch(() => ({ data: null }))
        const coupon = couponRes && couponRes.data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      const payment = await ensurePaymentRecord(order, openid, 'mock')
      return markOrderPaid(data.orderId, { paymentNo: payment.paymentNo, channel: 'mock', rawCallback: { mock: true } })
    }
    if (action === 'createRefund') {
      const admin = await requireAdmin(openid)
      const resolved = await getPayableOrder(data.orderId)
      const order = resolved.order
      if (!order) throw new Error('订单不存在')
      const amount = Number(data.refundAmount || order.payAmount || 0)
      if (amount <= 0 || amount > Number(order.payAmount || 0)) throw new Error('退款金额不正确')
      const reason = safeText(data.reason || '管理员退款').trim()
      if (reason.length > 200) throw new Error('退款原因不能超过 200 字')
      if (reason && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '退款原因' })
      }
      const refund = await createRefundForOrder(order, amount, reason, 'admin', openid, getClientRequestId(data))
      await logAdmin(admin, resolved.orderType === 'mall' ? 'mall_order' : 'order', data.orderId, 'createRefund', { refundNo: refund.refundNo, refundAmount: amount })
      if (resolved.orderType !== 'mall') await appendOrderTimeline(data.orderId, 'refund_processing', '退款处理中', `退款金额 ¥${amount}`, 'admin')
      return refund
    }
    if (action === 'queryRefund') {
      const user = await getUser(openid)
      if (user.roles.includes('admin')) await authorizeAdmin(user)
      const res = await db.collection('refunds').where({ refundNo: data.refundNo }).limit(1).get()
      const refund = res.data[0]
      if (!refund) throw new Error('退款单不存在')
      const resolved = await getPayableOrder(refund.orderId)
      const order = resolved.order
      if (!order || (order.clientOpenid !== openid && !user.roles.includes('admin'))) throw new Error('无权查看退款')
      return syncOrderRefund(refund)
    }
    if (action === 'listRefunds') {
      await requireAdmin(openid)
      const where = data.orderId ? { orderId: data.orderId } : {}
      return readScopedDocuments('refunds', where, 'createdAt', 'desc')
    }
    throw new Error('未知 payment 操作')
  }
}
