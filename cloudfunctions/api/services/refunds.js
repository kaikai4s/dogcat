module.exports = function createService({ db, crypto, now, getPayableOrder, getSystemSettings,
  assertPaymentModeAllowed, getWechatPayConfig, wechatPayRequest, sanitizeWechatPayload, amountYuanToFen, createRefundNo }) {
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
      const current = (await tx.collection(resolved.collectionName).doc(order._id).get()).data
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
      return { _id: id, ...value }
    })
    return dispatchOrderRefund(refund)
  }

  async function dispatchOrderRefund(refund) {
    if (refund.status === 'success' || refund.channel === 'mock') return refund
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
      const latest = (await tx.collection('refunds').doc(refund._id).get()).data
      if (latest.status === 'success') return latest
      const order = (await tx.collection(resolved.collectionName).doc(refund.orderId).get()).data
      const rows = await totals(tx, refund.orderId)
      const status = response.status === 'SUCCESS' ? 'success' : 'processing'
      const time = now()
      const patch = { status, wxRefundId: response.refund_id || '', gatewayStatus: response.status || '',
        rawRequest: sanitizeWechatPayload(body), rawResponse: sanitizeWechatPayload(response), lastError: '', updatedAt: time,
        ...(status === 'success' ? { succeededAt: time } : {}) }
      await tx.collection('refunds').doc(refund._id).update({ data: patch })
      const successful = rows.reduce((sum, row) => sum + ((row._id === refund._id ? status : row.status) === 'success' ? amountYuanToFen(row.refundAmount) : 0), 0)
      const reserved = rows.filter(row => ['success', 'processing'].includes(row.status)).reduce((sum, row) => sum + amountYuanToFen(row.refundAmount), 0)
      const full = successful >= amountYuanToFen(order.payAmount)
      await tx.collection(resolved.collectionName).doc(order._id).update({ data: {
        refundAmount: reserved / 100, refundedAmount: successful / 100,
        paymentStatus: full ? 'refunded' : 'refunding', refundStatus: full ? 'full_refunded' : successful === reserved ? 'partially_refunded' : 'processing',
        ...(full && order.status !== 'completed' ? { status: 'refunded' } : {}), updatedAt: time
      } })
      if (status === 'success') await tx.collection('finance_logs').doc(refund._id).set({ data: {
        action: 'refund_success', targetType: 'refund', targetId: refund._id, orderId: refund.orderId,
        amountDelta: -Number(refund.refundAmount), detail: { refundNo: refund.refundNo }, createdAt: time
      } })
      return { ...latest, ...patch }
    })
  }

  async function reconcilePendingRefunds() {
    // Oldest checked first; one failure must not block the remaining refunds.
    const rows = (await db.collection('refunds').where({ status: 'processing', channel: 'wechat' }).orderBy('updatedAt', 'asc').limit(30).get()).data || []
    for (const row of rows) {
      try { await dispatchOrderRefund(row) } catch (error) { console.error('[refund-reconcile]', { id: row._id, message: error.message }) }
    }
    return rows.length
  }
  return { requestOrderRefund, dispatchOrderRefund, reconcilePendingRefunds }
}
