const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb() {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_staff_1', openid: 'openid_staff_1', nickname: '托师小李', phone: '13900001111', roles: ['client', 'staff'], status: 'active' },
      { _id: 'u_staff_2', openid: 'openid_staff_2', nickname: '托师小张', phone: '13900002222', roles: ['client', 'staff'], status: 'active' },
      { _id: 'u_staff_3', openid: 'openid_staff_3', nickname: '托师小赵', phone: '13900003333', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff_1',
        realName: '李未退',
        phone: '13900001111',
        auditStatus: 'approved',
        staffLevel: 'intern',
        depositStatus: 'paid'
      },
      {
        _id: 'sp_2',
        openid: 'openid_staff_2',
        realName: '张已清',
        phone: '13900002222',
        auditStatus: 'approved',
        staffLevel: 'intern',
        depositStatus: 'refunded'
      },
      {
        _id: 'sp_3',
        openid: 'openid_staff_3',
        realName: '赵有收益',
        phone: '13900003333',
        auditStatus: 'approved',
        staffLevel: 'intern',
        depositStatus: 'refunded'
      }
    ],
    // 模拟李未退有两条保证金记录：一条最新生成的未支付记录（0元），一条历史未退结清的记录（19.90元）
    staff_deposits: [
      {
        _id: 'dep_1_new',
        staffOpenid: 'openid_staff_1',
        amount: 500,
        paidAmount: 0,
        availableRefundAmount: 0,
        status: 'unpaid',
        createdAt: '2026-10-27T08:00:00.000Z'
      },
      {
        _id: 'dep_1_old',
        staffOpenid: 'openid_staff_1',
        amount: 500,
        paidAmount: 500,
        availableRefundAmount: 19.90,
        status: 'partially_refunded',
        createdAt: '2026-10-20T08:00:00.000Z'
      },
      // 张已清：保证金已退款结清（余额0）
      {
        _id: 'dep_2_refunded',
        staffOpenid: 'openid_staff_2',
        amount: 500,
        paidAmount: 500,
        availableRefundAmount: 0,
        status: 'refunded',
        refundStatus: 'refunded',
        createdAt: '2026-10-21T08:00:00.000Z'
      },
      // 赵有收益：保证金已退款（余额0），但有未提现收益
      {
        _id: 'dep_3_refunded',
        staffOpenid: 'openid_staff_3',
        amount: 500,
        paidAmount: 500,
        availableRefundAmount: 0,
        status: 'refunded',
        refundStatus: 'refunded',
        createdAt: '2026-10-21T08:00:00.000Z'
      }
    ],
    staff_earnings: [
      {
        _id: 'earn_3',
        staffOpenid: 'openid_staff_3',
        amount: 88.00,
        status: 'available'
      }
    ],
    withdraw_requests: []
  })
}

test('admin listStaffProfiles correctly aggregates multi-record deposits and accurately flags canRevokeStaff', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 查询全部列表
  const res = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {}
  })

  assert.equal(res.ok, true)
  const list = res.data.list
  assert.equal(list.length, 3)

  // 1. 验证 李未退：即使最新记录是 0 余额的未支付记录，也能正确汇总出历史未退的 19.90
  const sp1 = list.find((p) => p._id === 'sp_1')
  assert.ok(sp1)
  assert.equal(sp1.depositBalance, 19.90)
  assert.equal(sp1.depositId, 'dep_1_old') // 优先锁定有未结清金额的记录ID
  assert.equal(sp1.hasUnsettledDeposit, true)
  assert.equal(sp1.canRevokeStaff, false) // 保证金未处理完成，不可移除

  // 2. 验证 张已清：保证金为 0 且无未结清记录，无收益占用，可移除身份
  const sp2 = list.find((p) => p._id === 'sp_2')
  assert.ok(sp2)
  assert.equal(sp2.depositBalance, 0)
  assert.equal(sp2.hasUnsettledDeposit, false)
  assert.equal(sp2.withdrawableAmount, 0)
  assert.equal(sp2.canRevokeStaff, true)

  // 3. 验证 赵有收益：虽然保证金为 0，但有未提现收益 88 元，不可移除
  const sp3 = list.find((p) => p._id === 'sp_3')
  assert.ok(sp3)
  assert.equal(sp3.depositBalance, 0)
  assert.equal(sp3.withdrawableAmount, 88.00)
  assert.equal(sp3.canRevokeStaff, false)
})

test('admin listStaffProfiles filters sitters by canRevoke and can_revoke status tab', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 通过 canRevoke: 'yes' 筛选零保证金且可移除身份的宠托师（应该只有 sp_2 张已清）
  const res1 = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {
      canRevoke: 'yes'
    }
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.list.length, 1)
  assert.equal(res1.data.list[0]._id, 'sp_2')
  assert.equal(res1.data.list[0].realName, '张已清')
  assert.equal(res1.data.list[0].canRevokeStaff, true)

  // 2. 通过快捷 Tab auditStatus: 'can_revoke' 筛选
  const resTab = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {
      auditStatus: 'can_revoke'
    }
  })
  assert.equal(resTab.ok, true)
  assert.equal(resTab.data.list.length, 1)
  assert.equal(resTab.data.list[0]._id, 'sp_2')

  // 3. 通过 canRevoke: 'no' 筛选不可移除身份的宠托师（应该有 sp_1 和 sp_3）
  const resNo = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {
      canRevoke: 'no'
    }
  })
  assert.equal(resNo.ok, true)
  assert.equal(resNo.data.list.length, 2)
  const ids = resNo.data.list.map((p) => p._id)
  assert.ok(ids.includes('sp_1'))
  assert.ok(ids.includes('sp_3'))
})

test('admin sitters list frontend page logic and validation', () => {
  let pageOptions = null
  let modalTitle = ''
  let modalContent = ''

  const context = {
    Page: (opts) => { pageOptions = opts },
    getCurrentPages: () => [],
    wx: {
      showToast: () => {},
      showModal: (opts) => {
        modalTitle = opts.title
        modalContent = opts.content
      },
      navigateTo: () => {},
      stopPullDownRefresh: () => {}
    },
    require: (name) => {
      if (name.includes('cloud')) return { callFunction: () => Promise.resolve({ list: [], total: 0 }), showError: () => {} }
      if (name.includes('admin-page-read')) return { optionalAdminRead: () => Promise.resolve({}) }
      if (name.includes('image-upload')) return { uploadImage: () => Promise.resolve({}) }
      if (name.includes('envList')) return { getActiveEnvId: () => 'test-env' }
      return {}
    }
  }

  const code = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.js'), 'utf8')
  vm.runInNewContext(code, context)

  assert.ok(pageOptions, 'Page options must be loaded')
  assert.ok(Array.isArray(pageOptions.data.statusTabs))
  const canRevokeTab = pageOptions.data.statusTabs.find((t) => t.value === 'can_revoke')
  assert.ok(canRevokeTab, 'statusTabs must contain can_revoke tab')
  assert.equal(canRevokeTab.label, '零保证金·可移除')

  // 验证 selectCanRevokeFilter
  let currentData = { ...pageOptions.data }
  const ctx = {
    data: currentData,
    setData(patch, cb) {
      Object.assign(this.data, patch)
      if (typeof cb === 'function') cb()
    },
    load() {}
  }

  pageOptions.selectCanRevokeFilter.call(ctx, { currentTarget: { dataset: { value: 'yes' } } })
  assert.equal(ctx.data.canRevokeStatus, 'yes')

  pageOptions.resetFilter.call(ctx)
  assert.equal(ctx.data.canRevokeStatus, '')

  // 验证 revokeStaff 拦截
  ctx.data.profiles = [
    {
      _id: 'sp_1',
      depositBalance: 19.9,
      depositBalanceText: '¥19.90',
      canRevokeStaff: false
    }
  ]

  pageOptions.revokeStaff.call(ctx, { currentTarget: { dataset: { id: 'sp_1' } } })
  assert.equal(modalTitle, '无法移除身份')
  assert.ok(modalContent.includes('保证金尚未结清（余额 ¥19.90）'))
})
