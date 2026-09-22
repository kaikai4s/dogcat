// Payment, order, coupon, stock and ledger changes share one database commit.
module.exports = function createService({ db, crypto, now, getPayableOrder, createPaymentNo,
  normalizeMallProduct, getSkuById, assertOrderPaymentOpen, amountYuanToFen }) {
  const key = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`
  async function optional(tx, name, id) {
    try { return (await tx.collection(name).doc(id).get()).data || null } catch (error) {
      if (String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  async function reserveOrderPayment(order, openid, channel, clientRequestId) {
    const resolved = await getPayableOrder(order._id)
    if (!resolved.order) throw new Error('订单不存在')
    return db.runTransaction(async tx => {
      const current = (await tx.collection(resolved.collectionName).doc(order._id).get()).data
      if (!current || current.clientOpenid !== openid || current.status !== 'pending_pay' || current.paymentStatus === 'closed') throw new Error('订单状态不可支付')
      assertOrderPaymentOpen(current)
      amountYuanToFen(current.payAmount)
      const id = key('payment', `${resolved.collectionName}:${order._id}`)
      let payment = await optional(tx, 'payments', id)
      if (!payment) {
        const candidates = (await db.collection('payments').where({ orderId: order._id, status: 'pending' }).limit(2).get()).data || []
        if (candidates.length > 1) throw new Error('存在重复支付单，请核对后重试')
        if (candidates[0]) payment = await optional(tx, 'payments', candidates[0]._id)
      }
      if (payment && (payment.status !== 'pending' || payment.channel !== channel || Number(payment.amount) !== Number(current.payAmount))) throw new Error('支付单状态或金额已变化，请核对')
      const time = now()
      if (!payment) {
        payment = { _id: id, orderId: order._id, orderNo: current.orderNo || '', openid,
          paymentNo: createPaymentNo(), prepayId: '', wxTransactionId: '', amount: Number(current.payAmount),
          currency: 'CNY', status: 'pending', channel, clientRequestId: clientRequestId || '',
          targetType: resolved.orderType === 'mall' ? 'mall_order' : 'order', createdAt: time, updatedAt: time }
        const { _id, ...value } = payment
        await tx.collection('payments').doc(_id).set({ data: value })
        await tx.collection('payment_events').doc(key('create', _id)).set({ data: {
          eventType: 'create', orderId: order._id, paymentNo: payment.paymentNo, status: 'pending',
          detail: { channel, amount: payment.amount }, createdAt: time
        } })
      }
      await tx.collection(resolved.collectionName).doc(order._id).update({ data: {
        paymentStatus: 'paying', paymentNo: payment.paymentNo, paymentClientRequestId: payment.clientRequestId || '', updatedAt: time
      } })
      return payment
    })
  }

  async function settleOrderPayment(orderId, payload = {}) {
    const resolved = await getPayableOrder(orderId)
    if (!resolved.order) throw new Error('订单不存在')
    return db.runTransaction(async tx => {
      const order = (await tx.collection(resolved.collectionName).doc(orderId).get()).data
      if (!order) throw new Error('订单不存在')
      const paymentNo = payload.paymentNo || order.paymentNo
      if (!paymentNo) throw new Error('支付单号缺失')
      if (order.paymentStatus === 'paid' || ['refunding', 'refunded'].includes(order.paymentStatus)) {
        if (order.paymentNo && order.paymentNo !== paymentNo) throw new Error('重复付款单号不一致，请核对')
        return { order, changed: false, orderType: resolved.orderType }
      }
      if (order.status !== 'pending_pay' || order.paymentStatus === 'closed') throw new Error('订单状态不可支付')
      const candidates = (await db.collection('payments').where({ orderId, paymentNo }).limit(2).get()).data || []
      if (candidates.length > 1) throw new Error('支付记录重复，请核对')
      const payment = candidates[0] ? await optional(tx, 'payments', candidates[0]._id) : null
      if (!payment || payment.orderId !== orderId || payment.paymentNo !== paymentNo || payment.status === 'closed' ||
          amountYuanToFen(payment.amount) !== amountYuanToFen(order.payAmount)) throw new Error('支付记录或金额不一致')
      if (payment.wxTransactionId && payload.wxTransactionId && payment.wxTransactionId !== payload.wxTransactionId) throw new Error('微信交易号不一致')
      const time = now()
      const coupon = order.couponId ? await optional(tx, 'user_coupons', order.couponId) : null
      if (order.couponId && (!coupon || coupon.openid !== order.clientOpenid || coupon.status !== 'locked' || coupon.lockedOrderId !== orderId)) throw new Error('优惠券状态异常')
      const products = new Map()
      if (resolved.orderType === 'mall') {
        if (!Array.isArray(order.items) || !order.items.length || order.items.length > 40) throw new Error('商城订单商品记录异常')
        for (const item of order.items) {
          const quantity = Number(item.quantity)
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('商品数量不正确')
          let product = products.get(item.productId)
          if (!product) product = normalizeMallProduct(await optional(tx, 'mall_products', item.productId) || {})
          if (product.status !== 'on_sale') throw new Error(`商品已下架：${item.name}`)
          const sku = getSkuById(product, item.skuId)
          if (!sku || sku.status === 'off_sale' || Number(sku.stock) < quantity) throw new Error(`商品库存不足：${item.name}`)
          const skus = product.skus.map(row => row.skuId === sku.skuId ? { ...row, stock: Number(row.stock) - quantity, salesCount: Number(row.salesCount || 0) + quantity } : row)
          const changed = skus.find(row => row.skuId === sku.skuId)
          product = normalizeMallProduct({ ...product, ...(product.specMode === 'single' ? { stock: changed.stock, salesCount: changed.salesCount } : {}), skus })
          products.set(item.productId, product)
        }
      }
      for (const [id, product] of products) {
        const { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText } = product
        await tx.collection('mall_products').doc(id).update({ data: { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText, updatedAt: time } })
      }
      const patch = { paymentStatus: 'paid', status: resolved.orderType === 'mall' ? 'pending_ship' : 'paid', paymentNo,
        wxTransactionId: payload.wxTransactionId || '', paidAt: time, updatedAt: time }
      await tx.collection(resolved.collectionName).doc(orderId).update({ data: patch })
      await tx.collection('payments').doc(payment._id).update({ data: {
        status: 'success', channel: payload.channel || payment.channel, wxTransactionId: patch.wxTransactionId,
        rawCallback: payload.rawCallback || {}, paidAt: time, updatedAt: time
      } })
      if (coupon) await tx.collection('user_coupons').doc(coupon._id).update({ data: { status: 'used', usedOrderId: orderId, usedAt: time, updatedAt: time } })
      const logId = key('paid', `${resolved.collectionName}:${orderId}`)
      await tx.collection('finance_logs').doc(logId).set({ data: {
        action: resolved.orderType === 'mall' ? 'mall_order_paid' : 'order_paid', targetType: resolved.orderType === 'mall' ? 'mall_order' : 'order',
        targetId: orderId, orderId, amountDelta: Number(order.payAmount), detail: { paymentNo }, createdAt: time
      } })
      await tx.collection('payment_events').doc(logId).set({ data: { eventType: 'paid', orderId, paymentNo, status: 'success', createdAt: time } })
      if (resolved.orderType === 'service') await tx.collection('order_timeline').doc(logId).set({ data: {
        orderId, type: 'paid', title: '订单已支付', detail: `支付金额 ¥${order.payAmount}`, actorRole: 'client', createdAt: time
      } })
      return { order: { ...order, ...patch }, changed: true, orderType: resolved.orderType }
    })
  }
  return { reserveOrderPayment, settleOrderPayment }
}
