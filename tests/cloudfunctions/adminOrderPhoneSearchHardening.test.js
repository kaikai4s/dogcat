const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin listOrders phone search: targeted bounded query without full table scan of users and profiles', async () => {
  // 构造 300 个无关用户，模拟生产环境海量注册用户
  const massiveIrrelevantUsers = Array.from({ length: 300 }, (_, i) => ({
    _id: `u_mass_${i}`,
    openid: `openid_mass_${i}`,
    nickname: `路人客户_${i}`,
    phone: `1580000${String(i).padStart(4, '0')}`,
    roles: ['client'],
    status: 'active'
  }))

  const targetClient = {
    _id: 'u_target_client',
    openid: 'openid_target_client',
    nickname: '张三客户',
    phone: '13812345678',
    roles: ['client'],
    status: 'active'
  }

  const targetStaffUser = {
    _id: 'u_target_staff',
    openid: 'openid_target_staff',
    nickname: '李四宠托',
    phone: '13987654321',
    roles: ['client', 'staff'],
    status: 'active'
  }

  const targetStaffProfile = {
    _id: 'sp_target_staff',
    openid: 'openid_target_staff',
    realName: '李师傅',
    phone: '13987654321',
    auditStatus: 'approved'
  }

  const otherStaffProfile = {
    _id: 'sp_other_staff',
    openid: 'openid_other_staff',
    realName: '赵师傅',
    phone: '13700000000',
    auditStatus: 'approved'
  }

  const orders = [
    {
      _id: 'ord_1',
      orderNo: 'ORD20260901001',
      clientOpenid: 'openid_target_client',
      contactPhone: '13812345678',
      staffOpenid: 'openid_target_staff',
      staffProfileId: 'sp_target_staff',
      status: 'paid',
      createdAt: '2026-09-01 10:00:00'
    },
    {
      _id: 'ord_2',
      orderNo: 'ORD20260901002',
      clientOpenid: 'openid_mass_1',
      contactPhone: '15800000001',
      staffOpenid: 'openid_other_staff',
      staffProfileId: 'sp_other_staff',
      status: 'paid',
      createdAt: '2026-09-01 11:00:00'
    }
  ]

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      targetClient,
      targetStaffUser,
      ...massiveIrrelevantUsers
    ],
    staff_profiles: [targetStaffProfile, otherStaffProfile],
    orders
  })

  // 监听 users 与 staff_profiles 的查询条件
  const userQueries = []
  const profileQueries = []
  const originalCollection = db.collection.bind(db)
  db.collection = function (name) {
    const col = originalCollection(name)
    if (name === 'users') {
      const origWhere = col.where.bind(col)
      col.where = function (cond) {
        userQueries.push(cond)
        return origWhere(cond)
      }
    }
    if (name === 'staff_profiles') {
      const origWhere = col.where.bind(col)
      col.where = function (cond) {
        profileQueries.push(cond)
        return origWhere(cond)
      }
    }
    return col
  }

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // --- 测试 1: 按客户手机号搜索 ---
  userQueries.length = 0
  profileQueries.length = 0
  const clientSearchRes = await fn.main({
    module: 'admin',
    action: 'listOrders',
    data: { clientPhone: '1381234' }
  })

  assert.equal(clientSearchRes.ok, true)
  assert.equal(clientSearchRes.data.list.length, 1)
  assert.equal(clientSearchRes.data.list[0]._id, 'ord_1')

  // 断言绝对没有对 users 进行全表扫描（空条件 where({})）
  assert.ok(userQueries.length > 0, '应该执行了受控的用户查询')
  for (const cond of userQueries) {
    if (cond.openid) continue // 鉴权管理员或单条订单关联用户信息点查
    // 搜索阶段查询条件必须带 phone
    assert.ok(cond.phone !== undefined, `users 搜索条件必须带 phone，检测到非法全表查询: ${JSON.stringify(cond)}`)
  }
  // 搜索客户手机号时不应该查询 staff_profiles
  assert.equal(profileQueries.length, 0, '根据客户手机号搜索订单时不应扫描 staff_profiles')

  // --- 测试 2: 按宠托师手机号搜索 ---
  userQueries.length = 0
  profileQueries.length = 0
  const staffSearchRes = await fn.main({
    module: 'admin',
    action: 'listOrders',
    data: { staffPhone: '1398765' }
  })

  assert.equal(staffSearchRes.ok, true)
  assert.equal(staffSearchRes.data.list.length, 1)
  assert.equal(staffSearchRes.data.list[0]._id, 'ord_1')

  for (const cond of userQueries) {
    if (cond.openid) continue
    assert.ok(cond.phone !== undefined, `users 查询条件必须带 phone: ${JSON.stringify(cond)}`)
  }
  for (const cond of profileQueries) {
    assert.ok(cond.phone !== undefined, `staff_profiles 查询条件必须带 phone: ${JSON.stringify(cond)}`)
  }

  // --- 测试 3: 搜索不存在的手机号 ---
  userQueries.length = 0
  profileQueries.length = 0
  const notFoundRes = await fn.main({
    module: 'admin',
    action: 'listOrders',
    data: { clientPhone: '19999999999' }
  })

  assert.equal(notFoundRes.ok, true)
  assert.equal(notFoundRes.data.list.length, 0, '搜索不存在的手机号应返回空订单列表')
})
