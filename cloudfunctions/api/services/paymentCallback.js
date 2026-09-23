module.exports = function createHandler(context) {
  const {
    appendPaymentEvent,
    db,
    decryptWechatPayResource,
    getPayableOrder,
    getSystemSettings,
    getWechatPayConfig,
    mapWechatTradeState,
    markOrderPaid,
    markStaffDepositPaid,
    now,
    safeText,
    sanitizeWechatPayload,
    validatePaymentCallbackPayload,
    verifyWechatPayCallback
  } = context
  async function recordNonSuccess(payment, payload, status) {
    if (payload.trade_state === 'SUCCESS') return
    await db.runTransaction(async tx => {
      const current = (await tx.collection('payments').doc(payment._id).get()).data
      if (!current || ['success', 'paid'].includes(current.status)) return
      await tx.collection('payments').doc(payment._id).update({ data: {
        status, wxTransactionId: payload.transaction_id || current.wxTransactionId || '',
        rawCallback: sanitizeWechatPayload(payload), updatedAt: now()
      } })
    })
  }
  return async function paymentCallback(data) {
      const settings = await getSystemSettings({ includeSecrets: true })
      const config = getWechatPayConfig(settings)
      const headers = data.headers || {}
      const rawBody = data.rawBody || (data.isBase64Encoded ? Buffer.from(data.body || '', 'base64').toString('utf8') : safeText(data.body || JSON.stringify(data.callback || {})))
      try {
        verifyWechatPayCallback(headers, rawBody, config)
        const callbackBody = rawBody ? JSON.parse(rawBody) : (data.callback || {})
        const payload = callbackBody.resource ? decryptWechatPayResource(callbackBody.resource, config.apiV3Key) : (data.callbackPayload || callbackBody)
        const paymentNo = safeText(payload.out_trade_no).trim()
        if (!paymentNo) throw new Error('微信支付回调缺少支付单号')
        const payment = (await db.collection('payments').where({ paymentNo }).limit(1).get()).data[0]
        if (!payment) throw new Error('支付单不存在')
        if (payment.targetType === 'staff_deposit') {
          const depositRes = await db.collection('staff_deposits').doc(payment.depositId || payment.orderId).get().catch(() => ({ data: null }))
          const deposit = depositRes && depositRes.data
          if (!deposit) throw new Error('保证金记录不存在')
          validatePaymentCallbackPayload(payload, { payAmount: deposit.amount }, payment, config)
          const status = mapWechatTradeState(payload.trade_state)
          await recordNonSuccess(payment, payload, status)
          await appendPaymentEvent('callback', { orderId: deposit._id, paymentNo, status, detail: { tradeState: payload.trade_state, wxTransactionId: payload.transaction_id || '', targetType: 'staff_deposit' } })
          if (payload.trade_state === 'SUCCESS') {
            await markStaffDepositPaid(deposit._id, { paymentNo, wxTransactionId: payload.transaction_id || '', channel: 'wechat', rawCallback: sanitizeWechatPayload(payload) })
          }
          return { code: 'SUCCESS', message: '成功' }
        }
        const resolved = await getPayableOrder(payment.orderId)
        const order = resolved.order
        if (!order) throw new Error('订单不存在')
        validatePaymentCallbackPayload(payload, order, payment, config)
        const status = mapWechatTradeState(payload.trade_state)
        await recordNonSuccess(payment, payload, status)
        await appendPaymentEvent('callback', { orderId: order._id || payment.orderId, paymentNo, status, detail: { tradeState: payload.trade_state, wxTransactionId: payload.transaction_id || '' } })
        if (payload.trade_state === 'SUCCESS') await markOrderPaid(order._id || payment.orderId, { paymentNo, wxTransactionId: payload.transaction_id || '', channel: 'wechat', rawCallback: sanitizeWechatPayload(payload) })
        return { code: 'SUCCESS', message: '成功' }
      } catch (error) {
        await appendPaymentEvent('callback_failed', { status: 'failed', detail: { message: error.message } })
        return { code: 'FAIL', message: error.message }
      }
    
  }
}
