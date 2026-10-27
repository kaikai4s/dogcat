const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setup() {
  let page
  const requests = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({
      callFunction: (module, action, data) => new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })),
      showError() {},
      can: () => true,
      canVisit: () => true
    }),
    wx: { stopPullDownRefresh: () => {} }
  })
  page.setData = patch => Object.assign(page.data, patch)
  return { page, requests }
}

test('admin home: 初始化与加载阶段 dashboardLoading 为 true，请求返回后变为 false', async () => {
  const { page, requests } = setup()

  // 初始状态
  assert.equal(page.data.dashboardLoading, true, '初始时 dashboardLoading 应为 true')
  assert.equal(page.data.dashboard, null, '初始时 dashboard 应为 null')

  // 调用 onShow 触发刷新
  const refreshPromise = page.onShow()
  assert.equal(page.data.dashboardLoading, true, '刷新开始时 dashboardLoading 应为 true')
  assert.equal(page.data.dashboard, null, '数据未返回前 dashboard 应为 null')

  // 模拟请求成功返回
  const dashboardReq = requests.find(r => r.action === 'dashboard')
  assert.ok(dashboardReq, '应发起 dashboard 请求')
  dashboardReq.resolve({
    orders: { paid: 2, in_service: 1 },
    monthly: { totals: { orders: 44, registrations: 8, revenue: 471.1 } }
  })

  // 响应其他伴随请求
  requests.filter(r => r.action !== 'dashboard').forEach(r => r.resolve({}))

  await refreshPromise

  // 请求返回后
  assert.equal(page.data.dashboardLoading, false, '数据加载完成后 dashboardLoading 应变为 false')
  assert.ok(page.data.dashboard, 'dashboard 数据应已填充')
})

test('admin home: 接口报错时 dashboardLoading 能够正确置为 false，避免骨架屏永久卡死', async () => {
  const { page, requests } = setup()

  const refreshPromise = page.onShow()
  const dashboardReq = requests.find(r => r.action === 'dashboard')
  dashboardReq.reject(new Error('网络超时'))
  requests.filter(r => r.action !== 'dashboard').forEach(r => r.resolve({}))

  await refreshPromise.catch(() => {})

  assert.equal(page.data.dashboardLoading, false, '异常时 dashboardLoading 应置为 false')
})

test('admin home WXML/WXSS: 包含 6 宫格、趋势卡片、收入分析的高保真骨架屏与流光动画', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.wxss'), 'utf8')

  // WXML
  assert.ok(wxml.includes('wx:if="{{dashboardLoading && !dashboard}}"'), '应在加载中且无数据时展示骨架屏')
  assert.ok(wxml.includes('skeleton-stats-grid'), '应包含 6 宫格骨架')
  assert.ok(wxml.includes('skeleton-panel-card'), '应包含面板卡片骨架')
  assert.ok(wxml.includes('skeleton-chart-box'), '应包含柱状图柱体骨架')
  assert.ok(wxml.includes('skeleton-shimmer'), '应应用全局微光动画类')

  // WXSS
  assert.ok(wxss.includes('.skeleton-stat-card'), '应包含 6 宫格单卡样式')
  assert.ok(wxss.includes('.skeleton-chart-box'), '应包含图表高度锁定样式')
  assert.ok(wxss.includes('.skeleton-revenue-stat'), '应包含收入分析骨架样式')
})
