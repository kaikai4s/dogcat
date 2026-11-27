const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { ENV_MAP, hasManorAssets } = require('../../miniprogram/envList')
const { DEFAULT_CARE, DEFAULT_GROUP } = require('../../cloudfunctions/api/services/playground-config')
const { DEFAULT_STAFF_TRAINING_QUIZ } = require('../../cloudfunctions/api/config/constants')

const root = path.resolve(__dirname, '../../miniprogram')
const flush = () => new Promise((resolve) => setImmediate(resolve))

function applySetData(targetData, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
    let target = targetData
    for (const segment of parts.slice(0, -1)) target = target[segment]
    target[parts.at(-1)] = value
  }
}

test('admin playground page renders and saves the 3D manor toggle', async () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/admin/playground/index.wxml'), 'utf8')
  assert.match(wxml, /开启 3D 庄园/)
  assert.match(wxml, /data-field="enableManor3d"/)

  let definition
  const calls = []
  let cachedSettings = null
  const toasts = []
  const initialSettings = {
    enableManor3d: true,
    playground: { width: 2240, height: 2240 },
    playgroundGroupBuy: structuredClone(DEFAULT_GROUP),
    playgroundCare: { cat: structuredClone(DEFAULT_CARE), dog: structuredClone(DEFAULT_CARE) }
  }

  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/admin/playground/index.js'), 'utf8'), {
    Page(config) { definition = config },
    wx: { showToast(opts) { toasts.push(opts.title) } },
    require(name) {
      assert.ok(name.endsWith('/cloud'))
      return {
        async callFunction(mod, action, data) {
          calls.push({ mod, action, data })
          if (action === 'getSystemSettings') return structuredClone(initialSettings)
          if (action === 'savePlaygroundSettings') return { ...structuredClone(initialSettings), ...data }
          throw new Error('unexpected action: ' + action)
        },
        setCachedSystemSettings(val) { cachedSettings = val },
        showError(err) { throw err }
      }
    }
  })

  const page = {
    ...definition,
    data: { ...structuredClone(definition.data), adminSuper: true },
    setData(patch) { applySetData(this.data, patch) }
  }

  await page.load()
  assert.equal(page.data.settings.enableManor3d, true)

  page.toggle({ currentTarget: { dataset: { field: 'enableManor3d' } }, detail: { value: false } })
  assert.equal(page.data.settings.enableManor3d, false)
  assert.equal(page.data.dirty, true)

  await page.save()
  const saveCall = calls.find((c) => c.action === 'savePlaygroundSettings')
  assert.ok(saveCall)
  assert.equal(saveCall.data.enableManor3d, false)
  assert.equal(cachedSettings.enableManor3d, false)
  assert.equal(page.data.settings.enableManor3d, false)
  assert.equal(page.data.dirty, false)
  assert.deepEqual(toasts, ['庄园配置已保存'])
})

test('admin system settings page renders and saves the 3D manor toggle with super-admin guard', async () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/admin/settings/index.wxml'), 'utf8')
  assert.match(wxml, /data-panel="manor3d"/)
  assert.match(wxml, /bindchange="toggleManor3d"/)

  let definition
  const saves = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/admin/settings/index.js'), 'utf8'), {
    Page(config) { definition = config },
    wx: { showToast() {}, showLoading() {}, hideLoading() {} },
    console,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      if (name.endsWith('/payment-config')) return require('../../miniprogram/pages/admin/settings/payment-config')
      if (name.endsWith('/subscription-options')) return require('../../miniprogram/utils/subscription-options')
      if (name.endsWith('/adminAccess')) return { can: () => true }
      if (name.endsWith('/cloud')) {
        return {
          getCloudEnv: () => 'test-env',
          setCachedSystemSettings() {},
          showError(err) { throw err },
          async callFunction(mod, action, payload) {
            saves.push({ mod, action, payload })
            return payload
          }
        }
      }
      return {}
    }
  })

  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, cb) { applySetData(this.data, patch); cb?.() }
  }
  page.data.loaded = true
  page.data.settings.staffTraining.quiz = structuredClone(DEFAULT_STAFF_TRAINING_QUIZ)

  // Non-super admin cannot toggle
  page.data.adminSuper = false
  page.toggleManor3d({ detail: { value: false } })
  assert.equal(page.data.settings.enableManor3d, true)

  // Super admin toggles off and saves
  page.data.adminSuper = true
  page.toggleManor3d({ detail: { value: false } })
  page.closeSettingModal()
  assert.equal(page.data.settings.enableManor3d, false)
  assert.equal(page.data.settingSummary.manor3d, '前台 3D 庄园已关闭')

  page.save()
  await flush()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].action, 'saveSystemSettings')
  assert.equal(saves[0].payload.enableManor3d, false)
})

test('client playground entry, 3D entry chooser, and direct 3D page respect enableManor3d switch', async () => {
  // 1. Playground home page hides 3D button and blocks openManor3d when enableManor3d is false
  let playgroundDef
  let cached = { enableManor3d: false }
  let overviewEnable = false
  const navigations = []

  vm.runInNewContext(fs.readFileSync(path.join(root, 'packagePlayground/pages/index.js'), 'utf8'), {
    Page(value) { playgroundDef = value },
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }),
      navigateTo: (opts) => navigations.push(opts),
      redirectTo: (opts) => navigations.push(opts),
      showToast() {},
      showLoading() {},
      hideLoading() {}
    },
    require(mod) {
      if (mod === '../../envList') return { getActiveEnvId: () => ENV_MAP.trial, hasManorAssets }
      return {
        getCachedSystemSettings: () => cached,
        setCachedSystemSettings: (next) => { cached = next; return next },
        ensureLogin: async () => {},
        showError: (err) => { throw err },
        callFunction: async () => ({ enableManor3d: overviewEnable, pets: [], hasCommunity: true })
      }
    }
  })

  const playgroundPage = {
    ...playgroundDef,
    data: structuredClone(playgroundDef.data),
    setData(patch) { Object.assign(this.data, patch) }
  }
  playgroundPage.onLoad()
  assert.equal(playgroundPage.data.showManor3d, false)
  await playgroundPage.load()
  assert.equal(playgroundPage.data.showManor3d, false)
  playgroundPage.openManor3d()
  assert.equal(navigations.length, 0)

  // 2D manor remains open
  playgroundPage.openWorld()
  assert.equal(navigations.length, 1)
  assert.equal(navigations[0].url, '/packagePlayground/pages/world')

  // Re-enabling on server restores 3D entry button
  overviewEnable = true
  await playgroundPage.load()
  assert.equal(playgroundPage.data.showManor3d, true)
  assert.equal(cached.enableManor3d, true)

  // 2. manor3d-entry blocks solo and community entry when cached settings mark enableManor3d: false
  let entryDef
  const entryNavs = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'packagePlayground/pages/manor3d-entry.js'), 'utf8'), {
    Page(value) { entryDef = value },
    Date,
    Math,
    wx: {
      getStorageSync(key) {
        if (key === 'vip_pet_system_settings') return { enableManor3d: false }
        return null
      },
      setStorageSync() {},
      removeStorageSync() {},
      navigateTo(opts) { entryNavs.push(opts) },
      navigateBack() {}
    }
  })
  const entryPage = { ...entryDef, data: structuredClone(entryDef.data), setData(p) { Object.assign(this.data, p) } }
  entryPage.onLoad()
  entryPage.enterSolo()
  assert.equal(entryNavs.length, 0)
  assert.equal(entryPage.data.error, '3D 庄园暂未开放')
  await entryPage.chooseCommunity()
  assert.equal(entryNavs.length, 0)
  assert.equal(entryPage.data.error, '3D 庄园暂未开放')

  // 3. Direct packageManor3d/pages/index transitions to unavailable without mounting canvas when disabled
  let manorDef
  const assetEvents = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'packageManor3d/pages/index.js'), 'utf8'), {
    Page(value) { manorDef = value },
    Date,
    setTimeout,
    clearTimeout,
    console: { warn() {} },
    wx: {
      getMenuButtonBoundingClientRect: () => ({ bottom: 82 }),
      getStorageSync: () => null,
      removeStorageSync() {},
      setStorageSync() {}
    },
    require(mod) {
      if (mod === '../../envList') return { getActiveEnvId: () => ENV_MAP.trial }
      if (mod === '../../utils/cloud') {
        return {
          getCachedSystemSettings: () => ({ enableManor3d: false }),
          loadSystemSettings: async () => ({ enableManor3d: false })
        }
      }
      if (mod === '../utils/cloud-assets') {
        return {
          hasManorAssets,
          createCloudAssets() {
            assetEvents.push('createAssets')
            return { async read() {}, invalidate() {}, cancel() {} }
          }
        }
      }
      if (mod === '../utils/model-runtime') return { THREE: {}, createRenderer() {}, async loadGlb() {}, disposeModel() {} }
      if (mod === '../utils/manor-scene') return { createManorScene() {} }
      if (mod === '../utils/manor-minimap') return require('../../miniprogram/packageManor3d/utils/manor-minimap')
      throw new Error('unexpected module: ' + mod)
    }
  })
  const manorPage = { ...manorDef, data: structuredClone(manorDef.data), setData(p, cb) { Object.assign(this.data, p); cb?.() } }
  manorPage.onLoad({})
  manorPage.onShow()
  manorPage.onReady()
  await flush()
  assert.equal(manorPage.data.status, 'unavailable')
  assert.equal(manorPage.data.mountCanvas, false)
  assert.deepEqual(assetEvents, [])

  // 4. Stale cached enableManor3d: false recovers when loadSystemSettings returns enableManor3d: true
  let reopenManorDef
  let reopenAssetsCreated = 0
  vm.runInNewContext(fs.readFileSync(path.join(root, 'packageManor3d/pages/index.js'), 'utf8'), {
    Page(value) { reopenManorDef = value },
    Date,
    setTimeout,
    clearTimeout,
    console: { warn() {} },
    wx: {
      getMenuButtonBoundingClientRect: () => ({ bottom: 82 }),
      getWindowInfo: () => ({ pixelRatio: 1 }),
      getStorageSync: () => null,
      removeStorageSync() {},
      setStorageSync() {},
      createSelectorQuery: () => ({
        in: () => ({
          select: () => ({
            fields: () => ({ exec: (cb) => cb([{ node: {}, width: 375, height: 667 }]) })
          })
        })
      })
    },
    require(mod) {
      if (mod === '../../envList') return { getActiveEnvId: () => ENV_MAP.trial }
      if (mod === '../../utils/cloud') {
        return {
          getCachedSystemSettings: () => ({ enableManor3d: false }),
          loadSystemSettings: async () => ({ enableManor3d: true })
        }
      }
      if (mod === '../utils/cloud-assets') {
        return {
          hasManorAssets,
          createCloudAssets() {
            reopenAssetsCreated += 1
            return { read: () => new Promise(() => {}), invalidate() {}, cancel() {} }
          }
        }
      }
      if (mod === '../utils/model-runtime') {
        return {
          THREE: {},
          createRenderer: () => ({ getPixelRatio: () => 1, setPixelRatio() {}, dispose() {} }),
          async loadGlb() {},
          disposeModel() {}
        }
      }
      if (mod === '../utils/manor-scene') return { createManorScene: () => ({ resize() {}, dispose() {} }) }
      if (mod === '../utils/manor-minimap') return require('../../miniprogram/packageManor3d/utils/manor-minimap')
      throw new Error('unexpected module: ' + mod)
    }
  })
  const reopenPage = { ...reopenManorDef, data: structuredClone(reopenManorDef.data), setData(p, cb) { Object.assign(this.data, p); cb?.() } }
  reopenPage.onLoad({})
  assert.equal(reopenPage.data.status, 'unavailable')
  reopenPage.onReady()
  reopenPage.onShow()
  await flush()
  assert.notEqual(reopenPage.data.status, 'unavailable')
  assert.equal(reopenPage.data.mountCanvas, true)
  assert.ok(reopenAssetsCreated >= 1)
})
