const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const access = require('../../miniprogram/utils/adminAccess')

function setup() {
  const cloud = {
    callFunction: async () => [],
    showError: () => {}
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
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) {
        const [parent, child] = k.split('.')
        page.data[parent] = page.data[parent] || {}
        page.data[parent][child] = v
      } else {
        page.data[k] = v
      }
    }
    if (callback) callback.call(page)
  }
  return page
}

test('admin finance withdraw: 提现历史默认不展开，点击可独立展开与收起', () => {
  const page = setup()

  // 默认不展开
  assert.equal(Object.keys(page.data.expandedWithdrawHistories || {}).length, 0)

  const id1 = 'w_001'
  const id2 = 'w_002'

  // 点击 id1 展开
  page.toggleWithdrawHistory({ currentTarget: { dataset: { id: id1 } } })
  assert.equal(page.data.expandedWithdrawHistories[id1], true, 'id1 应已展开')
  assert.equal(page.data.expandedWithdrawHistories[id2], undefined, 'id2 应仍未展开')

  // 点击 id2 展开
  page.toggleWithdrawHistory({ currentTarget: { dataset: { id: id2 } } })
  assert.equal(page.data.expandedWithdrawHistories[id1], true, 'id1 保持展开')
  assert.equal(page.data.expandedWithdrawHistories[id2], true, 'id2 应已展开')

  // 再次点击 id1 收起
  page.toggleWithdrawHistory({ currentTarget: { dataset: { id: id1 } } })
  assert.equal(page.data.expandedWithdrawHistories[id1], false, 'id1 应已收起')
  assert.equal(page.data.expandedWithdrawHistories[id2], true, 'id2 保持展开')
})

test('admin finance WXML/WXSS: 包含提现历史折叠组件与按钮对齐样式', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.wxss'), 'utf8')

  // WXML 校验
  assert.ok(wxml.includes('withdraw-history-box'), '应包含 withdraw-history-box 折叠卡片')
  assert.ok(wxml.includes('bindtap="toggleWithdrawHistory"'), '应绑定 toggleWithdrawHistory 点击事件')
  assert.ok(wxml.includes('expandedWithdrawHistories[item._id]'), '应依据 expandedWithdrawHistories 决定是否渲染历史列表')
  assert.ok(wxml.includes('withdraw-btn withdraw-reject-btn'), '驳回按钮应使用统一的 withdraw-btn')
  assert.ok(wxml.includes('withdraw-btn withdraw-approve-btn'), '同意按钮应使用统一的 withdraw-btn')

  // WXSS 校验
  assert.ok(wxss.includes('.withdraw-audit-actions'), '应包含操作栏样式')
  assert.ok(wxss.includes('flex: 1 1 0%'), '按钮应采用 flex: 1 1 0% 1:1 等宽平分对齐')
  assert.ok(wxss.includes('.withdraw-history-header'), '应包含折叠头部样式')
})
