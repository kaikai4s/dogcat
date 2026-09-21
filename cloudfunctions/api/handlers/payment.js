module.exports = function createHandler(context) {
  const {
    ORDER_STATUS,
    amountYuanToFen,
    appendOrderTimeline,
    appendPaymentEvent,
    assertOrderTransition,
    assertPaymentModeAllowed,
    buildMiniProgramPayParams,
    createRefundForOrder,
    db,
    ensurePaymentRecord,
    getClientRequestId,
    getPayableOrder,
    getSystemSettings,
    getUser,
    getWechatPayConfig,
    logAdmin,
    markOrderPaid,
    now,
    requireAdmin,
    requireClientPayableOrder,
    safeText,
    sanitizeWechatPayload,
    updateOrderWhenStatus,
    wechatPayRequest
  } = context
  return async function payment(openid, action, data) {
    if (action === 'createPayment') {
      const { order, collectionName, orderType } = await requireClientPayableOrder(openid, data.orderId, '无权支付该订单')
      const settings = await getSystemSettings({ includeSecrets: true })
      if (settings.payment.enabled === false) throw new Error('支付功能暂未开启')
      assertPaymentModeAllowed(settings.payment)
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid', paid: true }
      if (orderType === 'mall') {
        if (order.status !== 'pending_pay' && order.paymentStatus !== 'paying') throw new Error('订单状态不可支付')
      } else {
        assertOrderTransition(order.status, ORDER_STATUS.PAID, '订单状态不可支付')
      }
      if (Number(order.payAmount || 0) <= 0) throw new Error('订单金额不正确')
      if (order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      const clientRequestId = getClientRequestId(data)
      const payment = await ensurePaymentRecord(order, openid, settings.payment.mode, clientRequestId)
      const payingUpdate = { paymentStatus: 'paying', paymentNo: payment.paymentNo, paymentClientRequestId: payment.clientRequestId || clientRequestId, updatedAt: now() }
      if (orderType === 'mall') await db.collection(collectionName).doc(data.orderId).update({ data: payingUpdate })
      else await updateOrderWhenStatus(data.orderId, ORDER_STATUS.PENDING_PAY, payingUpdate, '订单状态不可支付')
      if (settings.payment.mode === 'mock') return { mock: true, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, message: '当前为模拟支付模式' }

      const config = getWechatPayConfig(settings)
      if (payment.prepayId) return { mock: false, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, payParams: buildMiniProgramPayParams(payment.prepayId, config) }
      const requestBody = {
        appid: config.appId,
        mchid: config.mchId,
        description: safeText(order.serviceSummary || order.petName || (orderType === 'mall' ? '宠物用品商城' : '上门宠护服务')).slice(0, 120) || (orderType === 'mall' ? '宠物用品商城' : '上门宠护服务'),
        out_trade_no: payment.paymentNo,
        notify_url: config.notifyUrl,
        amount: { total: amountYuanToFen(order.payAmount), currency: 'CNY' },
        payer: { openid }
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
      const payments = await db.collection('payments').where({ orderId: data.orderId }).get()
      return { orderId: data.orderId, status: order.status, paymentStatus: order.paymentStatus || 'unpaid', paymentNo: order.paymentNo || '', wxTransactionId: order.wxTransactionId || '', paidAt: order.paidAt || '', payments: payments.data || [] }
    }
    if (action === 'paymentCallback') throw new Error('paymentCallback 仅限 HTTP 回调调用')
    if (action === 'mockPayOrder') {
      const { order } = await requireClientPayableOrder(openid, data.orderId, '无权支付该订单')
      const settings = await getSystemSettings()
      assertPaymentModeAllowed(settings.payment)
      if (settings.payment.mode !== 'mock') throw new Error('当前未开启模拟支付')
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid' }
      if (order.status !== 'pending_pay' && order.paymentStatus !== 'paying') throw new Error('订单状态不可支付')
      if (order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      const payment = await ensurePaymentRecord(order, openid, 'mock')
      return markOrderPaid(data.orderId, { paymentNo: data.paymentNo || payment.paymentNo, channel: 'mock', rawCallback: { mock: true } })
    }
    if (action === 'createRefund') {
      const admin = await requireAdmin(openid)
      const resolved = await getPayableOrder(data.orderId)
      const order = resolved.order
      if (!order) throw new Error('订单不存在')
      const amount = Number(data.refundAmount || order.payAmount || 0)
      if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding') throw new Error('订单未支付，不能退款')
      if (amount <= 0 || amount > Number(order.payAmount || 0)) throw new Error('退款金额不正确')
      const refund = await createRefundForOrder(order, amount, data.reason || '管理员退款', 'admin', openid, getClientRequestId(data))
      const refundUpdate = { paymentStatus: 'refunding', refundStatus: resolved.orderType === 'mall' ? 'approved' : 'processing', refundAmount: amount, refundNo: refund.refundNo, updatedAt: now() }
      await db.collection(resolved.collectionName).doc(data.orderId).update({ data: refundUpdate })
      await logAdmin(admin, resolved.orderType === 'mall' ? 'mall_order' : 'order', data.orderId, 'createRefund', { refundNo: refund.refundNo, refundAmount: amount })
      if (resolved.orderType !== 'mall') await appendOrderTimeline(data.orderId, 'refund_processing', '退款处理中', `退款金额 ¥${amount}`, 'admin')
      return refund
    }
    if (action === 'queryRefund') {
      const user = await getUser(openid)
      const res = await db.collection('refunds').where({ refundNo: data.refundNo }).limit(1).get()
      const refund = res.data[0]
      if (!refund) throw new Error('退款单不存在')
      const resolved = await getPayableOrder(refund.orderId)
      const order = resolved.order
      if (!order || (order.clientOpenid !== openid && !user.roles.includes('admin'))) throw new Error('无权查看退款')
      return refund
    }
    if (action === 'listRefunds') {
      await requireAdmin(openid)
      const where = data.orderId ? { orderId: data.orderId } : {}
      const res = await db.collection('refunds').where(where).orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    throw new Error('未知 payment 操作')
  }
}
