const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createHandler = require('../../cloudfunctions/api/handlers/playground')
const { ownerId } = require('../../cloudfunctions/api/services/playground-world')

function createTestContext(dbState, openid = 'test_owner') {
  const db = createCollectionStore(dbState)
  const context = {
    db,
    getUser: async () => db.state.users.find((user) => user.openid === openid) || null,
    safeText: (value) => String(value || '').trim(),
    nowText: () => '2026-10-20T12:00:00.000Z'
  }
  return { db, handler: createHandler(context), openid }
}

test('稳定性防御：当用户未登录或数据库无用户记录时，新接口防御性检查不崩溃', async () => {
  const { handler, openid } = createTestContext({
    users: [],
    pet_playground_plots: [
      { _id: ownerId('test_owner'), kind: 'owner_plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48 }
    ]
  })

  // getCommunityGroupBuy 允许匿名或游客场景，不崩溃并返回默认社区名
  const groupBuyRes = await handler(openid, 'getCommunityGroupBuy', {})
  assert.equal(groupBuyRes.communityName, '当前社区')
  assert.ok(groupBuyRes.groupBuyDiscount)

  // getPlaygroundRewards 游客返回 0 积分与普通会员
  const rewardsRes = await handler(openid, 'getPlaygroundRewards', {})
  assert.equal(rewardsRes.points, 0)
  assert.equal(rewardsRes.memberLevelName, '普通会员')

  // exchangeCoupon 未登录时友好拒绝而非抛出 500 TypeError
  await assert.rejects(
    handler(openid, 'exchangeCoupon', { templateId: 'tpl_01' }),
    /请先登录后操作/
  )
})

test('位移平滑度验证：密集或网络抖动包到达时，拥有平滑缓冲，不误判移动过远纠偏', async () => {
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_test_owner', openid: 'test_owner', role: 'client' }],
    pets: [{ _id: 'pet_1', openid: 'test_owner', name: '豆豆', species: 'dog' }],
    pet_playground_plots: [
      { _id: ownerId('test_owner'), kind: 'owner_plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48 },
      { _id: 'mine', kind: 'plot', ownerOpenid: 'test_owner', plotId: 'mine', x: 84, z: 84, size: 48, gateDirection: 'south' }
    ]
  })

  const enterRes = await handler(openid, 'enterScene', {})
  assert.ok(enterRes.scene)
  const credentials = { session: enterRes.scene.session, sceneId: enterRes.scene.sceneId }

  // 模拟快速连续走动（密集小包），由于抖动缓冲保护，不返回 corrected: true
  // 假定紧接着走动了 1.5 米
  const syncRes = await handler(openid, 'syncScene', {
    ...credentials,
    seq: 1,
    online: true,
    reconcile: true,
    position: { x: enterRes.scene.position.x, z: enterRes.scene.position.z + 1.5 },
    trail: [{ x: enterRes.scene.position.x, z: enterRes.scene.position.z + 0.8 }]
  })

  assert.equal(syncRes.accepted, true)
  assert.notEqual(syncRes.corrected, true)
  assert.equal(syncRes.position.z, enterRes.scene.position.z + 1.5)
})
