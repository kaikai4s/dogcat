const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const backend = require('../../cloudfunctions/api/utils/locationCity')
const frontend = require('../../miniprogram/utils/location-city')

test('location city parser only trusts the leading province/city prefix', () => {
  const cases = {
    '四川省成都市郫都区团结街道学院路': '成都市',
    '江苏省苏州市昆山市花桥镇枫景路': '苏州市',
    '重庆市沙坪坝区': '重庆市',
    '广西壮族自治区南宁市青秀区': '南宁市',
    '湖北省恩施土家族苗族自治州恩施市': '恩施土家族苗族自治州',
    '中国广东省深圳市南山区': '深圳市',
    '郫都区犀浦镇农贸市场': '',
    '学院路12号': '',
    '': ''
  }
  for (const [address, city] of Object.entries(cases)) {
    assert.equal(backend.extractLocationCity(address), city, address)
    assert.equal(frontend.extractLocationCity(address), city, address)
  }
  assert.equal(backend.sameCity('苏州', '苏州市'), true)
  assert.equal(backend.sameCity('江苏', '苏州市'), false)
  assert.equal(backend.sameCity('重庆市', '成都市'), false)
  assert.equal(backend.assertServiceCityMatchesLocation('成都市', '四川省成都市郫都区'), '成都市')
  assert.equal(backend.assertServiceCityMatchesLocation('随便', ''), '')
  assert.throws(() => backend.assertServiceCityMatchesLocation('重庆市', '四川省成都市郫都区'), /不一致/)
  assert.throws(() => backend.assertServiceCityMatchesLocation('', '四川省成都市郫都区'), /请填写常驻服务城市/)
})

function setup(profile) {
  const db = createCollectionStore({
    users: [{ _id: 's', openid: 'staff', roles: ['client', 'staff'], status: 'active', phone: '13800000000' }],
    staff_profiles: profile ? [profile] : []
  })
  return { db, api: loadCloudFunction('api', db, 'staff') }
}

test('certification submission rejects a typed city that disagrees with the map pick', async () => {
  const { db, api } = setup()
  const noCity = await api.main({ module: 'staff', action: 'submitStaffProfile', data: {
    gender: 'female', realName: '张三', phone: '13800000000', serviceCity: '',
    serviceAddress: '四川传媒学院(郫都校区西区)', serviceLocationAddress: '四川省成都市郫都区团结街道学院路',
    serviceLatitude: 30.8, serviceLongitude: 103.9, idCardFrontFileId: 'cloud://a', idCardBackFileId: 'cloud://b', facePhotoFileId: 'cloud://c'
  } })
  assert.equal(noCity.ok, false)
  assert.match(noCity.message, /请填写常驻服务城市/)

  const res = await api.main({ module: 'staff', action: 'submitStaffProfile', data: {
    gender: 'female', realName: '张三', phone: '13800000000', serviceCity: '重庆市',
    serviceAddress: '四川传媒学院(郫都校区西区)', serviceLocationAddress: '四川省成都市郫都区团结街道学院路',
    serviceLatitude: 30.8, serviceLongitude: 103.9, idCardFrontFileId: 'cloud://a', idCardBackFileId: 'cloud://b', facePhotoFileId: 'cloud://c'
  } })
  assert.equal(res.ok, false)
  assert.match(res.message, /与地图选点所在的「成都市」不一致/)
  assert.equal(db.state.staff_profiles.length, 0)
})

test('approved staff move cities only after confirming, and the city follows the map pick', async () => {
  const profile = { _id: 'sp', openid: 'staff', userId: 's', gender: 'female', auditStatus: 'approved', serviceCity: '成都市',
    serviceAddress: '旧服务点', serviceLatitude: 30.6, serviceLongitude: 104.0, serviceRadiusKm: 5, publicMapEnabled: true }
  const { db, api } = setup(profile)
  const move = { serviceAddress: '中星城际广场鼎苑', serviceLocationAddress: '江苏省苏州市昆山市花桥镇枫景路', serviceLatitude: 31.3, serviceLongitude: 121.1 }
  const unconfirmed = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: move })
  assert.equal(unconfirmed.ok, false)
  assert.match(unconfirmed.message, /请确认更换服务城市/)
  assert.equal(db.state.staff_profiles[0].serviceAddress, '旧服务点')

  const typed = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: { ...move, serviceCity: '上海市', confirmServiceCityChange: true } })
  assert.equal(typed.ok, false)
  assert.match(typed.message, /认证资料已锁定/)

  const confirmed = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: { ...move, confirmServiceCityChange: true } })
  assert.equal(confirmed.ok, true, confirmed.message)
  const saved = db.state.staff_profiles[0]
  assert.equal(saved.serviceCity, '苏州市')
  assert.equal(saved.previousServiceCity, '成都市')
  assert.equal(saved.serviceAddress, '中星城际广场鼎苑')
  assert.equal(saved.publicMapEnabled, false)
  assert.equal(saved.publicBookingNeedsConfirmation, true)

  const confirmedWithMatchingCity = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: {
    ...move,
    serviceCity: '苏州市',
    confirmServiceCityChange: true
  } })
  assert.equal(confirmedWithMatchingCity.ok, true, confirmedWithMatchingCity.message)

  const sameCity = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: {
    serviceAddress: '新服务点', serviceLocationAddress: '江苏省苏州市姑苏区', serviceLatitude: 31.3, serviceLongitude: 120.6
  } })
  assert.equal(sameCity.ok, true, sameCity.message)
  assert.equal(db.state.staff_profiles[0].serviceAddress, '新服务点')
  assert.equal(db.state.staff_profiles[0].serviceCity, '苏州市')
})

test('legacy profiles without a service city get it filled from the map pick', async () => {
  const { db, api } = setup({ _id: 'sp', openid: 'staff', userId: 's', gender: 'female', auditStatus: 'approved', serviceCity: '',
    serviceAddress: '旧服务点', serviceLatitude: 30.6, serviceLongitude: 104.0, serviceRadiusKm: 5 })
  const res = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: {
    serviceAddress: '新服务点', serviceLocationAddress: '四川省成都市武侯区', serviceLatitude: 30.64, serviceLongitude: 104.04
  } })
  assert.equal(res.ok, true, res.message)
  assert.equal(db.state.staff_profiles[0].serviceCity, '成都市')
})
