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
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', species: 'dog', weight: 12 }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceType: 'walk',
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '测试地址',
      addressDetail: '1栋101',
      doorplate: '门口脚垫下有钥匙',
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'pending_pay')
  assert.equal(result.data.payAmount, 69)
  assert.equal(result.data.petId, 'p1')
  assert.deepEqual(result.data.petIds, ['p1'])
  assert.equal(db.state.orders.length, 1)
})

test('order multi-pet pricing applies per-service extra pet rules', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    pets: [
      { _id: 'dog1', openid: 'openid_client', name: '可乐', species: 'dog', weight: 8 },
      { _id: 'dog2', openid: 'openid_client', name: '豆豆', species: 'dog', weight: 6 },
      { _id: 'cat1', openid: 'openid_client', name: '雪球', species: 'cat', weight: 4 }
    ],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const twoDogsWalk = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1', 'dog2'], serviceTypes: ['visit_fee', 'walk'], durationMinutes: 60 } })
  const dogCatWalk = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1', 'cat1'], serviceTypes: ['visit_fee', 'walk'], durationMinutes: 60 } })
  const dogCatPlay = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1', 'cat1'], serviceTypes: ['visit_fee', 'play'], durationMinutes: 60 } })
  const threePetsMedicine = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1', 'dog2', 'cat1'], serviceTypes: ['visit_fee', 'medicine'], durationMinutes: 60 } })
  const combined = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1', 'dog2', 'cat1'], serviceTypes: ['visit_fee', 'walk', 'play', 'medicine'], durationMinutes: 60 } })
  const retired = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1'], serviceTypes: ['visit_fee', 'extra_pet'], durationMinutes: 60 } })
  const created = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petIds: ['dog1', 'cat1'],
      serviceTypes: ['visit_fee', 'play'],
      serviceAddress: '测试地址',
      addressDetail: '1栋101',
      doorplate: '门口脚垫下有钥匙',
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00'
    }
  })

  assert.equal(twoDogsWalk.data.payAmount, 99)
  assert.equal(dogCatWalk.data.payAmount, 69)
  assert.equal(dogCatPlay.data.payAmount, 84)
  assert.equal(threePetsMedicine.data.payAmount, 109)
  assert.equal(combined.data.payAmount, 247)
  assert.match(twoDogsWalk.data.priceItems.find((item) => item.type === 'extra_pet_fee').label, /额外狗狗 x1/)
  assert.match(dogCatPlay.data.priceItems.find((item) => item.type === 'extra_pet_fee').label, /额外宠物 x1/)
  assert.equal(retired.ok, false)
  assert.match(retired.message, /已下线/)
  assert.equal(created.ok, true)
  assert.equal(created.data.petId, 'dog1')
  assert.deepEqual(created.data.petIds, ['dog1', 'cat1'])
  assert.equal(created.data.petSnapshots.length, 2)
  assert.equal(created.data.petName, '可乐、雪球')
})

test('order pricing applies per-pet timed service extension fees', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    pets: [
      { _id: 'dog1', openid: 'openid_client', name: '可乐', species: 'dog', weight: 8 },
      { _id: 'dog2', openid: 'openid_client', name: '豆豆', species: 'dog', weight: 6 },
      { _id: 'cat1', openid: 'openid_client', name: '雪球', species: 'cat', weight: 4 }
    ],
    service_prices: [
      { key: 'walk', label: '遛狗', price: 69, internPrice: 59, extraPetFee: 10, internExtraPetFee: 8, extraPetRule: 'dog', extraHalfHourFee: 12, internExtraHalfHourFee: 9, enabled: true, sortOrder: 30 },
      { key: 'play', label: '陪伴玩耍', price: 39, internPrice: 29, extraPetFee: 10, internExtraPetFee: 8, extraPetRule: 'all', extraHalfHourFee: 6, internExtraHalfHourFee: 5, enabled: true, sortOrder: 40 }
    ],
    staff_profiles: [{ _id: 'sp_intern', staffLevel: 'intern' }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const quote = await fn.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      petIds: ['dog1', 'dog2', 'cat1'],
      serviceTypes: ['visit_fee', 'walk', 'play'],
      petServiceDurations: [
        { serviceKey: 'walk', petId: 'dog1', durationMinutes: 30 },
        { serviceKey: 'walk', petId: 'dog2', durationMinutes: 60 },
        { serviceKey: 'play', petId: 'dog1', durationMinutes: 30 },
        { serviceKey: 'play', petId: 'dog2', durationMinutes: 90 },
        { serviceKey: 'play', petId: 'cat1', durationMinutes: 30 }
      ],
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00'
    }
  })

  assert.equal(quote.ok, true)
  assert.equal(quote.data.durationMinutes, 240)
  assert.equal(quote.data.sessions[0].endTime, '2099-07-28 14:00')
  assert.equal(quote.data.payAmount, 192)
  assert.equal(quote.data.petServiceDurations.length, 5)
  assert.equal(quote.data.priceItems.filter((item) => item.type === 'pet_time_extra_fee').length, 2)

  const internQuote = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1'], serviceTypes: ['visit_fee', 'walk'], publishMode: 'direct', staffProfileId: 'sp_intern', petServiceDurations: [{ serviceKey: 'walk', petId: 'dog1', durationMinutes: 60 }] } })
  assert.equal(internQuote.ok, true)
  assert.equal(internQuote.data.payAmount, 98)
  assert.equal(internQuote.data.priceSnapshot.staffPriceLevel, 'intern')

  db.state.service_prices[0].extraHalfHourFee = 12.5
  const decimalQuote = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['dog1'], serviceTypes: ['visit_fee', 'walk'], petServiceDurations: [{ serviceKey: 'walk', petId: 'dog1', durationMinutes: 90 }] } })
  assert.equal(decimalQuote.data.payAmount, 124)
  db.state.service_prices[0].extraHalfHourFee = 12

  const multiDayOrder = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petIds: ['dog1'],
      serviceTypes: ['visit_fee', 'walk'],
      petServiceDurations: [{ serviceKey: 'walk', petId: 'dog1', durationMinutes: 60 }],
      serviceAddress: '测试地址',
      addressDetail: '1栋101',
      doorplate: '门口脚垫下有钥匙',
      orderType: 'multi_day',
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00',
      endDate: '2099-07-29'
    }
  })
  assert.equal(multiDayOrder.ok, true)
  assert.equal(multiDayOrder.data.sessionCount, 2)
  assert.equal(multiDayOrder.data.payAmount, 222)
  assert.equal(multiDayOrder.data.petServiceDurations.length, 1)
  assert.equal(multiDayOrder.data.priceSnapshot.petServiceDurations[0].durationMinutes, 60)

  const normalLongFeed = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['cat1'], serviceTypes: ['visit_fee', 'feed'], durationMinutes: 180 } })
  assert.equal(normalLongFeed.data.payAmount, 59)

  const invalid = await fn.main({ module: 'order', action: 'quoteOrder', data: { petIds: ['cat1'], serviceTypes: ['visit_fee', 'walk'], petServiceDurations: [{ serviceKey: 'walk', petId: 'cat1', durationMinutes: 30 }] } })
  assert.equal(invalid.ok, false)
  assert.match(invalid.message, /狗狗/)
})

test('order quoteOrder requires visit fee and business service', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const missingVisitFee = await fn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'p1', serviceTypes: ['walk'] } })
  assert.equal(missingVisitFee.ok, false)
  assert.match(missingVisitFee.message, /请选择上门费/)

  const missingBusiness = await fn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'p1', serviceTypes: ['visit_fee'] } })
  assert.equal(missingBusiness.ok, false)
  assert.match(missingBusiness.message, /请选择至少一项照护服务/)
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
