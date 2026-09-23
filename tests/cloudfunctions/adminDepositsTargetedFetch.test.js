const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin listStaffDeposits & listSupplyReimbursements: targeted fetch users/profiles without full table scan', async () => {
  // 1. 构造包含 200 个普通客户端用户和 2 个员工的测试数据库
  const normalUsers = Array.from({ length: 200 }, (_, i) => ({
    _id: `u_client_${i}`,
    openid: `openid_client_${i}`,
    nickname: `普通客户_${i}`,
    roles: ['client'],
    status: 'active'
  }))

  const staffUsers = [
    { _id: 'u_staff_1', openid: 'openid_staff_1', nickname: '金牌托师阿黄', phone: '13811112222', roles: ['client', 'staff'], status: 'active' },
    { _id: 'u_staff_2', openid: 'openid_staff_2', nickname: '银牌托师咪咪', phone: '13833334444', roles: ['client', 'staff'], status: 'active' }
  ]

  const adminUser = {
    _id: 'u_admin',
    openid: 'openid_admin',
    nickname: '超级管理员',
    roles: ['admin'],
    status: 'active'
  }

  const staffProfiles = [
    {
      _id: 'sp_1',
      openid: 'openid_staff_1',
      realName: '黄师傅',
      phone: '13811112222',
      staffLevel: 'senior',
      auditStatus: 'approved'
    },
    {
      _id: 'sp_2',
      openid: 'openid_staff_2',
      realName: '李师傅',
      phone: '13833334444',
      staffLevel: 'middle',
      auditStatus: 'approved'
    }
  ]

  const staffDeposits = [
    {
      _id: 'dep_1',
      staffOpenid: 'openid_staff_1',
      amount: 500,
      paidAmount: 500,
      refundedAmount: 0,
      forfeitedAmount: 0,
      availableRefundAmount: 500,
      status: 'paid',
      createdAt: '2026-09-01 10:00:00'
    },
    {
      _id: 'dep_2',
      staffOpenid: 'openid_staff_2',
      amount: 500,
      paidAmount: 500,
      refundedAmount: 0,
      forfeitedAmount: 100,
      availableRefundAmount: 400,
      status: 'paid',
      createdAt: '2026-09-02 12:00:00'
    }
  ]

  const staffEvidences = [
    {
      _id: 'ev_1',
      staffOpenid: 'openid_staff_2',
      orderId: 'ord_problem_1',
      orderNo: 'ORD20260902001',
      reasonType: 'service_violation',
      reasonTypeName: '违规未按时打卡',
      deductAmount: 100,
      actualDeductAmount: 100,
      status: 'forfeited',
      createdAt: '2026-09-02 13:00:00'
    }
  ]

  const reimbursements = [
    {
      _id: 'reimb_1',
      staffOpenid: 'openid_staff_1',
      amount: 68.5,
      type: 'shoe_covers',
      status: 'pending',
      createdAt: '2026-09-03 14:00:00'
    }
  ]

  const db = createCollectionStore({
    users: [adminUser, ...staffUsers, ...normalUsers],
    staff_profiles: staffProfiles,
    staff_deposits: staffDeposits,
    staff_deposit_evidences: staffEvidences,
    staff_supply_reimbursements: reimbursements
  })

  // 监控 users 集合的查询条件，确保绝不无条件全量拉取
  const userQueries = []
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
    return col
  }

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // --- 测试 1: listStaffDeposits ---
  userQueries.length = 0
  const depositRes = await fn.main({
    module: 'admin',
    action: 'listStaffDeposits',
    data: {
      pageSize: 50
    }
  })

  assert.equal(depositRes.ok, true, 'listStaffDeposits 应当调用成功')
  assert.equal(depositRes.data.length, 2, '应当返回 2 条保证金记录')

  // 验证关联字段完整映射
  const dep1 = depositRes.data.find((d) => d._id === 'dep_1')
  const dep2 = depositRes.data.find((d) => d._id === 'dep_2')
  assert.equal(dep1.staffNickname, '金牌托师阿黄')
  assert.equal(dep1.staffRealName, '黄师傅')
  assert.equal(dep1.staffLevel, 'senior')
  assert.equal(dep1.problemOrders.length, 0)

  assert.equal(dep2.staffNickname, '银牌托师咪咪')
  assert.equal(dep2.staffRealName, '李师傅')
  assert.equal(dep2.staffLevel, 'middle')
  assert.equal(dep2.problemOrders.length, 1)
  assert.equal(dep2.problemOrders[0].orderNo, 'ORD20260902001')
  assert.equal(dep2.problemOrders[0].actualDeductAmount, 100)

  // 验证针对 users 的查询：绝无全表无条件查询（空条件 where({})），仅使用 in 针对目标 staffOpenid 查询
  assert.ok(userQueries.length > 0, '应该触发了 users 查询')
  for (const cond of userQueries) {
    // 允许根据 openid: 'openid_admin' 查询鉴权用户，或根据 openid: { $in: [...] } 定向批量查询
    if (cond.openid && typeof cond.openid === 'string') {
      assert.equal(cond.openid, 'openid_admin', '单条 openid 查询应仅限鉴权')
    } else if (cond.openid && cond.openid.$in) {
      assert.ok(Array.isArray(cond.openid.$in), '批量定向查询必须为数组')
      // 必须包含 staffOpenid，且绝不包含 200 个普通客户 openid
      assert.ok(cond.openid.$in.includes('openid_staff_1'))
      assert.ok(cond.openid.$in.includes('openid_staff_2'))
      assert.equal(cond.openid.$in.length, 2, '定向批量查询应只包含当前页涉及的 2 个 staffOpenid')
    } else {
      assert.fail(`检测到非法的 users 查询条件: ${JSON.stringify(cond)}，存在全表扫描或未加约束查询风险`)
    }
  }

  // --- 测试 2: listSupplyReimbursements ---
  userQueries.length = 0
  const reimbRes = await fn.main({
    module: 'admin',
    action: 'listSupplyReimbursements',
    data: {
      pageSize: 50
    }
  })

  assert.equal(reimbRes.ok, true, 'listSupplyReimbursements 应当调用成功')
  assert.equal(reimbRes.data.length, 1, '应当返回 1 条报销记录')

  const r1 = reimbRes.data[0]
  assert.equal(r1.staffNickname, '金牌托师阿黄')
  assert.equal(r1.staffRealName, '黄师傅')
  assert.equal(r1.staffLevel, 'senior')
  assert.equal(r1.amount, 68.5)

  // 验证针对 users 的定向查询仅命中 openid_staff_1
  const targetedQuery = userQueries.find((c) => c.openid && c.openid.$in)
  assert.ok(targetedQuery, '物资报销列表应触发批量定向查询')
  assert.deepEqual(targetedQuery.openid.$in, ['openid_staff_1'], '物资报销定向查询应只包含涉及的 1 个 staffOpenid')

  // --- 测试 3: 分页截断与按需补全（pageSize: 1 时只定向查当前页第 1 条对应的员工） ---
  userQueries.length = 0
  const pagedRes = await fn.main({
    module: 'admin',
    action: 'listStaffDeposits',
    data: {
      pageSize: 1 // 只取第一条（按照 createdAt 降序，是 dep_2 openid_staff_2）
    }
  })

  assert.equal(pagedRes.ok, true)
  assert.equal(pagedRes.data.length, 1)
  assert.equal(pagedRes.data[0]._id, 'dep_2')

  const pagedTargetQuery = userQueries.find((c) => c.openid && c.openid.$in)
  assert.ok(pagedTargetQuery)
  assert.deepEqual(pagedTargetQuery.openid.$in, ['openid_staff_2'], 'pageSize 为 1 时应仅针对当前页所需的 1 个 staffOpenid 进行补全')
})
