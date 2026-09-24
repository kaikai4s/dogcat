const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('revokeStaff protection against active fulfillment orders and open incidents', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff_busy', openid: 'openid_staff_busy', roles: ['client', 'staff'], activeRole: 'staff', status: 'active', phone: '13800000001' },
      { _id: 'u_staff_incident', openid: 'openid_staff_incident', roles: ['client', 'staff'], activeRole: 'staff', status: 'active', phone: '13800000002' },
      { _id: 'u_staff_free', openid: 'openid_staff_free', roles: ['client', 'staff'], activeRole: 'staff', status: 'active', phone: '13800000003' }
    ],
    staff_profiles: [
      {
        _id: 'sp_busy',
        userId: 'u_staff_busy',
        openid: 'openid_staff_busy',
        realName: '履约中宠托师',
        phone: '13800000001',
        auditStatus: 'approved',
        staffLevel: 'certified'
      },
      {
        _id: 'sp_incident',
        userId: 'u_staff_incident',
        openid: 'openid_staff_incident',
        realName: '纠纷中宠托师',
        phone: '13800000002',
        auditStatus: 'approved',
        staffLevel: 'certified'
      },
      {
        _id: 'sp_free',
        userId: 'u_staff_free',
        openid: 'openid_staff_free',
        realName: '空闲宠托师',
        phone: '13800000003',
        auditStatus: 'approved',
        staffLevel: 'certified'
      }
    ],
    orders: [
      // 1. 履约中订单 (in_service)
      {
        _id: 'o_active_1',
        orderNo: 'O20001',
        staffOpenid: 'openid_staff_busy',
        status: 'in_service'
      },
      // 2. 空闲宠托师的历史已完成订单
      {
        _id: 'o_completed_1',
        orderNo: 'O20002',
        staffOpenid: 'openid_staff_free',
        status: 'completed'
      }
    ],
    order_incidents: [
      // 3. 处理中纠纷 (investigating)
      {
        _id: 'inc_1',
        staffOpenid: 'openid_staff_incident',
        status: 'investigating'
      }
    ],
    admin_operation_logs: [],
    platform_configs: []
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 尝试撤销有履约中订单的宠托师 -> 必须拦截
  const resBusy = await adminApi.main({
    module: 'admin',
    action: 'revokeStaff',
    data: { staffProfileId: 'sp_busy' }
  })
  assert.equal(resBusy.ok, false)
  assert.match(resBusy.message, /未完成的履约订单/)
  assert.equal(db.state.staff_profiles.find((p) => p._id === 'sp_busy').auditStatus, 'approved')

  // 验证当订单状态为 assigned 或 day_completed 时同样拦截
  db.state.orders[0].status = 'assigned'
  const resAssigned = await adminApi.main({
    module: 'admin',
    action: 'revokeStaff',
    data: { staffProfileId: 'sp_busy' }
  })
  assert.equal(resAssigned.ok, false)
  assert.match(resAssigned.message, /未完成的履约订单/)

  db.state.orders[0].status = 'day_completed'
  const resDayCompleted = await adminApi.main({
    module: 'admin',
    action: 'revokeStaff',
    data: { staffProfileId: 'sp_busy' }
  })
  assert.equal(resDayCompleted.ok, false)
  assert.match(resDayCompleted.message, /未完成的履约订单/)

  // 2. 尝试撤销有待结案客诉纠纷的宠托师 -> 必须拦截
  const resIncident = await adminApi.main({
    module: 'admin',
    action: 'revokeStaff',
    data: { staffProfileId: 'sp_incident' }
  })
  assert.equal(resIncident.ok, false)
  assert.match(resIncident.message, /尚未结案的客诉或纠纷/)
  assert.equal(db.state.staff_profiles.find((p) => p._id === 'sp_incident').auditStatus, 'approved')

  // 3. 撤销无进行中订单和纠纷的宠托师 -> 允许正常撤销
  const resFree = await adminApi.main({
    module: 'admin',
    action: 'revokeStaff',
    data: { staffProfileId: 'sp_free', auditRemark: '宠托师主动申请注销' }
  })
  assert.equal(resFree.ok, true)
  assert.equal(resFree.data.auditStatus, 'revoked')
  const profileFree = db.state.staff_profiles.find((p) => p._id === 'sp_free')
  assert.equal(profileFree.auditStatus, 'revoked')
  assert.equal(profileFree.auditRemark, '宠托师主动申请注销')
  const userFree = db.state.users.find((u) => u._id === 'u_staff_free')
  assert.deepEqual(userFree.roles, ['client'])
  assert.equal(userFree.activeRole, 'client')
})
