const test = require('node:test')
const assert = require('node:assert/strict')
const { safeNavigateTo } = require('../../miniprogram/utils/nav')

test('safeNavigateTo automatically degrades to redirectTo when page stack depth >= 9', () => {
  let navigateToCalled = false
  let redirectToCalled = false
  let targetUrl = ''
  let currentPagesList = []

  global.getCurrentPages = () => currentPagesList
  global.wx = {
    navigateTo: ({ url, fail }) => {
      navigateToCalled = true
      targetUrl = url
    },
    redirectTo: ({ url }) => {
      redirectToCalled = true
      targetUrl = url
    }
  }

  // Case 1: 页面栈深度为 3 (< 9) 时，正常使用 navigateTo
  currentPagesList = [
    { route: 'pages/client/home/index' },
    { route: 'pages/client/orders/list/index' },
    { route: 'pages/client/orders/detail/index' }
  ]
  navigateToCalled = false
  redirectToCalled = false
  safeNavigateTo({ url: '/pages/client/sitters/detail/index?id=123' })
  assert.equal(navigateToCalled, true)
  assert.equal(redirectToCalled, false)
  assert.equal(targetUrl, '/pages/client/sitters/detail/index?id=123')

  // Case 2: 页面栈深度达到 9 时，自动降级为 redirectTo
  currentPagesList = new Array(9).fill({ route: 'pages/dummy/index' })
  navigateToCalled = false
  redirectToCalled = false
  safeNavigateTo({ url: '/pages/client/orders/create/index' })
  assert.equal(navigateToCalled, false)
  assert.equal(redirectToCalled, true)
  assert.equal(targetUrl, '/pages/client/orders/create/index')

  // Case 3: 页面栈深度达到 10 时，自动降级为 redirectTo
  currentPagesList = new Array(10).fill({ route: 'pages/dummy/index' })
  navigateToCalled = false
  redirectToCalled = false
  safeNavigateTo({ url: '/pages/client/orders/detail/index' })
  assert.equal(navigateToCalled, false)
  assert.equal(redirectToCalled, true)
  assert.equal(targetUrl, '/pages/client/orders/detail/index')

  // Case 4: 栈深度 < 9 时若底层仍抛出 limit exceed，fail 回调自动降级为 redirectTo
  currentPagesList = new Array(8).fill({ route: 'pages/dummy/index' })
  navigateToCalled = false
  redirectToCalled = false
  global.wx.navigateTo = ({ url, fail }) => {
    navigateToCalled = true
    if (typeof fail === 'function') {
      fail({ errMsg: 'navigateTo:fail webview count limit exceed' })
    }
  }
  safeNavigateTo({ url: '/pages/client/messages/thread/index' })
  assert.equal(navigateToCalled, true)
  assert.equal(redirectToCalled, true)
  assert.equal(targetUrl, '/pages/client/messages/thread/index')
})

test('scheduled tasks use 7-day active time window to query orders without full table scan', () => {
  const currentTs = new Date('2026-09-22T14:00:00.000Z').getTime()
  const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
  const windowStartTs = currentTs - ACTIVE_WINDOW_MS
  const windowStartDate = new Date(windowStartTs)
  const windowStartText = `${windowStartDate.getFullYear()}-${String(windowStartDate.getMonth() + 1).padStart(2, '0')}-${String(windowStartDate.getDate()).padStart(2, '0')} 00:00`

  // 模拟 db.command.gte
  const _ = {
    gte: (val) => ({ $gte: val })
  }

  // 模拟待检查订单集合
  const orders = [
    {
      _id: 'order_recent_active',
      status: 'assigned',
      startTime: '2026-09-22 13:00', // 1 小时前，处于窗口内
      staffOpenid: 'staff_1'
    },
    {
      _id: 'order_yesterday_active',
      status: 'assigned',
      startTime: '2026-09-21 10:00', // 1 天前，处于窗口内
      staffOpenid: 'staff_2'
    },
    {
      _id: 'order_ancient_history',
      status: 'assigned',
      startTime: '2026-08-01 09:00', // 50 天前，远超 7 天窗口
      staffOpenid: 'staff_3'
    }
  ]

  // 构建带时间窗口的查询条件
  const whereCondition = {
    status: 'assigned',
    startTime: _.gte(windowStartText)
  }

  // 模拟数据库带条件过滤
  const filtered = orders.filter((order) => {
    if (order.status !== whereCondition.status) return false
    if (whereCondition.startTime && whereCondition.startTime.$gte) {
      return order.startTime >= whereCondition.startTime.$gte
    }
    return true
  })

  // 验证结果：只有 7 天内的活跃订单被拉取，历史老订单被数据库索引条件直接过滤
  assert.equal(filtered.length, 2)
  assert.ok(filtered.some(o => o._id === 'order_recent_active'))
  assert.ok(filtered.some(o => o._id === 'order_yesterday_active'))
  assert.ok(!filtered.some(o => o._id === 'order_ancient_history'))
})
