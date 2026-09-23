const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin listPromotionApplications: targeted staff profile fetch without full table scan', async () => {
  // 构造 100 个无关员工档案，模拟成百上千员工档案场景
  const irrelevantProfiles = Array.from({ length: 100 }, (_, i) => ({
    _id: `sp_mass_${i}`,
    openid: `openid_mass_staff_${i}`,
    realName: `员工_${i}`,
    auditStatus: 'approved',
    staffLevel: 'intern'
  }))

  const targetProfile1 = {
    _id: 'sp_target_1',
    openid: 'openid_staff_1',
    realName: '优秀托师王五',
    phone: '13911112222',
    auditStatus: 'approved',
    staffLevel: 'intern'
  }

  const targetProfile2 = {
    _id: 'sp_target_2',
    openid: 'openid_staff_2',
    realName: '资深托师赵六',
    phone: '13933334444',
    auditStatus: 'approved',
    staffLevel: 'intern'
  }

  const applications = [
    {
      _id: 'app_1',
      staffProfileId: 'sp_target_1',
      staffOpenid: 'openid_staff_1',
      status: 'pending',
      staffRemark: '申请晋升为认证宠托师',
      createdAt: '2026-09-01 10:00:00'
    },
    {
      _id: 'app_2',
      staffProfileId: 'sp_target_2',
      staffOpenid: 'openid_staff_2',
      status: 'approved',
      staffRemark: '已通过审核',
      createdAt: '2026-09-02 12:00:00'
    }
  ]

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    staff_profiles: [targetProfile1, targetProfile2, ...irrelevantProfiles],
    staff_promotion_applications: applications
  })

  // 监听 staff_profiles 集合查询，确保绝不无条件全表拉取
  const profileQueries = []
  const originalCollection = db.collection.bind(db)
  db.collection = function (name) {
    const col = originalCollection(name)
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

  // --- 测试 1: 分页查询 listPromotionApplications ---
  profileQueries.length = 0
  const res = await fn.main({
    module: 'admin',
    action: 'listPromotionApplications',
    data: {
      page: 1,
      pageSize: 20
    }
  })

  assert.equal(res.ok, true, 'listPromotionApplications 应调用成功')
  assert.equal(res.data.list.length, 2, '应当返回 2 条申请')

  const app1 = res.data.list.find((a) => a._id === 'app_1')
  const app2 = res.data.list.find((a) => a._id === 'app_2')
  assert.equal(app1.profile.realName, '优秀托师王五')
  assert.equal(app2.profile.realName, '资深托师赵六')

  // 验证 staff_profiles 查询：绝无空条件全表拉取，必须定向按 _id: $in 查询当前页目标 staffProfileId
  assert.ok(profileQueries.length > 0, '应该触发受控员工档案定向查询')
  for (const cond of profileQueries) {
    assert.ok(cond._id && cond._id.$in, `staff_profiles 必须使用 _id.$in 定向批量查询: ${JSON.stringify(cond)}`)
    assert.ok(cond._id.$in.includes('sp_target_1'))
    assert.ok(cond._id.$in.includes('sp_target_2'))
    assert.equal(cond._id.$in.length, 2, '定向批量查询应仅包含当前页实际涉及的 2 个 staffProfileId')
  }

  // --- 测试 2: 分页截断按需补全（pageSize: 1 时只查询第 1 条涉及的员工） ---
  profileQueries.length = 0
  const pagedRes = await fn.main({
    module: 'admin',
    action: 'listPromotionApplications',
    data: {
      page: 1,
      pageSize: 1 // 按照 createdAt 降序，第一条是 app_2
    }
  })

  assert.equal(pagedRes.ok, true)
  assert.equal(pagedRes.data.list.length, 1)
  assert.equal(pagedRes.data.list[0]._id, 'app_2')

  const targetQuery = profileQueries.find((c) => c._id && c._id.$in)
  assert.ok(targetQuery)
  assert.deepEqual(targetQuery._id.$in, ['sp_target_2'], 'pageSize 为 1 时应仅针对当前页涉及的 1 个 staffProfileId 进行补全')

  // --- 测试 3: getPromotionApplicationDetail 不存在申请的防护 ---
  const notFoundDetail = await fn.main({
    module: 'admin',
    action: 'getPromotionApplicationDetail',
    data: { id: 'non_existent_app' }
  })
  assert.equal(notFoundDetail.ok, false)
  assert.equal(notFoundDetail.message, '晋升申请不存在')
})
