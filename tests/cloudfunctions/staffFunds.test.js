const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const admin = { _id: 'admin', openid: 'admin' }

function setup() {
  const db = createCollectionStore({
    users: [{ ...admin, roles: ['admin'], status: 'active' }, { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    staff_profiles: [{ _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified', depositStatus: 'paid' }],
    staff_deposits: [{ _id: 'd', staffOpenid: 'staff', staffUserId: 'staff', staffProfileId: 'profile',
      status: 'paid', paidAmount: 500, amount: 500, availableRefundAmount: 500, refundedAmount: 0, forfeitedAmount: 0 }],
    staff_supply_reimbursements: [{ _id: 's', staffOpenid: 'staff', staffProfileId: 'profile', status: 'pending', amount: 100 }],
    orders: [], order_incidents: [], staff_deposit_events: [], finance_logs: [], admin_operation_logs: []
  })
  return { db, service: createContext({ db, cloud: {} }) }
}
const forfeit = (amount, clientRequestId = 'f') => ({ id: 'd', amount, clientRequestId, reason: '违规核实' })
const proof = { paymentConfirmed: true, paymentReference: 'bank-001' }

test('a sitter can only request one deposit refund at a time', async () => {
  const { db, service } = setup()
  db.state.staff_deposits.push({ ...db.state.staff_deposits[0], _id: 'topup' })
  await service.requestStaffDepositRefund('staff', 'd', '退出')
  await assert.rejects(service.requestStaffDepositRefund('staff', 'topup', '退出'), /退款.*处理中/)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'topup').status, 'paid')
})

test('simultaneous refund requests for different deposits serialize on the sitter profile', async () => {
  const { db, service } = setup()
  db.state.staff_deposits.push({ ...db.state.staff_deposits[0], _id: 'topup' })
  const retries = optimistic(db)
  const results = await Promise.allSettled([
    service.requestStaffDepositRefund('staff', 'd', '退出'),
    service.requestStaffDepositRefund('staff', 'topup', '退出')
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  assert.equal(db.state.staff_deposits.filter(row => row.refundStatus === 'requested').length, 1)
})

test('rejecting the first exit request restores eligibility while preserving an existing repayment restriction', async () => {
  for (const requiresRepayment of [false, true]) {
    const { db, service } = setup()
    Object.assign(db.state.staff_profiles[0], { exitStatus: 'none', requireDepositRepay: requiresRepayment,
      depositStatus: requiresRepayment ? 'supplement_required' : 'paid' })
    await service.requestStaffDepositRefund('staff', 'd', '退出')
    await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: false, reason: '撤回退出' })
    assert.equal(db.state.staff_profiles[0].exitStatus, 'none')
    assert.equal(service.canTakeOrders(db.state.staff_profiles[0]), !requiresRepayment)
  }
})

test('rejecting a historical parallel refund keeps an outstanding refund blocked from taking orders', async () => {
  const { db, service } = setup()
  db.state.staff_deposits.push({ ...db.state.staff_deposits[0], _id: 'other', status: 'refunding', refundStatus: 'processing' })
  Object.assign(db.state.staff_deposits[0], { status: 'refund_requested', refundStatus: 'requested', refundRevision: 1 })
  db.state.staff_profiles[0].exitStatus = 'requested'
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: false, reason: '驳回这一笔' })
  assert.equal(service.canTakeOrders(db.state.staff_profiles[0]), false)
  assert.equal(db.state.staff_profiles[0].exitStatus, 'approved')
})

test('rejecting all parallel admin requests restores orders when no refund has been paid', async () => {
  const { db, service } = setup()
  db.state.staff_deposits.push({ ...db.state.staff_deposits[0], _id: 'topup' })
  // A prior completed exit must not affect this new exit attempt.
  db.state.staff_profiles[0].exitRefundPaid = true
  await service.requestStaffDepositRefund('staff', 'd', '退出', admin)
  await service.requestStaffDepositRefund('staff', 'topup', '退出', admin)
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: false, reason: '撤回退出' })
  assert.equal(service.canTakeOrders(db.state.staff_profiles[0]), false)
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'topup', approved: false, reason: '撤回退出' })
  assert.equal(db.state.staff_profiles[0].exitStatus, 'none')
  assert.equal(service.canTakeOrders(db.state.staff_profiles[0]), true)
})

test('a refund paid after another request was opened still prevents that rejection from reopening orders', async () => {
  const { db, service } = setup()
  db.state.staff_deposits.push({ ...db.state.staff_deposits[0], _id: 'topup' })
  await service.requestStaffDepositRefund('staff', 'd', '退出', admin)
  await service.requestStaffDepositRefund('staff', 'topup', '退出', admin)
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: true })
  await service.settleStaffDeposit(admin, 'confirmDepositRefund', { id: 'd', ...proof })
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'topup', approved: false, reason: '补充资料' })
  assert.equal(db.state.staff_profiles[0].exitStatus, 'approved')
  assert.equal(service.canTakeOrders(db.state.staff_profiles[0]), false)
})

test('rejecting the remaining refund after a partial exit does not reopen order taking', async () => {
  const { db, service } = setup()
  db.state.staff_profiles[0].depositStandardAmount = 600
  db.state.staff_deposits.push({ ...db.state.staff_deposits[0], _id: 'topup', amount: 100, paidAmount: 100, availableRefundAmount: 100 })
  await service.requestStaffDepositRefund('staff', 'topup', '退出')
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'topup', approved: true })
  await service.settleStaffDeposit(admin, 'confirmDepositRefund', { id: 'topup', ...proof })
  assert.equal(db.state.staff_profiles[0].exitStatus, 'approved')
  await service.requestStaffDepositRefund('staff', 'd', '退还剩余余额')
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: false, reason: '需补充退出资料' })
  assert.equal(service.canTakeOrders(db.state.staff_profiles[0]), false)
  assert.equal(db.state.staff_profiles[0].exitStatus, 'approved')
  const retry = await service.requestStaffDepositRefund('staff', 'd', '已补充资料')
  assert.equal(retry.success, true)
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: true })
  await service.settleStaffDeposit(admin, 'confirmDepositRefund', { id: 'd', ...proof })
  assert.equal(db.state.staff_profiles[0].exitStatus, 'exited')
  assert.equal(db.state.staff_profiles[0].auditStatus, 'revoked')
})
async function approveRefund(service) {
  await service.requestStaffDepositRefund('staff', 'd', '退出')
  await service.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'd', approved: true })
}

test('refund approval is not payment; duplicate confirmation records cash only once', async () => {
  const { db, service } = setup()
  await approveRefund(service)
  assert.equal(db.state.staff_deposits[0].status, 'refund_approved')
  assert.equal(db.state.staff_deposits[0].refundedAmount, 0)
  assert.equal(db.state.finance_logs.length, 0)
  const retries = optimistic(db)
  await Promise.all([1, 2].map(() => service.settleStaffDeposit(admin, 'confirmDepositRefund', { id: 'd', ...proof })))
  assert.ok(retries() > 0)
  assert.equal(db.state.staff_deposits[0].refundedAmount, 500)
  assert.equal(db.state.finance_logs.length, 1)
  assert.equal(db.state.staff_profiles[0].exitStatus, 'exited')
  await assert.rejects(service.settleStaffDeposit(admin, 'confirmDepositRefund', { id: 'd', ...proof, paymentReference: 'different' }), /参数不一致/)
})

test('concurrent forfeitures cannot exceed balance and duplicate IDs do not deduct twice', async () => {
  const { db, service } = setup()
  const retries = optimistic(db)
  const results = await Promise.allSettled([
    service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(300, 'a')),
    service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(300, 'b'))
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  assert.equal(db.state.staff_deposits[0].availableRefundAmount, 200)
  const winner = results[0].status === 'fulfilled' ? 'a' : 'b'
  await service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(300, winner))
  assert.equal(db.state.staff_deposits[0].forfeitedAmount, 300)
  assert.equal(db.state.finance_logs.length, 1)
  await assert.rejects(service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(100, winner)), /参数不一致/)
})

test('refund request and forfeiture serialize without losing either amount', async () => {
  const { db, service } = setup()
  optimistic(db)
  await Promise.allSettled([
    service.requestStaffDepositRefund('staff', 'd', '退出'),
    service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(200))
  ])
  const deposit = db.state.staff_deposits[0]
  assert.equal(deposit.availableRefundAmount + deposit.refundedAmount + deposit.forfeitedAmount, 500)
  assert.equal(deposit.status, 'refund_requested')
  await assert.rejects(service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(100, 'later')), /不可没收/)
})

test('approved refund reserves its entire balance against forfeiture', async () => {
  const { db, service } = setup()
  await approveRefund(service)
  await assert.rejects(service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(1)), /不可没收/)
  assert.equal(db.state.staff_deposits[0].availableRefundAmount, 500)
})

test('late payment callback does not replenish refunded or forfeited money', async () => {
  for (const status of ['refunded', 'forfeited', 'refund_approved', 'refund_requested']) {
    const { db, service } = setup()
    Object.assign(db.state.staff_deposits[0], { status, availableRefundAmount: 0 })
    const before = structuredClone(db.state)
    await service.markStaffDepositPaid('d', { paymentNo: 'old-payment' })
    assert.deepEqual(db.state, before)
  }
})

test('payment confirmation requires explicit evidence and never reports gateway SUCCESS', async () => {
  const { db, service } = setup()
  await service.settleSupplyReimbursement(admin, 'auditSupplyReimbursement', { id: 's', approved: true, approvedAmount: 90 })
  await assert.rejects(service.settleSupplyReimbursement(admin, 'paySupplyReimbursement', { id: 's' }), /付款凭证/)
  const retries = optimistic(db)
  await Promise.all([1, 2].map(() => service.settleSupplyReimbursement(admin, 'paySupplyReimbursement', { id: 's', ...proof })))
  assert.ok(retries() > 0)
  assert.equal(db.state.staff_supply_reimbursements[0].transferStatus, 'MANUAL_CONFIRMED')
  assert.equal(db.state.staff_supply_reimbursements[0].paidAmount, 90)
  assert.equal(db.state.finance_logs.length, 1)
  assert.equal(db.state.finance_logs[0].amountDelta, -90)
})

test('conflicting reimbursement decisions and simultaneous first-time applications have one winner', async () => {
  const { db, service } = setup()
  optimistic(db)
  const results = await Promise.allSettled([
    service.settleSupplyReimbursement(admin, 'auditSupplyReimbursement', { id: 's', approved: true, approvedAmount: 50 }),
    service.settleSupplyReimbursement(admin, 'auditSupplyReimbursement', { id: 's', approved: false, reason: '凭证不符' })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  db.state.staff_supply_reimbursements = []
  const record = { staffOpenid: 'staff', staffProfileId: 'profile', amount: 50, status: 'pending' }
  const submitted = await Promise.allSettled([
    service.submitStaffSupplyOnce({ ...record, clientRequestId: 'a' }),
    service.submitStaffSupplyOnce({ ...record, clientRequestId: 'b' })
  ])
  assert.equal(submitted.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(db.state.staff_supply_reimbursements.length, 1)
})

test('exit checks detect day_completed and unresolved incidents after more than 100 records', async () => {
  for (const collection of ['orders', 'order_incidents']) {
    const { db, service } = setup()
    db.state[collection] = Array.from({ length: 120 }, (_, i) => ({ _id: `history${i}`, staffOpenid: 'staff', status: collection === 'orders' ? 'completed' : 'closed' }))
    db.state[collection].push({ _id: 'active', staffOpenid: 'staff', status: collection === 'orders' ? 'day_completed' : 'waiting_staff' })
    await assert.rejects(service.requestStaffDepositRefund('staff', 'd', '退出'), /未完成订单|客诉或纠纷/)
    assert.equal(db.state.staff_deposits[0].status, 'paid')
  }
})

test('malformed money and inconsistent deposit balances are rejected', async () => {
  for (const amount of [NaN, Infinity, -1, 0, 0.001, 101]) {
    const { service } = setup()
    await assert.rejects(service.settleSupplyReimbursement(admin, 'auditSupplyReimbursement', { id: 's', approved: true, approvedAmount: amount }))
  }
  const { db, service } = setup()
  db.state.staff_deposits[0].availableRefundAmount = 501
  await assert.rejects(service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(1)), /余额不一致/)
})

for (const collection of ['staff_profiles', 'staff_deposit_events', 'finance_logs', 'admin_operation_logs']) {
  test(`deposit operation rolls back all writes when ${collection} fails`, async () => {
    const { db, service } = setup()
    const run = db.runTransaction
    db.runTransaction = callback => run(tx => callback({ collection(name) {
      const coll = tx.collection(name)
      const doc = coll.doc
      coll.doc = id => {
        const record = doc(id)
        if (name === collection) record.set = record.update = async () => { throw new Error('injected failure') }
        return record
      }
      return coll
    } }))
    const before = structuredClone(db.state)
    await assert.rejects(service.settleStaffDeposit(admin, 'forfeitStaffDeposit', forfeit(200)), /injected failure/)
    assert.deepEqual(db.state, before)
  })
}

test('staff cannot invoke any new administrator financial endpoint', async () => {
  const { db } = setup()
  const fn = loadCloudFunction('api', db, 'staff')
  for (const action of ['auditDepositRefund', 'confirmDepositRefund', 'forfeitStaffDeposit', 'auditSupplyReimbursement', 'paySupplyReimbursement']) {
    assert.equal((await fn.main({ module: 'admin', action, data: { id: 'd', ...proof } })).ok, false)
  }
})

test('initial deposit payment is atomic and concurrent callbacks produce one ledger entry', async () => {
  const { db, service } = setup()
  Object.assign(db.state.staff_deposits[0], { status: 'unpaid', paidAmount: 0, availableRefundAmount: 0 })
  const retries = optimistic(db)
  await Promise.all([1, 2].map(() => service.markStaffDepositPaid('d', { paymentNo: 'p' })))
  assert.ok(retries() > 0)
  assert.equal(db.state.staff_deposits[0].paidAmount, 500)
  assert.equal(db.state.finance_logs.length, 1)
  assert.equal(db.state.staff_deposit_events.length, 1)
})

test('withdrawal of staff from service conflicts with a new assignment through the shared user', async () => {
  const { db, service } = setup()
  const order = { _id: 'o', status: 'paid', paymentStatus: 'paid', staffOpenid: '', startTime: '2099-10-01 10:00', endTime: '2099-10-01 11:00' }
  db.state.orders.push(order)
  const retries = optimistic(db)
  const results = await Promise.allSettled([
    service.requestStaffDepositRefund('staff', 'd', '退出'),
    service.assignOrderAtomically('o', structuredClone(order), { staffOpenid: 'staff', staffUserId: 'staff', staffProfileId: 'profile', status: 'assigned' })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  assert.ok(!(db.state.orders[0].status === 'assigned' && db.state.staff_profiles[0].exitStatus === 'requested'))
})
