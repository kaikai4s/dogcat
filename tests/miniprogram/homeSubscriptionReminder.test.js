const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '../../miniprogram')
const options = require('../../miniprogram/utils/subscription-options')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(role = 'client') {
  let page
  let finishWechat
  let fresh = { subscription: { enabled: true, templates: { staffDirectOrder: 'direct', upcomingServiceReminder: 'upcoming', serviceFinish: 'finish', refundResult: 'refund', disputeUpdate: 'reserved' } } }
  const navigation = []
  const wx = {
    getSetting: config => { finishWechat = config.success },
    requestSubscribeMessage() { assert.fail('showing the homepage must not request consent') },
    navigateTo: config => navigation.push(config.url)
  }
  const deps = { getCachedSystemSettings: () => fresh, loadSystemSettings: async () => fresh, loadMessageUnread() {} }
  const helper = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/home-subscription-reminder.js'), 'utf8'), {
    module: helper, wx,
    require: name => name.endsWith('/subscription-options') ? options : deps
  })
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${role}/home/index.js`), 'utf8'), {
    Page(config) { page = config }, wx, clearTimeout,
    getCurrentPages: () => [{ route: `pages/${role}/home/index` }],
    require: name => name.endsWith('/home-subscription-reminder') ? helper.exports : deps
  })
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  for (const method of ['applyCurrentTheme', 'applySavedLocation', 'loadHeroCarousel', 'loadHomePageData', 'loadStaffEntryState', 'initStaffHome']) page[method] = () => {}
  page._heroRestored = true
  return { page, navigation, wechat: value => finishWechat({ subscriptionsSetting: value }), settings: value => { fresh = value } }
}

test('both home pages render native reminder views without a custom-component dependency', () => {
  for (const role of ['client', 'staff']) {
    const config = JSON.parse(fs.readFileSync(path.join(root, `pages/${role}/home/index.json`), 'utf8'))
    assert.equal(config.usingComponents && config.usingComponents['subscription-reminder'], undefined)
    const view = fs.readFileSync(path.join(root, `pages/${role}/home/index.wxml`), 'utf8')
    assert.doesNotMatch(view, /<subscription-reminder\b/)
    assert.match(view, new RegExp(`<view class="subscription-entry" bindtap="go" data-url="/pages/common/subscriptions/index\\?role=${role}"`))
    assert.match(view, /{{subscriptionReminder.description}}/)
  }
})

test('homepage reminder uses the same role catalog, ignores reserved templates and never invokes native consent on show', async () => {
  for (const [role, count] of [['client', 2], ['staff', 3]]) {
    const ctx = setup(role)
    assert.ok(ctx.page.data.subscriptionReminder.description, 'initial render has readable text before any data request')
    ctx.page.onShow()
    await flush()
    assert.match(ctx.page.data.subscriptionReminder.description, new RegExp(`${count} 项`))
    ctx.page.go({ currentTarget: { dataset: { url: `/pages/common/subscriptions/index?role=${role}` } } })
    assert.equal(ctx.navigation[0], `/pages/common/subscriptions/index?role=${role}`)
  }
})

test('returning to homepage refreshes the switch and template configuration without hiding the reminder', async () => {
  const ctx = setup()
  ctx.page.onShow()
  await flush()
  ctx.wechat({ mainSwitch: false })
  assert.equal(ctx.page.data.subscriptionReminder.actionText, '去开启')
  assert.match(ctx.page.data.subscriptionReminder.description, /已关闭/)
  ctx.page.onShow()
  await flush()
  ctx.wechat({ mainSwitch: true, itemsSetting: { finish: 'accept', refund: 'accept' } })
  assert.equal(ctx.page.data.subscriptionReminder.actionText, '管理订阅')
  ctx.settings({ subscription: { enabled: true, templates: { refundResult: 'new-refund' } } })
  ctx.page.onShow()
  await flush()
  assert.equal(ctx.page.data.subscriptionReminder.actionText, '去订阅')
  assert.match(ctx.page.data.subscriptionReminder.description, /1 项/)
  ctx.settings({ subscription: { enabled: true, templates: {} } })
  ctx.page.onShow()
  await flush()
  assert.match(ctx.page.data.subscriptionReminder.description, /尚未配置/)
})

test('a hidden homepage ignores late permission reads', async () => {
  for (const role of ['client', 'staff']) {
    for (const lifecycle of ['onHide', 'onUnload']) {
      const ctx = setup(role)
      ctx.page.onShow()
      const description = ctx.page.data.subscriptionReminder.description
      ctx.page[lifecycle]()
      ctx.wechat({ mainSwitch: false })
      await flush()
      assert.equal(ctx.page.data.subscriptionReminder.description, description)
    }
  }
})
