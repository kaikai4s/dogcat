const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

test('homeSecurity getUnlockCode rate limit: max 3 requests per minute per order, then rejected and alerted', async () => {
  const staffOpenid = 'openid_staff_unlock'
  const clientOpenid = 'openid_client_unlock'
  const orderId = 'order_unlock_ratelimit'

  const db = createCollectionStore({
    users: [
      { _id: 'u_client_unlock', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' },
      { _id: 'u_staff_unlock', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_UNLOCK_001',
        clientOpenid,
        staffOpenid,
        status: 'assigned',
        startTime: '2000-01-01 00:00',
        endTime: '2999-12-31 23:59'
      }
    ],
    unlock_code_logs: [],
    admin_notifications: []
  })

  const clientFn = loadCloudFunction('homeSecurity', db, clientOpenid)
  const staffFn = loadCloudFunction('homeSecurity', db, staffOpenid)

  // 1. 客户设置一次性密码
  const setRes = await clientFn.main({
    action: 'updateOrderOneTimeCode',
    data: {
      orderId,
      code: '889900',
      effectiveStart: '2000-01-01 00:00',
      effectiveEnd: '2999-12-31 23:59'
    }
  })
  assert.equal(setRes.ok, true)

  // 2. 宠托师在 1 分钟内连续查看 3 次，全部成功
  const res1 = await staffFn.main({ action: 'getUnlockCode', data: { orderId } })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.doorLockCode, '889900')

  const res2 = await staffFn.main({ action: 'getUnlockCode', data: { orderId } })
  assert.equal(res2.ok, true)
  assert.equal(res2.data.doorLockCode, '889900')

  const res3 = await staffFn.main({ action: 'getUnlockCode', data: { orderId } })
  assert.equal(res3.ok, true)
  assert.equal(res3.data.doorLockCode, '889900')

  assert.equal(db.state.unlock_code_logs.length, 3)
  assert.equal(db.state.unlock_code_logs.every(log => log.result === 'success'), true)

  // 3. 第 4 次高频调用触发频次限制
  const res4 = await staffFn.main({ action: 'getUnlockCode', data: { orderId } })
  assert.equal(res4.ok, false)
  assert.match(res4.message, /密码查看过于频繁，请稍后再试/)

  // 验证第 4 条审计日志标记为 rate_limited 与 isRateLimited: true
  assert.equal(db.state.unlock_code_logs.length, 4)
  const limitedLog = db.state.unlock_code_logs[3]
  assert.equal(limitedLog.result, 'rate_limited')
  assert.equal(limitedLog.isRateLimited, true)

  // 验证管理员端收到超限预警
  const notice = db.state.admin_notifications.find(n => n.type === 'unlock_code_rate_limit_warning' && n.orderId === orderId)
  assert.ok(notice, 'Admin notification must be generated on unlock code rate limit exceeded')
  assert.equal(notice.level, 'warning')
  assert.match(notice.content, /1分钟内查看超过3次/)

  // 4. 模拟 1 分钟后（时间滑动过去 65 秒），之前的记录过期，再次查看恢复正常
  const originalLogs = db.state.unlock_code_logs
  // 将之前的审计记录时间往前推 65 秒
  originalLogs.forEach(log => {
    log.createdAt = new Date(Date.now() - 65 * 1000)
  })

  const resAfterWindow = await staffFn.main({ action: 'getUnlockCode', data: { orderId } })
  assert.equal(resAfterWindow.ok, true)
  assert.equal(resAfterWindow.data.doorLockCode, '889900')
})
