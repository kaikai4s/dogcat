const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(respond, login = async () => {}) {
  let definition
  const calls = [], navigation = [], toasts = [], errors = [], loading = []
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/pages/index.js'), 'utf8'), {
    Page(value) { definition = value }, require() { return {
      callFunction: async (module, action, data) => { calls.push({ action, data }); return respond(action, data) },
      ensureLogin: login, showError: error => errors.push(error)
    } }, wx: { navigateTo: value => navigation.push(value), redirectTo: value => navigation.push(value),
      showToast: value => toasts.push(value), showLoading: () => loading.push('show'), hideLoading: () => loading.push('hide') }
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(data) { Object.assign(this.data, data) } }
  return { page, calls, navigation, toasts, errors, loading }
}

test('overlapping entry refreshes keep the latest overview when responses arrive out of order', async () => {
  const replies = []
  const f = fixture(() => new Promise(resolve => replies.push(resolve)))
  const older = f.page.load(), latest = f.page.load()
  replies[1]({ userCommunity: { name: '新小区' }, hasCommunity: true, pets: [] })
  await latest
  replies[0]({ userCommunity: { name: '旧小区' }, hasCommunity: true, pets: [] })
  await older
  assert.equal(f.page.data.userCommunity.name, '新小区')
})

test('saving a community invalidates an older overview and blocks duplicate saves', async () => {
  let overviewReply, saveReply
  const f = fixture(action => new Promise(resolve => {
    if (action === 'getOverview') overviewReply = resolve
    else saveReply = resolve
  }))
  const refresh = f.page.load()
  const saving = f.page.saveCommunity({ name: '新小区' }, false)
  const duplicate = await f.page.saveCommunity({ name: '其他小区' }, true)
  assert.equal(duplicate, null)
  assert.equal(f.calls.filter(call => call.action === 'saveCommunity').length, 1)
  saveReply({ residentialCommunity: { name: '新小区' } })
  await saving
  overviewReply({ userCommunity: { name: '旧小区' }, hasCommunity: true, pets: [] })
  await refresh
  assert.equal(f.page.data.userCommunity.name, '新小区')
  assert.equal(f.page.data.loading, false)
  assert.equal(f.page.data.savingCommunity, false)
})

test('leaving the entry page suppresses late save navigation and notifications', async () => {
  let finish
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  const saving = f.page.saveCommunity({ name: '新小区' }, true)
  f.page.onHide()
  finish({ residentialCommunity: { name: '新小区' } })
  await saving
  assert.equal(f.navigation.length, 0)
  assert.equal(f.toasts.length, 0)
  assert.equal(f.page.data.userCommunity, null)
  assert.deepEqual(f.loading, ['show', 'hide'])
})

test('a failed save releases loading even when it invalidated an in-flight overview', async () => {
  let finish
  const f = fixture(action => {
    if (action === 'getOverview') return new Promise(resolve => { finish = resolve })
    throw new Error('保存失败')
  })
  const refresh = f.page.load()
  await assert.rejects(f.page.saveCommunity({ name: '新小区' }, false), /保存失败/)
  assert.equal(f.page.data.loading, false)
  assert.equal(f.page.data.savingCommunity, false)
  finish({ pets: [], userCommunity: { name: '旧小区' } })
  await refresh
  assert.equal(f.page.data.userCommunity, null)
})

test('a delayed login failure cannot redirect after the entry page is hidden', async () => {
  let fail
  const f = fixture(() => ({}), () => new Promise((resolve, reject) => { fail = reject }))
  f.page.onShow()
  f.page.onHide()
  fail(new Error('登录取消'))
  await flush()
  assert.equal(f.navigation.length, 0)
  assert.equal(f.calls.length, 0)
})
