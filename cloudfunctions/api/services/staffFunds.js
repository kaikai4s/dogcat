module.exports = function createService(context) {
  const { db, crypto, now, safeText } = context
  const key = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  function money(value, positive = false) {
    const number = Number(value)
    const cents = Math.round(number * 100)
    if (value == null || value === '' || !Number.isFinite(number) || !Number.isSafeInteger(cents) ||
        number < 0 || (positive && cents <= 0) || Math.abs(number * 100 - cents) > 1e-7) throw new Error('金额不正确，最多两位小数')
    return cents
  }
  async function optional(tx, collection, id) {
    if (!id) return null
    try { return (await tx.collection(collection).doc(id).get()).data || null } catch (error) {
      return null
    }
  }
  async function profileFor(tx, record) {
    if (!record.staffOpenid) throw new Error('财务记录缺少宠托师归属')
    const candidates = record.staffProfileId ? [{ _id: record.staffProfileId }]
      : (await db.collection('staff_profiles').where({ openid: record.staffOpenid }).limit(2).get()).data
    if (candidates.length !== 1) throw new Error('宠托师资料缺失或重复，请核对')
    const profile = (await tx.collection('staff_profiles').doc(candidates[0]._id).get().catch(() => ({ data: null }))).data
    if (!profile || profile.openid !== record.staffOpenid) throw new Error('宠托师资料归属不匹配')
    return profile
  }
  async function reserveStaffDepositPayment(user, snapshot, requestedAmount, channel, clientRequestId = '', supplyConsent = null) {
    money(requestedAmount, true)
    return db.runTransaction(async tx => {
      const profile = await profileFor(tx, { staffOpenid: user.openid, staffProfileId: snapshot._id })
      if (profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可缴纳保证金')
      const candidates = (await db.collection('staff_deposits').where({ staffOpenid: user.openid }).orderBy('createdAt', 'desc').limit(2).get()).data
      let deposit = profile.currentDepositId ? await optional(tx, 'staff_deposits', profile.currentDepositId) : null
      if (!deposit && candidates[0]) deposit = await optional(tx, 'staff_deposits', candidates[0]._id)
      if (deposit && deposit.staffOpenid !== user.openid) throw new Error('保证金归属不匹配')

      const isExitPending = ['requested', 'approved'].includes(profile.exitStatus) && deposit && ['refund_requested', 'refund_approved'].includes(deposit.status)
      if (isExitPending) throw new Error('保证金退还流程处理中，暂不可缴纳保证金')

      for (const candidate of candidates) {
        if (deposit && candidate._id === deposit._id) continue
        const other = await optional(tx, 'staff_deposits', candidate._id)
        if (other && other.status === 'unpaid') {
          if (!deposit) {
            deposit = other
          } else {
            await tx.collection('staff_deposits').doc(other._id).update({
              data: { status: 'superseded', statusText: '已失效', updatedAt: now() }
            })
          }
        }
      }
      const repeat = deposit && clientRequestId && deposit.clientRequestId === clientRequestId
      const isRefunded = profile.depositStatus === 'refunded' || deposit?.status === 'refunded'
      const needsRepay = profile.requireDepositRepay === true ||
        ['supplement_required', 'forfeited', 'refunded'].includes(profile.depositStatus) ||
        ['forfeited', 'refunded'].includes(deposit?.status) ||
        isRefunded ||
        (deposit && Number(deposit.availableRefundAmount || 0) <= 0 && Number(deposit.paidAmount || 0) > 0)

      if (deposit && deposit.status !== 'unpaid' && !(repeat && deposit.status === 'paid')) {
        if (!needsRepay || ['refund_requested', 'refund_approved'].includes(deposit.status)) throw new Error('您已足额缴纳保证金或记录正在处理中，无需重复缴纳')
        deposit = null
      }
      const time = now()
      const revision = Number(profile.depositPaymentRevision || 0) + 1
      if (!deposit) {
        deposit = { _id: key('deposit', user.openid, revision), staffOpenid: user.openid, staffUserId: user._id,
          staffProfileId: profile._id, amount: money(requestedAmount, true) / 100, paidAmount: 0, refundedAmount: 0,
          forfeitedAmount: 0, availableRefundAmount: 0, status: 'unpaid', statusText: '待支付', refundStatus: '',
          clientRequestId, createdAt: time, updatedAt: time }
        if (supplyConsent) Object.assign(deposit, { supplyAddress: supplyConsent.address, supplyFeeAmount: supplyConsent.feeAmount,
          supplyReimbursementTerms: supplyConsent.reimbursementTerms, supplyPolicyAcceptedAt: time, supplyPolicyVersion: 1 })
        const { _id, ...value } = deposit
        await tx.collection('staff_deposits').doc(_id).set({ data: value })
      } else if (deposit.status === 'unpaid' && money(deposit.amount, true) !== money(requestedAmount, true)) {
        const newAmount = money(requestedAmount, true) / 100
        await tx.collection('staff_deposits').doc(deposit._id).update({ data: { amount: newAmount, updatedAt: time } })
        deposit.amount = newAmount
      }
      if (deposit.status === 'unpaid' && supplyConsent && !deposit.supplyShipment) {
        await tx.collection('staff_deposits').doc(deposit._id).update({ data: {
          supplyAddress: supplyConsent.address, supplyFeeAmount: supplyConsent.feeAmount,
          supplyReimbursementTerms: supplyConsent.reimbursementTerms,
          supplyPolicyAcceptedAt: time, supplyPolicyVersion: 1, updatedAt: time
        } })
      }
      const payments = (await db.collection('payments').where({ orderId: deposit._id, targetType: 'staff_deposit' }).limit(2).get()).data
      if (payments.length > 1) {
        for (let i = 1; i < payments.length; i++) {
          await tx.collection('payments').doc(payments[i]._id).update({ data: { status: 'superseded', updatedAt: time } })
        }
      }
      let payment = payments[0] ? await optional(tx, 'payments', payments[0]._id) : null
      if (payment && payment.status === 'pending' && (payment.channel !== channel || money(payment.amount, true) !== money(deposit.amount, true))) {
        payment.channel = channel
        payment.amount = deposit.amount
        payment.prepayId = ''
        await tx.collection('payments').doc(payment._id).update({
          data: { channel, amount: deposit.amount, prepayId: '', updatedAt: time }
        })
      } else if (payment && !['pending', 'success'].includes(payment.status)) {
        payment = null
      }
      if (!payment) {
        payment = { _id: key('deposit_payment', deposit._id), orderId: deposit._id, depositId: deposit._id,
          targetType: 'staff_deposit', openid: user.openid, paymentNo: `P${crypto.randomBytes(15).toString('hex')}`,
          prepayId: '', wxTransactionId: '', amount: deposit.amount, currency: 'CNY', status: 'pending', channel,
          clientRequestId, createdAt: time, updatedAt: time }
        const { _id, ...value } = payment
        await tx.collection('payments').doc(_id).set({ data: value })
      }
      await tx.collection('staff_profiles').doc(profile._id).update({ data: {
        currentDepositId: deposit._id, depositPaymentRevision: revision, updatedAt: time
      } })
      return { deposit, payment }
    })
  }
  async function exitCheck(openid) {
    const orders = await db.collection('orders').where({ staffOpenid: openid,
      status: db.command.in(['paid', 'assigned', 'on_the_way', 'in_service', 'day_completed', 'pending_staff_confirm', 'service_suspended', 'refund_pending']) }).limit(1).get()
    if (orders.data.length) throw new Error('尚有未完成订单，暂不可退出退款')
    const incidents = await db.collection('order_incidents').where({ staffOpenid: openid,
      status: db.command.in(['open', 'investigating', 'triaging', 'waiting_client', 'waiting_staff', 'processing', 'refund_pending']) }).limit(1).get()
    if (incidents.data.length) throw new Error('存在尚未结案的客诉或纠纷，暂不可退出退款')
  }
  function balances(deposit) {
    const paid = money(deposit.paidAmount)
    const refunded = money(deposit.refundedAmount)
    const forfeited = money(deposit.forfeitedAmount)
    const supplyFee = money(deposit.supplyFeeDeductedAmount == null ? 0 : deposit.supplyFeeDeductedAmount)
    const available = money(deposit.availableRefundAmount)
    if (!Number.isSafeInteger(refunded + forfeited + supplyFee + available) || paid !== refunded + forfeited + supplyFee + available) throw new Error('保证金余额不一致，请先对账')
    return { paid, refunded, forfeited, supplyFee, available }
  }
  async function confirmStaffSupplyPolicy(openid, address, feeAmount, reimbursementTerms) {
    return db.runTransaction(async tx => {
      const candidates = (await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(2).get()).data
      const deposit = candidates.find(row => row.status === 'paid' || row.status === 'partially_refunded')
      if (!deposit) throw new Error('请先完成保证金支付')
      const current = await optional(tx, 'staff_deposits', deposit._id)
      if (current.supplyShipment) throw new Error('用品已经发货，收货地址不可修改')
      if (['requested', 'approved', 'processing'].includes(current.refundStatus)) throw new Error('退出退款处理中，不可修改用品地址')
      const fee = current.supplyPolicyAcceptedAt ? money(current.supplyFeeAmount, true) : money(feeAmount, true)
      if (fee >= balances(current).available) throw new Error('用品费用不能达到或超过当前可退押金')
      const time = now()
      await tx.collection('staff_deposits').doc(current._id).update({ data: {
        supplyAddress: address, supplyFeeAmount: fee / 100,
        supplyReimbursementTerms: current.supplyReimbursementTerms || reimbursementTerms,
        supplyPolicyAcceptedAt: current.supplyPolicyAcceptedAt || time,
        supplyPolicyVersion: 1, updatedAt: time
      } })
      return { depositId: current._id, acceptedAt: current.supplyPolicyAcceptedAt || time }
    })
  }
  async function shipStaffSupplies(admin, depositId, expressCompany, trackingNo) {
    return db.runTransaction(async tx => {
      const deposit = await optional(tx, 'staff_deposits', depositId)
      if (!deposit) throw new Error('保证金记录不存在')
      if (deposit.supplyShipment) {
        if (deposit.supplyShipment.expressCompany === expressCompany && deposit.supplyShipment.trackingNo === trackingNo) return deposit.supplyShipment
        throw new Error('用品已发货，不可重复发货')
      }
      if (deposit.status !== 'paid' || !deposit.supplyPolicyAcceptedAt || !deposit.supplyAddress) throw new Error('须先完成押金支付及用品规则确认')
      const profile = await profileFor(tx, deposit)
      if (profile.supplyShipmentDepositId) throw new Error('该宠托师已发过首次用品')
      const existingApps = (await db.collection('staff_supply_reimbursements').where({ staffOpenid: deposit.staffOpenid }).limit(1).get()).data
      if (existingApps.length) throw new Error('已有首次用品报销记录，请先处理历史记录，避免重复发放')
      if (money(deposit.supplyFeeAmount, true) >= balances(deposit).available) throw new Error('用品费用不能达到或超过可退押金')
      const time = now()
      const shipment = { expressCompany, trackingNo, shippedAt: time, shippedBy: admin.openid }
      await tx.collection('staff_deposits').doc(depositId).update({ data: { supplyShipment: shipment, updatedAt: time } })
      await tx.collection('staff_profiles').doc(profile._id).update({ data: { supplyShipmentDepositId: depositId, updatedAt: time } })
      await log(tx, key('supply_shipped', depositId), admin, 'shipStaffSupplies', 'staff_deposit', depositId, deposit,
        { expressCompany, trackingNo, supplyFeeAmount: deposit.supplyFeeAmount }, time)
      return shipment
    })
  }
  async function log(tx, id, admin, action, targetType, targetId, record, detail, time, delta = null) {
    await tx.collection('admin_operation_logs').doc(id).set({ data: {
      adminUserId: admin._id, adminOpenid: admin.openid, action, targetType, targetId, detail, createdAt: time
    } })
    if (delta !== null) await tx.collection('finance_logs').doc(id).set({ data: {
      action: detail.financeAction || action, targetType, targetId, staffOpenid: record.staffOpenid,
      amountDelta: delta, detail, createdAt: time
    } })
  }
  async function depositEvent(tx, id, deposit, actor, type, amount, reason, time, extra = {}) {
    await tx.collection('staff_deposit_events').doc(id).set({ data: {
      depositId: deposit._id, staffOpenid: deposit.staffOpenid, staffUserId: deposit.staffUserId || '',
      operatorOpenid: actor, operatorRole: type === 'refund_request' ? 'staff' : 'admin', type, amount, reason, createdAt: time, ...extra
    } })
  }
  async function requestStaffDepositRefund(openid, depositId, reason, admin = null) {
    return db.runTransaction(async tx => {
      const deposit = (await tx.collection('staff_deposits').doc(depositId).get().catch(() => ({ data: null }))).data
      if (!deposit || deposit.staffOpenid !== openid) throw new Error('保证金归属不匹配')
      if (deposit.refundStatus === 'requested') return { success: true, status: deposit.status }
      if (!['paid', 'partially_refunded'].includes(deposit.status) || !balances(deposit).available) throw new Error('暂无可退还保证金')
      const profile = await profileFor(tx, deposit)
      const staffUserId = deposit.staffUserId || (profile && profile.userId)
      let user = null
      if (staffUserId) {
        user = (await tx.collection('users').doc(staffUserId).get().catch(() => ({ data: null }))).data
      }
      if (!user && (deposit.staffOpenid || openid)) {
        const userRes = await tx.collection('users').where({ openid: deposit.staffOpenid || openid }).limit(1).get().catch(() => ({ data: [] }))
        user = userRes.data && userRes.data[0]
      }
      if (!user || user.openid !== openid) throw new Error('用户归属不匹配')
      await exitCheck(openid)
      const time = now()
      const revision = Number(deposit.refundRevision || 0) + 1
      await tx.collection('users').doc(user._id).update({ data: { staffAssignmentRevision: crypto.randomBytes(16).toString('hex') } })
      await tx.collection('staff_deposits').doc(depositId).update({ data: {
        status: 'refund_requested', statusText: '退款审核中', refundStatus: 'requested', refundReason: reason,
        refundRevision: revision, refundRequestedAt: time, updatedAt: time
      } })
      await tx.collection('staff_profiles').doc(profile._id).update({ data: { exitStatus: 'requested', depositStatus: 'refund_requested', updatedAt: time } })
      await depositEvent(tx, key(depositId, 'request', revision), deposit, admin ? admin.openid : openid, 'refund_request', deposit.availableRefundAmount, reason, time, admin ? { operatorRole: 'admin' } : {})
      if (admin) await tx.collection('admin_operation_logs').doc(key(depositId, 'admin_request', revision)).set({ data: {
        adminUserId: admin._id, adminOpenid: admin.openid, action: 'requestStaffDepositRefund', targetType: 'staff_deposit', targetId: depositId,
        detail: { staffOpenid: openid, amount: deposit.availableRefundAmount, reason }, createdAt: time
      } })
      return { success: true, status: 'refund_requested' }
    })
  }
  async function settleStaffDeposit(admin, action, data) {
    const reason = safeText(data.reason || data.auditRemark).trim()
    const requestId = safeText(data.clientRequestId).trim()
    const proof = safeText(data.paymentReference).trim()
    if (action === 'forfeitStaffDeposit' && (!requestId || !reason)) throw new Error('请提供操作请求号和没收原因')
    if (action === 'confirmDepositRefund' && (!proof || data.paymentConfirmed !== true)) throw new Error('请确认实际退款完成并提供付款凭证号')
    return db.runTransaction(async tx => {
      let deposit = null
      let depositId = safeText(data.id).trim()
      if (depositId) {
        deposit = (await tx.collection('staff_deposits').doc(depositId).get().catch(() => ({ data: null }))).data
      }
      if (!deposit && data.staffOpenid) {
        const dRes = await db.collection('staff_deposits').where({ staffOpenid: data.staffOpenid }).orderBy('createdAt', 'desc').limit(1).get()
        if (dRes && dRes.data && dRes.data.length > 0) {
          deposit = (await tx.collection('staff_deposits').doc(dRes.data[0]._id).get().catch(() => ({ data: null }))).data
          depositId = deposit && deposit._id
        }
      }
      if (!deposit) throw new Error('保证金记录不存在')
      const targetDepositId = depositId || deposit._id || data.id
      const eventId = key(targetDepositId, action, action === 'forfeitStaffDeposit' ? requestId : deposit.refundRevision || 0)
      const previous = await optional(tx, 'staff_deposit_events', eventId)
      if (previous?.result) {
        if (previous.request !== JSON.stringify([action, data.approved === true, data.amount ?? null, reason, proof])) throw new Error('重复请求参数不一致')
        return previous.result
      }
      const balance = balances(deposit)
      const profile = await profileFor(tx, deposit)
      const time = now()
      let patch, profilePatch = {}, amount = 0, financeAction = '', delta = null
      const evidenceImages = (action === 'forfeitStaffDeposit' && Array.isArray(data.evidenceImages))
        ? data.evidenceImages.filter((img) => typeof img === 'string' && img.trim())
        : []
      if (action === 'forfeitStaffDeposit') {
        if (!['paid', 'partially_refunded'].includes(deposit.status) || ['requested', 'approved', 'processing'].includes(deposit.refundStatus)) throw new Error('当前保证金状态不可没收，请先处理退款申请')
        amount = money(data.amount, true)
        if (amount > balance.available) throw new Error('没收金额不能大于当前可用保证金余额')
        if (deposit.supplyShipment && !deposit.supplyFeeSettledAt && amount + money(deposit.supplyFeeAmount, true) >= balance.available) throw new Error('请保留足够余额用于用品费用和退出退款结算')
        const available = (balance.available - amount) / 100
        patch = { forfeitedAmount: (balance.forfeited + amount) / 100, availableRefundAmount: available,
          status: available === 0 ? 'forfeited' : deposit.status, statusText: available === 0 ? '已全额没收' : `部分没收（余¥${available}）`,
          lastForfeitReason: reason, lastForfeitedAt: time, lastForfeitedBy: admin.openid, lastForfeitImages: evidenceImages }
        if (!available) {
          profilePatch.depositStatus = 'forfeited'
          profilePatch.requireDepositRepay = true
          profilePatch.requireDepositRepayReason = '履约保证金已被全额扣除，需重新足额缴纳后方可继续接单'
        }
        financeAction = 'deposit_forfeited'; delta = 0
      } else if (action === 'auditDepositRefund') {
        if (deposit.refundStatus !== 'requested' || deposit.status !== 'refund_requested') throw new Error('当前状态不可审核退款')
        if (data.approved === true) {
          await exitCheck(deposit.staffOpenid)
          if (!balance.available) throw new Error('暂无可退还保证金')
          let supplyFee = 0
          if (deposit.supplyShipment && deposit.supplyPolicyAcceptedAt && !deposit.supplyFeeSettledAt) {
            const apps = (await db.collection('staff_supply_reimbursements').where({ staffOpenid: deposit.staffOpenid }).limit(2).get()).data
            const app = apps.find(item => item.depositId === targetDepositId && item.benefitType === 'supply_fee_waiver')
            if (app && app.status === 'pending') throw new Error('首次用品费用减免正在审核，请先处理申请')
            supplyFee = app && app.status === 'approved' ? 0 : money(deposit.supplyFeeAmount, true)
            if (supplyFee >= balance.available) throw new Error('用品费用不低于可退押金，请人工对账后处理')
          }
          patch = { status: 'refund_approved', statusText: '审核通过，待实际退款', refundStatus: 'approved',
            supplyFeeSettledAt: deposit.supplyShipment && deposit.supplyPolicyAcceptedAt ? time : deposit.supplyFeeSettledAt || null,
            supplyFeeDeductedAmount: (balance.supplyFee + supplyFee) / 100,
            availableRefundAmount: (balance.available - supplyFee) / 100,
            approvedRefundAmount: (balance.available - supplyFee) / 100 }
          if (supplyFee) {
            const feeId = key('supply_fee', targetDepositId)
            await log(tx, feeId, admin, 'settleStaffSupplyFee', 'staff_deposit', targetDepositId, deposit,
              { supplyFeeAmount: supplyFee / 100, financeAction: 'staff_supply_fee' }, time, 0)
            await depositEvent(tx, feeId, deposit, admin.openid, 'supply_fee', supplyFee / 100, '首次用品费用', time)
          }
          profilePatch = { exitStatus: 'approved', depositStatus: 'refund_approved' }
        } else {
          if (!reason) throw new Error('请填写驳回原因')
          patch = { status: balance.refunded ? 'partially_refunded' : 'paid', statusText: '退款已驳回', refundStatus: 'rejected', refundRejectReason: reason }
          profilePatch = { exitStatus: 'none', depositStatus: 'paid' }
        }
        Object.assign(patch, { refundAuditedAt: time, refundAuditedBy: admin.openid, refundAuditRemark: reason })
      } else if (action === 'confirmDepositRefund') {
        if (deposit.status !== 'refund_approved' || deposit.refundStatus !== 'approved') throw new Error('仅已审核退款可确认付款')
        await exitCheck(deposit.staffOpenid)
        const { documentPages } = require('../utils/documentPages')
        for await (const rows of documentPages(tx, db.command, 'staff_earnings', { staffOpenid: deposit.staffOpenid })) {
          if (rows.some(row => ['pending', 'available', 'withdrawing', 'frozen'].includes(row.status) && row.isMock !== true && row.paymentChannel !== 'mock' && money(row.amount) > 0)) throw new Error('尚有未结清收益，请先完成收益结算和转账，再确认退出退款')
        }
        for await (const rows of documentPages(tx, db.command, 'withdraw_requests', { staffOpenid: deposit.staffOpenid })) {
          if (rows.some(row => ['pending', 'approved', 'processing', 'transferring', 'transfer_failed'].includes(row.status))) throw new Error('尚有未完成提现，请先核对转账结果')
        }
        amount = money(deposit.approvedRefundAmount, true)
        if (amount !== balance.available) throw new Error('退款金额与余额不一致')
        patch = { status: 'refunded', statusText: '已人工确认退款', refundStatus: 'success', availableRefundAmount: 0,
          refundedAmount: (balance.refunded + amount) / 100, refundPaidAt: time, refundPaidBy: admin.openid, refundPaymentReference: proof, refundConfirmationSource: 'manual' }
        let otherDepositsPending = false
        for await (const rows of documentPages(tx, db.command, 'staff_deposits', { staffOpenid: deposit.staffOpenid })) {
          if (rows.some(row => row._id !== targetDepositId && (
            money(row.availableRefundAmount == null ? 0 : row.availableRefundAmount) > 0 ||
            ['unpaid', 'refund_requested', 'refund_approved'].includes(row.status) ||
            ['requested', 'approved', 'processing'].includes(row.refundStatus)
          ))) otherDepositsPending = true
        }
        // Record each real refund, but finish the exit only after every deposit
        // has been resolved. Repayment can leave refundable balances in older rows.
        profilePatch = otherDepositsPending
          ? { exitStatus: 'approved', depositStatus: 'refund_approved' }
          : { exitStatus: 'exited', depositStatus: 'refunded', auditStatus: 'revoked' }
        financeAction = 'deposit_refunded'; delta = -amount / 100
      } else throw new Error('未知保证金操作')
      const result = { id: targetDepositId, status: patch.status, refundStatus: patch.refundStatus || deposit.refundStatus,
        availableRefundAmount: patch.availableRefundAmount ?? deposit.availableRefundAmount,
        approvedRefundAmount: patch.approvedRefundAmount ?? deposit.approvedRefundAmount,
        supplyFeeDeductedAmount: patch.supplyFeeDeductedAmount ?? deposit.supplyFeeDeductedAmount ?? 0,
        ...(action === 'confirmDepositRefund' ? { exitCompleted: profilePatch.exitStatus === 'exited' } : {}) }
      await tx.collection('staff_deposits').doc(targetDepositId).update({ data: { ...patch, updatedAt: time } })
      await tx.collection('staff_profiles').doc(profile._id).update({ data: { ...profilePatch, updatedAt: time } })
      if (action === 'confirmDepositRefund' && result.exitCompleted) {
        const staffUserId = deposit.staffUserId || (profile && profile.userId)
        let staffUser = null
        if (staffUserId) {
          staffUser = (await tx.collection('users').doc(staffUserId).get().catch(() => ({ data: null }))).data
        }
        if (!staffUser && deposit.staffOpenid) {
          const userRes = await tx.collection('users').where({ openid: deposit.staffOpenid }).limit(1).get().catch(() => ({ data: [] }))
          staffUser = userRes.data && userRes.data[0]
        }
        if (staffUser) {
          const roles = (Array.isArray(staffUser.roles) ? staffUser.roles : ['client']).filter((r) => r !== 'staff')
          const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
          if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
          await tx.collection('users').doc(staffUser._id).update({ data: userUpdate })
        }
      }
      if (action === 'forfeitStaffDeposit') {
        const evidencesToUpdate = []
        if (Array.isArray(data.selectedEvidences) && data.selectedEvidences.length > 0) {
          for (const item of data.selectedEvidences) {
            const evId = typeof item === 'string' ? item : (item.evidenceId || item.id || item._id)
            const evActual = typeof item === 'object' && item.actualDeductAmount !== undefined ? Number(item.actualDeductAmount) : undefined
            if (evId) evidencesToUpdate.push({ id: evId, actualDeductAmount: evActual })
          }
        } else if (Array.isArray(data.evidenceIds) && data.evidenceIds.length > 0) {
          for (const evId of data.evidenceIds) {
            if (evId) evidencesToUpdate.push({ id: evId })
          }
        } else if (data.evidenceId) {
          evidencesToUpdate.push({ id: data.evidenceId, actualDeductAmount: data.actualDeductAmount })
        }

        for (const item of evidencesToUpdate) {
          try {
            const evDoc = (await tx.collection('staff_deposit_evidences').doc(item.id).get().catch(() => null))?.data
            const evActualDeduct = item.actualDeductAmount !== undefined
              ? Number(item.actualDeductAmount)
              : (evDoc && evDoc.deductAmount !== undefined ? Number(evDoc.deductAmount) : (amount / 100))

            await tx.collection('staff_deposit_evidences').doc(item.id).update({
              data: {
                status: 'forfeited',
                actualDeductAmount: evActualDeduct,
                forfeitedAmount: evActualDeduct,
                forfeitedAt: time,
                forfeitedBy: admin.openid,
                forfeitDepositId: targetDepositId,
                forfeitEventId: eventId,
                forfeitProofImages: evidenceImages,
                updatedAt: time
              }
            })
          } catch (err) {
            // Non-blocking if evidence record missing
          }
        }
      }
      const eventType = action === 'forfeitStaffDeposit' ? 'forfeit' : action === 'confirmDepositRefund' ? 'refund' : 'refund_audit'
      await depositEvent(tx, eventId, deposit, admin.openid, eventType, amount / 100, reason, time, {
        result, request: JSON.stringify([action, data.approved === true, data.amount ?? null, reason, proof]),
        evidenceImages: action === 'forfeitStaffDeposit' ? evidenceImages : []
      })
      await log(tx, eventId, admin, action, 'staff_deposit', targetDepositId, deposit, { amount: amount / 100, reason, proof, financeAction, evidenceImages }, time, delta)
      return result
    })
  }
  async function settleSupplyReimbursement(admin, action, data) {
    const proof = safeText(data.paymentReference).trim()
    if (action === 'paySupplyReimbursement' && (!proof || data.paymentConfirmed !== true)) throw new Error('请确认实际打款完成并提供付款凭证号')
    return db.runTransaction(async tx => {
      const app = (await tx.collection('staff_supply_reimbursements').doc(data.id).get().catch(() => ({ data: null }))).data
      if (!app) throw new Error('报销申请不存在')
      const paying = action === 'paySupplyReimbursement'
      if (paying && app.benefitType === 'supply_fee_waiver') throw new Error('用品费用减免不单独打款，请在退押金时结算')
      const target = paying ? 'paid' : data.approved === true ? 'approved' : 'rejected'
      if (!paying && target === 'approved' && app.amountSource === 'config' && data.approvedAmount !== undefined && money(data.approvedAmount, true) !== money(app.amount, true)) {
        throw new Error('审批报销金额不能大于宠托师申请金额；报销金额由后台配置固定，管理员不能修改申请金额')
      }
      const amount = paying ? money(app.approvedAmount, true) : target === 'approved' ? money(app.amountSource === 'config' ? app.amount : (data.approvedAmount ?? app.amount), true) : 0
      if (amount > money(app.amount, true)) throw new Error('审批报销金额不能大于宠托师申请金额')
      if (app.status === target) {
        if ((paying && app.paymentReference !== proof) || (target === 'approved' && money(app.approvedAmount) !== amount)) throw new Error('重复操作参数不一致')
        return { id: data.id, status: target, approvedAmount: app.approvedAmount }
      }
      if (app.status !== (paying ? 'approved' : 'pending')) throw new Error('当前报销状态不可操作')
      const profile = await profileFor(tx, app)
      const reason = safeText(data.rejectReason || data.reason || data.auditRemark).trim()
      if (target === 'rejected' && !reason) throw new Error('请填写驳回原因')
      const time = now()
      const patch = paying ? { status: target, statusText: '已人工确认打款', transferStatus: 'MANUAL_CONFIRMED', paymentReference: proof,
        paymentConfirmationSource: 'manual', paidAmount: amount / 100, paidAt: time, paidBy: admin.openid }
        : { status: target, statusText: target === 'approved' ? (app.benefitType === 'supply_fee_waiver' ? '用品费用减免已通过' : '审核通过，等待打款') : '审核驳回', approvedAmount: target === 'approved' ? amount / 100 : null,
          auditRemark: reason, rejectReason: target === 'rejected' ? reason : '', auditedAt: time, auditedBy: admin.openid }
      await tx.collection('staff_supply_reimbursements').doc(data.id).update({ data: { ...patch, updatedAt: time } })
      await tx.collection('staff_profiles').doc(profile._id).update({ data: { supplyReimbursementStatus: target, updatedAt: time } })
      await log(tx, key('supply', data.id, target), admin, action, 'staff_supply_reimbursement', data.id, app,
        { approvedAmount: amount / 100, reason, proof, financeAction: 'supply_reimbursement_paid' }, time, paying ? -amount / 100 : null)
      return { id: data.id, status: target, approvedAmount: patch.approvedAmount ?? app.approvedAmount }
    })
  }
  async function submitStaffSupplyOnce(record) {
    const id = key('first_supply', record.staffOpenid)
    return db.runTransaction(async tx => {
      const existing = await optional(tx, 'staff_supply_reimbursements', id)
      if (existing && record.clientRequestId && existing.clientRequestId === record.clientRequestId) return existing
      const profile = await profileFor(tx, record)
      if (profile.auditStatus !== 'approved' || profile.staffLevel !== 'certified' || ['requested', 'approved', 'exited'].includes(profile.exitStatus)) throw new Error('仅在职正式认证宠托师可申请报销')
      const history = await db.collection('staff_supply_reimbursements').where({ staffOpenid: record.staffOpenid }).limit(1).get()
      if (existing || profile.supplyApplicationId || history.data.length) throw new Error('每位宠托师仅限申请一次首次宠物用品报销')
      money(record.amount, true)
      await tx.collection('staff_supply_reimbursements').doc(id).set({ data: record })
      await tx.collection('staff_profiles').doc(profile._id).update({ data: { supplyApplicationId: id, supplyReimbursementStatus: 'pending', updatedAt: now() } })
      return { _id: id, ...record }
    })
  }
  async function recordStaffDepositPayment(depositId, payload) {
    return db.runTransaction(async tx => {
      const deposit = (await tx.collection('staff_deposits').doc(depositId).get().catch(() => ({ data: null }))).data
      if (!deposit) throw new Error('保证金记录不存在')
      // Late payment callbacks must never replenish refunded/forfeited balances.
      if (deposit.status !== 'unpaid') {
        if (money(deposit.paidAmount) > 0) return { depositId, status: 'paid', paymentNo: deposit.paymentNo || '' }
        throw new Error('保证金状态异常，请核对付款记录')
      }
      const amount = money(deposit.amount, true) / 100
      const profile = await profileFor(tx, deposit)
      const candidates = (await db.collection('payments').where({ orderId: depositId, targetType: 'staff_deposit' }).limit(2).get()).data
      if (candidates.length > 1) throw new Error('保证金支付记录重复，请核对')
      const payment = candidates[0] ? (await tx.collection('payments').doc(candidates[0]._id).get().catch(() => ({ data: null }))).data : null
      if (payment && (payment.orderId !== depositId || payment.paymentNo !== payload.paymentNo || money(payment.amount) !== money(amount))) throw new Error('保证金支付金额或单号不一致')
      if (payload.channel === 'wechat' && !payment) throw new Error('保证金支付记录缺失，请先对账')
      const time = now()
      const paymentNo = payload.paymentNo
      await tx.collection('staff_deposits').doc(depositId).update({ data: {
        paidAmount: amount, availableRefundAmount: amount, status: 'paid', statusText: '已缴纳',
        paymentNo, wxTransactionId: payload.wxTransactionId || '', paidAt: time, updatedAt: time
      } })
      if (!profile.currentDepositId || profile.currentDepositId === depositId) await tx.collection('staff_profiles').doc(profile._id).update({ data: {
        depositStatus: 'paid',
        depositRequired: true,
        exitStatus: 'none',
        requireDepositRepay: false,
        requireDepositRepayReason: '',
        requireDepositRepayAt: '',
        updatedAt: time
      } })
      const staffUserId = deposit.staffUserId || profile.userId
      if (staffUserId) {
        const staffUser = (await tx.collection('users').doc(staffUserId).get().catch(() => ({ data: null }))).data
        if (staffUser) {
          const roles = Array.isArray(staffUser.roles) ? [...staffUser.roles] : ['client']
          if (!roles.includes('staff')) {
            roles.push('staff')
            await tx.collection('users').doc(staffUser._id).update({ data: { roles, updatedAt: time } })
          }
        }
      }
      await depositEvent(tx, key(depositId, 'paid'), deposit, deposit.staffOpenid, 'pay', amount, '缴纳宠托师入驻保证金', time)
      await tx.collection('finance_logs').doc(key(depositId, 'paid')).set({ data: {
        action: 'deposit_paid', targetType: 'staff_deposit', targetId: depositId, staffOpenid: deposit.staffOpenid,
        amountDelta: amount, detail: { paymentNo, channel: payload.channel || 'mock' }, createdAt: time
      } })
      if (payment) await tx.collection('payments').doc(payment._id).update({ data: {
        status: 'success', channel: payload.channel || payment.channel || 'mock', wxTransactionId: payload.wxTransactionId || '',
        rawCallback: payload.rawCallback || {}, paidAt: time, updatedAt: time
      } })
      return { depositId, status: 'paid', paymentNo }
    })
  }

  async function autoRefundStaffDeposit(admin, depositId, reason = '宠托师保证金退还', options = {}) {
    if (!depositId) throw new Error('缺少保证金记录ID')

    const deposit = (await db.collection('staff_deposits').doc(depositId).get().catch(() => ({ data: null })))?.data
    if (!deposit) throw new Error('保证金记录不存在')
    if (deposit.supplyShipment && !deposit.supplyFeeSettledAt) throw new Error('请先审核退押金并结算首次用品费用，再进行自动退款')

    const balance = balances(deposit)
    if (!balance.available || balance.available <= 0) {
      throw new Error('当前保证金无可用退还余额')
    }

    await exitCheck(deposit.staffOpenid)

    const { documentPages } = require('../utils/documentPages')
    for await (const rows of documentPages(db, db.command, 'staff_earnings', { staffOpenid: deposit.staffOpenid })) {
      if (rows.some(row => ['pending', 'available', 'withdrawing', 'frozen'].includes(row.status) && row.isMock !== true && row.paymentChannel !== 'mock' && money(row.amount) > 0)) {
        throw new Error('尚有未结清收益，请先完成收益结算和转账，再退还保证金')
      }
    }
    for await (const rows of documentPages(db, db.command, 'withdraw_requests', { staffOpenid: deposit.staffOpenid })) {
      if (rows.some(row => ['pending', 'approved', 'processing', 'transferring', 'transfer_failed'].includes(row.status))) {
        throw new Error('尚有未完成提现，请先在财务管理核对转账结果')
      }
    }

    const payments = (await db.collection('payments').where({
      orderId: depositId,
      targetType: 'staff_deposit'
    }).orderBy('createdAt', 'desc').limit(5).get().catch(() => ({ data: [] })))?.data || []
    const payment = payments.find(p => p.status === 'success') || payments[0] || null

    let settings = {}
    try {
      if (typeof context.getSystemSettings === 'function') {
        settings = await context.getSystemSettings({ includeSecrets: true })
      }
    } catch (_) {}
    const paymentSettings = (settings && settings.payment) || { mode: 'mock' }

    const isMock = paymentSettings.mode === 'mock' || (payment && payment.channel === 'mock') || (!payment && paymentSettings.mode !== 'wechat')
    const refundAmount = balance.available / 100
    // 构造具备唯一幂等性的退款单号，若原记录已发起过退款尝试则复用，杜绝重试导致微信商户重复出款
    const deterministicRefundNo = `R${crypto.createHash('sha256').update(`staff_deposit_refund:${depositId}:${deposit.paidAt || deposit.createdAt || ''}`).digest('hex').slice(0, 24)}`
    const refundNo = deposit.lastRefundNo || deterministicRefundNo
    const time = now()

    let paymentReference = ''
    let confirmationSource = 'auto_mock'
    let refundChannel = isMock ? 'mock' : 'wechat'

    if (!isMock) {
      if (paymentSettings.refundEnabled === false) {
        throw new Error('微信退款功能尚未启用，请在系统设置中开启或使用人工打款确认')
      }
      if (!payment || (!payment.wxTransactionId && !payment.paymentNo)) {
        throw new Error('缺少原微信支付流水凭证，无法自动原路退款，请使用人工打款确认')
      }
      const getPayConfig = context.getWechatPayConfig
      const wechatRequest = context.wechatPayRequest
      if (typeof getPayConfig !== 'function' || typeof wechatRequest !== 'function') {
        throw new Error('缺少微信退款网络网关支持')
      }
      let payConfig
      try {
        payConfig = getPayConfig(settings)
      } catch (cfgErr) {
        throw new Error(`微信支付配置不完整：${cfgErr.message || cfgErr}`)
      }
      const refundBody = {
        out_refund_no: refundNo,
        reason: reason || '宠托师保证金退还',
        amount: {
          refund: balance.available,
          total: Math.round(Number(payment.amount || deposit.paidAmount || deposit.amount) * 100),
          currency: 'CNY'
        },
        ...(payment.wxTransactionId ? { transaction_id: payment.wxTransactionId } : { out_trade_no: payment.paymentNo })
      }
      let wxRes
      try {
        wxRes = await wechatRequest('POST', '/v3/refund/domestic/refunds', refundBody, payConfig)
      } catch (err) {
        const errMsg = String(err && (err.message || err.errMsg || err) || '').toLowerCase()
        const isDuplicateOrExists = /already|exist|duplicate|out_trade_no_used|trade_state_error|已退款|已存在|重复/.test(errMsg)
        let recovered = false
        if (isDuplicateOrExists) {
          try {
            const queryRes = await wechatRequest('GET', `/v3/refund/domestic/refunds/out-refund-no/${encodeURIComponent(refundNo)}`, null, payConfig)
            if (queryRes && (queryRes.status === 'SUCCESS' || queryRes.status === 'PROCESSING' || queryRes.refund_id)) {
              wxRes = queryRes
              recovered = true
            }
          } catch (_) {}
        }
        if (!recovered) {
          throw new Error(`微信原路退款发起失败：${err.message || err}`)
        }
      }
      if (wxRes?.status !== 'SUCCESS') throw new Error('微信原路退款尚未成功，请稍后按同一退款单号重新核实，勿人工重复退款')
      paymentReference = (wxRes && (wxRes.refund_id || wxRes.out_refund_no)) || refundNo
      confirmationSource = 'auto_wechat'
    } else {
      paymentReference = `MOCK_${refundNo}`
      confirmationSource = 'auto_mock'
    }

    return db.runTransaction(async tx => {
      const curDeposit = (await tx.collection('staff_deposits').doc(depositId).get().catch(() => ({ data: null }))).data
      if (!curDeposit) throw new Error('保证金记录不存在')
      const curBalance = balances(curDeposit)
      if (curBalance.available !== balance.available) throw new Error('保证金余额已发生变动，请重新确认')

      const profile = await profileFor(tx, curDeposit)
      const patch = {
        status: 'refunded',
        statusText: isMock ? '已退还(模拟原路退还)' : '已微信原路退款',
        refundStatus: 'success',
        availableRefundAmount: 0,
        refundedAmount: (curBalance.refunded + curBalance.available) / 100,
        refundPaidAt: time,
        refundPaidBy: admin.openid,
        refundPaymentReference: paymentReference,
        refundConfirmationSource: confirmationSource,
        lastRefundReason: reason,
        lastRefundNo: refundNo,
        updatedAt: time
      }

      let otherDepositsPending = false
      for await (const rows of documentPages(tx, db.command, 'staff_deposits', { staffOpenid: curDeposit.staffOpenid })) {
        if (rows.some(row => row._id !== depositId && (
          money(row.availableRefundAmount == null ? 0 : row.availableRefundAmount) > 0 ||
          ['unpaid', 'refund_requested', 'refund_approved'].includes(row.status) ||
          ['requested', 'approved', 'processing'].includes(row.refundStatus)
        ))) otherDepositsPending = true
      }

      const profilePatch = otherDepositsPending
        ? { exitStatus: 'approved', depositStatus: 'refund_approved', updatedAt: time }
        : { exitStatus: 'exited', depositStatus: 'refunded', auditStatus: 'revoked', updatedAt: time }

      await tx.collection('staff_deposits').doc(depositId).update({ data: patch })
      await tx.collection('staff_profiles').doc(profile._id).update({ data: profilePatch })

      if (!otherDepositsPending) {
        const staffUserId = curDeposit.staffUserId || (profile && profile.userId)
        let staffUser = null
        if (staffUserId) {
          staffUser = (await tx.collection('users').doc(staffUserId).get().catch(() => ({ data: null }))).data
        }
        if (!staffUser && curDeposit.staffOpenid) {
          const userRes = await tx.collection('users').where({ openid: curDeposit.staffOpenid }).limit(1).get().catch(() => ({ data: [] }))
          staffUser = userRes.data && userRes.data[0]
        }
        if (staffUser) {
          const roles = (Array.isArray(staffUser.roles) ? staffUser.roles : ['client']).filter((r) => r !== 'staff')
          const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
          if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
          await tx.collection('users').doc(staffUser._id).update({ data: userUpdate })
        }
      }

      const refundId = `refund_${crypto.createHash('sha256').update(`staff_deposit:${depositId}:${refundNo}`).digest('hex').slice(0, 32)}`
      await tx.collection('refunds').doc(refundId).set({
        data: {
          orderId: depositId,
          orderNo: curDeposit.paymentNo || depositId,
          collectionName: 'staff_deposits',
          targetType: 'staff_deposit',
          paymentNo: payment ? (payment.paymentNo || '') : '',
          wxTransactionId: payment ? (payment.wxTransactionId || '') : '',
          refundNo,
          wxRefundId: paymentReference,
          openid: curDeposit.staffOpenid,
          amount: curDeposit.paidAmount || curDeposit.amount,
          refundAmount,
          reason,
          source: 'staff_deposit_auto_refund',
          operatorOpenid: admin.openid,
          status: 'success',
          channel: refundChannel,
          requestedAt: time,
          succeededAt: time,
          createdAt: time,
          updatedAt: time
        }
      })

      await log(tx, key(depositId, 'auto_refund', refundNo), admin, 'confirmDepositRefund', 'staff_deposit', depositId, curDeposit, {
        financeAction: 'deposit_refunded',
        refundNo,
        refundAmount,
        paymentReference,
        confirmationSource
      }, time, -refundAmount)

      await depositEvent(tx, key(depositId, 'auto_refund', refundNo), curDeposit, admin.openid, 'refund', refundAmount, reason, time, {
        operatorRole: 'admin',
        refundNo,
        confirmationSource
      })

      return {
        id: depositId,
        refundNo,
        refundAmount,
        channel: refundChannel,
        confirmationSource,
        status: 'refunded',
        exitCompleted: !otherDepositsPending
      }
    })
  }

  return { reserveStaffDepositPayment, confirmStaffSupplyPolicy, shipStaffSupplies, requestStaffDepositRefund, settleStaffDeposit, settleSupplyReimbursement, submitStaffSupplyOnce, recordStaffDepositPayment, autoRefundStaffDeposit }
}
