const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

function fixture(earnings = []) {
  const db = createCollectionStore({
    users: [{ _id: 'u', openid: 'staff', roles: ['client', 'staff'], status: 'active' }, { _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }],
    staff_profiles: [{ _id: 'sp', openid: 'staff', auditStatus: 'approved', realName: '小李', currentDepositId: 'd', depositStatus: 'unpaid', requireDepositRepay: true }],
    staff_deposits: [{ _id: 'd', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp', status: 'unpaid', amount: 500, paidAmount: 0, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 0 }],
    payments: [{ _id: 'p', targetType: 'staff_deposit', orderId: 'd', depositId: 'd', paymentNo: 'PAY', openid: 'staff', amount: 500, channel: 'wechat', status: 'pending' }],
    staff_earnings: earnings.map((row, index) => ({ _id: `e${index}`, staffOpenid: 'staff', amount: 10, status: 'available', ...row }))
  })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  return { db, context }
}

function depositService(f, reply) {
  return require('../../cloudfunctions/api/services/paymentLifecycle')({ ...f.context,
    getSystemSettings: async () => ({}), getWechatPayConfig: () => ({ appId: 'APP', mchId: 'MCH' }),
    wechatPayRequest: async (...args) => reply(...args) })
}
const paidReply = { appid: 'APP', mchid: 'MCH', out_trade_no: 'PAY', transaction_id: 'WX', amount: { total: 50000 }, trade_state: 'SUCCESS' }

test('standard, balance or eligibility changes during WeChat prepay cannot return obsolete payment parameters', async () => {
  for (const change of ['raise', 'lower', 'balance', 'revoke', 'exit']) {
  for (const useCachedPrepay of [false, true]) {
    const f = fixture()
    f.db.state.staff_profiles[0].depositStandardAmount = 500
    if (useCachedPrepay) f.db.state.payments[0].prepayId = 'CACHED_PREPAY'
    const changeStandard = () => {
      if (change === 'balance') f.db.state.staff_deposits.push({ _id: 'received', staffOpenid: 'staff', status: 'paid', paidAmount: 50, availableRefundAmount: 50 })
      else f.db.state.staff_profiles[0] = { ...f.db.state.staff_profiles[0],
        ...(change === 'revoke' ? { auditStatus: 'revoked' } : change === 'exit' ? { exitStatus: 'requested' } : { depositStandardAmount: change === 'raise' ? 600 : 450 }) }
    }
    Object.assign(f.context, depositService(f, () => ({ trade_state: 'NOTPAY' })), {
      getSystemSettings: async () => ({ staffDeposit: { enabled: true, amount: 500 }, payment: { mode: 'wechat' } }),
      assertPaymentModeAllowed: () => {},
      getWechatPayConfig: () => { if (useCachedPrepay) changeStandard(); return { appId: 'APP', mchId: 'MCH' } },
      buildMiniProgramPayParams: id => ({ package: `prepay_id=${id}` }),
      wechatPayRequest: async () => { changeStandard(); return { prepay_id: 'OBSOLETE_PREPAY' } }
    })
    const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
    await assert.rejects(handler('staff', 'createDepositPayment', { agreed: true }), /保证金.*变化/)
    assert.notEqual(f.db.state.payments[0].prepayId, 'OBSOLETE_PREPAY')
    assert.equal(f.db.state.staff_deposits[0].paidAmount, 0)
  }
  }
})

test('unchanged WeChat checkouts return new and cached payment parameters', async () => {
  for (const cached of [false, true]) {
    const f = fixture()
    f.db.state.staff_profiles[0].depositStandardAmount = 500
    if (cached) f.db.state.payments[0].prepayId = 'VALID_PREPAY'
    let requests = 0
    Object.assign(f.context, depositService(f, () => ({ trade_state: 'NOTPAY' })), {
      getSystemSettings: async () => ({ staffDeposit: { enabled: true, amount: 500 }, payment: { mode: 'wechat' } }),
      assertPaymentModeAllowed: () => {}, getWechatPayConfig: () => ({ appId: 'APP', mchId: 'MCH' }),
      buildMiniProgramPayParams: id => ({ package: `prepay_id=${id}` }),
      wechatPayRequest: async () => { requests++; return { prepay_id: 'VALID_PREPAY' } }
    })
    const result = await require('../../cloudfunctions/api/handlers/staff')(f.context)('staff', 'createDepositPayment', { agreed: true })
    assert.equal(result.payParams.package, 'prepay_id=VALID_PREPAY')
    assert.equal(requests, cached ? 0 : 1)
    assert.equal(f.db.state.payments[0].prepayId, 'VALID_PREPAY')
  }
})

test('a missing unissued WeChat order can be replaced after the personal standard changes', async () => {
  const f = fixture()
  const service = depositService(f, () => { throw Object.assign(new Error('订单不存在'), { code: 'ORDER_NOT_EXIST' }) })
  f.db.state.staff_profiles[0].depositStandardAmount = 99
  await service.closeChangedStaffDepositPayment(f.db.state.staff_profiles[0], 99, 'wechat')
  const result = await f.context.reserveStaffDepositPayment(f.db.state.users[0], f.db.state.staff_profiles[0], 99, 'wechat')
  assert.equal(result.deposit.amount, 99)
  assert.notEqual(result.payment.paymentNo, 'PAY')
})

test('abandoned WeChat top-ups are closed before refunding the remaining paid balance', async () => {
  for (const viaAdmin of [false, true]) {
    const f = fixture(), calls = []
    Object.assign(f.context, depositService(f, (method, path) => {
      calls.push({ method, path })
      return method === 'GET' ? { trade_state: 'NOTPAY' } : {}
    }))
    f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
      status: 'paid', amount: 50, paidAmount: 50, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 50 })
    const handler = require(`../../cloudfunctions/api/handlers/${viaAdmin ? 'admin' : 'staff'}`)(f.context)
    await handler(viaAdmin ? 'admin' : 'staff', viaAdmin ? 'requestStaffDepositRefund' : 'requestDepositRefund', { id: 'older', reason: '退出服务' })
    assert.ok(calls.some(call => call.method === 'POST' && call.path.endsWith('/close')))
    assert.equal(f.db.state.payments[0].status, 'closed')
    assert.equal(f.db.state.staff_deposits.find(row => row._id === 'd').status, 'cancelled')
    await f.context.settleStaffDeposit({ _id: 'a', openid: 'admin' }, 'auditDepositRefund', { id: 'older', approved: true })
    const result = await f.context.settleStaffDeposit({ _id: 'a', openid: 'admin' }, 'confirmDepositRefund', {
      id: 'older', paymentConfirmed: true, paymentReference: 'bank-older'
    })
    assert.equal(result.exitCompleted, true)
    assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
    assert.deepEqual(f.db.state.users[0].roles, ['client'])
  }
})

test('failed gateway closure leaves the paid balance and refund state untouched', async () => {
  const f = fixture()
  Object.assign(f.context, depositService(f, method => {
    if (method === 'GET') return { trade_state: 'NOTPAY' }
    throw new Error('关单失败')
  }))
  f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'paid', amount: 50, paidAmount: 50, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 50 })
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  await assert.rejects(handler('staff', 'requestDepositRefund', { reason: '退出服务' }), /关单失败/)
  assert.equal(f.db.state.staff_deposits.find(row => row._id === 'older').status, 'paid')
  assert.equal(f.db.state.payments[0].status, 'pending')
})

test('a payment arriving during exit preparation is credited before retrying the refund', async () => {
  const f = fixture()
  Object.assign(f.context, depositService(f, () => paidReply))
  f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'paid', amount: 50, paidAmount: 50, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 50 })
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  await assert.rejects(handler('staff', 'requestDepositRefund', { reason: '退出' }), /已到账/)
  assert.equal(f.db.state.staff_deposits.find(row => row._id === 'd').availableRefundAmount, 500)
  assert.equal(f.db.state.staff_deposits.find(row => row._id === 'older').status, 'paid')
  assert.equal(f.db.state.payments[0].status, 'success')
})

test('a top-up recreated between gateway closure and refund reservation blocks exit until it is closed', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].depositStandardAmount = 550
  Object.assign(f.context, depositService(f, method => method === 'GET' ? { trade_state: 'NOTPAY' } : {}))
  f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'paid', amount: 50, paidAmount: 50, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 50 })
  const prepare = f.context.prepareStaffDepositRefund
  f.context.prepareStaffDepositRefund = async (...args) => {
    await prepare(...args)
    await f.context.reserveStaffDepositPayment(f.db.state.users[0], f.db.state.staff_profiles[0], 500, 'wechat')
  }
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  await assert.rejects(handler('staff', 'requestDepositRefund', { reason: '退出' }), /补缴支付未关闭/)
  assert.equal(f.db.state.staff_deposits.find(row => row._id === 'older').status, 'paid')
  assert.equal(f.db.state.payments[0].status, 'pending')
})

test('missing gateway orders with already issued prepay parameters are not silently replaced', async () => {
  const f = fixture()
  f.db.state.payments[0].prepayId = 'ISSUED'
  const service = depositService(f, () => { throw Object.assign(new Error('订单不存在'), { code: 'ORDER_NOT_EXIST' }) })
  await assert.rejects(service.closeChangedStaffDepositPayment(f.db.state.staff_profiles[0], 99, 'wechat'), /订单不存在/)
  assert.equal(f.db.state.payments[0].status, 'pending')
  assert.equal(f.db.state.payments[0].paymentNo, 'PAY')
})

test('after exit rejection a cancelled mock top-up can be replaced and replenished normally', async () => {
  const f = fixture()
  f.db.state.payments[0].channel = 'mock'
  f.db.state.staff_profiles[0].depositStandardAmount = 550
  f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'paid', amount: 50, paidAmount: 50, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 50 })
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  await handler('staff', 'requestDepositRefund', { reason: '退出' })
  assert.equal(f.db.state.staff_deposits.find(row => row._id === 'd').status, 'cancelled')
  assert.equal(f.db.state.payments[0].status, 'closed')
  await f.context.settleStaffDeposit({ _id: 'a', openid: 'admin' }, 'auditDepositRefund', { id: 'older', approved: false, reason: '撤回退出' })
  const reserved = await f.context.reserveStaffDepositPayment(f.db.state.users[0], f.db.state.staff_profiles[0], 500, 'mock')
  assert.notEqual(reserved.deposit._id, 'd')
  await f.context.recordStaffDepositPayment(reserved.deposit._id, { channel: 'mock', paymentNo: reserved.payment.paymentNo })
  assert.equal(f.db.state.staff_profiles[0].depositStatus, 'paid')
  assert.equal(f.db.state.staff_profiles[0].requireDepositRepay, false)
})

test('deposit lost callback is repaired by an authoritative query, exactly once', async () => {
  const f = fixture(), calls = []
  const service = depositService(f, (...args) => { calls.push(args); return paidReply })
  const result = await service.syncWechatStaffDeposit(f.db.state.staff_profiles[0])
  assert.equal(result.deposit.status, 'paid')
  assert.equal(result.deposit.availableRefundAmount, 500)
  assert.equal(result.profile.requireDepositRepay, false)
  await service.syncWechatStaffDeposit(result.profile)
  assert.equal(calls.length, 1)
  assert.match(calls[0][1], /out-trade-no\/PAY\?mchid=MCH/)
  assert.equal(f.db.state.staff_deposit_events.filter(row => row.type === 'pay').length, 1)
})

test('deposit query validates merchant, app, bill and amount before crediting', async () => {
  for (const patch of [{ mchid: 'other' }, { appid: 'other' }, { out_trade_no: 'other' }, { amount: { total: 1 } }, { transaction_id: '' }]) {
    const f = fixture()
    await assert.rejects(depositService(f, () => ({ ...paidReply, ...patch })).syncWechatStaffDeposit(f.db.state.staff_profiles[0]))
    assert.equal(f.db.state.staff_deposits[0].status, 'unpaid')
    assert.equal(f.db.state.staff_profiles[0].requireDepositRepay, true)
  }
})

test('deposit query outage keeps payment unresolved, historical forfeiture never satisfies repayment', async () => {
  const f = fixture()
  const service = depositService(f, () => { throw new Error('query timeout') })
  const result = await service.syncWechatStaffDeposit(f.db.state.staff_profiles[0])
  assert.equal(result.paymentSyncPending, true)
  assert.equal(result.deposit.status, 'unpaid')
  f.db.state.staff_deposits[0].status = 'forfeited'
  f.db.state.staff_deposits[0].paidAmount = 500
  const historical = await service.syncWechatStaffDeposit(f.db.state.staff_profiles[0])
  assert.equal(historical.profile.requireDepositRepay, true)
})

test('staff deposit status and profile endpoints both reconcile paid deposits', async () => {
  for (const action of ['getDepositStatus', 'getStaffProfile']) {
    const f = fixture()
    Object.assign(f.context, depositService(f, () => paidReply))
    const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
    const result = await handler('staff', action, {})
    if (action === 'getDepositStatus') assert.equal(result.deposit.status, 'paid')
    else { assert.equal(result.depositStatus, 'paid'); assert.equal(result.depositNotice, null) }
  }
})

test('training hides quiz and rejects submission until every enabled video is complete', async () => {
  const f = fixture()
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  const locked = await handler('staff', 'getTrainingStatus', {})
  assert.equal(locked.quiz.unlocked, false)
  assert.deepEqual(locked.quiz.questions, [])
  await assert.rejects(handler('staff', 'submitTrainingQuiz', { answers: {} }), /先完成全部培训视频/)
  f.db.state.staff_profiles[0].trainingVideoProgress = Object.fromEntries(locked.videos.map(video => [video.key, { watched: true }]))
  const unlocked = await handler('staff', 'getTrainingStatus', {})
  assert.equal(unlocked.quiz.unlocked, true)
  assert.ok(unlocked.quiz.questions.length > 0)
  assert.ok(unlocked.quiz.questions.every(question => !('answer' in question)))
})

function earningService(f, state = 'PROCESSING') {
  const calls = []
  const settings = { settlement: { minWithdrawAmount: 100 }, staffSupplies: { transfer: { enabled: true } } }
  const config = { appId: 'APP', mchId: 'MCH', transferEnabled: true, transferMaxAmount: 200, transferSceneId: '1005', transferRemark: '服务收益', userRecvPerception: '劳务报酬' }
  const deps = { ...f.context, getSystemSettings: async () => settings, getWechatTransferConfig: () => config,
    checkTextSecurity: async () => {}, refreshStaffEarnings: async () => {},
    wechatPayRequest: async (method, path, body) => { calls.push({ method, path, body }); return { state, transfer_bill_no: 'WX-BILL', out_bill_no: body?.out_bill_no || '' } } }
  Object.assign(deps, require('../../cloudfunctions/api/services/wechatTransfers')(deps))
  Object.assign(deps, require('../../cloudfunctions/api/services/withdrawals')(deps))
  return { service: require('../../cloudfunctions/api/services/staffEarningSettlement')(deps), calls, deps }
}
const admin = { _id: 'a', openid: 'admin' }
const settleData = amount => ({ staffProfileId: 'sp', clientRequestId: 'test-operation', confirmed: true, expectedAmount: amount, batchIndex: 0 })

test('admin settlement retains a seven-fen balance until it can meet the gateway minimum', async () => {
  const f = fixture([{ amount: 0.07 }]), { service, calls } = earningService(f)
  const preview = await service.getStaffSettlementPreview('sp')
  assert.equal(preview.available, 0.07)
  assert.equal(preview.canSettle, false)
  await assert.rejects(service.settleStaffEarningsByWechat(admin, settleData(0.07)), /单笔最低.*0.10/)
  assert.equal(calls.length, 0)
  assert.equal(f.db.state.staff_earnings[0].status, 'available')
})

test('admin settlement combines two seven-fen earnings without changing either earning', async () => {
  const f = fixture([{ amount: 0.07 }, { amount: 0.07 }]), { service, calls } = earningService(f, 'SUCCESS')
  const result = await service.settleStaffEarningsByWechat(admin, settleData(0.14))
  assert.equal(result.status, 'paid')
  assert.equal(calls[0].body.transfer_amount, 14)
  assert.deepEqual(f.db.state.staff_earnings.map(row => row.amount), [0.07, 0.07])
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'withdrawn'))
})

test('fifty-record settlement boundary redistributes whole earnings to avoid a seven-fen final bill', async () => {
  const f = fixture(Array.from({ length: 51 }, () => ({ amount: 0.07 }))), { service, calls } = earningService(f, 'SUCCESS')
  const preview = await service.getStaffSettlementPreview('sp')
  assert.equal(preview.canSettle, true)
  assert.deepEqual(preview.groups.map(group => group.earningIds.length), [49, 2])
  assert.deepEqual(preview.groups.map(group => group.amountFen), [343, 14])
  const data = settleData(3.57)
  await service.settleStaffEarningsByWechat(admin, data)
  await service.settleStaffEarningsByWechat(admin, { ...data, batchIndex: 1 })
  assert.deepEqual(calls.map(row => row.body.transfer_amount), [343, 14])
  assert.equal(f.db.state.staff_earnings.length, 51)
  assert.ok(f.db.state.staff_earnings.every(row => row.amount === 0.07 && row.status === 'withdrawn'))
})

test('admin settles only real available earnings, preserving pending/frozen/occupied money', async () => {
  const f = fixture([{ amount: 10 }, { amount: 20, status: 'pending' }, { amount: 30, status: 'frozen' }, { amount: 40, status: 'withdrawing' }, { amount: 50, isMock: true }])
  const { service, calls } = earningService(f)
  const preview = await service.getStaffSettlementPreview('sp')
  assert.equal(preview.available, 10)
  assert.equal(preview.pending, 20)
  assert.equal(preview.frozen, 30)
  assert.equal(preview.withdrawing, 40)
  const result = await service.settleStaffEarningsByWechat(admin, settleData(10))
  assert.equal(result.status, 'transferring')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
  assert.deepEqual(f.db.state.staff_earnings.slice(1).map(row => row.status), ['pending', 'frozen', 'withdrawing', 'available'])
  assert.equal(calls[0].body.openid, 'staff')
  assert.equal(calls[0].body.transfer_amount, 1000)
  assert.equal(f.db.state.withdraw_requests[0].source, 'admin_wechat_settlement')
  await service.settleStaffEarningsByWechat(admin, settleData(10))
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET'])
})

test('admin settlement marks earnings withdrawn only after gateway success', async () => {
  const f = fixture([{ amount: 15 }])
  const { service } = earningService(f, 'SUCCESS')
  const result = await service.settleStaffEarningsByWechat(admin, settleData(15))
  assert.equal(result.status, 'paid')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawn')
  await service.settleStaffEarningsByWechat(admin, settleData(15))
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.equal(f.db.state.staff_earnings[0].amount, 15)
})

test('batch settlement returns a real gateway refusal as a result needing finance handling', async () => {
  const f = fixture([{ amount: 15 }]), { deps } = earningService(f)
  Object.assign(deps, require('../../cloudfunctions/api/services/wechatTransfers')({ ...deps,
    wechatPayRequest: async () => { throw Object.assign(new Error('超过单笔转账上下限，核实产品设置是否准确'), { code: 'INVALID_REQUEST' }) }
  }))
  const service = require('../../cloudfunctions/api/services/staffEarningSettlement')(deps)
  const result = await service.settleStaffEarningsByWechat(admin, settleData(15))
  assert.equal(result.status, 'transferring')
  assert.equal(result.transferStatus, 'unknown')
  assert.equal(result.needsHandling, true)
  assert.equal(result.lastTransferErrorCode, 'INVALID_REQUEST')
  assert.match(result.lastTransferError, /超过单笔转账上下限/)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

test('admin settlement groups all reviewed earnings into bounded transfer bills', async () => {
  const f = fixture([{ amount: 120 }, { amount: 100 }, { amount: 60 }])
  const { service, calls } = earningService(f, 'SUCCESS')
  const preview = await service.getStaffSettlementPreview('sp')
  assert.equal(preview.batchCount, 2)
  const data = settleData(280)
  assert.equal((await service.settleStaffEarningsByWechat(admin, data)).hasMore, true)
  assert.equal((await service.settleStaffEarningsByWechat(admin, { ...data, batchIndex: 1 })).hasMore, false)
  assert.deepEqual(calls.map(call => call.body.transfer_amount), [12000, 16000])
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'withdrawn'))
})

test('unreviewed amount changes and oversized indivisible earnings never start transfers', async () => {
  const f = fixture([{ amount: 10 }]), { service, calls } = earningService(f)
  await assert.rejects(service.settleStaffEarningsByWechat(admin, settleData(9)), /金额/)
  assert.equal(calls.length, 0)
  f.db.state.staff_earnings[0].amount = 201
  const preview = await service.getStaffSettlementPreview('sp')
  assert.equal(preview.canSettle, false)
  await assert.rejects(service.settleStaffEarningsByWechat(admin, settleData(201)), /转账上限/)
  assert.equal(calls.length, 0)
})

test('a freeze between preview and reservation prevents payment without clearing the ledger', async () => {
  const f = fixture([{ amount: 10 }]), { service, deps, calls } = earningService(f)
  const original = deps.createWithdrawRequest
  const guarded = require('../../cloudfunctions/api/services/staffEarningSettlement')({ ...deps,
    createWithdrawRequest: async (...args) => { f.db.state.staff_earnings[0].status = 'frozen'; return original(...args) } })
  await assert.rejects(guarded.settleStaffEarningsByWechat(admin, settleData(10)), /收益状态/)
  assert.equal(calls.length, 0)
  assert.equal(f.db.state.staff_earnings[0].status, 'frozen')
  assert.equal(f.db.state.staff_earnings[0].amount, 10)
})

test('admin refund entry records administrator attribution and cannot bypass unsettled earnings on exit', async () => {
  const f = fixture([{ amount: 10 }])
  f.db.state.payments[0].channel = 'manual'
  Object.assign(f.db.state.staff_deposits[0], { status: 'paid', paidAmount: 500, availableRefundAmount: 500 })
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  await handler('admin', 'requestStaffDepositRefund', { id: 'd', reason: '结束服务退还保证金' })
  assert.equal(f.db.state.staff_deposit_events[0].operatorRole, 'admin')
  await handler('admin', 'auditDepositRefund', { id: 'd', approved: true, reason: '审核通过' })
  await assert.rejects(handler('admin', 'confirmDepositRefund', { id: 'd', paymentConfirmed: true, paymentReference: 'ACTUAL-REFUND' }), /未结清收益/)
  assert.equal(f.db.state.staff_profiles[0].auditStatus, 'approved')
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 0)
})

test('competing admin settlement clicks reserve one withdrawal and reuse the same gateway bill', async () => {
  const f = fixture([{ amount: 10 }])
  require('./optimisticTransactions')(f.db)
  const { service, calls } = earningService(f, 'SUCCESS')
  await Promise.all([service.settleStaffEarningsByWechat(admin, settleData(10)), service.settleStaffEarningsByWechat(admin, settleData(10))])
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawn')
  const submitted = calls.filter(call => call.method === 'POST')
  assert.ok(submitted.length >= 1)
  assert.equal(new Set(submitted.map(call => call.body.out_bill_no)).size, 1)
})

test('staff removal checks unsettled earnings beyond the first hundred records', async () => {
  const f = fixture(Array.from({ length: 101 }, (_, index) => ({ status: index === 100 ? 'available' : 'withdrawn', amount: 10 })))
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  await assert.rejects(handler('admin', 'revokeStaff', { staffProfileId: 'sp' }), /收益尚未结清/)
  assert.equal(f.db.state.staff_profiles[0].auditStatus, 'approved')
})

for (const queryFails of [false, true]) {
  test(`deposit callback completed during ${queryFails ? 'failed' : 'pending'} query remains paid in returned state`, async () => {
    const f = fixture()
    const service = depositService(f, async () => {
      await f.context.recordStaffDepositPayment('d', { paymentNo: 'PAY', wxTransactionId: 'WX', channel: 'wechat' })
      if (queryFails) throw new Error('query timeout after callback')
      return { trade_state: 'NOTPAY' }
    })
    const result = await service.syncWechatStaffDeposit(f.db.state.staff_profiles[0])
    assert.equal(result.deposit.status, 'paid')
    assert.equal(result.profile.depositStatus, 'paid')
    assert.equal(result.profile.requireDepositRepay, false)
    assert.notEqual(result.paymentSyncPending, true)
  })
}

test('multiple refundable deposits are recorded one by one before staff exit completes', async () => {
  const f = fixture()
  f.db.state.payments[0].channel = 'manual'
  Object.assign(f.db.state.staff_deposits[0], { status: 'paid', paidAmount: 500, availableRefundAmount: 500 })
  f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'paid', amount: 100, paidAmount: 100, availableRefundAmount: 100, refundedAmount: 0, forfeitedAmount: 0 })
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  async function refund(id) {
    await handler('admin', 'requestStaffDepositRefund', { id, reason: '退出退还保证金' })
    await handler('admin', 'auditDepositRefund', { id, approved: true, reason: '审核通过' })
    return handler('admin', 'confirmDepositRefund', { id, paymentConfirmed: true, paymentReference: `actual-${id}` })
  }
  const first = await refund('d')
  assert.equal(first.exitCompleted, false)
  assert.equal(f.db.state.staff_deposits.find(row => row._id === 'd').refundedAmount, 500)
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'approved')
  assert.equal(f.db.state.staff_profiles[0].auditStatus, 'approved')
  assert.ok(f.db.state.users.find(row => row._id === 'u').roles.includes('staff'))
  const last = await refund('older')
  assert.equal(last.exitCompleted, true)
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
  assert.equal(f.db.state.staff_profiles[0].auditStatus, 'revoked')
  assert.ok(!f.db.state.users.find(row => row._id === 'u').roles.includes('staff'))
  assert.equal(f.db.state.staff_deposits.reduce((sum, row) => sum + row.refundedAmount, 0), 600)
})

test('concurrent confirmations refund each approved deposit once and complete staff exit only after both', async () => {
  const f = fixture()
  f.db.state.payments[0].channel = 'manual'
  Object.assign(f.db.state.staff_deposits[0], { status: 'paid', paidAmount: 500, availableRefundAmount: 500 })
  f.db.state.staff_deposits.push({ _id: 'older', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'paid', amount: 100, paidAmount: 100, availableRefundAmount: 100, refundedAmount: 0, forfeitedAmount: 0 })
  f.db.state.users.find(row => row._id === 'u').activeRole = 'staff'
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  for (const id of ['d', 'older']) {
    await handler('admin', 'requestStaffDepositRefund', { id, reason: '退出退还保证金' })
    await handler('admin', 'auditDepositRefund', { id, approved: true, reason: '审核通过' })
  }
  assert.ok(f.db.state.staff_deposits.every(row => row.status === 'refund_approved' && row.refundStatus === 'approved'))
  const retries = require('./optimisticTransactions')(f.db)
  const confirm = id => handler('admin', 'confirmDepositRefund', { id, paymentConfirmed: true, paymentReference: `actual-${id}` })
  const results = await Promise.all(['d', 'older'].map(confirm))
  assert.ok(retries() > 0, 'confirmations must overlap and retry a conflicting transaction')
  assert.deepEqual(results.map(row => row.exitCompleted).sort(), [false, true])
  function assertRefundsAndExit() {
    assert.equal(f.db.state.staff_deposits.reduce((sum, row) => sum + row.refundedAmount, 0), 600)
    for (const [id, amount] of [['d', 500], ['older', 100]]) {
      const deposit = f.db.state.staff_deposits.find(row => row._id === id)
      assert.equal(deposit.status, 'refunded')
      assert.equal(deposit.refundStatus, 'success')
      assert.equal(deposit.refundedAmount, amount)
      assert.equal(deposit.availableRefundAmount, 0)
      const events = f.db.state.staff_deposit_events.filter(row => row.type === 'refund' && row.depositId === id)
      assert.equal(events.length, 1)
      assert.equal(events[0].amount, amount)
      const logs = f.db.state.finance_logs.filter(row => row.action === 'deposit_refunded' && row.targetId === id)
      assert.equal(logs.length, 1)
      assert.equal(logs[0].amountDelta, -amount)
      assert.equal(f.db.state.admin_operation_logs.filter(row => row.action === 'confirmDepositRefund' && row.targetId === id).length, 1)
    }
    assert.equal(f.db.state.finance_logs.reduce((sum, row) => sum + row.amountDelta, 0), -600)
    assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
    assert.equal(f.db.state.staff_profiles[0].auditStatus, 'revoked')
    const user = f.db.state.users.find(row => row._id === 'u')
    assert.deepEqual(user.roles, ['client'])
    assert.equal(user.activeRole, 'client')
  }
  assertRefundsAndExit()
  const ledger = structuredClone([f.db.state.staff_deposit_events, f.db.state.finance_logs, f.db.state.admin_operation_logs])
  assert.deepEqual(await Promise.all(['d', 'older'].map(confirm)), results)
  assertRefundsAndExit()
  assert.deepEqual([f.db.state.staff_deposit_events, f.db.state.finance_logs, f.db.state.admin_operation_logs], ledger)
})

for (const pending of [
  { label: 'positive balance', status: 'paid', refundStatus: '', paidAmount: 10, refundedAmount: 0, availableRefundAmount: 10 },
  { label: 'zero balance with processing refund', status: 'refunded', refundStatus: 'processing', paidAmount: 10, refundedAmount: 10, availableRefundAmount: 0 }
]) {
  test(`an unresolved deposit after record 101 prevents staff exit: ${pending.label}`, async () => {
    const f = fixture()
    Object.assign(f.db.state.staff_deposits[0], { status: 'refund_approved', refundStatus: 'approved',
      paidAmount: 500, availableRefundAmount: 500, approvedRefundAmount: 500 })
    f.db.state.staff_deposits.push(...Array.from({ length: 100 }, (_, index) => ({
      _id: `history-${String(index).padStart(3, '0')}`, staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
      status: 'refunded', refundStatus: 'success', amount: 10, paidAmount: 10, refundedAmount: 10, forfeitedAmount: 0, availableRefundAmount: 0
    })))
    const { label, ...pendingDeposit } = pending
    f.db.state.staff_deposits.push({ _id: 'z-pending', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
      amount: 10, forfeitedAmount: 0, ...pendingDeposit })
    assert.equal([...f.db.state.staff_deposits].sort((a, b) => a._id.localeCompare(b._id)).findIndex(row => row._id === 'z-pending'), 101)
    Object.assign(f.db.state.staff_profiles[0], { exitStatus: 'approved', depositStatus: 'refund_approved' })
    f.db.state.users.find(row => row._id === 'u').activeRole = 'staff'
    const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
    const result = await handler('admin', 'confirmDepositRefund', { id: 'd', paymentConfirmed: true, paymentReference: 'actual-d' })
    assert.equal(result.exitCompleted, false)
    assert.equal(f.db.state.staff_deposits[0].refundedAmount, 500)
    assert.equal(f.db.state.staff_deposits[0].status, 'refunded')
    assert.equal(f.db.state.staff_profiles[0].exitStatus, 'approved')
    assert.equal(f.db.state.staff_profiles[0].auditStatus, 'approved')
    const user = f.db.state.users.find(row => row._id === 'u')
    assert.deepEqual(user.roles, ['client', 'staff'])
    assert.equal(user.activeRole, 'staff')
    assert.deepEqual(f.db.state.staff_deposits.find(row => row._id === 'z-pending'), {
      _id: 'z-pending', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp', amount: 10, forfeitedAmount: 0, ...pendingDeposit
    })
  })
}

test('platform-wide deposit lists retain date filtering and exclude historical records', async () => {
  const f = fixture()
  f.db.state.staff_deposits = [
    { _id: 'old-staff', staffOpenid: 'staff', status: 'paid', createdAt: new Date('2024-01-01T00:00:00Z'), paidAt: new Date('2024-01-02T00:00:00Z') },
    { _id: 'old-other', staffOpenid: 'other', status: 'paid', createdAt: new Date('2024-01-01T00:00:00Z'), paidAt: new Date('2024-01-02T00:00:00Z') },
    { _id: 'current-staff', staffOpenid: 'staff', status: 'paid', createdAt: new Date('2026-10-10T12:00:00Z') },
    { _id: 'current-other', staffOpenid: 'other', status: 'paid', createdAt: new Date('2026-10-15T12:00:00Z') },
    { _id: 'future', staffOpenid: 'staff', status: 'paid', createdAt: new Date('2026-11-10T12:00:00Z'), paidAt: new Date('2026-11-11T12:00:00Z') }
  ]
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  const result = await handler('admin', 'listStaffDeposits', { startDate: '2026-10-01', endDate: '2026-10-26', pageSize: 50 })
  assert.deepEqual(result.map(row => row._id).sort(), ['current-other', 'current-staff'])
})

test('targeted finance lists include all historical records for the selected staff member', async () => {
  const f = fixture()
  const oldDate = new Date('2024-01-01T00:00:00Z')
  f.db.state.staff_deposits = Array.from({ length: 105 }, (_, index) => ({ _id: `d${String(index).padStart(3, '0')}`, staffOpenid: 'staff', createdAt: oldDate, status: 'paid', amount: 10 }))
  f.db.state.withdraw_requests = Array.from({ length: 105 }, (_, index) => ({ _id: `w${String(index).padStart(3, '0')}`, staffOpenid: 'staff', createdAt: oldDate, status: 'paid', amount: 10 }))
  f.db.state.staff_deposits.push({ _id: 'other', staffOpenid: 'other', createdAt: new Date(), status: 'paid' })
  f.db.state.withdraw_requests.push({ _id: 'other', staffOpenid: 'other', createdAt: new Date(), status: 'paid' })
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  for (const action of ['listStaffDeposits', 'listWithdrawRequests']) {
    const result = await handler('admin', action, { staffOpenid: 'staff', startDate: '2026-10-01', endDate: '2026-10-26', pageSize: 50 })
    assert.equal(result.length, 105)
    assert.ok(result.every(row => row.staffOpenid === 'staff'))
  }
})

test('deposit checkout returns success after repairing a lost payment callback', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].depositStandardAmount = 500
  Object.assign(f.context, depositService(f, () => paidReply), {
    getSystemSettings: async () => ({ staffDeposit: { enabled: true, amount: 500 } })
  })
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  const result = await handler('staff', 'createDepositPayment', { agreed: true })
  assert.equal(result.paid, true)
  assert.equal(f.db.state.staff_profiles[0].requireDepositRepay, false)
})

test('payment reservation rejects stale standards and balances without changing payment records', async () => {
  const f = fixture()
  const snapshot = { ...f.db.state.staff_profiles[0], depositStandardAmount: 99 }
  Object.assign(f.db.state.staff_profiles[0], { depositStandardAmount: 100 })
  await assert.rejects(f.context.reserveStaffDepositPayment(f.db.state.users[0], snapshot, 99, 'mock'), /标准或余额已变化/)
  assert.equal(f.db.state.staff_deposits[0].amount, 500)
  assert.equal(f.db.state.payments[0].amount, 500)
  Object.assign(snapshot, { depositStandardAmount: 100 })
  f.db.state.staff_deposits.push({ _id: 'old', staffOpenid: 'staff', availableRefundAmount: 50 })
  await assert.rejects(f.context.reserveStaffDepositPayment(f.db.state.users[0], snapshot, 100, 'mock'), /标准或余额已变化/)
})

test('deposit callback totals more than one page without transaction collection queries', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].depositStandardAmount = 650
  for (let i = 0; i < 150; i++) f.db.state.staff_deposits.push({ _id: `old_${String(i).padStart(3, '0')}`, staffOpenid: 'staff', availableRefundAmount: 1, status: 'paid' })
  const runTransaction = f.db.runTransaction
  f.db.runTransaction = callback => runTransaction(tx => callback({ collection: name => ({ doc: id => tx.collection(name).doc(id) }) }))
  await f.context.recordStaffDepositPayment('d', { paymentNo: 'PAY', channel: 'wechat' })
  assert.equal(f.db.state.staff_profiles[0].depositStatus, 'paid')
  assert.equal(f.db.state.staff_profiles[0].requireDepositRepay, false)
})

test('changing a pending WeChat amount closes the original order before issuing a new number', async () => {
  const f = fixture(), calls = []
  const service = depositService(f, (method, path) => { calls.push([method, path]); return method === 'GET' ? { trade_state: 'NOTPAY' } : {} })
  f.db.state.staff_profiles[0].depositStandardAmount = 99
  await service.closeChangedStaffDepositPayment(f.db.state.staff_profiles[0], 99, 'wechat')
  assert.equal(f.db.state.payments[0].status, 'closed')
  assert.equal(calls[1][0], 'POST')
  assert.match(calls[1][1], /out-trade-no\/PAY\/close$/)
  const result = await f.context.reserveStaffDepositPayment(f.db.state.users[0], f.db.state.staff_profiles[0], 99, 'wechat')
  assert.equal(result.deposit.amount, 99)
  assert.notEqual(result.payment.paymentNo, 'PAY')
  assert.deepEqual(result.payment.previousPaymentNos, ['PAY'])
  assert.equal(f.db.state.payments.length, 1)
  await f.context.recordStaffDepositPayment('d', { paymentNo: result.payment.paymentNo, channel: 'wechat' })
  assert.equal(f.db.state.staff_profiles[0].depositStatus, 'paid')
  assert.equal(f.db.state.staff_deposits[0].availableRefundAmount, 99)
})

test('a failed WeChat close preserves the original bill and blocks amount replacement', async () => {
  const f = fixture()
  const service = depositService(f, method => {
    if (method === 'GET') return { trade_state: 'NOTPAY' }
    throw new Error('关单失败')
  })
  await assert.rejects(service.closeChangedStaffDepositPayment(f.db.state.staff_profiles[0], 99, 'wechat'), /关单失败/)
  assert.equal(f.db.state.payments[0].status, 'pending')
  await assert.rejects(f.context.reserveStaffDepositPayment(f.db.state.users[0], f.db.state.staff_profiles[0], 99, 'wechat'), /尚未关闭/)
  assert.equal(f.db.state.staff_deposits[0].amount, 500)
  assert.equal(f.db.state.payments[0].paymentNo, 'PAY')
})

test('reconciling an older payment still collects the remainder of a raised standard', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].depositStandardAmount = 600
  Object.assign(f.context, depositService(f, () => paidReply), {
    getSystemSettings: async () => ({ staffDeposit: { enabled: true, amount: 600 }, payment: { mode: 'mock' } }),
    assertPaymentModeAllowed: () => {}
  })
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  const result = await handler('staff', 'createDepositPayment', { agreed: true })
  assert.equal(result.paid, true)
  assert.notEqual(result.depositId, 'd')
  assert.equal(f.db.state.staff_deposits.find(row => row._id === result.depositId).paidAmount, 100)
  assert.equal(f.db.state.staff_profiles[0].requireDepositRepay, false)
})

test('a late prepay response cannot overwrite a replacement payment order', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].depositStandardAmount = 500
  Object.assign(f.context, depositService(f, () => ({ trade_state: 'NOTPAY' })), {
    getSystemSettings: async () => ({ staffDeposit: { enabled: true, amount: 500 }, payment: { mode: 'wechat' } }),
    assertPaymentModeAllowed: () => {},
    getWechatPayConfig: () => ({ appId: 'APP', mchId: 'MCH' }),
    wechatPayRequest: async () => {
      f.db.state.payments[0] = { ...f.db.state.payments[0], paymentNo: 'REPLACEMENT', prepayId: 'NEW_PREPAY' }
      return { prepay_id: 'OLD_PREPAY' }
    }
  })
  const handler = require('../../cloudfunctions/api/handlers/staff')(f.context)
  await assert.rejects(handler('staff', 'createDepositPayment', { agreed: true }), /支付订单已更新/)
  assert.equal(f.db.state.payments[0].paymentNo, 'REPLACEMENT')
  assert.equal(f.db.state.payments[0].prepayId, 'NEW_PREPAY')
})

test('legacy payment callbacks use the current platform standard rather than the old bill amount', async () => {
  const f = fixture()
  f.db.state.staff_deposits[0].amount = 99
  f.db.state.payments[0].amount = 99
  f.context.getSystemSettings = async () => ({ staffDeposit: { enabled: true, amount: 100 } })
  await f.context.recordStaffDepositPayment('d', { paymentNo: 'PAY', channel: 'wechat' })
  const profile = f.db.state.staff_profiles[0]
  assert.equal(profile.depositStandardAmount, 100)
  assert.equal(profile.depositEntryStandardAmount, 100)
  assert.equal(profile.requireDepositRepay, true)
  assert.equal(profile.depositStatus, 'supplement_required')
})

test('closed gateway deposit orders rotate payment number even when the amount stays the same', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].depositStandardAmount = 500
  f.db.state.payments[0].prepayId = 'CLOSED_PREPAY'
  const service = depositService(f, () => ({ trade_state: 'CLOSED' }))
  const synced = await service.syncWechatStaffDeposit(f.db.state.staff_profiles[0])
  const reserved = await f.context.reserveStaffDepositPayment(f.db.state.users[0], synced.profile, 500, 'wechat')
  assert.notEqual(reserved.payment.paymentNo, 'PAY')
  assert.equal(reserved.payment.prepayId, '')
  assert.equal(reserved.deposit.amount, 500)
})

test('a confirmed missing gateway order allows retrying the same deposit payment', async () => {
  const f = fixture()
  const service = depositService(f, () => { throw Object.assign(new Error('订单不存在'), { code: 'ORDER_NOT_EXIST' }) })
  const synced = await service.syncWechatStaffDeposit(f.db.state.staff_profiles[0])
  assert.notEqual(synced.paymentSyncPending, true)
  assert.equal(f.db.state.payments[0].paymentNo, 'PAY')
  assert.equal(f.db.state.staff_deposits[0].status, 'unpaid')
})

test('late payment records funds without restoring a revoked sitter role or reopening exit', async () => {
  const f = fixture()
  Object.assign(f.db.state.staff_profiles[0], { auditStatus: 'revoked', exitStatus: 'exited', depositStandardAmount: 500 })
  f.db.state.users[0].roles = ['client']
  await f.context.recordStaffDepositPayment('d', { paymentNo: 'PAY', channel: 'wechat' })
  assert.equal(f.db.state.staff_deposits[0].paidAmount, 500)
  assert.deepEqual(f.db.state.users[0].roles, ['client'])
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
  assert.equal(f.db.state.staff_profiles[0].auditStatus, 'revoked')
})
