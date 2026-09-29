const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('markWithdrawPaid stores paymentProofImage and records isSameAuditorAndPayer audit flag', async () => {
  const adminOpenid = 'openid_admin_1'
  const staffOpenid = 'openid_staff_w'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin1', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], status: 'active' }
    ],
    withdraw_requests: [
      {
        _id: 'wr_1',
        staffOpenid,
        amount: 100,
        earningIds: ['earn_1'],
        status: 'approved',
        auditedByOpenid: adminOpenid,
        auditedAt: new Date()
      }
    ],
    staff_earnings: [
      {
        _id: 'earn_1',
        staffOpenid,
        amount: 100,
        status: 'withdrawing',
        withdrawRequestId: 'wr_1'
      }
    ],
    system_settings: [
      {
        _id: 'default',
        finance: { strictDualReview: false }
      }
    ],
    finance_logs: [],
    admin_operation_logs: []
  })

  const adminApi = loadCloudFunction('api', db, adminOpenid)

  const res = await adminApi.main({
    module: 'admin',
    action: 'markWithdrawPaid',
    data: {
      id: 'wr_1',
      paymentConfirmed: true,
      paymentReference: 'WX_TRANSFER_998877',
      paymentProofImage: 'cloud://dogcat/receipts/proof_001.png'
    }
  })

  assert.equal(res.ok, true, res.error || '')
  const wr = db.state.withdraw_requests.find(r => r._id === 'wr_1')
  assert.equal(wr.status, 'paid')
  assert.equal(wr.paymentReference, 'WX_TRANSFER_998877')
  assert.equal(wr.paymentProofImage, 'cloud://dogcat/receipts/proof_001.png')
  assert.equal(wr.isSameAuditorAndPayer, true, '应标记审核人与打款人为同一人的内控告警标记')

  const flog = db.state.finance_logs.find(l => l.action === 'withdraw_paid')
  assert.ok(flog)
  assert.equal(flog.detail.paymentProofImage, 'cloud://dogcat/receipts/proof_001.png')
})

test('strictDualReview mode blocks same admin from approving and paying withdrawal', async () => {
  const adminOpenid1 = 'openid_admin_auditor'
  const adminOpenid2 = 'openid_admin_payer'
  const staffOpenid = 'openid_staff_dual'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin1', openid: adminOpenid1, roles: ['admin'], status: 'active' },
      { _id: 'u_admin2', openid: adminOpenid2, roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], status: 'active' }
    ],
    withdraw_requests: [
      {
        _id: 'wr_strict',
        staffOpenid,
        amount: 200,
        earningIds: ['earn_strict_1'],
        status: 'approved',
        auditedByOpenid: adminOpenid1,
        auditedAt: new Date()
      }
    ],
    staff_earnings: [
      {
        _id: 'earn_strict_1',
        staffOpenid,
        amount: 200,
        status: 'withdrawing',
        withdrawRequestId: 'wr_strict'
      }
    ],
    system_settings: [
      {
        _id: 'default',
        finance: { strictDualReview: true }
      }
    ],
    finance_logs: [],
    admin_operation_logs: []
  })

  // 1. 同一管理员打款 -> 拦截
  const admin1Api = loadCloudFunction('api', db, adminOpenid1)
  const rejectRes = await admin1Api.main({
    module: 'admin',
    action: 'markWithdrawPaid',
    data: {
      id: 'wr_strict',
      paymentConfirmed: true,
      paymentReference: 'WX_TRANSFER_SAME'
    }
  })
  assert.equal(rejectRes.ok, false)
  assert.match(rejectRes.error, /严格财务双人复核/)

  // 2. 第二位独立管理员打款 -> 允许通过
  const admin2Api = loadCloudFunction('api', db, adminOpenid2)
  const passRes = await admin2Api.main({
    module: 'admin',
    action: 'markWithdrawPaid',
    data: {
      id: 'wr_strict',
      paymentConfirmed: true,
      paymentReference: 'WX_TRANSFER_DIFF',
      paymentProofImage: 'cloud://dogcat/receipts/proof_diff.png'
    }
  })
  assert.equal(passRes.ok, true, passRes.error || '')
  const wr = db.state.withdraw_requests.find(r => r._id === 'wr_strict')
  assert.equal(wr.status, 'paid')
  assert.equal(wr.isSameAuditorAndPayer, false)
  assert.equal(wr.paidByOpenid, adminOpenid2)
})

test('republishOrderAsUrgent atomically rolls back deposit evidence if order status conflicts', async () => {
  const adminOpenid = 'openid_admin_urgent'
  const staffOpenid = 'openid_staff_target'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: adminOpenid, roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], name: '王托师', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_target', openid: staffOpenid, realName: '王托师' }
    ],
    orders: [
      {
        _id: 'order_atomic_conflict',
        orderNo: 'ORD_ATOMIC_001',
        status: 'assigned',
        staffOpenid,
        payAmount: 100,
        startTime: '2026-10-20 10:00',
        endTime: '2026-10-20 11:00'
      }
    ],
    staff_deposit_evidences: [],
    order_timeline: [],
    order_staff_messages: []
  })

  // 模拟在管理员发起加急重发时，宠托师抢先进入履约开始状态 (in_service)
  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const col = origCollection(name)
    if (name === 'orders') {
      const origDoc = col.doc.bind(col)
      col.doc = (id) => {
        const docObj = origDoc(id)
        const origGet = docObj.get.bind(docObj)
        docObj.get = async () => {
          const res = await origGet()
          const clonedData = { ...res.data, status: 'assigned' }
          // 底层状态被抢先变更为 in_service
          const realOrder = db.state.orders.find(o => o._id === id)
          if (realOrder) realOrder.status = 'in_service'
          return { data: clonedData }
        }
        return docObj
      }
    }
    return col
  }

  const adminApi = loadCloudFunction('api', db, adminOpenid)
  const futureStart = new Date(Date.now() + 4 * 3600 * 1000).toISOString()
  const futureEnd = new Date(Date.now() + 5 * 3600 * 1000).toISOString()

  const res = await adminApi.main({
    module: 'admin',
    action: 'republishOrderAsUrgent',
    data: {
      orderId: 'order_atomic_conflict',
      staffReward: 120,
      startTime: futureStart,
      endTime: futureEnd,
      recordDepositEvidence: true,
      deductAmount: 60
    }
  })

  assert.equal(res.ok, false)
  assert.match(res.message, /已被并发更新或已被宠托师抢先开始/)

  // 验证 staff_deposit_evidences 中没有任何孤立的脏数据
  assert.equal(db.state.staff_deposit_evidences.length, 0)
  // 订单保持 in_service
  const order = db.state.orders.find(o => o._id === 'order_atomic_conflict')
  assert.equal(order.status, 'in_service')
})

test('admin dashboard handles empty current month without falling back to scanning all historical records', async () => {
  const adminOpenid = 'openid_admin_perf'

  // 创建很多陈旧年份历史数据（2020年），而当前月份完全没有数据
  const historicalOrders = Array.from({ length: 50 }, (_, i) => ({
    _id: `ord_old_${i}`,
    status: 'completed',
    paymentStatus: 'paid',
    payAmount: 88,
    createdAt: `2020-01-${String((i % 25) + 1).padStart(2, '0')} 10:00:00`,
    paidAt: `2020-01-${String((i % 25) + 1).padStart(2, '0')} 10:00:00`
  }))

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_p', openid: adminOpenid, roles: ['admin'], status: 'active', createdAt: '2020-01-01 00:00:00' }
    ],
    orders: historicalOrders,
    staff_profiles: [],
    order_incidents: []
  })

  const adminApi = loadCloudFunction('api', db, adminOpenid)
  const res = await adminApi.main({ module: 'admin', action: 'dashboard', data: {} })

  assert.equal(res.ok, true, res.error || '')
  // 当月没有订单与注册时，直接返回 0，不会把 2020 年的 50 条历史记录全表拉入
  assert.equal(res.data.monthly.totals.orders, 0)
  assert.equal(res.data.monthly.totals.revenue, 0)
  assert.equal(res.data.monthly.totals.paidOrders, 0)
})
