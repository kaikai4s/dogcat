const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('disposable supplies config includes shoe covers and admin can configure purchase urls', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'staff_openid', roles: ['staff'], status: 'active' }
    ],
    admins: [
      { _id: 'a1', openid: 'admin_openid', name: '总管理员', status: 'active', permissions: ['all'] }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'staff_openid',
        realName: '张宠托',
        auditStatus: 'approved',
        staffLevel: 'certified',
        onboardingStatus: 'videos_completed',
        quizPassedAt: '2026-09-20 10:00',
        trainingVideosCompletedAt: '2026-09-20 11:00',
        videoAuditStatus: 'approved'
      }
    ],
    platform_configs: [],
    admin_operation_logs: []
  })

  const adminApi = loadCloudFunction('api', db, 'admin_openid')
  const staffApi = loadCloudFunction('api', db, 'staff_openid')
  const publicApi = loadCloudFunction('api', db, 'any_user_openid')

  // 1. 初始状态：通过公共设置和培训状态查询，默认物品包含一次性鞋套
  const initialSettings = await publicApi.main({ action: 'getSettings', module: 'system' })
  assert.equal(initialSettings.ok, true)
  const initialItems = initialSettings.data.staffSupplies.items
  assert.ok(Array.isArray(initialItems))
  assert.ok(initialItems.some((item) => item.name === '一次性鞋套'), '默认物品列表中必须包含一次性鞋套')
  assert.ok(initialSettings.data.staffSupplies.requiredItems.includes('一次性鞋套'))
  assert.ok(initialSettings.data.staffTraining.videoAuditGuide.requiredItemsNotice.includes('一次性鞋套'))

  // 2. 管理员在后台上传配置每个一次性物品的购买链接与说明
  const configuredItems = [
    {
      id: 'supply_gloves',
      name: '一次性手套',
      description: '医用级防抓咬防接触感染，足量备齐',
      purchaseUrl: 'https://mall.example.com/items/gloves-100pcs',
      enabled: true
    },
    {
      id: 'supply_mask',
      name: '一次性口罩',
      description: '三层防护医用口罩，全程规范佩戴',
      purchaseUrl: 'https://mall.example.com/items/medical-masks',
      enabled: true
    },
    {
      id: 'supply_shoes',
      name: '一次性鞋套',
      description: '加厚防滑入户鞋套，进门即穿戴',
      purchaseUrl: 'https://mall.example.com/items/shoe-covers-thick',
      enabled: true
    },
    {
      id: 'supply_disinfectant',
      name: '安全宠物消毒用品',
      description: '次氯酸宠物无毒喷雾，入户及随身工具消毒',
      purchaseUrl: 'https://mall.example.com/items/pet-disinfectant-spray',
      enabled: true
    }
  ]

  const currentSettings = initialSettings.data
  const saveRes = await adminApi.main({
    action: 'saveSystemSettings',
    module: 'admin',
    data: {
      ...currentSettings,
      staffSupplies: {
        ...currentSettings.staffSupplies,
        items: configuredItems
      }
    }
  })
  assert.equal(saveRes.ok, true)

  // 3. 宠托师获取培训状态，核验一次性鞋套及购买链接
  const trainingRes = await staffApi.main({ action: 'getTrainingStatus', module: 'staff' })
  assert.equal(trainingRes.ok, true)
  const trainingSupplies = trainingRes.data.supplies
  assert.ok(trainingSupplies)
  const shoeCoverItem = trainingSupplies.items.find((item) => item.name === '一次性鞋套')
  assert.ok(shoeCoverItem, '培训必备用品中应包含一次性鞋套')
  assert.equal(shoeCoverItem.purchaseUrl, 'https://mall.example.com/items/shoe-covers-thick', '正确返回一次性鞋套购买链接')

  // 4. 宠托师获取报销状态，核验包含购买链接的用品配置
  const reimburseRes = await staffApi.main({ action: 'getSupplyReimbursementStatus', module: 'staff' })
  assert.equal(reimburseRes.ok, true)
  const reimburseSupplies = reimburseRes.data.supplies
  assert.ok(reimburseSupplies)
  assert.equal(reimburseSupplies.items.length, 4)
  assert.equal(reimburseSupplies.items[0].purchaseUrl, 'https://mall.example.com/items/gloves-100pcs')
  assert.equal(reimburseSupplies.items[2].name, '一次性鞋套')
  assert.equal(reimburseSupplies.items[2].purchaseUrl, 'https://mall.example.com/items/shoe-covers-thick')

  // 5. 校验审计日志有记录
  assert.ok(db.state.admin_operation_logs.some((log) => log.action === 'saveSystemSettings'))
})
