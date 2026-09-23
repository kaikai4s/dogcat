const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('staff privacy hardening: public sitters list and detail do not leak private coordinates or detailed address', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_openid', nickname: '客户小李', status: 'active', roles: ['client'] },
      { _id: 'u_staff_1', openid: 'staff_openid_1', nickname: '张托托', status: 'active', roles: ['staff'] },
      { _id: 'u_staff_2', openid: 'staff_openid_2', nickname: '李托托', status: 'active', roles: ['staff'] }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'staff_openid_1',
        auditStatus: 'approved',
        realName: '张三',
        nickname: '张托托',
        serviceCity: '上海市',
        serviceAreas: '浦东新区,黄浦区',
        serviceAddress: '上海市浦东新区张江高科科苑路88号3栋502室',
        serviceLatitude: 31.205,
        serviceLongitude: 121.505,
        serviceRadiusKm: 5,
        updatedAt: '2026-08-01 12:00:00'
      },
      {
        _id: 'sp_2',
        openid: 'staff_openid_2',
        auditStatus: 'approved',
        realName: '李四',
        nickname: '李托托',
        serviceCity: '上海市',
        serviceAreas: '徐汇区',
        serviceAddress: '上海市徐汇区虹桥路100号8室',
        publicServiceAddress: '徐汇宠物爱心服务驿站（虹桥路店）',
        serviceLatitude: 31.190,
        serviceLongitude: 121.430,
        serviceRadiusKm: 10,
        updatedAt: '2026-08-02 12:00:00'
      }
    ],
    service_reviews: [],
    sitter_favorites: []
  })

  const clientApi = loadCloudFunction('api', db, 'client_openid')

  // 1. 验证 listApprovedSitters 返回结果脱敏
  const listRes = await clientApi.main({
    module: 'staff',
    action: 'listApprovedSitters',
    data: { latitude: 31.200, longitude: 121.500 }
  })

  assert.equal(listRes.ok, true)
  assert.equal(listRes.data.list.length, 2)

  const sitter1 = listRes.data.list.find((item) => item._id === 'sp_1')
  const sitter2 = listRes.data.list.find((item) => item._id === 'sp_2')

  // 验证绝不暴露精确 GPS 坐标
  assert.equal(sitter1.serviceLatitude, undefined)
  assert.equal(sitter1.serviceLongitude, undefined)
  assert.equal(sitter2.serviceLatitude, undefined)
  assert.equal(sitter2.serviceLongitude, undefined)

  // 验证私人详细地址脱敏（门牌号/栋/室被遮蔽）
  assert.equal(sitter1.serviceAddress.includes('502室'), false)
  assert.equal(sitter1.serviceAddress.includes('***'), true)
  assert.equal(sitter1.hasServiceAddress, true)

  // 验证配置了公开服务地址时优先展示公开服务网点
  assert.equal(sitter2.publicServiceAddress, '徐汇宠物爱心服务驿站（虹桥路店）')
  assert.equal(sitter2.serviceAddress, '徐汇宠物爱心服务驿站（虹桥路店）')

  // 验证服务端计算的相对距离与服务范围判定完全正确
  assert.equal(typeof sitter1.distanceKm, 'number')
  assert.equal(sitter1.inServiceRange, true)
  assert.equal(sitter1.canDirectBook, true)
  assert.equal(typeof sitter1.distanceText, 'string')

  // 2. 验证 getPublicSitterDetail 详情接口脱敏
  const detailRes1 = await clientApi.main({
    module: 'staff',
    action: 'getPublicSitterDetail',
    data: { staffProfileId: 'sp_1', latitude: 31.200, longitude: 121.500 }
  })
  assert.equal(detailRes1.ok, true)
  const detail1 = detailRes1.data
  assert.equal(detail1.serviceLatitude, undefined)
  assert.equal(detail1.serviceLongitude, undefined)
  assert.equal(detail1.serviceAddress.includes('502室'), false)
  assert.equal(detail1.serviceAddress.includes('***'), true)
  assert.equal(detail1.hasServiceAddress, true)
  assert.equal(detail1.inServiceRange, true)
  assert.equal(typeof detail1.distanceText, 'string')

  // 3. 验证 checkSitterRange 接口在服务端进行安全判定
  // 近处地址 (31.200, 121.500) 距离 sp_1 (31.205, 121.505) 约 700米，在 5km 范围内
  const rangeNear = await clientApi.main({
    module: 'staff',
    action: 'checkSitterRange',
    data: { staffProfileId: 'sp_1', latitude: 31.200, longitude: 121.500 }
  })
  assert.equal(rangeNear.ok, true)
  assert.equal(rangeNear.data.inServiceRange, true)
  assert.equal(rangeNear.data.canDirectBook, true)

  // 远处地址 (30.800, 121.000) 距离 sp_1 超出 5km
  const rangeFar = await clientApi.main({
    module: 'staff',
    action: 'checkSitterRange',
    data: { staffProfileId: 'sp_1', latitude: 30.800, longitude: 121.000 }
  })
  assert.equal(rangeFar.ok, true)
  assert.equal(rangeFar.data.inServiceRange, false)
  assert.equal(rangeFar.data.canDirectBook, false)
  assert.equal(rangeFar.data.message.includes('超出'), true)

  // 4. 验证宠托师本人拉取 getStaffProfile 仍可见本人的私人常驻地址与坐标，便于管理配置
  const staffApi = loadCloudFunction('api', db, 'staff_openid_1')
  const profileRes = await staffApi.main({
    module: 'staff',
    action: 'getStaffProfile'
  })
  assert.equal(profileRes.ok, true)
  assert.equal(profileRes.data.serviceAddress, '上海市浦东新区张江高科科苑路88号3栋502室')
  assert.equal(profileRes.data.serviceLatitude, 31.205)
  assert.equal(profileRes.data.serviceLongitude, 121.505)

  // 5. 验证宠托师本人可以配置 publicServiceAddress
  const updateRes = await staffApi.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      publicServiceAddress: '张江高科宠物服务驿站'
    }
  })
  assert.equal(updateRes.ok, true)
  assert.equal(updateRes.data.publicServiceAddress, '张江高科宠物服务驿站')

  // 再次通过公开详情接口获取，此时展示刚刚配置的公开服务地址
  const detailAfter = await clientApi.main({
    module: 'staff',
    action: 'getPublicSitterDetail',
    data: { staffProfileId: 'sp_1' }
  })
  assert.equal(detailAfter.ok, true)
  assert.equal(detailAfter.data.publicServiceAddress, '张江高科宠物服务驿站')
  assert.equal(detailAfter.data.serviceAddress, '张江高科宠物服务驿站')

  // 6. 验证 listFavoriteSitters 也脱敏且不暴露经纬度
  await clientApi.main({
    module: 'staff',
    action: 'favoriteSitter',
    data: { staffProfileId: 'sp_1' }
  })
  const favoritesRes = await clientApi.main({
    module: 'staff',
    action: 'listFavoriteSitters',
    data: { latitude: 31.200, longitude: 121.500 }
  })
  assert.equal(favoritesRes.ok, true)
  assert.equal(favoritesRes.data.length, 1)
  const favItem = favoritesRes.data[0]
  assert.equal(favItem.serviceLatitude, undefined)
  assert.equal(favItem.serviceLongitude, undefined)
  assert.equal(favItem.serviceAddress, '张江高科宠物服务驿站')
  assert.equal(favItem.favorite, true)
  assert.equal(favItem.inServiceRange, true)

  // 7. 验证在创建订单若超出范围时，服务端错误信息脱敏，不泄漏员工私人住址
  // sp_2 没有配置 publicServiceAddress 时的私人住址是 '上海市徐汇区虹桥路100号8室'
  // 若某宠托师 sp_private 仅有私人地址
  await db.collection('staff_profiles').add({
    data: {
      _id: 'sp_private',
      openid: 'staff_openid_private',
      auditStatus: 'approved',
      realName: '赵私密',
      serviceCity: '上海市',
      serviceAddress: '上海市杨浦区控江路1200弄3号601室',
      serviceLatitude: 31.290,
      serviceLongitude: 121.530,
      serviceRadiusKm: 3
    }
  })
  await db.collection('users').add({
    data: {
      _id: 'u_staff_priv',
      openid: 'staff_openid_private',
      nickname: '赵托托',
      status: 'active',
      roles: ['staff']
    }
  })

  await db.collection('pets').add({
    data: {
      _id: 'p1',
      openid: 'client_openid',
      name: '奶糖',
      species: 'cat',
      weight: 4
    }
  })

  // 创建订单指定 sp_private，但是在很远的地方 (31.100, 121.300)
  const orderRes = await clientApi.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_private',
      serviceAddress: '上海市闵行区莘庄地铁站南广场',
      addressLatitude: 31.100,
      addressLongitude: 121.300,
      serviceTypes: ['visit_fee', 'feed'],
      petIds: ['p1']
    }
  })
  assert.equal(orderRes.ok, false)
  // 错误信息不得包含私人门牌号 '601室'
  assert.equal(orderRes.message.includes('601室'), false)
  assert.equal(orderRes.message.includes('***'), true)
})
