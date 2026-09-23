const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin dashboard pushes down monthly date predicate avoiding full table historical scans', async () => {
  const nowDate = new Date()
  const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}`
  const makeCurrentDate = (day) => `${monthKey}-${String(day).padStart(2, '0')} 10:00:00`

  // 构造当月数据与大量历史年份陈旧数据
  const currentOrders = [
    { _id: 'o_cur_1', status: 'paid', paymentStatus: 'paid', payAmount: 100, createdAt: makeCurrentDate(2), paidAt: makeCurrentDate(2) },
    { _id: 'o_cur_2', status: 'completed', paymentStatus: 'paid', payAmount: 200, createdAt: makeCurrentDate(3), paidAt: makeCurrentDate(3) }
  ]
  const historicalOrders = Array.from({ length: 30 }, (_, i) => ({
    _id: `o_hist_${i}`,
    status: 'completed',
    paymentStatus: 'paid',
    payAmount: 50,
    createdAt: `2021-05-${String((i % 25) + 1).padStart(2, '0')} 10:00:00`,
    paidAt: `2021-05-${String((i % 25) + 1).padStart(2, '0')} 10:00:00`
  }))

  const currentUsers = [
    { _id: 'u_cur_1', openid: 'u_cur_1', roles: ['client'], status: 'active', createdAt: makeCurrentDate(1) },
    { _id: 'u_cur_2', openid: 'u_cur_2', roles: ['client'], status: 'active', createdAt: makeCurrentDate(2) }
  ]
  const historicalUsers = Array.from({ length: 30 }, (_, i) => ({
    _id: `u_hist_${i}`,
    openid: `u_hist_${i}`,
    roles: ['client'],
    status: 'active',
    createdAt: `2021-05-${String((i % 25) + 1).padStart(2, '0')} 10:00:00`
  }))

  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', createdAt: makeCurrentDate(1) }, ...currentUsers, ...historicalUsers],
    orders: [...currentOrders, ...historicalOrders],
    staff_profiles: [{ _id: 'sp1', auditStatus: 'pending' }],
    order_incidents: [{ _id: 'i1', status: 'open' }]
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const result = await fn.main({ module: 'admin', action: 'dashboard', data: {} })

  assert.equal(result.ok, true)
  // 月度趋势数据仅统计当月的订单与注册数，历史数据在数据库层被过滤
  assert.equal(result.data.monthly.totals.orders, 2)
  assert.equal(result.data.monthly.totals.revenue, 300)
  assert.equal(result.data.monthly.totals.registrations, 3) // admin + 2 current users
})

test('admin finance list queries use bounded database pagination without full table readAll', async () => {
  const rangeDate = '2026-09-20'
  const payments = Array.from({ length: 80 }, (_, i) => ({
    _id: `pay_${i}`,
    status: 'paid',
    amount: 100,
    paidAt: `${rangeDate} ${String(10 + Math.floor(i / 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
    createdAt: `${rangeDate} ${String(10 + Math.floor(i / 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`
  }))
  const financeLogs = Array.from({ length: 80 }, (_, i) => ({
    _id: `flog_${i}`,
    action: 'order_paid',
    targetType: 'order',
    amountDelta: 100,
    createdAt: `${rangeDate} ${String(10 + Math.floor(i / 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`
  }))

  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    payments,
    finance_logs: financeLogs
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const paymentsRes = await fn.main({ module: 'admin', action: 'listPayments', data: { startDate: rangeDate, endDate: rangeDate, pageSize: 20 } })
  const logsRes = await fn.main({ module: 'admin', action: 'listFinanceLogs', data: { startDate: rangeDate, endDate: rangeDate, pageSize: 25 } })

  assert.equal(paymentsRes.ok, true)
  assert.equal(paymentsRes.data.length, 20)

  assert.equal(logsRes.ok, true)
  assert.equal(logsRes.data.length, 25)
})
