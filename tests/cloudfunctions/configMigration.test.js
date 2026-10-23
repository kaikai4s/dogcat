const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const SOURCE = 'cloud1-5gnhqn4t0554c1d9'
const TARGET = 'production-d2g5jx277f41a81a6'
const SOURCE_ROOT = 'cloud://' + SOURCE + '.636c-' + SOURCE + '-1310870236'
const TARGET_ROOT = 'cloud://' + TARGET + '.7072-' + TARGET + '-1310870236'
const owner = { _id: 'owner', openid: 'owner', roles: ['admin'], status: 'active' }
const copy = value => structuredClone(value)
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
function rehash(snapshot) { snapshot.checksum = crypto.createHash('sha256').update(canonical(snapshot.sections)).digest('hex'); return snapshot }
function setup(env, extra = {}) {
  const db = createCollectionStore({ users: [copy(owner)], ...extra })
  const api = loadCloudFunction('api', db, 'owner', { wxContext: { ENV: env, APPID: 'same-app' } })
  const call = (action, data = {}) => api.main({ module: 'configMigration', action, data })
  return { db, api, call }
}
async function exported(extra = {}) {
  const source = setup(SOURCE, extra)
  const result = await source.call('export')
  assert.equal(result.ok, true, result.message)
  return result.data
}
async function apply(target, snapshot, requestId = 'migration_test_123') {
  const preview = await target.call('preview', { snapshot })
  assert.equal(preview.ok, true, preview.message)
  return target.call('import', { snapshot, token: preview.data.token, requestId, confirmEnvId: TARGET })
}

test('export includes all config sections and defaults but excludes people, orders, keys and admin policy', async () => {
  const snapshot = await exported({
    orders: [{ _id: 'private-order' }], admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      payment: { mode: 'wechat', mchId: 'merchant', apiV3Key: 'PAYMENT_SECRET', privateKey: 'PRIVATE_KEY' },
      qwenApiKey: 'AI_SECRET', logistics: { key: 'LOGISTICS_SECRET', appCode: 'APP_CODE', juheKey: 'JUHE_EXP_SECRET_123456789', juheKeyInput: 'JUHE_INPUT_SECRET_123456789' },
      staffSupplies: { transfer: { enabled: true, sceneId: 'PAYOUT_SCENE' } }, customerService: { phone: '19900000000' }
    } }]
  })
  assert.equal(Object.keys(snapshot.sections).length, 13)
  assert.ok(snapshot.sections.prices.length > 0 && snapshot.sections.checkinRules.length > 0)
  const text = JSON.stringify(snapshot)
  for (const secret of ['PAYMENT_SECRET', 'PRIVATE_KEY', 'AI_SECRET', 'LOGISTICS_SECRET', 'JUHE_EXP_SECRET_123456789', 'JUHE_INPUT_SECRET_123456789', 'APP_CODE', 'PAYOUT_SCENE', 'private-order']) assert.ok(!text.includes(secret), secret)
  assert.equal(snapshot.sections.system[0].value.customerService.phone, '19900000000')
  assert.equal(snapshot.source.envId, SOURCE)
})

test('cross-env preview rewrites assets, then atomic import retains destination payment keys and disables test mode', async () => {
  const snapshot = await exported({ platform_configs: [{ _id: 's', key: 'system_settings', value: {
    enableTestAddressMode: true, payment: { mode: 'mock' }, customerService: { phone: '19900000000' },
    homeHeroCarousel: { enabled: true, items: [{ id: 'hero', type: 'image', fileId: SOURCE_ROOT + '/banners/hero.png', enabled: true }] }
  } }] })
  const target = setup(TARGET, { platform_configs: [{ _id: 'production-settings', key: 'system_settings', value: {
    payment: { mode: 'wechat', mchId: 'production-merchant', apiV3Key: 'production-secret' },
    qwenApiKey: 'production-ai-secret', logistics: { key: 'production-logistics', juheKey: 'production-juhe-secret' }, staffSupplies: { transfer: { enabled: true, sceneId: 'production-scene' } }
  } }], orders: [{ _id: 'keep-order', status: 'paid' }] })
  const preview = await target.call('preview', { snapshot })
  assert.equal(preview.ok, true, preview.message)
  assert.ok(preview.data.assets.some(file => file.target === TARGET_ROOT + '/banners/hero.png'))
  const result = await target.call('import', { snapshot, token: preview.data.token, requestId: 'import_atomic_123', confirmEnvId: TARGET })
  assert.equal(result.ok, true, result.message)
  const settings = target.db.state.platform_configs.find(row => row.key === 'system_settings').value
  assert.equal(settings.payment.mode, 'wechat')
  assert.equal(settings.payment.apiV3Key, 'production-secret')
  assert.equal(settings.payment.mchId, 'production-merchant')
  assert.equal(settings.qwenApiKey, 'production-ai-secret')
  assert.equal(settings.logistics.key, 'production-logistics')
  assert.equal(settings.logistics.juheKey, 'production-juhe-secret')
  assert.equal(settings.staffSupplies.transfer.sceneId, 'production-scene')
  assert.equal(settings.enableTestAddressMode, false)
  assert.equal(target.db.state.orders[0].status, 'paid')
  assert.equal((target.db.state.config_migration_backups || []).length, 1)
  assert.equal(target.db.state.admin_operation_logs.filter(row => row.action === 'importConfiguration').length, 1)
  const backup = await target.call('backup', { id: result.data.backupId })
  assert.equal(backup.ok, true)
  assert.ok(!JSON.stringify(backup.data).includes('production-secret'))
})

test('same business keys map existing IDs and preserve target-only configs and references', async () => {
  const snapshot = await exported({ member_levels: [{ _id: 'dev-level', name: 'VIP', minPoints: 100, pointMultiplier: 2 }],
    pet_titles: [{ _id: 'title', name: '会员之星', autoGrantLevelIds: ['dev-level'] }],
    service_prices: [{ _id: 'dev-price', key: 'feed', label: '喂食', price: 88 }] })
  const target = setup(TARGET, { member_levels: [{ _id: 'prod-level', name: 'VIP', minPoints: 50, pointMultiplier: 1 }, { _id: 'only-target', name: '独有等级', minPoints: 999, pointMultiplier: 3 }],
    service_prices: [{ _id: 'prod-price', key: 'feed', label: '喂食', price: 30 }] })
  const result = await apply(target, snapshot)
  assert.equal(result.ok, true, result.message)
  assert.equal(target.db.state.member_levels.length, 2)
  assert.equal(target.db.state.member_levels.find(row => row._id === 'prod-level').minPoints, 100)
  assert.deepEqual(target.db.state.pet_titles[0].autoGrantLevelIds, ['prod-level'])
  assert.equal(target.db.state.service_prices.length, snapshot.sections.prices.length)
  assert.equal(target.db.state.service_prices.find(row => row.key === 'feed')._id, 'prod-price')
  assert.equal(target.db.state.service_prices.find(row => row.key === 'feed').price, 88)
})

test('stale previews are rejected without writes and repeated import requests are idempotent', async () => {
  const snapshot = await exported()
  const target = setup(TARGET)
  const preview = await target.call('preview', { snapshot })
  target.db.state.service_prices.push({ _id: 'concurrent', key: 'feed', label: '并发改价', price: 99 })
  const rejected = await target.call('import', { snapshot, token: preview.data.token, requestId: 'stale_preview_123', confirmEnvId: TARGET })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /重新预览/)
  assert.equal((target.db.state.config_migration_backups || []).length, 0)
  const next = await target.call('preview', { snapshot })
  const data = { snapshot, token: next.data.token, requestId: 'repeat_import_123', confirmEnvId: TARGET }
  const first = await target.call('import', data), second = await target.call('import', data)
  assert.equal(first.ok, true, first.message)
  assert.equal(second.ok, true, second.message)
  assert.equal(first.data.backupId, second.data.backupId)
  assert.equal((target.db.state.config_migration_backups || []).length, 1)
})

test('runtime stock, issued coupons, sales and questionnaire counts are not imported from test data', async () => {
  const snapshot = await exported({
    mall_products: [{ _id: 'product', name: '宠物用品', coverFileId: SOURCE_ROOT + '/product.jpg', price: 10, stock: 99, salesCount: 100 }],
    coupon_templates: [{ _id: 'coupon', name: '优惠券', discountAmount: 10, minOrderAmount: 20, issuedCount: 99 }],
    questionnaires: [{ _id: 'survey', title: '调查', targetRoles: ['client'], questions: [{ id: 'q', type: 'short_text', title: '建议', required: false }], status: 'published', responseCount: 99 }]
  })
  const target = setup(TARGET, {
    mall_products: [{ _id: 'product', name: '宠物用品', coverFileId: TARGET_ROOT + '/product.jpg', price: 5, stock: 3, salesCount: 7 }],
    coupon_templates: [{ _id: 'coupon', name: '优惠券', discountAmount: 5, minOrderAmount: 10, issuedCount: 4 }]
  })
  const result = await apply(target, snapshot)
  assert.equal(result.ok, true, result.message)
  assert.equal(target.db.state.mall_products[0].stock, 3)
  assert.equal(target.db.state.mall_products[0].skus[0].stock, 3)
  assert.equal(target.db.state.mall_products[0].salesCount, 7)
  assert.equal(target.db.state.coupon_templates[0].issuedCount, 4)
  assert.equal(target.db.state.questionnaires[0].responseCount, 0)
  assert.equal(target.db.state.questionnaires[0].status, 'draft')
})

test('bad files, foreign apps, unsupported sections and broken references never reach writes', async () => {
  const snapshot = await exported()
  const target = setup(TARGET)
  const cases = []
  let broken = copy(snapshot); broken.sections.system[0].value.customerService.phone = 'tampered'; cases.push(broken)
  broken = copy(snapshot); broken.version = 99; cases.push(broken)
  broken = copy(snapshot); broken.source.appId = 'other-app'; cases.push(broken)
  broken = copy(snapshot); broken.sections.users = [{ _id: 'evil' }]; cases.push(rehash(broken))
  broken = copy(snapshot); broken.sections.petTitles.push({ _id: 'bad-title', name: '无效等级', autoGrantLevelIds: ['missing'] }); cases.push(rehash(broken))
  broken = copy(snapshot); broken.sections.system[0].value.customerService.image = 'cloud://thirdparty.bucket/file.png'; cases.push(rehash(broken))
  for (const input of cases) {
    const response = await target.call('preview', { snapshot: input })
    assert.equal(response.ok, false)
  }
  assert.equal(target.db.state.platform_configs.length, 0)
  assert.equal((target.db.state.config_migration_backups || []).length, 0)
})

test('delegated admins with settings permission cannot export, preview, import or read backups', async () => {
  const target = setup(TARGET, { users: [copy(owner), { _id: 'delegate', openid: 'delegate', roles: ['admin'], status: 'active' }],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    admin_memberships: [{ _id: 'delegate', groupIds: ['settings'] }],
    admin_groups: [{ _id: 'settings', enabled: true, permissions: ['admin.getSystemSettings'] }] })
  const fn = loadCloudFunction('api', target.db, 'delegate', { wxContext: { ENV: TARGET } })
  for (const action of ['export', 'preview', 'import', 'backup']) {
    const response = await fn.main({ module: 'configMigration', action, data: {} })
    assert.equal(response.ok, false)
    assert.match(response.message, /权限/)
  }
})

test('failed configuration write rolls back backup and every preceding write', async () => {
  const snapshot = await exported()
  const target = setup(TARGET)
  const preview = await target.call('preview', { snapshot })
  const original = target.db.runTransaction
  target.db.runTransaction = callback => original(async tx => {
    const realCollection = tx.collection
    return callback({ collection(name) {
      const collection = realCollection(name)
      if (name !== 'service_checkin_rules') return collection
      return new Proxy(collection, { get(obj, key) {
        if (key === 'doc') return id => { const doc = obj.doc(id); return { ...doc, set: async () => { throw new Error('simulated write failure') } } }
        return typeof obj[key] === 'function' ? obj[key].bind(obj) : obj[key]
      } })
    } })
  })
  const result = await target.call('import', { snapshot, token: preview.data.token, confirmEnvId: TARGET, requestId: 'rollback_1234' })
  assert.equal(result.ok, false)
  assert.equal(target.db.state.service_prices.length, 0)
  assert.equal((target.db.state.config_migration_backups || []).length, 0)
  assert.match(result.message, /simulated write failure/)
  assert.equal((target.db.state.admin_operation_logs || []).length, 0)
})

test('export paginates beyond 100 configuration rows without silently truncating them', async () => {
  const snapshot = await exported({ coupon_templates: Array.from({ length: 125 }, (_, i) => ({ _id: 'coupon_' + String(i).padStart(3, '0'), name: '优惠券' + i, discountAmount: 1, minOrderAmount: 2 })) })
  assert.equal(snapshot.sections.coupons.length, 125)
  assert.equal(snapshot.sections.coupons.at(-1)._id, 'coupon_124')
  const target = setup(TARGET)
  const result = await apply(target, snapshot)
  assert.equal(result.ok, true, result.message)
  assert.equal(target.db.state.coupon_templates.length, 125)
})

test('invalid prices, duplicate business keys and undersized land fail preview without changing configuration', async () => {
  const original = await exported()
  const target = setup(TARGET)
  let snapshot = copy(original)
  snapshot.sections.prices[0].price = -1
  assert.equal((await target.call('preview', { snapshot: rehash(snapshot) })).ok, false)
  snapshot = copy(original)
  snapshot.sections.prices.push({ ...snapshot.sections.prices[0], _id: 'duplicate-price' })
  assert.equal((await target.call('preview', { snapshot: rehash(snapshot) })).ok, false)
  target.db.state.pet_playground_plots.push({ _id: 'world_config_v2', width: 4000, height: 4000, usedWidth: 3000, usedHeight: 3000 })
  const tooSmall = await target.call('preview', { snapshot: original })
  assert.equal(tooSmall.ok, false)
  assert.match(tooSmall.message, /已使用范围/)
  assert.equal(target.db.state.pet_playground_plots[0].width, 4000)
})

test('transaction rechecks owner permissions and ignores injected payment credentials', async () => {
  const snapshot = await exported()
  snapshot.sections.system[0].value.payment = { mode: 'mock', apiV3Key: 'injected-key' }
  rehash(snapshot)
  const target = setup(TARGET, { platform_configs: [{ _id: 'settings', key: 'system_settings', value: { payment: { mode: 'wechat', apiV3Key: 'actual-secret' } } }] })
  const result = await apply(target, snapshot)
  assert.equal(result.ok, true, result.message)
  assert.equal(target.db.state.platform_configs.find(row => row.key === 'system_settings').value.payment.apiV3Key, 'actual-secret')
  const preview = await target.call('preview', { snapshot })
  target.db.state.admin_access_config.push({ _id: 'policy', enabled: true, ownerOpenid: 'other-owner' })
  const denied = await target.call('import', { snapshot, token: preview.data.token, confirmEnvId: TARGET, requestId: 'permissions_123' })
  assert.equal(denied.ok, false)
})
