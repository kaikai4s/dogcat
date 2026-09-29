const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('Multi-day order: getCancelQuote on day_completed calculates partial refund and cancelOrder settles completed days', async () => {
  const clientOpenid = 'openid_client_multiday'
  const staffOpenid = 'openid_staff_multiday'
  const orderId = 'order_multiday_1'

  const currentTime = new Date()
  const day2Start = new Date(currentTime.getTime() + 10 * 36e5).toISOString() // 10小时后 (<24h)
  const day2End = new Date(currentTime.getTime() + 11 * 36e5).toISOString()
  const day3Start = new Date(currentTime.getTime() + 34 * 36e5).toISOString() // 34小时后 (>=24h)
  const day3End = new Date(currentTime.getTime() + 35 * 36e5).toISOString()

  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active', phone: '13900000001' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active', phone: '13800000002', realName: '张师傅' }
    ],
    staff_profiles: [
      { _id: 'sp_multiday', openid: staffOpenid, realName: '张师傅', auditStatus: 'approved' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_MULTI_001',
        clientOpenid,
        clientUserId: 'u_client',
        staffOpenid,
        staffUserId: 'u_staff',
        status: 'day_completed',
        paymentStatus: 'paid',
        paymentNo: 'PAY_MULTI_001',
        amount: 300,
        payAmount: 300,
        sessionCount: 3,
        serviceSessions: [
          { index: 1, date: '2026-09-28', startTime: '2026-09-28 10:00:00', endTime: '2026-09-28 11:00:00', status: 'completed' },
          { index: 2, date: '2026-09-29', startTime: day2Start, endTime: day2End, status: 'pending' },
          { index: 3, date: '2026-09-30', startTime: day3Start, endTime: day3End, status: 'pending' }
        ],
        startTime: '2026-09-28 10:00:00',
        endTime: day3End
      }
    ],
    refunds: [],
    staff_earnings: [],
    order_timeline: [],
    order_client_messages: [],
    order_staff_messages: []
  })

  const clientApi = loadCloudFunction('api', db, clientOpenid)

  // 1. 试算取消退款金额
  const quoteRes = await clientApi.main({
    module: 'order',
    action: 'getCancelQuote',
    data: { orderId }
  })
  assert.equal(quoteRes.ok, true, quoteRes.message)
  assert.equal(quoteRes.data.canCancel, true)
  assert.equal(quoteRes.data.isMultiDayPartialCancel, true)
  // Day 1 已完成 (0退款), Day 2 不足24h退80% (100 * 0.8 = 80), Day 3 超过24h退100% (100). 合计 180
  assert.equal(quoteRes.data.refundAmount, 180)
  assert.ok(quoteRes.data.ruleText.includes('已完成1天服务不予退还'))

  // 2. 确认取消订单
  const cancelRes = await clientApi.main({
    module: 'order',
    action: 'cancelOrder',
    data: { orderId, reason: '主人提前回家' }
  })
  assert.equal(cancelRes.ok, true, cancelRes.message)
  assert.equal(cancelRes.data.status, 'cancelled')
  assert.equal(cancelRes.data.refundAmount, 180)

  // 3. 验证数据库订单及场次状态
  const updatedOrder = db.state.orders.find((o) => o._id === orderId)
  assert.equal(updatedOrder.status, 'cancelled')
  assert.equal(updatedOrder.serviceSessions[0].status, 'completed')
  assert.equal(updatedOrder.serviceSessions[1].status, 'cancelled')
  assert.equal(updatedOrder.serviceSessions[2].status, 'cancelled')

  // 4. 验证退款记录与宠托师首日履约收益结算 (300 - 180 = 120 留存, 70% 佣金 = 84)
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.refunds[0].refundAmount, 180)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.staff_earnings[0].amount, 84)
  assert.equal(db.state.staff_earnings[0].staffOpenid, staffOpenid)
})

test('Revoked or disabled staff cannot depart for service or view unlock codes', async () => {
  const staffOpenid = 'openid_revoked_staff'
  const clientOpenid = 'openid_client_test'
  const orderId = 'order_security_lock'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_revoked', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active', phone: '13800000009' },
      { _id: 'u_client_test', openid: clientOpenid, roles: ['client'], status: 'active', phone: '13900000008' }
    ],
    staff_profiles: [
      { _id: 'sp_revoked', openid: staffOpenid, auditStatus: 'revoked' }
    ],
    orders: [
      {
        _id: orderId,
        clientOpenid,
        staffOpenid,
        status: 'assigned',
        paymentStatus: 'paid',
        startTime: '2026-09-29 10:00:00',
        endTime: '2026-09-29 11:00:00',
        orderHomeSecurity: { doorLockCodeCipher: 'cipher', doorLockCodeIv: 'iv', doorLockCodeTag: 'tag' }
      }
    ],
    order_timeline: [],
    unlock_code_logs: []
  })

  const staffApi = loadCloudFunction('api', db, staffOpenid)

  // 1. 被撤销资质的宠托师出发前往被拦截
  const departRes = await staffApi.main({
    module: 'order',
    action: 'departForService',
    data: { orderId }
  })
  assert.equal(departRes.ok, false)
  assert.match(departRes.error, /宠托师资质已被平台暂停或撤销/)

  // 2. 被撤销资质的宠托师获取门锁密码被拦截
  const unlockRes = await staffApi.main({
    module: 'homeSecurity',
    action: 'getUnlockCode',
    data: { orderId }
  })
  assert.equal(unlockRes.ok, false)
  assert.match(unlockRes.error, /宠托师资质已被平台暂停或撤销/)

  // 3. 账号被禁用的宠托师同样被拦截
  db.state.users[0].status = 'disabled'
  db.state.staff_profiles[0].auditStatus = 'approved'
  const disabledDepartRes = await staffApi.main({
    module: 'order',
    action: 'departForService',
    data: { orderId }
  })
  assert.equal(disabledDepartRes.ok, false)
  assert.match(disabledDepartRes.error, /请先登录|已被禁用/)
})

test('Withdrawal request validation blocks client, disabled users, and revoked staff', async () => {
  const normalStaffOpenid = 'openid_normal_staff'
  const clientOpenid = 'openid_pure_client'
  const revokedStaffOpenid = 'openid_revoked_withdrawal'

  const db = createCollectionStore({
    users: [
      { _id: 'u_norm_staff', openid: normalStaffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_only', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' },
      { _id: 'u_rev_staff', openid: revokedStaffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_norm', openid: normalStaffOpenid, auditStatus: 'approved' },
      { _id: 'sp_rev', openid: revokedStaffOpenid, auditStatus: 'revoked' }
    ],
    staff_earnings: [
      { _id: 'e_1', staffOpenid: normalStaffOpenid, status: 'available', amount: 50 },
      { _id: 'e_2', staffOpenid: revokedStaffOpenid, status: 'available', amount: 50 }
    ],
    withdraw_requests: [],
    finance_logs: []
  })

  // 1. 普通客户调用提现直接拦截
  const clientApi = loadCloudFunction('api', db, clientOpenid)
  const clientRes = await clientApi.main({
    module: 'finance',
    action: 'createWithdrawRequest',
    data: { accountName: '客户', accountNo: '6222000000000001' }
  })
  assert.equal(clientRes.ok, false)
  assert.match(clientRes.error, /仅宠托师可申请提现/)

  // 2. 被撤销资质宠托师调用提现拦截
  const revokedApi = loadCloudFunction('api', db, revokedStaffOpenid)
  const revokedRes = await revokedApi.main({
    module: 'finance',
    action: 'createWithdrawRequest',
    data: { accountName: '失信宠托', accountNo: '6222000000000002' }
  })
  assert.equal(revokedRes.ok, false)
  assert.match(revokedRes.error, /宠托师资质已被平台暂停或撤销/)

  // 3. 正常宠托师正常提交提现
  const normalApi = loadCloudFunction('api', db, normalStaffOpenid)
  const normalRes = await normalApi.main({
    module: 'finance',
    action: 'createWithdrawRequest',
    data: { accountName: '诚信宠托', accountNo: '6222000000000003' }
  })
  assert.equal(normalRes.ok, true, normalRes.message)
  assert.equal(normalRes.data.status, 'pending')
  assert.equal(normalRes.data.amount, 50)
})
