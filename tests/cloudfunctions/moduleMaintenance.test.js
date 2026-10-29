const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function fixture() {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'inviter', openid: 'inviter', roles: ['client'], status: 'active', inviteCode: 'INVITER' }
    ],
    pets: [{ _id: 'pet', openid: 'client', name: '可乐', weight: 10 }],
    orders: [], user_invites: [], user_asset_earnings: [], platform_configs: [], admin_operation_logs: []
  })
  return { db, admin: loadCloudFunction('api', db, 'admin'), client: loadCloudFunction('api', db, 'client') }
}

test('admin maintenance switches default off, persist independently and preserve untouched flags', async () => {
  const { admin, client } = fixture()
  const initial = await client.main({ module: 'system', action: 'getSettings' })
  assert.deepEqual(initial.data.maintenance, { petRanking: false, booking: false, invitation: false })
  const first = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { maintenance: { petRanking: true, booking: true, invitation: true } } })
  assert.equal(first.ok, true, first.message)
  const second = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { maintenance: { booking: false } } })
  assert.equal(second.ok, true, second.message)
  const publicSettings = await client.main({ module: 'system', action: 'getSettings' })
  assert.deepEqual(publicSettings.data.maintenance, { petRanking: true, booking: false, invitation: true })
})

test('saving only maintenance preserves published notices, while explicitly clearing notices still works', async () => {
  const { admin, client } = fixture()
  const noticeTicker = { enabled: true, items: ['预约前请核对联系方式'] }
  const published = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { noticeTicker } })
  assert.equal(published.ok, true, published.message)

  const partial = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { maintenance: { booking: true } } })
  assert.equal(partial.ok, true, partial.message)
  assert.deepEqual(partial.data.noticeTicker, noticeTicker)
  const publicSettings = await client.main({ module: 'system', action: 'getSettings' })
  assert.deepEqual(publicSettings.data.noticeTicker, noticeTicker)

  const cleared = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { noticeTicker: { enabled: false, items: [] } } })
  assert.equal(cleared.ok, true, cleared.message)
  assert.deepEqual(cleared.data.noticeTicker, { enabled: false, items: [] })
})

test('general cover is public, survives partial saves, and can be removed explicitly', async () => {
  const { admin, client } = fixture()
  const imageUrl = 'cloud://test/general_share/cover.jpg'
  const invalid = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { generalShare: { imageUrl: '/private/file.jpg' } } })
  assert.equal(invalid.ok, false)
  const saved = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { generalShare: { imageUrl } } })
  assert.equal(saved.ok, true, saved.message)
  await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { maintenance: { booking: true } } })
  const publicSettings = await client.main({ module: 'system', action: 'getSettings' })
  assert.equal(publicSettings.data.generalShare.imageUrl, imageUrl)
  const removed = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { generalShare: { imageUrl: '' } } })
  assert.equal(removed.ok, true, removed.message)
  assert.equal(removed.data.generalShare.imageUrl, '')
})

test('ranking maintenance rejects reads and voting; booking maintenance rejects quote/create but not order history', async () => {
  const { db, client } = fixture()
  const settings = { _id: 'settings', key: 'system_settings', value: { maintenance: { petRanking: true, booking: true } } }
  db.state.platform_configs.push(settings)
  for (const action of ['getActivityHome', 'listRanking', 'vote']) {
    const result = await client.main({ module: 'petBeauty', action, data: { petId: 'pet' } })
    assert.equal(result.ok, false, action)
    assert.equal(result.code, 'MODULE_MAINTENANCE')
    assert.match(result.message, /宠物排行榜.*正在维护中/)
  }
  for (const action of ['quoteOrder', 'createOrder']) {
    const result = await client.main({ module: 'order', action, data: { petId: 'pet' } })
    assert.equal(result.ok, false, action)
    assert.equal(result.code, 'MODULE_MAINTENANCE')
    assert.match(result.message, /预约下单.*正在维护中/)
  }
  assert.equal(db.state.orders.length, 0)
  const list = await client.main({ module: 'order', action: 'listMyOrders' })
  assert.notEqual(list.code, 'MODULE_MAINTENANCE')
  settings.value.maintenance = { petRanking: false, booking: false }
  const allowed = await client.main({ module: 'order', action: 'quoteOrder', data: { petId: 'pet' } })
  assert.notEqual(allowed.code, 'MODULE_MAINTENANCE')
})

test('invitation maintenance prevents direct and login-based binding while asset summary stays available', async () => {
  const { db, client } = fixture()
  db.state.platform_configs.push({ _id: 'settings', key: 'system_settings', value: { maintenance: { invitation: true } } })
  const direct = await client.main({ module: 'finance', action: 'bindInviteCode', data: { inviteCode: 'INVITER' } })
  assert.equal(direct.ok, false)
  assert.equal(direct.code, 'MODULE_MAINTENANCE')
  const login = await client.main({ module: 'auth', action: 'login', data: { inviteCode: 'INVITER' } })
  assert.equal(login.ok, true, login.message)
  assert.equal(db.state.users.find(user => user.openid === 'client').inviterOpenid, undefined)
  assert.equal(db.state.user_invites.length, 0)
  const assets = await client.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(assets.ok, true, assets.message)
  db.state.platform_configs[0].value.maintenance.invitation = false
  const resumed = await client.main({ module: 'finance', action: 'bindInviteCode', data: { inviteCode: 'INVITER' } })
  assert.equal(resumed.ok, true, resumed.message)
  assert.equal(db.state.user_invites.length, 1)
})

test('booking maintenance blocks unpaid service payments without affecting mall payments', async () => {
  const { db, client } = fixture()
  db.state.platform_configs.push({ _id: 'settings', key: 'system_settings', value: { maintenance: { booking: true }, payment: { mode: 'mock' } } })
  db.state.orders.push({ _id: 'service', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 39, createdAt: new Date() })
  db.state.mall_orders = [{ _id: 'mall', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 25, createdAt: new Date() }]
  for (const action of ['createPayment', 'mockPayOrder']) {
    const service = await client.main({ module: 'payment', action, data: { orderId: 'service' } })
    assert.equal(service.ok, false, action)
    assert.equal(service.code, 'MODULE_MAINTENANCE')
  }
  const mall = await client.main({ module: 'payment', action: 'createPayment', data: { orderId: 'mall' } })
  assert.equal(mall.ok, true, mall.message)
  assert.equal(mall.data.mock, true)
})
