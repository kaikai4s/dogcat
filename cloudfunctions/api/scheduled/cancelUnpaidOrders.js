module.exports = function createHelpers({
  db, ORDER_STATUS, now, getOrderPaymentDeadline, getSystemSettings,
  getWechatPayConfig, wechatPayRequest, validatePaymentCallbackPayload,
  markOrderPaid, sanitizeWechatPayload, couponDisplayStatus,
  normalizeMallProduct, getSkuById
}) {
  async function reconcilePayment(order, payment, requireExpired = true) {
    if (payment.channel === 'mock') {
      if (['success', 'paid'].includes(payment.status)) {
        await markOrderPaid(order._id, { paymentNo: payment.paymentNo, channel: 'mock' })
        return false
      }
      return true
    }
    if (!payment.paymentNo) throw new Error('支付记录缺少支付单号，无法安全关单')
    const config = getWechatPayConfig(await getSystemSettings({ includeSecrets: true }))
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(payment.paymentNo)}`
    let response
    try {
      response = await wechatPayRequest('GET', `${path}?mchid=${encodeURIComponent(config.mchId)}`, null, config)
    } catch (error) {
      if (error.code === 'ORDER_NOT_EXIST' && requireExpired) return true
      throw error
    }
    if (response.trade_state === 'SUCCESS') {
      validatePaymentCallbackPayload(response, order, payment, config)
      await markOrderPaid(order._id, {
        paymentNo: payment.paymentNo, wxTransactionId: response.transaction_id,
        channel: 'wechat', rawCallback: sanitizeWechatPayload(response)
      })
      return false
    }
    if (['CLOSED', 'REVOKED', 'PAYERROR'].includes(response.trade_state)) return true
    if (!['NOTPAY', 'USERPAYING'].includes(response.trade_state)) throw new Error('微信支付状态无法确认，暂不取消订单')
    // A payment racing with close may produce ORDERPAID. Keep the order and retry reconciliation.
    await wechatPayRequest('POST', `${path}/close`, { mchid: config.mchId }, config)
    return true
  }

  async function cancelUnpaidOrder(order, options = {}) {
    const time = now()
    const collectionName = options.collectionName || 'orders'
    const requireExpired = options.requireExpired === true
    const payments = []
    for (let offset = 0; ; offset += 100) {
      const page = (await db.collection('payments').where({ orderId: order._id }).orderBy('_id', 'asc').skip(offset).limit(100).get()).data || []
      payments.push(...page)
      if (page.length < 100) break
    }
    // Missing local payment records are not proof that WeChat never received the order.
    if (order.paymentNo && !payments.some(payment => payment.paymentNo === order.paymentNo)) {
      payments.push({ paymentNo: order.paymentNo, channel: 'wechat' })
    }
    if (order.paymentStatus === 'paying' && !payments.length) throw new Error('支付中的订单缺少支付记录，暂不取消')
    for (const payment of payments) {
      if (!await reconcilePayment(order, payment, requireExpired)) return false
    }
    // Bound transaction size explicitly rather than partially cancelling an order.
    if (payments.length > 50) throw new Error('订单支付记录过多，需人工核对')
    return db.runTransaction(async transaction => {
      const current = (await transaction.collection(collectionName).doc(order._id).get()).data
      if (!current || current.status !== ORDER_STATUS.PENDING_PAY || current.paymentStatus === 'paid') return false
      if (current.paymentNo !== order.paymentNo || current.paymentStatus !== order.paymentStatus) return false
      const deadline = getOrderPaymentDeadline(current)
      if (requireExpired && (!deadline || time.getTime() < deadline)) return false
      for (const payment of payments.filter(item => item._id)) {
        const fresh = (await transaction.collection('payments').doc(payment._id).get()).data
        if (fresh && ['success', 'paid'].includes(fresh.status)) return false
      }
      const coupon = current.couponId
        ? (await transaction.collection('user_coupons').doc(current.couponId).get()).data
        : null
      const reason = options.reason || '超过30分钟未支付，系统自动取消'
      if (current.stockReserved === true && Array.isArray(current.items) && current.items.length) {
        const productRestores = new Map()
        for (const item of current.items) {
          const quantity = Number(item.quantity)
          if (!Number.isSafeInteger(quantity) || quantity <= 0) continue
          let product = productRestores.get(item.productId)
          if (!product) {
            const rawProduct = (await transaction.collection('mall_products').doc(item.productId).get()).data
            if (rawProduct) product = typeof normalizeMallProduct === 'function' ? normalizeMallProduct(rawProduct) : rawProduct
          }
          if (product) {
            const sku = typeof getSkuById === 'function' ? getSkuById(product, item.skuId) : (product.skus && product.skus.find(s => s.skuId === item.skuId))
            if (sku) {
              const skus = product.skus.map(row => row.skuId === sku.skuId ? { ...row, stock: Number(row.stock) + quantity } : row)
              const changed = skus.find(row => row.skuId === sku.skuId)
              if (typeof normalizeMallProduct === 'function') {
                product = normalizeMallProduct({
                  ...product,
                  ...(product.specMode === 'single' ? { stock: changed.stock } : {}),
                  skus
                })
              } else {
                product.skus = skus
                if (product.specMode === 'single') product.stock = changed.stock
              }
              productRestores.set(item.productId, product)
            }
          }
        }
        for (const [id, product] of productRestores) {
          const { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText } = product
          await transaction.collection('mall_products').doc(id).update({
            data: { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText, updatedAt: time }
          })
        }
      }
      const updateData = {
        status: 'cancelled', paymentStatus: 'closed', cancelReason: reason, cancelledAt: time, updatedAt: time
      }
      if (current.stockReserved === true) {
        updateData.stockReserved = false
        updateData.stockReleasedAt = time
      }
      await transaction.collection(collectionName).doc(order._id).update({ data: updateData })
      if (coupon && coupon.status === 'locked' && coupon.lockedOrderId === order._id) {
        await transaction.collection('user_coupons').doc(current.couponId).update({ data: {
          status: couponDisplayStatus({ ...coupon, status: 'available' }, time),
          lockedOrderId: '', lockedAt: '', unlockedAt: time, updatedAt: time
        } })
      }
      for (const payment of payments.filter(item => item._id)) {
        await transaction.collection('payments').doc(payment._id).update({ data: { status: 'closed', updatedAt: time } })
      }
      await transaction.collection('order_timeline').doc(`timeout_${order._id}`).set({ data: {
        orderId: order._id, type: 'cancelled', title: '订单已取消', detail: reason, actorRole: options.actorRole || 'system', createdAt: time
      } })
      return true
    })
  }

  async function cancelUnpaidOrders() {
    const time = now()
    const cancelled = []
    for (const collectionName of ['orders', 'mall_orders']) {
    let cursor = ''
    while (true) {
      const where = { status: ORDER_STATUS.PENDING_PAY }
      if (cursor) where._id = db.command.gt(cursor)
      const orders = (await db.collection(collectionName).where(where).orderBy('_id', 'asc').limit(100).get()).data || []
      for (const order of orders) {
        const deadline = getOrderPaymentDeadline(order)
        if (!deadline || time.getTime() < deadline || order.paymentStatus === 'paid') continue
        try {
          if (await cancelUnpaidOrder(order, { requireExpired: true, collectionName })) cancelled.push(order._id)
        } catch (error) {
          console.error('[cancelUnpaidOrders]', { orderId: order._id, message: error.message })
        }
      }
      if (orders.length < 100) break
      cursor = orders[orders.length - 1]._id
    }
    }
    return cancelled
  }

  return { cancelUnpaidOrders, cancelUnpaidOrder }
}
