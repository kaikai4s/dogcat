const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setupUserEditPage({ userDetail, relatedDetails }) {
  const requests = []
  const cloud = {
    callFunction: async (module, action, data) => {
      requests.push({ module, action, data })
      if (action === 'getUserDetail') return userDetail
      if (action === 'getUserRelatedDetails') return relatedDetails
      return {}
    },
    showError: () => {}
  }
  let page
  const clipboardData = { text: '' }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/users/edit/index.js'), 'utf8'), {
    Page: (value) => { page = value },
    wx: {
      showToast() {},
      showLoading() {},
      hideLoading() {},
      navigateTo() {},
      setClipboardData({ data, success }) {
        clipboardData.text = data
        if (success) success()
      }
    },
    require(name) {
      if (name.endsWith('/cloud')) return cloud
      return {}
    }
  })
  page.setData = function(patch, callback) {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) {
        const parts = k.split('.')
        let cur = this.data
        for (let i = 0; i < parts.length - 1; i++) {
          cur[parts[i]] = cur[parts[i]] || {}
          cur = cur[parts[i]]
        }
        cur[parts[parts.length - 1]] = v
      } else {
        this.data[k] = v
      }
    }
    if (callback) callback.call(this)
  }
  return { page, requests, clipboardData }
}

test('admin finance page WXML and copyText handles applicantOpenid display and clipboard copy', () => {
  const financeWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.wxml'), 'utf8')
  assert.ok(financeWxml.includes('申请人微信ID'), '财务页面应包含申请人微信ID字段')
  assert.ok(financeWxml.includes('copyable-val'), '微信ID应具有可复制容器样式类')
  assert.ok(financeWxml.includes('bindtap="copyText"'), '微信ID应绑定 copyText 点击复制')

  // 测试 copyText 实现
  let copied = ''
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8'), {
    Page: (value) => { page = value },
    wx: {
      setClipboardData({ data, success }) {
        copied = data
        if (success) success()
      },
      showToast() {}
    },
    require: (name) => {
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      return { navMethods: () => ({}), createPageNav: () => ({}) }
    }
  })

  page.copyText({ currentTarget: { dataset: { text: 'wx_test_openid_999' } } })
  assert.equal(copied, 'wx_test_openid_999', '点击复制应正确将 openid 写入剪贴板')
})

test('admin home dashboard renders pending commission, pending staff earnings, and expired commission stats', () => {
  const homeWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.wxml'), 'utf8')
  assert.ok(homeWxml.includes('佣金与收益概览'), '控制台应包含佣金与收益概览卡片')
  assert.ok(homeWxml.includes('platform-finance-card'), '控制台应包含平台佣金统计样式')
  assert.ok(homeWxml.includes('platformFinanceStats'), '控制台应绑定 platformFinanceStats 列表')

  // 测试控制台逻辑中的 buildFinanceOverviewStats
  let homePage
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/home/index.js'), 'utf8'), {
    Page: (value) => { homePage = value },
    require: (name) => {
      if (name.endsWith('/adminAccess')) return { can: () => true, canVisit: () => true }
      if (name.endsWith('/cloud')) return { callFunction: () => Promise.resolve({ pendingCommission: 88.5, pendingStaffEarnings: 150, expiredCommission: 20 }) }
      return {}
    }
  })

  homePage.setData = function(patch) {
    Object.assign(this.data, patch)
  }

  homePage.loadDashboard().then(() => {
    assert.ok(homePage.data.platformFinanceStats.length >= 3)
    const commissionStat = homePage.data.platformFinanceStats.find(s => s.label === '待提现佣金')
    const earningsStat = homePage.data.platformFinanceStats.find(s => s.label === '待提现收益')
    const expiredStat = homePage.data.platformFinanceStats.find(s => s.label === '过期佣金总额')
    assert.ok(commissionStat)
    assert.ok(earningsStat)
    assert.ok(expiredStat)
    assert.equal(commissionStat.value, '¥88.50')
    assert.equal(earningsStat.value, '¥150.00')
    assert.equal(expiredStat.value, '¥20.00')
  })
})

test('admin user edit page renders commission summary card, supports drilling down into related details modal', async () => {
  const editWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/users/edit/index.wxml'), 'utf8')
  assert.ok(editWxml.includes('用户佣金资产'), '应渲染用户佣金资产卡片')
  assert.ok(editWxml.includes('当前可提现'), '应展示当前可提现')
  assert.ok(editWxml.includes('累计已过期'), '应展示累计已过期')
  assert.ok(editWxml.includes('detail-mask'), '应包含明细抽屉遮罩')
  assert.ok(editWxml.includes('detail-drawer'), '应包含明细抽屉面板')
  assert.ok(editWxml.includes('tapStatsRow'), '关联数据统计行应绑定 tapStatsRow 点击查看明细')

  const userDetail = {
    _id: 'u1',
    openid: 'user_openid_123',
    nickname: '小汪主人',
    status: 'active',
    roles: ['client'],
    points: 100,
    stats: {
      coupons: 3,
      pointLogs: 5,
      addresses: 2,
      pets: 1
    },
    commission: {
      available: 25.5,
      withdrawn: 60.0,
      expired: 10.0,
      total: 95.5
    }
  }

  const relatedDetails = {
    coupons: [
      { _id: 'c1', name: '首单减免券', discountAmount: 30, minOrderAmount: 100, usageScopeText: '上门喂养', sourceText: '新用户注册赠送', statusText: '可使用', validTo: '2026-12-31' }
    ],
    pointLogs: [
      { _id: 'p1', delta: 20, balance: 100, reason: '每日签到', createdAt: '2026-11-01' }
    ],
    commission: {
      available: 25.5,
      withdrawn: 60.0,
      expired: 10.0,
      earnings: [
        { _id: 'e1', amountText: '25.50', sourceTypeText: '好友邀请奖励', statusText: '可提现', createdAt: '2026-10-20' }
      ],
      withdraws: [
        { _id: 'w1', amountText: '60.00', payoutChannel: '微信零钱', statusText: '已到账', createdAt: '2026-10-01' }
      ],
      expiredRecords: [
        { _id: 'ex1', amountText: '10.00', sourceTypeText: '订单分销佣金', statusText: '已过期', expiresAt: '2026-09-01' }
      ]
    }
  }

  const { page, requests } = setupUserEditPage({ userDetail, relatedDetails })

  // 1. onLoad 触发 load
  page.onLoad({ openid: 'user_openid_123' })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(page.data.userCommission.availableText, '25.50')
  assert.equal(page.data.userCommission.withdrawnText, '60.00')
  assert.equal(page.data.userCommission.expiredText, '10.00')
  assert.equal(page.data.statsRows.length, 11)

  // 2. 点击优惠券统计行打开详情弹窗
  page.tapStatsRow({ currentTarget: { dataset: { key: 'coupons' } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(page.data.activeDetailType, 'coupons')
  assert.equal(page.data.activeDetailTitle, '优惠券明细')
  assert.equal(page.data.currentDetailList.length, 1)
  assert.equal(page.data.currentDetailList[0].name, '首单减免券')

  // 3. 关闭弹窗
  page.closeDetailModal()
  assert.equal(page.data.activeDetailType, '')

  // 4. 点击佣金获得明细
  page.openDetailModal({ currentTarget: { dataset: { type: 'commission_earnings' } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(page.data.activeDetailType, 'commission_earnings')
  assert.equal(page.data.currentDetailList.length, 1)
  assert.equal(page.data.currentDetailList[0].amountText, '25.50')

  // 5. 点击佣金过期明细
  page.openDetailModal({ currentTarget: { dataset: { type: 'commission_expired' } } })
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(page.data.activeDetailType, 'commission_expired')
  assert.equal(page.data.currentDetailList.length, 1)
  assert.equal(page.data.currentDetailList[0].amountText, '10.00')
})
