const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { ENV_MAP, hasManorAssets } = require('../../miniprogram/envList')
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(respond, login = async () => {}, envVersion = 'develop') {
  let definition
  const calls = [], navigation = [], toasts = [], errors = [], loading = []
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packagePlayground/pages/index.js'), 'utf8'), {
    Page(value) { definition = value }, require(path) {
      if (path === '../../envList') return { getActiveEnvId: () => ENV_MAP[envVersion], hasManorAssets }
      assert.equal(path, '../../utils/cloud')
      return {
        callFunction: async (module, action, data) => { calls.push({ action, data }); return respond(action, data) },
        ensureLogin: login, showError: error => errors.push(error)
      }
    }, wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      navigateTo: value => navigation.push(value), redirectTo: value => navigation.push(value),
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

test('the experience version offers 3D without a community and preserves the 2D community prompt', async () => {
  const { page, navigation, toasts } = fixture(() => ({ pets: [], hasCommunity: false }), undefined, 'trial')
  page.onLoad()
  page.openManor3d()
  assert.equal(navigation.length, 0)
  await page.load()
  page.openWorld()
  assert.equal(page.data.showCommunityModal, true)
  assert.equal(navigation.length, 0)
  page.closeCommunityModal()
  page.openManor3d()
  page.openManor3d()
  assert.equal(navigation.length, 1)
  assert.equal(navigation[0].url, '/packageManor3d/pages/index')
  navigation[0].fail()
  navigation[0].complete()
  assert.equal(toasts[0].title, '暂时无法打开 3D 庄园')
  page.openManor3d()
  assert.equal(navigation.length, 2)
})

test('the release version only offers the existing route while its 3D cloud files are unconfirmed', async () => {
  const { page, navigation } = fixture(() => ({ pets: [], hasCommunity: true }), undefined, 'release')
  page.onLoad()
  await page.load()
  assert.equal(page.data.showManor3d, false)
  page.openManor3d()
  assert.equal(navigation.length, 0)
  page.openWorld()
  assert.equal(navigation[0].url, '/packagePlayground/pages/world')
})
