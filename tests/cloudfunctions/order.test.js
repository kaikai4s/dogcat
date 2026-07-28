const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('order createOrder creates pending order for current client pet', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: []
  })
  const fn = loadCloudFunction('order', db, 'openid_client')

  const result = await fn.main({
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceType: 'walk',
      serviceAddress: '测试地址',
      startTime: '2026-07-28 10:00',
      endTime: '2026-07-28 11:00'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'pending_pay')
  assert.equal(result.data.payAmount, 89)
  assert.equal(db.state.orders.length, 1)
})

test('order finishService rejects when required checkins are missing', async () => {
  const db = createCollectionStore({
    users: [{ _id: 's1', openid: 'openid_staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'o1', staffOpenid: 'openid_staff', clientOpenid: 'openid_client', status: 'in_service', requiredCheckins: ['enter_door'] }],
    checkin_logs: []
  })
  const fn = loadCloudFunction('order', db, 'openid_staff')

  const result = await fn.main({ action: 'finishService', data: { id: 'o1' } })

  assert.equal(result.ok, false)
  assert.match(result.message, /缺少强制打卡/)
})
