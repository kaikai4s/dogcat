const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createTransfers = require('../../cloudfunctions/api/services/wechatTransfers')

// Synthetic withdrawals and gateway replies; all network requests are mocked.
function fixture(reply, amount = 0.14) {
  const db = createCollectionStore({
    users: [{ _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }, { _id: 's', openid: 'staff', roles: ['staff'], status: 'active' }],
    withdraw_requests: [{ _id: 'w', staffOpenid: 'staff', recipientOpenid: 'staff', status: 'pending', payoutChannel: 'wechat_wallet',
      amount, amountFen: Math.round(amount * 100), earningIds: ['e'], transferStatus: 'not_started' }],
    staff_earnings: [{ _id: 'e', staffOpenid: 'staff', amount, status: 'withdrawing', withdrawRequestId: 'w' }]
  })
  const context = createContext({ db, cloud: {} }), calls = []
  const service = createTransfers({ ...context, crypto,
    // No staffSupplies.transfer here: the gateway config may come from env or
    // the legacy payment config. Approval must use the shared config resolver.
    getSystemSettings: async () => ({ payment: { transfer: { enabled: true } } }),
    getWechatTransferConfig: () => ({ mchId: 'MCH', appId: 'APP', transferMaxAmount: 200, transferSceneId: '1005' }),
    encryptWechatTransferUserName: () => '',
    wechatPayRequest: async (method, path, body) => {
      calls.push({ method, path, body })
      return reply({ method, path, body, calls, db })
    }
  })
  Object.assign(context, service)
  context.checkTextSecurity = async () => {}
  return { db, context, service, calls, handler: require('../../cloudfunctions/api/handlers/admin')(context) }
}

test('staff approval submits a valid fourteen-fen withdrawal through the shared gateway configuration', async () => {
  const f = fixture(() => ({ state: 'PROCESSING', transfer_bill_no: 'WX' }))
  const result = await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  assert.equal(result.status, 'transferring')
  assert.equal(f.calls[0].body.transfer_amount, 14)
  assert.equal(f.calls[0].body.openid, 'staff')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

for (const missingCode of ['NOT_FOUND', 'RESOURCE_NOT_EXISTS']) {
test(`missing transfer (${missingCode}) keeps its gateway error code and recovers using the original bill`, async () => {
  const f = fixture(({ method, calls }) => {
    if (calls.length === 1 || method === 'GET') throw Object.assign(new Error('记录不存在'), { code: missingCode, statusCode: 404 })
    return { state: 'SUCCESS', transfer_bill_no: 'WX' }
  })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  const originalBill = f.db.state.withdraw_requests[0].outBillNo
  assert.equal(f.db.state.withdraw_requests[0].transferStatus, 'unknown')
  assert.equal(f.db.state.withdraw_requests[0].lastTransferErrorCode, missingCode)
  await assert.rejects(f.service.queryWechatWithdrawalTransfer('w'), /核对原单并安全重试/)
  assert.match(f.db.state.withdraw_requests[0].lastTransferError, /原转账单/)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
  await f.handler('admin', 'retryWithdrawTransfer', { id: 'w' })
  assert.deepEqual(f.calls.map(row => row.method), ['POST', 'GET', 'GET', 'POST'])
  assert.equal(f.calls[3].body.out_bill_no, originalBill)
  assert.equal(f.calls[3].body.transfer_amount, 14)
  assert.equal(f.db.state.withdraw_requests[0].status, 'paid')
  assert.equal(f.db.state.withdraw_requests[0].lastTransferError, '')
  assert.equal(f.db.state.withdraw_requests[0].lastTransferErrorCode, '')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawn')
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 1)
})
}

test('scheduled reconciliation resumes a NOT_FOUND transfer with its original bill', async () => {
  let submitted = false
  const f = fixture(({ method }) => {
    if (method === 'GET') throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND', statusCode: 404 })
    if (!submitted) {
      submitted = true
      throw new Error('submit response lost')
    }
    return { state: 'SUCCESS', transfer_bill_no: 'WX' }
  })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  const originalBill = f.calls[0].body.out_bill_no
  await f.service.reconcileWechatTransfers()
  assert.deepEqual(f.calls.map(row => row.method), ['POST', 'GET', 'POST'])
  assert.equal(f.calls[2].body.out_bill_no, originalBill)
  assert.equal(f.calls[2].body.transfer_amount, 14)
  assert.equal(f.db.state.withdraw_requests[0].status, 'paid')
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 1)
})

test('NOT_FOUND under a changed merchant does not query or resubmit the original transfer', async () => {
  const f = fixture(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND', statusCode: 404 }) })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  f.db.state.withdraw_requests[0].transferMchId = 'PREVIOUS-MCH'
  await assert.rejects(f.service.retryWechatWithdrawalTransfer('w'), /商户或小程序配置已变化/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

test('NOT_FOUND cannot resubmit a legacy transfer without its original merchant identity', async () => {
  const f = fixture(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND', statusCode: 404 }) })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  delete f.db.state.withdraw_requests[0].transferMchId
  delete f.db.state.withdraw_requests[0].transferAppId
  await assert.rejects(f.service.retryWechatWithdrawalTransfer('w'), /历史转账缺少原商户信息/)
  assert.deepEqual(f.calls.map(row => row.method), ['POST', 'GET'])
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

test('an uncertain transfer query does not start another payment', async () => {
  const f = fixture(() => { throw Object.assign(new Error('gateway timeout'), { code: 'ETIMEDOUT' }) })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  await assert.rejects(f.handler('admin', 'retryWithdrawTransfer', { id: 'w' }), /gateway timeout/)
  assert.deepEqual(f.calls.map(row => row.method), ['POST', 'GET'])
  assert.equal(f.db.state.withdraw_requests[0].lastTransferErrorCode, 'ETIMEDOUT')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

async function historicalSmall(reply, assetType = 'staff') {
  const f = fixture(reply, 0.07)
  Object.assign(f.db.state.withdraw_requests[0], {
    status: 'transferring', transferStatus: 'unknown', outBillNo: 'ORIGINAL-7-FEN', outDetailNo: 'ORIGINAL-7-FEN',
    transferMchId: 'MCH', transferAppId: 'APP', transferAttemptCount: 1, transferSubmittedAt: new Date(),
    lastTransferErrorCode: 'INVALID_REQUEST', lastTransferError: '超过单笔转账上下限'
  })
  if (assetType === 'user') {
    Object.assign(f.db.state.withdraw_requests[0], { assetType: 'user', userOpenid: 'staff' })
    f.db.state.user_asset_earnings = [{ _id: 'e', userOpenid: 'staff', amount: 0.07, status: 'withdrawing', withdrawRequestId: 'w' }]
    f.db.state.staff_earnings = []
  }
  await f.db.runTransaction(tx => f.context.prepareWechatSubmissionQuota(tx, f.db.state.withdraw_requests[0]))
  return f
}

test('approval and payload reject seven fen before any gateway submission', async () => {
  const f = fixture(() => { throw new Error('must not submit') }, 0.07)
  await assert.rejects(f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true }), /单笔最低.*0.10/)
  assert.equal(f.db.state.withdraw_requests[0].status, 'pending')
  assert.throws(() => f.service.buildTransferPayload(f.db.state.withdraw_requests[0], { transferMaxAmount: 200 }), /单笔最低.*0.10/)
  f.db.state.withdraw_requests[0].status = 'approved'
  await assert.rejects(f.service.submitWechatWithdrawalTransfer('w'), /单笔最低.*0.10/)
  assert.equal(f.calls.length, 0)
})

for (const assetType of ['staff', 'user']) {
  test(`${assetType} historical seven-fen transfer returns its unchanged earnings and quota only after missing original query`, async () => {
    const f = await historicalSmall(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND', statusCode: 404 }) }, assetType)
    const result = await f.handler('admin', 'releaseFailedWithdraw', { id: 'w' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.transferStatus, 'released')
    assert.equal(result.lastTransferError, '')
    const request = f.db.state.withdraw_requests[0]
    assert.equal(request.amount, 0.07)
    assert.equal(request.amountFen, 7)
    assert.equal(request.outBillNo, 'ORIGINAL-7-FEN')
    assert.equal(request.releaseReason, 'below_wechat_minimum')
    assert.ok(request.gatewayAbsenceConfirmedAt)
    const earnings = f.db.state[assetType === 'staff' ? 'staff_earnings' : 'user_asset_earnings']
    assert.equal(earnings[0].amount, 0.07)
    assert.equal(earnings[0].status, 'available')
    assert.equal(earnings[0].withdrawRequestId, '')
    assert.equal(f.db.state.wechat_transfer_quota_ledger[0].state, 'released')
    assert.ok(f.db.state.wechat_transfer_quota_inflight.every(row => row.outstandingFen === 0))
    assert.deepEqual(f.calls.map(row => row.method), ['GET'])
    assert.match(f.calls[0].path, /out-bill-no\/ORIGINAL-7-FEN$/)
    const ledger = structuredClone([f.db.state.finance_logs, f.db.state.wechat_transfer_quota_inflight])
    await f.handler('admin', 'releaseFailedWithdraw', { id: 'w' })
    assert.deepEqual([f.db.state.finance_logs, f.db.state.wechat_transfer_quota_inflight], ledger)
    assert.equal(f.calls.length, 1)
  })
}

test('returned seven fen combines with existing twenty-eight fen into one thirty-five-fen request', async () => {
  const f = await historicalSmall(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND' }) })
  f.db.state.staff_earnings.push({ _id: 'e2', staffOpenid: 'staff', amount: 0.28, status: 'available' })
  await f.handler('admin', 'releaseFailedWithdraw', { id: 'w' })
  const withdrawals = require('../../cloudfunctions/api/services/withdrawals')({ ...f.context,
    getSystemSettings: async () => ({ settlement: { minWithdrawAmount: 0.10 } }), refreshStaffEarnings: async () => {} })
  const combined = await withdrawals.createWithdrawRequest('staff', { amount: 0.35, payoutChannel: 'wechat_wallet', clientRequestId: 'combined' })
  assert.equal(combined.amountFen, 35)
  assert.deepEqual(combined.earningIds, ['e', 'e2'])
  assert.deepEqual(f.db.state.staff_earnings.map(row => row.amount), [0.07, 0.28])
  assert.ok(f.db.state.staff_earnings.every(row => row.withdrawRequestId === combined._id))
  assert.deepEqual(f.calls.map(row => row.method), ['GET'])
})

test('concurrent return clicks release a historical small withdrawal once', async () => {
  const f = await historicalSmall(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND' }) })
  require('./optimisticTransactions')(f.db)
  const results = await Promise.all([1, 2].map(() => f.handler('admin', 'releaseFailedWithdraw', { id: 'w' })))
  assert.ok(results.every(row => row.transferStatus === 'released'))
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_released').length, 1)
  assert.equal(f.db.state.staff_earnings[0].amount, 0.07)
  assert.ok(f.db.state.wechat_transfer_quota_inflight.every(row => row.outstandingFen === 0))
  assert.ok(f.calls.every(row => row.method === 'GET'))
})

test('uncertain small-transfer query keeps earnings and quota reserved', async () => {
  const f = await historicalSmall(() => { throw Object.assign(new Error('query timeout'), { code: 'ETIMEDOUT' }) })
  await assert.rejects(f.handler('admin', 'releaseFailedWithdraw', { id: 'w' }), /query timeout/)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
  assert.equal(f.db.state.wechat_transfer_quota_ledger[0].state, 'in_flight')
  assert.deepEqual(f.calls.map(row => row.method), ['GET'])
})

test('small transfer cannot be returned under a changed or missing original merchant', async () => {
  for (const mchId of ['CHANGED-MCH', '']) {
    const f = await historicalSmall(() => { throw new Error('must not query') })
    f.db.state.withdraw_requests[0].transferMchId = mchId
    await assert.rejects(f.handler('admin', 'releaseFailedWithdraw', { id: 'w' }), /商户/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
    assert.equal(f.db.state.wechat_transfer_quota_ledger[0].state, 'in_flight')
  }
})

for (const state of ['PROCESSING', 'SUCCESS']) {
  test(`an existing ${state} small transfer is synchronized without returning its earnings`, async () => {
    const f = await historicalSmall(() => ({ state, transfer_bill_no: 'WX' }))
    await assert.rejects(f.handler('admin', 'releaseFailedWithdraw', { id: 'w' }), /已有转账记录/)
    assert.equal(f.db.state.withdraw_requests[0].status, state === 'SUCCESS' ? 'paid' : 'transferring')
    assert.equal(f.db.state.staff_earnings[0].status, state === 'SUCCESS' ? 'withdrawn' : 'withdrawing')
    assert.equal(f.db.state.wechat_transfer_quota_ledger[0].state, state === 'SUCCESS' ? 'succeeded' : 'in_flight')
    assert.deepEqual(f.calls.map(row => row.method), ['GET'])
  })
}

test('scheduled reconciliation never resubmits missing seven-fen transfers', async () => {
  const f = await historicalSmall(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND' }) })
  await f.service.reconcileWechatTransfers()
  assert.deepEqual(f.calls.map(row => row.method), ['GET'])
  assert.match(f.db.state.withdraw_requests[0].lastTransferError, /退回余额合并提现/)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

test('retry API returns the actual gateway refusal and code', async () => {
  const f = fixture(({ method, calls }) => {
    if (method === 'GET') throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND' })
    throw Object.assign(new Error(calls.length === 1 ? '首次提交失败' : '超过单笔转账上下限，核实产品设置是否准确'), { code: 'INVALID_REQUEST' })
  })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  const result = await f.handler('admin', 'retryWithdrawTransfer', { id: 'w' })
  assert.equal(result.lastTransferErrorCode, 'INVALID_REQUEST')
  assert.match(result.lastTransferError, /超过单笔转账上下限/)
  assert.equal(result.transferStatus, 'unknown')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

test('user asset new requests and approvals enforce the WeChat minimum even with a lower business minimum', async () => {
  const f = fixture(() => {}, 0.07)
  const assets = require('../../cloudfunctions/api/services/userAssets')({ ...f.context,
    getSystemSettings: async () => ({ invitation: { userMinWithdrawAmount: 0.01 } }) })
  await assert.rejects(assets.createUserAssetWithdraw('staff', { amount: 0.07 }), /单笔最低.*0.10/)
  Object.assign(f.db.state.withdraw_requests[0], { assetType: 'user', userOpenid: 'staff' })
  await assert.rejects(assets.settleUserAssetWithdrawal({ openid: 'admin' }, { id: 'w', approved: true }), /单笔最低.*0.10/)
  assert.equal(f.db.state.withdraw_requests[0].status, 'pending')
})

test('late scheduled query error cannot attach an old failure to a concurrently confirmed payment', async () => {
  const f = fixture(async ({ method }) => {
    if (method === 'POST') return { state: 'PROCESSING', transfer_bill_no: 'WX' }
    await f.context.markWechatWithdrawalPaid('w', { state: 'SUCCESS', transferBillNo: 'WX' })
    throw Object.assign(new Error('query timeout after payment confirmed'), { code: 'ETIMEDOUT' })
  })
  await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  await f.service.reconcileWechatTransfers()
  assert.equal(f.db.state.withdraw_requests[0].status, 'paid')
  assert.equal(f.db.state.withdraw_requests[0].lastTransferError, '')
  assert.equal(f.db.state.withdraw_requests[0].lastTransferErrorCode, '')
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawn')
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 1)
})

test('historical yuan and fen disagreement is held for reconciliation before submission', async () => {
  const f = fixture(() => { throw new Error('must reconcile first') })
  f.db.state.withdraw_requests[0].amountFen = 28
  const result = await f.handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
  assert.match(result.lastTransferError, /分金额与申请金额不一致/)
  assert.equal(result.status, 'approved')
  assert.equal(f.calls.length, 0)
  assert.equal(f.db.state.withdraw_requests[0].amount, 0.14)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
})

test('historical small transfer with inconsistent earning total retains earnings and quota for reconciliation', async () => {
  const f = await historicalSmall(() => { throw Object.assign(new Error('记录不存在'), { code: 'NOT_FOUND' }) })
  f.db.state.staff_earnings[0].amount = 0.06
  await assert.rejects(f.handler('admin', 'releaseFailedWithdraw', { id: 'w' }), /提现金额与收益合计不一致/)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
  assert.equal(f.db.state.withdraw_requests[0].status, 'transferring')
  assert.equal(f.db.state.wechat_transfer_quota_ledger[0].state, 'in_flight')
})
