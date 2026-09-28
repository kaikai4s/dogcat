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


