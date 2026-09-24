const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('1. admin cannot delete user who has active in_service order', async () => {
  const adminOpenid = 'admin_op_1'
  const clientOpenid = 'client_active_order_user'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_admin_backup', openid: 'admin_backup', roles: ['admin'], status: 'active' },
      { _id: 'u_client_1', openid: clientOpenid, roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_active_1',
        orderNo: 'ORD_ACTIVE_1',
        clientOpenid,
        status: 'in_service',
        createdAt: '2026-09-24 10:00:00'
      }
    ],
    order_incidents: [],
    withdraw_requests: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)

  // 尝试软删除
  const deleteRes = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: clientOpenid }
  })
  assert.equal(deleteRes.ok, false)
  assert.match(deleteRes.message, /该用户存在履约中或未完结的服务订单，无法删除/)

  // 尝试硬删除
  const hardDeleteRes = await adminFn.main({
    module: 'admin',
    action: 'hardDeleteUser',
    data: { openid: clientOpenid }
  })
  assert.equal(hardDeleteRes.ok, false)
  assert.match(hardDeleteRes.message, /该用户存在履约中或未完结的服务订单，无法删除/)

  // 验证用户未被修改或删除
  const user = db.state.users.find(u => u.openid === clientOpenid)
  assert.equal(user.status, 'active')
})

test('2. admin cannot delete user who has refunding order', async () => {
  const adminOpenid = 'admin_op_2'
  const clientOpenid = 'client_refunding_user'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_admin_backup', openid: 'admin_backup', roles: ['admin'], status: 'active' },
      { _id: 'u_client_2', openid: clientOpenid, roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_refunding_1',
        orderNo: 'ORD_REFUNDING_1',
        clientOpenid,
        status: 'cancelled',
        paymentStatus: 'refunding',
        createdAt: '2026-09-24 10:00:00'
      }
    ],
    order_incidents: [],
    withdraw_requests: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)

  const res = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: clientOpenid }
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /该用户存在退款处理中的订单，无法删除/)
})

test('3. admin cannot delete staff who has assigned active service', async () => {
  const adminOpenid = 'admin_op_3'
  const staffOpenid = 'staff_assigned_user'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_admin_backup', openid: 'admin_backup', roles: ['admin'], status: 'active' },
      { _id: 'u_staff_1', openid: staffOpenid, roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp_1', openid: staffOpenid, realName: '测试托师' }],
    orders: [
      {
        _id: 'ord_assigned_1',
        orderNo: 'ORD_ASSIGNED_1',
        clientOpenid: 'client_other',
        staffOpenid,
        status: 'assigned',
        createdAt: '2026-09-24 10:00:00'
      }
    ],
    order_incidents: [],
    withdraw_requests: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)

  const res = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: staffOpenid }
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /该宠托师有尚未完成的履约订单，无法删除/)
})

test('4. admin cannot delete user who has pending incident or complaint', async () => {
  const adminOpenid = 'admin_op_4'
  const clientOpenid = 'client_incident_user'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_admin_backup', openid: 'admin_backup', roles: ['admin'], status: 'active' },
      { _id: 'u_client_incident', openid: clientOpenid, roles: ['client'], status: 'active' }
    ],
    orders: [],
    order_incidents: [
      {
        _id: 'inc_1',
        clientOpenid,
        status: 'pending',
        createdAt: '2026-09-24 10:00:00'
      }
    ],
    withdraw_requests: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)

  const res = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: clientOpenid }
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /该用户存在处理中的纠纷或投诉，无法删除/)
})

test('5. admin cannot delete staff who has pending withdrawal', async () => {
  const adminOpenid = 'admin_op_5'
  const staffOpenid = 'staff_withdraw_user'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_admin_backup', openid: 'admin_backup', roles: ['admin'], status: 'active' },
      { _id: 'u_staff_withdraw', openid: staffOpenid, roles: ['staff'], status: 'active' }
    ],
    orders: [],
    order_incidents: [],
    withdraw_requests: [
      {
        _id: 'w_1',
        staffOpenid,
        amount: 200,
        status: 'pending',
        createdAt: '2026-09-24 10:00:00'
      }
    ],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)

  const res = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: staffOpenid }
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /该宠托师存在待处理的提现申请，无法删除/)
})

test('6. user with only completed historical orders can be deleted safely', async () => {
  const adminOpenid = 'admin_op_6'
  const cleanUserOpenid = 'client_clean_completed_user'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_admin_backup', openid: 'admin_backup', roles: ['admin'], status: 'active' },
      { _id: 'u_client_clean', openid: cleanUserOpenid, roles: ['client'], status: 'active', nickname: '历史好客户' }
    ],
    orders: [
      {
        _id: 'ord_completed_1',
        clientOpenid: cleanUserOpenid,
        status: 'completed',
        paymentStatus: 'paid',
        createdAt: '2026-08-01 10:00:00'
      }
    ],
    order_incidents: [],
    withdraw_requests: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)

  // 软删除成功
  const res = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: cleanUserOpenid }
  })

  assert.equal(res.ok, true)
  const deletedUser = db.state.users.find(u => u.openid === cleanUserOpenid)
  assert.equal(deletedUser.status, 'deleted')
  assert.equal(deletedUser.nickname, '已删除用户')
})
