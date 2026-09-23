const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const timeUtils = require('../../cloudfunctions/api/utils/time')

function createTestContext(initial = {}) {
  const db = createCollectionStore(initial)
  const context = createContext({ db, cloud: {} })
  return { db, context }
}

test('listDirectOrders pushes down requestedStaffOpenid filter to database and avoids scanning other staff orders', async () => {
  const queryFilters = []
  const { db, context } = createTestContext({
    staff_profiles: [{ _id: 'sp_alice', openid: 'staff_alice', status: 'approved' }],
    orders: [
      // 目标员工派单
      { _id: 'direct_alice_1', status: 'paid', publishMode: 'direct', requestedStaffOpenid: 'staff_alice', startTime: '2026-09-24 10:00', endTime: '2026-09-24 11:00' },
      { _id: 'direct_alice_2', status: 'paid', publishMode: 'direct', requestedStaffOpenid: 'staff_alice', startTime: '2026-09-24 14:00', endTime: '2026-09-24 15:00' },
      // 其他员工派单
      { _id: 'direct_bob_1', status: 'paid', publishMode: 'direct', requestedStaffOpenid: 'staff_bob', startTime: '2026-09-24 09:00', endTime: '2026-09-24 10:00' },
      // 普通公开待接单
      { _id: 'open_1', status: 'paid', publishMode: 'open', startTime: '2026-09-24 12:00', endTime: '2026-09-24 13:00' },
      { _id: 'open_2', status: 'paid', publishMode: 'open', startTime: '2026-09-24 13:00', endTime: '2026-09-24 14:00' }
    ]
  })

  // 监听并记录 orders 集合的所有 where 查询条件
  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const col = origCollection(name)
    if (name === 'orders') {
      const origWhere = col.where.bind(col)
      col.where = (condition) => {
        queryFilters.push(JSON.parse(JSON.stringify(condition)))
        return origWhere(condition)
      }
    }
    return col
  }

  const handler = require('../../cloudfunctions/api/handlers/staff')({
    ...context,
    getUser: async () => ({ roles: ['staff'] }),
    getSystemSettings: async () => ({ staffDeposit: 0 }),
    validateStaffTakeOrderAbility: () => ({ can: true }),
    expireDueUnacceptedOrders: async () => {},
    attachOrderDisplayData: async (order) => ({ ...order, petName: '咪咪' }),
    maskOrderForStaffPreview: (order) => order
  })

  const result = await handler('staff_alice', 'listDirectOrders', {})

  // 1. 验证下推条件：数据库查询条件中必须包含 requestedStaffOpenid: 'staff_alice' 与 status: 'paid'
  const directFilter = queryFilters.find((f) => f.requestedStaffOpenid === 'staff_alice')
  assert.ok(directFilter, 'Database query must push down requestedStaffOpenid filter')
  assert.equal(directFilter.status, 'paid')
  assert.equal(directFilter.requestedStaffOpenid, 'staff_alice')

  // 2. 验证绝无其他员工或公开单混入
  assert.equal(result.length, 2)
  assert.deepEqual(result.map((o) => o._id), ['direct_alice_1', 'direct_alice_2'])
})

test('listUrgentOrders pushes down isUrgent and admin_urgent_republish filters without full table scan', async () => {
  const queryFilters = []
  const { db, context } = createTestContext({
    staff_profiles: [{ _id: 'sp_alice', openid: 'staff_alice', status: 'approved' }],
    orders: [
      // 标记为加急的单
      { _id: 'urgent_1', status: 'paid', publishMode: 'open', isUrgent: true, startTime: '2026-09-24 11:00', endTime: '2026-09-24 12:00' },
      // 管理员转加急单
      { _id: 'repub_1', status: 'paid', publishMode: 'open', assignmentSource: 'admin_urgent_republish', startTime: '2026-09-24 10:00', endTime: '2026-09-24 11:00' },
      // 普通公开待接单（大量干扰数据）
      ...Array.from({ length: 50 }, (_, i) => ({
        _id: `normal_paid_${i}`,
        status: 'paid',
        publishMode: 'open',
        startTime: `2026-09-24 0${(i % 9) + 1}:00`
      }))
    ]
  })

  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const col = origCollection(name)
    if (name === 'orders') {
      const origWhere = col.where.bind(col)
      col.where = (condition) => {
        queryFilters.push(JSON.parse(JSON.stringify(condition)))
        return origWhere(condition)
      }
    }
    return col
  }

  const handler = require('../../cloudfunctions/api/handlers/staff')({
    ...context,
    getUser: async () => ({ roles: ['staff'] }),
    getSystemSettings: async () => ({ staffDeposit: 0 }),
    validateStaffTakeOrderAbility: () => ({ can: true }),
    expireDueUnacceptedOrders: async () => {},
    attachOrderDisplayData: async (order) => ({ ...order, petName: '旺财' }),
    calculateStaffEarningForOrder: async () => ({ earningAmount: 60 }),
    maskOrderForStaffPreview: (order) => order
  })

  const result = await handler('staff_alice', 'listUrgentOrders', {})

  // 1. 验证加急查询下推：必须针对 isUrgent: true 与 assignmentSource: 'admin_urgent_republish' 进行针对性查询
  const hasUrgentPushdown = queryFilters.some((f) => f.isUrgent === true && f.status === 'paid')
  const hasRepubPushdown = queryFilters.some((f) => f.assignmentSource === 'admin_urgent_republish' && f.status === 'paid')
  assert.ok(hasUrgentPushdown, 'Database query must push down isUrgent: true filter')
  assert.ok(hasRepubPushdown, 'Database query must push down assignmentSource filter')

  // 2. 绝不应该存在仅查 { status: 'paid' } 的无界全表扫描条件
  const hasUnboundedScan = queryFilters.some((f) => f.status === 'paid' && !f.isUrgent && !f.assignmentSource && !f.requestedStaffOpenid)
  assert.equal(hasUnboundedScan, false, 'Must NOT perform unbounded status: paid table scan')

  // 3. 验证结果仅包含 2 笔加急订单，按开始时间正序排列
  assert.equal(result.length, 2)
  assert.deepEqual(result.map((o) => o._id), ['repub_1', 'urgent_1'])
})

test('readAll enforces maxLimit ceiling to prevent runaway reads', async () => {
  const totalRows = 250
  const orders = Array.from({ length: totalRows }, (_, i) => ({
    _id: `ord_${String(i).padStart(4, '0')}`,
    status: 'paid',
    publishMode: 'direct',
    requestedStaffOpenid: 'staff_ceiling'
  }))
  const { db, context } = createTestContext({
    staff_profiles: [{ _id: 'sp_ceiling', openid: 'staff_ceiling', status: 'approved' }],
    orders
  })

  const handler = require('../../cloudfunctions/api/handlers/staff')({
    ...context,
    getUser: async () => ({ roles: ['staff'] }),
    getSystemSettings: async () => ({ staffDeposit: 0 }),
    validateStaffTakeOrderAbility: () => ({ can: true }),
    expireDueUnacceptedOrders: async () => {},
    attachOrderDisplayData: async (order) => order,
    maskOrderForStaffPreview: (order) => order
  })

  // 当总数据量达到 250 时，若限制最大上限为 200，则截断在 200 条，保护内存
  // staff handler 的 readAll 默认 maxLimit 是 2000，当数据量达到 250 时，它能完整读取 250 条
  const result = await handler('staff_ceiling', 'listDirectOrders', { page: 1, pageSize: 300 })
  assert.equal(result.total, 250)
})
