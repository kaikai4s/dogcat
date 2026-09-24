const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('1. checkin: sanitization within 1.0km succeeds and records distanceKm', async () => {
  const staffOpenid = 'openid_staff_checkin_1'
  const clientOpenid = 'openid_client_checkin_1'
  const orderId = 'order_checkin_distance_1'
  const time = Date.now()

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_1', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_1', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_DISTANCE_1',
        clientOpenid,
        staffOpenid,
        staffUserId: 'u_staff_1',
        status: 'assigned',
        addressLatitude: 31.2000,
        addressLongitude: 121.5000,
        startTime: '2026-10-01 10:00',
        endTime: '2026-10-01 11:00',
        requiredCheckins: ['sanitization', 'feed']
      }
    ],
    order_early_start_requests: [
      { _id: 'es_1', orderId, status: 'approved', approvedAt: new Date() }
    ],
    checkin_logs: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, staffOpenid)
  // 打卡位置在 31.2005, 121.5005（相距约 70米，在 1km 电子围栏内）
  const res = await fn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'sanitization',
      mediaFileId: `cloud://bucket/${time}_sanitization.jpg`,
      latitude: 31.2005,
      longitude: 121.5005,
      remark: '消毒到位'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.eventType, 'sanitization')
  assert.ok(typeof res.data.distanceKm === 'number')
  assert.ok(res.data.distanceKm < 0.2) // 70米左右
  assert.equal(db.state.checkin_logs.length, 1)
  assert.equal(db.state.checkin_logs[0].distanceKm, res.data.distanceKm)
})

test('2. checkin: remote sanitization (>1.0km) is strictly rejected', async () => {
  const staffOpenid = 'openid_staff_checkin_2'
  const clientOpenid = 'openid_client_checkin_2'
  const orderId = 'order_checkin_distance_2'
  const time = Date.now()

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_2', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_2', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_DISTANCE_2',
        clientOpenid,
        staffOpenid,
        staffUserId: 'u_staff_2',
        status: 'assigned',
        addressLatitude: 31.2000,
        addressLongitude: 121.5000,
        startTime: '2026-10-01 10:00',
        endTime: '2026-10-01 11:00',
        requiredCheckins: ['sanitization', 'feed']
      }
    ],
    order_early_start_requests: [
      { _id: 'es_2', orderId, status: 'approved', approvedAt: new Date() }
    ],
    checkin_logs: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, staffOpenid)
  // 打卡位置在 31.2500, 121.5000（相距约 5.5km，超出 1km 电子围栏）
  const res = await fn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'sanitization',
      mediaFileId: `cloud://bucket/${time}_sanitization.jpg`,
      latitude: 31.2500,
      longitude: 121.5000,
      remark: '虚假远程打卡'
    }
  })

  assert.equal(res.ok, false)
  assert.match(res.message, /超出服务现场范围，请到达客户服务现场后打卡/)
  assert.equal(db.state.checkin_logs.length, 0)
})

test('3. checkin: in-service normal checkin beyond 1.0km is rejected for live checkin', async () => {
  const staffOpenid = 'openid_staff_checkin_3'
  const clientOpenid = 'openid_client_checkin_3'
  const orderId = 'order_checkin_distance_3'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_3', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_3', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_DISTANCE_3',
        clientOpenid,
        staffOpenid,
        staffUserId: 'u_staff_3',
        status: 'in_service',
        addressLatitude: 31.2000,
        addressLongitude: 121.5000,
        startTime: '2026-10-01 10:00',
        endTime: '2026-10-01 11:00',
        requiredCheckins: ['feed']
      }
    ],
    checkin_logs: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, staffOpenid)
  // 现场打卡（非补录）但在 3km 以外
  const res = await fn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'feed',
      mediaFileId: 'cloud://bucket/feed_photo.jpg',
      latitude: 31.2300,
      longitude: 121.5000,
      isBackfilled: false,
      remark: '远程喂猫'
    }
  })

  assert.equal(res.ok, false)
  assert.match(res.message, /超出服务现场范围，请到达客户服务现场后打卡/)
  assert.equal(db.state.checkin_logs.length, 0)
})

test('4. checkin: backfilled checkin (isBackfilled: true) allows distance exemption but records distanceKm', async () => {
  const staffOpenid = 'openid_staff_checkin_4'
  const clientOpenid = 'openid_client_checkin_4'
  const orderId = 'order_checkin_distance_4'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_4', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_4', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_DISTANCE_4',
        clientOpenid,
        staffOpenid,
        staffUserId: 'u_staff_4',
        status: 'in_service',
        addressLatitude: 31.2000,
        addressLongitude: 121.5000,
        startTime: '2026-10-01 10:00',
        endTime: '2026-10-01 11:00',
        requiredCheckins: ['feed']
      }
    ],
    checkin_logs: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, staffOpenid)
  // 离场后补传照片（isBackfilled: true）
  const res = await fn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'feed',
      mediaFileId: 'cloud://bucket/backfilled_photo.jpg',
      latitude: 31.2300,
      longitude: 121.5000,
      isBackfilled: true,
      remark: '地库无信号，出来后补传'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.isBackfilled, true)
  assert.ok(typeof res.data.distanceKm === 'number')
  assert.ok(res.data.distanceKm > 1.0)
  assert.equal(db.state.checkin_logs.length, 1)
})

test('5. checkin: orders without coordinate gracefully fallback without distance block', async () => {
  const staffOpenid = 'openid_staff_checkin_5'
  const clientOpenid = 'openid_client_checkin_5'
  const orderId = 'order_checkin_distance_5'

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_5', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_client_5', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_DISTANCE_5',
        clientOpenid,
        staffOpenid,
        staffUserId: 'u_staff_5',
        status: 'in_service',
        addressLatitude: 0,
        addressLongitude: 0,
        startTime: '2026-10-01 10:00',
        endTime: '2026-10-01 11:00',
        requiredCheckins: ['feed']
      }
    ],
    checkin_logs: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, staffOpenid)
  const res = await fn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'feed',
      mediaFileId: 'cloud://bucket/normal_photo.jpg',
      latitude: 31.2300,
      longitude: 121.5000,
      remark: '无坐标历史订单打卡'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.distanceKm, null)
  assert.equal(db.state.checkin_logs.length, 1)
})
