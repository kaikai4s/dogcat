const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('setupDatabase: initializes data without granting administrator identity', async (t) => {
  const previousSecret = process.env.INIT_ADMIN_SECRET
  process.env.INIT_ADMIN_SECRET = 'setup-test-secret'
  t.after(() => {
    if (previousSecret === undefined) delete process.env.INIT_ADMIN_SECRET
    else process.env.INIT_ADMIN_SECRET = previousSecret
  })
  const db = createCollectionStore({})
  const api = loadCloudFunction('api', db, 'openid_super_admin')

  const res = await api.main({
    module: 'initData',
    action: 'setupDatabase',
    data: {
      adminOpenid: 'openid_super_admin',
      secret: 'setup-test-secret'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.success, true)
  assert.equal(res.data.totalCollections, 98)
  assert.equal(res.data.totalIndexesConfigured, 64)
  for (const name of ['idx_map_admin_city', 'idx_map_candidates_staff', 'idx_map_candidates_orders', 'idx_map_application_city', 'idx_map_application_pending']) assert.ok(res.data.indexResults.some(index => index.name === name))
  assert.ok(res.data.indexResults.some(index => index.collection === 'ai_chat_records' && index.name === 'idx_ai_history_owner_time'))
  assert.ok(res.data.indexResults.some(index => index.collection === 'ai_chat_records' && index.name === 'idx_ai_history_pet_time'))
  assert.ok(res.data.pricesInitialized > 0)
  assert.ok(res.data.checkinRulesInitialized > 0)
  assert.equal(res.data.settingsInitialized, true)
  assert.equal(res.data.initialAdminBound, null)
  assert.equal(db.state.users.length, 0)

  // 验证服务价格已初始化
  assert.ok(db.state.service_prices.length >= 7)
  // 验证打卡规则已初始化
  assert.ok(db.state.service_checkin_rules.length > 0)
  // 验证集合已初始化
  assert.ok(Array.isArray(db.state.pet_beauty_bonus_votes))
  assert.ok(Array.isArray(db.state.questionnaires))
  assert.ok(Array.isArray(db.state.questionnaire_responses))
  assert.ok(Array.isArray(db.state.user_asset_earnings))
  assert.ok(Array.isArray(db.state.wechat_transfer_quota_ledger))
  assert.ok(Array.isArray(db.state.pet_vaccine_certifications))
  assert.ok(Array.isArray(db.state.subscription_balances))
  assert.ok(Array.isArray(db.state.subscription_balance_events))
  assert.ok(Array.isArray(db.state.pet_playground_live))
  assert.ok(Array.isArray(db.state.pet_playground_appearance_requests))
  assert.ok(Array.isArray(db.state.pet_playground_appearance_bindings))
  assert.ok(Array.isArray(db.state.pet_playground_disputes))
  assert.ok(Array.isArray(db.state.pet_playground_accidents))
  assert.ok(Array.isArray(db.state.pet_playground_jail))
  assert.ok(Array.isArray(db.state.ai_chat_records))
})

test('bootstrap fails closed without configured secret before any initialization', async (t) => {
  const previousSecret = process.env.INIT_ADMIN_SECRET
  delete process.env.INIT_ADMIN_SECRET
  t.after(() => {
    if (previousSecret !== undefined) process.env.INIT_ADMIN_SECRET = previousSecret
  })
  const db = createCollectionStore({ users: [] })
  const api = loadCloudFunction('api', db, 'attacker')
  for (const action of ['setupDatabase', 'initAllCollections', 'checkCollections', 'buildNotificationIndexes', 'setupNotificationIndexes']) {
    const result = await api.main({ module: 'initData', action, data: { adminOpenid: 'attacker', secret: 'anything' } })
    assert.equal(result.ok, false, action)
    assert.match(result.message, /初始管理员配置未完成/)
  }
  assert.deepEqual(db.state.users, [])
  assert.equal(db.state.service_prices, undefined)
  assert.equal(db.state.system_settings, undefined)
})

test('bootstrap with a valid secret never upgrades an arbitrary user; explicit whitelisted claim remains available', async (t) => {
  const previousSecret = process.env.INIT_ADMIN_SECRET
  const previousPhones = process.env.INIT_ADMIN_PHONES
  process.env.INIT_ADMIN_SECRET = 'explicit-bootstrap'
  process.env.INIT_ADMIN_PHONES = '13900000001'
  t.after(() => {
    if (previousSecret === undefined) delete process.env.INIT_ADMIN_SECRET
    else process.env.INIT_ADMIN_SECRET = previousSecret
    if (previousPhones === undefined) delete process.env.INIT_ADMIN_PHONES
    else process.env.INIT_ADMIN_PHONES = previousPhones
  })
  const db = createCollectionStore({ users: [
    { _id: 'claimant', openid: 'claimant', roles: ['client'], status: 'active', phone: '13900000001' },
    { _id: 'target', openid: 'target', roles: ['client'], status: 'active', phone: '13800000000' }
  ] })
  const api = loadCloudFunction('api', db, 'claimant')
  const wrong = await api.main({ module: 'initData', action: 'setupDatabase', data: { secret: 'wrong' } })
  assert.equal(wrong.ok, false)
  assert.match(wrong.message, /初始化密钥不正确/)
  for (const action of ['setupDatabase', 'initAllCollections']) {
    const setup = await api.main({ module: 'initData', action, data: { secret: 'explicit-bootstrap', adminOpenid: 'target' } })
    assert.equal(setup.ok, true, setup.message)
    assert.equal(setup.data.initialAdminBound, null)
    assert.ok(db.state.users.every(row => !row.roles.includes('admin')))
  }
  const claim = await api.main({ module: 'initData', action: 'claimInitialAdmin', data: { secret: 'explicit-bootstrap' } })
  assert.equal(claim.ok, true, claim.message)
  assert.ok(db.state.users.find(row => row._id === 'claimant').roles.includes('admin'))
  assert.deepEqual(db.state.users.find(row => row._id === 'target').roles, ['client'])
  const client = loadCloudFunction('api', db, 'target')
  const denied = await client.main({ module: 'initData', action: 'setupDatabase', data: { secret: 'explicit-bootstrap' } })
  assert.equal(denied.ok, false)
})

test('buildNotificationIndexes: builds indexes specifically for system_notifications and user_notification_reads', async () => {
  const db = createCollectionStore({
    users: [{ openid: 'admin_openid', roles: ['admin'], activeRole: 'admin', status: 'active' }]
  })
  const api = loadCloudFunction('api', db, 'admin_openid')

  const res = await api.main({
    module: 'initData',
    action: 'buildNotificationIndexes'
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.success, true)
  assert.equal(res.data.total, 3)
  assert.equal(res.data.results.length, 3)
  const collectionsCovered = res.data.results.map(r => r.collection)
  assert.ok(collectionsCovered.includes('system_notifications'))
  assert.ok(collectionsCovered.includes('user_notification_reads'))
})

