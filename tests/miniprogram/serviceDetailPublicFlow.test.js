const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const createSystemHandler = require('../../cloudfunctions/api/handlers/system')
const createServiceCatalog = require('../../cloudfunctions/api/services/serviceCatalog')
const createCheckinRules = require('../../cloudfunctions/api/services/checkinRules')
const createOrderState = require('../../cloudfunctions/api/services/orderState')
const {
  CHECKIN_EVENT_TYPES,
  EXTRA_PET_RULES,
  RETIRED_SERVICE_KEYS,
  VISIT_FEE_SERVICE_KEY,
  defaultServiceCheckinRules,
  defaultServicePrices
} = require('../../cloudfunctions/api/config/constants')

function buildMockDb(collections = {}) {
  return {
    collection(name) {
      const rows = collections[name] || []
      return {
        orderBy() {
          return this
        },
        where(query) {
          const filtered = rows.filter((row) =>
            Object.entries(query || {}).every(([k, v]) => row[k] === v)
          )
          return {
            limit() {
              return { get: async () => ({ data: filtered }) }
            },
            get: async () => ({ data: filtered })
          }
        },
        get: async () => ({ data: rows })
      }
    }
  }
}

test('system.getPublicServiceDetail returns service details and flowSteps without login', async () => {
  const db = buildMockDb({
    service_prices: [
      {
        key: 'walk',
        label: '遛狗服务',
        price: 39,
        internPrice: 35,
        extraPetFee: 30,
        extraPetRule: 'dog',
        extraHalfHourFee: 20,
        enabled: true,
        showOnHome: true,
        sortOrder: 10,
        description: '牵引遛狗、轨迹记录、回家安置',
        detailDescription: '全程佩戴安全牵引，避开高温时段，回家擦拭脚爪。',
        caseImageFileIds: ['cloud://env/case1.jpg', 'cloud://env/case2.jpg']
      },
      {
        key: VISIT_FEE_SERVICE_KEY,
        label: '上门费',
        price: 30,
        enabled: true,
        sortOrder: 5
      }
    ],
    service_checkin_rules: []
  })

  const safeText = (v) => (v == null ? '' : String(v))
  const orderState = createOrderState({ db, safeText, ORDER_STATUS: {} })
  const serviceCatalog = createServiceCatalog({
    EXTRA_PET_RULES,
    RETIRED_SERVICE_KEYS,
    VISIT_FEE_SERVICE_KEY,
    db,
    defaultServicePrices,
    safeText
  })
  const checkinRules = createCheckinRules({
    CHECKIN_EVENT_TYPES,
    checkinEventText: orderState.checkinEventText,
    cloud: {},
    db,
    defaultServiceCheckinRules,
    defaultServicePrices,
    formatDateKey: (d) => d.toISOString().slice(0, 10),
    hasCheckinPhoto: () => false,
    hasCoordinate: () => false,
    listServicePrices: serviceCatalog.listServicePrices,
    now: () => new Date().toISOString(),
    readScopedDocuments: async () => [],
    safeFileId: (v) => safeText(v).trim(),
    safeText,
    toTimeValue: () => 0
  })

  const systemHandler = createSystemHandler({
    VISIT_FEE_SERVICE_KEY,
    checkinEventText: orderState.checkinEventText,
    db,
    getSystemSettings: async () => ({ maintenance: { booking: false } }),
    getUser: async () => {
      throw new Error('不应要求登录')
    },
    listServiceCheckinRules: checkinRules.listServiceCheckinRules,
    listServicePrices: serviceCatalog.listServicePrices,
    resolveCheckinRequirements: checkinRules.resolveCheckinRequirements,
    safeFileId: (v) => safeText(v).trim(),
    safeText
  })

  const res = await systemHandler('', 'getPublicServiceDetail', { key: 'walk' })
  assert.equal(res.service.key, 'walk')
  assert.equal(res.service.priceText, '¥39起')
  assert.equal(res.service.detailDescription, '全程佩戴安全牵引，避开高温时段，回家擦拭脚爪。')
  assert.deepEqual(res.service.caseImageFileIds, ['cloud://env/case1.jpg', 'cloud://env/case2.jpg'])
  assert.equal(res.visitFeePrice, 30)
  assert.ok(Array.isArray(res.flowSteps) && res.flowSteps.length >= 6)
  assert.equal(res.flowSteps[0].eventType, 'sanitization')
  assert.equal(res.flowSteps[0].stepNumber, '01')
  assert.ok(res.flowSteps[0].description.length > 0)

  await assert.rejects(() => systemHandler('', 'getPublicServiceDetail', { key: 'non_existent' }), /服务项目不存在/)
})

test('home hot services cards navigate to service-detail without login while 去下单 keeps goProtected', () => {
  const homeWxml = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml'),
    'utf8'
  )
  assert.ok(
    homeWxml.includes('data-url="/pages/client/orders/create/index" bindtap="goProtected">去下单</view>'),
    '去下单 link must keep goProtected logic'
  )
  assert.ok(
    homeWxml.includes('data-url="/pages/client/orders/service-detail/index?key={{item.key}}" bindtap="go"'),
    'Hot service cards must navigate to service-detail via go (no login required)'
  )
  assert.ok(
    !homeWxml.includes('service-price-card interactive" wx:for="{{displayServicePrices.length ? displayServicePrices : servicePrices}}" wx:key="uniqueKey" data-url="/pages/client/orders/create/index'),
    'Hot service cards must no longer jump directly to orders/create'
  )

  const appJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../miniprogram/app.json'), 'utf8')
  )
  const ordersPkg = appJson.subpackages.find((pkg) => pkg.root === 'pages/client/orders')
  assert.ok(ordersPkg && ordersPkg.pages.includes('service-detail/index'), 'service-detail/index must be registered in client-orders subpackage')
})

test('service-detail page loads public data without login and goOrder enforces login', async () => {
  const calls = []
  let ensuredLogin = false
  let navigatedUrl = ''
  let pageConfig = null

  const modulePath = require.resolve('../../miniprogram/pages/client/orders/service-detail/index.js')
  const cloudPath = require.resolve('../../miniprogram/utils/cloud')
  const themePath = require.resolve('../../miniprogram/utils/theme')
  const fontPath = require.resolve('../../miniprogram/utils/font')
  const navPath = require.resolve('../../miniprogram/utils/nav')

  const originalPage = global.Page
  const originalWx = global.wx
  const originalCache = {
    [modulePath]: require.cache[modulePath],
    [cloudPath]: require.cache[cloudPath],
    [themePath]: require.cache[themePath],
    [fontPath]: require.cache[fontPath],
    [navPath]: require.cache[navPath]
  }

  try {
    global.Page = (cfg) => { pageConfig = cfg }
    global.wx = {
      setNavigationBarTitle: () => {},
      showModal: () => {}
    }
    require.cache[cloudPath] = {
      exports: {
        callFunction: (mod, act, data) => {
          calls.push({ mod, act, data })
          if (mod === 'system' && act === 'getPublicServiceDetail') {
            return Promise.resolve({
              service: {
                key: 'feed',
                label: '喂养服务',
                price: 29,
                internPrice: 29,
                extraPetFee: 0,
                extraPetRule: 'none',
                extraHalfHourFee: 0,
                description: '换粮换水',
                detailDescription: '详细喂养说明',
                caseImageFileIds: [],
                coverUrl: ''
              },
              visitFeePrice: 30,
              flowSteps: [{ stepNumber: '01', eventType: 'sanitization', label: '消毒打卡', description: '消毒', required: true, optional: false }],
              maintenance: { booking: false }
            })
          }
          if (mod === 'order' && act === 'listPublicCompletedOrders') {
            return Promise.resolve({ list: [{ _id: 'ord1', petName: '橘猫', orderTitle: '订单 000001' }] })
          }
          return Promise.resolve({})
        },
        showError: () => {},
        ensureLogin: () => {
          ensuredLogin = true
          return Promise.resolve()
        }
      }
    }
    require.cache[themePath] = { exports: { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({ themeClass: 'theme-day' }) } }
    require.cache[fontPath] = { exports: { applyFont: () => ({ value: 'system' }), getFontState: () => ({ fontClass: 'font-system' }) } }
    require.cache[navPath] = { exports: { safeNavigateTo: ({ url, success }) => { navigatedUrl = url; if (success) success() } } }
    delete require.cache[modulePath]

    require(modulePath)
    const instance = {
      ...pageConfig,
      data: JSON.parse(JSON.stringify(pageConfig.data)),
      setData(patch) { Object.assign(this.data, patch) }
    }

    instance.onLoad({ key: 'feed' })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(ensuredLogin, false, 'Loading service detail must not require login')
    assert.ok(calls.some((c) => c.mod === 'system' && c.act === 'getPublicServiceDetail' && c.data.key === 'feed'))
    assert.ok(calls.some((c) => c.mod === 'order' && c.act === 'listPublicCompletedOrders' && c.data.serviceType === 'feed'))
    assert.equal(instance.data.service.label, '喂养服务')
    assert.equal(instance.data.flowSteps.length, 1)
    assert.equal(instance.data.cases.length, 1)

    await instance.goOrder()
    assert.equal(ensuredLogin, true, 'Clicking 去下单 on detail page must call ensureLogin')
    assert.equal(navigatedUrl, '/pages/client/orders/create/index?serviceType=feed')
  } finally {
    global.Page = originalPage
    global.wx = originalWx
    Object.entries(originalCache).forEach(([k, v]) => {
      if (v) require.cache[k] = v
      else delete require.cache[k]
    })
  }
})
