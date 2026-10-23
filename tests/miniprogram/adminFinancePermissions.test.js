const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const access = require('../../miniprogram/utils/adminAccess')
function setup(permissions, respond = async () => []) {
  const calls = [], errors = []
  const cloud = { callFunction: async (module, action, data) => { calls.push({ module, action, data }); return respond(action) }, showError: error => errors.push(error.message) }
  const helper = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/admin-page-read.js'), 'utf8'), {
    module: helper, require: name => name === './cloud' ? cloud : access
  })
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8'), {
    Page: value => { page = value }, wx: { showToast() {} }, require(name) {
      if (name.endsWith('/adminAccess')) return access
      if (name.endsWith('/admin-page-read')) return helper.exports
      if (name.endsWith('/cloud')) return cloud
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      return {}
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
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
test('user-only withdrawal audit uses the user audit action without the broader staff audit grant', async () => {
  const { page, calls } = setup(['admin.listUserAssetWithdrawals', 'admin.auditUserAssetWithdrawal'])
  page.setData({ requests: [{ _id: 'w', assetType: 'user' }] })
  page.load = () => {}
  page.audit({ currentTarget: { dataset: { id: 'w', approved: true } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].action, 'auditUserAssetWithdrawal')
  assert.equal(calls[0].data.id, 'w')
})
