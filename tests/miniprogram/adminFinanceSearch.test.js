const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const access = require('../../miniprogram/utils/adminAccess')

function setup(permissions, respond = async () => []) {
  const calls = [], errors = []
  const cloud = {
    callFunction: async (module, action, data) => {
      calls.push({ module, action, data })
      return respond(action, data)
    },
    showError: (error) => errors.push(error.message)
  }
  const helper = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/utils/admin-page-read.js'), 'utf8'), {
    module: helper,
    require: (name) => name.endsWith('/cloud') ? cloud : access
  })
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8'), {
    Page: (value) => { page = value },
    wx: {
      showToast() {},
      showLoading() {},
      hideLoading() {},
      stopPullDownRefresh() {}
    },
    require(name) {
      if (name.endsWith('/adminAccess')) return access
      if (name.endsWith('/admin-page-read')) return helper.exports
      if (name.endsWith('/cloud')) return cloud
      if (name.endsWith('/nav')) return { navMethods: () => ({}), createPageNav: () => ({}) }
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      return {}
    }
  })
  page.setData = (patch, callback) => {
    Object.assign(page.data, patch)
    if (callback) callback.call(page)
  }
  page.setData({ adminAccess: { superAdmin: true, permissions } })
  return { page, calls, errors }
}

test('admin finance page search: keyword input, submit, clear and query parameter passing', async () => {
  const allPermissions = [
    'admin.listWithdrawRequests', 'admin.listStaffDeposits', 'admin.listSupplyReimbursements',
    'admin.listPayments', 'admin.listRefunds', 'admin.listStaffEarnings', 'admin.listFinanceLogs'
  ]
  const mockData = {
    listWithdrawRequests: [
      { _id: 'wd_1', staffPhone: '13911112222', amount: 50, outBillNo: 'BILL_WD_1' },
      { _id: 'wd_2', staffPhone: '13933334444', amount: 60, outBillNo: 'BILL_WD_2' }
    ],
    listStaffDeposits: [
      { _id: 'dep_1', staffPhone: '13911112222', amount: 500, outTradeNo: 'TRADE_DEP_1' },
      { _id: 'dep_2', staffPhone: '13933334444', amount: 500, outTradeNo: 'TRADE_DEP_2' }
    ],
    listPayments: [
      { _id: 'pay_1', orderId: 'ORD_1001', contactPhone: '13555556666', paymentNo: 'P001', amount: 100 },
      { _id: 'pay_2', orderId: 'ORD_2002', contactPhone: '13677778888', paymentNo: 'P002', amount: 200 }
    ]
  }

  const { page, calls } = setup(allPermissions, async (action, data) => {
    return mockData[action] || []
  })

  page.updateAccessibleTabs()

  // 1. 默认无关键词，query 只有起止时间
  assert.equal(page.data.keyword, '')
  assert.equal(page.data.appliedKeyword, '')
  assert.equal(page.query().keyword, undefined)

  // 2. 输入手机号
  page.inputKeyword({ detail: { value: '13911112222' } })
  assert.equal(page.data.keyword, '13911112222')
  // 此时尚未提交，appliedKeyword 仍为空
  assert.equal(page.data.appliedKeyword, '')

  // 3. 提交搜索
  calls.length = 0
  page.submitSearch()
  await page.load()
  await page.loadStaffFinance()

  // 校验 appliedKeyword 已生效
  assert.equal(page.data.appliedKeyword, '13911112222')
  assert.equal(page.query().keyword, '13911112222')

  // 校验后端调用入参均携带 keyword: '13911112222'
  const withdrawCall = calls.find(c => c.action === 'listWithdrawRequests')
  assert.ok(withdrawCall, '应当调用 listWithdrawRequests')
  assert.equal(withdrawCall.data.keyword, '13911112222')

  const depositCall = calls.find(c => c.action === 'listStaffDeposits')
  assert.ok(depositCall, '应当调用 listStaffDeposits')
  assert.equal(depositCall.data.keyword, '13911112222')

  // 校验前端已根据手机号做展示呈现
  assert.equal(page.data.requests.length, 1)
  assert.equal(page.data.requests[0]._id, 'wd_1')
  assert.equal(page.data.deposits.length, 1)
  assert.equal(page.data.deposits[0]._id, 'dep_1')

  // 4. 输入订单号搜索
  page.inputKeyword({ detail: { value: 'ORD_2002' } })
  page.submitSearch()
  await page.load()
  await page.loadStaffFinance()

  assert.equal(page.data.appliedKeyword, 'ORD_2002')
  assert.equal(page.query().keyword, 'ORD_2002')
  assert.equal(page.data.payments.length, 1)
  assert.equal(page.data.payments[0]._id, 'pay_2')

  // 5. 点击清除搜索
  calls.length = 0
  page.clearSearch()
  await page.load()
  await page.loadStaffFinance()

  assert.equal(page.data.keyword, '')
  assert.equal(page.data.appliedKeyword, '')
  assert.equal(page.query().keyword, undefined)
  assert.equal(page.data.requests.length, 2)
  assert.equal(page.data.deposits.length, 2)
  assert.equal(page.data.payments.length, 2)
})
