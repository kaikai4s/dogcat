const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin finance list search: by phone number and order ID across all finance modules', async () => {
  const users = [
    { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
    { _id: 'u_staff_1', openid: 'openid_staff_1', nickname: '张师傅', phone: '13911112222' },
    { _id: 'u_staff_2', openid: 'openid_staff_2', nickname: '李师傅', phone: '13933334444' },
    { _id: 'u_client_1', openid: 'openid_client_1', nickname: '王女士', phone: '13555556666' },
    { _id: 'u_client_2', openid: 'openid_client_2', nickname: '赵先生', phone: '13677778888' }
  ]

  const staffProfiles = [
    { _id: 'sp_1', openid: 'openid_staff_1', realName: '张建国', phone: '13700001111', certifiedPhone: '13700001111', staffLevel: 'certified' },
    { _id: 'sp_2', openid: 'openid_staff_2', realName: '李建军', phone: '13700002222', certifiedPhone: '13700002222', staffLevel: 'intern' }
  ]

  const orders = [
    { _id: 'ord_1001', orderNo: 'ORD202610270001', userOpenid: 'openid_client_1', staffOpenid: 'openid_staff_1', contactPhone: '13555556666', status: 'completed' },
    { _id: 'ord_1002', orderNo: 'ORD202610270002', userOpenid: 'openid_client_2', staffOpenid: 'openid_staff_2', contactPhone: '13677778888', status: 'completed' }
  ]

  const withdrawRequests = [
    { _id: 'wd_1', staffOpenid: 'openid_staff_1', amount: 88, status: 'paid', outBillNo: 'BILL_WD_888', wechatTransferBillNo: 'WX_BILL_888', createdAt: '2026-10-27 10:00:00', paidAt: '2026-10-27 10:05:00' },
    { _id: 'wd_2', staffOpenid: 'openid_staff_2', amount: 66, status: 'pending', outBillNo: 'BILL_WD_666', createdAt: '2026-10-27 11:00:00' },
    { _id: 'wd_3', userOpenid: 'openid_client_1', assetType: 'user', amount: 20, status: 'approved', outBillNo: 'BILL_USER_20', createdAt: '2026-10-27 12:00:00' }
  ]

  const staffDeposits = [
    { _id: 'dep_1', staffOpenid: 'openid_staff_1', amount: 500, paidAmount: 500, status: 'paid', outTradeNo: 'TRADE_DEP_001', createdAt: '2026-10-20 10:00:00' },
    { _id: 'dep_2', staffOpenid: 'openid_staff_2', amount: 500, paidAmount: 500, status: 'paid', outTradeNo: 'TRADE_DEP_002', createdAt: '2026-10-21 10:00:00' }
  ]

  const staffEvidences = [
    { _id: 'ev_1', staffOpenid: 'openid_staff_1', orderId: 'ord_1001', orderNo: 'ORD202610270001', reasonType: 'late', deductAmount: 20, status: 'pending', createdAt: '2026-10-25 10:00:00' }
  ]

  const supplyReimbursements = [
    { _id: 'reimb_1', staffOpenid: 'openid_staff_1', amount: 150, approvedAmount: 150, status: 'paid', outTradeNo: 'SUP_001', createdAt: '2026-10-22 10:00:00' },
    { _id: 'reimb_2', staffOpenid: 'openid_staff_2', amount: 100, status: 'pending', createdAt: '2026-10-23 10:00:00' }
  ]

  const payments = [
    { _id: 'pay_1', orderId: 'ord_1001', paymentNo: 'PAY202610270001', amount: 199, status: 'paid', createdAt: '2026-10-27 09:00:00' },
    { _id: 'pay_2', orderId: 'ord_1002', paymentNo: 'PAY202610270002', amount: 299, status: 'paid', createdAt: '2026-10-27 09:30:00' }
  ]

  const refunds = [
    { _id: 'ref_1', orderId: 'ord_1001', refundNo: 'REF202610270001', amount: 50, status: 'success', createdAt: '2026-10-27 14:00:00' },
    { _id: 'ref_2', orderId: 'ord_1002', refundNo: 'REF202610270002', amount: 30, status: 'success', createdAt: '2026-10-27 15:00:00' }
  ]

  const staffEarnings = [
    { _id: 'earn_1', staffOpenid: 'openid_staff_1', orderId: 'ord_1001', amount: 120, status: 'settled', createdAt: '2026-10-27 16:00:00' },
    { _id: 'earn_2', staffOpenid: 'openid_staff_2', orderId: 'ord_1002', amount: 180, status: 'settled', createdAt: '2026-10-27 17:00:00' }
  ]

  const financeLogs = [
    { _id: 'log_1', targetType: 'order', targetId: 'ord_1001', action: 'order_paid', amountDelta: 199, createdAt: '2026-10-27 09:00:00' },
    { _id: 'log_2', targetType: 'order', targetId: 'ord_1002', action: 'order_paid', amountDelta: 299, createdAt: '2026-10-27 09:30:00' }
  ]

  const db = createCollectionStore({
    users,
    staff_profiles: staffProfiles,
    orders,
    withdraw_requests: withdrawRequests,
    staff_deposits: staffDeposits,
    staff_deposit_evidences: staffEvidences,
    staff_supply_reimbursements: supplyReimbursements,
    payments,
    refunds,
    staff_earnings: staffEarnings,
    finance_logs: financeLogs,
    user_asset_earnings: []
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 提现申请搜索：通过宠托师手机号搜索
  const withdrawByPhone = await fn.main({
    module: 'admin',
    action: 'listWithdrawRequests',
    data: { keyword: '13911112222' }
  })
  assert.equal(withdrawByPhone.ok, true)
  assert.equal(withdrawByPhone.data.length, 1)
  assert.equal(withdrawByPhone.data[0]._id, 'wd_1')
  assert.equal(withdrawByPhone.data[0].staffRealName, '张建国')

  // 提现申请搜索：通过提现单号/微信商户号搜索
  const withdrawByBill = await fn.main({
    module: 'admin',
    action: 'listWithdrawRequests',
    data: { keyword: 'WX_BILL_888' }
  })
  assert.equal(withdrawByBill.ok, true)
  assert.equal(withdrawByBill.data.length, 1)
  assert.equal(withdrawByBill.data[0]._id, 'wd_1')

  // 用户提现搜索：通过客户手机号搜索
  const withdrawUserPhone = await fn.main({
    module: 'admin',
    action: 'listWithdrawRequests',
    data: { keyword: '13555556666' }
  })
  assert.equal(withdrawUserPhone.ok, true)
  assert.equal(withdrawUserPhone.data.some(w => w._id === 'wd_3'), true)

  // 2. 保证金搜索：通过宠托师实名手机号搜索
  const depositByPhone = await fn.main({
    module: 'admin',
    action: 'listStaffDeposits',
    data: { keyword: '13700001111' }
  })
  assert.equal(depositByPhone.ok, true)
  assert.equal(depositByPhone.data.length, 1)
  assert.equal(depositByPhone.data[0]._id, 'dep_1')

  // 保证金搜索：通过关联问题订单号 ORD202610270001 搜索
  const depositByOrder = await fn.main({
    module: 'admin',
    action: 'listStaffDeposits',
    data: { keyword: 'ORD202610270001' }
  })
  assert.equal(depositByOrder.ok, true)
  assert.equal(depositByOrder.data.length, 1)
  assert.equal(depositByOrder.data[0]._id, 'dep_1')

  // 3. 用品报销搜索：通过手机号搜索
  const reimbByPhone = await fn.main({
    module: 'admin',
    action: 'listSupplyReimbursements',
    data: { keyword: '13933334444' }
  })
  assert.equal(reimbByPhone.ok, true)
  assert.equal(reimbByPhone.data.length, 1)
  assert.equal(reimbByPhone.data[0]._id, 'reimb_2')

  // 4. 支付搜索：通过支付单号搜索
  const payByNo = await fn.main({
    module: 'admin',
    action: 'listPayments',
    data: { keyword: 'PAY202610270001' }
  })
  assert.equal(payByNo.ok, true)
  assert.equal(payByNo.data.length, 1)
  assert.equal(payByNo.data[0]._id, 'pay_1')
  assert.equal(payByNo.data[0].contactPhone, '13555556666')

  // 支付搜索：通过客户手机号搜索
  const payByClientPhone = await fn.main({
    module: 'admin',
    action: 'listPayments',
    data: { keyword: '13677778888' }
  })
  assert.equal(payByClientPhone.ok, true)
  assert.equal(payByClientPhone.data.length, 1)
  assert.equal(payByClientPhone.data[0]._id, 'pay_2')

  // 5. 退款搜索：通过订单号搜索
  const refByOrder = await fn.main({
    module: 'admin',
    action: 'listRefunds',
    data: { keyword: 'ord_1001' }
  })
  assert.equal(refByOrder.ok, true)
  assert.equal(refByOrder.data.length, 1)
  assert.equal(refByOrder.data[0]._id, 'ref_1')

  // 退款搜索：通过退款单号搜索
  const refByNo = await fn.main({
    module: 'admin',
    action: 'listRefunds',
    data: { keyword: 'REF202610270002' }
  })
  assert.equal(refByNo.ok, true)
  assert.equal(refByNo.data.length, 1)
  assert.equal(refByNo.data[0]._id, 'ref_2')

  // 6. 宠托师收益搜索：通过手机号搜索
  const earnByPhone = await fn.main({
    module: 'admin',
    action: 'listStaffEarnings',
    data: { keyword: '13911112222' }
  })
  assert.equal(earnByPhone.ok, true)
  assert.equal(earnByPhone.data.length, 1)
  assert.equal(earnByPhone.data[0]._id, 'earn_1')
  assert.equal(earnByPhone.data[0].staffRealName, '张建国')

  // 7. 财务流水搜索：通过订单号搜索
  const logByTarget = await fn.main({
    module: 'admin',
    action: 'listFinanceLogs',
    data: { keyword: 'ord_1002' }
  })
  assert.equal(logByTarget.ok, true)
  assert.equal(logByTarget.data.length, 1)
  assert.equal(logByTarget.data[0]._id, 'log_2')

  // 8. 无关键字搜索：返回完整记录
  const allPayments = await fn.main({
    module: 'admin',
    action: 'listPayments',
    data: {}
  })
  assert.equal(allPayments.ok, true)
  assert.equal(allPayments.data.length, 2)
})
