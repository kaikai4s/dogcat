const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('official account: system settings normalization, admin persistence, and public exposure', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'client_openid', roles: ['client'], status: 'active' }
    ],
    admins: [
      { _id: 'a1', openid: 'admin_openid', name: '总管理员', status: 'active', permissions: ['all'] }
    ],
    platform_configs: [],
    admin_operation_logs: []
  })

  const clientApi = loadCloudFunction('api', db, 'client_openid')
  const adminApi = loadCloudFunction('api', db, 'admin_openid')

  // 1. 默认情况下，客户端调用 getCustomerServiceInfo 和 getOfficialAccountConfig
  const defaultCsRes = await clientApi.main({ module: 'system', action: 'getCustomerServiceInfo' })
  assert.equal(defaultCsRes.ok, true)
  assert.equal(defaultCsRes.data.officialAccount.enabled, true)
  assert.equal(defaultCsRes.data.officialAccount.name, 'Dovelin 多芙琳宠物上门服务')
  assert.equal(defaultCsRes.data.officialAccountName, 'Dovelin 多芙琳宠物上门服务')

  const defaultOaRes = await clientApi.main({ module: 'system', action: 'getOfficialAccountConfig' })
  assert.equal(defaultOaRes.ok, true)
  assert.equal(defaultOaRes.data.name, 'Dovelin 多芙琳宠物上门服务')
  assert.equal(defaultOaRes.data.enableFollowBar, false)

  // 2. 管理员在后台保存服务号配置
  const saveRes = await adminApi.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      settings: {
        officialAccount: {
          enabled: true,
          name: '多芙琳宠护官方服务号',
          appId: 'wx1234567890abcdef',
          originalId: 'gh_9876543210ab',
          qrCodeUrl: 'cloud://test-env/official_account/qr_code_001.png',
          followGuideText: '关注服务号接收到家打卡提醒与上门动态',
          enableFollowBar: true
        }
      }
    }
  })
  assert.equal(saveRes.ok, true)
  assert.equal(saveRes.data.officialAccount.name, '多芙琳宠护官方服务号')
  assert.equal(saveRes.data.officialAccount.appId, 'wx1234567890abcdef')
  assert.equal(saveRes.data.officialAccount.originalId, 'gh_9876543210ab')
  assert.equal(saveRes.data.officialAccount.qrCodeUrl, 'cloud://test-env/official_account/qr_code_001.png')
  assert.equal(saveRes.data.officialAccount.enableFollowBar, true)
  // 向后兼容：customerService.officialAccountName 自动同步
  assert.equal(saveRes.data.customerService.officialAccountName, '多芙琳宠护官方服务号')

  // 3. 客户端再次获取客服信息与服务号配置，确认即时生效
  const updatedCsRes = await clientApi.main({ module: 'system', action: 'getCustomerServiceInfo' })
  assert.equal(updatedCsRes.ok, true)
  assert.equal(updatedCsRes.data.officialAccount.name, '多芙琳宠护官方服务号')
  assert.equal(updatedCsRes.data.officialAccount.appId, 'wx1234567890abcdef')
  assert.equal(updatedCsRes.data.officialAccount.originalId, 'gh_9876543210ab')
  assert.equal(updatedCsRes.data.officialAccount.qrCodeUrl, 'cloud://test-env/official_account/qr_code_001.png')
  assert.equal(updatedCsRes.data.officialAccount.followGuideText, '关注服务号接收到家打卡提醒与上门动态')
  assert.equal(updatedCsRes.data.officialAccount.enableFollowBar, true)

  const updatedOaRes = await clientApi.main({ module: 'system', action: 'getOfficialAccountConfig' })
  assert.equal(updatedOaRes.ok, true)
  assert.equal(updatedOaRes.data.name, '多芙琳宠护官方服务号')
  assert.equal(updatedOaRes.data.enableFollowBar, true)
})
