const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createTransfers = require('../../cloudfunctions/api/services/wechatTransfers')
const token = require('../../cloudfunctions/api/utils/mallProductVersion')

function transferFixture(reply) {
  const calls = [], failures = []
  const db = createCollectionStore({ withdraw_requests: [{ _id: 'w', assetType: 'user', status: 'approved',
    payoutChannel: 'wechat_wallet', amount: 10, recipientOpenid: 'client', outBillNo: 'ORIGINAL-BILL', transferStatus: 'queued' }] })
  const service = createTransfers({ db, crypto, now: () => new Date(), safeText: value => String(value || ''),
    getSystemSettings: async () => ({}), getWechatTransferConfig: () => ({ mchId: 'merchant', appId: 'app', transferMaxAmount: 200, transferSceneId: '1005' }),
    wechatPayRequest: async (method, path, body) => { calls.push({ method, path, body }); return reply(method, path, body) },
    encryptWechatTransferUserName: () => '', sanitizeWechatTransferPayload: value => value,
    markWechatWithdrawalPaid: async () => {}, markWechatWithdrawalFailed: async (...args) => { failures.push(args); return {} },
    prepareWechatSubmissionQuota: async () => {} })
  return { db, service, calls, failures }
}

test('transfer response parsing failures preserve unknown state and never release payment quota', async () => {
  const f = transferFixture(() => { throw new Error('微信支付响应解析失败') })
  await f.service.submitWechatWithdrawalTransfer('w')
  assert.equal(f.db.state.withdraw_requests[0].transferStatus, 'unknown')
  assert.equal(f.db.state.withdraw_requests[0].status, 'transferring')
  assert.equal(f.failures.length, 0)
})

test('scheduled recovery resubmits an explicitly missing transfer using its original bill and amount', async () => {
  const f = transferFixture(method => {
    if (method === 'GET') throw Object.assign(new Error('not found'), { code: 'RESOURCE_NOT_EXISTS' })
    return { state: 'PROCESSING', transfer_bill_no: 'wechat-bill' }
  })
  await f.service.reconcileWechatTransfers()
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST'])
  assert.equal(f.calls[1].body.out_bill_no, 'ORIGINAL-BILL')
  assert.equal(f.calls[1].body.transfer_amount, 1000)
  assert.equal(f.db.state.withdraw_requests[0].outBillNo, 'ORIGINAL-BILL')
  assert.equal(f.db.state.withdraw_requests[0].transferStatus, 'processing')
})

test('query network failures do not resubmit or mark an authorized transfer failed', async () => {
  const f = transferFixture(() => { throw Object.assign(new Error('connection interrupted'), { code: 'ECONNRESET' }) })
  await f.service.reconcileWechatTransfers()
  assert.deepEqual(f.calls.map(call => call.method), ['GET'])
  assert.equal(f.failures.length, 0)
  assert.equal(f.db.state.withdraw_requests[0].status, 'approved')
})

test('only an explicit terminal gateway result enters the transfer failure settlement', async () => {
  const f = transferFixture(() => ({}))
  await f.service.applyWechatTransferResult('w', { state: 'FAIL', fail_reason: '账户异常' })
  assert.equal(f.failures.length, 1)
  assert.equal(f.failures[0][1].state, 'FAIL')
  assert.equal(f.failures[0][1].gatewayTerminalConfirmed, true)
})

test('a changed transfer merchant cannot query or resubmit an intent under another merchant', async () => {
  const f = transferFixture(() => ({}))
  f.db.state.withdraw_requests[0].transferMchId = 'previous-merchant'
  await f.service.reconcileWechatTransfers()
  assert.equal(f.calls.length, 0)
  assert.match(f.db.state.withdraw_requests[0].lastTransferError, /商户或小程序配置已变化/)
})

test('legacy submitted transfers without original merchant identity require review rather than blind resubmission', async () => {
  const f = transferFixture(() => { throw Object.assign(new Error('not found'), { code: 'RESOURCE_NOT_EXISTS' }) })
  f.db.state.withdraw_requests[0].transferSubmittedAt = new Date()
  await f.service.reconcileWechatTransfers()
  assert.deepEqual(f.calls.map(call => call.method), ['GET'])
  assert.match(f.db.state.withdraw_requests[0].lastTransferError, /原商户信息/)
  await assert.rejects(f.service.retryWechatWithdrawalTransfer('w', { openid: 'admin' }), /原商户信息/)
  assert.equal(f.calls.length, 1)
})

test('legacy failure labels cannot release earnings until gateway failure has actually been confirmed', async () => {
  const db = createCollectionStore({ withdraw_requests: [{ _id: 'w', assetType: 'user', userOpenid: 'client', amount: 10,
    payoutChannel: 'wechat_wallet', earningIds: ['e'], status: 'transfer_failed' }],
    user_asset_earnings: [{ _id: 'e', userOpenid: 'client', amount: 10, status: 'withdrawing', withdrawRequestId: 'w' }] })
  const context = createContext({ db, cloud: {} })
  await assert.rejects(context.releaseUserAssetWithdrawal({ openid: 'admin' }, { id: 'w' }), /确认微信转账已失败/)
  assert.equal(db.state.user_asset_earnings[0].status, 'withdrawing')
  db.state.withdraw_requests[0].gatewayFailureConfirmed = true
  await context.releaseUserAssetWithdrawal({ openid: 'admin' }, { id: 'w' })
  assert.equal(db.state.user_asset_earnings[0].status, 'available')
})

function mallFixture() {
  const product = { _id: 'p', name: '宠物用品', coverFileId: 'cloud://product/image', status: 'on_sale',
    specMode: 'single', price: 10, originalPrice: 12, stock: 8, salesCount: 2,
    skus: [{ skuId: 'default', price: 10, stock: 8, salesCount: 2 }] }
  const db = createCollectionStore({ users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }], mall_products: [product] }, { cloudObjectUpdates: true })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  context.checkImageSecurity = async () => {}
  const handler = require('../../cloudfunctions/api/handlers/adminMall')(context)
  return { db, context, handler, product }
}

test('a stale product form cannot overwrite stock changed by an intervening order', async () => {
  const f = mallFixture()
  const list = await f.handler('admin', 'listProducts', {})
  const form = list.list[0]
  await f.db.collection('mall_products').doc('p').update({ data: { stock: 7, skus: [{ skuId: 'default', price: 10, stock: 7, salesCount: 2 }] } })
  await assert.rejects(f.handler('admin', 'saveProduct', { ...form, id: 'p', name: '修改说明' }), /库存已变化/)
  assert.equal(f.db.state.mall_products[0].stock, 7)
  assert.equal(f.db.state.mall_products[0].name, '宠物用品')
})

test('a current product edit preserves ledger sales counts and invalidates the old edit token', async () => {
  const f = mallFixture()
  f.db.state.mall_products[0].createdAt = new Date('2025-01-01T00:00:00Z')
  const before = token(f.db.state.mall_products[0])
  const result = await f.handler('admin', 'saveProduct', { ...f.product, id: 'p', editToken: before, name: '新名称', salesCount: 0 })
  assert.equal(result.name, '新名称')
  assert.equal(f.db.state.mall_products[0].stock, 8)
  assert.equal(f.db.state.mall_products[0].salesCount, 2)
  assert.equal(f.db.state.mall_products[0].skus[0].salesCount, 2)
  assert.equal(new Date(f.db.state.mall_products[0].createdAt).toISOString(), '2025-01-01T00:00:00.000Z')
  assert.notEqual(token(f.db.state.mall_products[0]), before)
})

test('competing inventory compensations restore an order exactly once', async () => {
  const f = mallFixture()
  require('./optimisticTransactions')(f.db)
  f.db.state.mall_orders = [{ _id: 'o', paymentStatus: 'refunded', stockRestorePending: true,
    items: [{ productId: 'p', skuId: 'default', quantity: 2 }] }]
  const inventory = require('../../cloudfunctions/api/services/mallRefundInventory')(f.context)
  const results = await Promise.all([inventory.restorePendingStock('o'), inventory.restorePendingStock('o')])
  assert.equal(results.filter(result => result.restored).length, 1)
  assert.equal(f.db.state.mall_products[0].stock, 10)
  assert.equal(f.db.state.mall_products[0].salesCount, 0)
  assert.equal(f.db.state.mall_orders[0].stockRestorePending, false)
})

test('a concurrent product edit and stock deduction preserve the deduction without stale form overwrite', async () => {
  const f = mallFixture()
  require('./optimisticTransactions')(f.db)
  const editToken = token(f.db.state.mall_products[0])
  const results = await Promise.allSettled([
    f.handler('admin', 'saveProduct', { ...f.product, id: 'p', editToken, name: '新名称' }),
    f.db.runTransaction(async tx => {
      const product = (await tx.collection('mall_products').doc('p').get()).data
      await tx.collection('mall_products').doc('p').update({ data: { stock: product.stock - 1,
        skus: product.skus.map(sku => ({ ...sku, stock: sku.stock - 1 })) } })
    })
  ])
  assert.equal(results[1].status, 'fulfilled')
  if (results[0].status === 'rejected') assert.match(results[0].reason.message, /库存已变化/)
  assert.equal(f.db.state.mall_products[0].stock, 7)
  assert.equal(f.db.state.mall_products[0].skus[0].stock, 7)
})

test('refund inventory compensation can recover later and remains idempotent', async () => {
  const f = mallFixture()
  f.db.state.mall_orders = [{ _id: 'o', paymentStatus: 'refunded', stockRestorePending: true,
    items: [{ productId: 'p', skuId: 'retired', quantity: 2 }] }]
  const inventory = require('../../cloudfunctions/api/services/mallRefundInventory')(f.context)
  await inventory.restorePendingStock('o')
  assert.equal(f.db.state.mall_orders[0].paymentStatus, 'refunded')
  assert.equal(f.db.state.mall_orders[0].stockRestorePending, true)
  assert.match(f.db.state.mall_orders[0].stockRestoreError, /规格不存在/)
  assert.equal(f.db.state.mall_products[0].stock, 8)
  // Once the historical SKU is restored, the existing inventory intent recovers.
  f.db.state.mall_products[0].skus[0].skuId = 'retired'
  await inventory.retryPendingStock()
  assert.equal(f.db.state.mall_orders[0].stockRestorePending, false)
  assert.equal(f.db.state.mall_orders[0].stockRestored, true)
  assert.equal(f.db.state.mall_products[0].stock, 10)
  await inventory.restorePendingStock('o')
  assert.equal(f.db.state.mall_products[0].stock, 10)
})

for (const approved of [false, true]) {
  test(`a stale ${approved ? 'return approval' : 'refund rejection'} cannot overwrite a completed refund`, async () => {
    const f = mallFixture()
    f.db.state.mall_orders = [{ _id: 'o', status: 'refund_applied', preRefundStatus: 'pending_ship',
      refundStatus: 'applied', afterSaleType: 'return_and_refund', paymentStatus: 'paid' }]
    f.context.checkTextSecurity = async () => {
      Object.assign(f.db.state.mall_orders[0], { status: 'refunded', refundStatus: 'full_refunded', paymentStatus: 'refunded' })
    }
    const handler = require('../../cloudfunctions/api/handlers/adminMall')(f.context)
    await assert.rejects(handler('admin', 'auditRefund', { id: 'o', approved, remark: '审核意见' }), /售后状态已变化/)
    assert.equal(f.db.state.mall_orders[0].refundStatus, 'full_refunded')
    assert.equal(f.db.state.mall_orders[0].status, 'refunded')
  })
}

test('monthly scheduling settles only the previous month, including year rollover and delayed recovery', async () => {
  for (const day of [{ year: 2026, month: '10', monthKey: '2026-10', dayNumber: 31, previous: '2026-09' },
    { year: 2027, month: '01', monthKey: '2027-01', dayNumber: 5, previous: '2026-12' }]) {
    const settled = [], noop = async () => []
    const run = require('../../cloudfunctions/api/scheduled')({ cancelUnpaidOrders: noop, expireDueUnacceptedOrders: noop,
      sendUpcomingServiceRemindersToStaff: noop, processOverdueUnfinishedOrders: noop, processOverdueUnstartedOrders: noop,
      toCstParts: () => day, settlePetBeautyMonthlyRanking: async month => { settled.push(month) } })
    await run()
    assert.deepEqual(settled, [day.previous])
  }
})

test('due group queries exclude formed history and retain legacy unformed groups', async () => {
  const db = createCollectionStore({ pet_playground_groups: [
    ...Array.from({ length: 250 }, (_, i) => ({ _id: 'formed_' + i, status: 'formed', formedAt: 1, deadline: 1 })),
    { _id: 'recruiting', status: 'recruiting', formedAt: 0, deadline: 1, members: [] },
    { _id: 'legacy', deadline: 1, members: [] }
  ] })
  const collection = db.collection.bind(db), returned = []
  db.collection = name => {
    const col = collection(name)
    if (name !== 'pet_playground_groups') return col
    const where = col.where.bind(col)
    col.where = condition => {
      const query = where(condition), get = query.get.bind(query)
      query.get = async () => { const result = await get(); returned.push(...result.data); return result }
      return query
    }
    return col
  }
  await require('../../cloudfunctions/api/services/playground-group-buy')({ db }).expireDueGroupBuys(1000)
  assert.equal(returned.length, 2)
  assert.equal(db.state.pet_playground_groups.find(row => row._id === 'recruiting').status, 'cancelled')
  assert.equal(db.state.pet_playground_groups.find(row => row._id === 'legacy').status, 'cancelled')
})

test('public completed-order projection checks deletion before loading related content', () => {
  const source = fs.readFileSync(require.resolve('../../cloudfunctions/api/handlers/order'), 'utf8')
  const detail = source.slice(source.indexOf("if (action === 'getPublicCompletedOrderDetail')"))
  assert.match(detail.slice(0, detail.indexOf('const [reviewRes')), /isAdminDeletedOrder\(order\)/)
})
