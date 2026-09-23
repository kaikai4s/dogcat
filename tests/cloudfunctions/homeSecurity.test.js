const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

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

