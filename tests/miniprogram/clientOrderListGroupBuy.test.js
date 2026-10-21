const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { withOrderText } = require('../../miniprogram/utils/format')

function pageAt(relativePath, bindings = {}) {
  const file = path.resolve(__dirname, '../../miniprogram', relativePath)
  const localRequire = createRequire(file)
  let pageOptions = null
  const storage = bindings.storage || new Map()
  let navigatedUrl = ''

  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    showToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    navigateTo: (opts) => { navigatedUrl = opts.url },
    redirectTo: (opts) => { navigatedUrl = opts.url },
    pageScrollTo: () => {},
    ...bindings.wx
  }

  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(options) {
      pageOptions = options
    },
    require(name) {
      if (name.endsWith('/cloud')) {
        return {
          getCurrentUser: bindings.getCurrentUser || (async () => ({ openid: 'u1' })),
          callFunction: bindings.callFunction || (async () => ({ list: [], total: 0 })),
          showError: () => {},
          ensureLogin: async () => ({})
        }
      }
      if (name.endsWith('/theme')) {
        return {
          applyTheme: () => ({ value: 'day' }),
          getThemeState: () => ({ themeClass: 'theme-day' })
        }
      }
      if (name.endsWith('/client-nav')) {
        return {
          loadMessageUnread: () => {}
        }
      }
      return localRequire(name)
    },
    wx,
    getApp: () => ({ globalData: {} }),
    clearTimeout,
    setTimeout
  })

  const page = {
    ...pageOptions,
    data: JSON.parse(JSON.stringify(pageOptions.data))
  }

  page.setData = function (patch, cb) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) {
        if (!target[part]) target[part] = {}
        target = target[part]
      }
      target[parts[parts.length - 1]] = value
    }
    if (typeof cb === 'function') cb()
  }

  return { page, getNavigatedUrl: () => navigatedUrl }
}

test('同小区拼单订单格式化: withOrderText 附带拼单标记与进度文案', () => {
  // 1. 普通订单无拼单标记
  const normalOrder = withOrderText({ status: 'paid', serviceSummary: '上门喂养' })
  assert.equal(normalOrder.isGroupBuy, false)
  assert.equal(normalOrder.statusText, '待附近宠托师接单')

  // 2. 招募中拼单订单
  const recruitingOrder = withOrderText({
    status: 'paid',
    source: 'community_groupbuy',
    groupBuyId: 'gb_100',
    groupBuyStatus: 'recruiting',
    serviceSummary: '上门遛狗'
  })
  assert.equal(recruitingOrder.isGroupBuy, true)
  assert.equal(recruitingOrder.statusText, '拼单招募中')
  assert.equal(recruitingOrder.groupBuyTagText, '同小区拼单')
  assert.match(recruitingOrder.groupBuyProgressText, /招募中/)

  // 3. 已成团拼单订单
  const formedOrder = withOrderText({
    status: 'paid',
    source: 'community_groupbuy',
    groupBuyId: 'gb_100',
    groupBuyStatus: 'formed',
    serviceSummary: '上门喂猫'
  })
  assert.equal(formedOrder.isGroupBuy, true)
  assert.equal(formedOrder.statusText, '已成团·待派单')
  assert.match(formedOrder.groupBuyProgressText, /已成团/)
})

test('订单列表 WXML 与 WXSS: 包含同小区拼单专属标签、进度行与详情操作', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/list/index.wxml'), 'utf8')
  assert.match(wxml, /group-buy-order-badge/)
  assert.match(wxml, /badge-group-recruiting/)
  assert.match(wxml, /badge-group-formed/)
  assert.match(wxml, /group-buy-card-footer/)
  assert.match(wxml, /openGroupBuyDetail/)

  const wxss = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/list/index.wxss'), 'utf8')
  assert.match(wxss, /\.group-buy-order-badge/)
  assert.match(wxss, /\.badge\.badge-group-recruiting/)
  assert.match(wxss, /\.group-buy-card-footer/)
  assert.match(wxss, /\.group-buy-detail-link/)
})

test('订单列表页面交互: 正确展示拼单订单并在点击拼单详情时跳转', async () => {
  const mockOrders = [
    {
      _id: 'ord_gb_1',
      status: 'paid',
      source: 'community_groupbuy',
      groupBuyId: 'group_999',
      groupBuyStatus: 'recruiting',
      serviceSummary: '上门遛狗',
      petName: '大黄',
      payAmount: 68
    },
    {
      _id: 'ord_norm_2',
      status: 'paid',
      serviceSummary: '上门喂养',
      petName: '咪咪',
      payAmount: 89
    }
  ]

  const { page, getNavigatedUrl } = pageAt('pages/client/orders/list/index.js', {
    callFunction: async () => ({ list: mockOrders, total: 2 })
  })

  await page.load({ reset: true })

  // 验证两笔订单均正确呈现在用户的订单列表中
  assert.equal(page.data.orders.length, 2)
  const gbOrder = page.data.orders.find((o) => o._id === 'ord_gb_1')
  const normOrder = page.data.orders.find((o) => o._id === 'ord_norm_2')

  assert.ok(gbOrder, '拼单订单必须出现在自己的订单列表')
  assert.equal(gbOrder.isGroupBuy, true)
  assert.equal(gbOrder.statusText, '拼单招募中')

  assert.ok(normOrder, '普通订单正常存在')
  assert.equal(normOrder.isGroupBuy, false)

  // 点击拼单详情入口
  page.openGroupBuyDetail({ currentTarget: { dataset: { groupId: 'group_999' } } })
  assert.equal(getNavigatedUrl(), '/pages/client/orders/group-buy/index?groupId=group_999')
})
