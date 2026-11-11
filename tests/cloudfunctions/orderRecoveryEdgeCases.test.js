const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createExecution = require('../../cloudfunctions/api/services/serviceExecution')
const createOverdue = require('../../cloudfunctions/api/services/overdueOrders')

const current = new Date('2026-11-13T16:40:00Z')
const beijingCurrent = '2026-11-14 00:40:00'

function fixture({ group = false, long = true, final = false, complete = true } = {}) {
  const count = long ? (final ? 12 : 13) : 1
  const activeIndex = long ? 12 : 1
  const sessions = Array.from({ length: count }, (_, i) => {
    const day = long ? i + 2 : 13
    const date = `2026-11-${String(day).padStart(2, '0')}`
    const endDate = `2026-11-${String(day + 1).padStart(2, '0')}`
    return { index: i + 1, date, startTime: `${date} 23:00`, endTime: `${endDate} 00:00`,
      status: i + 1 < activeIndex ? 'completed' : i + 1 === activeIndex ? 'in_service' : 'pending',
      ...(i + 1 === activeIndex ? { startedAt: '2026-11-13T15:00:00Z' } : {}) }
  })
  const ids = group ? ['a', 'b'] : ['a']
  const db = createCollectionStore({
    users: ids.map(id => ({ _id: id, openid: id, roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 })),
    orders: ids.map(id => ({ _id: id, orderNo: id, clientOpenid: id, clientUserId: id,
      staffOpenid: 'staff', status: 'in_service', paymentStatus: 'paid', paymentChannel: 'wechat',
      payAmount: 100, orderType: long ? 'multi_day' : 'single',
      startTime: sessions[0].startTime, endTime: sessions.at(-1).endTime,
      serviceSessions: structuredClone(sessions), activeSessionIndex: activeIndex,
      currentSessionStartedAt: '2026-11-13T15:00:00Z', startedAt: sessions[0].startTime,
      requiredCheckins: complete ? [] : ['arrive'], durationMinutes: 60,
      ...(group ? { groupBuyId: 'group', groupBuyStatus: 'formed' } : {}) })),
    pet_playground_groups: group ? [{ _id: 'group', status: 'formed', formedAt: 1 }] : [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      settlement: { staffCommissionRate: .7, settlementDelayDays: 0 }
    } }]
  })
  optimistic(db)
  const context = { ...createContext({ db, cloud: {} }), now: () => current }
  const execution = createExecution({ ...context, requireSanitizationEvidence: async () => {}, readScopedDocuments: async () => [] })
  const overdue = createOverdue({ ...context, ...execution, notifyOrder: async () => {}, notifyAdmins: async () => {} })
  return { db, overdue, execution, context }
}

test('a service on day twelve auto-completes without skipping the remaining day or creating earnings early', async () => {
  const f = fixture()
  const result = await f.overdue.processOverdueUnfinishedOrders(current)
  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'auto_completed')
  assert.equal(result[0].sessionIndex, 12)
  assert.equal(f.db.state.orders[0].status, 'day_completed')
  assert.deepEqual(f.db.state.orders[0].serviceSessions.slice(-2).map(s => s.status), ['completed', 'pending'])
  assert.equal((f.db.state.staff_earnings || []).length, 0)
  assert.equal((await f.overdue.processOverdueUnfinishedOrders(current)).length, 0)
})

test('a formed group finishing on day twelve settles every household once after Beijing midnight', async () => {
  const f = fixture({ group: true, final: true })
  const result = await f.overdue.processOverdueUnfinishedOrders(current)
  assert.equal(result.length, 2)
  assert.ok(f.db.state.orders.every(order => order.status === 'completed'))
  assert.ok(f.db.state.orders.every(order => order.completedAt.toISOString() === current.toISOString()))
  assert.equal(f.db.state.staff_earnings.length, 2)
  assert.ok(f.db.state.staff_earnings.every(earning => earning.amount === 70))
  await f.execution.retryPendingGroupCompletions()
  assert.equal(f.db.state.staff_earnings.length, 2)
  assert.equal(f.db.state.point_logs.length, 2)
})

test('missing checkins on day twelve create the correct session incident only once', async () => {
  const f = fixture({ complete: false })
  const time = '2026-11-14 01:05:00'
  const result = await f.overdue.processOverdueUnfinishedOrders(time)
  assert.equal(result.length, 1)
  assert.equal(result[0].type, 'incident_created')
  assert.equal(f.db.state.order_incidents[0]._id, 'inc_a_12_finish_overdue')
  assert.equal(f.db.state.order_incidents[0].createdAt.toISOString(), '2026-11-13T17:05:00.000Z')
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal((await f.overdue.processOverdueUnfinishedOrders(time)).length, 0)
  assert.equal(f.db.state.order_incidents.length, 1)
})

test('an old in-service session remains outside the existing seven-day processing window', async () => {
  const f = fixture()
  f.db.state.orders[0].currentSessionStartedAt = '2026-11-02T15:00:00Z'
  assert.deepEqual(await f.overdue.processOverdueUnfinishedOrders(current), [])
  assert.equal(f.db.state.orders[0].status, 'in_service')
})

test('old in-service records do not hide a current visit after the first thousand records', async () => {
  const f = fixture()
  const order = structuredClone(f.db.state.orders[0])
  f.db.state.orders[0]._id = 'z-current'
  f.db.state.orders.unshift(...Array.from({ length: 1001 }, (_, i) => ({ ...order,
    _id: `old-${String(i).padStart(4, '0')}`, currentSessionStartedAt: '2026-11-02T15:00:00Z' })))
  const result = await f.overdue.processOverdueUnfinishedOrders(current)
  assert.equal(result.length, 1)
  assert.equal(result[0].orderId, 'z-current')
  assert.equal(f.db.state.orders.at(-1).status, 'day_completed')
  assert.ok(f.db.state.orders.slice(0, -1).every(row => row.status === 'in_service'))
})

test('a Beijing wall-time completion argument records the same instant as its ISO equivalent', async () => {
  const f = fixture({ long: false })
  const result = await f.overdue.processOverdueUnfinishedOrders(beijingCurrent)
  assert.equal(result.length, 1)
  assert.equal(f.db.state.orders[0].completedAt.toISOString(), current.toISOString())
  assert.equal(f.db.state.staff_earnings[0].availableAt.toISOString(), current.toISOString())
})

test('a Beijing wall-time reminder argument preserves the correct update time', async () => {
  const f = fixture({ long: false })
  Object.assign(f.db.state.orders[0], { status: 'assigned', activeSessionIndex: 0, currentSessionStartedAt: '' })
  f.db.state.orders[0].serviceSessions[0].status = 'pending'
  const result = await f.overdue.processOverdueUnstartedOrders(beijingCurrent)
  assert.equal(result.length, 1)
  assert.equal(f.db.state.orders[0].updatedAt.toISOString(), current.toISOString())
})

test('an unfinished-service reminder records Beijing wall time without shifting its date', async () => {
  const f = fixture({ long: false, complete: false })
  const result = await f.overdue.processOverdueUnfinishedOrders('2026-11-14 00:20:00')
  assert.equal(result[0].type, 'reminded')
  assert.equal(f.db.state.orders[0].overdueFinishRemindedAt.toISOString(), '2026-11-13T16:20:00.000Z')
  assert.equal(f.db.state.orders[0].updatedAt.toISOString(), '2026-11-13T16:20:00.000Z')
})
