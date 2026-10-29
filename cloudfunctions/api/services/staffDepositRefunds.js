const { documentPages } = require('../utils/documentPages')

module.exports = function createService({
  db, crypto, now, safeText, getSystemSettings, getWechatPayConfig,
  wechatPayRequest, amountYuanToFen, recordStaffDepositRefundSuccess, finalizeStaffDepositExit
}) {
  async function read(id) {
    const deposit = (await db.collection('staff_deposits').doc(id).get()).data
    if (!deposit) throw new Error('保证金记录不存在')
    return deposit
  }
  function result(deposit) {
    const retryAt = new Date(deposit.refundNextCheckAt || 0).getTime()
    return { id: deposit._id, status: deposit.status, refundStatus: deposit.refundStatus,
      refundChannel: deposit.refundChannel || '', refundLastError: deposit.refundLastError || '',
      refundAcceptanceUnconfirmed: !!deposit.refundNo && deposit.refundStatus !== 'success' && !deposit.wechatRefundId,
      retryAfterSeconds: deposit.refundStatus === 'success' ? 0 : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000) || 0),
      availableRefundAmount: deposit.availableRefundAmount,
      approvedRefundAmount: deposit.approvedRefundAmount,
      supplyFeeDeductedAmount: deposit.supplyFeeDeductedAmount || 0,
      ...(deposit.refundStatus === 'success' ? { exitCompleted: !deposit.refundExitPending } : {}) }
  }
  async function prepare(id, payment, config) {
    return db.runTransaction(async tx => {
      const deposit = (await tx.collection('staff_deposits').doc(id).get()).data
      if (deposit.refundStatus === 'success') return deposit
      if (!['refund_approved', 'refunding'].includes(deposit.status) || !['approved', 'processing'].includes(deposit.refundStatus)) throw new Error('仅已审核保证金退款可发起原路退款')
      const time = now()
      if (new Date(deposit.refundNextCheckAt || 0).getTime() > new Date(time).getTime()) return { ...deposit, refundCheckDeferred: true }
      if (deposit.supplyPolicyAcceptedAt && deposit.supplyShipment && !deposit.supplyFeeSettledAt) throw new Error('首次用品费用尚未结算，请先核对报销并结算后退款')
      const original = (await tx.collection('payments').doc(payment._id).get()).data
      if (!original || original.targetType !== 'staff_deposit' || original.orderId !== id ||
          (original.depositId && original.depositId !== id) || original.openid !== deposit.staffOpenid ||
          original.channel !== 'wechat' || original.status !== 'success' || !original.paymentNo ||
          (deposit.paymentNo && deposit.paymentNo !== original.paymentNo) ||
          (deposit.wxTransactionId && deposit.wxTransactionId !== original.wxTransactionId) ||
          amountYuanToFen(original.amount) !== amountYuanToFen(deposit.paidAmount)) throw new Error('原保证金支付记录不匹配，请先对账')
      const refundFen = amountYuanToFen(deposit.approvedRefundAmount)
      const totalFen = amountYuanToFen(original.amount)
      const refundedFen = Math.round(Number(deposit.refundedAmount || 0) * 100)
      const forfeitedFen = Math.round(Number(deposit.forfeitedAmount || 0) * 100)
      const supplyFeeFen = Math.round(Number(deposit.supplyFeeDeductedAmount || 0) * 100)
      if (refundFen !== amountYuanToFen(deposit.availableRefundAmount) ||
          refundFen + refundedFen + forfeitedFen + supplyFeeFen !== totalFen) throw new Error('退款金额与保证金余额不一致')
      if ((deposit.refundMchId && deposit.refundMchId !== config.mchId) ||
          (deposit.refundAppId && deposit.refundAppId !== config.appId)) throw new Error('原退款商户或小程序配置已变化，请先核对原单')
      const patch = deposit.refundNo ? {} : {
        refundNo: `DR${crypto.createHash('sha256').update(JSON.stringify([id, deposit.refundRevision || 0])).digest('hex').slice(0, 28).toUpperCase()}`,
        refundMchId: config.mchId, refundAppId: config.appId,
        refundPaymentNo: original.paymentNo, refundOriginalTransactionId: original.wxTransactionId || '',
        refundTotalFen: totalFen, refundAmountFen: refundFen,
        refundRequestReason: safeText(deposit.refundReason || '宠托师退出退还保证金').slice(0, 80)
      }
      const intent = { ...deposit, ...patch }
      if (!intent.refundMchId || !intent.refundAppId || intent.refundPaymentNo !== original.paymentNo ||
          intent.refundTotalFen !== totalFen || intent.refundAmountFen !== refundFen ||
          intent.refundOriginalTransactionId !== (original.wxTransactionId || '')) throw new Error('原退款凭证不完整或金额变化，请先对账')
      await tx.collection('staff_deposits').doc(id).update({ data: {
        ...patch, refundChannel: 'wechat',
        refundNextCheckAt: new Date(new Date(time).getTime() + 30 * 1000),
        refundLastCheckedAt: new Date(Math.max(new Date(time).getTime(), (new Date(deposit.refundLastCheckedAt || 0).getTime() || 0) + 1)), updatedAt: time
      } })
      return { ...intent, refundChannel: 'wechat' }
    })
  }
  async function savePending(id, intent, patch) {
    await db.runTransaction(async tx => {
      const current = (await tx.collection('staff_deposits').doc(id).get()).data
      if (current.refundStatus === 'success' || !['approved', 'processing'].includes(current.refundStatus)) return
      if (intent && current.refundNo !== intent.refundNo) throw new Error('保证金退款单已变化')
      const time = now()
      await tx.collection('staff_deposits').doc(id).update({ data: { ...patch,
        refundLastCheckedAt: new Date(Math.max(new Date(time).getTime(), (new Date(current.refundLastCheckedAt || 0).getTime() || 0) + 1)), updatedAt: time } })
    })
  }
  function validateRefundResponse(response, intent, refundNo, requirePaymentReference = false) {
    if (!response || response.out_refund_no !== refundNo || !response.refund_id ||
        response.amount?.refund !== intent.refundAmountFen || response.amount?.total !== intent.refundTotalFen ||
        (response.amount.currency && response.amount.currency !== 'CNY') ||
        (response.out_trade_no && response.out_trade_no !== intent.refundPaymentNo) ||
        (response.transaction_id && intent.refundOriginalTransactionId && response.transaction_id !== intent.refundOriginalTransactionId) ||
        (response.mchid && response.mchid !== intent.refundMchId) ||
        (requirePaymentReference && response.out_trade_no !== intent.refundPaymentNo &&
          response.transaction_id !== intent.refundOriginalTransactionId) ||
        !['SUCCESS', 'PROCESSING', 'CLOSED', 'ABNORMAL'].includes(response.status)) {
      throw new Error('微信退款结果不完整或与原保证金不匹配')
    }
  }
  async function adoptLegacyRefund(id, intent, legacyNo) {
    await db.runTransaction(async tx => {
      const current = (await tx.collection('staff_deposits').doc(id).get()).data
      if (current.refundStatus === 'success') return
      if (current.refundNo !== intent.refundNo || current.wechatRefundId ||
          !['approved', 'processing'].includes(current.refundStatus)) throw new Error('原退款单状态已变化，请重新核对')
      await tx.collection('staff_deposits').doc(id).update({ data: {
        refundNo: legacyNo, refundPreviousReservedNo: intent.refundNo,
        refundLegacyRecoveredAt: now(), updatedAt: now()
      } })
    })
  }
  async function syncStaffDepositRefund(id) {
    if (!id) throw new Error('缺少保证金记录 ID')
    const initial = await read(id)
    if (initial.refundStatus === 'success') {
      await finalizeStaffDepositExit(id)
      return result(await read(id))
    }
    if (!['refund_approved', 'refunding'].includes(initial.status)) throw new Error('当前状态不可同步保证金退款')
    let intent, gatewayStage = '', wechatPayment = initial.refundChannel === 'wechat' || initial.paymentChannel === 'wechat'
    try {
      const payments = (await db.collection('payments').where({ orderId: id, targetType: 'staff_deposit' }).limit(2).get()).data
      if (payments.length > 1) throw new Error('保证金支付记录重复，请先对账')
      const payment = payments[0]
      wechatPayment = wechatPayment || payment?.channel === 'wechat'
      if (!wechatPayment) {
        await savePending(id, null, { refundChannel: 'manual', refundLastError: '', statusText: '审核通过，待人工退款' })
        return result(await read(id))
      }
      if (!payment || payment.channel !== 'wechat') throw new Error('原微信保证金支付记录缺失，请先对账')
      const settings = await getSystemSettings({ includeSecrets: true })
      const config = getWechatPayConfig(settings)
      intent = await prepare(id, payment, config)
      if (intent.refundStatus === 'success') return result(intent)
      if (intent.refundCheckDeferred) return result(intent)
      let response
      if (initial.refundNo) {
        try {
          gatewayStage = 'query'
          response = await wechatPayRequest('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(intent.refundNo)}`, null, config)
        } catch (error) {
          if (error.code !== 'RESOURCE_NOT_EXISTS') throw error
          // Reuse the original authorized refund; never create another number.
        }
      }
      // The retired refund flow used an R-prefixed number. A prior successful
      // refund may exist there even if the newer DR-prefixed reservation does not.
      if (!response && !initial.wechatRefundId && (initial.paidAt || initial.createdAt)) {
        const legacyNo = initial.lastRefundNo || `R${crypto.createHash('sha256').update(`staff_deposit_refund:${id}:${initial.paidAt || initial.createdAt || ''}`).digest('hex').slice(0, 24)}`
        if (legacyNo !== intent.refundNo) {
          let legacyResponse
          try {
            gatewayStage = 'query'
            legacyResponse = await wechatPayRequest('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(legacyNo)}`, null, config)
          } catch (error) {
            if (error.code !== 'RESOURCE_NOT_EXISTS') throw error
          }
          if (legacyResponse) {
            gatewayStage = 'validate'
            validateRefundResponse(legacyResponse, intent, legacyNo, true)
            if (!['SUCCESS', 'PROCESSING'].includes(legacyResponse.status)) throw new Error(`旧退款单状态${legacyResponse.status}，请在商户平台核对，系统不会再次发起退款`)
            await adoptLegacyRefund(id, intent, legacyNo)
            intent = { ...intent, refundNo: legacyNo }
            response = legacyResponse
          }
        }
      }
      if (!response) {
        if (settings.payment?.mode !== 'wechat') throw new Error('当前未启用微信支付，无法发起保证金原路退款')
        if (config.refundEnabled === false || settings.payment.refundEnabled === false) throw new Error('微信退款功能尚未启用')
        // A locally reserved merchant number is not evidence that WeChat accepted the refund.
        await savePending(id, intent, { status: 'refunding', statusText: '退款受理待核实', refundStatus: 'processing', refundSubmittedAt: intent.refundSubmittedAt || now() })
        gatewayStage = 'submit'
        response = await wechatPayRequest('POST', '/v3/refund/domestic/refunds', {
          out_refund_no: intent.refundNo, reason: intent.refundRequestReason,
          ...(intent.refundOriginalTransactionId ? { transaction_id: intent.refundOriginalTransactionId } : { out_trade_no: intent.refundPaymentNo }),
          amount: { refund: intent.refundAmountFen, total: intent.refundTotalFen, currency: 'CNY' }
        }, config)
      }
      gatewayStage = 'validate'
      validateRefundResponse(response, intent, intent.refundNo)
      if (response.status === 'SUCCESS') {
        await recordStaffDepositRefundSuccess(id, {
          refundNo: intent.refundNo, refundId: response.refund_id, refundFen: intent.refundAmountFen
        })
      } else {
        await savePending(id, intent, { status: 'refunding', refundStatus: 'processing',
          statusText: response.status === 'PROCESSING' ? '微信已受理，原路退款处理中' : '微信退款异常，待核对原单',
          wechatRefundId: response.refund_id, wechatRefundState: response.status,
          refundNextCheckAt: new Date(new Date(now()).getTime() + (response.status === 'PROCESSING' ? 60 : 300) * 1000),
          refundLastError: response.status === 'PROCESSING' ? '' : `微信退款状态：${response.status}，请在商户平台核对原退款单` })
      }
    } catch (error) {
      const rateLimited = error.statusCode === 429 || /FREQUENCY_LIMITED|RATE_LIMIT|请求频率过高|频率限制/i.test(`${error.code || ''} ${error.message || ''}`)
      const acceptanceUnknown = !!intent?.refundNo && !intent.wechatRefundId && gatewayStage !== 'query'
      await savePending(id, intent, { ...(wechatPayment ? { refundChannel: 'wechat' } : {}),
        ...(acceptanceUnknown ? { statusText: '退款受理待核实' } : {}),
        ...(rateLimited ? { refundNextCheckAt: new Date(new Date(now()).getTime() + 5 * 60 * 1000) } : {}),
        refundLastError: rateLimited
          ? `${gatewayStage === 'submit' ? '微信退款提交未获受理确认' : '微信退款查询被限流'}，冷却至少5分钟后定时任务会自动核对原退款单，请勿重复发起退款`
          : safeText(error.message || '保证金退款待确认').slice(0, 500) })
    }
    return result(await read(id))
  }
  async function reconcileStaffDepositRefunds(limit = 10) {
    const startedAt = Date.now()
    const count = Math.min(Math.max(Number(limit) || 10, 1), 20)
    let checked = 0
    async function reconcile(where) {
      let processed = 0
      for await (const rows of documentPages(db, db.command, 'staff_deposits', where)) {
        for (const deposit of rows) {
          if (Date.now() - startedAt >= 45000 || processed >= count) return
          if (deposit.refundStatus !== 'success' && new Date(deposit.refundNextCheckAt || 0).getTime() > Date.now()) continue
          processed++
          checked++
          try {
            const checkedAt = new Date(Math.max(new Date(now()).getTime(), (new Date(deposit.refundLastCheckedAt || 0).getTime() || 0) + 1))
            await db.collection('staff_deposits').doc(deposit._id).update({ data: { refundLastCheckedAt: checkedAt } })
            await syncStaffDepositRefund(deposit._id)
          } catch (error) { console.error('[deposit-refund-sync]', { depositId: deposit._id, message: error.message }) }
        }
      }
    }
    await reconcile({ status: db.command.in(['refund_approved', 'refunding']) })
    if (Date.now() - startedAt < 45000) await reconcile({ refundStatus: 'success', refundExitPending: true })
    return { checked }
  }
  return { syncStaffDepositRefund, reconcileStaffDepositRefunds }
}
