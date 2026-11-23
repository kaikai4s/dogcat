const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')

function loadPageDef(relPath, extraRequires = {}, extraGlobals = {}) {
  let pageDef
  const fullPath = path.join(root, relPath)
  const dir = path.dirname(fullPath)
  vm.runInNewContext(fs.readFileSync(fullPath, 'utf8'), {
    Page: (def) => { pageDef = def },
    getApp: () => ({ globalData: {} }),
    getCurrentPages: () => [],
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    wx: {
      showToast() {},
      showModal() {},
      navigateTo() {},
      redirectTo() {},
      navigateBack() {},
      switchTab() { throw new Error('switchTab must not be called without tabBar') },
      stopPullDownRefresh() {},
      getStorageSync() { return null },
      removeStorageSync() {},
      setStorageSync() {},
      createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec() {} }) }) }),
      ...extraGlobals.wx
    },
    require: (req) => {
      for (const [suffix, impl] of Object.entries(extraRequires)) {
        if (req.endsWith(suffix)) return impl
      }
      if (req.startsWith('.')) {
        const resolved = path.resolve(dir, req)
        if (resolved.endsWith('utils/format') || resolved.endsWith('utils/format.js')) {
          return require(path.join(root, 'utils/format.js'))
        }
      }
      return {}
    },
    ...extraGlobals.globals
  })
  return pageDef
}

function makeInstance(pageDef, overrides = {}) {
  const inst = {
    ...pageDef,
    data: JSON.parse(JSON.stringify(pageDef.data || {})),
    setData(patch, cb) {
      for (const [k, v] of Object.entries(patch || {})) {
        if (k.includes('.')) {
          const parts = k.split('.')
          let cur = this.data
          while (parts.length > 1) {
            const p = parts.shift()
            if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}
            cur = cur[p]
          }
          cur[parts[0]] = v
        } else {
          this.data[k] = v
        }
      }
      if (cb) cb.call(this)
    },
    ...overrides
  }
  return inst
}

test('F2: client home uses order.listOrders (not nonexistent getClientOrders)', async () => {
  const calls = []
  const pageDef = loadPageDef('pages/client/home/index.js', {
    '/cloud': {
      callFunction: async (mod, action, data) => {
        calls.push({ mod, action, data })
        return { list: [{ _id: 'ord_r1', status: 'completed' }] }
      },
      ensureLogin: async () => true,
      loadSystemSettings: async () => ({}),
      showError() {}
    },
    '/nav': { navMethods: () => ({}) },
    '/page-share': { createShareConfig: () => ({}) },
    '/theme': { applyTheme: () => ({ value: 'warm' }), getThemeState: () => ({}) },
    '/font': { initFontSize() {} }
  })
  const navUrls = []
  const inst = makeInstance(pageDef)
  await pageDef.onTapQuickRepeat.call(inst)
  await Promise.resolve()
  assert.ok(calls.some(c => c.mod === 'order' && c.action === 'listOrders'))
  assert.equal(calls.some(c => c.action === 'getClientOrders'), false)
  void navUrls
})

test('F4: group-buy openProfile uses wx.navigateTo instead of wx.switchTab', () => {
  const navigated = []
  const pageDef = loadPageDef('pages/client/orders/group-buy/index.js', {
    '/cloud': { callFunction: async () => ({}), ensureLogin: async () => ({}), showError() {} },
    '/community-group-buy': { decorateListing: x => x },
    '/theme': { applyTheme: () => ({ value: 'warm' }), getThemeState: () => ({}) }
  }, {
    wx: { navigateTo: (opts) => navigated.push(opts.url), switchTab() { throw new Error('unexpected switchTab') } }
  })
  const inst = makeInstance(pageDef)
  inst.openProfile()
  assert.deepEqual(navigated, ['/pages/client/profile/index'])
})

test('F5: booking page locks publishMode=open & orderType=single in groupBuyMode and matches serviceOptions by key', async () => {
  const aiPayloads = []
  const pageDef = loadPageDef('pages/client/orders/create/index.js', {
    '/cloud': {
      callFunction: async (mod, action, data) => {
        if (action === 'generatePetVoice') {
          aiPayloads.push(data)
          return { voiceMessage: 'ai ok' }
        }
        return {}
      },
      ensureLogin: async () => ({}),
      loadSystemSettings: async () => ({}),
      getCachedSystemSettings: () => ({}),
      showError() {}
    },
    '/nav': { createPageNav: () => ({}), navMethods: () => ({}), safeNavigateTo() {} },
    '/offlineQueue': { createClientRequestId: () => 'cid_1' },
    '/theme': { applyTheme: () => ({ value: 'warm' }), getThemeState: () => ({}) }
  })

  const inst = makeInstance(pageDef)
  inst.showBookingNotice = () => {}
  inst.initPricingSurcharges = () => {}
  inst.onLoad({ source: 'community_groupbuy', publishMode: 'direct', staffProfileId: 'sp_1' })
  assert.equal(inst.data.groupBuyMode, true)
  assert.equal(inst.data.form.publishMode, 'open')
  assert.equal(inst.data.form.staffProfileId, '')
  assert.equal(inst.data.form.orderType, 'single')

  inst.choosePublishMode({ currentTarget: { dataset: { mode: 'direct' } } })
  assert.equal(inst.data.form.publishMode, 'open')

  inst.chooseOrderType({ currentTarget: { dataset: { type: 'multi_day' } } })
  assert.equal(inst.data.form.orderType, 'single')

  inst.changeCalendarOrderType({ currentTarget: { dataset: { type: 'multi_day' } } })
  assert.equal(inst.data.calendarTempOrderType, 'single')

  inst.setData({
    serviceOptions: [{ key: 'walk', label: '遛狗服务' }, { key: 'feed', label: '喂养服务' }],
    'form.serviceType': 'walk',
    'form.startDate': '2026-10-01'
  })
  await inst.fetchAiPetVoice({ _id: 'p1', name: '豆豆' }, '2026-10-01')
  assert.equal(aiPayloads[0].serviceName, '遛狗服务')
})

test('F6: admin orders/list and sitters/list accept keyword from onLoad query', () => {
  const ordersDef = loadPageDef('pages/admin/orders/list/index.js', {
    '/cloud': { callFunction: async () => ({ list: [] }), showError() {} },
    '/admin-page-read': { optionalAdminRead: async () => [] }
  })
  const ordersInst = makeInstance(ordersDef)
  ordersInst.onLoad({ keyword: 'openid_target%5F1' })
  assert.equal(ordersInst.data.orderKeyword, 'openid_target_1')

  const sittersDef = loadPageDef('pages/admin/sitters/list/index.js', {
    '/cloud': { callFunction: async () => ({ list: [] }), showError() {} },
    '/admin-page-read': { optionalAdminRead: async () => [] },
    '/image-upload': { uploadImage: async () => '' },
    '/envList': { getActiveEnvId: () => 'env_1' }
  })
  const sittersInst = makeInstance(sittersDef)
  sittersInst.onLoad({ keyword: 'openid_staff%5F2' })
  assert.equal(sittersInst.data.keyword, 'openid_staff_2')
})

test('F7: questionnaire edit renders coupon names using type and discountAmount instead of undefined', async () => {
  const pageDef = loadPageDef('pages/admin/questionnaires/edit/index.js', {
    '/cloud': { callFunction: async () => ({}), showError() {} },
    '/admin-page-read': {
      optionalAdminRead: async () => [{ _id: 'tpl_1', name: '满减券', type: 'fixed', discountAmount: 25 }]
    }
  })
  const inst = makeInstance(pageDef)
  await inst.loadCoupons()
  assert.deepEqual(Array.from(inst.data.couponNames), ['不发放优惠券', '满减券 (减¥25)'])
})

test('F8: client order detail does not start polling timer after onHide/onUnload during async load', async () => {
  let resolveOrder
  const intervalCallbacks = []
  const clearedIds = []
  const pageDef = loadPageDef('pages/client/orders/detail/index.js', {
    '/cloud': {
      callFunction: (mod, action) => {
        if (action === 'getOrderDetail') return new Promise(r => { resolveOrder = r })
        return Promise.resolve([])
      },
      ensureLogin: async () => true,
      loadSystemSettings: async () => ({}),
      showError() {}
    },
    '/nav': { createPageNav: () => ({}), navMethods: () => ({}) },
    '/theme': { applyTheme: () => ({ value: 'warm' }), getThemeState: () => ({}) },
    '/sessionChat': { sessionChatMethods: () => ({ stopSessionChatRefresh() {}, startSessionChatRefresh() {} }) },
    '/orderCareCards': { buildOrderCareCards: () => [] }
  }, {
    globals: {
      setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length },
      clearInterval: (id) => { clearedIds.push(id) }
    }
  })
  const inst = makeInstance(pageDef)
  inst.onLoad({ id: 'ord_1' })
  await inst.onShow()
  const loadPromise = inst.load()
  inst.onHide()
  resolveOrder({ _id: 'ord_1', status: 'assigned', serviceSessions: [] })
  await loadPromise
  assert.equal(intervalCallbacks.length, 0, 'must not start polling interval after page is hidden')
})

test('F9: adminAccess guard cancels async callbacks after hide/unload and does not redirect on page load error', async () => {
  let resolveAccess
  const redirects = []
  const shownErrors = []
  const pages = []
  const source = fs.readFileSync(path.join(root, 'utils/adminAccess.js'), 'utf8')
  const ctx = {
    module: { exports: {} },
    Page(opts) { pages.push(opts) },
    wx: {
      showToast() {},
      redirectTo: (opts) => redirects.push(opts.url),
      reLaunch: (opts) => redirects.push(opts.url)
    },
    require(name) {
      if (name.endsWith('cloud')) {
        return {
          callFunction: () => new Promise(r => { resolveAccess = r }),
          showError: (err) => shownErrors.push(err && err.message)
        }
      }
      return {}
    }
  }
  vm.runInNewContext(source, ctx)
  ctx.module.exports.installAdminPageGuard()

  // Scenario 1: page unloaded before getMyAdminAccess resolves
  let shownCount = 0
  ctx.Page({ onLoad() {}, onShow() { shownCount += 1 } })
  const page1 = { route: 'pages/admin/home/index', setData() {} }
  pages[0].onLoad.call(page1, {})
  const p1 = pages[0].onShow.call(page1)
  pages[0].onUnload.call(page1)
  resolveAccess({ superAdmin: true, permissions: [] })
  await p1
  assert.equal(shownCount, 0)

  // Scenario 2: page onShow rejects with error -> shows error but does NOT kick user to role-select
  ctx.Page({
    onLoad() {},
    onShow() { return Promise.reject(new Error('业务加载失败')) }
  })
  const page2 = { route: 'pages/admin/home/index', setData() {} }
  pages[1].onLoad.call(page2, {})
  const p2 = pages[1].onShow.call(page2)
  resolveAccess({ superAdmin: true, permissions: [] })
  await p2
  assert.deepEqual(shownErrors, ['业务加载失败'])
  assert.deepEqual(redirects, [])
})

test('F10: admin lists drop stale responses on rapid reset and client address save locks duplicate taps', async () => {
  // 1. staff-promotion/list
  const promoResolvers = []
  const promoDef = loadPageDef('pages/admin/staff-promotion/list/index.js', {
    '/cloud': { callFunction: () => new Promise(r => promoResolvers.push(r)), showError() {} }
  })
  const promo = makeInstance(promoDef)
  const firstLoad = promo.load({ reset: true })
  promo.switchStatus({ currentTarget: { dataset: { value: 'approved' } } })
  assert.equal(promoResolvers.length, 2, 'switching status during loading must still issue request')
  promoResolvers[1]({ list: [{ _id: 'new_1' }], page: 1, hasMore: false })
  await Promise.resolve()
  promoResolvers[0]({ list: [{ _id: 'stale_1' }], page: 1, hasMore: false })
  await firstLoad
  await Promise.resolve()
  assert.deepEqual(Array.from(promo.data.list).map(i => i._id), ['new_1'])

  // 2. incidents/list lock on resolve
  let resolveCalls = 0
  let resolveDone
  const incDef = loadPageDef('pages/admin/incidents/list/index.js', {
    '/cloud': {
      callFunction: (mod, action) => {
        if (action === 'resolveIncident') {
          resolveCalls += 1
          return new Promise(r => { resolveDone = r })
        }
        return Promise.resolve({ list: [], page: 1, hasMore: false, total: 0 })
      },
      showError() {}
    }
  })
  const inc = makeInstance(incDef)
  const r1 = inc.resolve({ currentTarget: { dataset: { id: 'inc_1' } } })
  inc.resolve({ currentTarget: { dataset: { id: 'inc_1' } } })
  assert.equal(resolveCalls, 1)
  resolveDone()
  await r1

  // 3. addresses/edit save lock
  let saveCalls = 0
  let saveDone
  const addrDef = loadPageDef('pages/client/addresses/edit/index.js', {
    '/cloud': {
      callFunction: () => {
        saveCalls += 1
        return new Promise(r => { saveDone = r })
      },
      chooseSelectedLocation: async () => ({}),
      ensureLogin: async () => true,
      showError() {}
    },
    '/nav': { createPageNav: () => ({}), navMethods: () => ({}) }
  })
  const addr = makeInstance(addrDef)
  addr.setData({
    'form.serviceAddress': '阳光小区',
    'form.latitude': 31.2,
    'form.longitude': 121.5,
    'form.addressDetail': '1栋1单元',
    'form.doorplate': '101'
  })
  const s1 = addr.save()
  addr.save()
  assert.equal(saveCalls, 1)
  saveDone()
  await s1
})
