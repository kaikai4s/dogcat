module.exports = function createService(context) {
  const { db, crypto, now, getPayableOrder, createPaymentNo,
    normalizeMallProduct, getSkuById, assertOrderPaymentOpen, amountYuanToFen } = context
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
      const current = (await tx.collection(resolved.collectionName).doc(order._id).get().catch(() => ({ data: null }))).data
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
    const result = await db.runTransaction(async tx => {
      const order = (await tx.collection(resolved.collectionName).doc(orderId).get().catch(() => ({ data: null }))).data
      if (!order) throw new Error('订单不存在')
      const paymentNo = payload.paymentNo || order.paymentNo
      if (!paymentNo) throw new Error('支付单号缺失')
      if (order.paymentStatus === 'paid' || ['refunding', 'refunded'].includes(order.paymentStatus)) {
        if (order.paymentNo && order.paymentNo !== paymentNo) throw new Error('重复付款单号不一致，请核对')
        return { order, changed: false, orderType: resolved.orderType }
      }
      if (order.status !== 'pending_pay' || order.paymentStatus === 'closed') throw new Error('订单状态不可支付')
      const candidates = (await db.collection('payments').where({ orderId, paymentNo }).limit(2).get()).data || []
      const paymentId = key('payment', `${resolved.collectionName}:${orderId}`)
      let payment = await optional(tx, 'payments', paymentId)
      if (!payment) {
        const row = (await db.collection('payments').where({ orderId, paymentNo }).limit(1).get()).data[0]
        if (row) payment = await optional(tx, 'payments', row._id)
      }
      if (!payment) throw new Error('支付单不存在')
      if (payment.status === 'success') return { order, changed: false, orderType: resolved.orderType }
      if (payment.status !== 'pending') throw new Error('支付单状态不可结算')
      if (payment.paymentNo !== paymentNo) throw new Error('支付单号不匹配')
      if (payment.wxTransactionId && payload.wxTransactionId && payment.wxTransactionId !== payload.wxTransactionId) throw new Error('微信交易号不一致')
      if (amountYuanToFen(payment.amount) !== amountYuanToFen(order.payAmount)) throw new Error('支付记录或金额不一致')
      const time = now()
      const coupon = order.couponId ? await optional(tx, 'user_coupons', order.couponId) : null
      if (order.couponId && (!coupon || coupon.openid !== order.clientOpenid || coupon.status !== 'locked' || coupon.lockedOrderId !== orderId)) throw new Error('优惠券状态异常')
      const products = new Map()
      let stockShortage = false
      let shortageReason = ''
      if (resolved.orderType === 'mall') {
        if (!Array.isArray(order.items) || !order.items.length || order.items.length > 40) throw new Error('商城订单商品记录异常')
        for (const item of order.items) {
          const quantity = Number(item.quantity)
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('商品数量不正确')
          let product = products.get(item.productId)
          if (!product) product = normalizeMallProduct(await optional(tx, 'mall_products', item.productId) || {})

          if (order.stockReserved === true) {
            // 方案 A：下单时已预占库存，无需再扣减库存，只累加销量
            const sku = getSkuById(product, item.skuId)
            const skus = product.skus.map(row => row.skuId === (sku ? sku.skuId : item.skuId)
              ? { ...row, salesCount: Number(row.salesCount || 0) + quantity }
              : row)
            const changed = skus.find(row => row.skuId === (sku ? sku.skuId : item.skuId))
            product = normalizeMallProduct({
              ...product,
              ...(product.specMode === 'single' && changed ? { salesCount: changed.salesCount } : {}),
              skus
            })
            products.set(item.productId, product)
          } else {
            // 未预占库存（如历史存量订单或 mock 订单）：需扣减库存
            if (product.status !== 'on_sale') {
              stockShortage = true
              shortageReason = `商品已下架：${item.name}`
              break
            }
            const sku = getSkuById(product, item.skuId)
            if (!sku || sku.status === 'off_sale' || Number(sku.stock) < quantity) {
              stockShortage = true
              shortageReason = `商品库存不足：${item.name}`
              break
            }
            const skus = product.skus.map(row => row.skuId === sku.skuId ? { ...row, stock: Number(row.stock) - quantity, salesCount: Number(row.salesCount || 0) + quantity } : row)
            const changed = skus.find(row => row.skuId === sku.skuId)
            product = normalizeMallProduct({ ...product, ...(product.specMode === 'single' ? { stock: changed.stock, salesCount: changed.salesCount } : {}), skus })
            products.set(item.productId, product)
          }
        }
      }

      if (stockShortage) {
        // 方案 B 兜底：若真实支付已经实扣金额，不可回滚抛错卡死，应标记支付成功并触发全额原路退款
        const hasRealPayment = Boolean(payload.wxTransactionId || (payment && payment.channel !== 'mock'))
        if (!hasRealPayment) {
          throw new Error(shortageReason || '商品库存不足')
        }
        const patch = {
          paymentStatus: 'paid',
          status: 'refund_applied',
          refundStatus: 'applied',
          refundReason: shortageReason || '商品库存不足，系统自动全额退款',
          refundAmount: Number(order.payAmount),
          paymentNo,
          wxTransactionId: payload.wxTransactionId || payment.wxTransactionId || '',
          paidAt: time,
          updatedAt: time
        }
        await tx.collection(resolved.collectionName).doc(orderId).update({ data: patch })
        await tx.collection('payments').doc(payment._id).update({ data: {
          status: 'success', channel: payload.channel || payment.channel, wxTransactionId: patch.wxTransactionId,
          rawCallback: payload.rawCallback || {}, paidAt: time, updatedAt: time
        } })
        if (coupon) {
          await tx.collection('user_coupons').doc(coupon._id).update({
            data: { status: 'available', lockedOrderId: '', lockedAt: null, updatedAt: time }
          })
        }
        const logId = key('paid', `${resolved.collectionName}:${orderId}`)
        await tx.collection('finance_logs').doc(logId).set({ data: {
          action: 'mall_order_paid', targetType: 'mall_order',
          targetId: orderId, orderId, amountDelta: Number(order.payAmount), detail: { paymentNo, shortageReason }, createdAt: time
        } })
        await tx.collection('payment_events').doc(logId).set({ data: {
          eventType: 'paid', orderId, paymentNo, status: 'success', shortageReason, createdAt: time
        } })
        return {
          order: { ...order, ...patch },
          changed: true,
          orderType: resolved.orderType,
          oversoldRefundRequired: true,
          shortageReason
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

    if (result && result.oversoldRefundRequired && typeof context.requestOrderRefund === 'function') {
      try {
        await context.requestOrderRefund(
          result.order,
          Number(result.order.payAmount),
          result.shortageReason || '商品库存不足，系统自动全额退款',
          'system_auto_refund',
          'system'
        )
      } catch (refundError) {
        console.error('[paymentSettlement] oversold auto refund trigger error:', refundError)
      }
    }
    return result
  }

  async function createOrderWithCouponLock({
    collectionName,
    order,
    couponId,
    openid,
    extraDocuments = []
  }) {
    const time = now()
    let candidateId = (typeof db.collection === 'function' && typeof db.collection(collectionName).doc === 'function' && db.collection(collectionName).doc().id)
    if (!candidateId || (db.state && db.state[collectionName] && db.state[collectionName].some(row => row._id === candidateId))) {
      const count = db.state && db.state[collectionName] ? db.state[collectionName].length : 0
      candidateId = `${collectionName}_${count + 1}`
      while (db.state && db.state[collectionName] && db.state[collectionName].some(row => row._id === candidateId)) {
        candidateId = `${collectionName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      }
    }
    const orderId = candidateId

    const execute = async (tx) => {
      // 1. 如果使用了优惠券，在同一事务内进行严格原子校验和锁定
      if (couponId) {
        const coupon = await optional(tx, 'user_coupons', couponId)
        if (!coupon || coupon.openid !== openid) {
          throw new Error('优惠券不存在或不属于当前用户')
        }
        if (coupon.status !== 'available') {
          throw new Error(coupon.status === 'locked' ? '优惠券已被其他订单锁定' : (coupon.status === 'used' ? '优惠券已被使用' : '优惠券不可用'))
        }
        const validTo = new Date(coupon.validTo || 0).getTime()
        if (validTo && validTo < new Date(time).getTime()) {
          throw new Error('优惠券已过期')
        }
        await tx.collection('user_coupons').doc(couponId).update({
          data: {
            status: 'locked',
            lockedOrderId: orderId,
            lockedAt: time,
            updatedAt: time
          }
        })
      }

      // 2. 如果是商城订单，原子校验商品状态并预扣库存（方案 A 核心）
      let stockReserved = false
      if ((collectionName === 'mall_orders' || order.orderType === 'mall') && Array.isArray(order.items) && order.items.length) {
        const productUpdates = new Map()
        for (const item of order.items) {
          const quantity = Number(item.quantity)
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('商品数量不正确')
          let product = productUpdates.get(item.productId)
          if (!product) {
            const rawProduct = (await tx.collection('mall_products').doc(item.productId).get().catch(() => ({ data: null }))).data
            if (!rawProduct || rawProduct.status !== 'on_sale') throw new Error(`商品不存在或已下架：${item.name || ''}`)
            product = typeof normalizeMallProduct === 'function' ? normalizeMallProduct(rawProduct) : rawProduct
          }
          const sku = typeof getSkuById === 'function' ? getSkuById(product, item.skuId) : (product.skus && product.skus.find(s => s.skuId === item.skuId))
          if (!sku || sku.status === 'off_sale') throw new Error(`商品规格不存在或已下架：${item.name || ''}`)
          if (Number(sku.stock || 0) < quantity) {
            throw new Error(`商品库存不足：${product.name || item.name || ''}`)
          }
          const skus = product.skus.map(row => row.skuId === sku.skuId ? { ...row, stock: Number(row.stock) - quantity } : row)
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
          productUpdates.set(item.productId, product)
        }

        for (const [id, product] of productUpdates) {
          const { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText } = product
          await tx.collection('mall_products').doc(id).update({
            data: { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText, updatedAt: time }
          })
        }
        stockReserved = true
      }

      // 3. 写入订单主表记录
      const finalOrder = {
        ...order,
        _id: orderId,
        ...(stockReserved ? { stockReserved: true } : {}),
        createdAt: order.createdAt || time,
        updatedAt: order.updatedAt || time
      }
      await tx.collection(collectionName).doc(orderId).set({
        data: finalOrder
      })

      // 4. 写入附加表（如 order_home_security）
      for (const extra of extraDocuments) {
        const extraColl = extra.collection
        let extraId = extra._id || (typeof db.collection === 'function' && typeof db.collection(extraColl).doc === 'function' && db.collection(extraColl).doc().id)
        if (!extraId || (db.state && db.state[extraColl] && db.state[extraColl].some(row => row._id === extraId))) {
          const count = db.state && db.state[extraColl] ? db.state[extraColl].length : 0
          extraId = `${extraColl}_${count + 1}`
          while (db.state && db.state[extraColl] && db.state[extraColl].some(row => row._id === extraId)) {
            extraId = `${extraColl}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          }
        }
        await tx.collection(extraColl).doc(extraId).set({
          data: { ...extra.data, _id: extraId, orderId }
        })
      }

      return finalOrder
    }

    if (typeof db.runTransaction === 'function') {
      return await db.runTransaction(execute)
    } else {
      return await execute(db)
    }
  }

  return { reserveOrderPayment, settleOrderPayment, createOrderWithCouponLock }
}
