const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createRefunds = require('../../cloudfunctions/api/services/staffDepositRefunds')

// Isolated synthetic ledger and gateway responses; no real payment requests.
function fixture(reply, { earnings = [], amount = 99.99, forfeited = 0 } = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'u', openid: 'staff', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' },
      { _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }],
    staff_profiles: [{ _id: 'sp', userId: 'u', openid: 'staff', auditStatus: 'approved', currentDepositId: 'd', depositStatus: 'paid' }],
    staff_deposits: [{ _id: 'd', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp', status: 'paid',
      amount, paidAmount: amount, refundedAmount: 0, forfeitedAmount: forfeited, availableRefundAmount: Math.round((amount - forfeited) * 100) / 100,
      paymentNo: 'PAY', wxTransactionId: 'WX', paymentChannel: 'wechat' }],
    payments: [{ _id: 'p', orderId: 'd', depositId: 'd', targetType: 'staff_deposit', openid: 'staff',
      status: 'success', channel: 'wechat', amount, paymentNo: 'PAY', wxTransactionId: 'WX' }],
    staff_earnings: earnings
  })
  const context = createContext({ db, cloud: {} }), calls = []
  let gatewayRefund, settings = { payment: { mode: 'wechat', refundEnabled: true } }
  const config = { mchId: 'MCH', appId: 'APP', refundEnabled: true }
  const service = createRefunds({ ...context, crypto,
    getSystemSettings: async () => settings, getWechatPayConfig: () => config,
    wechatPayRequest: async (method, path, body) => {
      calls.push({ method, path, body })
      if (body) gatewayRefund = { out_refund_no: body.out_refund_no, out_trade_no: 'PAY', transaction_id: 'WX',
        refund_id: 'REFUND-WX', amount: body.amount, status: 'PROCESSING' }
      return reply ? reply({ method, path, body, gatewayRefund, db, calls }) : gatewayRefund
    }
  })
  context.syncStaffDepositRefund = service.syncStaffDepositRefund
  context.checkTextSecurity = async () => {}
  const handler = require('../../cloudfunctions/api/handlers/admin')(context)
  async function approve() {
    await handler('admin', 'requestStaffDepositRefund', { id: 'd', reason: '退出退还保证金' })
    return handler('admin', 'auditDepositRefund', { id: 'd', approved: true, reason: '审核通过' })
  }
  return { db, context, service, calls, config, settings, approve, handler }
}

function allowNextGatewayCheck(f) {
  f.db.state.staff_deposits[0].refundNextCheckAt = new Date(0)
}

test('approval automatically starts original-payment refund, then scheduled query books success once', async () => {
  const f = fixture(({ method, gatewayRefund }) => ({ ...gatewayRefund, status: method === 'POST' ? 'PROCESSING' : 'SUCCESS' }))
  const approved = await f.approve()
  assert.equal(approved.status, 'refunding')
  assert.equal(approved.refundStatus, 'processing')
  assert.equal(f.calls[0].path, '/v3/refund/domestic/refunds')
  assert.equal(f.calls[0].body.transaction_id, 'WX')
  assert.deepEqual(f.calls[0].body.amount, { refund: 9999, total: 9999, currency: 'CNY' })
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 0)
  assert.ok(f.db.state.users[0].roles.includes('staff'))
  allowNextGatewayCheck(f)
  await f.service.reconcileStaffDepositRefunds()
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
  assert.equal(f.db.state.staff_deposits[0].availableRefundAmount, 0)
  assert.equal(f.db.state.staff_deposits[0].wechatRefundState, 'SUCCESS')
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
  assert.deepEqual(f.db.state.users[0].roles, ['client'])
  await f.service.syncStaffDepositRefund('d')
  assert.equal(f.calls.length, 2)
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'deposit_refunded').length, 1)
  assert.equal(f.db.state.staff_deposit_events.filter(row => row.type === 'refund').length, 1)
})

test('original-payment refund subtracts first-supply cost and keeps the original paid total', async () => {
  const f = fixture(({ gatewayRefund }) => ({ ...gatewayRefund, status: 'SUCCESS' }), { amount: 500 })
  Object.assign(f.db.state.staff_deposits[0], {
    supplyPolicyAcceptedAt: '2026-10-28T00:00:00.000Z', supplyFeeAmount: 120,
    supplyShipment: { expressCompany: '测试快递', trackingNo: 'TEST123' }
  })
  const preview = await f.handler('admin', 'getStaffDepositRefundPreview', { id: 'd' })
  assert.equal(preview.estimatedRefundAmount, 380)
  const result = await f.approve()
  assert.equal(result.refundStatus, 'success')
  assert.deepEqual(f.calls[0].body.amount, { refund: 38000, total: 50000, currency: 'CNY' })
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 380)
  assert.equal(f.db.state.staff_deposits[0].supplyFeeDeductedAmount, 120)
  assert.equal(f.db.state.staff_deposit_events.filter(row => row.type === 'supply_fee').length, 1)
  await f.service.syncStaffDepositRefund('d')
  assert.equal(f.calls.length, 1)
  assert.equal(f.db.state.staff_deposit_events.filter(row => row.type === 'supply_fee').length, 1)
})

test('lost submit response recovers with original refund number and amount after explicit absence', async () => {
  const f = fixture(({ method, gatewayRefund, calls }) => {
    if (calls.length === 1) throw new Error('response lost')
    if (method === 'GET') throw Object.assign(new Error('原单不存在'), { code: 'RESOURCE_NOT_EXISTS' })
    return { ...gatewayRefund, status: 'SUCCESS' }
  })
  await f.approve()
  assert.equal(f.db.state.staff_deposits[0].refundStatus, 'processing')
  assert.match(f.db.state.staff_deposits[0].refundLastError, /response lost/)
  assert.equal(f.db.state.staff_deposits[0].statusText, '退款受理待核实')
  assert.equal(f.db.state.staff_deposits[0].wechatRefundId, undefined)
  assert.ok(f.db.state.staff_deposits[0].refundNo)
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 0)
  allowNextGatewayCheck(f)
  const result = await f.handler('admin', 'syncDepositRefund', { id: 'd' })
  assert.equal(result.refundStatus, 'success')
  assert.deepEqual(f.calls.map(row => row.method), ['POST', 'GET', 'POST'])
  assert.deepEqual(f.calls[0].body, f.calls[2].body)
})

test('limited refund submission reserves a number without claiming WeChat acceptance', async () => {
  const f = fixture(({ method }) => {
    if (method === 'POST') throw Object.assign(new Error('请求频率过高'), { code: 'FREQUENCY_LIMITED', statusCode: 429 })
    throw Object.assign(new Error('原单不存在'), { code: 'RESOURCE_NOT_EXISTS' })
  })
  await f.approve()
  const deposit = f.db.state.staff_deposits[0]
  assert.equal(deposit.statusText, '退款受理待核实')
  assert.equal(deposit.wechatRefundId, undefined)
  assert.ok(deposit.refundNo)
  assert.match(deposit.refundLastError, /提交未获受理确认/)
  assert.ok(new Date(deposit.refundNextCheckAt).getTime() > Date.now())
  assert.deepEqual(f.calls.map(call => call.method), ['POST'])
  const pending = await f.service.syncStaffDepositRefund('d')
  assert.equal(pending.refundAcceptanceUnconfirmed, true)
  assert.equal(f.calls.length, 1)
})

test('recovers an older R-prefixed successful refund after the newer DR reservation is absent', async () => {
  const paidAt = new Date('2026-10-28T12:36:49.000Z')
  const legacyNo = `R${crypto.createHash('sha256').update(`staff_deposit_refund:d:${paidAt}`).digest('hex').slice(0, 24)}`
  const f = fixture(({ method, path }) => {
    if (method === 'POST') throw Object.assign(new Error('请求频率过高'), { statusCode: 429 })
    if (!path.endsWith(`/${legacyNo}`)) throw Object.assign(new Error('原单不存在'), { code: 'RESOURCE_NOT_EXISTS' })
    return { out_refund_no: legacyNo, refund_id: 'LEGACY-WX-REFUND', status: 'SUCCESS',
      out_trade_no: 'PAY', transaction_id: 'WX', mchid: 'MCH',
      amount: { refund: 9999, total: 9999, currency: 'CNY' } }
  })
  await f.approve()
  const newerNo = f.db.state.staff_deposits[0].refundNo
  assert.notEqual(newerNo, legacyNo)
  f.db.state.staff_deposits[0].paidAt = paidAt
  allowNextGatewayCheck(f)
  const result = await f.service.syncStaffDepositRefund('d')
  assert.equal(result.refundStatus, 'success')
  assert.equal(f.db.state.staff_deposits[0].refundNo, legacyNo)
  assert.equal(f.db.state.staff_deposits[0].refundPreviousReservedNo, newerNo)
  assert.equal(f.db.state.staff_deposits[0].wechatRefundId, 'LEGACY-WX-REFUND')
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'GET'])
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'deposit_refunded').length, 1)
  await f.service.syncStaffDepositRefund('d')
  assert.equal(f.calls.length, 3)
})

test('first approval verifies the old refund number before submitting any new refund', async () => {
  const paidAt = new Date('2026-10-28T12:36:49.000Z')
  const legacyNo = `R${crypto.createHash('sha256').update(`staff_deposit_refund:d:${paidAt}`).digest('hex').slice(0, 24)}`
  const f = fixture(({ method, path }) => {
    assert.equal(method, 'GET')
    assert.ok(path.endsWith(`/${legacyNo}`))
    return { out_refund_no: legacyNo, refund_id: 'LEGACY-WX-REFUND', status: 'SUCCESS',
      out_trade_no: 'PAY', transaction_id: 'WX', mchid: 'MCH',
      amount: { refund: 9999, total: 9999, currency: 'CNY' } }
  })
  f.db.state.staff_deposits[0].paidAt = paidAt
  const result = await f.approve()
  assert.equal(result.refundStatus, 'success')
  assert.equal(f.db.state.staff_deposits[0].refundNo, legacyNo)
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
  assert.deepEqual(f.calls.map(call => call.method), ['GET'])
})

test('an unrelated legacy refund cannot be booked and blocks a fresh refund submission', async () => {
  const paidAt = new Date('2026-10-28T12:36:49.000Z')
  const legacyNo = `R${crypto.createHash('sha256').update(`staff_deposit_refund:d:${paidAt}`).digest('hex').slice(0, 24)}`
  const f = fixture(({ method, path }) => {
    if (method === 'POST') throw new Error('submit timeout')
    if (!path.endsWith(`/${legacyNo}`)) throw Object.assign(new Error('原单不存在'), { code: 'RESOURCE_NOT_EXISTS' })
    return { out_refund_no: legacyNo, refund_id: 'WRONG-REFUND', status: 'SUCCESS',
      out_trade_no: 'OTHER-ORDER', transaction_id: 'OTHER-TRANSACTION', mchid: 'MCH',
      amount: { refund: 9999, total: 9999, currency: 'CNY' } }
  })
  await f.approve()
  f.db.state.staff_deposits[0].paidAt = paidAt
  allowNextGatewayCheck(f)
  await f.service.syncStaffDepositRefund('d')
  const deposit = f.db.state.staff_deposits[0]
  assert.equal(deposit.refundedAmount, 0)
  assert.equal(deposit.wechatRefundId, undefined)
  assert.match(deposit.refundLastError, /与原保证金不匹配/)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'GET'])
})

test('query timeout never submits another refund or books an unconfirmed refund', async () => {
  const f = fixture(({ method, gatewayRefund }) => {
    if (method === 'GET') throw new Error('query timeout')
    return gatewayRefund
  })
  await f.approve()
  allowNextGatewayCheck(f)
  await f.service.syncStaffDepositRefund('d')
  assert.deepEqual(f.calls.map(row => row.method), ['POST', 'GET'])
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 0)
  assert.equal(f.db.state.staff_deposits[0].availableRefundAmount, 99.99)
  assert.match(f.db.state.staff_deposits[0].refundLastError, /query timeout/)
})

test('successful refund is recorded while unsettled earnings keep staff exit pending', async () => {
  const f = fixture(({ gatewayRefund }) => ({ ...gatewayRefund, status: 'SUCCESS' }), {
    earnings: [{ _id: 'e', staffOpenid: 'staff', status: 'available', amount: 0.07 }]
  })
  const result = await f.approve()
  assert.equal(result.refundStatus, 'success')
  assert.equal(result.exitCompleted, false)
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
  assert.equal(f.db.state.staff_deposits[0].refundExitPending, true)
  assert.ok(f.db.state.users[0].roles.includes('staff'))
  f.db.state.staff_earnings[0].status = 'withdrawn'
  await f.service.reconcileStaffDepositRefunds()
  assert.equal(f.db.state.staff_deposits[0].refundExitPending, false)
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
  assert.equal(f.calls.length, 1)
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'deposit_refunded').length, 1)
})

test('concurrent successful queries record one refund and one financial outflow', async () => {
  const f = fixture(({ method, gatewayRefund }) => ({ ...gatewayRefund, status: method === 'POST' ? 'PROCESSING' : 'SUCCESS' }))
  await f.approve()
  allowNextGatewayCheck(f)
  require('./optimisticTransactions')(f.db)
  const results = await Promise.all([f.service.syncStaffDepositRefund('d'), f.service.syncStaffDepositRefund('d')])
  assert.ok(results.some(row => row.refundStatus === 'success'))
  assert.ok(results.every(row => ['processing', 'success'].includes(row.refundStatus)))
  assert.equal(f.db.state.staff_deposits[0].refundStatus, 'success')
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'deposit_refunded').length, 1)
  assert.equal(f.db.state.staff_deposit_events.filter(row => row.type === 'refund').length, 1)
})

test('partial forfeiture refunds only the available balance against the original payment total', async () => {
  const f = fixture(({ gatewayRefund }) => ({ ...gatewayRefund, status: 'SUCCESS' }), { amount: 100, forfeited: 20 })
  await f.approve()
  assert.deepEqual(f.calls[0].body.amount, { refund: 8000, total: 10000, currency: 'CNY' })
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 80)
  assert.equal(f.db.state.staff_deposits[0].forfeitedAmount, 20)
})

test('historical approved refunds are automatically resumed without a second approval', async () => {
  const f = fixture(({ gatewayRefund }) => ({ ...gatewayRefund, status: 'SUCCESS' }))
  Object.assign(f.db.state.staff_deposits[0], { status: 'refund_approved', refundStatus: 'approved', approvedRefundAmount: 99.99 })
  Object.assign(f.db.state.staff_profiles[0], { exitStatus: 'approved', depositStatus: 'refund_approved' })
  await f.service.reconcileStaffDepositRefunds()
  assert.equal(f.db.state.staff_deposits[0].refundStatus, 'success')
  assert.equal(f.calls.length, 1)
})

test('late submit timeout cannot downgrade a refund confirmed concurrently', async () => {
  const f = fixture(async ({ gatewayRefund, db }) => {
    await f.context.recordStaffDepositRefundSuccess('d', { refundNo: gatewayRefund.out_refund_no, refundId: 'REFUND-WX', refundFen: 9999 })
    throw new Error('late timeout')
  })
  const result = await f.approve()
  assert.equal(result.refundStatus, 'success')
  assert.equal(result.refundLastError, '')
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
})

test('refund configuration changes leave the original refund available for reconciliation', async () => {
  const f = fixture()
  await f.approve()
  f.config.mchId = 'OTHER'
  allowNextGatewayCheck(f)
  await f.service.syncStaffDepositRefund('d')
  assert.equal(f.calls.length, 1)
  assert.match(f.db.state.staff_deposits[0].refundLastError, /商户或小程序配置已变化/)
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 0)
})

test('gateway frequency limit defers retries and later confirms the existing refund without a second payout', async () => {
  let queries = 0
  const f = fixture(({ method, gatewayRefund }) => {
    if (method === 'GET' && ++queries === 1) throw Object.assign(new Error('请求频率过高，请稍后重试'), { code: 'FREQUENCY_LIMITED', statusCode: 429 })
    return { ...gatewayRefund, status: method === 'POST' ? 'PROCESSING' : 'SUCCESS' }
  })
  await f.approve()
  const deferred = await f.handler('admin', 'syncDepositRefund', { id: 'd' })
  assert.equal(deferred.refundStatus, 'processing')
  assert.ok(deferred.retryAfterSeconds > 0)
  assert.equal(f.calls.length, 1)
  allowNextGatewayCheck(f)
  const rateLimited = await f.handler('admin', 'syncDepositRefund', { id: 'd' })
  assert.equal(rateLimited.refundStatus, 'processing')
  assert.match(rateLimited.refundLastError, /至少5分钟后定时任务会自动核对/)
  assert.ok(rateLimited.retryAfterSeconds > 0)
  await f.service.reconcileStaffDepositRefunds()
  assert.equal(f.calls.length, 2)
  allowNextGatewayCheck(f)
  const confirmed = await f.service.syncStaffDepositRefund('d')
  assert.equal(confirmed.refundStatus, 'success')
  assert.equal(confirmed.retryAfterSeconds, 0)
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 99.99)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'GET'])
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'deposit_refunded').length, 1)
})

test('scheduled reconciliation reaches an eligible refund beyond a page of cooling records', async () => {
  const f = fixture(({ gatewayRefund }) => ({ ...gatewayRefund, status: 'SUCCESS' }))
  Object.assign(f.db.state.staff_deposits[0], { status: 'refund_approved', refundStatus: 'approved', approvedRefundAmount: 99.99 })
  f.db.state.staff_deposits.push(...Array.from({ length: 101 }, (_, index) => ({
    _id: `a${String(index).padStart(3, '0')}`, staffOpenid: `other_${index}`,
    status: 'refunding', refundStatus: 'processing', refundNextCheckAt: new Date(Date.now() + 600000)
  })))
  const result = await f.service.reconcileStaffDepositRefunds()
  assert.equal(result.checked, 1)
  assert.equal(f.db.state.staff_deposits[0].refundStatus, 'success')
  assert.equal(f.calls.length, 1)
})

test('existing refund can still be confirmed after new payment submissions are disabled', async () => {
  const f = fixture(({ method, gatewayRefund }) => ({ ...gatewayRefund, status: method === 'POST' ? 'PROCESSING' : 'SUCCESS' }))
  await f.approve()
  f.settings.payment.mode = 'manual'
  f.settings.payment.refundEnabled = false
  allowNextGatewayCheck(f)
  const confirmed = await f.service.syncStaffDepositRefund('d')
  assert.equal(confirmed.refundStatus, 'success')
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
})

test('original non-WeChat payments retain explicit manual refund processing', async () => {
  const f = fixture()
  f.db.state.payments[0].channel = 'manual'
  f.db.state.staff_deposits[0].paymentChannel = 'manual'
  const result = await f.approve()
  assert.equal(result.refundChannel, 'manual')
  assert.equal(result.status, 'refund_approved')
  assert.equal(f.calls.length, 0)
  await f.handler('admin', 'confirmDepositRefund', { id: 'd', paymentConfirmed: true, paymentReference: 'manual-proof' })
  assert.equal(f.db.state.staff_deposits[0].refundStatus, 'success')
})
