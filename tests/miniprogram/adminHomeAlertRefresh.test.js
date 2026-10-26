const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function setup(access) {
  let page, stopped = 0
  const requests = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({
      callFunction: (module, action, data) => new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })),
      showError() {}, ...(access ? require('../../miniprogram/utils/adminAccess') : { can: access => access !== false, canVisit: () => true })
    }),
    wx: { stopPullDownRefresh: () => { stopped++ } }
  })
  page.setData = patch => Object.assign(page.data, patch)
  if (access) page.data.adminAccess = access
  return { page, requests, stopped: () => stopped }
}
const answer = (requests, notice = null) => requests.forEach(r => r.resolve(r.action === 'dashboard' ? { orders: {} } : { unreadCount: notice ? 1 : 0, latestUrgent: notice }))

test('returning after completion refreshes and clears alert; pre-navigation response cannot restore it', async () => {
  const { page, requests } = setup()
  const first = page.onShow()
  const firstBatch = requests.length
  page.onHide()
  const second = page.onShow()
  answer(requests.slice(firstBatch))
  await second
  answer(requests.slice(0, firstBatch), { orderId: 'completed_order' })
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
    require: name => name.endsWith('/adminAccess') ? require('../../miniprogram/utils/adminAccess') : ({ callFunction: () => Promise.resolve() }),
    getCurrentPages: () => [home], wx: { navigateTo() {} }
  })
  page.setData = patch => Object.assign(page.data, patch)
  const item = { _id: 'old', orderId: 'completed', isRead: false, isResolved: true }
  page.setData({ list: [item], unreadCount: 2, adminAccess: { superAdmin: true } })
  page.tapItem({ currentTarget: { dataset: { item } } })
  assert.equal(page.data.unreadCount, 2)
  assert.equal(home.data.unreadNotificationCount, 2)
  assert.equal(page.data.list[0].isRead, true)
})

test('urgent banner distinguishes dispatch alerts from finish alerts and unrelated notifications', async () => {
  for (const [type, actionText, tip] of [
    ['order_start_overdue', '去调度', '宠托师超时未到场'],
    ['order_finish_overdue', '去查看', '服务超时未完成'],
    ['order_urgent_republished', '去调度', '订单已转加急公共单'],
    ['refund_failure', '去查看', '点击查看通知详情']
  ]) {
    const { page, requests } = setup()
    const pending = page.loadNotifications()
    answer(requests, { type, orderId: 'order' })
    await pending
    assert.equal(page.data.urgentNotice.actionText, actionText)
    assert.ok(page.data.urgentNotice.tip.includes(tip))
  }
})

test('resolved payload cannot display an actionable home banner', async () => {
  const { page, requests } = setup()
  const pending = page.loadNotifications()
  answer(requests, { type: 'order_finish_overdue', isResolved: true })
  await pending
  assert.equal(page.data.urgentNotice, null)
})

test('order formatter suppresses terminal warnings without changing stored history', () => {
  const { withOrderText } = require('../../miniprogram/utils/format')
  for (const status of ['completed', 'auto_completed', 'cancelled', 'refunded', 'closed', 'expired', 'timeout_closed']) {
    const order = { status, isOverdue: true, isStartOverdue: true, isFinishOverdue: true, finishOverdueIncidentCreated: true }
    const display = withOrderText(order)
    assert.equal(display.isOverdue, false, status)
    assert.equal(display.isStartOverdue, false, status)
    assert.equal(display.isFinishOverdue, false, status)
    assert.equal(display.finishOverdueIncidentCreated, true)
    assert.equal(order.isOverdue, true)
  }
  assert.equal(withOrderText({ status: 'in_service', isFinishOverdue: true }).isOverdue, true)
})

test('appearance customization entry shows outstanding count and clears it after processing', async () => {
  const { page, requests } = setup()
  for (const count of [3, 0]) {
    const pending = page.onShow()
    for (const request of requests.splice(0)) request.resolve(request.action === 'dashboard'
      ? { pendingReviews: { playgroundCustomizations: count } } : {})
    await pending
    const entry = page.data.adminSections.flatMap(section => section.items).find(item => item.url === '/pages/admin/playground-customizations/index')
    assert.equal(entry.pendingCount, count)
  }
})

const badge = (page, route) => page.data.adminSections.flatMap(group => group.items).find(item => item.url === `/pages/admin/${route}/index`)?.pendingCount

test('community-only permission loads its own count without dashboard or notification access', async () => {
  const { page, requests } = setup({ permissions: ['communityMap.listAdmin'] })
  const pending = page.onShow()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].module, 'communityMap'); assert.equal(requests[0].action, 'listAdmin')
  assert.equal(requests[0].data.pendingCountsOnly, true)
  requests[0].resolve({ pendingApplicationCount: 6 }); await pending
  assert.equal(badge(page, 'community-map'), 6)
  assert.equal(page.data.dashboard, null); assert.equal(page.data.unreadNotificationCount, 0)
})

test('dashboard, mall and community responses preserve both badges in every completion order', async () => {
  for (const order of [['communityMap', 'adminMall', 'admin'], ['adminMall', 'admin', 'communityMap'],
    ['admin', 'communityMap', 'adminMall'], ['admin', 'adminMall', 'communityMap'],
    ['communityMap', 'admin', 'adminMall'], ['adminMall', 'communityMap', 'admin']]) {
    const { page, requests } = setup({ permissions: ['communityMap.listAdmin', 'adminMall.listOrders', 'admin.dashboard'] })
    const pending = page.onShow()
    for (const module of order) {
      requests.find(r => r.module === module).resolve(module === 'communityMap' ? { pendingApplicationCount: 4 }
        : module === 'adminMall' ? { pendingCount: 7 } : { pendingReviews: { mallOrders: 99, communityApplications: 99 } })
      await Promise.resolve(); await Promise.resolve()
      if (module === 'communityMap' || page.data.communityPendingCount !== null) assert.equal(badge(page, 'community-map'), 4)
      if (module === 'adminMall' || page.data.mallPendingCount !== null) assert.equal(badge(page, 'mall/orders'), 7)
    }
    await pending
    assert.equal(badge(page, 'community-map'), 4); assert.equal(badge(page, 'mall/orders'), 7)
    assert.equal(page.data.unreadNotificationCount, 0)
  }
})

test('community count refresh, hide, unload and permission loss fence stale responses', async () => {
  for (const invalidate of ['refresh', 'onHide', 'onUnload', 'permission']) {
    const { page, requests } = setup({ permissions: ['communityMap.listAdmin'] })
    const old = page.onShow()
    if (invalidate === 'refresh') {
      const fresh = page.refreshHome()
      requests[1].resolve({ pendingApplicationCount: 2 }); await fresh
    } else if (invalidate === 'permission') {
      page.data.adminAccess = { permissions: [] }; await page.refreshHome()
    } else page[invalidate]()
    requests[0].resolve({ pendingApplicationCount: 99 }); await old
    assert.equal(page.data.communityPendingCount, invalidate === 'refresh' ? 2 : null)
    assert.notEqual(badge(page, 'community-map'), 99)
  }
})

test('community request sequences do not invalidate mall queries and stale errors stay silent', async () => {
  const { page, requests } = setup({ permissions: ['communityMap.listAdmin', 'adminMall.listOrders'] })
  const pending = page.onShow()
  const current = page.loadCommunityPending()
  requests[2].resolve({ pendingApplicationCount: 0 }); await current
  requests[0].resolve({ pendingCount: 8 }); requests[1].reject(new Error('stale')); await pending
  assert.equal(badge(page, 'community-map'), 0); assert.equal(badge(page, 'mall/orders'), 8)
})

test('mall-only administrator sees pending mall order badge without the dashboard permission', async () => {
  let page
  const accessHelpers = require('../../miniprogram/utils/adminAccess')
  const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({ ...accessHelpers, showError: error => assert.fail(error.message), callFunction: async (module, action, data) => {
      calls.push({ module, action, data })
      assert.equal(module, 'adminMall')
      assert.equal(action, 'listOrders')
      assert.equal(data.pendingCountsOnly, true)
      return { pendingCount: 7 }
    } }), wx: {}
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.data.adminAccess = { superAdmin: false, permissions: ['adminMall.listOrders'] }
  await page.onShow()
  assert.equal(calls.length, 1)
  const entry = page.data.adminSections.flatMap(group => group.items).find(item => item.url === '/pages/admin/mall/orders/index')
  assert.equal(entry.pendingCount, 7)
})
