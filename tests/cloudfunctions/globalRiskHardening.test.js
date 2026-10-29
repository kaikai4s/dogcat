const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')
const { loadCloudFunction } = require('./helpers')

test('parallel first logins create only one user document and stable identity', async () => {
  const db = createCollectionStore({ users: [] })
  const retries = optimistic(db)
  const api = loadCloudFunction('api', db, 'new_client')
  const results = await Promise.all(Array.from({ length: 3 }, () => api.main({ module: 'auth', action: 'login', data: {} })))
  assert.ok(results.every(result => result.ok), results.map(result => result.message).join(','))
  assert.equal(db.state.users.length, 1)
  assert.equal(new Set(results.map(result => result.data._id)).size, 1)
  assert.ok(retries() > 0)
})

test('invitation reward retries use persisted reward identity after a settings change', async () => {
  const invite = { _id: 'invite_client', inviterOpenid: 'inviter', invitedOpenid: 'client' }
  const { db, service } = context({ user_invites: [invite], pets: [{ _id: 'pet_client', openid: 'client', name: '宠物' }] })
  optimistic(db)
  await service.grantInviteReward(invite, { settings: { enabled: true, rewardAmount: 5 } })
  const firstId = db.state.user_asset_earnings[0]._id
  db.state.user_asset_earnings[0].status = 'withdrawn'
  await service.grantInviteReward(invite, { settings: { enabled: true, rewardAmount: 9 } })
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0]._id, firstId)
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
  assert.equal(db.state.user_asset_earnings[0].status, 'withdrawn')
})

test('invitation reward transaction query failure cannot overwrite or duplicate existing earnings', async () => {
  const invite = { _id: 'invite_client', inviterOpenid: 'inviter', invitedOpenid: 'client' }
  const { db, service } = context({ user_invites: [invite] })
  const run = db.runTransaction
  db.runTransaction = fn => run(tx => fn({ collection(name) {
    if (name === 'user_asset_earnings') throw new Error('reward ledger unavailable')
    return tx.collection(name)
  } }))
  await assert.rejects(() => service.grantInviteReward(invite, { settings: { enabled: true, rewardAmount: 5 } }), /reward ledger unavailable/)
  assert.equal((db.state.user_asset_earnings || []).length, 0)
  assert.equal(db.state.user_invites[0].rewardEarningId, undefined)
})

function context(initial) {
  const db = createCollectionStore({ users: [{ _id: 'u', openid: 'client', status: 'active', roles: ['client'], inviteCode: 'TEST' }], ...initial })
  return { db, service: createContext({ db, cloud: {} }) }
}

test('user assets include over 1000 earnings and invitations, and all withdrawal history with ownership filters', async () => {
  const { service } = context({
    user_asset_earnings: [...Array.from({ length: 1105 }, (_, i) => ({ _id: `earning_${String(i).padStart(4, '0')}`, userOpenid: 'client', amount: 0.01, status: 'available' })), { _id: 'other', userOpenid: 'other', amount: 500, status: 'available' }],
    user_invites: Array.from({ length: 1105 }, (_, i) => ({ _id: `invite_${i}`, inviterOpenid: 'client', invitedOpenid: `neighbor_${i}` })),
    withdraw_requests: [...Array.from({ length: 235 }, (_, i) => ({ _id: `withdraw_${i}`, assetType: 'user', userOpenid: 'client', amount: 1, status: 'paid' })), { _id: 'other', assetType: 'user', userOpenid: 'other', amount: 100 }]
  })
  const result = await service.getUserAssetSummary('client')
  assert.equal(result.availableAmount, 11.05)
  assert.equal(result.totalAmount, 11.05)
  assert.equal(result.earnings.length, 1105)
  assert.equal(result.invites.length, 1105)
  assert.equal(result.withdraws.length, 235)
})

test('asset ledger query failures and damaged money never become a zero balance', async () => {
  const broken = context()
  const collection = broken.db.collection
  broken.db.collection = name => {
    if (name === 'user_asset_earnings') throw new Error('ledger unavailable')
    return collection(name)
  }
  await assert.rejects(() => broken.service.summarizeUserAssets('client'), /ledger unavailable/)
  for (const amount of [null, -2, NaN, 0.001]) {
    const { service } = context({ user_asset_earnings: [{ _id: 'e', userOpenid: 'client', amount, status: 'available' }] })
    await assert.rejects(() => service.summarizeUserAssets('client'), /金额/)
  }
})

test('large asset withdrawal fails with a batching instruction and no partial locks', async () => {
  const { db, service } = context({
    system_settings: [{ _id: 'default', invitation: { enabled: true, userMinWithdrawAmount: 1 } }],
    user_asset_earnings: Array.from({ length: 125 }, (_, i) => ({ _id: `e_${String(i).padStart(3, '0')}`, userOpenid: 'client', amount: 1, status: 'available' }))
  })
  await assert.rejects(() => service.createUserAssetWithdraw('client', { amount: 110 }), /分批申请/)
  assert.ok(db.state.user_asset_earnings.every(e => e.status === 'available'))
  assert.equal((db.state.withdraw_requests || []).length, 0)
})

test('reusing asset withdrawal request ID with a different amount is rejected', async () => {
  const { service } = context({ withdraw_requests: [{ _id: `uw_${require('crypto').createHash('sha256').update(JSON.stringify(['client', 'retry'])).digest('hex').slice(0, 32)}`, assetType: 'user', userOpenid: 'client', amount: 20 }] })
  await assert.rejects(() => service.createUserAssetWithdraw('client', { amount: 30, clientRequestId: 'retry' }), /请求编号/)
})

test('failed asset withdrawal release rejects missing, foreign, paid, duplicated and mismatched earnings atomically', async () => {
  const cases = [
    { ids: ['missing'] }, { patch: { userOpenid: 'other' } }, { patch: { withdrawRequestId: 'other' } },
    { patch: { status: 'withdrawn' } }, { ids: ['e', 'e'], amount: 4 }, { amount: 3 }
  ]
  for (const scenario of cases) {
    const { db, service } = context({
      withdraw_requests: [{ _id: 'w', assetType: 'user', userOpenid: 'client', amount: scenario.amount || 2, earningIds: scenario.ids || ['e'], status: 'transfer_failed', gatewayFailureConfirmed: true }],
      user_asset_earnings: [{ _id: 'e', userOpenid: 'client', amount: 2, withdrawRequestId: 'w', status: 'withdrawing', ...scenario.patch }]
    })
    const before = structuredClone(db.state)
    await assert.rejects(() => service.releaseUserAssetWithdrawal({ openid: 'admin' }, { id: 'w' }))
    assert.deepEqual(db.state, before)
  }
})

test('valid failed asset withdrawal release restores only the locked owner earnings', async () => {
  const { db, service } = context({
    withdraw_requests: [{ _id: 'w', assetType: 'user', userOpenid: 'client', amount: 2, earningIds: ['e'], status: 'transfer_failed', gatewayFailureConfirmed: true }],
    user_asset_earnings: [{ _id: 'e', userOpenid: 'client', amount: 2, withdrawRequestId: 'w', status: 'withdrawing' }]
  })
  await service.releaseUserAssetWithdrawal({ openid: 'admin' }, { id: 'w' })
  assert.equal(db.state.user_asset_earnings[0].status, 'available')
  assert.equal(db.state.withdraw_requests[0].status, 'rejected')
})

test('verified late transfer success settles a failed user withdrawal exactly once', async () => {
  const { db, service } = context({
    withdraw_requests: [{ _id: 'w', assetType: 'user', userOpenid: 'client', recipientOpenid: 'client', payoutChannel: 'wechat_wallet', amount: 2, earningIds: ['e'], status: 'transfer_failed' }],
    user_asset_earnings: [{ _id: 'e', userOpenid: 'client', amount: 2, withdrawRequestId: 'w', status: 'withdrawing' }]
  })
  const first = await service.markUserAssetPaid('w', { state: 'SUCCESS', transferBillNo: 'bill' })
  const second = await service.markUserAssetPaid('w', { state: 'SUCCESS', transferBillNo: 'bill' })
  assert.equal(first.request.status, 'paid')
  assert.equal(second.changed, false)
  assert.equal(db.state.user_asset_earnings[0].status, 'withdrawn')
  assert.equal(db.state.finance_logs.filter(row => row.action === 'user_withdraw_paid').length, 1)
  await assert.rejects(() => service.releaseUserAssetWithdrawal({ openid: 'admin' }, { id: 'w' }), /失败单可释放/)
})

test('supplies reimbursement counts completed work after long unpaid history and finds paid purchases beyond 100 rows', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'staff_user', openid: 'staff', status: 'active', roles: ['staff'] }],
    staff_profiles: [{ _id: 'p', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified' }],
    orders: [...Array.from({ length: 510 }, (_, i) => ({ _id: `old_${i}`, staffOpenid: 'staff', status: 'pending_pay' })), { _id: 'done', staffOpenid: 'staff', status: 'completed' }],
    mall_orders: [...Array.from({ length: 110 }, (_, i) => ({ _id: `old_${String(i).padStart(3, '0')}`, clientOpenid: 'staff', status: 'pending_pay' })), { _id: 'z_purchase', clientOpenid: 'staff', status: 'paid' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { staffSupplies: { reimbursementEnabled: true, reimbursementMode: 'order_count', reimbursementOrderCount: 1, purchaseRequired: true } } }]
  })
  const api = loadCloudFunction('api', db, 'staff')
  const result = await api.main({ module: 'staff', action: 'getSupplyReimbursementStatus', data: {} })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.qualification.completedOrderCount, 1)
  assert.equal(result.data.purchaseMet, true)
  assert.equal(result.data.canApply, true)
})

function groupContext(overrides = {}) {
  const session = { index: 1, date: '2026-10-21', startTime: '2026-10-21 10:00', endTime: '2026-10-21 11:00', status: 'in_service', startedAt: new Date('2026-10-21T02:00:00Z') }
  const db = createCollectionStore({
    orders: ['a', 'b'].map(id => ({ _id: id, groupBuyId: 'g', staffOpenid: 'staff', paymentStatus: 'paid', status: 'in_service', activeSessionIndex: 1, currentSessionStartedAt: session.startedAt, serviceSessions: [session] })),
    pet_playground_groups: [{ _id: 'g', status: 'formed' }]
  })
  const retries = optimistic(db)
  const now = () => new Date('2026-10-21T03:01:00Z')
  const sessions = require('../../cloudfunctions/api/services/orderSessions')({ now, formatDateKey: d => d.toISOString().slice(0, 10), toTimeValue: v => v ? new Date(v).getTime() : 0 })
  let fail = false
  const settled = new Set()
  const service = require('../../cloudfunctions/api/services/groupCompletion')({
    db, now, ...sessions, toTimeValue: v => v ? new Date(v).getTime() : 0,
    evaluateCheckinCompletion: async () => ({ isComplete: true }), appendOrderTimeline: async () => {}, appendOrderClientMessage: async () => {},
    completeSingleOrderService: async member => {
      if (member._id === 'b' && fail) throw new Error('temporary settlement failure')
      settled.add(member._id)
      await db.collection('orders').doc(member._id).update({ data: { status: 'completed' } })
      return { id: member._id, status: 'completed' }
    }, ...overrides
  })
  return { db, service, session, now, retries, settled, setFailure: value => { fail = value } }
}

test('parallel household finishes cannot leave both waiting for each other', async () => {
  const s = groupContext()
  const orders = structuredClone(s.db.state.orders)
  const results = await Promise.all(orders.map(order => s.service.finishGroup(order, s.session, s.now())))
  assert.ok(results.some(result => result.allGroupCompleted))
  assert.ok(s.retries() > 0)
  assert.ok(s.db.state.orders.every(order => order.status === 'completed' && order.groupCompletionPending === false))
  assert.equal(s.settled.size, 2)
})

test('partially failed group settlement retries even through an already completed household', async () => {
  const s = groupContext()
  await s.service.finishGroup(structuredClone(s.db.state.orders[0]), s.session, s.now())
  s.setFailure(true)
  await assert.rejects(() => s.service.finishGroup(structuredClone(s.db.state.orders[1]), s.session, s.now()), /temporary settlement failure/)
  assert.equal(s.db.state.orders[0].status, 'completed')
  assert.equal(s.db.state.orders[1].status, 'day_completed')
  assert.equal(s.db.state.orders[1].groupCompletionPending, true)
  s.setFailure(false)
  const result = await s.service.finishGroup(structuredClone(s.db.state.orders[0]), s.session, s.now())
  assert.equal(result.allGroupCompleted, true)
  assert.ok(s.db.state.orders.every(order => order.status === 'completed' && !order.groupCompletionPending))
})

test('scheduled group reconciliation recovers a failed settlement', async () => {
  const s = groupContext()
  await s.service.finishGroup(structuredClone(s.db.state.orders[0]), s.session, s.now())
  s.setFailure(true)
  await assert.rejects(() => s.service.finishGroup(structuredClone(s.db.state.orders[1]), s.session, s.now()))
  s.setFailure(false)
  await s.service.retryPendingGroupCompletions()
  assert.ok(s.db.state.orders.every(order => order.status === 'completed' && !order.groupCompletionPending))
})

test('group finishing preserves evidence requirements and future service sessions', async () => {
  const s = groupContext({ evaluateCheckinCompletion: async () => ({ isComplete: false, missing: ['离户照片'] }) })
  await assert.rejects(() => s.service.finishGroup(structuredClone(s.db.state.orders[0]), s.session), /离户照片/)
  assert.equal(s.db.state.orders[0].status, 'in_service')
  const later = groupContext()
  later.db.state.orders[0].serviceSessions.push({ ...later.session, index: 2, status: 'pending' })
  await assert.rejects(() => later.service.finishGroup(structuredClone(later.db.state.orders[0]), later.session), /未完成的服务场次/)
  assert.equal(later.settled.size, 0)
})
