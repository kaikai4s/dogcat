module.exports = function createService({ db, now, parseDateValue, safeText, enqueueSubscription, buildSubscriptionData, settleUserAssetWithdrawal, markUserAssetPaid, markUserAssetFailed, releaseUserAssetWithdrawal, commitWechatTransferSuccessQuota, releaseWechatTransferQuota }) {
  async function optionalDocument(transaction, collectionName, id) {
    try {
      return (await transaction.collection(collectionName).doc(id).get()).data || null
    } catch (error) {
      if (String(error.message || error.errMsg || error).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }

  async function optionalOrder(tx, id) {
    try { return (await tx.collection('orders').doc(id).get()).data || null } catch (error) {
      if (String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  function cents(value, positive = false) {
    const amount = Number(value)
    const result = Math.round(amount * 100)
    if (value == null || value === '' || !Number.isFinite(amount) || !Number.isSafeInteger(result) || Math.abs(amount * 100 - result) > 0.000001 ||
        amount < 0 || (positive && result <= 0)) throw new Error('金额不正确，请核对财务记录')
    return result
  }

  function ids(value, required = false) {
    if (!Array.isArray(value) || value.length > 50 || (required && !value.length) ||
        value.some(id => typeof id !== 'string' || !id) || new Set(value).size !== value.length) {
      throw new Error('收益关联记录异常或超过50笔，请人工核对')
    }
    return value
  }

  function releasedStatus(earning, time) {
    const availableAt = parseDateValue(earning.availableAt)
    return availableAt && availableAt > time ? 'pending' : 'available'
  }

  async function financeLog(tx, id, action, targetType, targetId, time, payload = {}) {
    await tx.collection('finance_logs').doc(id).set({ data: {
      action, targetType, targetId, amountDelta: 0, createdAt: time, ...payload
    } })
  }

  async function settleWithdrawal(admin, data, paid = false) {
    const probe = await db.collection('withdraw_requests').doc(data.id).get().catch(() => ({ data: null }))
    if (probe && probe.data && probe.data.assetType === 'user') {
      if (typeof settleUserAssetWithdrawal !== 'function') throw new Error('用户资产提现服务未就绪')
      return settleUserAssetWithdrawal(admin, data, paid)
    }
    const paymentReference = safeText(data.paymentReference).trim()
    const paymentProofImage = safeText(data.paymentProofImage || data.paymentProof || '').trim()
    if (paid && (data.paymentConfirmed !== true || !paymentReference)) throw new Error('请确认实际付款成功并填写付款凭证号')
    const target = paid ? 'paid' : (data.approved === true ? 'approved' : 'rejected')
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.status === target) {
        if (paid && request.paymentReference && request.paymentReference !== paymentReference) throw new Error('已确认付款凭证不可更改')
        return { request, changed: false }
      }
      if (request.status !== (paid ? 'approved' : 'pending')) throw new Error(paid ? '仅已审核提现可标记打款' : '当前状态不可审核')
      if (paid && request.payoutChannel === 'wechat_wallet') throw new Error('微信提现单须以微信转账成功结果为准，不能手动标记打款')

      // 双人复核校验
      let isSameAuditorAndPayer = false
      if (paid) {
        const settings = await optionalDocument(tx, 'system_settings', 'default')
        const strictDualReview = settings?.finance?.strictDualReview === true
        if (request.auditedByOpenid && request.auditedByOpenid === admin.openid) {
          if (strictDualReview) {
            throw new Error('系统已开启严格财务双人复核，审核人与打款出款人不能为同一管理员')
          }
          isSameAuditorAndPayer = true
        }
      }

      const earningIds = ids(request.earningIds, true)
      const earnings = []
      let total = 0
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || !request.staffOpenid || earning.staffOpenid !== request.staffOpenid ||
            earning.isMock === true || earning.paymentChannel === 'mock' ||
            earning.withdrawRequestId !== data.id || earning.status !== 'withdrawing' || earning.frozenIncidentId) {
          throw new Error('收益状态或提现归属异常，请核对后重试')
        }
        total += cents(earning.amount, true)
        earnings.push(earning)
      }
      if (!Number.isSafeInteger(total) || total !== cents(request.amount, true)) throw new Error('提现金额与收益合计不一致')
      const time = now()
      const patch = paid
        ? {
            status: target,
            paidAt: time,
            paidByOpenid: admin.openid,
            paidByUserId: admin._id || '',
            payRemark: safeText(data.payRemark).trim(),
            paymentReference,
            paymentProofImage: paymentProofImage || request.paymentProofImage || '',
            paymentChannel: 'MANUAL_CONFIRMED',
            isSameAuditorAndPayer,
            updatedAt: time
          }
        : {
            status: target,
            auditedAt: time,
            auditedByOpenid: admin.openid,
            auditedByUserId: admin._id || '',
            auditRemark: safeText(data.auditRemark).trim(),
            updatedAt: time
          }
      if (!paid && target === 'rejected') await releaseWechatTransferQuota(tx, { _id: data.id, ...request }, 'rejected')
      await tx.collection('withdraw_requests').doc(data.id).update({ data: patch })
      // Approval also writes the earnings, making it conflict with concurrent freezes.
      for (const earning of earnings) {
        await tx.collection('staff_earnings').doc(earning._id).update({ data: {
          status: paid ? 'withdrawn' : target === 'rejected' ? releasedStatus(earning, time) : 'withdrawing',
          withdrawRequestId: target === 'rejected' ? '' : data.id, updatedAt: time
        } })
      }
      const action = `withdraw_${target}`
      await enqueueSubscription(tx, { openid: request.staffOpenid, templateKey: 'withdrawResult', page: 'pages/staff/earnings/index',
        messageData: buildSubscriptionData('withdrawResult', { orderNo: data.id, startTime: request.createdAt }, { amount: request.amount, statusText: paid ? '已打款' : target === 'approved' ? '已审核' : '已驳回' }), orderId: '', deliveryKey: `withdraw:${data.id}:${target}` })
      await financeLog(tx, `${action}_${data.id}`, action, 'withdraw_request', data.id, time, {
        staffOpenid: request.staffOpenid, amountDelta: paid ? -total / 100 : 0,
        detail: { earningIds, auditRemark: patch.auditRemark || '', payRemark: patch.payRemark || '', paymentReference, paymentProofImage: patch.paymentProofImage || '', isSameAuditorAndPayer }
      })
      await tx.collection('admin_operation_logs').doc(`${action}_${data.id}`).set({ data: {
        adminUserId: admin._id, adminOpenid: admin.openid, targetType: 'withdraw_request', targetId: data.id,
        action: paid ? 'markWithdrawPaid' : 'auditWithdrawRequest', detail: { amount: total / 100, approved: data.approved === true, paymentReference: patch.paymentReference, paymentProofImage: patch.paymentProofImage, isSameAuditorAndPayer }, createdAt: time
      } })
      return { request: { ...request, ...patch }, changed: true }
    })
  }

  function transferPaidReference(request, result = {}) {
    return safeText(result.transferBillNo || result.transfer_bill_no || result.outBillNo || request.outBillNo || request.outDetailNo).trim()
  }

  async function markWechatWithdrawalPaid(withdrawId, result = {}) {
    const probe = await db.collection('withdraw_requests').doc(withdrawId).get().catch(() => ({ data: null }))
    if (probe && probe.data && probe.data.assetType === 'user') return markUserAssetPaid(withdrawId, result)
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.status === 'paid') return { request, changed: false }
      if (request.payoutChannel !== 'wechat_wallet') throw new Error('非微信提现单不能使用微信转账结算')
      if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('当前提现状态不可确认微信打款')
      const earningIds = ids(request.earningIds, true)
      const earnings = []
      let total = 0
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || earning.staffOpenid !== request.staffOpenid || earning.withdrawRequestId !== withdrawId || earning.status !== 'withdrawing' || earning.frozenIncidentId) {
          throw new Error('收益状态或提现归属异常，请核对后重试')
        }
        total += cents(earning.amount, true)
        earnings.push(earning)
      }
      if (!Number.isSafeInteger(total) || total !== cents(request.amount, true)) throw new Error('提现金额与收益合计不一致')
      const time = now()
      const paymentReference = transferPaidReference(request, result)
      await commitWechatTransferSuccessQuota(tx, { _id: withdrawId, ...request }, result)
      const patch = {
        status: 'paid',
        transferStatus: 'success',
        wechatTransferState: safeText(result.state || result.transfer_state || 'SUCCESS').trim() || 'SUCCESS',
        wechatTransferBillNo: safeText(result.transferBillNo || result.transfer_bill_no || request.wechatTransferBillNo).trim(),
        paymentChannel: 'WECHAT_WALLET',
        paymentReference,
        paidAt: time,
        transferSucceededAt: time,
        lastTransferCheckedAt: time,
        rawTransferResponse: result.rawTransferResponse || result.raw || {},
        updatedAt: time
      }
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: patch })
      for (const earning of earnings) {
        await tx.collection('staff_earnings').doc(earning._id).update({ data: { status: 'withdrawn', updatedAt: time } })
      }
      await enqueueSubscription(tx, { openid: request.staffOpenid, templateKey: 'withdrawResult', page: 'pages/staff/earnings/index',
        messageData: buildSubscriptionData('withdrawResult', { orderNo: withdrawId, startTime: request.createdAt }, { amount: request.amount, statusText: '已打款' }), orderId: '', deliveryKey: `withdraw:${withdrawId}:paid` })
      await financeLog(tx, `withdraw_paid_${withdrawId}`, 'withdraw_paid', 'withdraw_request', withdrawId, time, {
        staffOpenid: request.staffOpenid, amountDelta: -total / 100,
        detail: { earningIds, paymentChannel: 'WECHAT_WALLET', paymentReference, outBillNo: request.outBillNo }
      })
      return { request: { ...request, ...patch }, changed: true }
    })
  }

  async function markWechatWithdrawalFailed(withdrawId, result = {}) {
    const probe = await db.collection('withdraw_requests').doc(withdrawId).get().catch(() => ({ data: null }))
    if (probe && probe.data && probe.data.assetType === 'user') return markUserAssetFailed(withdrawId, result)
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.status === 'paid') return { request, changed: false }
      if (request.payoutChannel !== 'wechat_wallet') throw new Error('非微信提现单不能标记微信转账失败')
      const time = now()
      await releaseWechatTransferQuota(tx, { _id: withdrawId, ...request }, 'transfer_failed')
      const patch = {
        status: 'transfer_failed',
        transferStatus: 'failed',
        wechatTransferState: safeText(result.state || result.transfer_state || 'FAIL').trim() || 'FAIL',
        lastTransferError: safeText(result.failReason || result.fail_reason || result.message || '微信提现失败').slice(0, 500),
        lastTransferCheckedAt: time,
        transferFailedAt: time,
        rawTransferResponse: result.rawTransferResponse || result.raw || {},
        updatedAt: time
      }
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: patch })
      await enqueueSubscription(tx, { openid: request.staffOpenid, templateKey: 'withdrawResult', page: 'pages/staff/earnings/index',
        messageData: buildSubscriptionData('withdrawResult', { orderNo: withdrawId, startTime: request.createdAt }, { amount: request.amount, statusText: '打款失败' }), orderId: '', deliveryKey: `withdraw:${withdrawId}:transfer_failed` })
      await financeLog(tx, `withdraw_transfer_failed_${withdrawId}_${Number(request.transferAttemptCount || 0)}`, 'withdraw_transfer_failed', 'withdraw_request', withdrawId, time, {
        staffOpenid: request.staffOpenid,
        detail: { outBillNo: request.outBillNo, error: patch.lastTransferError }
      })
      return { request: { ...request, ...patch }, changed: true }
    })
  }

  async function releaseFailedWithdrawal(admin, data = {}) {
    const probe = await db.collection('withdraw_requests').doc(data.id).get().catch(() => ({ data: null }))
    if (probe && probe.data && probe.data.assetType === 'user') return releaseUserAssetWithdrawal(admin, data)
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(data.id).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.payoutChannel !== 'wechat_wallet' || request.status !== 'transfer_failed') throw new Error('仅微信提现失败单可释放收益')
      const earningIds = ids(request.earningIds, true)
      const earnings = []
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || earning.staffOpenid !== request.staffOpenid || earning.withdrawRequestId !== data.id || earning.status !== 'withdrawing') throw new Error('收益状态或提现归属异常，请核对后重试')
        earnings.push(earning)
      }
      const time = now()
      const remark = safeText(data.remark || data.auditRemark).trim()
      await releaseWechatTransferQuota(tx, { _id: data.id, ...request }, 'released')
      await tx.collection('withdraw_requests').doc(data.id).update({ data: {
        status: 'rejected', transferStatus: 'released', releasedAt: time, releasedByOpenid: admin.openid,
        auditRemark: remark || request.auditRemark || '微信提现失败后释放收益', updatedAt: time
      } })
      for (const earning of earnings) {
        await tx.collection('staff_earnings').doc(earning._id).update({ data: { status: releasedStatus(earning, time), withdrawRequestId: '', updatedAt: time } })
      }
      await financeLog(tx, `withdraw_release_${data.id}`, 'withdraw_released', 'withdraw_request', data.id, time, {
        staffOpenid: request.staffOpenid,
        detail: { earningIds, remark }
      })
      return { request: { ...request, status: 'rejected', transferStatus: 'released' }, changed: true }
    })
  }

  async function freezeIncidentEarnings(incidentId, actorOpenid) {
    return db.runTransaction(async tx => {
      const incident = (await tx.collection('order_incidents').doc(incidentId).get()).data
      if (!incident) throw new Error('纠纷不存在')
      if (['closed', 'resolved', 'rejected'].includes(incident.status)) throw new Error('已结案纠纷不可新增冻结')
      if (['release', 'deduct'].includes(incident.earningResolution?.decision)) throw new Error('收益已处理，请新建纠纷后再操作')
      const order = await optionalOrder(tx, incident.orderId)
      if (order?.frozenEarningIncidentId && order.frozenEarningIncidentId !== incidentId) throw new Error('订单收益已被其他纠纷冻结')
      if (order && order.staffOpenid !== incident.staffOpenid) throw new Error('收益归属异常')
      // Candidate discovery is bounded; point reads inside the transaction revalidate ownership.
      const rows = (await db.collection('staff_earnings').where({ orderId: incident.orderId }).orderBy('_id', 'asc').limit(51).get()).data || []
      const earningIds = ids([...new Set([...(incident.frozenEarningIds || []), ...rows.map(row => row._id)])])
      const earnings = []
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || !incident.staffOpenid || earning.orderId !== incident.orderId || earning.staffOpenid !== incident.staffOpenid) throw new Error('收益归属异常')
        if (earning.withdrawRequestId || ['withdrawing', 'withdrawn'].includes(earning.status)) throw new Error('收益正在提现或已打款，请先核对提现单，不能直接冻结')
        if (earning.status === 'frozen' && earning.frozenIncidentId === incidentId) continue
        if (!['pending', 'available'].includes(earning.status) || earning.frozenIncidentId) throw new Error('收益已被其他纠纷冻结或不可冻结')
        earnings.push(earning)
      }
      if (!earnings.length && (!order || order.frozenEarningIncidentId === incidentId)) return { id: incidentId, frozenEarningIds: earningIds }
      const time = now()
      if (order) await tx.collection('orders').doc(order._id).update({ data: {
        frozenEarningIncidentId: incidentId, earningRevision: Number(order.earningRevision || 0) + 1
      } })
      const revision = Number(incident.earningRevision || 0) + 1
      for (const earning of earnings) {
        await tx.collection('staff_earnings').doc(earning._id).update({ data: {
          status: 'frozen', frozenIncidentId: incidentId, frozenFromStatus: earning.status, updatedAt: time
        } })
      }
      await tx.collection('order_incidents').doc(incidentId).update({ data: { frozenEarningIds: earningIds, earningRevision: revision, updatedAt: time } })
      await financeLog(tx, `freeze_${incidentId}_${revision}`, 'staff_earning_frozen', 'incident', incidentId, time, { orderId: incident.orderId, detail: { earningIds } })
      await tx.collection('incident_actions').doc(`freeze_${incidentId}_${revision}`).set({ data: {
        incidentId, action: 'earning_frozen', actorRole: 'admin', actorOpenid, detail: { earningIds }, createdAt: time
      } })
      return { id: incidentId, frozenEarningIds: earningIds }
    })
  }

  async function closeIncidentFinancially(incidentId, data, actorOpenid) {
    const decision = safeText(data.earningDecision).trim()
    if (decision && !['release', 'deduct', 'keep_frozen'].includes(decision)) throw new Error('收益处理方式不正确')
    const requested = decision === 'deduct' ? cents(data.deductAmount === undefined ? 0 : data.deductAmount) : 0
    return db.runTransaction(async tx => {
      const incident = (await tx.collection('order_incidents').doc(incidentId).get()).data
      if (!incident) throw new Error('纠纷不存在')
      const previous = incident.earningResolution
      if (previous && ['release', 'deduct'].includes(previous.decision)) {
        if (decision !== previous.decision || (decision === 'deduct' && requested !== incident.requestedDeductCents)) throw new Error('收益已处理，不能重复变更')
        return { id: incidentId, status: incident.status, earningResolution: previous }
      }
      if (incident.closedAt && decision === (previous?.decision || '') && incident.status === data.status &&
          incident.closeRemark === safeText(data.closeRemark).trim()) {
        return { id: incidentId, status: incident.status, earningResolution: previous || null }
      }
      const earningIds = ids(incident.frozenEarningIds || [])
      const order = await optionalOrder(tx, incident.orderId)
      const earnings = []
      let total = 0
      for (const id of earningIds) {
        const earning = (await tx.collection('staff_earnings').doc(id).get()).data
        if (!earning || !incident.staffOpenid || earning.orderId !== incident.orderId || earning.staffOpenid !== incident.staffOpenid ||
            earning.status !== 'frozen' || earning.frozenIncidentId !== incidentId || earning.withdrawRequestId) throw new Error('冻结收益归属或状态异常，请核对后重试')
        total += cents(earning.amount)
        earnings.push(earning)
      }
      if (!Number.isSafeInteger(total)) throw new Error('金额不正确')
      if (decision === 'deduct' && !earningIds.length) throw new Error('没有可扣减的冻结收益')
      if (decision === 'deduct' && requested > total) throw new Error('扣减金额不能超过冻结收益')
      const deduction = decision === 'deduct' ? (requested || total) : 0
      let remaining = deduction
      const time = now()
      const remark = safeText(data.earningRemark || data.closeRemark).trim()
      for (const earning of earnings) {
        if (!decision || decision === 'keep_frozen') continue
        const amount = cents(earning.amount)
        const taken = Math.min(amount, remaining)
        remaining -= taken
        const patch = { status: releasedStatus(earning, time), frozenIncidentId: '', frozenFromStatus: '', frozenResolvedAt: time, frozenResolveRemark: remark, updatedAt: time }
        if (decision === 'deduct') {
          const accumulated = cents(earning.deductedAmount || 0) + taken
          if (!Number.isSafeInteger(accumulated)) throw new Error('金额不正确')
          Object.assign(patch, { amount: (amount - taken) / 100, deductedAmount: accumulated / 100, status: amount > taken ? patch.status : 'deducted' })
        }
        await tx.collection('staff_earnings').doc(earning._id).update({ data: patch })
      }
      const resolution = decision ? { decision, earningIds, deductedAmount: deduction / 100 } : null
      const revision = Number(incident.earningRevision || 0) + 1
      const patch = { status: data.status, closeRemark: safeText(data.closeRemark).trim(), closedAt: time, updatedAt: time, earningRevision: revision }
      if (order?.frozenEarningIncidentId === incidentId && ['release', 'deduct'].includes(decision)) {
        await tx.collection('orders').doc(order._id).update({ data: { frozenEarningIncidentId: '', earningRevision: Number(order.earningRevision || 0) + 1 } })
      }
      if (resolution) Object.assign(patch, { earningResolution: resolution, requestedDeductCents: requested })
      await tx.collection('order_incidents').doc(incidentId).update({ data: patch })
      if (resolution) await financeLog(tx, `resolve_${incidentId}_${revision}`, `staff_earning_${decision}`, 'incident', incidentId, time, { orderId: incident.orderId, amountDelta: -deduction / 100, detail: { ...resolution, remark } })
      if (resolution) await tx.collection('incident_actions').doc(`resolve_${incidentId}_${revision}`).set({ data: {
        incidentId, action: `earning_${decision}`, actorRole: 'admin', actorOpenid, detail: resolution, createdAt: time
      } })
      await tx.collection('incident_actions').doc(`close_${incidentId}_${revision}`).set({ data: {
        incidentId, action: 'closed', actorRole: 'admin', actorOpenid, detail: { ...patch }, createdAt: time
      } })
      await tx.collection('order_timeline').doc(`incident_${incidentId}_${revision}`).set({ data: {
        orderId: incident.orderId, type: 'incident_closed', title: '纠纷已结案', detail: patch.closeRemark || patch.status, actorRole: 'admin', createdAt: time
      } })
      return { id: incidentId, status: patch.status, earningResolution: resolution }
    })
  }

  return { settleWithdrawal, markWechatWithdrawalPaid, markWechatWithdrawalFailed, releaseFailedWithdrawal, freezeIncidentEarnings, closeIncidentFinancially }
}
