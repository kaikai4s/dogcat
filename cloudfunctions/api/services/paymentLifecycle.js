module.exports = function createService({
  db, getStaffProfileByOpenid, recordStaffDepositPayment, reserveOrderPayment, settleOrderPayment, requestOrderRefund,
  appendOrderClientMessage, createPaymentNo, notifyOrder,
  getSystemSettings, getWechatPayConfig, wechatPayRequest, appendPaymentEvent,
  sanitizeWechatPayload, validatePaymentCallbackPayload, getPayableOrder, readScopedDocuments
}) {
  function buildMallOrderItemSnapshot(product, sku, quantity) {
    return { productId: product._id, skuId: sku.skuId, name: product.name, coverFileId: sku.imageFileId || product.coverFileId || '', price: Number(sku.price || 0), quantity, specText: sku.specText || '', specs: sku.specs || {}, shippingFee: Number(product.shippingFee || 0), skuSnapshot: { skuId: sku.skuId, specs: sku.specs || {}, specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), imageFileId: sku.imageFileId || '' } }
  }

  async function ensurePaymentRecord(order, openid, channel = 'mock', clientRequestId = '') {
    return reserveOrderPayment(order, openid, channel, clientRequestId)
  }

  async function markMallOrderPaid(orderId, order, paymentPayload = {}) {
    return markOrderPaid(orderId, paymentPayload)
  }

  async function markOrderPaid(orderId, paymentPayload = {}) {
    const result = await settleOrderPayment(orderId, paymentPayload)
    const order = result.order
    if (result.changed && result.orderType === 'service') {
      // Notifications cannot turn a committed payment into a failed callback.
      try {
        await appendOrderClientMessage(order, { eventType: 'paid', title: '订单已支付', detail: `支付金额 ¥${order.payAmount}`, actorRole: 'system', unreadForClient: true })
        await notifyOrder(order.clientOpenid, 'orderPaid', order, { amount: Number(order.payAmount), statusText: '已支付' })
      } catch (error) { console.error('[paid-notification]', { orderId, message: error.message }) }
    }
    return { orderId, status: 'paid', paymentNo: order.paymentNo }
  }

  async function markStaffDepositPaid(depositId, paymentPayload = {}) {
    return recordStaffDepositPayment(depositId, { ...paymentPayload, paymentNo: paymentPayload.paymentNo || createPaymentNo() })
  }

  async function createRefundForOrder(order, refundAmount, reason, source, operatorOpenid, clientRequestId = '', options = {}) {
    return requestOrderRefund(order, refundAmount, reason, source, operatorOpenid, clientRequestId, options)
  }

  // Query only the current unpaid deposit: historical refunded/forfeited payments
  // must never satisfy a new repayment requirement.
  async function syncWechatStaffDeposit(profile) {
    if (!profile) return { profile, deposit: null }
    async function readCurrentDeposit(currentProfile) {
      if (!currentProfile) return null
      if (currentProfile.currentDepositId) {
        const current = (await db.collection('staff_deposits').doc(currentProfile.currentDepositId).get()).data
        if (!current || current.staffOpenid !== currentProfile.openid) throw new Error('当前保证金记录归属不匹配，请联系平台核对')
        return current
      }
      return (await db.collection('staff_deposits').where({ staffOpenid: currentProfile.openid }).orderBy('createdAt', 'desc').limit(1).get()).data[0] || null
    }
    async function freshSnapshot() {
      const freshProfile = await getStaffProfileByOpenid(profile.openid)
      return { profile: freshProfile, deposit: await readCurrentDeposit(freshProfile) }
    }
    const deposit = await readCurrentDeposit(profile)
    if (!deposit || deposit.status !== 'unpaid') return { profile, deposit }
    const payments = (await db.collection('payments').where({ orderId: deposit._id, targetType: 'staff_deposit' }).limit(2).get()).data
    if (payments.length > 1) throw new Error('保证金支付记录重复，请联系平台对账')
    const payment = payments[0]
    if (!payment || payment.channel !== 'wechat') return { profile, deposit }
    if (payment.openid !== profile.openid || Number(payment.amount) !== Number(deposit.amount)) throw new Error('保证金支付记录不匹配')
    let response, config
    try {
      config = getWechatPayConfig(await getSystemSettings({ includeSecrets: true }))
      response = await wechatPayRequest('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(payment.paymentNo)}?mchid=${encodeURIComponent(config.mchId)}`, null, config)
    } catch (error) {
      console.error('[deposit-payment-query]', { depositId: deposit._id, message: error.message })
      const fresh = await freshSnapshot()
      return { ...fresh, paymentSyncPending: fresh.deposit?.status === 'unpaid' }
    }
    if (response.trade_state !== 'SUCCESS') return freshSnapshot()
    validatePaymentCallbackPayload(response, { payAmount: deposit.amount }, payment, config)
    await markStaffDepositPaid(deposit._id, { paymentNo: payment.paymentNo, wxTransactionId: response.transaction_id, channel: 'wechat', rawCallback: sanitizeWechatPayload(response) })
    const fresh = await freshSnapshot()
    return { ...fresh, reconciled: fresh.deposit?._id === deposit._id && fresh.deposit.status === 'paid' }
  }

  async function syncWechatPaidOrder(order, payments) {
    if (!order || order.paymentStatus === 'paid') return order
    if (!payments && typeof readScopedDocuments === 'function') {
      payments = await readScopedDocuments('payments', { orderId: order._id }, 'createdAt', 'desc')
    }
    const paymentRecords = Array.isArray(payments) ? payments : []
    const paymentNo = order.paymentNo || (paymentRecords.find(item => item.channel === 'wechat' && item.paymentNo) || {}).paymentNo
    if (!paymentNo) return order
    const payment = paymentRecords.find(item => item.paymentNo === paymentNo) || { paymentNo, orderId: order._id, channel: 'wechat' }
    if (payment.channel === 'mock') {
      if (['success', 'paid'].includes(payment.status) && order.paymentStatus !== 'paid') {
        await markOrderPaid(order._id, { paymentNo: payment.paymentNo, channel: 'mock' })
        const fresh = typeof getPayableOrder === 'function' ? await getPayableOrder(order._id) : null
        return (fresh && fresh.order) || order
      }
      return order
    }
    if (['success', 'paid'].includes(payment.status) && order.paymentStatus !== 'paid') {
      await markOrderPaid(order._id, {
        paymentNo: payment.paymentNo,
        wxTransactionId: payment.wxTransactionId || '',
        channel: payment.channel || 'wechat',
        rawCallback: payment.rawCallback || {}
      })
      const fresh = typeof getPayableOrder === 'function' ? await getPayableOrder(order._id) : null
      return (fresh && fresh.order) || order
    }
    if (payment.status && ['success', 'paid'].includes(payment.status)) return order
    if (typeof getSystemSettings !== 'function' || typeof getWechatPayConfig !== 'function' || typeof wechatPayRequest !== 'function') return order
    const settings = await getSystemSettings({ includeSecrets: true })
    const config = getWechatPayConfig(settings)
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(paymentNo)}?mchid=${encodeURIComponent(config.mchId)}`
    let response
    try {
      response = await wechatPayRequest('GET', path, null, config)
    } catch (error) {
      if (typeof appendPaymentEvent === 'function') {
        await appendPaymentEvent('query_failed', { orderId: order._id, paymentNo, status: 'failed', detail: { message: error.message, code: error.code || '' } })
      }
      return order
    }
    if (typeof appendPaymentEvent === 'function') {
      await appendPaymentEvent('query', { orderId: order._id, paymentNo, status: response.trade_state || 'UNKNOWN', detail: typeof sanitizeWechatPayload === 'function' ? sanitizeWechatPayload(response) : response })
    }
    if (response.trade_state !== 'SUCCESS') return order
    if (typeof validatePaymentCallbackPayload === 'function') {
      validatePaymentCallbackPayload(response, order, payment, config)
    }
    await markOrderPaid(order._id, {
      paymentNo,
      wxTransactionId: response.transaction_id || '',
      channel: 'wechat',
      rawCallback: typeof sanitizeWechatPayload === 'function' ? sanitizeWechatPayload(response) : response
    })
    const fresh = typeof getPayableOrder === 'function' ? await getPayableOrder(order._id) : null
    return (fresh && fresh.order) || order
  }

  return {
    buildMallOrderItemSnapshot,
    markMallOrderPaid,
    ensurePaymentRecord,
    markOrderPaid,
    markStaffDepositPaid,
    createRefundForOrder,
    syncWechatPaidOrder,
    syncWechatStaffDeposit
  }
}
