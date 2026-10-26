const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const access = require('../../miniprogram/utils/adminAccess')
function setup(permissions, respond = async () => []) {
  const calls = [], errors = []
  const cloud = { callFunction: async (module, action, data) => { calls.push({ module, action, data }); return respond(action, data) }, showError: error => errors.push(error.message) }
  const helper = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/utils/admin-page-read.js'), 'utf8'), {
    module: helper, require: name => name.endsWith('/cloud') ? cloud : access
  })
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8'), {
    Page: value => { page = value }, wx: { showToast() {} }, require(name) {
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
  return { page, calls, errors }
}
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

test('user-only withdrawal audit uses the user audit action without the broader staff audit grant', async () => {
  const { page, calls } = setup(['admin.listUserAssetWithdrawals', 'admin.auditUserAssetWithdrawal'])
  page.setData({ requests: [{ _id: 'w', assetType: 'user' }] })
  page.load = () => {}
  page.audit({ currentTarget: { dataset: { id: 'w', approved: true } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].action, 'auditUserAssetWithdrawal')
  assert.equal(calls[0].data.id, 'w')
})
