const test = require('node:test')
const assert = require('node:assert/strict')
const root = require('node:path').resolve(__dirname, '../..')
const { createCollectionStore, loadCloudFunction } = require(root + '/tests/cloudfunctions/helpers')
const createContext = require(root + '/cloudfunctions/api/services/context')
const createTransfers = require(root + '/cloudfunctions/api/services/wechatTransfers')
const optimistic = require('./optimisticTransactions')

test('late processing and failure results cannot downgrade a paid withdrawal', async () => {
  const db = createCollectionStore({
    withdraw_requests: [{ _id: 'withdraw', staffOpenid: 'staff', recipientOpenid: 'staff', payoutChannel: 'wechat_wallet', status: 'transferring', amount: 1, amountFen: 100, earningIds: ['earning'], outBillNo: 'WD-test' }],
    staff_earnings: [{ _id: 'earning', staffOpenid: 'staff', amount: 1, status: 'withdrawing', withdrawRequestId: 'withdraw' }]
  })
  const context = createContext({ db, cloud: {} })
  await context.applyWechatTransferResult('withdraw', { state: 'SUCCESS', transfer_bill_no: 'WX-test' })
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
  assert.equal(db.state.staff_earnings[0].status, 'withdrawn')
  await context.applyWechatTransferResult('withdraw', { state: 'ACCEPTED', transfer_bill_no: 'WX-test' })
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
  await context.applyWechatTransferResult('withdraw', { state: 'FAIL', transfer_bill_no: 'WX-test' })
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
  await context.applyWechatTransferResult('withdraw', { state: 'SUCCESS', transfer_bill_no: 'WX-test' })
  assert.equal(db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 1)
})

test('expiration preserves a successful refund terminal state', async () => {
  const db = createCollectionStore({ orders: [{ _id: 'order', clientOpenid: 'client', status: 'paid', paymentStatus: 'paid', payAmount: 100, paymentNo: 'payment', startTime: '2000-01-01 10:00', endTime: '2000-01-01 11:00' }] })
  const context = createContext({ db, cloud: {} })
  const refunds = require(root + '/cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }), getWechatPayConfig: () => ({}),
    wechatPayRequest: async (method, path, body) => ({ status: 'SUCCESS', out_refund_no: body.out_refund_no, refund_id: 'gateway-refund', amount: body.amount })
  })
  const expire = require(root + '/cloudfunctions/api/scheduled/expireOrders')({ ...context, createRefundForOrder: refunds.requestOrderRefund })
  await expire.expireUnacceptedOrder('order', structuredClone(db.state.orders[0]))
  assert.equal(db.state.refunds[0].status, 'success')
  assert.equal(db.state.orders[0].refundedAmount, 100)
  assert.equal(db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(db.state.orders[0].refundStatus, 'full_refunded')
  await refunds.refreshOrderRefunds([db.state.orders[0]])
  assert.equal(db.state.orders[0].paymentStatus, 'refunded')
})

test('service start rejects missing or invalid GPS and accepts a valid nearby position', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'order', staffOpenid: 'staff', staffUserId: 'staff', clientOpenid: 'client', status: 'assigned', paymentStatus: 'paid', addressLatitude: 31.2, addressLongitude: 121.5, startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date(Date.now() + 3600000).toISOString(), requiredCheckins: [] }]
  })
  const api = loadCloudFunction('api', db, 'staff')
  for (const location of [{}, { currentLatitude: null, currentLongitude: null }, { currentLatitude: 'invalid', currentLongitude: 121.5 }, { currentLatitude: 91, currentLongitude: 121.5 }, { currentLatitude: 31.2, currentLongitude: 181 }]) {
    const result = await api.main({ module: 'order', action: 'startService', data: { id: 'order', ...location } })
    assert.equal(result.ok, false)
    assert.match(result.message, /有效当前位置/)
    assert.equal(db.state.orders[0].status, 'assigned')
  }
  const distant = await api.main({ module: 'order', action: 'startService', data: { id: 'order', currentLatitude: 32.2, currentLongitude: 121.5 } })
  assert.equal(distant.ok, false)
  assert.match(distant.message, /请到达服务地址附近/)
  const valid = await api.main({ module: 'order', action: 'startService', data: { id: 'order', currentLatitude: 31.2, currentLongitude: 121.5 } })
  assert.equal(valid.ok, true, valid.message)
  assert.equal(db.state.orders[0].status, 'in_service')
  assert.equal(db.state.orders[0].startDistanceKm, 0)
})

test('sanitization photo download failures reject evidence', async () => {
  const db = createCollectionStore()
  const context = createContext({ db, cloud: { downloadFile: async () => { throw new Error('file does not exist') } } })
  await assert.rejects(context.validateSanitizationMedia('cloud://bucket/non-existent.jpg', 'order', 'staff'), /file does not exist/)
})

test('transfer reconciliation rotates waiting records so later approved requests get checked', async () => {
  const db = createCollectionStore({ withdraw_requests: Array.from({ length: 11 }, (_, i) => ({ _id: `withdraw-${i}`, status: 'approved', payoutChannel: 'wechat_wallet', outBillNo: `WD-${i}`, amount: 1 })) })
  const context = createContext({ db, cloud: {} })
  const queried = []
  const transfers = createTransfers({ ...context, getSystemSettings: async () => ({}), getWechatTransferConfig: () => ({}),
    wechatPayRequest: async (method, path) => { queried.push(path); return { state: 'WAIT_USER_CONFIRM', package_info: 'test-package' } }
  })
  await transfers.reconcileWechatTransfers(10)
  await transfers.reconcileWechatTransfers(10)
  assert.equal(queried.length, 20)
  assert.equal(db.state.withdraw_requests[10].status, 'transferring')
  assert.equal(queried.some(path => path.endsWith('/WD-10')), true)
})

test('concurrent processing and success responses finish with one paid ledger entry', async () => {
  const db = createCollectionStore({
    withdraw_requests: [{ _id: 'withdraw', staffOpenid: 'staff', recipientOpenid: 'staff', payoutChannel: 'wechat_wallet', status: 'transferring', amount: 1, amountFen: 100, earningIds: ['earning'], outBillNo: 'WD-test' }],
    staff_earnings: [{ _id: 'earning', staffOpenid: 'staff', amount: 1, status: 'withdrawing', withdrawRequestId: 'withdraw' }]
  })
  optimistic(db)
  const context = createContext({ db, cloud: {} })
  await Promise.all([
    context.applyWechatTransferResult('withdraw', { state: 'SUCCESS', transfer_bill_no: 'WX-test' }),
    context.applyWechatTransferResult('withdraw', { state: 'WAIT_USER_CONFIRM', package_info: 'old-package' })
  ])
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
  assert.equal(db.state.withdraw_requests[0].transferStatus, 'success')
  assert.equal(db.state.staff_earnings[0].status, 'withdrawn')
  assert.equal(db.state.finance_logs.filter(row => row.action === 'withdraw_paid').length, 1)
})

test('processing responses never reopen paid, released or failed requests for staff or user assets', async () => {
  for (const assetType of ['staff', 'user']) {
    for (const status of ['paid', 'rejected', 'transfer_failed']) {
      const db = createCollectionStore({ withdraw_requests: [{ _id: 'withdraw', assetType, staffOpenid: 'staff', userOpenid: 'user', status, payoutChannel: 'wechat_wallet', transferStatus: status === 'rejected' ? 'released' : 'success' }] })
      const context = createContext({ db, cloud: {} })
      const before = structuredClone(db.state.withdraw_requests[0])
      const result = await context.applyWechatTransferResult('withdraw', { state: 'ACCEPTED' })
      assert.equal(result.changed, false)
      assert.deepEqual(db.state.withdraw_requests[0], before)
      if (status !== 'transfer_failed') {
        await context.applyWechatTransferResult('withdraw', { state: 'FAIL' })
        assert.deepEqual(db.state.withdraw_requests[0], before)
      }
    }
  }
})

test('late submission timeouts cannot overwrite payment already confirmed by a concurrent query', async () => {
  const db = createCollectionStore({
    withdraw_requests: [{ _id: 'withdraw', staffOpenid: 'staff', recipientOpenid: 'staff', payoutChannel: 'wechat_wallet', status: 'approved', amount: 1, amountFen: 100, earningIds: ['earning'], outBillNo: 'WD-test' }],
    staff_earnings: [{ _id: 'earning', staffOpenid: 'staff', amount: 1, status: 'withdrawing', withdrawRequestId: 'withdraw' }]
  })
  const context = createContext({ db, cloud: {} })
  const transfers = createTransfers({ ...context, getSystemSettings: async () => ({}),
    getWechatTransferConfig: () => ({ appId: 'app', mchId: 'mch', transferMaxAmount: 200, transferSceneId: '1005' }),
    wechatPayRequest: async () => {
      await context.markWechatWithdrawalPaid('withdraw', { state: 'SUCCESS', transferBillNo: 'WX-test' })
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    }
  })
  const result = await transfers.submitWechatWithdrawalTransfer('withdraw')
  assert.equal(result.request.status, 'paid')
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
  assert.equal(db.state.staff_earnings[0].status, 'withdrawn')
})

test('permanently failing transfer queries also rotate out of the next batch', async () => {
  const db = createCollectionStore({ withdraw_requests: Array.from({ length: 21 }, (_, i) => ({ _id: `withdraw-${String(i).padStart(2, '0')}`, status: 'transferring', payoutChannel: 'wechat_wallet', outBillNo: `WD-${i}`, amount: 1 })) })
  const context = createContext({ db, cloud: {} })
  const queried = new Set()
  const transfers = createTransfers({ ...context, now: () => new Date('2026-10-22T02:00:00Z'), getSystemSettings: async () => ({}), getWechatTransferConfig: () => ({}),
    wechatPayRequest: async (method, path) => { queried.add(path); throw new Error('gateway unavailable') }
  })
  for (let i = 0; i < 3; i++) await transfers.reconcileWechatTransfers(10)
  assert.equal(queried.size, 21)
})

test('expiration also preserves terminal refund failures and successful group refund states', async () => {
  for (const status of ['SUCCESS', 'CLOSED']) {
    const db = createCollectionStore({
      orders: [{ _id: 'order', groupBuyId: 'group', clientOpenid: 'client', status: 'paid', paymentStatus: 'paid', payAmount: 100, paymentNo: 'payment', startTime: '2000-01-01 10:00', endTime: '2000-01-01 11:00' }],
      pet_playground_groups: [{ _id: 'group', status: 'formed' }]
    })
    const context = createContext({ db, cloud: {} })
    const refunds = require(root + '/cloudfunctions/api/services/refunds')({ ...context,
      getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }), getWechatPayConfig: () => ({}),
      wechatPayRequest: async (method, path, body) => ({ status, out_refund_no: body.out_refund_no, refund_id: 'gateway-refund', amount: body.amount })
    })
    const expire = require(root + '/cloudfunctions/api/scheduled/expireOrders')({ ...context, createRefundForOrder: refunds.requestOrderRefund })
    await expire.expireUnacceptedOrder('order', structuredClone(db.state.orders[0]))
    assert.equal(db.state.refunds[0].status, status === 'SUCCESS' ? 'success' : 'failed')
    assert.equal(db.state.orders[0].paymentStatus, status === 'SUCCESS' ? 'refunded' : 'paid')
    assert.equal(db.state.orders[0].refundStatus, status === 'SUCCESS' ? 'full_refunded' : 'failed')
    assert.equal(db.state.orders[0].groupBuyStatus, 'cancelled')
  }
})

test('sanitization media requires a downloaded image and accepts valid image headers', async () => {
  for (const cloud of [{}, { downloadFile: async () => ({}) }, { downloadFile: async () => ({ fileContent: 'not-a-buffer' }) }, { downloadFile: async () => ({ fileContent: Buffer.from('not an image') }) }]) {
    const context = createContext({ db: createCollectionStore(), cloud })
    await assert.rejects(context.validateSanitizationMedia('cloud://bucket/photo.jpg', 'order', 'staff'), /照片验证暂不可用|有效图片/)
  }
  const context = createContext({ db: createCollectionStore(), cloud: { downloadFile: async () => ({ fileContent: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGfoAAAAASUVORK5CYII=', 'base64') }) } })
  await assert.doesNotReject(context.validateSanitizationMedia('cloud://bucket/photo.jpg', 'order', 'staff'))
})
