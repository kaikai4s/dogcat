const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createService = require('../../cloudfunctions/api/services/withdrawals')
const validation = require('../../cloudfunctions/api/utils/validation')

function setup(count = 2) {
  const db = createCollectionStore({
    staff_earnings: Array.from({ length: count }, (_, i) => ({ _id: `e${String(i).padStart(3, '0')}`, staffOpenid: 'staff', status: 'available', amount: 10 })),
    withdraw_requests: [], finance_logs: []
  })
  const service = createService({
    db, crypto: require('node:crypto'), ...validation,
    findByClientRequestId: async () => null,
    getUser: async () => ({}), refreshStaffEarnings: async () => {},
    getSystemSettings: async () => ({ settlement: { minWithdrawAmount: 10 } }), now: () => new Date()
  })
  const originalCreate = service.createWithdrawRequest
  const wrappedCreate = (openid, data = {}) => {
    return originalCreate(openid, {
      accountName: data.accountName !== undefined ? data.accountName : '测试宠托师',
      accountNo: data.accountNo !== undefined ? data.accountNo : '6222021234567890',
      ...data
    })
  }
  return { db, ...service, createWithdrawRequest: wrappedCreate, rawCreateWithdrawRequest: originalCreate }
}

test('concurrent withdrawal requests can reserve each earning only once', async () => {
  const { db, createWithdrawRequest } = setup()
  const results = await Promise.allSettled([
    createWithdrawRequest('staff', { clientRequestId: 'a' }),
    createWithdrawRequest('staff', { clientRequestId: 'b' })
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(db.state.withdraw_requests.length, 1)
  assert.equal(db.state.finance_logs.length, 1)
  assert.ok(db.state.staff_earnings.every(e => e.status === 'withdrawing' && e.withdrawRequestId === db.state.withdraw_requests[0]._id))
})

test('concurrent duplicate IDs and retries return the same committed request', async () => {
  const { db, createWithdrawRequest } = setup()
  const [first, duplicate] = await Promise.all([
    createWithdrawRequest('staff', { clientRequestId: 'same' }),
    createWithdrawRequest('staff', { clientRequestId: 'same' })
  ])
  const retry = await createWithdrawRequest('staff', { clientRequestId: 'same' })
  assert.equal(first._id, duplicate._id)
  assert.equal(first._id, retry._id)
  assert.equal(db.state.withdraw_requests.length, 1)
  assert.equal(db.state.finance_logs.length, 1)
})

for (const failingCollection of ['staff_earnings', 'finance_logs']) {
  test(`failure in ${failingCollection} rolls back request, earnings and log`, async () => {
    const { db, createWithdrawRequest } = setup()
    const originalRun = db.runTransaction
    db.runTransaction = callback => originalRun(transaction => callback({ collection(name) {
      const collection = transaction.collection(name)
      const doc = collection.doc
      collection.doc = id => {
        const record = doc(id)
        if (name === failingCollection && (name !== 'staff_earnings' || id === 'e001')) {
          record.update = record.set = async () => { throw new Error('injected write failure') }
        }
        return record
      }
      return collection
    } }))
    await assert.rejects(createWithdrawRequest('staff', {}), /injected write failure/)
    assert.equal(db.state.withdraw_requests.length, 0)
    assert.equal(db.state.finance_logs.length, 0)
    assert.ok(db.state.staff_earnings.every(e => e.status === 'available'))
  })
}

test('invalid amounts and oversized batches cannot freeze earnings', async () => {
  const { db, createWithdrawRequest } = setup(51)
  for (const amount of [NaN, Infinity, -1, 0, 'bad']) {
    await assert.rejects(createWithdrawRequest('staff', { amount }), /提现金额不正确/)
  }
  await assert.rejects(createWithdrawRequest('staff', {}), /最多包含50笔/)
  assert.equal(db.state.withdraw_requests.length, 0)
  assert.ok(db.state.staff_earnings.every(e => e.status === 'available'))
  const request = await createWithdrawRequest('staff', { amount: 20 })
  assert.equal(request.amount, 20)
  assert.equal(request.earningIds.length, 2)
})

test('transaction revalidates ownership and amount before any writes', async () => {
  for (const mutation of [{ staffOpenid: 'other' }, { amount: 99 }, { status: 'frozen' }, { withdrawRequestId: 'other' }, { frozenIncidentId: 'incident' }]) {
    const { db, createWithdrawRequest } = setup()
    const originalRun = db.runTransaction
    db.runTransaction = callback => {
      db.state.staff_earnings[1] = { ...db.state.staff_earnings[1], ...mutation }
      return originalRun(callback)
    }
    await assert.rejects(createWithdrawRequest('staff', {}), /收益状态已变化/)
    assert.equal(db.state.withdraw_requests.length, 0)
    assert.equal(db.state.staff_earnings[0].status, 'available')
  }
})

test('transaction callback retry does not duplicate request or finance log', async () => {
  const { db, createWithdrawRequest } = setup()
  const run = db.runTransaction
  db.runTransaction = async callback => {
    const discarded = createCollectionStore(structuredClone(db.state))
    await callback({ collection: discarded.collection })
    return run(callback)
  }
  await createWithdrawRequest('staff', { clientRequestId: 'retried' })
  assert.equal(db.state.withdraw_requests.length, 1)
  assert.equal(db.state.finance_logs.length, 1)
})

test('accountName and accountNo validation prevents invalid withdrawal requests', async () => {
  const { rawCreateWithdrawRequest } = setup()
  await assert.rejects(
    rawCreateWithdrawRequest('staff', { accountName: '', accountNo: '6222021234567890' }),
    /请填写正确的提现收款人姓名/
  )
  await assert.rejects(
    rawCreateWithdrawRequest('staff', { accountName: 'a', accountNo: '6222021234567890' }),
    /请填写正确的提现收款人姓名/
  )
  await assert.rejects(
    rawCreateWithdrawRequest('staff', { accountName: '测试宠托师', accountNo: '' }),
    /请填写正确的提现收款账号/
  )
  await assert.rejects(
    rawCreateWithdrawRequest('staff', { accountName: '测试宠托师', accountNo: '123' }),
    /请填写正确的提现收款账号/
  )
})

