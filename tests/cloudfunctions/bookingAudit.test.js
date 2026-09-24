const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

function setup() {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'client', roles: ['client'], status: 'active', phone: '13800000000' }],
    pets: ['p1', 'p2'].map(_id => ({ _id, openid: 'client', name: _id, species: 'dog' })),
    service_prices: [{ key: 'feed', label: '喂养', price: 29, extraPetRule: 'all', extraPetFee: 10.25, enabled: true }],
    mall_products: [{ _id: 'product', name: 'food', status: 'on_sale', specMode: 'single', price: 20, stock: 10 }]
  })
  return { db, context: createContext({ db, cloud: {} }) }
}

for (const clock of ['00:00', '03:30', '07:59', '08:00', '23:30']) {
  test(`booking sessions keep Beijing dates and advance daily at ${clock}`, () => {
    const { context } = setup()
    const input = { startTime: `2099-12-31 ${clock}`, endTime: '2100-01-03 12:00', durationMinutes: 60 }
    const single = context.buildOrderSessions(input)
    assert.equal(single[0].date, '2099-12-31')
    const sessions = context.buildOrderSessions({ ...input, orderType: 'multi_day', endDate: '2100-01-02' })
    assert.deepEqual(sessions.map(row => row.date), ['2099-12-31', '2100-01-01', '2100-01-02'])
    assert.deepEqual(sessions.map(row => row.startTime), ['2099-12-31', '2100-01-01', '2100-01-02'].map(date => `${date} ${clock}`))
    assert.equal(context.getTodayServiceSession({ serviceSessions: sessions }, `2100-01-01 ${clock}`).index, 2)
  })
}

test('extra pet charges preserve cents in quotes and created orders', async () => {
  const { db } = setup()
  const fn = loadCloudFunction('api', db, 'client')
  const data = { petIds: ['p1', 'p2'], serviceTypes: ['visit_fee', 'feed'], serviceAddress: '地址', addressDetail: '1栋', doorplate: '101', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00' }
  const quote = await fn.main({ module: 'order', action: 'quoteOrder', data })
  assert.equal(quote.ok, true, quote.message)
  assert.equal(quote.data.priceItems.find(row => row.type === 'extra_pet_fee').price, 10.25)
  const order = await fn.main({ module: 'order', action: 'createOrder', data })
  assert.equal(order.ok, true, order.message)
  assert.equal(order.data.payAmount, 69.25)
})

for (const moduleName of ['order', 'mall']) {
  test(`${moduleName}: concurrent retries of one request create only one order`, async () => {
    const { db } = setup()
    optimistic(db)
    const fn = loadCloudFunction('api', db, 'client')
    const data = moduleName === 'order'
      ? { petId: 'p1', serviceTypes: ['visit_fee', 'feed'], serviceAddress: '地址', addressDetail: '1栋', doorplate: '101', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00' }
      : { productId: 'product', quantity: 2, shippingAddress: { contactName: '张三', contactPhone: '13800000000', serviceAddress: '地址', addressDetail: '101' } }
    data.clientRequestId = 'same-request'
    const results = await Promise.all([1, 2].map(() => fn.main({ module: moduleName, action: 'createOrder', data })))
    results.forEach(result => assert.equal(result.ok, true, result.message))
    assert.equal(results[0].data._id, results[1].data._id)
    assert.equal(db.state[moduleName === 'order' ? 'orders' : 'mall_orders'].length, 1)
    if (moduleName === 'order') {
      assert.equal(db.state.order_home_security.length, 1)
      assert.equal(db.state.order_timeline.filter(row => row.type === 'created').length, 1)
    } else {
      assert.equal(db.state.mall_products[0].stock, 8)
    }
  })
}
