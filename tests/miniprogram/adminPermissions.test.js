const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const access = { enabled: true, superAdmin: true, currentOpenid: 'owner', tree: [
  { id: 'orders', label: '订单', children: [{ id: 'admin.listOrders', label: '查看订单' }, { id: 'admin.refundOrder', label: '退款' }] },
  { id: 'finance', label: '财务', children: [{ id: 'admin.financeDashboard', label: '财务看板' }] }
] }
function setup(call = async () => ({})) {
  let page
  const toasts = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/permissions/index.js'), 'utf8'), {
    Page(value) { page = value }, require() { return { callFunction: call, showError: error => toasts.push(error.message) } },
    wx: { showToast: value => toasts.push(value.title), pageScrollTo() {}, navigateTo() {} }
  })
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.')
      let target = page.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
  }
  page.setData({ access, groups: [], members: [] })
  return { page, toasts }
}
const event = (id, value) => ({ currentTarget: { dataset: { id } }, detail: { value } })

test('permission search preserves selections outside the filtered visible children', () => {
  const { page } = setup()
  page.edit(event())
  page.branch(event('orders'))
  page.permissionSearch(event('', '退款'))
  assert.equal(page.data.tree.length, 1)
  assert.equal(page.data.tree[0].children.length, 1)
  page.permissions(event('orders', []))
  assert.deepEqual([...page.data.selected], ['admin.listOrders'])
  page.permissionSearch(event('', ''))
  assert.equal(page.data.tree[0].partial, true)
  assert.equal(page.data.permissionCount, 1)
})

test('save refuses blank names, prevents duplicate submissions and keeps editor after network errors', async () => {
  let reject, calls = 0
  const { page, toasts } = setup(() => { calls++; return new Promise((resolve, no) => { reject = no }) })
  page.edit(event())
  await page.save()
  assert.equal(calls, 0)
  page.name(event('', '客服'))
  const pending = page.save()
  await page.save()
  page.cancel()
  assert.equal(calls, 1)
  assert.ok(page.data.editor)
  reject(new Error('network error'))
  await pending
  assert.equal(page.data.busy, false)
  assert.equal(page.data.editor.name, '客服')
  assert.ok(toasts.includes('network error'))
})

test('load errors clear prior privileged state and a subsequent reload recovers', async () => {
  let failed = true
  const { page } = setup(async (module, action) => {
    if (failed) throw new Error('offline')
    if (action === 'getMyAdminAccess') return access
    return { list: [], hasMore: false }
  })
  await page.load()
  assert.equal(page.data.access, null)
  assert.equal(page.data.error, 'offline')
  assert.equal(page.data.loading, false)
  failed = false
  await page.load()
  assert.equal(page.data.access.superAdmin, true)
  assert.equal(page.data.error, '')
})

test('non-owner access does not fetch protected member or group lists', async () => {
  const calls = []
  const { page } = setup(async (module, action) => { calls.push(action); return { ...access, superAdmin: false } })
  await page.load()
  assert.deepEqual(calls, ['getMyAdminAccess'])
  page.edit(event())
  assert.equal(page.data.editor, null)
})

test('member editor exposes inactive groups and blocks more than ten assignments', async () => {
  let count = 0
  const { page, toasts } = setup(async () => { count++; return { openid: 'member', groupIds: ['active', 'inactive'], revision: 3 } })
  page.setData({ groups: [{ _id: 'active', enabled: true }, { _id: 'inactive', enabled: false }], targetOpenid: 'member' })
  await page.editMember(event())
  assert.deepEqual([...page.data.selectedGroups], ['active'])
  assert.equal(page.data.inactiveGroupCount, 1)
  page.groupsChanged(event('', Array.from({ length: 11 }, (_, i) => String(i))))
  await page.saveMember()
  assert.equal(count, 1)
  assert.ok(toasts.includes('最多分配 10 个用户组'))
})
