const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram/pages/client/mall/list')
const appid = 'wx' + '1'.repeat(16)
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup({ enabled = true, supported = true, platform = 'ios', failed = false } = {}) {
  const calls = []
  let shopEnabled = enabled
  let shopFailed = failed
  const wx = { canIUse: () => supported, getDeviceInfo: () => ({ platform }), stopPullDownRefresh: () => {} }
  const deps = {
    callFunction(module, action) {
      calls.push(`${module}.${action}`)
      if (action === 'getShopConfig') return shopFailed
        ? Promise.reject(new Error('网络错误'))
        : Promise.resolve({ enabled: shopEnabled, appid: shopEnabled ? appid : '' })
      if (action === 'listCategories') return Promise.resolve([])
      if (action === 'listProducts') return Promise.resolve({ list: [], page: 1, hasMore: false, total: 0 })
      return Promise.resolve({})
    },
    showError: error => { throw error },
    ensureLogin: () => Promise.resolve()
  }
  let page
  vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), {
    Page: config => { page = config }, wx, require: () => deps, Promise
  })
  page.setData = function (data, callback) {
    for (const [key, value] of Object.entries(data)) this.data[key] = value
    if (callback) callback.call(this)
  }
  return { page, calls, setShopEnabled: value => { shopEnabled = value }, setShopFailed: value => { shopFailed = value } }
}

test('enabled shop opens first without loading local inventory or checkout', async () => {
  const { page, calls } = setup()
  page.onLoad()
  await flush()
  assert.equal(page.data.mallMode, 'shop')
  assert.equal(page.data.shopConfig.appid, appid)
  assert.deepEqual(calls, ['mall.getShopConfig'])
  page.switchMallMode({ currentTarget: { dataset: { mode: 'local' } } })
  await flush()
  assert.equal(page.data.mallMode, 'local')
  assert.equal(calls.includes('mall.listProducts'), true)
  page.switchMallMode({ currentTarget: { dataset: { mode: 'shop' } } })
  page.onReachBottom()
  assert.equal(calls.filter(call => call === 'mall.listProducts').length, 1)
})

test('disabled or unsupported shop falls back to local mall, including after disabling', async () => {
  for (const options of [{ enabled: false }, { supported: false }, { platform: 'windows' }, { platform: 'mac' }]) {
    const { page, calls } = setup(options)
    page.onLoad()
    await flush()
    assert.equal(page.data.mallMode, 'local')
    assert.equal(calls.includes('mall.listProducts'), true)
  }
  const { page, setShopEnabled } = setup()
  page.onLoad()
  await flush()
  setShopEnabled(false)
  await page.loadShopConfig(false)
  assert.equal(page.data.mallMode, 'local')
  assert.equal(page.data.localLoaded, true)
})

test('initial config failure shows retry and opens the shop after recovery', async () => {
  const { page, calls, setShopFailed } = setup({ failed: true })
  page.onLoad()
  await flush()
  assert.equal(page.data.configLoaded, true)
  assert.equal(page.data.shopConfigError, true)
  assert.equal(page.data.mallMode, 'local')
  assert.equal(calls.includes('mall.listProducts'), true)
  setShopFailed(false)
  await page.retryShopConfig()
  assert.equal(page.data.shopConfigError, false)
  assert.equal(page.data.mallMode, 'shop')
})

test('temporary failure keeps current shop and does not override an explicit local choice', async () => {
  const { page, setShopFailed } = setup()
  page.onLoad()
  await flush()
  setShopFailed(true)
  await page.loadShopConfig(false)
  assert.equal(page.data.mallMode, 'shop')
  assert.equal(page.data.shopConfig.enabled, true)
  assert.equal(page.data.shopConfigError, true)
  page.switchMallMode({ currentTarget: { dataset: { mode: 'local' } } })
  await flush()
  setShopFailed(false)
  await page.loadShopConfig(false)
  assert.equal(page.data.mallMode, 'local')
  assert.equal(page.data.shopConfigError, false)
})

test('native shop component and local cart are rendered in mutually exclusive branches', () => {
  const markup = fs.readFileSync(path.join(root, 'index.wxml'), 'utf8')
  assert.match(markup, /wx:elif="\{\{shopConfig\.enabled && shopSupported && mallMode === 'shop'\}\}"/)
  assert.match(markup, /<store-home\s+class="wechat-shop-home"\s+appid="\{\{shopConfig\.appid\}\}"\s*\/>/)
  assert.match(markup, /<dovlin-refresh\s+wx:else/)
  assert.match(markup, /bindtap="cart"/)
  assert.match(markup, /bindtap="retryShopConfig"/)
})
