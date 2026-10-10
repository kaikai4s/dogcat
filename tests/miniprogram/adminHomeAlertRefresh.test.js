const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function setup() {
  let page, stopped = 0
  const requests = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({
      callFunction: (module, action) => new Promise((resolve, reject) => requests.push({ action, resolve, reject })),
      showError() {}, can: access => access !== false, canVisit: () => true
    }),
    wx: { stopPullDownRefresh: () => { stopped++ } }
  })
  page.setData = patch => Object.assign(page.data, patch)
  return { page, requests, stopped: () => stopped }
}
const answer = (requests, notice = null) => requests.forEach(r => r.resolve(r.action === 'dashboard' ? { orders: {} } : { unreadCount: notice ? 1 : 0, latestUrgent: notice }))

test('returning after completion refreshes and clears alert; pre-navigation response cannot restore it', async () => {
  const { page, requests } = setup()
  const first = page.onShow()
  page.onHide()
  const second = page.onShow()
  answer(requests.slice(2))
  await second
  answer(requests.slice(0, 2), { orderId: 'completed_order' })
  await first
  assert.equal(page.data.urgentNotice, null)
  assert.equal(page.data.unreadNotificationCount, 0)
})

test('pull-to-refresh clears previous alert and waits for both queries', async () => {
  const { page, requests, stopped } = setup()
  page.setData({ urgentNotice: { orderId: 'old' }, unreadNotificationCount: 1 })
  const pending = page.onPullDownRefresh()
  assert.equal(page.data.urgentNotice, null)
  assert.equal(page.data.unreadNotificationCount, 0)
  assert.equal(stopped(), 0)
  answer(requests)
  await pending
  assert.equal(stopped(), 1)
})

test('failed refresh and late hidden-page responses cannot resurrect old alerts', async () => {
  const { page, requests } = setup()
  page.setData({ urgentNotice: { orderId: 'old' }, unreadNotificationCount: 1 })
  const pending = page.onShow()
  requests.forEach(r => r.reject(new Error('offline')))
  await pending
  assert.equal(page.data.urgentNotice, null)
  const late = page.loadNotifications()
  page.onUnload()
  requests.at(-1).resolve({ unreadCount: 1, latestUrgent: { orderId: 'old' } })
  await late
  assert.equal(page.data.urgentNotice, null)
})

test('permission loss invalidates pending privileged responses', async () => {
  const { page, requests } = setup()
  const pending = page.onShow()
  page.data.adminAccess = false
  await page.onShow()
  answer(requests, { orderId: 'old' })
  await pending
  assert.equal(page.data.urgentNotice, null)
  assert.equal(page.data.dashboard, null)
})

test('opening resolved history does not decrement other pending notification counts', () => {
  let page
  const home = { route: 'pages/admin/home/index', data: { unreadNotificationCount: 2 }, setData(patch) { Object.assign(this.data, patch) } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/notifications/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({ callFunction: () => Promise.resolve() }),
    getCurrentPages: () => [home], wx: { navigateTo() {} }
  })
  page.setData = patch => Object.assign(page.data, patch)
  const item = { _id: 'old', orderId: 'completed', isRead: false, isResolved: true }
  page.setData({ list: [item], unreadCount: 2 })
  page.tapItem({ currentTarget: { dataset: { item } } })
  assert.equal(page.data.unreadCount, 2)
  assert.equal(home.data.unreadNotificationCount, 2)
  assert.equal(page.data.list[0].isRead, true)
})
