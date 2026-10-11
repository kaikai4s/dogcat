const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function makeFixture(status = 'in_service') {
  const now = Date.now()
  const db = createCollectionStore({
    users: [
      { _id: 'client_user', openid: 'client', roles: ['client'], status: 'active' },
      { _id: 'staff_user', openid: 'staff', roles: ['client', 'staff'], status: 'active' },
      { _id: 'admin_user', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'stranger_user', openid: 'stranger', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'staff_profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified' }],
    orders: [{
      _id: 'tracking_order', orderNo: 'O_TRACKING_OPT', clientOpenid: 'client', clientUserId: 'client_user',
      staffOpenid: 'staff', staffUserId: 'staff_user', staffProfileId: 'staff_profile', status,
      paymentStatus: 'paid', serviceType: 'feed', serviceSummary: '上门喂养', serviceAddress: '测试地址',
      startTime: new Date(now - 30 * 60 * 1000), endTime: new Date(now + 30 * 60 * 1000),
      serviceSessions: [{ index: 1, startTime: new Date(now - 30 * 60 * 1000), endTime: new Date(now + 30 * 60 * 1000), status: status === 'completed' ? 'completed' : 'in_service', startedAt: new Date(now - 20 * 60 * 1000) }],
      activeSessionIndex: status === 'in_service' ? 1 : 0,
      currentSessionStartedAt: new Date(now - 20 * 60 * 1000),
      startedAt: new Date(now - 20 * 60 * 1000),
      currentLocation: { latitude: 31.2304, longitude: 121.4737, updatedAt: new Date(now - 1000) },
      departureLocation: { latitude: 31.2204, longitude: 121.4637 },
      travelLocation: { latitude: 31.2204, longitude: 121.4637 },
      travelDeparted: true, travelDepartedAt: new Date(now - 25 * 60 * 1000),
      travelDistanceKm: 1.2, distanceFromDestinationKm: 1.2, estimatedTravelMinutes: 8,
      travelEtaMinutes: 8, estimatedArrivalTime: new Date(now + 8 * 60 * 1000),
      radarProximityNotified: true, radarProximityNotifiedAt: new Date(now - 5 * 60 * 1000),
      radarApproachingNotified: true, radarApproachingNotifiedAt: new Date(now - 5 * 60 * 1000),
      trackRevision: 7, checkinRevision: 3,
      checkinRequirements: [{ eventType: 'feed', label: '喂食', required: true }]
    }],
    checkin_logs: [{ _id: 'live_checkin', orderId: 'tracking_order', eventType: 'feed', mediaFileId: 'cloud://feed.jpg', recordedAt: new Date(now - 1000), createdAt: new Date(now - 1000) }],
    track_logs: [], order_home_security: [], order_timeline: [], order_messages: [], order_session_messages: [],
    risk_bypass_logs: [], refunds: [], staff_deposit_evidences: [], unlock_code_logs: []
  })
  return { db, now }
}

test('order progress is lightweight, authorized, and clears transit data after service starts', async () => {
  const { db } = makeFixture('in_service')
  const clientApi = loadCloudFunction('api', db, 'client')
  const strangerApi = loadCloudFunction('api', db, 'stranger')

  const progress = await clientApi.main({ module: 'order', action: 'getOrderProgress', data: { id: 'tracking_order' } })
  assert.equal(progress.ok, true, progress.error || '')
  assert.equal(progress.data.status, 'in_service')
  assert.equal(progress.data.trackRevision, 7)
  assert.equal(progress.data.checkinRevision, 3)
  assert.equal(progress.data.liveCheckins.length, 1)
  assert.equal(progress.data.serviceStarted, true)

  const detail = await clientApi.main({ module: 'order', action: 'getOrderDetail', data: { id: 'tracking_order' } })
  assert.equal(detail.ok, true, detail.error || '')
  assert.equal(detail.data.currentLocation, null)
  assert.equal(detail.data.travelDistanceKm, null)
  assert.equal(detail.data.travelDeparted, false)
  assert.equal(detail.data.radarProximityNotified, false)

  db.state.orders[0].status = 'on_the_way'
  const transitDetail = await clientApi.main({ module: 'order', action: 'getOrderDetail', data: { id: 'tracking_order' } })
  assert.equal(transitDetail.ok, true, transitDetail.error || '')
  assert.equal(transitDetail.data.currentLocation.latitude, 31.2304)
  assert.equal(transitDetail.data.travelEtaMinutes, 8)

  const denied = await strangerApi.main({ module: 'order', action: 'getOrderProgress', data: { id: 'tracking_order' } })
  assert.equal(denied.ok, false)
})

test('completed service accepts precise backfill only inside the recorded session window', async () => {
  const { db, now } = makeFixture('completed')
  const staffApi = loadCloudFunction('api', db, 'staff')
  const point = {
    clientPointId: 'backfill_1', latitude: 31.2305, longitude: 121.4738, accuracy: 8,
    recordedAt: now - 2 * 60 * 1000, isBackfilled: true
  }
  Object.assign(db.state.orders[0], {
    completedAt: new Date(now - 60 * 1000),
    trackBackfillStartedAt: new Date(now - 20 * 60 * 1000),
    trackBackfillFinishedAt: new Date(now - 60 * 1000),
    trackBackfillUntil: new Date(now + 5 * 60 * 1000)
  })

  const accepted = await staffApi.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: 'tracking_order', points: [point], isBackfilled: true } })
  assert.equal(accepted.ok, true, accepted.error || '')
  assert.equal(accepted.data.count, 1)
  assert.equal(db.state.track_logs.length, 1)
  assert.equal(db.state.track_logs[0].isBackfilled, true)

  const outsideSession = await staffApi.main({ module: 'track', action: 'batchUploadTrack', data: {
    orderId: 'tracking_order', points: [{ ...point, clientPointId: 'backfill_late', recordedAt: now + 10 * 60 * 1000 }], isBackfilled: true
  } })
  assert.equal(outsideSession.ok, true, outsideSession.error || '')
  assert.equal(outsideSession.data.count, 0)
  assert.equal(outsideSession.data.rejectedCount, 1)

  db.state.orders[0].trackBackfillUntil = new Date(now - 1)
  const expired = await staffApi.main({ module: 'track', action: 'batchUploadTrack', data: {
    orderId: 'tracking_order', points: [{ ...point, clientPointId: 'backfill_expired' }], isBackfilled: true
  } })
  assert.equal(expired.ok, false)

  const otherStaff = loadCloudFunction('api', db, 'stranger')
  const wrongStaff = await otherStaff.main({ module: 'track', action: 'batchUploadTrack', data: {
    orderId: 'tracking_order', points: [{ ...point, clientPointId: 'backfill_other' }], isBackfilled: true
  } })
  assert.equal(wrongStaff.ok, false)
})

test('admin order evidence and session messages read past the first database page', async () => {
  const { db } = makeFixture('completed')
  for (let index = 0; index < 105; index += 1) {
    await db.collection('track_logs').add({ data: {
      _id: `track_${String(index).padStart(3, '0')}`, orderId: 'tracking_order',
      latitude: 31.23 + index * 0.00001, longitude: 121.47, accuracy: 8, recordedAt: new Date(1800000000000 + index * 1000)
    } })
    await db.collection('checkin_logs').add({ data: {
      _id: `checkin_${String(index).padStart(3, '0')}`, orderId: 'tracking_order', eventType: 'feed',
      mediaFileId: `cloud://feed-${index}.jpg`, recordedAt: new Date(1800000000000 + index * 1000), createdAt: new Date(1800000000000 + index * 1000)
    } })
  }
  for (let index = 0; index < 5; index += 1) {
    await db.collection('order_session_messages').add({ data: {
      orderId: 'tracking_order', senderRole: index % 2 ? 'staff' : 'client', content: `消息${index}`,
      createdAt: new Date(1800000000000 + index * 1000)
    } })
  }

  const adminApi = loadCloudFunction('api', db, 'admin')
  const detail = await adminApi.main({ module: 'admin', action: 'getOrderDetail', data: { orderId: 'tracking_order' } })
  assert.equal(detail.ok, true, detail.error || '')
  assert.equal(detail.data.tracks.length, 105)
  assert.equal(detail.data.checkins.length, 106)

  const firstPage = await adminApi.main({ module: 'admin', action: 'listOrderSessionMessages', data: { orderId: 'tracking_order', page: 1, pageSize: 2 } })
  const secondPage = await adminApi.main({ module: 'admin', action: 'listOrderSessionMessages', data: { orderId: 'tracking_order', page: 2, pageSize: 2 } })
  const lastPage = await adminApi.main({ module: 'admin', action: 'listOrderSessionMessages', data: { orderId: 'tracking_order', page: 3, pageSize: 2 } })
  assert.equal(firstPage.data.total, 5)
  assert.equal(firstPage.data.sessionMessages.length, 2)
  assert.equal(firstPage.data.hasMore, true)
  assert.equal(secondPage.data.sessionMessages[0].content, '消息2')
  assert.equal(secondPage.data.hasMore, true)
  assert.equal(lastPage.data.sessionMessages.length, 1)
  assert.equal(lastPage.data.hasMore, false)
})
