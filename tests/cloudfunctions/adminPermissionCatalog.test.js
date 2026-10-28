const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tree, permissions, ownerActions, ownerTree } = require('../../cloudfunctions/api/config/adminPermissions')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const leaves = tree.flatMap(node => node.children)
function setup(grants = [], extra = {}) {
  const db = createCollectionStore({ users: [{ _id: 'delegate', openid: 'delegate', roles: ['admin'], status: 'active' }],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    admin_groups: [{ _id: 'g', name: '职责组', enabled: true, permissions: grants }],
    admin_memberships: [{ _id: 'delegate', groupIds: ['g'] }], ...extra })
  const api = loadCloudFunction('api', db, 'delegate')
  return { db, call: (module, action, data = {}) => api.main({ module, action, data }) }
}
test('catalog covers every admin/adminMall action and all registered page permissions without duplicates', () => {
  assert.equal(leaves.length, permissions.size)
  const all = new Set([...permissions, ...ownerActions, 'admin.getMyAdminAccess'])
  for (const module of ['admin', 'adminMall']) {
    const source = fs.readFileSync(path.join(__dirname, `../../cloudfunctions/api/handlers/${module}.js`), 'utf8')
    const actions = [...source.matchAll(/if \(action === ['"]([^'"]+)['"]/g)].map(match => match[1])
    for (const action of actions) assert.ok(all.has(`${module}.${action}`), `${module}.${action}`)
  }
  const { routes } = require('../../miniprogram/utils/adminAccess')
  for (const [route, keys] of Object.entries(routes)) for (const key of keys) assert.ok(key === 'owner' || permissions.has(key), `${route}: ${key}`)
  for (const leaf of leaves) {
    assert.ok(leaf.description && ['read', 'write'].includes(leaf.kind), leaf.id)
    assert.equal(ownerActions.has(leaf.id), false)
    const visiting = new Set()
    function check(id) {
      assert.equal(visiting.has(id), false, `dependency cycle: ${id}`)
      visiting.add(id)
      for (const key of leaves.find(item => item.id === id).requires) { assert.ok(permissions.has(key), key); check(key) }
      visiting.delete(id)
    }
    check(leaf.id)
  }
  assert.equal(ownerTree.flatMap(node => node.children).length, ownerActions.size)
})
test('new catalog endpoints are delegated explicitly; removing the group immediately denies access', async () => {
  const { db, call } = setup(['admin.listOrderSessionMessages', 'adminMall.listExpressCompanies'])
  assert.equal((await call('admin', 'listOrderSessionMessages', { orderId: 'o' })).ok, true)
  assert.equal((await call('adminMall', 'listExpressCompanies')).ok, true)
  assert.equal((await call('adminMall', 'queryOrderLogistics', { orderId: 'o' })).code, 'ADMIN_FORBIDDEN')
  db.state.admin_groups[0].enabled = false
  assert.equal((await call('admin', 'listOrderSessionMessages', { orderId: 'o' })).code, 'ADMIN_FORBIDDEN')
})
test('WeChat shop config can be read by a delegated admin without write access', async () => {
  const appid = 'wx' + 'a'.repeat(16)
  const { db, call } = setup(['adminMall.listProducts', 'adminMall.getShopConfig'], {
    platform_configs: [{ _id: 'shop', key: 'wechat_shop', enabled: false, appid }]
  })
  assert.equal((await call('adminMall', 'getShopConfig')).data.appid, appid)
  assert.equal((await call('adminMall', 'saveShopConfig', { enabled: true, appid })).code, 'ADMIN_FORBIDDEN')
  assert.equal(db.state.platform_configs[0].enabled, false)
  db.state.admin_groups[0].permissions.push('adminMall.saveShopConfig')
  assert.equal((await call('adminMall', 'saveShopConfig', { enabled: true, appid })).ok, true)
})
test('community deletion needs a distinct admin grant even for an editor', async () => {
  const id = 'map_community_' + 'a'.repeat(24)
  const { db, call } = setup(['communityMap.listAdmin', 'communityMap.saveAdmin'], {
    platform_configs: [{ _id: id, key: 'service_community', name: '花园', city: '上海市', cityKey: '上海',
      latitude: 31.2, longitude: 121.5, enabled: true, revision: 1, editVersion: 1 }],
    pet_playground_plots: [{ _id: 'plot', kind: 'plot', ownerOpenid: 'resident', communityId: 'scene' }]
  })
  assert.equal((await call('communityMap', 'deleteAdmin', { id, editVersion: 1 })).code, 'ADMIN_FORBIDDEN')
  assert.equal(db.state.platform_configs[0].enabled, true)
  db.state.admin_groups[0].permissions.push('communityMap.deleteAdmin')
  assert.equal((await call('communityMap', 'deleteAdmin', { id, editVersion: 1 })).ok, true)
  assert.equal(db.state.platform_configs[0].enabled, false)
  assert.equal(db.state.pet_playground_plots.length, 1)
})
test('owner-only catalog remains informational and cannot be delegated even by forged stored grants', async () => {
  const { call } = setup([...ownerActions])
  const catalog = await call('admin', 'getMyAdminAccess')
  assert.equal(catalog.ok, true)
  assert.ok(catalog.data.ownerTree.some(node => node.children.some(child => child.id === 'configMigration.import')))
  assert.equal(catalog.data.permissions.length, 0)
  for (const key of ownerActions) {
    const [module, action] = key.split('.')
    assert.equal((await call(module, action)).code, 'ADMIN_FORBIDDEN', key)
  }
})
test('order detail and evidence do not disclose private chat without the independent chat permission', async () => {
  const { db, call } = setup(['admin.getOrderDetail', 'admin.getEvidence'], {
    orders: [{ _id: 'o', clientOpenid: 'client', status: 'cancelled', paymentStatus: 'unpaid', payAmount: 0 }],
    order_session_messages: [{ _id: 'secret', orderId: 'o', content: 'private conversation', createdAt: new Date() }],
    risk_bypass_logs: [{ _id: 'risk', orderId: 'o', createdAt: new Date() }]
  })
  for (const action of ['getOrderDetail', 'getEvidence']) {
    const result = await call('admin', action, { id: 'o' })
    assert.equal(result.ok, true, result.message)
    assert.deepEqual(result.data.sessionMessages, [])
    assert.deepEqual(result.data.riskBypassLogs, [])
  }
  db.state.admin_groups[0].permissions.push('admin.listOrderSessionMessages')
  const allowed = await call('admin', 'getOrderDetail', { id: 'o' })
  assert.equal(allowed.data.sessionMessages[0]._id, 'secret')
})
test('questionnaire create/update cannot publish through payload flags without publish permission', async () => {
  const { db, call } = setup(['questionnaire.create', 'questionnaire.update'])
  const payload = { title: '服务反馈', targetRoles: ['client'], questions: [{ type: 'long_text', title: '请填写建议' }] }
  for (const flags of [{ publishImmediately: true }, { status: 'published' }]) {
    const rejected = await call('questionnaire', 'create', { ...payload, ...flags })
    assert.equal(rejected.code, 'ADMIN_FORBIDDEN', rejected.message)
  }
  assert.equal((db.state.questionnaires || []).length, 0)
  const draft = await call('questionnaire', 'create', payload)
  assert.equal(draft.ok, true, draft.message)
  const result = await call('questionnaire', 'update', { ...payload, id: draft.data._id, publishImmediately: true })
  assert.equal(result.code, 'ADMIN_FORBIDDEN')
  assert.equal(db.state.questionnaires[0].status, 'draft')
  db.state.admin_groups[0].permissions.push('questionnaire.publish')
  assert.equal((await call('questionnaire', 'update', { ...payload, id: draft.data._id, publishImmediately: true })).ok, true)
})

test('catalog covers all explicit admin page RPC calls and action visibility refers to real permissions', () => {
  const root = path.join(__dirname, '../../miniprogram/pages/admin')
  const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)])
  const all = new Set([...permissions, ...ownerActions, 'admin.getMyAdminAccess'])
  const modules = new Set(['admin', 'adminMall', 'configMigration', 'playgroundBuilding', 'playgroundFarm', 'playgroundAppearance', 'questionnaire', 'incident', 'payment'])
  for (const file of files(root)) {
    if (!/\.(js|wxml)$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/callFunction\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
      if (modules.has(match[1])) assert.ok(all.has(`${match[1]}.${match[2]}`), `${file}: ${match[1]}.${match[2]}`)
    }
    for (const match of source.matchAll(/adminPermissions\.([A-Za-z0-9]+)_([A-Za-z0-9]+)/g)) {
      assert.ok(permissions.has(`${match[1]}.${match[2]}`), `${file}: ${match[0]}`)
    }
    if (file.endsWith('.wxml')) {
      for (const match of source.matchAll(/<[A-Za-z](?:[^"'>]|"[^"]*"|'[^']*')*>/g)) {
        assert.ok((match[0].match(/\bwx:if=/g) || []).length <= 1, `${file}: duplicate wx:if`)
      }
    }
  }
})
