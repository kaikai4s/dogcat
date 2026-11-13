const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const access = require('../../miniprogram/utils/adminAccess')
function setup(permissions, respond = async () => []) {
  const calls = [], errors = [], loadingEvents = []
  const cloud = { callFunction: async (module, action, data) => { calls.push({ module, action, data }); return respond(action, data) }, showError: error => errors.push(error.message) }
  const helper = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/utils/admin-page-read.js'), 'utf8'), {
    module: helper, require: name => name.endsWith('/cloud') ? cloud : access
  })
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8'), {
    Page: value => { page = value }, wx: {
      showLoading() { loadingEvents.push('show') },
      hideLoading() { loadingEvents.push('hide') },
      showToast() { loadingEvents.push('toast') },
      showModal() { loadingEvents.push('modal') }
    }, require(name) {
      if (name.endsWith('/adminAccess')) return access
      if (name.endsWith('/admin-page-read')) return helper.exports
      if (name.endsWith('/cloud')) return cloud
      if (name.endsWith('/nav')) return { navMethods: () => ({}), createPageNav: () => ({}) }
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      return {}
    }
  })
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback.call(page) }
  page.setData({ adminAccess: { superAdmin: false, permissions } })
  return { page, calls, errors, loadingEvents }
}
test('finance displays redeemed earnings and redemption logs with their recorded amounts', async () => {
  const { page } = setup(['admin.listStaffEarnings', 'admin.listFinanceLogs', 'admin.listWithdrawRequests'], async action => {
    if (action === 'listStaffEarnings') return [{ _id: 'e', status: 'redeemed', amount: 0, redeemedAmount: 30 }]
    if (action === 'listFinanceLogs') return [{ action: 'staff_earning_redeemed', targetType: 'withdraw_request', amountDelta: -30 }]
    if (action === 'listWithdrawRequests') return [{ _id: 'w', source: 'admin_earning_redemption', status: 'paid', amount: 30 }]
    return []
  })
  await page.load()
  assert.equal(page.data.earnings[0].statusText, '已兑换')
  assert.equal(page.data.earnings[0].redeemedAmountText, '30.00')
  assert.equal(page.data.logs[0].actionText, '宠托师收益已兑换')
  assert.equal(page.data.requests[0].statusText, '已兑换')
})

test('finance earnings show refund adjustments and outstanding paid debt separately from redeemed totals', async () => {
  const { page } = setup(['admin.listStaffEarnings'], async () => [
    { _id: 'e', status: 'redeemed', amount: 0, redeemedAmount: 60, deductedAmount: 40, overpaidDebtAmount: 60 }
  ])
  await page.load()
  assert.equal(page.data.earnings[0].redeemedAmountText, '60.00')
  assert.equal(page.data.earnings[0].adjustmentAmountText, '40.00')
  assert.equal(page.data.earnings[0].debtAmountText, '60.00')
  const template = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.wxml'), 'utf8')
  assert.match(template, /item.adjustmentAmountText/)
  assert.match(template, /item.debtAmountText/)
})

test('user-asset-only financial administrator can enter finance and fetch no staff or other financial data', async () => {
  const grants = ['admin.listUserAssetWithdrawals']
  const { page, calls } = setup(grants, async () => [{ _id: 'w', assetType: 'user', amount: 30 }])
  assert.equal(access.canVisit({ permissions: grants }, '/pages/admin/finance/index'), true)
  page.updateAccessibleTabs()
  await page.load()
  await page.loadStaffFinance()
  assert.deepEqual(calls.map(row => row.action), ['listUserAssetWithdrawals'])
  assert.equal(page.data.requests[0].amountText, '30.00')
  assert.deepEqual([...page.data.accessibleTabs], ['withdraws'])
  assert.equal(page.data.dashboard, null)
  assert.equal(page.data.deposits.length, 0)
  page.switchTab({ currentTarget: { dataset: { tab: 'payments' } } })
  assert.equal(page.data.activeTab, 'withdraws')
})
test('a failed permitted finance query does not discard another permitted result', async () => {
  const { page, calls, errors } = setup(['admin.listPayments', 'admin.listRefunds'], async action => {
    if (action === 'listPayments') throw new Error('payment unavailable')
    return [{ _id: 'refund', amount: 7 }]
  })
  page.setData({ status: 'pending' })
  page.updateAccessibleTabs()
  await page.load()
  assert.equal(page.data.activeTab, 'payments')
  assert.equal(page.data.payments.length, 0)
  assert.equal(page.data.refunds[0]._id, 'refund')
  assert.deepEqual(errors, ['payment unavailable'])
  assert.ok(calls.every(call => !Object.hasOwn(call.data, 'status')))
  assert.deepEqual(calls.map(row => row.action).sort(), ['listPayments', 'listRefunds'])
})
test('staff deposit queries use all history only for a selected staff member', async () => {
  const { page, calls } = setup(['admin.listStaffDeposits', 'admin.listSupplyReimbursements'])
  page.setData({ startDate: '2026-10-01', endDate: '2026-10-26' })
  await page.loadStaffFinance()
  assert.deepEqual({ ...calls[0].data }, { startDate: '2026-10-01', endDate: '2026-10-26' })
  page.setData({ targetStaffOpenid: 'staff' })
  await page.loadStaffFinance()
  assert.deepEqual({ ...calls[2].data }, { staffOpenid: 'staff' })
  assert.deepEqual({ ...calls[3].data }, { startDate: '2026-10-01', endDate: '2026-10-26' })
})

test('clearing staff filter reloads monthly deposits and discards the old targeted response', async () => {
  let resolveOld
  const { page, calls } = setup(['admin.listStaffDeposits', 'admin.forfeitStaffDeposit'], (_, data) => data.staffOpenid
    ? new Promise(resolve => { resolveOld = resolve }) : [{ _id: 'monthly', staffOpenid: 'other' }])
  page.setData({ targetStaffOpenid: 'staff', targetStaffLabel: '小李' })
  page._autoForfeitParams = { staffOpenid: 'staff' }
  const old = page.loadStaffFinance()
  page.clearStaffFilter()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].data.staffOpenid, undefined)
  assert.equal(calls[1].data.startDate, page.data.startDate)
  assert.equal(page.data.deposits[0]._id, 'monthly')
  resolveOld([{ _id: 'historical', staffOpenid: 'staff', staffRealName: '小李', status: 'paid', availableRefundAmount: 500 }])
  await old
  assert.equal(page.data.deposits[0]._id, 'monthly')
  assert.equal(page.data.targetStaffLabel, '')
  assert.equal(page.data.showForfeitModal, undefined)
  assert.equal(page._autoForfeitParams, null)
})

test('late platform response cannot replace newly selected staff history', async () => {
  let resolveOld
  const { page } = setup(['admin.listStaffDeposits'], (_, data) => data.staffOpenid
    ? [{ _id: 'historical', staffOpenid: 'staff', staffRealName: '小李' }]
    : new Promise(resolve => { resolveOld = resolve }))
  const old = page.loadStaffFinance()
  page.setData({ targetStaffOpenid: 'staff' })
  await page.loadStaffFinance()
  resolveOld([{ _id: 'monthly', staffOpenid: 'other' }])
  await old
  assert.equal(page.data.deposits[0]._id, 'historical')
  assert.equal(page.data.targetStaffLabel, '小李')
})

test('stale successful response cannot end loading or open forfeiture during a newer request', async () => {
  const pending = []
  const { page } = setup(['admin.listStaffDeposits', 'admin.forfeitStaffDeposit'], () => new Promise(resolve => pending.push(resolve)))
  page.setData({ targetStaffOpenid: 'staff' })
  page._autoForfeitParams = { staffOpenid: 'staff' }
  const old = page.loadStaffFinance()
  const current = page.loadStaffFinance()
  pending[0]([{ _id: 'old', staffOpenid: 'staff', status: 'paid', availableRefundAmount: 500 }])
  await old
  assert.equal(page.data.staffFinanceLoading, true)
  assert.equal(page.data.deposits.length, 0)
  assert.equal(page.data.showForfeitModal, undefined)
  assert.equal(page._autoForfeitParams.staffOpenid, 'staff')
  pending[1]([{ _id: 'current', staffOpenid: 'staff', status: 'paid', availableRefundAmount: 100 }])
  await current
  assert.equal(page.data.staffFinanceLoading, false)
  assert.equal(page.data.forfeitDepositId, 'current')
  assert.equal(page.data.forfeitMaxAmount, 100)
  assert.equal(page.data.showForfeitModal, true)
})

test('stale finance failures do not clear loading or display errors for a newer request', async () => {
  const pending = []
  const { page, errors } = setup(['admin.listStaffDeposits'], () => new Promise((resolve, reject) => pending.push({ resolve, reject })))
  const old = page.loadStaffFinance()
  const current = page.loadStaffFinance()
  pending[0].reject(new Error('stale error'))
  await old
  assert.equal(page.data.staffFinanceLoading, true)
  assert.equal(page.data.staffFinanceError, '')
  assert.deepEqual(errors, [])
  pending[1].reject(new Error('current error'))
  await current
  assert.equal(page.data.staffFinanceLoading, false)
  assert.equal(page.data.staffFinanceError, 'current error')
  assert.deepEqual(errors, ['current error'])
})

for (const action of ['refund', 'settlement']) {
  test(`${action} navigation does not automatically open deposit forfeiture`, () => {
    const { page } = setup(['admin.listStaffDeposits'])
    page.onLoad({ tab: 'deposits', staffOpenid: 'staff', action })
    assert.equal(page.data.targetStaffOpenid, 'staff')
    assert.equal(page._autoForfeitParams, undefined)
  })
}

for (const outcome of ['approved', 'rejected', 'transfer_error', 'request_error']) {
  test(`withdrawal audit dismisses loading before feedback: ${outcome}`, async () => {
    const { page, loadingEvents, errors } = setup(['admin.auditUserAssetWithdrawal'], async () => {
      if (outcome === 'request_error') throw new Error('审核失败')
      return outcome === 'transfer_error' ? { lastTransferError: '转账待处理' } : {}
    })
    page.setData({ requests: [{ _id: 'w', assetType: 'user' }] })
    page.load = () => {}
    page.audit({ currentTarget: { dataset: { id: 'w', approved: outcome !== 'rejected' } } })
    assert.deepEqual(loadingEvents, ['show'])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(loadingEvents, outcome === 'request_error'
      ? ['show', 'hide']
      : ['show', 'hide', outcome === 'transfer_error' ? 'modal' : 'toast'])
    assert.deepEqual(errors, outcome === 'request_error' ? ['审核失败'] : [])
  })
}

test('user-only withdrawal audit uses the user audit action without the broader staff audit grant', async () => {
  const { page, calls } = setup(['admin.listUserAssetWithdrawals', 'admin.auditUserAssetWithdrawal'])
  page.setData({ requests: [{ _id: 'w', assetType: 'user' }] })
  page.load = () => {}
  page.audit({ currentTarget: { dataset: { id: 'w', approved: true } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].action, 'auditUserAssetWithdrawal')
  assert.equal(calls[0].data.id, 'w')
})

test('finance display localization uses payment, refund and earning domains without changing raw records', async () => {
  const format = require('../../miniprogram/utils/format')
  const rows = {
    listPayments: ['success', 'pending', 'failed', 'superseded', 'future_payment', ''].map((status, i) => ({ _id: `pay-${i}`, status, statusText: status, amount: 12, channel: i === 0 ? 'wechat' : i === 1 ? 'mock' : 'future_channel', paymentNo: 'P-RAW' })),
    listRefunds: ['success', 'processing', 'failed', 'future_refund', ''].map(status => ({ status, statusText: status, reason: 'Keep free text PROCESSING', refundNo: 'R-RAW' })),
    listStaffEarnings: ['pending', 'available', 'withdrawing', 'withdrawn', 'frozen', 'deducted', 'refunded_void', 'mock_settled', 'future_earning', ''].map(status => ({ status, statusText: status, orderId: 'ORDER-RAW' }))
  }
  const { page } = setup(Object.keys(rows).map(action => `admin.${action}`), async action => rows[action])
  await page.load()
  assert.equal(page.data.payments[0].statusText, format.formatPaymentStatus('paid'))
  assert.equal(page.data.payments[1].statusText, format.formatPaymentStatus('unpaid'))
  assert.equal(page.data.payments[2].statusText, format.formatPaymentStatus('failed'))
  assert.equal(page.data.payments[3].statusText, format.formatPaymentStatus('closed'))
  assert.equal(page.data.payments[0].channelText, '微信支付')
  assert.equal(page.data.payments[1].channelText, '模拟支付')
  assert.equal(page.data.payments[2].channelText, '支付渠道待核实')
  for (const [i, row] of page.data.refunds.entries()) {
    assert.equal(row.statusText, format.formatRefundStatus(row.status) || '退款状态待核实')
    assert.equal(row.status, rows.listRefunds[i].status)
    assert.equal(row.reason, 'Keep free text PROCESSING')
    assert.equal(row.refundNo, 'R-RAW')
  }
  assert.deepEqual(Array.from(page.data.earnings, row => row.statusText), [
    '待结算', '可提现', '提现中', '已提现', '已冻结', '已扣减', '退款已作废', '模拟收益（不可提现）', '收益状态待核实', '收益状态待核实'
  ])
  assert.equal(page.data.payments[0].status, 'success')
  assert.equal(page.data.payments[0].channel, 'wechat')
  assert.equal(page.data.payments[0].paymentNo, 'P-RAW')
  assert.equal(rows.listPayments[0].statusText, 'success')
  assert.ok(page.data.payments[4].statusText && !/future|成功|已支付/.test(page.data.payments[4].statusText))
  assert.ok(page.data.payments[5].statusText)
})

test('finance log actions and target types are localized with safe unknown labels and unchanged IDs', async () => {
  const actions = ['order_paid', 'mall_order_paid', 'refund_success', 'withdraw_requested', 'withdraw_approved', 'withdraw_rejected',
    'withdraw_paid', 'withdraw_transfer_failed', 'withdraw_released', 'withdraw_rejected_for_refund', 'admin_staff_settlement',
    'user_withdraw_approved', 'user_withdraw_rejected', 'user_withdraw_paid', 'user_withdraw_released',
    'staff_earning_created', 'staff_earning_mock_created', 'staff_earning_frozen', 'staff_earning_release', 'staff_earning_deduct',
    'staff_earning_keep_frozen', 'staff_earning_voided', 'staff_earning_partially_refunded', 'staff_earning_withdrawn_debt',
    'deposit_paid', 'deposit_forfeited', 'deposit_refunded', 'staff_supply_fee', 'supply_reimbursement_paid']
  const targets = ['order', 'mall_order', 'refund', 'withdraw_request', 'user_asset_withdrawal', 'staff_earning', 'staff_profile',
    'incident', 'staff_deposit', 'staff_supply_reimbursement']
  const { page } = setup(['admin.listFinanceLogs'], async () => [
    ...actions.map((action, i) => ({ action, targetType: targets[i % targets.length], targetId: `RAW-${i}`, amountDelta: -3 })),
    { action: 'future_action', targetType: 'future_type', targetId: 'RAW-UNKNOWN' }
  ])
  await page.load()
  page.data.logs.slice(0, -1).forEach((row, i) => {
    assert.match(row.actionText, /[\u4e00-\u9fff]/)
    assert.doesNotMatch(row.actionText, /待核实/)
    assert.match(row.targetTypeText, /[\u4e00-\u9fff]/)
    assert.doesNotMatch(row.targetTypeText, /待核实/)
    assert.equal(row.action, actions[i])
    assert.equal(row.targetType, targets[i % targets.length])
    assert.equal(row.targetId, `RAW-${i}`)
    assert.equal(row.amountDelta, -3)
  })
  assert.equal(page.data.logs.at(-1).actionText, '财务操作待核实')
  assert.equal(page.data.logs.at(-1).targetTypeText, '财务对象待核实')
})

test('deposit and supply labels are derived locally rather than trusting external statusText', async () => {
  const deposits = [
    ['paid', '已缴纳'], ['unpaid', '待支付'], ['partially_refunded', '部分已退还'], ['refund_requested', '退款审核中'],
    ['refund_approved', '审核通过，待实际退款'], ['refunding', '原路退款处理中'], ['refunded', '已退还'],
    ['forfeited', '已全额没收'], ['superseded', '已失效'], ['future_deposit', '保证金状态待核实'], ['', '保证金状态待核实']
  ]
  const supplies = [['pending', '待审核'], ['approved', '审核通过，等待打款'], ['rejected', '审核驳回'], ['paid', '已人工确认打款'], ['future_supply', '报销状态待核实']]
  const { page } = setup(['admin.listStaffDeposits', 'admin.listSupplyReimbursements'], async action => action === 'listStaffDeposits'
    ? [...deposits.map(([status]) => ({ status, statusText: 'UNTRUSTED_SUCCESS' })),
      { status: 'paid', forfeitedAmount: 10, availableRefundAmount: 90 },
      { status: 'paid', refundStatus: 'rejected' }, { status: 'refunding', refundNo: 'RESERVED', refundStatus: 'processing' },
      { status: 'refund_approved', refundChannel: 'manual' }]
    : [...supplies.map(([status]) => ({ status, statusText: 'UNTRUSTED_SUCCESS' })), { status: 'approved', benefitType: 'supply_fee_waiver' }])
  await page.loadStaffFinance()
  deposits.forEach(([status, label], i) => {
    assert.equal(page.data.deposits[i].status, status)
    assert.equal(page.data.deposits[i].statusText, label)
  })
  supplies.forEach(([status, label], i) => {
    assert.equal(page.data.supplies[i].status, status)
    assert.equal(page.data.supplies[i].statusText, label)
  })
  assert.equal(page.data.supplies.at(-1).statusText, '用品费用减免已通过')
  assert.equal(page.data.deposits.at(-4).statusText, '部分没收（余¥90.00）')
  assert.equal(page.data.deposits.at(-3).statusText, '退款已驳回')
  assert.equal(page.data.deposits.at(-2).statusText, '退款受理待核实')
  assert.equal(page.data.deposits.at(-1).statusText, '审核通过，待人工退款')
})

test('withdrawal and sitter histories never expose unknown status labels or imply approval means paid', async () => {
  const history = [
    { status: 'approved', payoutChannel: 'manual' },
    { status: 'paid', source: 'admin_manual_tail_settlement' },
    { status: 'approved', payoutChannel: 'wechat_wallet' },
    { status: 'future_status', statusText: 'SUCCESS' }, { status: '', statusText: 'SUCCESS' }
  ]
  const { page } = setup(['admin.listWithdrawRequests'], async () => [
    { status: 'future_status', transferStatus: 'future_transfer', payoutChannel: 'wechat_wallet', withdrawHistory: history },
    { status: 'transferring', transferStatus: 'processing', payoutChannel: 'wechat_wallet', wechatTransferState: 'WAIT_USER_CONFIRM' },
    { status: 'transferring', transferStatus: 'processing', payoutChannel: 'wechat_wallet', wechatTransferState: 'FUTURE_STATE' }
  ])
  await page.load()
  assert.equal(page.data.requests[0].statusText, '提现状态待核实')
  assert.equal(page.data.requests[0].transferStatusText, '转账状态待核实')
  assert.equal(page.data.requests[1].transferStatusText, '待收款人确认收款')
  assert.equal(page.data.requests[2].transferStatusText, '微信转账状态待核实')
  const expected = ['待人工付款', '已人工结清', '待提交转账', '提现状态待核实', '提现状态待核实']
  assert.deepEqual(Array.from(page.data.requests[0].withdrawHistory, row => row.statusText), expected)
  const withDisplay = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.js'), 'utf8') + '\n;withDisplay', {
    Page() {}, require() { return {} }
  })
  const profile = withDisplay({ _id: 'STAFF-RAW', withdrawHistory: history })
  assert.deepEqual(Array.from(profile.withdrawHistory, row => row.statusText), expected)
  assert.equal(profile.withdrawHistory[3].status, 'future_status')
  assert.equal(profile._id, 'STAFF-RAW')
})

test('finance template renders display fields while keeping raw status conditions and IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.wxml'), 'utf8')
  assert.doesNotMatch(source, /\{\{item\.(status|channel|action|targetType)\}\}|statusText\s*\|\|\s*item\.status|channel\s*\|\|\s*'mock'/)
  assert.match(source, /\{\{item\.statusText\}\}/)
  assert.match(source, /\{\{item\.channelText\}\}/)
  assert.match(source, /\{\{item\.actionText\}\}/)
  assert.match(source, /\{\{item\.targetTypeText\}\} \/ \{\{item\.targetId\}\}/)
  assert.match(source, /item\.status === 'pending'/)
  assert.match(source, /data-status="pending"/)
})
