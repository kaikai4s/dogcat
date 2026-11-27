const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

function terminatedSecurityFixture(status = 'cancelled') {
  const security = { type: 'one_time_code', oneTimeCode: { cipher: 'unified', iv: 'iv', tag: 'tag' },
    sessionCodes: [{ sessionIndex: 1, cipher: 'one' }, { sessionIndex: 2, cipher: 'two' }] }
  const db = createCollectionStore({ orders: [{ _id: 'multi', status, orderType: 'multi_day',
    startTime: '2099-01-01 10:00', endTime: '2099-01-02 11:00',
    serviceSessions: [{ index: 1, startTime: '2099-01-01 10:00', endTime: '2099-01-01 11:00' },
      { index: 2, startTime: '2099-01-02 10:00', endTime: '2099-01-02 11:00' }],
    orderHomeSecurity: security, homeSecurityCleanupPending: true }],
    order_home_security: [{ _id: 'sec', orderId: 'multi', ...security }] })
  require('./optimisticTransactions')(db)
  return { db, c: require('../../cloudfunctions/api/services/context')({ db, cloud: {} }) }
}

for (const status of ['cancelled', 'expired', 'completed', 'refunded']) {
  test(`terminal multi-day ${status} clears all password records exactly once`, async () => {
    const { db, c } = terminatedSecurityFixture(status)
    await c.destroyOrderHomeSecuritySecrets('multi', { reason: 'terminal_cleanup' })
    for (const security of [db.state.orders[0].orderHomeSecurity, db.state.order_home_security[0]]) {
      assert.equal(security.oneTimeCode.cipher, '')
      assert.ok(security.sessionCodes.every(code => code.cipher === '' && code.destroyed))
      assert.equal(security.destroyed, true)
    }
    assert.equal(db.state.orders[0].hasDoorLockCode, false)
    assert.equal(db.state.orders[0].homeSecurityCleanupPending, false)
    await c.destroyOrderHomeSecuritySecrets('multi', { reason: 'terminal_cleanup' })
    assert.equal(db.state.unlock_code_logs.length, 1)
  })
}

test('password destruction failure rolls back both records and never logs success; scheduled retry recovers', async () => {
  const { db, c } = terminatedSecurityFixture()
  const run = db.runTransaction
  db.runTransaction = callback => run(tx => callback({ collection(name) {
    if (name === 'order_home_security') {
      const collection = tx.collection(name)
      const doc = collection.doc.bind(collection)
      collection.doc = id => ({ ...doc(id), update: async () => { throw new Error('security write unavailable') } })
      return collection
    }
    return tx.collection(name)
  } }))
  await assert.rejects(c.destroyOrderHomeSecuritySecrets('multi'), /security write unavailable/)
  assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, 'unified')
  assert.equal((db.state.unlock_code_logs || []).length, 0)
  db.runTransaction = run
  await c.retryPendingHomeSecurityCleanup()
  assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, '')
  assert.equal(db.state.orders[0].homeSecurityCleanupPending, false)
})

test('intermediate multi-day completion destroys only its own code and preserves future credentials', async () => {
  const { db, c } = terminatedSecurityFixture('day_completed')
  await c.destroyOrderHomeSecuritySecrets('multi', { sessionIndex: 1 })
  for (const security of [db.state.orders[0].orderHomeSecurity, db.state.order_home_security[0]]) {
    assert.equal(security.oneTimeCode.cipher, 'unified')
    assert.equal(security.sessionCodes[0].cipher, '')
    assert.equal(security.sessionCodes[1].cipher, 'two')
    assert.equal(security.hasDoorLockCode, true)
  }
})

test('cleanup uses whole-object replacement to remove legacy plaintext from cloud snapshots', async () => {
  const security = { type: 'one_time_code', oneTimeCode: { code: 'plaintext', cipher: 'cipher' },
    sessionCodes: [{ sessionIndex: 1, code: 'plaintext', cipher: 'cipher' }] }
  const db = createCollectionStore({ orders: [{ _id: 'legacy', status: 'cancelled', doorLockCode: 'plaintext',
    orderHomeSecurity: security, homeSecuritySnapshot: security }],
    order_home_security: [{ _id: 'sec', orderId: 'legacy', ...security }] }, { cloudObjectUpdates: true })
  const c = require('../../cloudfunctions/api/services/context')({ db, cloud: {} })
  await c.destroyOrderHomeSecuritySecrets('legacy')
  assert.doesNotMatch(JSON.stringify(db.state.orders), /plaintext|"cipher":"cipher"/)
  assert.doesNotMatch(JSON.stringify(db.state.order_home_security), /plaintext|"cipher":"cipher"/)
})

test('terminal cleanup retry rechecks transaction status and cannot erase a resumed service', async () => {
  const { db, c } = terminatedSecurityFixture()
  const run = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0].status = 'in_service'
    return run(callback)
  }
  await c.retryPendingHomeSecurityCleanup()
  assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, 'unified')
  assert.equal((db.state.unlock_code_logs || []).length, 0)
})

test('session cleanup retries a concurrent password reset without overwriting a future credential', async () => {
  const { db, c } = terminatedSecurityFixture('day_completed')
  const run = db.runTransaction
  let reset = false
  db.runTransaction = callback => run(async tx => {
    const result = await callback(tx)
    if (!reset) {
      reset = true
      db.state.order_home_security[0].sessionCodes[1].cipher = 'new-future-code'
    }
    return result
  })
  await c.destroyOrderHomeSecuritySecrets('multi', { sessionIndex: 1 })
  assert.equal(db.state.orders[0].orderHomeSecurity.sessionCodes[1].cipher, 'new-future-code')
  assert.equal(db.state.order_home_security[0].sessionCodes[1].cipher, 'new-future-code')
  assert.equal(db.state.unlock_code_logs.length, 1)
})

for (const mode of ['unpaid', 'expired']) {
  test(`${mode} termination clears multi-day credentials in both collections`, async () => {
    const { db, c } = terminatedSecurityFixture(mode === 'unpaid' ? 'pending_pay' : 'paid')
    const order = db.state.orders[0]
    Object.assign(order, { paymentStatus: mode === 'unpaid' ? 'unpaid' : 'paid', payAmount: 0,
      startTime: new Date(Date.now() - 3600000), couponId: 'coupon' })
    db.state.user_coupons = [{ _id: 'coupon', status: mode === 'unpaid' ? 'locked' : 'used',
      lockedOrderId: 'multi', usedOrderId: 'multi', validTo: '2099-01-01' }]
    if (mode === 'unpaid') await c.cancelUnpaidOrder(order)
    else await c.expireUnacceptedOrder('multi', order)
    assert.equal(db.state.orders[0].status, mode === 'unpaid' ? 'cancelled' : 'expired')
    assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, '')
    assert.equal(db.state.order_home_security[0].oneTimeCode.cipher, '')
    assert.equal(db.state.orders[0].homeSecurityCleanupPending, false)
  })
}

test('client cancellation remains committed when security cleanup fails and its durable retry recovers', async () => {
  const { db, c } = terminatedSecurityFixture('paid')
  Object.assign(db.state.orders[0], { clientOpenid: 'client', paymentStatus: 'paid', payAmount: 0,
    startTime: '2099-01-01 10:00', endTime: '2099-01-02 11:00', couponId: 'coupon' })
  db.state.users = [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' }]
  db.state.user_coupons = [{ _id: 'coupon', status: 'used', usedOrderId: 'multi', validTo: '2099-01-01' }]
  const run = db.runTransaction
  db.runTransaction = callback => run(tx => callback({ collection(name) {
    if (name === 'order_home_security') throw new Error('security temporarily unavailable')
    return tx.collection(name)
  } }))
  const api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'multi' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.orders[0].status, 'cancelled')
  assert.equal(db.state.orders[0].homeSecurityCleanupPending, true)
  assert.equal(db.state.user_coupons[0].status, 'available')
  assert.equal((db.state.unlock_code_logs || []).length, 0)
  db.runTransaction = run
  await c.retryPendingHomeSecurityCleanup()
  assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, '')
  assert.equal(db.state.orders[0].homeSecurityCleanupPending, false)
})

test('resetting one visit password preserves encrypted credentials for other visits in both records', async () => {
  const { db, c } = terminatedSecurityFixture('assigned')
  db.state.orders[0].clientOpenid = 'client'
  db.state.users = [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' }]
  const handler = require('../../cloudfunctions/api/handlers/homeSecurity')({ ...c, appendOrderStaffMessage: async () => {} })
  await handler('client', 'updateOrderOneTimeCode', { orderId: 'multi', sessionIndex: 1, code: '123456',
    effectiveStart: '2099-01-01 09:00', effectiveEnd: '2099-01-01 12:00' })
  for (const security of [db.state.orders[0].orderHomeSecurity, db.state.order_home_security[0]]) {
    assert.equal(security.sessionCodes[1].cipher, 'two')
    const { cipher, iv, tag } = security.sessionCodes[0]
    assert.equal(c.decryptText(cipher, iv, tag), '123456')
  }
})

for (const race of ['cancelled', 'completed', 'write_failure']) {
  test(`password reset cannot resurrect secrets or partially commit during ${race}`, async () => {
    const { db, c } = terminatedSecurityFixture('assigned')
    db.state.orders[0].clientOpenid = 'client'
    db.state.users = [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' }]
    const run = db.runTransaction
    db.runTransaction = callback => {
      if (race !== 'write_failure') db.state.orders[0].status = race
      return run(tx => callback({ collection(name) {
        const collection = tx.collection(name)
        if (race === 'write_failure' && name === 'order_home_security') {
          const doc = collection.doc.bind(collection)
          collection.doc = id => ({ ...doc(id), update: async () => { throw new Error('security update unavailable') } })
        }
        return collection
      } }))
    }
    const handler = require('../../cloudfunctions/api/handlers/homeSecurity')({ ...c, appendOrderStaffMessage: async () => {} })
    await assert.rejects(handler('client', 'updateOrderOneTimeCode', { orderId: 'multi', code: '123456',
      effectiveStart: '2099-01-01 09:00', effectiveEnd: '2099-01-02 12:00' }), /不可修改密码|security update unavailable/)
    assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, 'unified')
    assert.equal(db.state.order_home_security[0].oneTimeCode.cipher, 'unified')
  })
}

for (const [amount, failCleanup] of [[20, false], [100, false], [100, true]]) {
  test(`refund of ${amount} preserves live secrets or cleans terminal credentials (cleanup failure: ${failCleanup})`, async () => {
    const { db, c } = terminatedSecurityFixture('assigned')
    Object.assign(db.state.orders[0], { payAmount: 100, paymentStatus: 'paid', paymentChannel: 'mock', clientOpenid: 'client' })
    db.state.orders[0].homeSecurityCleanupPending = false
    const refunds = require('../../cloudfunctions/api/services/refunds')({ ...c,
      getSystemSettings: async () => ({ payment: { mode: 'mock' } }), assertPaymentModeAllowed: () => {},
      getPayableOrder: async () => ({ collectionName: 'orders', order: db.state.orders[0] }),
      createRefundNo: () => 'REFUND', adjustStaffEarningsForRefund: async () => {}, notifyOrder: async () => {},
      ...(failCleanup ? { destroyOrderHomeSecuritySecrets: async () => { throw new Error('cleanup unavailable') } } : {}) })
    await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), amount, '协商退款', 'admin_manual', 'admin', 'request')
    assert.equal(db.state.orders[0].refundedAmount, amount)
    if (amount < 100 || failCleanup) {
      assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, 'unified')
    } else {
      assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, '')
      assert.equal(db.state.order_home_security[0].oneTimeCode.cipher, '')
    }
    assert.equal(db.state.orders[0].homeSecurityCleanupPending, failCleanup)
    if (failCleanup) {
      assert.equal(db.state.orders[0].status, 'refunded')
      await c.retryPendingHomeSecurityCleanup()
      assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher, '')
    }
  })
}

function liveSecurityFixture(count = 2) {
  const time = new Date('2030-01-01T02:30:00Z')
  const db = createCollectionStore({ users: [
    { _id: 'client', openid: 'client', roles: ['client'], status: 'active' },
    { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }
  ], orders: [] })
  require('./optimisticTransactions')(db)
  const c = require('../../cloudfunctions/api/services/context')({ db, cloud: {} })
  const sessions = Array.from({ length: count }, (_, i) => ({ index: i + 1,
    startTime: new Date(+time - 1800000 + i * 86400000), endTime: new Date(+time + 1800000 + i * 86400000),
    status: i ? 'pending' : 'in_service', ...(i ? {} : { startedAt: new Date(+time - 1800000) }) }))
  const security = { type: 'one_time_code', oneTimeCode: { ...c.encryptText('UNIFIED'), effectiveStart: sessions[0].startTime, effectiveEnd: sessions[count - 1].endTime },
    sessionCodes: sessions.map(s => ({ sessionIndex: s.index, ...c.encryptText(`DAY_${s.index}`), effectiveStart: s.startTime, effectiveEnd: s.endTime })) }
  db.state.orders.push({ _id: 'live', clientOpenid: 'client', staffOpenid: 'staff', status: 'in_service', serviceType: 'feed',
    orderType: count > 1 ? 'multi_day' : 'single', activeSessionIndex: 1, startedAt: sessions[0].startedAt,
    currentSessionStartedAt: sessions[0].startedAt, startTime: sessions[0].startTime, endTime: sessions[count - 1].endTime,
    serviceSessions: sessions, orderHomeSecurity: security })
  db.state.order_home_security = [{ _id: 'sec', orderId: 'live', ...structuredClone(security) }]
  const handler = require('../../cloudfunctions/api/handlers/homeSecurity')({ ...c, now: () => time,
    appendOrderStaffMessage: async () => {}, checkRateLimit: async () => {}, getApprovedEarlyStart: async () => null })
  return { db, c, time, handler }
}

for (const count of [1, 2]) {
  test(`common reset replaces old per-visit overrides for ${count} visits and staff decrypts the new code`, async () => {
    const { db, handler } = liveSecurityFixture(count)
    await handler('client', 'updateOrderOneTimeCode', { orderId: 'live', code: 'NEW_CODE',
      effectiveStart: db.state.orders[0].startTime, effectiveEnd: db.state.orders[0].endTime })
    const result = await handler('staff', 'getUnlockCode', { orderId: 'live', sessionIndex: 1 })
    assert.equal(result.doorLockCode, 'NEW_CODE')
    for (const security of [db.state.orders[0].orderHomeSecurity, db.state.order_home_security[0]]) {
      assert.equal(security.sessionCodes.length, 0)
    }
  })
}

test('common reset preserves completed-code tombstones and requires coverage of all remaining visits', async () => {
  const { db, c, handler } = liveSecurityFixture(3)
  const order = db.state.orders[0]
  order.status = 'day_completed'
  order.activeSessionIndex = 0
  order.serviceSessions[0].status = 'completed'
  await c.destroyOrderHomeSecuritySecrets('live', { sessionIndex: 1 })
  await assert.rejects(handler('client', 'updateOrderOneTimeCode', { orderId: 'live', code: 'NEW_CODE',
    effectiveStart: order.serviceSessions[1].startTime, effectiveEnd: order.serviceSessions[1].endTime }), /覆盖/)
  await handler('client', 'updateOrderOneTimeCode', { orderId: 'live', code: 'NEW_CODE',
    effectiveStart: order.serviceSessions[1].startTime, effectiveEnd: order.serviceSessions[2].endTime })
  for (const security of [db.state.orders[0].orderHomeSecurity, db.state.order_home_security[0]]) {
    assert.equal(security.sessionCodes.length, 1)
    assert.equal(security.sessionCodes[0].sessionIndex, 1)
    assert.equal(security.sessionCodes[0].destroyed, true)
  }
})

for (const index of [0, 1, 99, 1.5]) {
  test(`password reset rejects completed or invalid target visit ${index}`, async () => {
    const { db, handler } = liveSecurityFixture()
    db.state.orders[0].serviceSessions[0].status = 'completed'
    await assert.rejects(handler('client', 'updateOrderOneTimeCode', { orderId: 'live', sessionIndex: index, code: 'NEW_CODE',
      effectiveStart: db.state.orders[0].startTime, effectiveEnd: db.state.orders[0].endTime }), /场次/)
  })
}

test('batch reset cannot resurrect completed visits or accept duplicate indices', async () => {
  const { db, handler } = liveSecurityFixture()
  const order = db.state.orders[0]
  order.serviceSessions[0].status = 'completed'
  const code = { sessionIndex: 1, code: 'NEW_CODE', effectiveStart: order.startTime, effectiveEnd: order.endTime }
  await assert.rejects(handler('client', 'updateOrderOneTimeCode', { orderId: 'live', sessionCodes: [code] }), /场次/)
  await assert.rejects(handler('client', 'updateOrderOneTimeCode', { orderId: 'live', sessionCodes: [{ ...code, sessionIndex: 2 }, { ...code, sessionIndex: 2 }] }), /场次/)
})

for (const status of ['completed', 'cancelled']) {
  test(`staff cannot decrypt a ${status} visit even while old credentials and time windows remain valid`, async () => {
    const { db, handler } = liveSecurityFixture()
    Object.assign(db.state.orders[0], { status: 'day_completed', activeSessionIndex: 0 })
    db.state.orders[0].serviceSessions[0].status = status
    await assert.rejects(handler('staff', 'getUnlockCode', { orderId: 'live', sessionIndex: 1 }), /场次.*(完成|取消)/)
    assert.notEqual(db.state.unlock_code_logs[0].result, 'success')
  })
}

for (const failure of ['cleanup', 'timeline', 'message', 'notification']) {
  test(`intermediate visit cleanup survives ${failure} failure and scheduler preserves the next visit`, async () => {
    const { db, c, time } = liveSecurityFixture(3)
    const fail = async () => { throw new Error(`simulated ${failure} failure`) }
    const noop = async () => {}
    const execution = require('../../cloudfunctions/api/services/serviceExecution')({ ...c,
      appendOrderTimeline: failure === 'timeline' ? fail : noop, appendOrderClientMessage: failure === 'message' ? fail : noop,
      enqueueOrderNotification: noop, notifyOrder: failure === 'notification' ? fail : noop,
      ...(failure === 'cleanup' ? { destroyOrderHomeSecuritySecrets: fail } : {}) })
    const order = structuredClone(db.state.orders[0])
    const finish = execution.completeOrderService(order, c.getActiveServiceSession(order), time)
    if (failure === 'cleanup') await finish
    else await assert.rejects(finish, /simulated/)
    assert.equal(db.state.orders[0].status, 'day_completed')
    if (failure === 'cleanup') assert.deepEqual(db.state.orders[0].homeSecurityPendingSessionIndexes, [1])
    else assert.equal(db.state.order_home_security[0].sessionCodes[0].cipher, '')
    Object.assign(db.state.orders[0], { status: 'in_service', activeSessionIndex: 2 })
    db.state.orders[0].serviceSessions[1].status = 'in_service'
    await c.retryPendingHomeSecurityCleanup()
    assert.equal(db.state.order_home_security[0].sessionCodes[0].cipher, '')
    assert.ok(db.state.order_home_security[0].sessionCodes[1].cipher)
    assert.ok(db.state.order_home_security[0].oneTimeCode.cipher)
    assert.deepEqual(db.state.orders[0].homeSecurityPendingSessionIndexes, [])
  })
}

test('session cleanup retry rechecks completed status before touching a resumed visit', async () => {
  const { db, c } = liveSecurityFixture(3)
  const order = db.state.orders[0]
  order.serviceSessions[0].status = 'completed'
  order.homeSecurityPendingSessionIndexes = [1]
  const original = order.orderHomeSecurity.sessionCodes[0].cipher
  const run = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0].serviceSessions[0].status = 'in_service'
    return run(callback)
  }
  await c.retryPendingHomeSecurityCleanup()
  assert.equal(db.state.order_home_security[0].sessionCodes[0].cipher, original)
  assert.deepEqual(db.state.orders[0].homeSecurityPendingSessionIndexes, [1])
  assert.equal((db.state.unlock_code_logs || []).length, 0)
})

test('session cleanup retry drains multiple finished visits without destroying the shared or future code', async () => {
  const { db, c } = liveSecurityFixture(3)
  Object.assign(db.state.orders[0], { homeSecurityPendingSessionIndexes: [1, 2], activeSessionIndex: 3 })
  db.state.orders[0].serviceSessions.forEach(session => { session.status = session.index < 3 ? 'completed' : 'in_service' })
  await c.retryPendingHomeSecurityCleanup()
  for (const security of [db.state.orders[0].orderHomeSecurity, db.state.order_home_security[0]]) {
    assert.equal(security.sessionCodes[0].cipher, '')
    assert.equal(security.sessionCodes[1].cipher, '')
    assert.ok(security.sessionCodes[2].cipher)
    assert.ok(security.oneTimeCode.cipher)
  }
  assert.deepEqual(db.state.orders[0].homeSecurityPendingSessionIndexes, [])
})

test('session cleanup clears its pending marker even when the order has no security record', async () => {
  const db = createCollectionStore({ orders: [{ _id: 'no-security', status: 'day_completed',
    serviceSessions: [{ index: 1, status: 'completed' }, { index: 2, status: 'pending' }],
    homeSecurityPendingSessionIndexes: [1] }] })
  const c = require('../../cloudfunctions/api/services/context')({ db, cloud: {} })
  await c.retryPendingHomeSecurityCleanup()
  assert.deepEqual(db.state.orders[0].homeSecurityPendingSessionIndexes, [])
  assert.equal((db.state.unlock_code_logs || []).length, 0)
})

for (const mode of ['single', 'batch']) {
  test(`${mode} password reset rejects a validity window that does not cover its target visit`, async () => {
    const { db, handler } = liveSecurityFixture()
    const session = db.state.orders[0].serviceSessions[1]
    const item = { sessionIndex: 2, code: 'NEW_CODE', effectiveStart: new Date(+session.startTime + 1), effectiveEnd: session.endTime }
    await assert.rejects(handler('client', 'updateOrderOneTimeCode', { orderId: 'live',
      ...(mode === 'batch' ? { sessionCodes: [item] } : item) }), /覆盖/)
    assert.equal(db.state.order_home_security[0].sessionCodes[1].cipher, db.state.orders[0].orderHomeSecurity.sessionCodes[1].cipher)
  })
}

test('homeSecurity saveHomeSecurity requires configured encryption key', async () => {
  const previous = process.env.HOME_SECURITY_KEY
  delete process.env.HOME_SECURITY_KEY
  try {
    const db = createCollectionStore({
      users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
      home_security: []
    })
    const fn = loadCloudFunction('homeSecurity', db, 'openid_client')

    const result = await fn.main({ action: 'saveHomeSecurity', data: { doorLockCode: '123456' } })

    assert.equal(result.ok, false)
    assert.equal(result.message, '家庭安防加密密钥未配置')
  } finally {
    process.env.HOME_SECURITY_KEY = previous
  }
})

test('homeSecurity saveHomeSecurity stores encrypted door lock fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    home_security: []
  })
  const fn = loadCloudFunction('homeSecurity', db, 'openid_client')

  const result = await fn.main({ action: 'saveHomeSecurity', data: { doorLockCode: '123456', keyLocation: '门垫下' } })

  assert.equal(result.ok, true)
  assert.ok(db.state.home_security[0].doorLockCodeCipher)
  assert.notEqual(db.state.home_security[0].doorLockCodeCipher, '123456')
  assert.ok(db.state.home_security[0].doorLockCodeIv)
  assert.ok(db.state.home_security[0].doorLockCodeTag)
})

test('homeSecurity getUnlockCode rejects outside service time window and logs attempt', async () => {
  const db = createCollectionStore({
    users: [{ _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'o1', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', status: 'assigned', startTime: '2099-01-01 10:00', endTime: '2099-01-01 11:00' }],
    unlock_code_logs: []
  })
  const fn = loadCloudFunction('homeSecurity', db, 'openid_staff')

  const result = await fn.main({ action: 'getUnlockCode', data: { orderId: 'o1' } })

  assert.equal(result.ok, false)
  assert.equal(result.message, '不在服务解锁时间窗口')
  assert.equal(db.state.unlock_code_logs.length, 1)
  assert.equal(db.state.unlock_code_logs[0].result, 'forbidden')
})

test('homeSecurity getUnlockCode reads order-level one-time code and logs success', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [{ _id: 'o1', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', status: 'assigned', startTime: '2000-01-01 10:00', endTime: '2999-01-01 11:00' }],
    unlock_code_logs: []
  })
  const clientFn = loadCloudFunction('homeSecurity', db, 'openid_client')
  const update = await clientFn.main({ action: 'updateOrderOneTimeCode', data: { orderId: 'o1', code: '654321', effectiveStart: '2000-01-01 10:00', effectiveEnd: '2999-01-01 11:00' } })
  assert.equal(update.ok, true)
  assert.equal(update.data.oneTimeCode.masked, '6***1')
  assert.equal(update.data.doorLockCode, undefined)
  assert.equal(update.data.oneTimeCode.cipher, undefined)
  assert.equal(db.state.orders[0].orderHomeSecurity.doorLockCode, undefined)
  assert.equal(db.state.orders[0].homeSecuritySnapshot.doorLockCode, undefined)
  assert.equal(db.state.orders[0].orderHomeSecurity.oneTimeCode.cipher.includes('654321'), false)

  const staffFn = loadCloudFunction('homeSecurity', db, 'openid_staff')
  const result = await staffFn.main({ action: 'getUnlockCode', data: { orderId: 'o1' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.doorLockCode, '654321')
  assert.equal(db.state.unlock_code_logs[0].result, 'success')
})

test('homeSecurity listHomeSecurityHistory returns masked order security only for owner', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    orders: [
      { _id: 'o1', orderNo: 'O1', clientOpenid: 'openid_client', startTime: '2026-08-25 10:00', endTime: '2026-08-25 11:00', orderHomeSecurity: { type: 'one_time_code', lockMethodText: '一次性密码', oneTimeCode: { masked: '1***6', effectiveStart: '2026-08-25 09:30', effectiveEnd: '2026-08-25 11:30', cipher: 'secret' } }, createdAt: '2026-08-25' },
      { _id: 'o2', orderNo: 'O2', clientOpenid: 'other_client', orderHomeSecurity: { type: 'key', key: { location: '门垫下', imageFileIds: ['cloud://key.jpg'] } }, createdAt: '2026-08-24' }
    ]
  })
  const fn = loadCloudFunction('homeSecurity', db, 'openid_client')

  const result = await fn.main({ action: 'listHomeSecurityHistory' })

  assert.equal(result.ok, true)
  assert.equal(result.data.length, 1)
  assert.equal(result.data[0].orderId, 'o1')
  assert.equal(result.data[0].orderHomeSecurity.oneTimeCode.masked, '1***6')
  assert.equal(result.data[0].orderHomeSecurity.oneTimeCode.cipher, undefined)
})

test('homeSecurity requestRemoteUnlock records wechat and admin phone channels', async () => {
  const db = createCollectionStore({
    users: [{ _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'o1', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', status: 'assigned', orderHomeSecurity: { type: 'remote_unlock', remoteUnlock: { requestCount: 0 } } }],
    home_security_notifications: [],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { customerService: { phone: '400100200', wechatId: 'dogcat_cs', workHours: '9:00-21:00' } } }]
  })
  const fn = loadCloudFunction('homeSecurity', db, 'openid_staff')

  const result = await fn.main({ action: 'requestRemoteUnlock', data: { orderId: 'o1' } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.data.remoteUnlock.notifyChannels, ['wechat', 'admin_phone'])
  assert.equal(result.data.remoteUnlock.lastNotifyStatus.admin_phone, 'available')
  assert.deepEqual(db.state.home_security_notifications[0].channels, ['wechat', 'admin_phone'])
  assert.equal(db.state.home_security_notifications[0].customerServiceSnapshot.phone, '400100200')
})

test('homeSecurity getUnlockCode records audit log on non-existent orderId, missing orderId, and unauthorized roles', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 's2', openid: 'openid_other_staff', roles: ['staff'], status: 'active' },
      { _id: 'c1', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      { _id: 'o_bound', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', status: 'assigned', startTime: '2099-01-01 10:00', endTime: '2099-01-01 11:00' }
    ],
    unlock_code_logs: []
  })
  const staffFn = loadCloudFunction('homeSecurity', db, 'openid_staff')
  const otherStaffFn = loadCloudFunction('homeSecurity', db, 'openid_other_staff')
  const clientFn = loadCloudFunction('homeSecurity', db, 'openid_client')

  // 1. 传入不存在的 orderId：绝不能跳过审计日志
  const resNonExistent = await staffFn.main({ action: 'getUnlockCode', data: { orderId: 'non_existent_999' } })
  assert.equal(resNonExistent.ok, false)
  assert.equal(resNonExistent.message, '订单不存在')
  assert.equal(db.state.unlock_code_logs.length, 1)
  assert.equal(db.state.unlock_code_logs[0].orderId, 'non_existent_999')
  assert.equal(db.state.unlock_code_logs[0].staffOpenid, 'openid_staff')
  assert.equal(db.state.unlock_code_logs[0].result, 'forbidden')
  assert.equal(db.state.unlock_code_logs[0].reason, '订单不存在')

  // 2. 缺少 orderId
  const resMissing = await staffFn.main({ action: 'getUnlockCode', data: {} })
  assert.equal(resMissing.ok, false)
  assert.equal(resMissing.message, '缺少订单ID')
  assert.equal(db.state.unlock_code_logs.length, 2)
  assert.equal(db.state.unlock_code_logs[1].staffOpenid, 'openid_staff')
  assert.equal(db.state.unlock_code_logs[1].result, 'forbidden')
  assert.equal(db.state.unlock_code_logs[1].reason, '缺少订单ID')

  // 3. 跨员工越权访问其他员工的订单
  const resCrossStaff = await otherStaffFn.main({ action: 'getUnlockCode', data: { orderId: 'o_bound' } })
  assert.equal(resCrossStaff.ok, false)
  assert.equal(resCrossStaff.message, '不是该订单绑定员工')
  assert.equal(db.state.unlock_code_logs.length, 3)
  assert.equal(db.state.unlock_code_logs[2].orderId, 'o_bound')
  assert.equal(db.state.unlock_code_logs[2].staffOpenid, 'openid_other_staff')
  assert.equal(db.state.unlock_code_logs[2].result, 'forbidden')
  assert.equal(db.state.unlock_code_logs[2].reason, '不是该订单绑定员工')

  // 4. 普通客户无权限查看
  const resClient = await clientFn.main({ action: 'getUnlockCode', data: { orderId: 'o_bound' } })
  assert.equal(resClient.ok, false)
  assert.equal(resClient.message, '仅员工可查看')
  assert.equal(db.state.unlock_code_logs.length, 4)
  assert.equal(db.state.unlock_code_logs[3].staffOpenid, 'openid_client')
  assert.equal(db.state.unlock_code_logs[3].result, 'forbidden')
  assert.equal(db.state.unlock_code_logs[3].reason, '仅员工可查看')
})

test('homeSecurity destroyOrderHomeSecuritySecrets erases cipher and marks destroyed', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [{
      _id: 'o_destroy',
      orderNo: 'ORD_DEST',
      staffOpenid: 'openid_staff',
      clientOpenid: 'openid_client',
      status: 'in_service',
      startTime: '2000-01-01 10:00',
      endTime: '2999-01-01 11:00',
      hasDoorLockCode: true
    }],
    order_home_security: [{ _id: 'sec_dest', orderId: 'o_destroy', oneTimeCode: { cipher: 'init_cipher' } }],
    unlock_code_logs: []
  })

  const clientFn = loadCloudFunction('homeSecurity', db, 'openid_client')
  await clientFn.main({
    action: 'updateOrderOneTimeCode',
    data: { orderId: 'o_destroy', code: '888888', effectiveStart: '2000-01-01 10:00', effectiveEnd: '2999-01-01 11:00' }
  })

  const staffFn = loadCloudFunction('homeSecurity', db, 'openid_staff')
  const beforeUnlock = await staffFn.main({ action: 'getUnlockCode', data: { orderId: 'o_destroy' } })
  assert.equal(beforeUnlock.ok, true)
  assert.equal(beforeUnlock.data.doorLockCode, '888888')

  // 执行自动脱敏销毁
  const context = require('../../cloudfunctions/api/services/context')({ cloud: {}, db })
  await context.destroyOrderHomeSecuritySecrets('o_destroy', { reason: 'service_completed_auto_destroyed', actor: 'staff' })

  // 验证 orders 集合中的密码已抹除脱敏
  const updatedOrder = db.state.orders.find(o => o._id === 'o_destroy')
  assert.equal(updatedOrder.isDoorLockCodeDestroyed, true)
  assert.equal(updatedOrder.hasDoorLockCode, false)
  assert.equal(updatedOrder.orderHomeSecurity.destroyed, true)
  assert.equal(updatedOrder.orderHomeSecurity.isPasswordDestroyed, true)
  assert.equal(updatedOrder.orderHomeSecurity.oneTimeCode.cipher, '')
  assert.equal(updatedOrder.orderHomeSecurity.oneTimeCode.destroyed, true)
  assert.equal(updatedOrder.orderHomeSecurity.doorLockCodeCipher, '')

  // 验证 order_home_security 集合中的密码也已抹除
  const secDoc = db.state.order_home_security.find(s => s.orderId === 'o_destroy')
  assert.equal(secDoc.oneTimeCode.cipher, '')
  assert.equal(secDoc.destroyed, true)

  // 验证已记录销毁流水
  const destroyLog = db.state.unlock_code_logs.find(l => l.result === 'destroyed')
  assert.ok(destroyLog)
  assert.equal(destroyLog.reason, 'service_completed_auto_destroyed')

  // 销毁后宠托师再次尝试查看密码：应当被拦截并返回脱敏销毁提示
  const afterUnlock = await staffFn.main({ action: 'getUnlockCode', data: { orderId: 'o_destroy' } })
  assert.equal(afterUnlock.ok, false)
  assert.ok(afterUnlock.message.includes('已在服务完成并确认离户后自动脱敏销毁'))

  // 验证销毁后的查看尝试记录在流水中为 destroyed
  const lastLog = db.state.unlock_code_logs[db.state.unlock_code_logs.length - 1]
  assert.equal(lastLog.result, 'destroyed')
})

test('homeSecurity destroyOrderHomeSecuritySecrets handles multi-day session destruction step by step', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [{
      _id: 'o_multi_destroy',
      orderNo: 'ORD_MULTI_DEST',
      staffOpenid: 'openid_staff',
      clientOpenid: 'openid_client',
      status: 'in_service',
      serviceSessions: [
        { index: 1, date: '2026-10-01', startTime: '2000-10-01 10:00', endTime: '2999-10-01 11:00', status: 'in_service' },
        { index: 2, date: '2026-10-02', startTime: '2000-10-02 10:00', endTime: '2999-10-02 11:00', status: 'pending' }
      ],
      hasDoorLockCode: true
    }],
    order_home_security: [],
    unlock_code_logs: []
  })

  const clientFn = loadCloudFunction('homeSecurity', db, 'openid_client')
  await clientFn.main({
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'o_multi_destroy',
      sessionCodes: [
        { sessionIndex: 1, date: '2026-10-01', code: '111111', effectiveStart: '2000-10-01 10:00', effectiveEnd: '2999-10-01 11:00' },
        { sessionIndex: 2, date: '2026-10-02', code: '222222', effectiveStart: '2000-10-02 10:00', effectiveEnd: '2999-10-02 11:00' }
      ]
    }
  })

  const context = require('../../cloudfunctions/api/services/context')({ cloud: {}, db })

  // 1. 完结第 1 天服务：仅销毁第 1 天的密码
  await context.destroyOrderHomeSecuritySecrets('o_multi_destroy', { sessionIndex: 1, reason: 'day_completed', actor: 'staff' })

  const orderAfterDay1 = db.state.orders.find(o => o._id === 'o_multi_destroy')
  const sCodes1 = orderAfterDay1.orderHomeSecurity.sessionCodes
  assert.equal(sCodes1[0].destroyed, true)
  assert.equal(sCodes1[0].cipher, '')
  // 第 2 天密码保持有效
  assert.equal(sCodes1[1].destroyed, undefined)
  assert.ok(sCodes1[1].cipher)
  assert.equal(orderAfterDay1.hasDoorLockCode, true)
  assert.equal(orderAfterDay1.isDoorLockCodeDestroyed, undefined)

  // 2. 完结第 2 天服务（全部完结）：整单密码全部销毁
  await context.destroyOrderHomeSecuritySecrets('o_multi_destroy', { sessionIndex: 2, reason: 'service_completed', actor: 'staff' })

  const orderAfterDay2 = db.state.orders.find(o => o._id === 'o_multi_destroy')
  const sCodes2 = orderAfterDay2.orderHomeSecurity.sessionCodes
  assert.equal(sCodes2[0].destroyed, true)
  assert.equal(sCodes2[1].destroyed, true)
  assert.equal(sCodes2[1].cipher, '')
  assert.equal(orderAfterDay2.hasDoorLockCode, false)
  assert.equal(orderAfterDay2.isDoorLockCodeDestroyed, true)
})

test('service finishService triggers auto destruction of door lock secrets', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [{
      _id: 'o_finish_sec',
      orderNo: 'ORD_FINISH_SEC',
      staffOpenid: 'openid_staff',
      clientOpenid: 'openid_client',
      status: 'in_service',
      startTime: '2000-01-01 10:00',
      endTime: '2999-01-01 11:00',
      serviceSessions: [{ index: 1, status: 'in_service', startTime: '2000-01-01 10:00', endTime: '2999-01-01 11:00' }],
      checkinRequirements: [],
      hasDoorLockCode: true
    }],
    checkin_logs: [],
    order_home_security: [],
    unlock_code_logs: []
  })

  const clientFn = loadCloudFunction('homeSecurity', db, 'openid_client')
  await clientFn.main({
    action: 'updateOrderOneTimeCode',
    data: { orderId: 'o_finish_sec', code: '999888', effectiveStart: '2000-01-01 10:00', effectiveEnd: '2999-01-01 11:00' }
  })

  // 宠托师完成服务
  const apiFn = loadCloudFunction('api', db, 'openid_staff')
  const finishRes = await apiFn.main({ module: 'order', action: 'finishService', data: { id: 'o_finish_sec' } })
  assert.equal(finishRes.ok, true)
  assert.equal(finishRes.data.status, 'completed')

  // 验证完单后门锁密码已自动销毁
  const finishedOrder = db.state.orders.find(o => o._id === 'o_finish_sec')
  assert.equal(finishedOrder.isDoorLockCodeDestroyed, true)
  assert.equal(finishedOrder.hasDoorLockCode, false)
  assert.equal(finishedOrder.orderHomeSecurity.destroyed, true)
  assert.equal(finishedOrder.orderHomeSecurity.oneTimeCode.cipher, '')

  // 宠托师无法再次查看密码
  const staffFn = loadCloudFunction('homeSecurity', db, 'openid_staff')
  const unlockRes = await staffFn.main({ action: 'getUnlockCode', data: { orderId: 'o_finish_sec' } })
  assert.equal(unlockRes.ok, false)
  assert.ok(unlockRes.message.includes('已在服务完成并确认离户后自动脱敏销毁'))
})

test('admin manualCompleteOrder and client cancelOrder trigger password auto destruction', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'a1', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    orders: [
      {
        _id: 'o_admin_comp',
        orderNo: 'ORD_ADMIN_COMP',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        status: 'in_service',
        startTime: '2000-01-01 10:00',
        endTime: '2999-01-01 11:00',
        hasDoorLockCode: true
      },
      {
        _id: 'o_cancel_sec',
        orderNo: 'ORD_CANCEL_SEC',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        status: 'assigned',
        startTime: '2099-01-01 10:00',
        endTime: '2099-01-01 11:00',
        paymentStatus: 'paid',
        payAmount: 100,
        hasDoorLockCode: true
      }
    ],
    order_home_security: [],
    unlock_code_logs: []
  })

  const clientFn = loadCloudFunction('homeSecurity', db, 'openid_client')
  await clientFn.main({ action: 'updateOrderOneTimeCode', data: { orderId: 'o_admin_comp', code: '123123', effectiveStart: '2000-01-01 10:00', effectiveEnd: '2999-01-01 11:00' } })
  await clientFn.main({ action: 'updateOrderOneTimeCode', data: { orderId: 'o_cancel_sec', code: '456456', effectiveStart: '2099-01-01 10:00', effectiveEnd: '2099-01-01 11:00' } })

  // 1. 管理员线下核实完单
  const adminApi = loadCloudFunction('api', db, 'openid_admin')
  const adminRes = await adminApi.main({ module: 'admin', action: 'manualCompleteOrder', data: { orderId: 'o_admin_comp', remark: '线下核实已离户完毕' } })
  assert.equal(adminRes.ok, true)

  const adminCompOrder = db.state.orders.find(o => o._id === 'o_admin_comp')
  assert.equal(adminCompOrder.isDoorLockCodeDestroyed, true)
  assert.equal(adminCompOrder.orderHomeSecurity.destroyed, true)
  assert.equal(adminCompOrder.orderHomeSecurity.oneTimeCode.cipher, '')

  // 2. 客户取消订单
  const clientApi = loadCloudFunction('api', db, 'openid_client')
  const cancelRes = await clientApi.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'o_cancel_sec', reason: '行程有变取消' } })
  assert.equal(cancelRes.ok, true)

  const cancelledOrder = db.state.orders.find(o => o._id === 'o_cancel_sec')
  assert.equal(cancelledOrder.isDoorLockCodeDestroyed, true)
  assert.equal(cancelledOrder.orderHomeSecurity.destroyed, true)
  assert.equal(cancelledOrder.orderHomeSecurity.oneTimeCode.cipher, '')
})


