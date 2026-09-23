const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('client address null safety: deleteAddress and setDefaultAddress handle non-existent, empty ID, and deleted documents gracefully', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client_1', roles: ['client'], status: 'active' },
      { _id: 'u2', openid: 'openid_client_2', roles: ['client'], status: 'active' }
    ],
    user_addresses: [
      {
        _id: 'addr_1',
        openid: 'openid_client_1',
        label: '家',
        serviceAddress: '测试小区A栋',
        isDefault: true,
        updatedAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'addr_2',
        openid: 'openid_client_1',
        label: '公司',
        serviceAddress: '软件园B栋',
        isDefault: false,
        updatedAt: '2026-09-01 11:00:00'
      },
      {
        _id: 'addr_other',
        openid: 'openid_client_2',
        label: '其他用户家',
        serviceAddress: '远方小区C栋',
        isDefault: true,
        updatedAt: '2026-09-01 12:00:00'
      }
    ]
  })

  const client1Api = loadCloudFunction('api', db, 'openid_client_1')

  // --- 测试 deleteAddress ---

  // 1. 传入空 ID
  const deleteEmptyRes = await client1Api.main({
    module: 'client',
    action: 'deleteAddress',
    data: {}
  })
  assert.equal(deleteEmptyRes.ok, false)
  assert.equal(deleteEmptyRes.message, '缺少地址ID')

  // 2. 传入不存在的 ID
  const deleteNonExistentRes = await client1Api.main({
    module: 'client',
    action: 'deleteAddress',
    data: { id: 'addr_not_found_999' }
  })
  assert.equal(deleteNonExistentRes.ok, false)
  assert.equal(deleteNonExistentRes.message, '地址不存在')

  // 3. 越权删除他人地址
  const deleteUnauthorizedRes = await client1Api.main({
    module: 'client',
    action: 'deleteAddress',
    data: { id: 'addr_other' }
  })
  assert.equal(deleteUnauthorizedRes.ok, false)
  assert.equal(deleteUnauthorizedRes.message, '无权操作地址')

  // 4. 正常删除本人地址
  const deleteSuccessRes = await client1Api.main({
    module: 'client',
    action: 'deleteAddress',
    data: { id: 'addr_1' }
  })
  assert.equal(deleteSuccessRes.ok, true)
  assert.equal(deleteSuccessRes.data.id, 'addr_1')
  assert.equal(db.state.user_addresses.some((a) => a._id === 'addr_1'), false)

  // 5. 二次删除已被删除的地址（模拟并发删除或重复点击）
  const deleteAgainRes = await client1Api.main({
    module: 'client',
    action: 'deleteAddress',
    data: { id: 'addr_1' }
  })
  assert.equal(deleteAgainRes.ok, false)
  assert.equal(deleteAgainRes.message, '地址不存在')

  // --- 测试 setDefaultAddress ---

  // 6. 传入空 ID
  const setDefaultEmptyRes = await client1Api.main({
    module: 'client',
    action: 'setDefaultAddress',
    data: {}
  })
  assert.equal(setDefaultEmptyRes.ok, false)
  assert.equal(setDefaultEmptyRes.message, '缺少地址ID')

  // 7. 传入不存在的 ID
  const setDefaultNonExistentRes = await client1Api.main({
    module: 'client',
    action: 'setDefaultAddress',
    data: { id: 'addr_not_found_999' }
  })
  assert.equal(setDefaultNonExistentRes.ok, false)
  assert.equal(setDefaultNonExistentRes.message, '地址不存在')

  // 8. 越权设置他人地址为默认地址
  const setDefaultUnauthorizedRes = await client1Api.main({
    module: 'client',
    action: 'setDefaultAddress',
    data: { id: 'addr_other' }
  })
  assert.equal(setDefaultUnauthorizedRes.ok, false)
  assert.equal(setDefaultUnauthorizedRes.message, '无权操作地址')

  // 9. 正常将 addr_2 设为默认地址
  const setDefaultSuccessRes = await client1Api.main({
    module: 'client',
    action: 'setDefaultAddress',
    data: { id: 'addr_2' }
  })
  assert.equal(setDefaultSuccessRes.ok, true)
  assert.equal(setDefaultSuccessRes.data.id, 'addr_2')
  const addr2 = db.state.user_addresses.find((a) => a._id === 'addr_2')
  assert.equal(addr2.isDefault, true)
})
