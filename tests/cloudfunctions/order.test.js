const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createFinishStore(checkinLogs = []) {
  return createCollectionStore({
    users: [
      { _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'c1', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 }
    ],
    orders: [{ _id: 'o1', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', clientUserId: 'c1', status: 'in_service', payAmount: 60, requiredCheckins: ['enter_door'] }],
    checkin_logs: checkinLogs,
    order_timeline: [],
    order_message_threads: [],
    order_messages: [],
    staff_earnings: [],
    point_logs: [],
    retro_card_logs: []
  })
}

test('order createOrder creates pending order for current client pet', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceType: 'walk',
      serviceAddress: '测试地址',
      addressDetail: '1栋101',
      doorplate: '门口脚垫下有钥匙',
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'pending_pay')
  assert.equal(result.data.payAmount, 89)
  assert.equal(db.state.orders.length, 1)
})

test('order finishService rejects when required checkins are missing', async () => {
  const db = createFinishStore([])
  const fn = loadCloudFunction('api', db, 'openid_staff')

  const result = await fn.main({ module: 'order', action: 'finishService', data: { id: 'o1' } })

  assert.equal(result.ok, false)
  assert.match(result.message, /缺少必打卡照片/)
})

test('order finishService rejects when required checkin has no photo', async () => {
  const db = createFinishStore([{ _id: 'ck1', orderId: 'o1', eventType: 'enter_door', mediaFileId: '', latitude: 31.2, longitude: 121.5 }])
  const fn = loadCloudFunction('api', db, 'openid_staff')

  const result = await fn.main({ module: 'order', action: 'finishService', data: { id: 'o1' } })

  assert.equal(result.ok, false)
  assert.match(result.message, /缺少必打卡照片/)
})

test('order finishService rejects when required checkin photo is deleted', async () => {
  const db = createFinishStore([{ _id: 'ck1', orderId: 'o1', eventType: 'enter_door', mediaFileId: 'cloud://photo.jpg', deletedAt: '2026-08-28' }])
  const fn = loadCloudFunction('api', db, 'openid_staff')

  const result = await fn.main({ module: 'order', action: 'finishService', data: { id: 'o1' } })

  assert.equal(result.ok, false)
  assert.match(result.message, /缺少必打卡照片/)
})

test('order finishService allows completion with active required photo', async () => {
  const db = createFinishStore([{ _id: 'ck1', orderId: 'o1', eventType: 'enter_door', mediaFileId: 'cloud://photo.jpg', latitude: 31.2, longitude: 121.5 }])
  const fn = loadCloudFunction('api', db, 'openid_staff')

  const result = await fn.main({ module: 'order', action: 'finishService', data: { id: 'o1' } })

  assert.equal(result.ok, true)
  assert.equal(db.state.orders[0].status, 'completed')
})
