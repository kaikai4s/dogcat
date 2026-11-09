const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

function loadCloudModule(wxMock = {}) {
  let exported = null
  const storage = new Map()

  const defaultWx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    requirePrivacyAuthorize: ({ success }) => success && success(),
    chooseLocation: ({ success }) => success && success({
      name: '测试小区',
      address: '四川省成都市高新区天府大道',
      latitude: 30.54,
      longitude: 104.06
    }),
    ...wxMock
  }

  const code = fs.readFileSync(path.join(root, 'utils/cloud.js'), 'utf8')
  const context = {
    module: { exports: {} },
    exports: {},
    wx: defaultWx,
    getApp: () => ({ globalData: {} }),
    require: () => ({}),
    console
  }

  vm.runInNewContext(code, context)
  return { cloud: context.module.exports, storage }
}

test('chooseSelectedLocation forwards provided latitude and longitude to wx.chooseLocation', async () => {
  let calledParams = null
  const { cloud } = loadCloudModule({
    chooseLocation: (params) => {
      calledParams = params
      params.success({
        name: '万科金域蓝湾',
        address: '成都市建设北路三段',
        latitude: 30.67,
        longitude: 104.11
      })
    }
  })

  const loc = await cloud.chooseSelectedLocation({ latitude: 30.67, longitude: 104.11 })
  assert.ok(calledParams)
  assert.equal(calledParams.latitude, 30.67)
  assert.equal(calledParams.longitude, 104.11)
  assert.equal(loc.name, '万科金域蓝湾')
})

test('chooseSelectedLocation falls back to cached location if available', async () => {
  let calledParams = null
  const { cloud, storage } = loadCloudModule({
    chooseLocation: (params) => {
      calledParams = params
      params.success({
        name: '缓存位置',
        address: '成都市天府广场',
        latitude: 30.65,
        longitude: 104.06
      })
    }
  })

  storage.set('vip_pet_selected_location', {
    latitude: 30.65,
    longitude: 104.06,
    name: '天府广场'
  })

  await cloud.chooseSelectedLocation()
  assert.ok(calledParams)
  assert.equal(calledParams.latitude, 30.65)
  assert.equal(calledParams.longitude, 104.06)
})

test('chooseSelectedLocation queries wx.getLocation when no coordinates or cache exist', async () => {
  let getLocationCalled = false
  let calledParams = null
  const { cloud } = loadCloudModule({
    getLocation: ({ success }) => {
      getLocationCalled = true
      success({ latitude: 31.23, longitude: 121.47 })
    },
    chooseLocation: (params) => {
      calledParams = params
      params.success({
        name: '人民广场',
        address: '上海市黄浦区人民大道',
        latitude: 31.23,
        longitude: 121.47
      })
    }
  })

  await cloud.chooseSelectedLocation()
  assert.equal(getLocationCalled, true)
  assert.ok(calledParams)
  assert.equal(calledParams.latitude, 31.23)
  assert.equal(calledParams.longitude, 121.47)
})
