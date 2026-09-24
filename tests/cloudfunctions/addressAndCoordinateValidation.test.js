const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createGeographyService = require('../../cloudfunctions/api/services/geography')

test('address and order coordinate validation and distance calculation stability', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000001' }
    ],
    pets: [
      { _id: 'pet_1', openid: 'openid_client', name: '大黄', species: 'dog', breed: '金毛' }
    ],
    user_addresses: [],
    orders: [],
    service_prices: [],
    platform_configs: []
  })

  const clientApi = loadCloudFunction('api', db, 'openid_client')

  // 1. saveAddress 越界坐标拦截测试
  const resInvalidLat = await clientApi.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      label: '家',
      serviceAddress: '测试越界地址',
      addressDetail: '1栋',
      doorplate: '101',
      latitude: 91.5,
      longitude: 121.47
    }
  })
  assert.equal(resInvalidLat.ok, false)
  assert.match(resInvalidLat.message, /地址经纬度坐标无效/)

  const resInvalidLng = await clientApi.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      label: '家',
      serviceAddress: '测试越界地址',
      addressDetail: '1栋',
      doorplate: '101',
      latitude: 31.23,
      longitude: 185.0
    }
  })
  assert.equal(resInvalidLng.ok, false)
  assert.match(resInvalidLng.message, /地址经纬度坐标无效/)

  // 2. saveAddress 正常坐标保存
  const resValid = await clientApi.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      label: '家',
      serviceAddress: '上海市人民广场',
      addressDetail: '1栋',
      doorplate: '101',
      latitude: 31.2304,
      longitude: 121.4737
    }
  })
  assert.equal(resValid.ok, true)
  assert.equal(db.state.user_addresses[0].latitude, 31.2304)
  assert.equal(db.state.user_addresses[0].longitude, 121.4737)

  // 3. createOrder 越界坐标拦截测试
  const resOrderInvalidCoord = await clientApi.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'pet_1',
      serviceTypes: ['visit_fee', 'feed'],
      serviceAddress: '越界订单地址',
      addressDetail: '1栋',
      doorplate: '101',
      addressLatitude: -95.0,
      addressLongitude: 120.0,
      startTime: '2099-09-01 10:00',
      endTime: '2099-09-01 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(resOrderInvalidCoord.ok, false)
  assert.match(resOrderInvalidCoord.message, /服务地址经纬度坐标无效/)

  // 4. calcDistanceKm 数学边界稳定性测试（验证 safeA 防 NaN）
  const geo = createGeographyService({})
  // 两个近乎完全重合或相同点
  const dSame = geo.calcDistanceKm(31.2304, 121.4737, 31.2304, 121.4737)
  assert.equal(Number.isFinite(dSame), true)
  assert.equal(Math.round(dSame), 0)

  // 对极点计算
  const dAntipode = geo.calcDistanceKm(0, 0, 0, 180)
  assert.equal(dAntipode, null) // 因为其中一点为 0,0 坐标

  const dRealAntipode = geo.calcDistanceKm(45.0, 90.0, -45.0, -90.0)
  assert.equal(Number.isFinite(dRealAntipode), true)
  assert.equal(isNaN(dRealAntipode), false)

  // 零坐标或缺失坐标返回 null
  assert.equal(geo.calcDistanceKm(0, 0, 31.2, 121.5), null)
  assert.equal(geo.calcDistanceKm(null, null, 31.2, 121.5), null)
})
