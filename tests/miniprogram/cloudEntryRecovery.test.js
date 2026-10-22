const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup() {
  let now = 1000
  let onShow
  let timerId = 0
  const timers = new Map()
  const requests = []
  const messages = []
  const storage = {}
  const app = { globalData: { env: 'test-env', user: null } }
  const module = { exports: {} }
  const wx = {
    cloud: { callFunction(options) { return new Promise((resolve, reject) => requests.push({ ...options, resolve, reject })) } },
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    onAppShow: callback => { onShow = callback },
    showToast: options => messages.push(options.title),
    showModal: options => messages.push(options.content)
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/cloud.js'), 'utf8'), {
    module, wx, getApp: () => app, Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout: id => timers.delete(id),
    require: name => name.endsWith('/subscription-options') ? require('../../miniprogram/utils/subscription-options') : { envList: [], getSavedThemeKey: () => '', getSavedFontKey: () => '', saveTheme() {}, saveFont() {} }
  })
  return {
    api: module.exports, app, requests, messages,
    advance(ms, fireTimers = true) {
      now += ms
      if (fireTimers) for (const timer of [...timers.values()]) if (timer.at <= now) timer.callback()
    },
    resume() { onShow() }
  }
}
const ok = user => ({ result: { ok: true, data: user } })

test('a late explicit login cannot undo a subsequent logout', async () => {
  const { api, requests, app } = setup()
  const pending = api.loginWithWechat()
  api.logoutCurrentUser()
  requests[0].resolve(ok({ _id: 'old-login' }))
  assert.equal(await pending, null)
  assert.equal(app.globalData.user, null)
  assert.equal(app.globalData.isGuest, true)
  assert.equal(await api.getCurrentUser({ silent: true }), null)
  assert.equal(requests.length, 1)
})

test('overlapping explicit logins keep the newest identity regardless of response order', async () => {
  for (const reverse of [false, true]) {
    const { api, requests, app } = setup()
    const first = api.loginWithWechat()
    const second = api.loginWithWechat()
    if (reverse) {
      requests[1].resolve(ok({ _id: 'current' }))
      await second
      requests[0].resolve(ok({ _id: 'stale' }))
    } else {
      requests[0].resolve(ok({ _id: 'stale' }))
      await first
      assert.equal(app.globalData.user, null)
      requests[1].resolve(ok({ _id: 'current' }))
    }
    await Promise.all([first, second])
    assert.equal(app.globalData.user._id, 'current')
  }
})

test('an old session response cannot invalidate an explicit login in progress', async () => {
  const { api, requests, app } = setup()
  const session = api.getCurrentUser({ sessionOnly: true })
  await flush()
  const login = api.loginWithWechat()
  requests[0].resolve(ok({ _id: 'stale-session' }))
  await session
  assert.equal(app.globalData.user, null)
  requests[1].resolve(ok({ _id: 'explicit-login' }))
  await login
  assert.equal(app.globalData.user._id, 'explicit-login')
})

test('parallel homepage and booking session checks share one lightweight request', async () => {
  const { api, requests } = setup()
  const first = api.getCurrentUser({ silent: true, sessionOnly: true })
  const second = api.getCurrentUser({ silent: true, sessionOnly: true })
  const booking = api.ensureLogin()
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].data.action, 'checkSession')
  requests[0].resolve(ok({ _id: 'user' }))
  for (const user of await Promise.all([first, second, booking])) assert.equal(user._id, 'user')
})

test('session timeout releases the request; retry succeeds and late old success cannot overwrite it', async () => {
  const { api, requests, advance, app, messages } = setup()
  const oldResult = api.ensureLogin().catch(error => error)
  await flush()
  advance(15000)
  assert.equal((await oldResult).code, 'ENTRY_READ_TIMEOUT')
  assert.equal(messages.length, 1)
  const retry = api.ensureLogin()
  await flush()
  assert.equal(requests.length, 2)
  requests[1].resolve(ok({ _id: 'current' }))
  assert.equal((await retry)._id, 'current')
  requests[0].resolve(ok({ _id: 'stale' }))
  await flush()
  assert.equal(app.globalData.user._id, 'current')
})

test('returning from background expires waiting reads even if timers were suspended', async () => {
  const { api, requests, advance, resume, app } = setup()
  const waiting = api.getCurrentUser({ sessionOnly: true }).catch(error => error)
  await flush()
  advance(8 * 60 * 1000, false)
  resume()
  assert.equal((await waiting).code, 'ENTRY_READ_TIMEOUT')
  requests[0].resolve(ok({ _id: 'stale' }))
  await flush()
  assert.equal(app.globalData.user, null)
})

test('late response is rejected by wall-clock deadline before a suspended timeout callback runs', async () => {
  const { api, requests, advance, app } = setup()
  const waiting = api.getCurrentUser({ sessionOnly: true }).catch(error => error)
  await flush()
  advance(16000, false)
  requests[0].resolve(ok({ _id: 'stale' }))
  assert.equal((await waiting).code, 'ENTRY_READ_TIMEOUT')
  assert.equal(app.globalData.user, null)
})

test('result-expired message is readable and stale session errors cannot clear a newer login', async () => {
  const { api, requests, app, messages } = setup()
  api.showError({ errMsg: 'cloud.callFunction:fail -404010 result expired. callId: private-trace' })
  assert.ok(messages[0].includes('连接已过期'))
  assert.ok(!messages[0].includes('private-trace'))
  const pending = api.getCurrentUser({ sessionOnly: true })
  await flush()
  api.setCachedUser({ _id: 'new-login' })
  requests[0].resolve({ result: { ok: false, message: '请先登录' } })
  await pending
  assert.equal(app.globalData.user._id, 'new-login')
})

test('leaving a booking attempt suppresses its delayed login error', async () => {
  const { api, requests, messages } = setup()
  let active = true
  const waiting = api.ensureLogin({ isActive: () => active }).catch(error => error)
  await flush()
  active = false
  requests[0].reject({ errCode: -404010, errMsg: 'result expired' })
  assert.equal((await waiting).code, 'LOGIN_CANCELLED')
  assert.equal(messages.length, 0)
})

test('identity subscribers synchronously observe login, permission changes, expiration and logout', async () => {
  const { api, app, requests } = setup()
  const observed = []
  const unsubscribe = api.subscribeIdentityChange(user => observed.push(user))
  const staff = { _id: 'staff', roles: ['staff'] }
  api.setCachedUser(staff)
  assert.equal(observed[0], staff)
  const revoked = { ...staff, roles: ['client'] }
  api.setCachedUser(revoked)
  assert.equal(observed[1], revoked)
  const reading = api.callFunction('order', 'getActiveService').catch(error => error)
  await flush()
  requests[0].resolve({ result: { ok: false, message: '请先登录' } })
  await reading
  assert.equal(observed[2], null)
  assert.equal(app.globalData.user, null)
  api.setCachedUser(staff)
  api.logoutCurrentUser()
  assert.equal(observed[4], null)
  unsubscribe()
  api.setCachedUser(staff)
  assert.equal(observed.length, 5)
})

test('active-service recovery has a read deadline so a suspended request cannot block later recovery', async () => {
  const { api, requests, advance } = setup()
  const waiting = api.callFunction('order', 'getActiveService').catch(error => error)
  await flush()
  advance(15000)
  assert.equal((await waiting).code, 'ENTRY_READ_TIMEOUT')
  const retry = api.callFunction('order', 'getActiveService')
  await flush()
  requests[1].resolve(ok({ orderId: 'active-order' }))
  assert.equal((await retry).orderId, 'active-order')
  requests[0].resolve(ok({ orderId: 'stale-order' }))
})

test('order creation is not subject to read deadlines and is never automatically retried', async () => {
  const { api, requests, advance } = setup()
  const creating = api.callFunction('order', 'createOrder', { clientRequestId: 'same-id' })
  advance(60000)
  assert.equal(requests.length, 1)
  requests[0].resolve(ok({ _id: 'order' }))
  assert.equal((await creating)._id, 'order')
})
