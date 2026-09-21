const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('checkin photos with numeric recordedAt (as sent by mini program) are counted in getOrderDetail and satisfy finishService', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '豆豆', species: 'dog', weight: 5, birthDate: '2020-01-01' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '李宠托', auditStatus: 'approved', serviceCity: '上海', serviceAddress: '服务点', serviceLatitude: 31.2, serviceLongitude: 121.5 }],
    service_prices: [
      { _id: 'price0', key: 'visit_fee', label: '基础服务费', price: 30, enabled: true, sortOrder: 0 },
      { _id: 'price1', key: 'walk', label: '遛狗服务', price: 80, enabled: true, sortOrder: 1 }
    ],
    orders: [],
    checkin_logs: [],
    track_logs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  // 1. 创建订单并支付、接单
  const created = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '测试小区',
      addressDetail: '1栋',
      doorplate: '101',
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(created.ok, true)
  const orderId = created.data._id

  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId } })
  await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId } })
  await staffFn.main({ module: 'order', action: 'requestEarlyStart', data: { orderId, reason: '提前开始' } })
  await clientFn.main({ module: 'order', action: 'approveEarlyStart', data: { orderId } })

  // 2. 消毒打卡与开始服务
  await staffFn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'sanitization',
      mediaFileId: 'cloud://sanitization.jpg',
      latitude: 31.2,
      longitude: 121.5
    }
  })

  const startRes = await staffFn.main({ module: 'order', action: 'startService', data: { id: orderId } })
  assert.equal(startRes.ok, true)

  // 3. 模拟小程序前端拍照打卡，前端会发送 recordedAt: Date.now() （毫秒数字类型）
  const requiredWalkEvents = ['enter_door', 'leash_on', 'pet_status', 'return_home', 'leave_door']
  for (const eventType of requiredWalkEvents) {
    const checkinRes = await staffFn.main({
      module: 'checkin',
      action: 'createCheckin',
      data: {
        orderId,
        eventType,
        mediaFileId: `cloud://${eventType}.jpg`,
        latitude: 31.2,
        longitude: 121.5,
        recordedAt: Date.now(), // 前端发送的数值型时间戳
        clientRequestId: `req_${eventType}_${Date.now()}`
      }
    })
    assert.equal(checkinRes.ok, true)
  }

  // 4. 调用 getOrderDetail 验证打卡要求是否被正确标记为已完成且 photoCount > 0
  const orderDetail = await staffFn.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: orderId }
  })
  assert.equal(orderDetail.ok, true)

  const reqs = orderDetail.data.checkinRequirements
  assert.ok(Array.isArray(reqs))

  for (const eventType of requiredWalkEvents) {
    const req = reqs.find((item) => item.eventType === eventType)
    assert.ok(req, `应当存在 ${eventType} 打卡项`)
    assert.equal(req.completed, true, `${eventType} 应该被标记为已完成`)
    assert.ok(req.photoCount >= 1, `${eventType} photoCount 应该大于等于 1`)
    assert.ok(req.photos.length >= 1, `${eventType} photos 列表不应为空`)
  }

  // 5. 验证可正常完成服务
  const finishRes = await staffFn.main({
    module: 'order',
    action: 'finishService',
    data: { id: orderId }
  })
  assert.equal(finishRes.ok, true, '全部打卡完成后应当可以顺利完成服务')
})
