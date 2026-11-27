const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

const COMMUNITY_ID = 'map_community_' + 'c'.repeat(24)

function fixture(extra = {}) {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_1', openid: 'client_1', roles: ['client'], status: 'active', nickname: '林女士' },
      { _id: 'u_client_2', openid: 'client_2', roles: ['client'], status: 'active', nickname: '周先生' },
      { _id: 'u_staff', openid: 'staff_1', roles: ['staff'], status: 'active', nickname: '王宠托' }
    ],
    staff_profiles: [{
      _id: 'sp_1',
      openid: 'staff_1',
      realName: '王安',
      gender: 'male',
      auditStatus: 'approved',
      staffLevel: 'certified',
      onboardingStatus: 'certified',
      trainingPassed: true,
      videoAuditStatus: 'approved',
      serviceCity: '深圳市',
      serviceAddress: '晴溪花园南门',
      serviceLatitude: 22.5401,
      serviceLongitude: 114.0601,
      serviceRadiusKm: 5,
      weeklySchedule: {
        1: [{ start: 8, end: 22 }],
        2: [{ start: 8, end: 22 }],
        3: [{ start: 8, end: 22 }],
        4: [{ start: 8, end: 22 }],
        5: [{ start: 8, end: 22 }],
        6: [{ start: 8, end: 22 }],
        7: [{ start: 8, end: 22 }]
      }
    }],
    platform_configs: [{
      _id: COMMUNITY_ID,
      key: 'service_community',
      enabled: true,
      name: '晴溪花园',
      aliases: [],
      city: '深圳市',
      cityKey: '深圳',
      latitude: 22.54,
      longitude: 114.06,
      revision: 1,
      matchRadiusKm: 1
    }],
    pets: [
      {
        _id: 'pet_large_dog',
        openid: 'client_1',
        name: '大黄',
        species: 'dog',
        breed: '金毛',
        weight: 28,
        avatarFileId: 'cloud://env/pets/dahuang.jpg',
        vaccineCertification: { status: 'approved' }
      },
      {
        _id: 'pet_medium_dog',
        openid: 'client_1',
        name: '可乐',
        species: 'dog',
        breed: '柴犬',
        weight: 12,
        avatarFileId: 'cloud://env/pets/kele.jpg',
        vaccineCertification: { status: 'approved' }
      },
      {
        _id: 'pet_cat',
        openid: 'client_2',
        name: '糯米',
        species: 'cat',
        breed: '布偶',
        weight: 5.5,
        avatarFileId: 'cloud://env/pets/nuomi.jpg',
        vaccineCertification: { status: 'approved' }
      },
      {
        _id: 'pet_boundary_dog',
        openid: 'client_2',
        name: '雷神',
        species: 'dog',
        breed: '拉布拉多',
        weight: 25,
        avatarFileId: 'cloud://env/pets/leishen.jpg',
        vaccineCertification: { status: 'approved' }
      }
    ],
    orders: [],
    pet_playground_groups: [],
    ...extra
  })
  return {
    db,
    staffApi: loadCloudFunction('api', db, 'staff_1')
  }
}

function baseOrder(id, overrides = {}) {
  return {
    _id: id,
    orderNo: `ORD_${id}`,
    clientUserId: 'u_client_1',
    clientOpenid: 'client_1',
    status: 'paid',
    paymentStatus: 'paid',
    publishMode: 'open',
    city: '深圳市',
    serviceAddress: '晴溪花园',
    addressDetail: '3栋1201',
    doorplate: '1201',
    addressLatitude: 22.5402,
    addressLongitude: 114.0602,
    serviceLatitude: 22.5402,
    serviceLongitude: 114.0602,
    serviceType: 'feed',
    serviceTypes: ['feed'],
    serviceSummary: '上门喂养',
    startTime: '2099-12-10 10:00',
    endTime: '2099-12-10 11:00',
    durationMinutes: 60,
    sessionCount: 1,
    amount: 89,
    payAmount: 89,
    ...overrides
  }
}

test('staff nearby list, map list, and order detail expose multi-pet photos, weights, and large-dog flags (>=25kg)', async () => {
  const { staffApi } = fixture({
    orders: [
      baseOrder('ord_multi', {
        petId: 'pet_large_dog',
        petIds: ['pet_large_dog', 'pet_medium_dog'],
        petName: '大黄、可乐'
      }),
      baseOrder('ord_medium_only', {
        petId: 'pet_medium_dog',
        petIds: ['pet_medium_dog'],
        petName: '可乐',
        startTime: '2099-12-10 14:00',
        endTime: '2099-12-10 15:00'
      })
    ]
  })

  const nearbyRes = await staffApi.main({
    module: 'staff',
    action: 'listNearbyOrders',
    data: { city: '深圳市', latitude: 22.5401, longitude: 114.0601 }
  })
  assert.equal(nearbyRes.ok, true, nearbyRes.message)
  const list = Array.isArray(nearbyRes.data) ? nearbyRes.data : nearbyRes.data.list
  const multiCard = list.find((o) => o._id === 'ord_multi')
  const mediumCard = list.find((o) => o._id === 'ord_medium_only')

  assert.equal(multiCard.hasLargeDog, true)
  assert.match(multiCard.largeDogSummaryText, /金毛「大黄」\(28kg\)/)
  assert.equal(multiCard.petWeightSummary, '大黄 28kg、可乐 12kg')
  assert.deepEqual(multiCard.petPhotoUrls, ['cloud://env/pets/dahuang.jpg', 'cloud://env/pets/kele.jpg'])
  assert.equal(multiCard.addressDetail, '接单后可见')

  assert.equal(mediumCard.hasLargeDog, false)
  assert.equal(mediumCard.petWeightSummary, '12kg')

  // Community map cards include public-safe pet photo, weight, and large-dog flag without leaking home details
  const mapRes = await staffApi.main({
    module: 'communityMap',
    action: 'listOrders',
    data: { city: '深圳市', communityId: COMMUNITY_ID }
  })
  assert.equal(mapRes.ok, true, mapRes.message)
  const mapMulti = mapRes.data.list.find((o) => o._id === 'ord_multi')
  assert.equal(mapMulti.petAvatar, 'cloud://env/pets/dahuang.jpg')
  assert.equal(mapMulti.petWeightSummary, '大黄 28kg、可乐 12kg')
  assert.equal(mapMulti.hasLargeDog, true)
  assert.equal(JSON.stringify(mapRes.data).includes('3栋1201'), false)

  // Staff preview detail includes all petSnapshots with weight and isLargeDog
  const detailRes = await staffApi.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: 'ord_multi', role: 'staff' }
  })
  assert.equal(detailRes.ok, true, detailRes.message)
  assert.equal(detailRes.data.hasLargeDog, true)
  assert.equal(detailRes.data.petSnapshots.length, 2)
  assert.equal(detailRes.data.petSnapshots[0].isLargeDog, true)
  assert.equal(detailRes.data.petSnapshots[0].weight, 28)
  assert.equal(detailRes.data.petSnapshots[1].isLargeDog, false)
  assert.equal(detailRes.data.petSnapshots[1].weight, 12)
})

test('grabbing a feed or walk order with a >=25kg dog requires large-dog confirmation, including group-buy bundles', async () => {
  const { db, staffApi } = fixture({
    pet_playground_groups: [{
      _id: 'grp_1',
      status: 'formed',
      formedAt: '2099-12-01T00:00:00.000Z'
    }],
    orders: [
      // Group-buy household 1: 5.5kg cat (primary order clicked by sitter)
      baseOrder('ord_grp_cat', {
        clientUserId: 'u_client_2',
        clientOpenid: 'client_2',
        petId: 'pet_cat',
        petIds: ['pet_cat'],
        petName: '糯米',
        groupBuyId: 'grp_1',
        groupBuyStatus: 'formed'
      }),
      // Group-buy household 2: 25kg Labrador dog (feeding service, exact 25kg boundary)
      baseOrder('ord_grp_dog25', {
        clientUserId: 'u_client_2',
        clientOpenid: 'client_2',
        petId: 'pet_boundary_dog',
        petIds: ['pet_boundary_dog'],
        petName: '雷神',
        groupBuyId: 'grp_1',
        groupBuyStatus: 'formed',
        startTime: '2099-12-10 11:30',
        endTime: '2099-12-10 12:30'
      })
    ]
  })

  // 1. Risk check on household 1 detects household 2's 25kg large dog across the bundle
  const riskRes = await staffApi.main({
    module: 'staff',
    action: 'checkAcceptOrderRisk',
    data: { orderId: 'ord_grp_cat' }
  })
  assert.equal(riskRes.ok, true, riskRes.message)
  assert.equal(riskRes.data.requiresConfirmation, true)
  assert.equal(riskRes.data.hasLargeDog, true)
  assert.equal(riskRes.data.noticeTitle, '大型犬接单安全确认')
  assert.equal(riskRes.data.warnings[0].type, 'large_dog')
  assert.match(riskRes.data.warnings[0].title, /拉布拉多「雷神」\(25kg\)/)
  assert.ok(riskRes.data.noticeItems.some((item) => item.includes('大型犬')))

  // 2. Attempting to accept without riskConfirmed: true is rejected by the server
  const unconfirmed = await staffApi.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId: 'ord_grp_cat',
      riskConfirmed: false,
      currentLatitude: 22.5401,
      currentLongitude: 114.0601
    }
  })
  assert.equal(unconfirmed.ok, false)
  assert.match(unconfirmed.message, /大型犬/)

  // 3. Accepting with riskConfirmed: true succeeds for the whole bundle and records risk warning
  const confirmed = await staffApi.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId: 'ord_grp_cat',
      riskConfirmed: true,
      currentLatitude: 22.5401,
      currentLongitude: 114.0601
    }
  })
  assert.equal(confirmed.ok, true, confirmed.message)
  assert.equal(confirmed.data.bundledCount, 2)
  const savedPrimary = db.state.orders.find((o) => o._id === 'ord_grp_cat')
  assert.equal(savedPrimary.status, 'assigned')
  assert.ok(Array.isArray(savedPrimary.acceptRiskWarnings))
  assert.equal(savedPrimary.acceptRiskWarnings[0].type, 'large_dog')
})

test('edge cases: snapshot missing weight falls back to pets table, and group-buy secondary household schedule/conflict is prechecked', async () => {
  const { staffApi } = fixture({
    pet_playground_groups: [{
      _id: 'grp_2',
      status: 'formed',
      formedAt: '2099-12-01T00:00:00.000Z'
    }],
    orders: [
      // Snapshot has species='dog' and weight=0 (missing), while pets table has weight=28kg
      baseOrder('ord_incomplete_snap', {
        petId: 'pet_large_dog',
        petIds: ['pet_large_dog'],
        petSnapshots: [{ _id: 'pet_large_dog', name: '大黄', species: 'dog', weight: 0 }]
      }),
      // Group-buy household 1 inside schedule (10:00-11:00)
      baseOrder('ord_grp2_h1', {
        petId: 'pet_cat',
        petIds: ['pet_cat'],
        groupBuyId: 'grp_2',
        groupBuyStatus: 'formed',
        startTime: '2099-12-10 10:00',
        endTime: '2099-12-10 11:00'
      }),
      // Group-buy household 2 outside schedule (22:30-23:30, sitter schedule ends at 22:00)
      baseOrder('ord_grp2_h2', {
        clientUserId: 'u_client_2',
        clientOpenid: 'client_2',
        petId: 'pet_medium_dog',
        petIds: ['pet_medium_dog'],
        groupBuyId: 'grp_2',
        groupBuyStatus: 'formed',
        startTime: '2099-12-10 22:30',
        endTime: '2099-12-10 23:30'
      })
    ]
  })

  const snapFallbackRisk = await staffApi.main({
    module: 'staff',
    action: 'checkAcceptOrderRisk',
    data: { orderId: 'ord_incomplete_snap' }
  })
  assert.equal(snapFallbackRisk.ok, true)
  assert.equal(snapFallbackRisk.data.hasLargeDog, true)
  assert.equal(snapFallbackRisk.data.warnings[0].type, 'large_dog')

  const bundleScheduleRisk = await staffApi.main({
    module: 'staff',
    action: 'checkAcceptOrderRisk',
    data: { orderId: 'ord_grp2_h1' }
  })
  assert.equal(bundleScheduleRisk.ok, true)
  assert.equal(bundleScheduleRisk.data.requiresConfirmation, true)
  assert.ok(bundleScheduleRisk.data.warnings.some((w) => w.type === 'time'))
})
