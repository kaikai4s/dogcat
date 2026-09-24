const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadBookingPage(file, { stackDepth = 1, login, navigate, callFunction } = {}) {
  let page
  const navigation = []
  const errors = []
  const wx = {
    getStorageSync: () => null,
    cloud: {},
    navigateTo(options) {
      navigation.push({ method: 'navigateTo', url: options.url })
      if (navigate) navigate(options)
      else if (options.success) options.success({})
    },
    redirectTo(options) {
      navigation.push({ method: 'redirectTo', url: options.url })
      if (options.success) options.success({})
    }
  }
  const getCurrentPages = () => Array.from({ length: stackDepth }, () => ({ route: 'pages/client/home/index' }))
  const navModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/nav.js'), 'utf8'), {
    module: navModule, require: () => ({ getRoleHome: () => '/pages/client/home/index' }), wx, getCurrentPages
  })
  const deps = {
    loadSystemSettings: async () => ({}),
    ensureLogin: login || (async () => ({ _id: 'user' })),
    applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}),
    getSelectedLocation: () => null,
    toBeijingDate: require('../../miniprogram/utils/format').toBeijingDate,
    parseBeijingDate: require('../../miniprogram/utils/format').parseBeijingDate,
    showError: (error) => errors.push(error),
    callFunction: callFunction || (async (_, action) => {
      if (action === 'listServiceOptions') return [{ key: 'walk', price: 39 }]
      if (action === 'listPets') return [{ _id: 'pet', name: 'pet', species: 'dog' }]
      return []
    })
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram', file), 'utf8'), {
    Page(config) { page = config },
    require: (name) => name.endsWith('/nav') ? navModule.exports : deps,
    wx, getCurrentPages, console: { error() {}, warn() {} }, setTimeout, clearTimeout
  })
  page.setData = function (updates, callback) {
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
    if (callback) callback.call(this)
  }
  return { page, navigation, errors }
}

const homePath = 'pages/client/home/index.js'
const createPath = 'pages/client/orders/create/index.js'
const bookingUrl = '/pages/client/orders/create/index'
const tap = (url = bookingUrl) => ({ currentTarget: { dataset: { url } } })

test('home booking opens the create route with service options intact and handles a full page stack', async () => {
  for (const stackDepth of [1, 10]) {
    const { page, navigation } = loadBookingPage(homePath, { stackDepth })
    await page.goProtected(tap(bookingUrl + '?serviceType=feed'))
    assert.deepEqual(navigation, [{ method: stackDepth === 10 ? 'redirectTo' : 'navigateTo', url: bookingUrl + '?serviceType=feed' }])
    assert.equal(page.data.protectedNavigationUrl, '')
  }
})

test('booking navigation errors are visible and the entry remains retryable', async () => {
  let fail = true
  const error = { errMsg: 'navigateTo:fail page not found' }
  const { page, errors, navigation } = loadBookingPage(homePath, {
    navigate(options) { if (fail) options.fail(error); else options.success({}) }
  })
  await page.goProtected(tap())
  assert.deepEqual(errors, [error])
  assert.equal(page.data.protectedNavigationUrl, '')
  fail = false
  await page.goProtected(tap())
  assert.equal(navigation.length, 2)
})

test('rapid booking taps wait for the current login instead of opening duplicate pages', async () => {
  let resolveLogin
  const login = new Promise(resolve => { resolveLogin = resolve })
  const { page, navigation } = loadBookingPage(homePath, { login: () => login })
  const opening = page.goProtected(tap())
  page.goProtected(tap())
  assert.equal(page.data.protectedNavigationUrl, bookingUrl)
  resolveLogin({ _id: 'user' })
  await opening
  assert.equal(navigation.length, 1)
})

test('booking initialization failures stay on the page and report the actual error', async () => {
  const { page, errors, navigation } = loadBookingPage(createPath)
  const error = new Error('initialization failed')
  page.loadPageData = () => { throw error }
  await page.onShow()
  assert.deepEqual(errors, [error])
  assert.deepEqual(navigation, [])
})

test('booking auth cancellation does not override ensureLogin navigation', async () => {
  const { page, navigation } = loadBookingPage(createPath, {
    login: async () => { throw { code: 'LOGIN_CANCELLED' } }
  })
  await page.onShow()
  assert.deepEqual(navigation, [])
})

test('booking page initializes its real lifecycle and loads pet and service data', async () => {
  const { page, navigation, errors } = loadBookingPage(createPath)
  page.onLoad()
  await page.onShow()
  assert.equal(page.data.petsLoaded, true)
  assert.equal(page.data.pets[0]._id, 'pet')
  assert.equal(page.data.form.staffGenderRequirement, 'any')
  assert.ok(page.data.form.startTime)
  assert.deepEqual(errors, [])
  assert.deepEqual(navigation, [])
})
