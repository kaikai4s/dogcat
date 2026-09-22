const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createRegistry = require('../../cloudfunctions/api/handlers')
const createDatabaseHelpers = require('../../cloudfunctions/api/utils/database')

test('service assembly has no missing dependencies or duplicate exports', () => {
  const originalLoad = Module._load
  const assembled = new Set()
  const contextPath = require.resolve('../../cloudfunctions/api/services/context')
  Module._load = function(request, parent, isMain) {
    const exported = originalLoad.call(this, request, parent, isMain)
    if (parent?.filename !== contextPath || typeof exported !== 'function') return exported
    return dependencies => {
      const checked = new Proxy(dependencies, {
        get(target, name) {
          assert.ok(Object.hasOwn(target, name), `${request}: uninitialized dependency ${String(name)}`)
          assert.notEqual(target[name], undefined, `${request}: undefined dependency ${String(name)}`)
          return target[name]
        }
      })
      const result = exported(checked)
      for (const name of Object.keys(result)) {
        assert.ok(!Object.hasOwn(dependencies, name), `${request}: duplicate export ${name}`)
      }
      assembled.add(request)
      return result
    }
  }
  try {
    const context = createContext({ db: createCollectionStore(), cloud: {} })
    for (const name of ['markOrderPaid', 'createRefundForOrder', 'completeOrderService', 'getHomePageData', 'buildOrderSessions']) {
      assert.equal(typeof context[name], 'function')
    }
    assert.ok(assembled.size > 40)
  } finally {
    Module._load = originalLoad
  }
})

test('payment protocol service works independently of cloud SDK and database', () => {
  const service = require('../../cloudfunctions/api/services/wechatPay')({
    crypto: require('node:crypto'),
    https: {},
    safeText: value => value == null ? '' : String(value)
  })
  assert.equal(service.amountYuanToFen(12.34), 1234)
  assert.throws(() => service.amountYuanToFen(-1), /支付金额不正确/)
  const payload = { appid: 'app', mchid: 'merchant', out_trade_no: 'P1', amount: { total: 1234 } }
  const order = { payAmount: 12.34 }
  const payment = { paymentNo: 'P1', amount: 12.34 }
  const config = { appId: 'app', mchId: 'merchant' }
  assert.doesNotThrow(() => service.validatePaymentCallbackPayload(payload, order, payment, config))
  assert.throws(() => service.validatePaymentCallbackPayload({ ...payload, amount: { total: 1 } }, order, payment, config), /金额不匹配/)
})

test('all business modules resolve explicit dependencies and reject inherited routes', () => {
  const db = createCollectionStore()
  const context = createContext({ db, cloud: {} })
  const checked = new Proxy(context, {
    get(target, name) {
      assert.ok(Object.hasOwn(target, name), `Missing dependency: ${String(name)}`)
      assert.notEqual(target[name], undefined, `Undefined dependency: ${String(name)}`)
      return target[name]
    }
  })
  const registry = createRegistry(checked)
  const directory = path.resolve(__dirname, '../../cloudfunctions/api/handlers')
  const modules = fs.readdirSync(directory).filter(name => name.endsWith('.js') && name !== 'index.js')
  assert.equal(modules.length, 25)
  for (const file of modules) {
    const name = path.basename(file, '.js')
    assert.equal(typeof registry(name), 'function', name)
    assert.equal(registry(name), registry(name))
  }
  for (const name of ['constructor', 'toString', '__proto__', 'missing']) assert.equal(registry(name), null)
  assert.equal(typeof require('../../cloudfunctions/api/services/paymentCallback')(checked), 'function')
  assert.equal(typeof require('../../cloudfunctions/api/scheduled')(checked), 'function')
})

test('handler factories isolate database dependencies across API instances', async () => {
  const firstDb = createCollectionStore()
  const secondDb = createCollectionStore()
  const first = loadCloudFunction('api', firstDb, 'first')
  const second = loadCloudFunction('api', secondDb, 'second')
  await first.main({ module: 'auth', action: 'login', data: {} })
  await second.main({ module: 'auth', action: 'login', data: {} })
  assert.ok(firstDb.state.users.some(user => user.openid === 'first'))
  assert.ok(secondDb.state.users.some(user => user.openid === 'second'))
  assert.ok(!firstDb.state.users.some(user => user.openid === 'second'))
})

test('payment RPC rejects forged internal flags even without OPENID', async () => {
  const db = { collection() { throw new Error('Database must not be touched') } }
  for (const openid of ['client', '']) {
    const fn = loadCloudFunction('api', db, openid)
    const result = await fn.main({ module: 'payment', action: 'paymentCallback', data: { _isInternalHttpCallback: true } })
    assert.equal(result.ok, false)
    assert.match(result.message, /仅限 HTTP/)
  }
})

test('client cannot forge HTTP or timer events', async () => {
  const db = { collection() { throw new Error('Database must not be touched') } }
  const fn = loadCloudFunction('api', db, 'client')
  for (const event of [{ httpMethod: 'POST', body: '{}' }, { Type: 'Timer' }]) {
    const result = await fn.main(event)
    assert.equal(result.ok, false)
    assert.match(result.message, /客户端不可触发/)
  }
})

test('pagination reads 250 documents with identical timestamps', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ _id: `id_${String(i).padStart(3, '0')}`, createdAt: '2026-09-01' }))
  const db = createCollectionStore({ records: rows })
  const { getAllDocuments } = createDatabaseHelpers({ db, safeText: String })
  const records = await getAllDocuments('records')
  assert.equal(records.length, 250)
  assert.equal(new Set(records.map(row => row._id)).size, 250)
  assert.deepEqual(records, rows)
})

test('scheduled runner preserves all tasks and previous-month catchup', async () => {
  const calls = []
  const task = name => async () => { calls.push(name); return [] }
  const run = require('../../cloudfunctions/api/scheduled')({
    cancelUnpaidOrders: task('cancel'),
    reconcilePendingRefunds: async () => {},
    retryFailedSubscriptions: async () => {},
    expireDueUnacceptedOrders: task('expire'),
    sendUpcomingServiceRemindersToStaff: task('remind'),
    processOverdueUnstartedOrders: task('unstarted'),
    processOverdueUnfinishedOrders: task('unfinished'),
    getMonthDays: () => 31,
    toCstParts: () => ({ dayNumber: 1, monthKey: '2026-01', month: '01', year: 2026 }),
    settlePetBeautyMonthlyRanking: async (month, options) => { calls.push([month, options.source]); return { monthKey: month } }
  })
  const result = await run()
  assert.deepEqual(calls, ['cancel', 'expire', 'remind', 'unstarted', 'unfinished', ['2025-12', 'timer_catchup']])
  assert.equal(result.petBeautySettled.monthKey, '2025-12')
  assert.equal(result.expired, true)
})
