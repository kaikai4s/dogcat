const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

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
