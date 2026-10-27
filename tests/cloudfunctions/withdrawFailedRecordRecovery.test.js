const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createService = require('../../cloudfunctions/api/services/withdrawals')
const createEarningsService = require('../../cloudfunctions/api/services/earnings')
const createFinancialSettlement = require('../../cloudfunctions/api/services/financialSettlement')
const validation = require('../../cloudfunctions/api/utils/validation')

test('withdrawals: 6 笔 0.07 元收益在包含历史失败残留 withdrawRequestId 时可正常提现 0.42 元', async () => {
  const staffOpenid = 'staff_yuan'
  const time = new Date().toISOString()
  
  // 模拟历史失败提现单（例如低于微信单笔限额 0.10 元导致微信转账失败）
  const failedWithdrawRequest = {
    _id: 'WD1EF6A3D257E30D74CD38',
    staffOpenid,
    amount: 0.07,
    status: 'transfer_failed',
    transferStatus: 'failed',
    payoutChannel: 'wechat_wallet',
    lastTransferError: '微信尚未查到原转账单，此笔低于最低 ¥0.10',
    createdAt: time,
    updatedAt: time
  }

  // 6 笔 0.07 收益，总计 0.42 元。其中第 1 笔残留了已失败单据的 withdrawRequestId
  const staffEarnings = [
    { _id: 'e1', staffOpenid, amount: 0.07, status: 'available', withdrawRequestId: 'WD1EF6A3D257E30D74CD38' },
    { _id: 'e2', staffOpenid, amount: 0.07, status: 'available' },
    { _id: 'e3', staffOpenid, amount: 0.07, status: 'available' },
    { _id: 'e4', staffOpenid, amount: 0.07, status: 'available' },
    { _id: 'e5', staffOpenid, amount: 0.07, status: 'available' },
    { _id: 'e6', staffOpenid, amount: 0.07, status: 'available' },
  ]

  const db = createCollectionStore({
    staff_earnings: staffEarnings,
    withdraw_requests: [failedWithdrawRequest],
    finance_logs: [],
    staff_profiles: [{ openid: staffOpenid, auditStatus: 'approved' }],
    users: [{ openid: staffOpenid, roles: ['staff'], status: 'active' }],
    system_settings: [{ _id: 'default', settlement: { minWithdrawAmount: 0.01 } }]
  })

  const earningsService = createEarningsService({
    db,
    now: () => time,
    parseDateValue: (v) => new Date(v).getTime(),
    releaseWechatTransferQuota: async () => {}
  })

  const service = createService({
    db,
    crypto: require('node:crypto'),
    ...validation,
    findByClientRequestId: async () => null,
    getUser: async () => ({ openid: staffOpenid, roles: ['staff'], status: 'active' }),
    refreshStaffEarnings: earningsService.refreshStaffEarnings,
    getSystemSettings: async () => ({ settlement: { minWithdrawAmount: 0.01 } }),
    now: () => time
  })

  // 申请提现 0.42 元
  const result = await service.createWithdrawRequest(staffOpenid, {
    amount: 0.42,
    payoutChannel: 'wechat_wallet',
    clientRequestId: 'withdraw_042_test'
  })

  assert.ok(result, '提现申请应创建成功')
  assert.equal(result.amount, 0.42)
  assert.equal(result.status, 'pending')
  assert.equal(result.earningIds.length, 6)
  
  // 验证 6 笔收益均已成功转为 withdrawing，且绑定为新提现单 ID
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) {
    const row = db.state.staff_earnings.find(e => e._id === id)
    assert.equal(row.status, 'withdrawing')
    assert.equal(row.withdrawRequestId, result._id)
  }
})

test('refreshStaffEarnings: 能够自动清洗 transfer_failed / failed / cancelled 提现单残留的 withdrawRequestId', async () => {
  const staffOpenid = 'staff_cleanup'
  const time = new Date().toISOString()

  const db = createCollectionStore({
    staff_earnings: [
      { _id: 'ec1', staffOpenid, amount: 0.07, status: 'available', withdrawRequestId: 'WD_FAILED' },
      { _id: 'ec2', staffOpenid, amount: 0.07, status: 'available', withdrawRequestId: 'WD_NON_EXIST' },
      { _id: 'ec3', staffOpenid, amount: 0.07, status: 'available', withdrawRequestId: 'WD_PENDING' }
    ],
    withdraw_requests: [
      { _id: 'WD_FAILED', staffOpenid, status: 'transfer_failed', transferStatus: 'failed' },
      { _id: 'WD_PENDING', staffOpenid, status: 'pending' }
    ]
  })

  const earningsService = createEarningsService({
    db,
    now: () => time,
    parseDateValue: (v) => new Date(v).getTime(),
    releaseWechatTransferQuota: async () => {}
  })

  await earningsService.refreshStaffEarnings(staffOpenid)

  const ec1 = db.state.staff_earnings.find(e => e._id === 'ec1')
  const ec2 = db.state.staff_earnings.find(e => e._id === 'ec2')
  const ec3 = db.state.staff_earnings.find(e => e._id === 'ec3')

  assert.equal(ec1.withdrawRequestId, '', '失败单残留的 withdrawRequestId 应被清洗')
  assert.equal(ec2.withdrawRequestId, '', '不存在的提现单残留应被清洗')
  assert.equal(ec3.withdrawRequestId, 'WD_PENDING', 'pending 待审单的 withdrawRequestId 应保留')
})
