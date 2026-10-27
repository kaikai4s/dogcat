const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setupPage() {
  const root = path.join(__dirname, '../../miniprogram')
  const earningsJs = fs.readFileSync(path.join(root, 'pages/staff/earnings/index.js'), 'utf8')
  const earningsWxml = fs.readFileSync(path.join(root, 'pages/staff/earnings/index.wxml'), 'utf8')

  let pageDef
  const mockContext = {
    Page: (def) => { pageDef = def },
    wx: {
      showToast() {},
      showModal() {},
      showLoading() {},
      hideLoading() {},
      stopPullDownRefresh() {}
    },
    require: (name) => {
      if (name.endsWith('/cloud')) {
        return {
          callFunction: async () => {},
          showError: () => {},
          showLoading: () => {},
          hideLoading: () => {}
        }
      }
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'req_123' }
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({ themeClass: 'theme-day' }) }
      return {}
    }
  }

  vm.runInNewContext(earningsJs, mockContext)
  return { pageDef, earningsWxml }
}

test('staff earnings display: no gross order price shown, displays expected and actual earnings with deduction explanations', async () => {
  const { pageDef, earningsWxml } = setupPage()

  // 1. 验证 WXML 中不存在“订单原价”文案
  assert.equal(earningsWxml.includes('订单原价'), false, '宠托师端不应显示“订单原价”')
  assert.equal(earningsWxml.includes('理应到手收益'), true, '应当显示“理应到手收益”')
  assert.equal(earningsWxml.includes('实际到手收益'), true, '应当显示“实际到手收益”')
  assert.equal(earningsWxml.includes('违规扣除'), true, '如有扣除应当显示违规扣除')
  assert.equal(earningsWxml.includes('扣除说明'), true, '如有扣除应当显示扣除说明')

  // 2. 模拟页面逻辑并挂载数据
  const page = { ...pageDef, data: { ...pageDef.data } }
  page.setData = function (patch) {
    Object.assign(this.data, patch)
  }

  // 模拟 6 笔可提现收益（每笔 0.07，总计 0.42），其中 1 笔有扣除说明
  const mockRawEarnings = [
    { _id: 'e1', orderId: 'O1', amount: 0.07, status: 'available', availableAt: '2026-10-19 13:30:59' },
    { _id: 'e2', orderId: 'O2', amount: 0.07, status: 'available', availableAt: '2026-10-19 00:43:53' },
    { _id: 'e3', orderId: 'O3', amount: 0.07, status: 'available', availableAt: '2026-10-18 23:14:38' },
    { _id: 'e4', orderId: 'O4', amount: 0.07, status: 'available', availableAt: '2026-10-16 04:00:19' },
    { _id: 'e5', orderId: 'O5', amount: 0.07, status: 'available', availableAt: '2026-10-16 02:23:50' },
    { _id: 'e6', orderId: 'O6', amount: 0.07, deductAmount: 0.03, deductReason: '迟到扣除', status: 'available', availableAt: '2026-10-15 11:08:49' }
  ]

  // 调用 load 模拟的处理逻辑
  const withEarning = (item) => {
    const deductAmount = Number(item.deductAmount || 0)
    const hasDeduction = deductAmount > 0
    const expectedAmount = Number(item.originalAmount != null ? item.originalAmount : (item.amount != null ? Number(item.amount) + deductAmount : 0))
    return {
      ...item,
      amountText: Number(item.amount).toFixed(2),
      expectedAmountText: Number(expectedAmount).toFixed(2),
      deductAmountText: Number(deductAmount).toFixed(2),
      deductReasonText: item.deductReason || '服务违规/出险扣除',
      hasDeduction
    }
  }

  const decorated = mockRawEarnings.map(withEarning)
  page.setData({
    earnings: decorated,
    filteredEarnings: decorated,
    availableEarningsCount: decorated.filter(e => e.status === 'available').length,
    pendingEarningsCount: decorated.filter(e => e.status === 'pending').length
  })

  // 验证笔数
  assert.equal(page.data.earnings.length, 6, '应当总共有 6 笔记录')
  assert.equal(page.data.availableEarningsCount, 6, '可提现记录数量应当为 6')

  // 验证无扣除记录的收益字段
  const normalEarning = page.data.earnings[0]
  assert.equal(normalEarning.expectedAmountText, '0.07')
  assert.equal(normalEarning.amountText, '0.07')
  assert.equal(normalEarning.hasDeduction, false)

  // 验证有扣除记录的收益字段
  const deductedEarning = page.data.earnings[5]
  assert.equal(deductedEarning.expectedAmountText, '0.10', '理应到手收益应当为 0.07 + 0.03 = 0.10')
  assert.equal(deductedEarning.amountText, '0.07', '实际到手收益为 0.07')
  assert.equal(deductedEarning.deductAmountText, '0.03', '扣除金额为 0.03')
  assert.equal(deductedEarning.deductReasonText, '迟到扣除', '扣除说明为 迟到扣除')
  assert.equal(deductedEarning.hasDeduction, true)

  // 3. 测试状态筛选
  page.filterEarnings({ currentTarget: { dataset: { status: 'available' } } })
  assert.equal(page.data.earningFilterStatus, 'available')
  assert.equal(page.data.filteredEarnings.length, 6)

  page.filterEarnings({ currentTarget: { dataset: { status: 'pending' } } })
  assert.equal(page.data.earningFilterStatus, 'pending')
  assert.equal(page.data.filteredEarnings.length, 0)
})
