module.exports = function createService({ db, crypto, now, getPayableOrder, getSystemSettings,
  assertPaymentModeAllowed, getWechatPayConfig, wechatPayRequest, sanitizeWechatPayload, amountYuanToFen, createRefundNo, restoreOrderCoupon,
  normalizeMallProduct, getSkuById }) {
  const idFor = value => `refund_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`
  async function optional(tx, name, id) {
    try { return (await tx.collection(name).doc(id).get()).data || null } catch (error) {
      if (String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  async function totals(tx, orderId) {
    const candidates = (await db.collection('refunds').where({ orderId }).limit(51).get()).data || []
    if (candidates.length > 50) throw new Error('退款记录超过50笔，请人工核对')
    const rows = []
    for (const candidate of candidates) {
      const row = await optional(tx, 'refunds', candidate._id)
      if (row && row.orderId === orderId) rows.push(row)
    }
    return rows
  }
  async function requestOrderRefund(order, amount, reason, source, operatorOpenid, requestId = '', options = {}) {
    const requested = amountYuanToFen(amount)
    const settings = await getSystemSettings({ includeSecrets: true })
    assertPaymentModeAllowed(settings.payment)
    if (settings.payment.mode === 'wechat' && settings.payment.refundEnabled === false) throw new Error('微信退款功能尚未启用')
    if (settings.payment.mode === 'wechat' && !order.paymentNo && !order.wxTransactionId) throw new Error('缺少原支付凭证，请先对账')
    const resolved = await getPayableOrder(order._id)
    if (!resolved.order) throw new Error('订单不存在')
    const id = idFor(`${resolved.collectionName}:${order._id}:${operatorOpenid}:${requestId || crypto.randomBytes(16).toString('hex')}`)
    const refund = await db.runTransaction(async tx => {
      const current = (await tx.collection(resolved.collectionName).doc(order._id).get().catch(() => ({ data: null }))).data
      if (!current) throw new Error('订单不存在')
      const previous = await optional(tx, 'refunds', id)
      const rows = await totals(tx, order._id)
      const existing = previous || (requestId && rows.find(row => row.clientRequestId === requestId && row.openid === order.clientOpenid))
      if (existing) {
        if (amountYuanToFen(existing.refundAmount) !== requested || existing.reason !== (reason || '') || existing.source !== source) throw new Error('同一退款请求不可更改金额或原因')
        return existing
      }
      if (!['paid', 'refunding'].includes(current.paymentStatus)) throw new Error('订单未支付或状态不支持退款')
      // Reusing a pending request is allowed only for the same business operation.
      const pending = !requestId && rows.find(row => row.status === 'processing' && row.source === source && row.reason === (reason || '') && amountYuanToFen(row.refundAmount) === requested)
      if (pending) return pending
      const reserved = rows.filter(row => ['processing', 'success'].includes(row.status)).reduce((sum, row) => sum + amountYuanToFen(row.refundAmount), 0)
      const recorded = current.refundAmount == null || Number(current.refundAmount) === 0 ? 0 : amountYuanToFen(current.refundAmount)
      const successful = rows.filter(row => row.status === 'success').reduce((sum, row) => sum + amountYuanToFen(row.refundAmount), 0)
      const recordedSuccess = current.refundedAmount == null || Number(current.refundedAmount) === 0 ? 0 : amountYuanToFen(current.refundedAmount)
      // Older mall applications stored the requested amount in refundAmount before approval.
      const legacyApplication = resolved.collectionName === 'mall_orders' && ['applied', 'rejected'].includes(current.refundStatus) &&
        current.paymentStatus === 'paid' && !current.refundNo && !rows.length && recorded === amountYuanToFen(current.payAmount)
      if ((!legacyApplication && recorded > reserved) || recordedSuccess > successful) throw new Error('历史退款金额与明细不一致，请先对账')
      const total = amountYuanToFen(current.payAmount)
      if (!Number.isSafeInteger(reserved + requested) || reserved + requested > total) throw new Error('退款金额不能超过可退金额上限')
      if (options.cancelStatus && (current.status !== order.status || current.staffOpenid !== order.staffOpenid)) throw new Error('订单状态已变化，请刷新后重新取消')
      const time = now()
      const value = { orderId: order._id, orderNo: current.orderNo || '', collectionName: resolved.collectionName,
        paymentNo: current.paymentNo || '', wxTransactionId: current.wxTransactionId || '', refundNo: createRefundNo(),
        openid: current.clientOpenid || '', amount: Number(current.payAmount), refundAmount: requested / 100,
        reason: reason || '', source, operatorOpenid, clientRequestId: requestId, status: 'processing',
        channel: settings.payment.mode, requestedAt: time, createdAt: time, updatedAt: time }
      await tx.collection('refunds').doc(id).set({ data: value })
      await tx.collection(resolved.collectionName).doc(order._id).update({ data: {
        paymentStatus: 'refunding', refundStatus: 'processing', refundAmount: (reserved + requested) / 100,
        refundNo: value.refundNo, refundRevision: Number(current.refundRevision || 0) + 1, updatedAt: time,
        ...(options.cancelStatus ? { status: options.cancelStatus, cancelReason: reason || '', cancelledAt: time } : {}),
        ...(options.cancelStatus === 'expired' ? { expiredAt: time, expireReason: '服务开始时间前无人接单' } : {})
      } })
      await tx.collection('payment_events').doc(id).set({ data: { eventType: 'refund_create', orderId: order._id,
        refundNo: value.refundNo, status: 'processing', detail: { refundAmount: value.refundAmount, source }, createdAt: time } })
      if (current.couponId && (reserved + requested >= total)) {
        if (typeof restoreOrderCoupon === 'function') {
          await restoreOrderCoupon(current.couponId, order._id, tx)
        }
      }
      return { _id: id, ...value }
    })
    return dispatchOrderRefund(refund)
  }

  async function dispatchOrderRefund(refund) {
    if (refund.status === 'success' || refund.status === 'failed' || refund.channel === 'mock') return refund
    const settings = await getSystemSettings({ includeSecrets: true })
    if (settings.payment.mode !== 'wechat' || settings.payment.refundEnabled === false) throw new Error('微信退款功能尚未启用')
    const config = getWechatPayConfig(settings)
    const body = { out_refund_no: refund.refundNo, reason: refund.reason || '订单退款',
      amount: { refund: amountYuanToFen(refund.refundAmount), total: amountYuanToFen(refund.amount), currency: 'CNY' },
      ...(refund.wxTransactionId ? { transaction_id: refund.wxTransactionId } : { out_trade_no: refund.paymentNo }) }
    let response
    try {
      // Reuse the same merchant refund number after any ambiguous network outcome.
      response = await wechatPayRequest('POST', '/v3/refund/domestic/refunds', body, config)
      if (response.out_refund_no && response.out_refund_no !== refund.refundNo) throw new Error('微信退款单号不一致')
      if (response.amount && (response.amount.refund !== body.amount.refund || response.amount.total !== body.amount.total)) throw new Error('微信退款金额不一致')
    } catch (error) {
      await db.collection('refunds').doc(refund._id).update({ data: { lastError: String(error.message || error).slice(0, 300), updatedAt: now() } })
      throw new Error(`微信退款结果待核实，请使用原请求重试：${error.message}`)
    }
    const resolved = await getPayableOrder(refund.orderId)
    return db.runTransaction(async tx => {
      const latest = (await tx.collection('refunds').doc(refund._id).get().catch(() => ({ data: null }))).data
      if (!latest || latest.status === 'success' || latest.status === 'failed') return latest || refund
      const order = (await tx.collection(resolved.collectionName).doc(refund.orderId).get().catch(() => ({ data: null }))).data
      if (!order) throw new Error('订单不存在')
      const rows = await totals(tx, refund.orderId)
      let status = 'processing'
      let failReason = ''
      if (response.status === 'SUCCESS') {
        status = 'success'
      } else if (response.status === 'CLOSED') {
        status = 'failed'
        failReason = '微信退款已关闭'
      } else if (response.status === 'ABNORMAL') {
        status = 'failed'
        failReason = '微信退款异常'
      }
      const time = now()
      const patch = { status, wxRefundId: response.refund_id || '', gatewayStatus: response.status || '',
        rawRequest: sanitizeWechatPayload(body), rawResponse: sanitizeWechatPayload(response),
        lastError: status === 'failed' ? (failReason || response.status || '') : '',
        failReason: status === 'failed' ? (failReason || response.status || '') : '',
        updatedAt: time,
        ...(status === 'success' ? { succeededAt: time } : {}),
        ...(status === 'failed' ? { failedAt: time } : {}) }
      await tx.collection('refunds').doc(refund._id).update({ data: patch })
      const successful = rows.reduce((sum, row) => sum + ((row._id === refund._id ? status : row.status) === 'success' ? amountYuanToFen(row.refundAmount) : 0), 0)
      const reserved = rows.reduce((sum, row) => sum + (['success', 'processing'].includes(row._id === refund._id ? status : row.status) ? amountYuanToFen(row.refundAmount) : 0), 0)
      const hasProcessing = rows.some(row => (row._id === refund._id ? status : row.status) === 'processing')
      const total = amountYuanToFen(order.payAmount)
      const full = successful >= total
      let paymentStatus = order.paymentStatus
      let refundStatus = order.refundStatus
      if (hasProcessing) {
        paymentStatus = 'refunding'
        refundStatus = 'processing'
      } else if (full) {
        paymentStatus = 'refunded'
        refundStatus = 'full_refunded'
      } else if (successful > 0) {
        paymentStatus = 'paid'
        refundStatus = 'partially_refunded'
      } else {
        paymentStatus = 'paid'
        refundStatus = 'failed'
      }
      const isMallOrder = resolved.collectionName === 'mall_orders' || order.orderType === 'mall'
      let shouldRestoreStock = false
      if (status === 'success' && full && isMallOrder && order.status !== 'completed' && order.oversoldRefundRequired !== true && order.stockRestored !== true && Array.isArray(order.items) && order.items.length) {
        shouldRestoreStock = true
      }

      if (shouldRestoreStock) {
        const productRestores = new Map()
        for (const item of order.items) {
          const quantity = Number(item.quantity)
          if (!Number.isSafeInteger(quantity) || quantity <= 0) continue
          let product = productRestores.get(item.productId)
          if (!product) {
            const rawProduct = (await tx.collection('mall_products').doc(item.productId).get().catch(() => ({ data: null }))).data
            if (rawProduct) product = typeof normalizeMallProduct === 'function' ? normalizeMallProduct(rawProduct) : rawProduct
          }
          if (product) {
            let sku = typeof getSkuById === 'function' ? getSkuById(product, item.skuId) : null
            if (!sku && Array.isArray(product.skus)) {
              sku = product.skus.find(s => s.skuId === item.skuId)
            }
            if (sku) {
              const skus = product.skus.map(row => row.skuId === sku.skuId
                ? {
                  ...row,
                  stock: Number(row.stock || 0) + quantity,
                  salesCount: Math.max(0, Number(row.salesCount || 0) - quantity)
                }
                : row)
              const changed = skus.find(row => row.skuId === sku.skuId)
              if (typeof normalizeMallProduct === 'function') {
                product = normalizeMallProduct({
                  ...product,
                  ...(product.specMode === 'single' ? { stock: changed.stock, salesCount: changed.salesCount } : {}),
                  skus
                })
              } else {
                product.skus = skus
                if (product.specMode === 'single') {
                  product.stock = changed.stock
                  product.salesCount = changed.salesCount
                }
              }
              productRestores.set(item.productId, product)
            }
          }
        }
        for (const [id, product] of productRestores) {
          const { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText } = product
          await tx.collection('mall_products').doc(id).update({
            data: { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText, updatedAt: time }
          })
        }
      }

      await tx.collection(resolved.collectionName).doc(order._id).update({ data: {
        refundAmount: reserved / 100, refundedAmount: successful / 100,
        paymentStatus, refundStatus,
        ...(full && order.status !== 'completed' ? { status: 'refunded' } : {}),
        ...(shouldRestoreStock ? { stockRestored: true, stockRestoredAt: time } : {}),
        updatedAt: time
      } })
      if (status === 'success') {
        if (full && order.couponId && typeof restoreOrderCoupon === 'function') {
          await restoreOrderCoupon(order.couponId, order._id, tx)
        }
        await tx.collection('finance_logs').doc(refund._id).set({ data: {
          action: 'refund_success', targetType: 'refund', targetId: refund._id, orderId: refund.orderId,
          amountDelta: -Number(refund.refundAmount), detail: { refundNo: refund.refundNo }, createdAt: time
        } })
      } else if (status === 'failed') {
        await tx.collection('payment_events').doc(`${refund._id}_failed`).set({ data: {
          eventType: 'refund_failed', orderId: refund.orderId, refundNo: refund.refundNo, status: 'failed',
          detail: { gatewayStatus: response.status, failReason, refundAmount: refund.refundAmount }, createdAt: time
        } })
      }
      return { ...latest, ...patch }
    })
  }

  async function reconcilePendingRefunds() {
    // 1. 处理 processing 中的退款记录（对微信端重试 dispatch）
    const rows = (await db.collection('refunds').where({ status: 'processing', channel: 'wechat' }).orderBy('updatedAt', 'asc').limit(30).get()).data || []
    for (const row of rows) {
      try {
        const updated = await dispatchOrderRefund(row)
        if (updated && updated.status === 'success') {
          const resolved = await getPayableOrder(row.orderId)
          if (resolved && resolved.order && resolved.order.oversoldRefundFailed) {
            await db.collection(resolved.collectionName).doc(row.orderId).update({
              data: {
                oversoldRefundFailed: false,
                oversoldRefundRecoveredAt: now(),
                updatedAt: now()
              }
            }).catch(() => {})
          }
        }
      } catch (error) {
        console.error('[refund-reconcile]', { id: row._id, message: error.message })
      }
    }

    // 2. 补偿重试：处理因前置异常未能成功发起退款单的超卖订单（oversoldRefundFailed: true）
    const failedMallOrders = (await db.collection('mall_orders').where({ oversoldRefundFailed: true }).limit(20).get()).data || []
    const failedServiceOrders = (await db.collection('orders').where({ oversoldRefundFailed: true }).limit(20).get()).data || []
    const allFailed = [
      ...failedMallOrders.map(o => ({ order: o, collection: 'mall_orders' })),
      ...failedServiceOrders.map(o => ({ order: o, collection: 'orders' }))
    ]
    for (const { order: failedOrder, collection } of allFailed) {
      try {
        const refundRows = (await db.collection('refunds').where({ orderId: failedOrder._id }).limit(10).get()).data || []
        const hasSuccess = refundRows.some(r => r.status === 'success')
        if (hasSuccess) {
          await db.collection(collection).doc(failedOrder._id).update({
            data: { oversoldRefundFailed: false, oversoldRefundRecoveredAt: now(), updatedAt: now() }
          }).catch(() => {})
          continue
        }
        const hasProcessing = refundRows.some(r => r.status === 'processing')
        if (hasProcessing) {
          continue
        }
        // 重新拉起退款请求
        await requestOrderRefund(
          failedOrder,
          Number(failedOrder.payAmount),
          failedOrder.refundReason || '商品库存不足，系统自动全额退款',
          'system_auto_refund',
          'system'
        )
        await db.collection(collection).doc(failedOrder._id).update({
          data: {
            oversoldRefundFailed: false,
            oversoldRefundRecoveredAt: now(),
            updatedAt: now()
          }
        }).catch(() => {})
      } catch (retryErr) {
        console.error('[refund-reconcile-oversold]', { id: failedOrder._id, message: retryErr.message })
      }
    }

    return rows.length + allFailed.length
  }
  return { requestOrderRefund, dispatchOrderRefund, reconcilePendingRefunds }
}
