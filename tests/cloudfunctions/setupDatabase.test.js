const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('setupDatabase: initializes collections and seeds default prices and checkin rules', async () => {
  const db = createCollectionStore({})
  const api = loadCloudFunction('api', db, 'openid_super_admin')

  const res = await api.main({
    module: 'initData',
    action: 'setupDatabase',
    data: {
      adminOpenid: 'openid_super_admin'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.success, true)
  assert.equal(res.data.totalCollections, 73)
  assert.ok(res.data.pricesInitialized > 0)
  assert.ok(res.data.checkinRulesInitialized > 0)
  assert.equal(res.data.settingsInitialized, true)
  assert.equal(res.data.initialAdminBound, 'openid_super_admin')

  // 验证 users 中首位管理员已创建
  const adminUser = db.state.users.find(u => u.openid === 'openid_super_admin')
  assert.ok(adminUser)
  assert.ok(adminUser.roles.includes('admin'))
  assert.equal(adminUser.activeRole, 'admin')

  // 验证服务价格已初始化
  assert.ok(db.state.service_prices.length >= 7)
  // 验证打卡规则已初始化
  assert.ok(db.state.service_checkin_rules.length > 0)
})
