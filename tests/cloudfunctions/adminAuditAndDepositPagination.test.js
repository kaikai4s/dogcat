const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin listStaffAudits: database pagination and targeted evidence fetch without full table scan', async () => {
  // 构造 60 个待审核和 60 个已审核的托师（共 120 个，超过单次 100 条限制）
  const staffProfiles = Array.from({ length: 120 }, (_, i) => ({
    _id: `sp_${String(i + 1).padStart(3, '0')}`,
    openid: `openid_staff_${i + 1}`,
    realName: `托师_${i + 1}`,
    phone: `1380000${String(i + 1).padStart(4, '0')}`,
    serviceCity: i % 2 === 0 ? '上海' : '北京',
    serviceAreas: '浦东,徐汇',
    auditStatus: i < 70 ? 'pending' : 'approved',
    updatedAt: `2026-09-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`
  }))

  // 构造 300 条历史保证金违规扣款凭证（全平台历史海量数据）
  const evidences = Array.from({ length: 300 }, (_, i) => ({
    _id: `ev_${i + 1}`,
    staffOpenid: `openid_staff_${(i % 120) + 1}`,
    orderId: `ord_${i + 1}`,
    orderNo: `ORD_${i + 1}`,
    reasonType: 'late_checkin',
    deductAmount: 50,
    status: i % 3 === 0 ? 'pending' : 'forfeited',
    createdAt: `2026-08-01 10:00:00`
  }))

  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }],
    staff_profiles: staffProfiles,
    staff_deposit_evidences: evidences
  })

  // 监控 staff_deposit_evidences 的查询条件，确保绝不无条件全量拉取
  const evidenceQueries = []
  const originalCollection = db.collection.bind(db)
  db.collection = function (name) {
    const col = originalCollection(name)
    if (name === 'staff_deposit_evidences') {
      const origWhere = col.where.bind(col)
      col.where = function (cond) {
        evidenceQueries.push(cond)
        return origWhere(cond)
      }
    }
    return col
  }

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 无 keyword 分页查询：只查待审核托师（auditStatus: 'pending'，共 70 条），第 1 页 20 条
  evidenceQueries.length = 0
  const resPending = await fn.main({
    module: 'admin',
    action: 'listStaffAudits',
    data: {
      auditStatus: 'pending',
      page: 1,
      pageSize: 20
    }
  })

  assert.equal(resPending.ok, true)
  assert.equal(resPending.data.total, 70, '待审核托师总数应为 70')
  assert.equal(resPending.data.page, 1)
  assert.equal(resPending.data.pageSize, 20)
  assert.equal(resPending.data.list.length, 20)
  assert.equal(resPending.data.hasMore, true)

  // 验证凭证查询：绝无全表扫描，且针对当前页 20 个托师 openid 定向批查
  assert.ok(evidenceQueries.length > 0, '应该触发凭证查询')
  for (const cond of evidenceQueries) {
    assert.ok(cond.staffOpenid, '凭证查询必须包含 staffOpenid 约束')
    assert.ok(cond.staffOpenid.$in, '凭证查询必须为定向 $in 约束')
    assert.equal(cond.staffOpenid.$in.length, 20, '凭证查询应且仅包含当前页的 20 个 staffOpenid')
  }

  // 验证第 1 条托师的凭证被正确关联
  const firstStaff = resPending.data.list[0]
  assert.ok(firstStaff.problemOrders.length > 0, '应关联对应的违规凭证')
  assert.equal(firstStaff.problemOrderCount, firstStaff.problemOrders.length)

  // 2. 翻页到最后一页：第 4 页（70 条中剩余 10 条）
  const resPage4 = await fn.main({
    module: 'admin',
    action: 'listStaffAudits',
    data: {
      auditStatus: 'pending',
      page: 4,
      pageSize: 20
    }
  })
  assert.equal(resPage4.ok, true)
  assert.equal(resPage4.data.list.length, 10)
  assert.equal(resPage4.data.hasMore, false)

  // 3. 关键字搜索分页：搜索 '上海'（共 35 条 pending），第 1 页 20 条
  const resKeyword = await fn.main({
    module: 'admin',
    action: 'listStaffAudits',
    data: {
      auditStatus: 'pending',
      keyword: '上海',
      page: 1,
      pageSize: 20
    }
  })
  assert.equal(resKeyword.ok, true)
  assert.equal(resKeyword.data.total, 35)
  assert.equal(resKeyword.data.list.length, 20)
  assert.equal(resKeyword.data.hasMore, true)
})

test('admin listStaffDeposits & listSupplyReimbursements: database query without full-table readAll', async () => {
  const staffUsers = [
    { _id: 'u_s1', openid: 'openid_s1', nickname: '托师1', phone: '13811110001', roles: ['client', 'staff'], status: 'active' },
    { _id: 'u_s2', openid: 'openid_s2', nickname: '托师2', phone: '13811110002', roles: ['client', 'staff'], status: 'active' }
  ]
  const staffProfiles = [
    { _id: 'sp_1', openid: 'openid_s1', realName: '张三', phone: '13811110001', staffLevel: 'senior', auditStatus: 'approved' },
    { _id: 'sp_2', openid: 'openid_s2', realName: '李四', phone: '13811110002', staffLevel: 'middle', auditStatus: 'approved' }
  ]
  const deposits = Array.from({ length: 60 }, (_, i) => ({
    _id: `dep_${i + 1}`,
    staffOpenid: i % 2 === 0 ? 'openid_s1' : 'openid_s2',
    amount: 500,
    paidAmount: 500,
    status: i < 40 ? 'paid' : 'refunded',
    createdAt: `2026-09-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`
  }))
  const reimbursements = Array.from({ length: 60 }, (_, i) => ({
    _id: `reimb_${i + 1}`,
    staffOpenid: i % 2 === 0 ? 'openid_s1' : 'openid_s2',
    amount: 100 + i,
    status: i < 30 ? 'pending' : 'paid',
    createdAt: `2026-09-02 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`
  }))

  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }, ...staffUsers],
    staff_profiles: staffProfiles,
    staff_deposits: deposits,
    staff_deposit_evidences: [],
    staff_supply_reimbursements: reimbursements
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 查询已支付保证金（status: 'paid'），pageSize: 20
  const depRes = await fn.main({
    module: 'admin',
    action: 'listStaffDeposits',
    data: {
      status: 'paid',
      pageSize: 20
    }
  })
  assert.equal(depRes.ok, true)
  assert.equal(Array.isArray(depRes.data), true)
  assert.equal(depRes.data.length, 20)
  assert.ok(depRes.data[0].staffRealName)

  // 2. 查询待处理物资报销（status: 'pending'），pageSize: 15
  const reimbRes = await fn.main({
    module: 'admin',
    action: 'listSupplyReimbursements',
    data: {
      status: 'pending',
      pageSize: 15
    }
  })
  assert.equal(reimbRes.ok, true)
  assert.equal(Array.isArray(reimbRes.data), true)
  assert.equal(reimbRes.data.length, 15)
  assert.ok(reimbRes.data[0].staffRealName)
})
