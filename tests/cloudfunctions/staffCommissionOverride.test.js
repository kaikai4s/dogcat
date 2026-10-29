const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

function setup() {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'admin', status: 'active', roles: ['admin'] },
      { _id: 'staff', openid: 'staff', status: 'active', roles: ['staff'] },
      { _id: 'other', openid: 'other', status: 'active', roles: ['client'] }
    ],
    staff_profiles: [{ _id: 'profile', openid: 'staff', realName: '张师傅', auditStatus: 'approved' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { settlement: { staffCommissionRate: 0.7, settlementDelayDays: 0 } } }],
    orders: [
      { _id: 'order1', orderNo: 'ORD1', staffOpenid: 'staff', staffProfileId: 'profile', clientOpenid: 'other', payAmount: 100, status: 'in_service', paymentStatus: 'paid', paidAt: '2026-10-29' },
      { _id: 'order2', orderNo: 'ORD2', staffOpenid: 'staff', staffProfileId: 'profile', clientOpenid: 'other', payAmount: 100, status: 'in_service', paymentStatus: 'paid', paidAt: '2026-10-29' }
    ],
    staff_earnings: [], finance_logs: [], admin_operation_logs: []
  })
  return { db, admin: loadCloudFunction('api', db, 'admin'), client: loadCloudFunction('api', db, 'other'), service: createContext({ db, cloud: {} }) }
}

test('admin personal commission rate is used for estimates and new earnings, then resets without rewriting history', async () => {
  const { db, admin, service } = setup()
  const set = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '80' } })
  assert.equal(set.ok, true, set.message)
  assert.equal(db.state.staff_profiles[0].commissionRateOverride, 0.8)
  const profiles = await admin.main({ module: 'admin', action: 'listStaffProfiles', data: { pageSize: 10 } })
  assert.equal(profiles.data.list[0].commissionRateOverride, 0.8)
  assert.equal(profiles.data.defaultCommissionRate, 0.7)

  const estimated = await service.calculateStaffEarningForOrder(db.state.orders[0])
  assert.deepEqual(estimated, { earningAmount: 80, commissionRate: 0.8 })
  const detail = await admin.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'order1' } })
  assert.equal(detail.ok, true, detail.message)
  assert.equal(detail.data.order.profitSummary.staffReward, 80)
  const earning = await service.ensureStaffEarning(db.state.orders[0])
  assert.equal(earning.amount, 80)
  assert.equal(earning.commissionRate, 0.8)
  assert.equal(db.state.finance_logs[0].detail.commissionRate, 0.8)
  db.state.orders[0].status = 'completed'

  const reset = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', useDefault: true } })
  assert.equal(reset.ok, true, reset.message)
  assert.equal(reset.data.commissionRateOverride, null)
  assert.equal((await service.calculateStaffEarningForOrder(db.state.orders[1])).earningAmount, 70)
  assert.equal((await service.ensureStaffEarning(db.state.orders[1])).amount, 70)
  const historical = await admin.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'order1' } })
  assert.equal(historical.data.order.profitSummary.staffReward, 80)
  assert.equal(historical.data.order.profitSummary.commissionRateText, '80%')
  const orderList = await admin.main({ module: 'admin', action: 'listOrders', data: { pageSize: 10 } })
  assert.equal(orderList.ok, true, orderList.message)
  assert.equal(orderList.data.list.find(item => item._id === 'order1').profitSummary.staffReward, 80)
  assert.equal(orderList.data.list.find(item => item._id === 'order2').profitSummary.staffReward, 70)
  assert.equal(db.state.staff_earnings.find(row => row.orderId === 'order1').amount, 80)
})

test('personal rate validates input and permission, including exact 0 and 100 percent', async () => {
  const { db, admin, client, service } = setup()
  for (const commissionPercent of ['-1', '100.01', '70.123', '', 'invalid']) {
    const result = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent } })
    assert.equal(result.ok, false, commissionPercent)
  }
  const denied = await client.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '100' } })
  assert.equal(denied.ok, false)
  assert.equal(db.state.staff_profiles[0].commissionRateOverride, undefined)

  const zero = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '0' } })
  assert.equal(zero.ok, true)
  assert.equal((await service.calculateStaffEarningForOrder(db.state.orders[0])).earningAmount, 0)
  const full = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '100' } })
  assert.equal(full.ok, true)
  assert.equal((await service.calculateStaffEarningForOrder(db.state.orders[0])).earningAmount, 100)
  const precise = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '33.33' } })
  assert.equal(precise.ok, true)
  assert.equal(db.state.staff_profiles[0].commissionRateOverride, 0.3333)
})

test('fixed urgent reward does not change when the sitter has a personal percentage', async () => {
  const { db, admin, service } = setup()
  await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '90' } })
  const urgent = { ...db.state.orders[0], _id: 'urgent', isUrgent: true, urgentStaffReward: 120 }
  assert.equal((await service.calculateStaffEarningForOrder(urgent)).earningAmount, 120)
  const earning = await service.ensureStaffEarning(urgent)
  assert.equal(earning.amount, 120)
  assert.equal(service.buildOrderProfitSummary(urgent, earning, 0.9).commissionRateText, '加急补贴一口价')
  const fixed = service.buildOrderProfitSummary({ ...urgent, urgentStaffReward: 60 }, { ...earning, amount: 60 }, 0.9)
  assert.equal(fixed.isFixedUrgentReward, true)
  assert.equal(fixed.platformProfit, 40)
  assert.equal(fixed.platformProfitRateText, '固定奖励后留存')
})

test('bad current sitter rate does not block historical order details or the entire order list', async () => {
  const { db, admin, service } = setup()
  db.state.staff_profiles[0].commissionRateOverride = 0.8
  await service.ensureStaffEarning(db.state.orders[0])
  db.state.orders[0].status = 'completed'
  db.state.staff_profiles[0].commissionRateOverride = 'invalid'

  const list = await admin.main({ module: 'admin', action: 'listOrders', data: { pageSize: 10 } })
  const history = await admin.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'order1' } })
  const pending = await admin.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'order2' } })
  assert.equal(list.ok, true, list.message)
  assert.equal(history.ok, true, history.message)
  assert.equal(pending.ok, true, pending.message)
  assert.equal(list.data.list.find(item => item._id === 'order1').profitSummary.staffReward, 80)
  assert.equal(history.data.order.profitSummary.staffReward, 80)
  assert.equal(history.data.order.profitSummary.commissionRateText, '80%')
  const unearned = list.data.list.find(item => item._id === 'order2')
  assert.equal(unearned.profitSummary, null)
  assert.match(unearned.profitError, /待核对/)
  assert.equal(pending.data.order.profitSummary, null)
  assert.match(pending.data.order.profitError, /待核对/)
})

test('cancelled orders with retained staff earnings show the same actual amount in list and detail', async () => {
  const { db, admin, service } = setup()
  const set = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', commissionPercent: '80' } })
  assert.equal(set.ok, true, set.message)
  await service.ensureStaffEarning(db.state.orders[0])
  db.state.staff_earnings.find(item => item.orderId === 'order1').amount = 40
  db.state.orders[0].status = 'cancelled'
  db.state.orders[0].refundAmount = 50
  db.state.orders[0].paymentStatus = 'refunded'
  const reset = await admin.main({ module: 'admin', action: 'setStaffCommissionRate', data: { staffProfileId: 'profile', useDefault: true } })
  assert.equal(reset.ok, true, reset.message)

  const list = await admin.main({ module: 'admin', action: 'listOrders', data: { pageSize: 10 } })
  const detail = await admin.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'order1' } })
  assert.equal(list.ok, true, list.message)
  assert.equal(detail.ok, true, detail.message)
  assert.equal(list.data.list.find(item => item._id === 'order1').staffReward, 40)
  assert.equal(detail.data.order.staffReward, 40)
  assert.equal(list.data.list.find(item => item._id === 'order1').profitSummary.commissionRateText, '80%')
})

test('invalid sitter rate blocks a multi-day cancellation before any refund is submitted', async () => {
  const { db, client } = setup()
  db.state.staff_profiles[0].commissionRateOverride = 'invalid'
  const start = new Date(Date.now() + 48 * 3600000).toISOString()
  const end = new Date(Date.now() + 49 * 3600000).toISOString()
  Object.assign(db.state.orders[0], {
    status: 'day_completed', paymentNo: 'PAY_ORDER_1', sessionCount: 2,
    startTime: new Date(Date.now() - 24 * 3600000).toISOString(), endTime: end,
    serviceSessions: [
      { index: 1, status: 'completed', startTime: new Date(Date.now() - 24 * 3600000).toISOString() },
      { index: 2, status: 'pending', startTime: start, endTime: end }
    ]
  })
  const cancelled = await client.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'order1' } })
  assert.equal(cancelled.ok, false)
  assert.match(cancelled.message, /个人提成比例异常/)
  assert.equal(db.state.orders[0].status, 'day_completed')
  assert.equal((db.state.refunds || []).length, 0)

  db.state.staff_profiles[0].commissionRateOverride = 0.8
  const retry = await client.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'order1' } })
  assert.equal(retry.ok, true, retry.message)
  assert.equal(db.state.orders[0].status, 'cancelled')
  assert.equal(db.state.staff_earnings.find(item => item.orderId === 'order1').amount, 40)
})
