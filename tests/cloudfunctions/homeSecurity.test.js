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
