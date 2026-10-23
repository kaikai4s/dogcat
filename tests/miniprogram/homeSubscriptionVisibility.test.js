const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '../../miniprogram')

test('both home pages omit subscription prompts while message pages retain the management entry', () => {
  for (const role of ['client', 'staff']) {
    const home = fs.readFileSync(path.join(root, `pages/${role}/home/index.wxml`), 'utf8')
    assert.doesNotMatch(home, /subscription-entry|subscription-reminder|subscriptionReminder|common\/subscriptions/)
    const messages = fs.readFileSync(path.join(root, `pages/${role}/messages/index.wxml`), 'utf8')
    assert.ok(messages.includes(`/pages/common/subscriptions/index?role=${role}`))
  }
})

test('entering and refreshing home does not query subscription permissions or request authorization', async () => {
  for (const role of ['client', 'staff']) {
    let page
    const calls = []
    const deps = { loadSystemSettings: async () => ({}), loadMessageUnread() {}, startStaffEntryUnread() {}, stopStaffEntryUnread() {} }
    vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${role}/home/index.js`), 'utf8'), {
      Page(config) { page = config }, require: () => deps, clearTimeout,
      wx: {
        getSetting() { assert.fail('home must not read subscription permissions') },
        requestSubscribeMessage() { assert.fail('home must not request subscription consent') },
        stopPullDownRefresh() { calls.push('refresh-finished') }
      }
    })
    page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
    for (const method of ['applyCurrentTheme', 'applySavedLocation', 'loadHeroCarousel', 'loadHomePageData', 'loadStaffEntryState', 'initStaffHome']) {
      page[method] = () => { calls.push(method); return Promise.resolve() }
    }
    page._heroRestored = true
    page.onShow()
    page.onShow()
    if (page.onPullDownRefresh) await page.onPullDownRefresh()
    assert.equal(page.data.subscriptionReminder, undefined)
    assert.ok(calls.includes(role === 'client' ? 'loadHeroCarousel' : 'initStaffHome'))
    if (role === 'client') assert.ok(calls.includes('refresh-finished'))
  }
})
