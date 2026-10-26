const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createSettlement = require('../../cloudfunctions/api/services/staffEarningSettlement')

// Isolated synthetic ledger and payment references; no actual payments are sent.
const admin = { _id: 'a', openid: 'admin' }
const requestData = { staffProfileId: 'sp', clientRequestId: 'tail-test', expectedAmount: 0.07, confirmed: true }
function fixture(extra = {}) {
  const db = createCollectionStore({
    users: [{ ...admin, roles: ['admin'], status: 'active' },
      { _id: 'b', openid: 'payer', roles: ['admin'], status: 'active' },
      { _id: 'u', openid: 'staff', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }],
    staff_profiles: [{ _id: 'sp', userId: 'u', openid: 'staff', realName: '小李', auditStatus: 'approved' }],
    staff_earnings: [{ _id: 'e1', staffOpenid: 'staff', orderId: 'order1', amount: 0.03, status: 'available' },
      { _id: 'e2', staffOpenid: 'staff', orderId: 'order2', amount: 0.04, status: 'available' }],
    withdraw_requests: [], finance_logs: [], admin_operation_logs: [], ...extra
  })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  Object.assign(context, createSettlement({ ...context, refreshStaffEarnings: async () => {},
    getWechatTransferConfig: () => { throw new Error('微信商家转账未启用') } }))
  const handler = require('../../cloudfunctions/api/handlers/admin')(context)
  const create = data => handler('admin', 'createStaffManualTailSettlement', { ...requestData, ...data })
  const approve = id => handler('admin', 'auditWithdrawRequest', { id, approved: true })
  const pay = (id, openid = 'admin') => handler(openid, 'markWithdrawPaid', {
    id, paymentConfirmed: true, paymentReference: 'SYNTHETIC-BANK-001'
  })
  return { db, context, handler, create, approve, pay }
}

test('manual tail preview remains available without WeChat merchant transfer configuration', async () => {
  const f = fixture()
  const preview = await f.context.getStaffSettlementPreview('sp')
  assert.equal(preview.available, 0.07)
  assert.equal(preview.canSettle, false)
  assert.equal(preview.canSettleManualTail, true)
})

test('creating a manual tail reserves genuine whole earnings and leaves payment outstanding', async () => {
  const f = fixture()
  const result = await f.create()
  assert.equal(result.status, 'pending')
  const request = f.db.state.withdraw_requests[0]
  assert.equal(request.source, 'admin_manual_tail_settlement')
  assert.equal(request.payoutChannel, 'manual')
  assert.equal(request.amount, 0.07)
  assert.equal(request.recipientOpenid, 'staff')
  assert.deepEqual(request.earningIds, ['e1', 'e2'])
  assert.ok(!request.paidAt)
  assert.ok(!request.paymentReference)
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'withdrawing' && row.withdrawRequestId === result.withdrawId))
  assert.deepEqual(f.db.state.staff_earnings.map(row => [row.amount, row.orderId]), [[0.03, 'order1'], [0.04, 'order2']])
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 0)
  assert.equal((f.db.state.wechat_transfer_quota_ledger || []).length, 0)
})

test('manual tail payment needs real-payment confirmation and a reference, then books once', async () => {
  const f = fixture(), result = await f.create()
  await f.approve(result.withdrawId)
  await assert.rejects(f.handler('admin', 'markWithdrawPaid', { id: result.withdrawId }), /实际付款成功.*凭证号/)
  assert.equal(f.db.state.withdraw_requests[0].status, 'approved')
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'withdrawing'))
  await f.pay(result.withdrawId)
  await f.pay(result.withdrawId)
  assert.equal(f.db.state.withdraw_requests[0].paymentChannel, 'MANUAL_CONFIRMED')
  assert.equal(f.db.state.withdraw_requests[0].paymentReference, 'SYNTHETIC-BANK-001')
  assert.equal(f.db.state.withdraw_requests[0].status, 'paid')
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'withdrawn'))
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 1)
  const replay = await f.create()
  assert.equal(replay.withdrawId, result.withdrawId)
  assert.equal(replay.status, 'paid')
  assert.equal(f.db.state.withdraw_requests.length, 1)
})

test('concurrent tail creation reserves one withdrawal for the same operation', async () => {
  const f = fixture()
  require('./optimisticTransactions')(f.db)
  const [first, second] = await Promise.all([f.create(), f.create()])
  assert.equal(first.withdrawId, second.withdrawId)
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_requested').length, 1)
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_approved').length, 0)
})

test('two different tail operations cannot reserve the same earnings', async () => {
  const f = fixture()
  require('./optimisticTransactions')(f.db)
  const results = await Promise.allSettled([f.create(), f.create({ clientRequestId: 'another-operation' })])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.ok(f.db.state.staff_earnings.every(row => row.withdrawRequestId === f.db.state.withdraw_requests[0]._id))
})

for (const status of ['pending', 'frozen', 'withdrawing']) {
  test(`other ${status} earnings must be resolved before creating a manual final tail`, async () => {
    const f = fixture()
    f.db.state.staff_earnings.push({ _id: 'blocked', staffOpenid: 'staff', amount: 0.01, status })
    await assert.rejects(f.create(), /待结算.*冻结.*在途提现/)
    assert.equal(f.db.state.withdraw_requests.length, 0)
    assert.equal(f.db.state.staff_earnings[0].status, 'available')
  })
}

test('an unresolved historical transfer must be handled before manual tail creation', async () => {
  const f = fixture({ withdraw_requests: [{ _id: 'old', staffOpenid: 'staff', payoutChannel: 'wechat_wallet', status: 'transferring', amount: 0.07, transferStatus: 'unknown' }] })
  await assert.rejects(f.create(), /在途提现/)
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'available'))
})

test('reviewed amount changes and the ten-fen boundary do not reserve money', async () => {
  const f = fixture()
  await assert.rejects(f.create({ expectedAmount: 0.06 }), /余额已变化/)
  await assert.rejects(f.create({ expectedAmount: 0.10 }), /仅处理不足/)
  assert.equal(f.db.state.withdraw_requests.length, 0)
  const run = f.db.runTransaction
  f.db.runTransaction = callback => {
    f.db.state.staff_earnings[0].amount = 0.04
    return run(callback)
  }
  await assert.rejects(f.create(), /收益已变化/)
  assert.equal(f.db.state.withdraw_requests.length, 0)
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'available'))
})

test('manual tail respects existing strict dual review for payment registration', async () => {
  const f = fixture({ system_settings: [{ _id: 'default', finance: { strictDualReview: true } }] })
  const result = await f.create()
  await f.approve(result.withdrawId)
  await assert.rejects(f.pay(result.withdrawId), /审核人与打款出款人不能为同一管理员/)
  assert.equal(f.db.state.withdraw_requests[0].status, 'approved')
  await f.pay(result.withdrawId, 'payer')
  assert.equal(f.db.state.withdraw_requests[0].status, 'paid')
  assert.equal(f.db.state.withdraw_requests[0].paidByOpenid, 'payer')
})

test('registering an actual tail payment completes an exit awaiting already-refunded deposit settlement', async () => {
  const f = fixture({ staff_deposits: [{ _id: 'd', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'sp',
    status: 'refunded', refundStatus: 'success', refundExitPending: true, amount: 500,
    paidAmount: 500, refundedAmount: 500, availableRefundAmount: 0, forfeitedAmount: 0 }] })
  f.db.state.staff_profiles[0].exitStatus = 'approved'
  const result = await f.create()
  await f.approve(result.withdrawId)
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'approved')
  await f.pay(result.withdrawId)
  assert.equal(f.db.state.staff_deposits[0].refundExitPending, false)
  assert.equal(f.db.state.staff_profiles[0].exitStatus, 'exited')
  assert.deepEqual(f.db.state.users.find(row => row.openid === 'staff').roles, ['client'])
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 500)
})

test('rejecting an unpaid manual tail returns the original earnings without recording a payout', async () => {
  const f = fixture(), result = await f.create()
  await f.handler('admin', 'auditWithdrawRequest', { id: result.withdrawId, approved: false })
  assert.ok(f.db.state.staff_earnings.every(row => row.status === 'available' && !row.withdrawRequestId))
  assert.deepEqual(f.db.state.staff_earnings.map(row => row.amount), [0.03, 0.04])
  assert.equal(f.db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 0)
})
