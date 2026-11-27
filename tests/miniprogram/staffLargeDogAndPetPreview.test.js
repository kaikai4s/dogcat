const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('staff workbench, community map, detail, and task list templates expose pet photos, weights, and large-dog alerts', () => {
  const homeWxml = fs.readFileSync(path.join(root, 'pages/staff/home/index.wxml'), 'utf8')
  const mapWxml = fs.readFileSync(path.join(root, 'pages/common/community-map/index.wxml'), 'utf8')
  const detailWxml = fs.readFileSync(path.join(root, 'pages/staff/orders/detail/index.wxml'), 'utf8')
  const listWxml = fs.readFileSync(path.join(root, 'pages/staff/orders/list/index.wxml'), 'utf8')
  const groupWxml = fs.readFileSync(path.join(root, 'components/group-households/index.wxml'), 'utf8')

  assert.match(homeWxml, /previewOrderPetPhotos/)
  assert.match(homeWxml, /item\.petWeightSummary/)
  assert.match(homeWxml, /大型犬 ≥25kg/)
  assert.match(homeWxml, /acceptRisk\.noticeDesc/)

  assert.match(mapWxml, /previewPetPhotos/)
  assert.match(mapWxml, /item\.petWeightSummary/)
  assert.match(mapWxml, /item\.hasLargeDog/)

  assert.match(detailWxml, /order\.petProfiles/)
  assert.match(detailWxml, /petItem\.isLargeDog/)
  assert.match(detailWxml, /order\.hasLargeDog/)

  assert.match(listWxml, /previewOrderPetPhotos/)
  assert.match(listWxml, /item\.petWeightSummary/)
  assert.match(listWxml, /item\.hasLargeDog/)

  assert.match(groupWxml, /pet\.isLargeDog/)
})

test('staff workbench previews multi-pet photos and requires two-step confirmation on large-dog risk', async () => {
  let homeDef
  const previews = []
  const calls = []

  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/staff/home/index.js'), 'utf8'), {
    Page(cfg) { homeDef = cfg },
    Array,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    wx: {
      previewImage: (opts) => previews.push({ current: opts.current, urls: Array.from(opts.urls) }),
      getLocation: ({ success }) => success({ latitude: 22.5401, longitude: 114.0601 }),
      showToast() {},
      showModal() {},
      stopPullDownRefresh() {}
    },
    require(mod) {
      if (mod.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({ themeClass: 'theme-day' }) }
      if (mod.endsWith('/client-nav')) return { loadMessageUnread() {} }
      return {
        getSelectedLocation: () => ({ latitude: 22.5401, longitude: 114.0601, name: '晴溪花园' }),
        requestSubscribeTemplates: async () => ({ requested: false }),
        loadSystemSettings: async () => ({}),
        requirePrivacyAuthorize: async () => {},
        showLoading() {},
        hideLoading() {},
        showError(err) { throw err },
        async callFunction(modName, action, data) {
          calls.push({ modName, action, data })
          if (action === 'checkAcceptOrderRisk') {
            return {
              requiresConfirmation: true,
              hasLargeDog: true,
              noticeTitle: '大型犬接单安全确认',
              noticeDesc: '该订单包含体重 ≥25kg 的大型犬，接单前请确认具备相应控犬与安全照护能力。',
              warnings: [{ type: 'large_dog', title: '订单包含大型犬（≥25kg）：金毛「大黄」(28kg)', detail: '力量较大' }],
              noticeItems: ['全程系牢牵引绳']
            }
          }
          if (action === 'acceptOrder') return { orderId: data.orderId, status: 'assigned' }
          return []
        }
      }
    }
  })

  const page = {
    ...homeDef,
    data: structuredClone(homeDef.data),
    setData(patch, cb) { Object.assign(this.data, patch); cb?.() }
  }

  // Photo preview supports multi-pet photo array
  page.previewOrderPetPhotos({
    currentTarget: {
      dataset: {
        url: 'cloud://env/pets/2.jpg',
        urls: ['cloud://env/pets/1.jpg', 'cloud://env/pets/2.jpg']
      }
    }
  })
  assert.deepEqual(previews, [{
    current: 'cloud://env/pets/2.jpg',
    urls: ['cloud://env/pets/1.jpg', 'cloud://env/pets/2.jpg']
  }])

  // Grabbing order opens step-1 large-dog modal, then step-2 consent submits riskConfirmed: true
  page.prepareAcceptOrder('ord_large_1')
  await flush()
  await flush()
  assert.equal(page.data.acceptRisk.hasLargeDog, true)
  assert.equal(page.data.acceptRiskStep, 1)
  assert.equal(calls.some((c) => c.action === 'acceptOrder'), false)

  page.continueAcceptRisk()
  assert.equal(page.data.acceptRiskStep, 2)
  page.toggleAcceptRiskAgreed()
  page.confirmRiskAccept()
  await flush()
  await flush()

  const acceptCall = calls.find((c) => c.action === 'acceptOrder')
  assert.ok(acceptCall)
  assert.equal(acceptCall.data.orderId, 'ord_large_1')
  assert.equal(acceptCall.data.riskConfirmed, true)
})

test('staff order detail builds petProfiles for multi-pet orders and previews clicked pet photo', async () => {
  let detailDef
  const previews = []

  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/staff/orders/detail/index.js'), 'utf8'), {
    Page(cfg) { detailDef = cfg },
    Array,
    Promise,
    wx: {
      previewImage: (opts) => previews.push({ current: opts.current, urls: Array.from(opts.urls) }),
      showToast() {},
      stopPullDownRefresh() {}
    },
    require(mod) {
      if (mod.endsWith('/format')) return require('../../miniprogram/utils/format')
      if (mod.endsWith('/nav')) return { createPageNav: () => ({}), navMethods: () => ({}) }
      if (mod.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({ themeClass: 'theme-day' }) }
      if (mod.endsWith('/clipboard')) return { copyText() {} }
      return {
        loadSystemSettings: async () => ({}),
        requestSubscribeTemplates: async () => ({}),
        showError(err) { throw err },
        async callFunction(modName, action) {
          if (action === 'getOrderDetail') {
            return {
              _id: 'ord_multi',
              status: 'paid',
              petName: '大黄、可乐',
              hasLargeDog: true,
              largeDogSummaryText: '大型犬提醒：金毛「大黄」(28kg)',
              petPhotoUrls: ['cloud://env/pets/dahuang.jpg', 'cloud://env/pets/kele.jpg'],
              petSnapshot: { name: '大黄', species: 'dog', weight: 28, isLargeDog: true, avatarFileId: 'cloud://env/pets/dahuang.jpg' },
              petSnapshots: [
                { name: '大黄', species: 'dog', weight: 28, isLargeDog: true, avatarFileId: 'cloud://env/pets/dahuang.jpg' },
                { name: '可乐', species: 'dog', weight: 12, isLargeDog: false, avatarFileId: 'cloud://env/pets/kele.jpg' }
              ]
            }
          }
          return {}
        }
      }
    }
  })

  const page = {
    ...detailDef,
    data: { ...structuredClone(detailDef.data), id: 'ord_multi' },
    setData(patch) { Object.assign(this.data, patch) }
  }

  page.load()
  await flush()
  await flush()

  assert.equal(page.data.order.petProfiles.length, 2)
  assert.equal(page.data.order.petProfiles[0].isLargeDog, true)
  assert.equal(page.data.order.petProfiles[1].weight, 12)

  page.previewPetPhoto({ currentTarget: { dataset: { url: 'cloud://env/pets/kele.jpg' } } })
  assert.deepEqual(previews, [{
    current: 'cloud://env/pets/kele.jpg',
    urls: ['cloud://env/pets/dahuang.jpg', 'cloud://env/pets/kele.jpg']
  }])
})
