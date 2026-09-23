const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('listIncidents pushes down status/orderId filters and supports database skip/limit beyond 100 items', async () => {
  // 构造 150 条纠纷工单，其中有不同状态与 orderId
  const totalIncidents = 150
  const incidents = Array.from({ length: totalIncidents }, (_, i) => ({
    _id: `inc_${String(i + 1).padStart(4, '0')}`,
    orderId: i < 5 ? 'target_order' : `ord_${i + 1}`,
    clientOpenid: `client_${i + 1}`,
    staffOpenid: `staff_${i + 1}`,
    status: i % 2 === 0 ? 'processing' : 'resolved',
    createdAt: new Date(1700000000000 + i * 1000).toISOString()
  }))

  const db = createCollectionStore({
    users: [{ _id: 'admin_user', openid: 'openid_admin', roles: ['admin'], status: 'active' }],
    order_incidents: incidents
  })

  // 监听 order_incidents 查询参数
  const queryLogs = []
  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const col = origCollection(name)
    if (name === 'order_incidents') {
      const origWhere = col.where.bind(col)
      const origSkip = col.skip.bind(col)
      const origLimit = col.limit.bind(col)
      const origCount = col.count.bind(col)
      const origGet = col.get.bind(col)

      col.where = (w) => {
        queryLogs.push({ type: 'where', where: JSON.parse(JSON.stringify(w)) })
        return origWhere(w)
      }
      col.skip = (s) => {
        queryLogs.push({ type: 'skip', skip: s })
        return origSkip(s)
      }
      col.limit = (l) => {
        queryLogs.push({ type: 'limit', limit: l })
        return origLimit(l)
      }
    }
    return col
  }

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 测试跨越 100 条限制的深度分页（第 6 页，每页 20 条，即查 101~120 条）
  const page6Result = await fn.main({
    module: 'incident',
    action: 'listIncidents',
    data: { page: 6, pageSize: 20 }
  })

  assert.equal(page6Result.ok, true)
  assert.equal(page6Result.data.total, 150)
  assert.equal(page6Result.data.page, 6)
  assert.equal(page6Result.data.pageSize, 20)
  assert.equal(page6Result.data.hasMore, true)
  assert.equal(page6Result.data.list.length, 20)
  // 验证 skip 是 (6-1)*20 = 100
  const hasSkip100 = queryLogs.some((l) => l.type === 'skip' && l.skip === 100)
  const hasLimit20 = queryLogs.some((l) => l.type === 'limit' && l.limit === 20)
  assert.ok(hasSkip100, 'Database query must call skip(100) for page 6')
  assert.ok(hasLimit20, 'Database query must call limit(20)')

  // 2. 测试 status 条件下推
  queryLogs.length = 0
  const filterStatusResult = await fn.main({
    module: 'incident',
    action: 'listIncidents',
    data: { status: 'processing', page: 1, pageSize: 10 }
  })
  assert.equal(filterStatusResult.ok, true)
  assert.equal(filterStatusResult.data.total, 75) // 150 条中一半为 processing
  assert.equal(filterStatusResult.data.list.length, 10)
  assert.ok(filterStatusResult.data.list.every((item) => item.status === 'processing'))
  const statusPushdown = queryLogs.some((l) => l.type === 'where' && l.where.status === 'processing')
  assert.ok(statusPushdown, 'where clause must push down status: processing')

  // 3. 测试 orderId 条件下推
  queryLogs.length = 0
  const filterOrderResult = await fn.main({
    module: 'incident',
    action: 'listIncidents',
    data: { orderId: 'target_order' }
  })
  assert.equal(filterOrderResult.ok, true)
  assert.equal(filterOrderResult.data.total, 5)
  assert.equal(filterOrderResult.data.list.length, 5)
  const orderIdPushdown = queryLogs.some((l) => l.type === 'where' && l.where.orderId === 'target_order')
  assert.ok(orderIdPushdown, 'where clause must push down orderId: target_order')
})

test('listMyIncidents pushes down status filter and supports optional pagination', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client_user', openid: 'openid_client_1', roles: ['client'], status: 'active' }],
    order_incidents: [
      { _id: 'inc_c1', clientOpenid: 'openid_client_1', status: 'open', createdAt: '2026-09-01' },
      { _id: 'inc_c2', clientOpenid: 'openid_client_1', status: 'resolved', createdAt: '2026-09-02' },
      { _id: 'inc_c3', clientOpenid: 'openid_client_1', status: 'resolved', createdAt: '2026-09-03' },
      { _id: 'inc_other', clientOpenid: 'openid_other', status: 'open', createdAt: '2026-09-04' }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  // 1. 未传分页时返回数组，且 status 下推生效
  const resNoPage = await fn.main({
    module: 'incident',
    action: 'listMyIncidents',
    data: { role: 'client', status: 'resolved' }
  })
  assert.equal(resNoPage.ok, true)
  assert.equal(Array.isArray(resNoPage.data), true)
  assert.equal(resNoPage.data.length, 2)
  assert.deepEqual(resNoPage.data.map((item) => item._id), ['inc_c3', 'inc_c2'])

  // 2. 传分页时返回带分页结构
  const resPaged = await fn.main({
    module: 'incident',
    action: 'listMyIncidents',
    data: { role: 'client', page: 1, pageSize: 1 }
  })
  assert.equal(resPaged.ok, true)
  assert.equal(resPaged.data.total, 3)
  assert.equal(resPaged.data.list.length, 1)
  assert.equal(resPaged.data.hasMore, true)
})
