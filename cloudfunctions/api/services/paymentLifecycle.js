module.exports = function createService({
  ORDER_STATUS,
  amountYuanToFen,
  appendFinanceLog,
  appendOrderClientMessage,
  appendOrderTimeline,
  appendPaymentEvent,
  assertOrderTransition,
  assertPaymentModeAllowed,
  createPaymentNo,
  createRefundNo,
  db,
  findByClientRequestId,
  getDocOrNull,
  getPayableOrder,
  getSkuById,
  getSystemSettings,
  getWechatPayConfig,
  makeIdempotencyKey,
  mapWechatRefundStatus,
  normalizeMallProduct,
  notifyOrder,
  notifyOrderAccepted,
  now,
  safeText,
  sanitizeWechatPayload,
  updateOrderWhenStatus,
  wechatPayRequest
}) {
  function buildMallOrderItemSnapshot(product, sku, quantity) {
    return { productId: product._id, skuId: sku.skuId, name: product.name, coverFileId: sku.imageFileId || product.coverFileId || '', price: Number(sku.price || 0), quantity, specText: sku.specText || '', specs: sku.specs || {}, skuSnapshot: { skuId: sku.skuId, specs: sku.specs || {}, specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), imageFileId: sku.imageFileId || '' } }
  }

  async function deductMallProductStock(item, time) {
    const quantity = Number(item.quantity || 0)
    const product = await getDocOrNull('mall_products', item.productId)
    if (!product || product.status !== 'on_sale') throw new Error(`商品已下架：${item.name}`)
    const normalized = normalizeMallProduct(product)
    const selected = getSkuById(normalized, item.skuId)
    const skus = normalized.skus.map((sku) => ({ ...sku, specs: { ...(sku.specs || {}) } }))
    const index = selected ? skus.findIndex((sku) => sku.skuId === selected.skuId) : -1
    const sku = skus[index]
    if (!sku || sku.status === 'off_sale') throw new Error(`商品已下架：${item.name}`)
    if (Number(sku.stock || 0) < quantity) throw new Error(`商品库存不足：${item.name}`)
    skus[index] = { ...sku, stock: Number(sku.stock || 0) - quantity, salesCount: Number(sku.salesCount || 0) + quantity }
    const singleFields = normalized.specMode === 'single' ? { stock: skus[index].stock, salesCount: skus[index].salesCount } : {}
    const nextProduct = normalizeMallProduct({ ...normalized, ...singleFields, skus, updatedAt: time })
    await db.collection('mall_products').doc(item.productId).update({ data: { skus: nextProduct.skus, price: nextProduct.price, originalPrice: nextProduct.originalPrice, stock: nextProduct.stock, totalStock: nextProduct.totalStock, minPrice: nextProduct.minPrice, maxPrice: nextProduct.maxPrice, salesCount: nextProduct.salesCount, specText: nextProduct.specText, updatedAt: time } })
  }

  async function markMallOrderPaid(orderId, order, paymentPayload = {}) {
    if (order.paymentStatus === 'paid') return { orderId, status: 'paid' }
    if (order.status !== 'pending_pay' && order.paymentStatus !== 'paying') throw new Error('订单状态不可支付')
    const time = now()
    for (const item of (order.items || [])) {
      const product = await getDocOrNull('mall_products', item.productId)
      if (!product || product.status !== 'on_sale') throw new Error(`商品已下架：${item.name}`)
      const sku = getSkuById(product, item.skuId)
      if (!sku || sku.status === 'off_sale') throw new Error(`商品已下架：${item.name}`)
      if (Number(sku.stock || 0) < Number(item.quantity || 0)) throw new Error(`商品库存不足：${item.name}`)
    }
    for (const item of (order.items || [])) await deductMallProductStock(item, time)
    const paymentNo = paymentPayload.paymentNo || createPaymentNo()
    const update = { paymentStatus: 'paid', status: 'pending_ship', paymentNo, wxTransactionId: paymentPayload.wxTransactionId || '', paidAt: time, updatedAt: time }
    await db.collection('mall_orders').doc(orderId).update({ data: update })
    if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'used', usedOrderId: orderId, usedAt: time, updatedAt: time } })
    const existing = await db.collection('payments').where({ orderId, paymentNo }).limit(1).get()
    if (existing.data[0]) await db.collection('payments').doc(existing.data[0]._id).update({ data: { status: 'success', channel: paymentPayload.channel || existing.data[0].channel || 'mock', wxTransactionId: update.wxTransactionId, rawCallback: paymentPayload.rawCallback || {}, paidAt: time, updatedAt: time } })
    else await db.collection('payments').add({ data: { orderId, orderNo: order.orderNo || '', openid: order.clientOpenid || '', paymentNo, prepayId: paymentPayload.prepayId || '', wxTransactionId: update.wxTransactionId, amount: Number(order.payAmount || 0), currency: 'CNY', status: 'success', channel: paymentPayload.channel || 'mock', idempotencyKey: makeIdempotencyKey('payment', orderId, paymentNo), rawCallback: paymentPayload.rawCallback || {}, paidAt: time, createdAt: time, updatedAt: time } })
    await appendPaymentEvent('paid', { orderId, paymentNo, status: 'success', detail: { amount: Number(order.payAmount || 0), channel: paymentPayload.channel || 'mock', orderType: 'mall' }, raw: paymentPayload.rawCallback || {} })
    await appendFinanceLog('mall_order_paid', { targetType: 'mall_order', targetId: orderId, orderId, amountDelta: Number(order.payAmount || 0), detail: { paymentNo } })
    return { orderId, status: 'paid', paymentNo }
  }

  async function ensurePaymentRecord(order, openid, channel = 'mock', clientRequestId = '') {
    if (clientRequestId) {
      const existingByRequest = await findByClientRequestId('payments', { orderId: order._id, openid, clientRequestId })
      if (existingByRequest) return existingByRequest
    }
    const existing = await db.collection('payments').where({ orderId: order._id, status: 'pending' }).limit(1).get()
    if (existing.data[0]) return existing.data[0]
    const time = now()
    const paymentNo = createPaymentNo()
    const payment = {
      orderId: order._id,
      orderNo: order.orderNo || '',
      openid,
      paymentNo,
      prepayId: '',
      wxTransactionId: '',
      amount: Number(order.payAmount || 0),
      currency: 'CNY',
      status: 'pending',
      channel,
      clientRequestId,
      idempotencyKey: clientRequestId || makeIdempotencyKey('payment', order._id, paymentNo),
      rawRequest: {},
      rawCallback: {},
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('payments').add({ data: payment })
    await appendPaymentEvent('create', { orderId: order._id, paymentNo, status: 'pending', detail: { channel, amount: payment.amount } })
    return { _id: created._id, ...payment }
  }

  async function markOrderPaid(orderId, paymentPayload = {}) {
    const resolved = await getPayableOrder(orderId)
    const order = resolved.order
    if (!order) throw new Error('订单不存在')
    if (resolved.orderType === 'mall') return markMallOrderPaid(orderId, order, paymentPayload)
    if (order.paymentStatus === 'paid') return { orderId, status: 'paid' }
    assertOrderTransition(order.status, ORDER_STATUS.PAID, '订单状态不可支付')
    const time = now()
    const paymentNo = paymentPayload.paymentNo || createPaymentNo()
    const paymentUpdate = {
      paymentStatus: 'paid',
      status: 'paid',
      paymentNo,
      wxTransactionId: paymentPayload.wxTransactionId || '',
      paidAt: time,
      updatedAt: time
    }
    const existing = await db.collection('payments').where({ orderId, paymentNo }).limit(1).get()
    if (existing.data[0]) {
      await db.collection('payments').doc(existing.data[0]._id).update({
        data: {
          status: 'success',
          channel: paymentPayload.channel || existing.data[0].channel || 'mock',
          wxTransactionId: paymentUpdate.wxTransactionId,
          rawCallback: paymentPayload.rawCallback || {},
          paidAt: time,
          updatedAt: time
        }
      })
    } else {
      await db.collection('payments').add({
        data: {
          orderId,
          orderNo: order.orderNo || '',
          openid: order.clientOpenid || '',
          paymentNo,
          prepayId: paymentPayload.prepayId || '',
          wxTransactionId: paymentUpdate.wxTransactionId,
          amount: Number(order.payAmount || 0),
          currency: 'CNY',
          status: 'success',
          channel: paymentPayload.channel || 'mock',
          idempotencyKey: makeIdempotencyKey('payment', orderId, paymentNo),
          rawCallback: paymentPayload.rawCallback || {},
          paidAt: time,
          createdAt: time,
          updatedAt: time
        }
      })
    }
    await updateOrderWhenStatus(orderId, order.status, paymentUpdate, '订单状态不可支付')
    if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'used', usedOrderId: orderId, usedAt: time, updatedAt: time } })
    await appendPaymentEvent('paid', { orderId, paymentNo, status: 'success', detail: { amount: Number(order.payAmount || 0), channel: paymentPayload.channel || 'mock' }, raw: paymentPayload.rawCallback || {} })
    await appendFinanceLog('order_paid', { targetType: 'order', targetId: orderId, orderId, amountDelta: Number(order.payAmount || 0), detail: { paymentNo } })
    const paidOrder = { ...order, _id: orderId, ...paymentUpdate }
    await appendOrderTimeline(orderId, 'paid', '订单已支付', `支付金额 ¥${order.payAmount}`, 'client')
    await appendOrderClientMessage(paidOrder, { eventType: 'paid', title: '订单已支付', detail: `支付金额 ¥${order.payAmount}`, actorRole: 'system', unreadForClient: true })
    await notifyOrder(order.clientOpenid, 'orderPaid', { ...order, _id: orderId }, { amount: Number(order.payAmount || 0), statusText: '已支付' })
    if (paidOrder.publishMode === 'direct' && paidOrder.requestedStaffOpenid) {
      const notifyResult = await notifyOrderAccepted(paidOrder, paidOrder.requestedStaffName)
      await db.collection('orders').doc(orderId).update({ data: { acceptedNotifyStatus: notifyResult && notifyResult.status || 'skipped', acceptedNotifyError: notifyResult && notifyResult.error || '', updatedAt: time } })
    }
    return { orderId, status: 'paid', paymentNo }
  }

  async function markStaffDepositPaid(depositId, paymentPayload = {}) {
    const deposit = (await db.collection('staff_deposits').doc(depositId).get()).data
    if (!deposit) throw new Error('保证金记录不存在')
    if (deposit.status === 'paid') return { depositId, status: 'paid' }
    const time = now()
    const paymentNo = paymentPayload.paymentNo || createPaymentNo()
    const amount = Number(deposit.amount || 0)
    await db.collection('staff_deposits').doc(depositId).update({
      data: {
        paidAmount: amount,
        availableRefundAmount: amount,
        status: 'paid',
        statusText: '已缴纳',
        paymentNo,
        wxTransactionId: paymentPayload.wxTransactionId || '',
        paidAt: time,
        updatedAt: time
      }
    })
    const profileRes = await db.collection('staff_profiles').where({ openid: deposit.staffOpenid }).limit(1).get()
    if (profileRes.data && profileRes.data[0]) {
      await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
        data: {
          depositStatus: 'paid',
          depositRequired: true,
          updatedAt: time
        }
      })
    }
    await db.collection('staff_deposit_events').add({
      data: {
        depositId,
        staffOpenid: deposit.staffOpenid,
        staffUserId: deposit.staffUserId,
        type: 'pay',
        amount,
        reason: '缴纳宠托师入驻保证金',
        operatorOpenid: deposit.staffOpenid,
        operatorRole: 'staff',
        createdAt: time
      }
    })
    await appendFinanceLog('deposit_paid', {
      targetType: 'staff_deposit',
      targetId: depositId,
      staffOpenid: deposit.staffOpenid,
      amountDelta: amount,
      detail: { amount, paymentNo, channel: paymentPayload.channel || 'mock' }
    })
    const existingPayment = (await db.collection('payments').where({ orderId: depositId, targetType: 'staff_deposit' }).limit(1).get()).data[0]
    if (existingPayment) {
      await db.collection('payments').doc(existingPayment._id).update({
        data: {
          status: 'success',
          channel: paymentPayload.channel || existingPayment.channel || 'mock',
          wxTransactionId: paymentPayload.wxTransactionId || existingPayment.wxTransactionId || '',
          rawCallback: paymentPayload.rawCallback || {},
          paidAt: time,
          updatedAt: time
        }
      })
    }
    return { depositId, status: 'paid', paymentNo }
  }

  async function createRefundForOrder(order, refundAmount, reason, source, operatorOpenid, clientRequestId = '', options = {}) {
    if (clientRequestId) {
      const existingByRequest = await findByClientRequestId('refunds', { orderId: order._id, openid: order.clientOpenid || '', clientRequestId })
      if (existingByRequest) return existingByRequest
    }
    const existing = await db.collection('refunds').where({ orderId: order._id, status: 'processing' }).limit(1).get()
    if (existing.data[0]) return existing.data[0]
    const time = now()
    const refundNo = createRefundNo()
    const refund = {
      orderId: order._id,
      orderNo: order.orderNo || '',
      paymentNo: order.paymentNo || '',
      wxTransactionId: order.wxTransactionId || '',
      refundNo,
      wxRefundId: '',
      openid: order.clientOpenid || '',
      amount: Number(order.payAmount || 0),
      refundAmount: Number(refundAmount || 0),
      reason: reason || '',
      status: 'processing',
      source: source || 'client_cancel',
      operatorOpenid: operatorOpenid || '',
      clientRequestId,
      idempotencyKey: clientRequestId || makeIdempotencyKey('refund', order._id, refundNo),
      rawRequest: {},
      rawCallback: {},
      requestedAt: time,
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('refunds').add({ data: refund })
    const createdRefund = { _id: created._id, ...refund }
    await appendPaymentEvent('refund_create', { orderId: order._id, refundNo, status: 'processing', detail: { refundAmount: refund.refundAmount, source } })

    const settings = await getSystemSettings({ includeSecrets: true })
    assertPaymentModeAllowed(settings.payment)
    if (settings.payment.mode === 'wechat' && settings.payment.refundEnabled !== false && (order.paymentNo || order.wxTransactionId)) {
      try {
        const config = getWechatPayConfig(settings)
        const requestBody = {
          out_trade_no: order.paymentNo || undefined,
          transaction_id: order.wxTransactionId || undefined,
          out_refund_no: refundNo,
          reason: safeText(reason).trim() || '订单退款',
          amount: { refund: amountYuanToFen(refund.refundAmount), total: amountYuanToFen(order.payAmount), currency: 'CNY' }
        }
        if (!requestBody.transaction_id) delete requestBody.transaction_id
        if (requestBody.transaction_id) delete requestBody.out_trade_no
        const response = await wechatPayRequest('POST', '/v3/refund/domestic/refunds', requestBody, config)
        const refundStatus = mapWechatRefundStatus(response.status)
        const update = { wxRefundId: response.refund_id || '', status: refundStatus, rawRequest: sanitizeWechatPayload(requestBody), rawResponse: sanitizeWechatPayload(response), updatedAt: now() }
        await db.collection('refunds').doc(created._id).update({ data: update })
        await appendPaymentEvent('refund_request', { orderId: order._id, refundNo, status: refundStatus, detail: { wxRefundId: update.wxRefundId, refundAmount: refund.refundAmount } })
        Object.assign(createdRefund, update)
      } catch (error) {
        await db.collection('refunds').doc(created._id).update({ data: { status: 'failed', rawResponse: { message: error.message }, updatedAt: now() } })
        await appendPaymentEvent('refund_failed', { orderId: order._id, refundNo, status: 'failed', detail: { message: error.message } })
        throw new Error(`微信退款发起失败：${error.message}`)
      }
    }

    await appendOrderClientMessage(order, { eventType: createdRefund.status === 'success' ? 'refund_result' : 'refund_processing', title: createdRefund.status === 'success' ? '退款已完成' : '退款处理中', detail: `退款金额 ¥${refund.refundAmount}`, actorRole: 'system', unreadForClient: options.unreadForClient !== undefined ? options.unreadForClient === true : true })
    await notifyOrder(order.clientOpenid, 'refundResult', order, { amount: refund.refundAmount, statusText: createdRefund.status === 'success' ? '已退款' : '退款中' })
    return createdRefund
  }

  return {
    buildMallOrderItemSnapshot,
    deductMallProductStock,
    markMallOrderPaid,
    ensurePaymentRecord,
    markOrderPaid,
    markStaffDepositPaid,
    createRefundForOrder
  }
}
