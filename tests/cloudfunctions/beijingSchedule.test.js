const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

function setup(exceptions = [], weeklySchedule = { '1': [{ start: 9, end: 18 }], '2': [{ start: 0, end: 6 }] }) {
  const profile = { _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified', weeklySchedule }
  const db = createCollectionStore({
    users: [{ _id: 'staff-user', openid: 'staff', roles: ['staff'], status: 'active' }],
    staff_profiles: [profile], staff_schedule_exceptions: exceptions.map(row => ({ staffOpenid: 'staff', ...row }))
  })
  return { db, profile, context: createContext({ db, cloud: {} }) }
}

test('schedule coverage uses Beijing weekday and the full service interval for text and UTC', async () => {
  const { context, profile } = setup()
  await context.validateStaffScheduleOnly(profile, '2099-08-03 17:00', '2099-08-03 18:00')
  await context.validateStaffScheduleOnly(profile, '2099-08-03T09:00:00Z', '2099-08-03T10:00:00Z')
  await assert.rejects(context.validateStaffScheduleOnly(profile, '2099-08-03 17:30', '2099-08-03 18:30'), /可接单时间段/)
  await assert.rejects(context.validateStaffScheduleOnly(profile, '2099-08-03 17:00', '2099-08-03 18:01'), /可接单时间段/)
  await context.validateStaffScheduleOnly(profile, '2099-08-04 03:30', '2099-08-04 04:30')
  await context.validateStaffScheduleOnly(profile, '2099-08-03T19:30:00Z', '2099-08-03T20:30:00Z')
  await assert.rejects(context.validateStaffScheduleOnly(profile, '2099-08-04 05:30', '2099-08-04 06:30'), /可接单时间段/)
})

test('cross-midnight service checks next-day exceptions but does not include its exclusive endpoint', async () => {
  const { context, profile } = setup([{ dateKey: '2099-08-04', status: 'unavailable' }], { '1': [{ start: 22, end: 24 }], '2': [{ start: 0, end: 6 }] })
  await context.validateStaffScheduleOnly(profile, '2099-08-03 23:00', '2099-08-04 00:00')
  await assert.rejects(context.validateStaffScheduleOnly(profile, '2099-08-03 23:00', '2099-08-04 01:00'), /休息/)
})

test('cross-midnight service accepts matching date exceptions on both calendar days', async () => {
  const { context, profile } = setup([
    { dateKey: '2099-08-03', status: 'available', slots: [{ start: 22, end: 24 }] },
    { dateKey: '2099-08-04', status: 'available', slots: [{ start: 0, end: 2 }] }
  ])
  await context.validateStaffScheduleOnly(profile, '2099-08-03 23:00', '2099-08-04 01:00')
  await assert.rejects(context.validateStaffScheduleOnly(profile, '2099-08-03 23:00', '2099-08-04 02:30'), /可接单时间段/)
})

test('multi-day services validate every visit, while existing bookings still block conflicts', async () => {
  const { context, profile, db } = setup()
  const sessions = [{ startTime: '2099-08-03 17:00', endTime: '2099-08-03 18:00' }, { startTime: '2099-08-04 03:30', endTime: '2099-08-04 04:30' }]
  await context.validateStaffAvailabilityForSessions(profile, sessions)
  await assert.rejects(context.validateStaffAvailabilityForSessions(profile, [sessions[0], { startTime: '2099-08-04 05:30', endTime: '2099-08-04 06:30' }]), /可接单时间段/)
  await db.collection('orders').add({ data: { staffOpenid: 'staff', status: 'assigned', startTime: '2099-08-03T19:45:00Z', endTime: '2099-08-03T20:15:00Z' } })
  await assert.rejects(context.validateStaffAvailabilityForSessions(profile, sessions), /已有订单/)
})

test('nearby list flags and time filtering use full service coverage including date exceptions', async () => {
  const { db } = setup([{ dateKey: '2099-08-04', status: 'unavailable' }])
  db.state.orders = [
    { _id: 'fits', startTime: '2099-08-03 17:00', endTime: '2099-08-03 18:00' },
    { _id: 'overruns', startTime: '2099-08-03 17:30', endTime: '2099-08-03 18:30' },
    { _id: 'rest-day', startTime: '2099-08-04 03:30', endTime: '2099-08-04 04:30' }
  ].map(order => ({ ...order, publishMode: 'open', status: 'paid', payAmount: 69, clientOpenid: 'client' }))
  const fn = loadCloudFunction('api', db, 'staff')
  const result = await fn.main({ module: 'staff', action: 'listNearbyOrders', data: {} })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(Object.fromEntries(result.data.map(order => [order._id, order.inTime])), { fits: true, overruns: false, 'rest-day': false })
  const filtered = await fn.main({ module: 'staff', action: 'listNearbyOrders', data: { inServiceTime: true } })
  assert.equal(filtered.ok, true, filtered.message)
  assert.deepEqual(filtered.data.map(order => order._id), ['fits'])
})
