const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('staff list query optimization: filter pushdown, no N+1 user queries, and deterministic pagination', async () => {
  // 构造模拟数据库：创建 10 个员工，其中 4 个上海，6 个北京
  const staffProfiles = [
    { _id: 'sp_sh_1', openid: 'openid_sh_1', auditStatus: 'approved', realName: '张三', serviceCity: '上海市', serviceAreas: '浦东新区', ratingAverage: 4.8, reviewCount: 10, updatedAt: '2026-08-01 10:00:00' },
    { _id: 'sp_sh_2', openid: 'openid_sh_2', auditStatus: 'approved', realName: '李四', serviceCity: '上海', serviceAreas: '黄浦区', ratingAverage: 4.8, reviewCount: 10, updatedAt: '2026-08-01 10:00:00' },
    { _id: 'sp_sh_3', openid: 'openid_sh_3', auditStatus: 'approved', realName: '王五', serviceCity: '上海市', serviceAreas: '静安区', ratingAverage: 4.8, reviewCount: 10, updatedAt: '2026-08-01 10:00:00' },
    { _id: 'sp_sh_4', openid: 'openid_sh_4', auditStatus: 'approved', realName: '赵六', serviceCity: '上海', serviceAreas: '徐汇区', ratingAverage: 4.8, reviewCount: 10, updatedAt: '2026-08-01 10:00:00' },
    // 北京员工
    { _id: 'sp_bj_1', openid: 'openid_bj_1', auditStatus: 'approved', realName: '刘一', serviceCity: '北京市', serviceAreas: '朝阳区', ratingAverage: 5.0, reviewCount: 20, updatedAt: '2026-08-01 12:00:00' },
    { _id: 'sp_bj_2', openid: 'openid_bj_2', auditStatus: 'approved', realName: '陈二', serviceCity: '北京市', serviceAreas: '海淀区', ratingAverage: 5.0, reviewCount: 20, updatedAt: '2026-08-01 12:00:00' },
    { _id: 'sp_bj_3', openid: 'openid_bj_3', auditStatus: 'approved', realName: '孙三', serviceCity: '北京市', serviceAreas: '西城区', ratingAverage: 5.0, reviewCount: 20, updatedAt: '2026-08-01 12:00:00' },
    { _id: 'sp_bj_4', openid: 'openid_bj_4', auditStatus: 'approved', realName: '钱四', serviceCity: '北京', serviceAreas: '东城区', ratingAverage: 5.0, reviewCount: 20, updatedAt: '2026-08-01 12:00:00' },
    { _id: 'sp_bj_5', openid: 'openid_bj_5', auditStatus: 'approved', realName: '周五', serviceCity: '北京市', serviceAreas: '丰台区', ratingAverage: 5.0, reviewCount: 20, updatedAt: '2026-08-01 12:00:00' },
    { _id: 'sp_bj_6', openid: 'openid_bj_6', auditStatus: 'approved', realName: '吴六', serviceCity: '北京市', serviceAreas: '石景山区', ratingAverage: 5.0, reviewCount: 20, updatedAt: '2026-08-01 12:00:00' }
  ]

  const users = [
    { _id: 'u_client', openid: 'openid_client', status: 'active', roles: ['client'] },
    { _id: 'u_sh_1', openid: 'openid_sh_1', nickname: '张大宝', status: 'active', roles: ['staff'] },
    { _id: 'u_sh_2', openid: 'openid_sh_2', nickname: '李小贝', status: 'active', roles: ['staff'] },
    { _id: 'u_sh_3', openid: 'openid_sh_3', nickname: '王阿黄', status: 'active', roles: ['staff'] },
    { _id: 'u_sh_4', openid: 'openid_sh_4', nickname: '赵欢欢', status: 'active', roles: ['staff'] },
    { _id: 'u_bj_1', openid: 'openid_bj_1', nickname: '北京托托1', status: 'active', roles: ['staff'] },
    { _id: 'u_bj_2', openid: 'openid_bj_2', nickname: '北京托托2', status: 'active', roles: ['staff'] },
    { _id: 'u_bj_3', openid: 'openid_bj_3', nickname: '北京托托3', status: 'active', roles: ['staff'] },
    { _id: 'u_bj_4', openid: 'openid_bj_4', nickname: '北京托托4', status: 'active', roles: ['staff'] },
    { _id: 'u_bj_5', openid: 'openid_bj_5', nickname: '北京托托5', status: 'active', roles: ['staff'] },
    { _id: 'u_bj_6', openid: 'openid_bj_6', nickname: '北京托托6', status: 'active', roles: ['staff'] }
  ]

  const db = createCollectionStore({
    users,
    staff_profiles: staffProfiles,
    service_reviews: [],
    sitter_favorites: []
  })

  // 对 users 集合和 staff_profiles 集合进行操作计数
  let userQueryCount = 0
  const originalCollection = db.collection.bind(db)
  db.collection = function (name) {
    const col = originalCollection(name)
    if (name === 'users') {
      const origGet = col.get.bind(col)
      col.get = async function () {
        userQueryCount += 1
        return origGet()
      }
    }
    return col
  }

  const clientApi = loadCloudFunction('api', db, 'openid_client')

  // 1. 验证按城市筛选：城市条件下推且仅查当前页需要的用户资料
  userQueryCount = 0
  const page1Res = await clientApi.main({
    module: 'staff',
    action: 'listApprovedSitters',
    data: {
      serviceCity: '上海',
      page: 1,
      pageSize: 2
    }
  })

  assert.equal(page1Res.ok, true)
  assert.equal(page1Res.data.total, 4) // 上海总共 4 个
  assert.equal(page1Res.data.list.length, 2)
  assert.equal(page1Res.data.page, 1)
  assert.equal(page1Res.data.hasMore, true)

  // 验证用户查询次数：在获取上海第 1 页（2条数据）时，users 表查询次数最多只有 1 次批量查询，绝非 10 次或 4 次！
  assert.equal(userQueryCount <= 1, true, `users 查询次数应 <= 1，实际为: ${userQueryCount}`)
  // 验证当前页返回的宠托师昵称正确装配
  assert.equal(page1Res.data.list[0].displayName.length > 0, true)

  // 2. 验证稳定排序与游标分页一致性（tie-breaker 避免跨页重复或遗漏）
  const page2Res = await clientApi.main({
    module: 'staff',
    action: 'listApprovedSitters',
    data: {
      serviceCity: '上海',
      page: 2,
      pageSize: 2
    }
  })

  assert.equal(page2Res.ok, true)
  assert.equal(page2Res.data.list.length, 2)
  assert.equal(page2Res.data.page, 2)
  assert.equal(page2Res.data.hasMore, false)

  // 验证两页的 ID 完全互斥，不存在同分导致的顺序漂移
  const page1Ids = page1Res.data.list.map((item) => item._id)
  const page2Ids = page2Res.data.list.map((item) => item._id)
  assert.equal(page1Ids.length, 2)
  assert.equal(page2Ids.length, 2)
  const intersection = page1Ids.filter((id) => page2Ids.includes(id))
  assert.deepEqual(intersection, [], '第 1 页与第 2 页数据不应有交集')

  // 3. 验证关键词匹配：当输入 keyword 时，单次批量加载即可匹配
  userQueryCount = 0
  const searchRes = await clientApi.main({
    module: 'staff',
    action: 'listApprovedSitters',
    data: {
      keyword: '小贝'
    }
  })
  assert.equal(searchRes.ok, true)
  assert.equal(searchRes.data.total, 1)
  assert.equal(searchRes.data.list[0]._id, 'sp_sh_2')
  assert.equal(searchRes.data.list[0].displayName, '李小贝')
  assert.equal(userQueryCount <= 1, true, `关键词搜索 users 批量查询次数应 <= 1，实际为: ${userQueryCount}`)
})
