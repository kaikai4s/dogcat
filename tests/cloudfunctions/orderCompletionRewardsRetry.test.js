const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createRewardOrderDb(extra = {}) {
  return createCollectionStore({
    users: [
      {
        _id: 'client_user_1',
        openid: 'openid_client_1',
        roles: ['client'],
        status: 'active',
        points: 0,
        totalPoints: 0,
        completedOrderCount: 0,
        retroCardCount: 0
      },
      {
        _id: 'staff_user_1',
        openid: 'openid_staff_1',
        roles: ['client', 'staff'],
        status: 'active'
      }
    ],
    orders: [
      {
        _id: 'order_retry_1',
        clientOpenid: 'openid_client_1',
        clientUserId: 'client_user_1',
        staffOpenid: 'openid_staff_1',
        status: 'completed', // 状态已提前流转至 completed，但副作用未完成
        payAmount: 60,
        completedAt: new Date().toISOString(),
        requiredCheckins: [],
        serviceSessions: [{ index: 1, status: 'completed' }]
      }
    ],
    staff_earnings: [],
    point_logs: [],
    retro_card_logs: [],
    order_timeline: [],
    platform_configs: [
      {
        _id: 'cfg1',
        key: 'system_settings',
        value: { settlement: { staffCommissionRate: 0.8, settlementDelayDays: 0, minWithdrawAmount: 10 } }
      }
    ],
    ...extra
  })
}

test('order completion retry: compensates missing points and completedOrderCount when order is completed but rewards not granted', async () => {
  const db = createRewardOrderDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff_1')

  // 模拟之前中断后，宠托师再次点击【完成服务】重试
  const res = await staffFn.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'order_retry_1' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.id, 'order_retry_1')
  assert.equal(res.data.completedOrderCount, 1)

  // 验证积分已被自动补偿发放
  const clientUser = db.state.users.find((u) => u._id === 'client_user_1')
  assert.equal(clientUser.completedOrderCount, 1, 'Client completedOrderCount must be incremented to 1')
  assert.equal(clientUser.points, 6, 'Points must be awarded (60 / 10 = 6 points)')

  const pointLog = db.state.point_logs.find((p) => p.openid === 'openid_client_1')
  assert.ok(pointLog, 'Point log must be created')
  assert.equal(pointLog.delta, 6)
  assert.equal(pointLog.sourceType, 'order_complete')

  // 验证订单上已打标副作用已发放
  const orderAfter = db.state.orders.find((o) => o._id === 'order_retry_1')
  assert.equal(orderAfter.pointsAwarded, true)
  assert.equal(orderAfter.clientOrderCounted, true)

  // 再次重试，验证幂等防重：完单数与积分不可重复累加
  const duplicateRes = await staffFn.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'order_retry_1' }
  })

  assert.equal(duplicateRes.ok, true)
  assert.equal(duplicateRes.data.completedOrderCount, 1)
  assert.equal(clientUser.completedOrderCount, 1, 'completedOrderCount must not be incremented again')
  assert.equal(clientUser.points, 6, 'Points must not be awarded again')
  assert.equal(db.state.point_logs.length, 1, 'Only 1 point log should exist')
})

test('order completion retry: compensates milestone retro card when count reaches 3 on retry, and prevents double grant', async () => {
  const db = createRewardOrderDb({
    users: [
      {
        _id: 'client_user_milestone',
        openid: 'openid_client_milestone',
        roles: ['client'],
        status: 'active',
        points: 20,
        totalPoints: 20,
        completedOrderCount: 2, // 已经完成了 2 单，本次应为第 3 单
        retroCardCount: 0
      },
      {
        _id: 'staff_user_1',
        openid: 'openid_staff_1',
        roles: ['client', 'staff'],
        status: 'active'
      }
    ],
    orders: [
      {
        _id: 'order_milestone_3',
        clientOpenid: 'openid_client_milestone',
        clientUserId: 'client_user_milestone',
        staffOpenid: 'openid_staff_1',
        status: 'completed', // 中断的第 3 单
        payAmount: 100,
        completedAt: new Date().toISOString(),
        requiredCheckins: [],
        serviceSessions: [{ index: 1, status: 'completed' }]
      }
    ]
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff_1')

  const res = await staffFn.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'order_milestone_3' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.completedOrderCount, 3)

  const clientUser = db.state.users.find((u) => u._id === 'client_user_milestone')
  assert.equal(clientUser.completedOrderCount, 3)
  assert.equal(clientUser.points, 30, 'Points: 20 + 10 = 30')
  assert.equal(clientUser.retroCardCount, 1, 'Milestone retro card +1 must be granted')

  const retroLog = db.state.retro_card_logs.find((r) => r.openid === 'openid_client_milestone')
  assert.ok(retroLog, 'Retro card log must exist')
  assert.equal(retroLog.delta, 1)
  assert.equal(retroLog.sourceType, 'order_complete_milestone')

  const orderAfter = db.state.orders.find((o) => o._id === 'order_milestone_3')
  assert.equal(orderAfter.pointsAwarded, true)
  assert.equal(orderAfter.clientOrderCounted, true)
  assert.equal(orderAfter.retroCardAwarded, true)

  // 重复重试：验证补签卡绝不会多发
  const retryRes = await staffFn.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'order_milestone_3' }
  })
  assert.equal(retryRes.ok, true)
  assert.equal(clientUser.retroCardCount, 1, 'Retro card must not be duplicated')
  assert.equal(db.state.retro_card_logs.length, 1, 'Only 1 retro card log should exist')
})
