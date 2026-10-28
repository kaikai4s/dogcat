const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))

function pageFrom(file, dependencies, wx = {}) {
  let page
  vm.runInNewContext(read(file), {
    Page(config) { page = config }, wx, console, setTimeout, clearTimeout,
    require(name) {
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (name.endsWith('/format')) return require(path.join(root, 'utils/format.js'))
      if (name.endsWith('/clipboard')) return { copyText() {} }
      if (name.endsWith('/nav')) return { createPageNav: () => ({}), navMethods: () => ({}) }
      return dependencies
    }
  })
  page.setData = function (values, callback) { Object.assign(this.data, values); if (callback) callback() }
  return page
}

test('booking maintenance skips login and data loading, shows a dedicated screen', async () => {
  let logins = 0
  const page = pageFrom('pages/client/orders/create/index.js', {
    getCachedSystemSettings: () => ({ maintenance: { booking: true } }),
    loadSystemSettings: async () => ({ maintenance: { booking: true } }),
    ensureLogin: async () => { logins++; return {} }
  })
  page.applyCurrentTheme = () => {}
  page.consumeSelectedCoupon = () => {}
  page.updateMinTime = () => {}
  page.loadPageData = () => assert.fail('maintenance must skip data loading')
  await page.onShow()
  assert.equal(page.data.bookingMaintenance, true)
  assert.equal(page.data.maintenanceLoading, false)
  assert.equal(logins, 0)
  assert.match(read('pages/client/orders/create/index.wxml'), /预约下单功能暂时不可使用，正在维护中/)
})

test('home blocks direct booking and ranking entries when the respective flag is active', () => {
  const messages = []
  const page = pageFrom('pages/client/home/index.js', {}, { showModal: options => messages.push(options.content) })
  page.setData({ maintenance: { booking: true, petRanking: true } })
  page.goProtected({ currentTarget: { dataset: { url: '/pages/client/orders/create/index?serviceType=feed' } } })
  page.go({ currentTarget: { dataset: { url: '/pages/client/pet-beauty/activity/index' } } })
  assert.equal(page.data.protectedNavigationUrl, '')
  assert.deepEqual(messages, ['预约下单功能暂时不可使用，正在维护中', '宠物排行榜功能暂时不可使用，正在维护中'])
})

test('ranking maintenance skips ranking reads and shows its unavailable state', async () => {
  const calls = []
  const page = pageFrom('pages/client/pet-beauty/activity/index.js', {
    loadSystemSettings: async () => ({ maintenance: { petRanking: true } }),
    callFunction: (_, action) => { calls.push(action); return Promise.resolve({}) }
  }, { setNavigationBarTitle() {} })
  await page.onShow()
  assert.equal(page.data.rankingMaintenance, true)
  assert.deepEqual(calls, [])
  assert.match(read('pages/client/pet-beauty/activity/index.wxml'), /宠物排行榜功能暂时不可使用，正在维护中/)
})

test('invitation maintenance preserves asset history and withdrawal while blocking binding and referral sharing', async () => {
  const calls = []
  const page = pageFrom('pages/client/profile/assets/index.js', {
    getCachedSystemSettings: () => ({ maintenance: { invitation: true } }),
    loadSystemSettings: async () => ({ maintenance: { invitation: true } }),
    ensureLogin: async () => ({ _id: 'client' }),
    savePendingInvite() {},
    callFunction: async (_, action) => {
      calls.push(action)
      if (action === 'getUserAssetSummary') return { inviteCode: 'MYCODE', availableAmount: 42, withdraws: [{ _id: 'w1', amount: 12 }], earnings: [{ _id: 'e1' }] }
    }
  }, { stopPullDownRefresh() {} })
  page.onLoad({ inviteCode: 'FRIEND' })
  page.onShow()
  await flush()
  await flush()
  assert.equal(page.data.invitationMaintenance, true)
  assert.equal(page.data.summary.availableAmount, 42)
  assert.equal(page.data.summary.withdraws.length, 1)
  assert.equal(page.data.summary.earnings.length, 1)
  assert.deepEqual(calls, ['getUserAssetSummary'])
  assert.equal(page.onShareAppMessage().path, '/pages/client/profile/assets/index')
  await page.bindInvite()
  assert.deepEqual(calls, ['getUserAssetSummary'])
  const view = read('pages/client/profile/assets/index.wxml')
  assert.match(view, /分享赚取佣金功能暂时不可使用，正在维护中/)
  assert.match(view, /bindtap="withdraw"/)
})
