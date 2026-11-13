const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createRedemption = require('../../cloudfunctions/api/services/staffEarningRedemption')

function fixture(rows) {
  const db = createCollectionStore({
    users: [{ _id: 'u', openid: 'staff', roles: ['staff'], status: 'active' }, { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    staff_profiles: [{ _id: 'sp', openid: 'staff', realName: '小李', auditStatus: 'approved' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { settlement: { staffEarningsMode: 'manual_redemption', minWithdrawAmount: 0, settlementDelayDays: 1 } } }],
    staff_earnings: (rows || [{ amount: 100 }, { amount: 20, status: 'pending', availableAt: new Date('2099-01-01') }]).map((r, i) => ({ _id: `e${i}`, staffOpenid: 'staff', orderId: `o${i}`, status: 'available', paymentChannel: 'wechat', ...r }))
  })
  const context = createContext({ db, cloud: {} })
  Object.assign(context, createRedemption({ ...context, checkImageSecurity: async () => {}, checkTextSecurity: async () => {} }))
  const data = { staffProfileId: 'sp', clientRequestId: 'redeem-1', amount: 30, paymentConfirmed: true, paymentProofImage: 'cloud://test.bucket/staff_redemptions/proof.png' }
  const record = patch => context.recordStaffEarningRedemption({ _id: 'admin', openid: 'admin' }, { ...data, ...patch })
  return { db, context, data, record }
}

test('partial redemption subtracts the amount once and retains order totals and proof', async () => {
  const f = fixture()
  const result = await f.record()
  assert.equal(result.status, 'paid')
  assert.equal(result.paymentProofImage, f.data.paymentProofImage)
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  assert.equal(f.db.state.staff_earnings[0].redeemedAmount, 30)
  assert.equal(f.db.state.staff_earnings[0].originalAmount, 100)
  const preview = await f.context.getStaffRedemptionPreview('sp')
  assert.equal(preview.estimated, 90)
  assert.equal(preview.available, 70)
  assert.equal(preview.redeemed, 30)
  const summary = f.context.summarizeStaffEarnings(f.db.state.staff_earnings)
  assert.equal(summary.total, 120)
  assert.equal(summary.redeemed, 30)
  assert.equal(summary.available, 70)
  const profit = f.context.buildOrderProfitSummary({ payAmount: 150, paymentStatus: 'paid', status: 'completed' }, f.db.state.staff_earnings[0])
  assert.equal(profit.staffReward, 100)
  assert.equal(f.db.state.finance_logs.length, 1)
  assert.equal(f.db.state.admin_operation_logs[0].adminOpenid, 'admin')
  assert.equal((await f.record())._id, result._id)
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  await assert.rejects(f.record({ amount: 31 }), /不可更改/)
})

test('redeeming a legacy earning preserves its original refund basis including earlier deductions', async () => {
  const f = fixture([{ amount: 70, deductAmount: 10, deductedAmount: 20 }])
  await f.record({ amount: 30 })
  assert.equal(f.db.state.staff_earnings[0].originalAmount, 100)
  await f.context.adjustStaffEarningsForRefund('o0', 20, 100, '第二次退款', null, { refundId: 'second', cumulativeRefundAmount: 40 })
  const row = f.db.state.staff_earnings[0]
  assert.equal(row.amount, 20)
  assert.equal(row.redeemedAmount, 30)
  assert.equal(row.deductedAmount, 40)
  assert.equal(row.overpaidDebtAmount, 0)
})

test('legacy original amount recovery includes earlier redemptions and keeps an explicit original value', async () => {
  for (const originalAmount of [undefined, 120]) {
    const f = fixture([{ amount: 40, redeemedAmount: 30, deductAmount: 10, deductedAmount: 20, originalAmount }])
    await f.record({ amount: 10 })
    assert.equal(f.db.state.staff_earnings[0].originalAmount, originalAmount ?? 100)
    assert.equal(f.db.state.staff_earnings[0].amount, 30)
    assert.equal(f.db.state.staff_earnings[0].redeemedAmount, 40)
  }
})

test('full redemption consumes only settled unreserved real earnings and supports cents', async () => {
  const f = fixture([{ amount: 0.03 }, { amount: 0.04 }, { amount: 50, status: 'frozen' }, { amount: 60, status: 'withdrawing' }, { amount: 70, isMock: true }, { amount: 80, pendingRefundIds: ['refund'] }, { amount: 90, status: 'pending', availableAt: new Date('2099-01-01') }])
  const r = await f.record({ amount: 0.07 })
  assert.equal(r.amount, 0.07)
  assert.deepEqual(f.db.state.staff_earnings.slice(0, 2).map(e => e.status), ['redeemed', 'redeemed'])
  assert.deepEqual(f.db.state.staff_earnings.slice(2).map(e => e.amount), [50, 60, 70, 80, 90])
  await assert.rejects(f.record({ clientRequestId: 'next', amount: 0.01 }), /超过当前可兑换/)
})

test('redemption rejects missing proof, confirmation, invalid precision and insufficient funds', async () => {
  const f = fixture()
  for (const patch of [{ paymentProofImage: '' }, { paymentProofImage: 'https://example.com/a.png' }, { paymentConfirmed: false }, { amount: 0 }, { amount: -1 }, { amount: 0.001 }, { amount: Infinity }, { amount: 101 }]) {
    await assert.rejects(f.record(patch))
  }
  assert.equal(f.db.state.staff_earnings[0].amount, 100)
  assert.equal((f.db.state.withdraw_requests || []).length, 0)
})

test('redemption rejects coerced boolean and array amounts without changing the ledger', async () => {
  for (const amount of [true, [1], ['30'], '0x10', '3e1']) {
    const f = fixture()
    await assert.rejects(f.record({ amount }), /有效金额/)
    assert.equal(f.db.state.staff_earnings[0].amount, 100)
    assert.equal((f.db.state.withdraw_requests || []).length, 0)
  }
})

test('an unreadable bound withdrawal cannot release earnings for preview or redemption', async () => {
  for (const operation of ['preview', 'record']) {
    const f = fixture([{ amount: 100, withdrawRequestId: 'held' }])
    f.db.state.withdraw_requests = [{ _id: 'held', status: 'pending', staffOpenid: 'staff', earningIds: ['e0'], amount: 100 }]
    const wrap = reader => ({ collection(name) {
      const collection = reader.collection(name)
      if (name === 'withdraw_requests') {
        const doc = collection.doc
        collection.doc = id => {
          const document = doc(id)
          if (id === 'held') document.get = async () => { throw new Error('withdrawal lookup unavailable') }
          return document
        }
      }
      return collection
    } })
    const collection = f.db.collection, run = f.db.runTransaction
    f.db.collection = wrap({ collection }).collection
    f.db.runTransaction = callback => run(tx => callback(wrap(tx)))
    await assert.rejects(operation === 'preview' ? f.context.getStaffRedemptionPreview('sp') : f.record(), /withdrawal lookup unavailable/)
    assert.equal(f.db.state.staff_earnings[0].withdrawRequestId, 'held')
    assert.equal(f.db.state.staff_earnings[0].amount, 100)
    assert.equal(f.db.state.withdraw_requests.length, 1)
  }
})

test('refreshing a stale withdrawal binding cannot erase a concurrently committed withdrawal', async () => {
  const f = fixture([{ amount: 100, withdrawRequestId: 'old' }])
  f.db.state.withdraw_requests = [{ _id: 'old', status: 'rejected', staffOpenid: 'staff', earningIds: ['e0'] }]
  require('./optimisticTransactions')(f.db)
  let injected = false
  const wrap = reader => ({ collection(name) {
    const collection = reader.collection(name)
    if (name === 'withdraw_requests') {
      const doc = collection.doc
      collection.doc = id => {
        const document = doc(id), get = document.get
        document.get = async () => {
          const result = await get()
          if (id === 'old' && !injected) {
            injected = true
            Object.assign(f.db.state.staff_earnings[0], { status: 'withdrawing', withdrawRequestId: 'new' })
            f.db.state.withdraw_requests.push({ _id: 'new', status: 'pending', staffOpenid: 'staff', earningIds: ['e0'], amount: 100 })
          }
          return result
        }
        return document
      }
    }
    return collection
  } })
  const collection = f.db.collection, run = f.db.runTransaction
  f.db.collection = wrap({ collection }).collection
  f.db.runTransaction = callback => run(tx => callback(wrap(tx)))
  assert.equal((await f.context.getStaffRedemptionPreview('sp')).available, 0)
  assert.equal(injected, true)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
  assert.equal(f.db.state.staff_earnings[0].withdrawRequestId, 'new')
  await assert.rejects(f.record(), /超过当前可兑换/)
})

test('a legacy available earning linked to a paid withdrawal cannot be redeemed again', async () => {
  for (const operation of ['preview', 'record']) {
    const f = fixture([{ amount: 70, redeemedAmount: 30, originalAmount: 100, withdrawRequestId: 'paid' }])
    f.db.state.withdraw_requests = [{ _id: 'paid', status: 'paid', staffOpenid: 'staff', earningIds: ['e0'], amount: 70 }]
    if (operation === 'preview') {
      const preview = await f.context.getStaffRedemptionPreview('sp')
      assert.equal(preview.available, 0)
      assert.equal(preview.maxRedemptionAmount, 0)
      assert.equal(preview.redeemed, 30)
    } else {
      await assert.rejects(f.record(), /超过当前可兑换/)
    }
    assert.equal(f.db.state.staff_earnings[0].withdrawRequestId, 'paid')
    assert.equal(f.db.state.staff_earnings[0].amount, 70)
    assert.equal(f.db.state.withdraw_requests.length, 1)
  }
})

test('switching back to withdrawals selects only earnings without existing payout bindings', async () => {
  for (const status of ['pending', 'approved', 'paid']) {
    const f = fixture([{ amount: 100, withdrawRequestId: 'reserved' }, { amount: 10 }])
    f.db.state.withdraw_requests = [{ _id: 'reserved', status, staffOpenid: 'staff', earningIds: ['e0'], amount: 100 }]
    f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
    const result = await f.context.createWithdrawRequest('staff', { payoutChannel: 'wechat_wallet', clientRequestId: 'new' })
    assert.equal(result.amount, 10)
    assert.deepEqual(result.earningIds, ['e1'])
    assert.equal(f.db.state.staff_earnings[0].withdrawRequestId, 'reserved')
    assert.equal(f.db.state.staff_earnings[0].amount, 100)
  }
})

test('admin settlement cannot reuse an earning already bound to an approved withdrawal', async () => {
  const f = fixture([{ amount: 100, withdrawRequestId: 'reserved' }])
  f.db.state.withdraw_requests = [{ _id: 'reserved', status: 'approved', staffOpenid: 'staff', earningIds: ['e0'], amount: 100 }]
  await assert.rejects(f.context.createWithdrawRequest('staff', {
    payoutChannel: 'wechat_wallet', clientRequestId: 'settlement', amount: 100
  }, { adminSettlementId: 'settlement', adminOpenid: 'admin', earningIds: ['e0'] }), /收益.*(锁定|占用|绑定)/)
  assert.equal(f.db.state.staff_earnings[0].withdrawRequestId, 'reserved')
  assert.equal(f.db.state.withdraw_requests.length, 1)
})

test('redemption preview exposes the executable batch limit across more than 100 earnings', async () => {
  const f = fixture([{ amount: 0 }, { amount: 100, pendingRefundIds: ['r'] }, ...Array.from({ length: 105 }, () => ({ amount: 1 }))])
  const preview = await f.context.getStaffRedemptionPreview('sp')
  assert.equal(preview.available, 105)
  assert.equal(preview.maxRedemptionAmount, 50)
  await assert.rejects(f.record({ amount: 50.01 }), /50笔/)
  assert.equal((f.db.state.withdraw_requests || []).length, 0)
  for (const [index, expected] of [50, 50, 5].entries()) {
    const next = await f.context.getStaffRedemptionPreview('sp')
    assert.equal(next.maxRedemptionAmount, expected)
    const record = await f.record({ clientRequestId: `batch-${index}`, amount: next.maxRedemptionAmount })
    assert.ok(record.allocations.length <= 50)
  }
  assert.equal((await f.context.getStaffRedemptionPreview('sp')).maxRedemptionAmount, 0)
  assert.equal(f.context.summarizeStaffEarnings(f.db.state.staff_earnings).redeemed, 105)
})

test('preview-only administrators cannot record redemption or alter balances', async () => {
  const f = fixture()
  f.db.state.admin_access_config = [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }]
  f.db.state.admin_memberships = [{ _id: 'admin', groupIds: ['readers'] }]
  f.db.state.admin_groups = [{ _id: 'readers', enabled: true, permissions: ['admin.getStaffRedemptionPreview'] }]
  const handler = require('../../cloudfunctions/api/handlers/admin')(f.context)
  const call = (action, data) => f.context.runAdminRequest('admin', action, data, () => handler('admin', action, data))
  assert.equal((await call('getStaffRedemptionPreview', { staffProfileId: 'sp' })).available, 100)
  await assert.rejects(call('recordStaffEarningRedemption', f.data), error => error.code === 'ADMIN_FORBIDDEN')
  assert.equal(f.db.state.staff_earnings[0].amount, 100)
  assert.equal((f.db.state.withdraw_requests || []).length, 0)
  f.db.state.admin_groups[0].permissions.push('admin.recordStaffEarningRedemption')
  assert.equal((await call('recordStaffEarningRedemption', f.data)).status, 'paid')
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
})

test('concurrent duplicate redemption commits once, while competing redemptions cannot overdraw', async () => {
  const f = fixture()
  require('./optimisticTransactions')(f.db)
  const same = await Promise.all([f.record({ amount: 80 }), f.record({ amount: 80 })])
  assert.equal(same[0]._id, same[1]._id)
  assert.equal(f.db.state.staff_earnings[0].amount, 20)
  const attempts = await Promise.allSettled([f.record({ clientRequestId: 'two', amount: 15 }), f.record({ clientRequestId: 'three', amount: 15 })])
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.db.state.staff_earnings[0].amount, 5)
})

test('failed audit-log writes roll back the redemption and the remaining earnings', async () => {
  const f = fixture(), run = f.db.runTransaction
  f.db.runTransaction = callback => run(tx => callback({ collection(name) {
    const collection = tx.collection(name)
    if (name === 'admin_operation_logs') collection.doc = () => ({ set: async () => { throw new Error('write failure') } })
    return collection
  } }))
  await assert.rejects(f.record(), /write failure/)
  assert.equal(f.db.state.staff_earnings[0].amount, 100)
  assert.equal((f.db.state.withdraw_requests || []).length, 0)
})

test('a lost transaction response is recovered from the committed record and remains safe to retry', async () => {
  const f = fixture()
  const run = f.db.runTransaction
  let loseResponse = true
  f.db.runTransaction = async callback => {
    const result = await run(callback)
    if (loseResponse) {
      loseResponse = false
      throw new Error('response connection lost')
    }
    return result
  }
  const recovered = await f.record()
  assert.equal(recovered.status, 'paid')
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
  const retry = await f.record()
  assert.equal(retry._id, recovered._id)
  assert.equal(retry.status, 'paid')
  assert.equal(retry.amount, 30)
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.equal(f.db.state.finance_logs.length, 1)
  assert.equal(f.db.state.admin_operation_logs.length, 1)
})

test('an unavailable commit confirmation keeps the result uncertain and a later retry deducts nothing more', async () => {
  const f = fixture()
  const run = f.db.runTransaction, collection = f.db.collection
  let confirmationUnavailable = false
  f.db.collection = name => {
    const target = collection(name)
    if (name === 'withdraw_requests') {
      const doc = target.doc
      target.doc = id => {
        const record = doc(id), get = record.get
        record.get = async () => {
          if (confirmationUnavailable) throw new Error('confirmation read unavailable')
          return get()
        }
        return record
      }
    }
    return target
  }
  f.db.runTransaction = async callback => {
    await run(callback)
    confirmationUnavailable = true
    throw new Error('response connection lost')
  }
  await assert.rejects(f.record(), error => /confirmation read unavailable/.test(error.message) && error.code !== 'STAFF_REDEMPTION_REVIEW_REQUIRED')
  confirmationUnavailable = false
  assert.equal((await f.record()).status, 'paid')
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  assert.equal(f.db.state.withdraw_requests.length, 1)
})

test('overlapping refund reservation and redemption preserve the hold and cannot spend it again', async () => {
  const f = fixture([{ amount: 100, originalAmount: 100 }])
  const retries = require('./optimisticTransactions')(f.db)
  const run = f.db.runTransaction
  let ready = 0, release
  const bothReady = new Promise(resolve => { release = resolve })
  f.db.runTransaction = callback => run(async tx => {
    const result = await callback(tx)
    if (++ready === 2) release()
    await bothReady
    return result
  })
  const [redemption, reservation] = await Promise.allSettled([
    f.record({ amount: 60 }),
    f.context.adjustStaffEarningsForRefund('o0', 100, 100, '', null, { phase: 'reserve', refundId: 'r' })
  ])
  assert.equal(reservation.status, 'fulfilled')
  assert.ok(retries() > 0, 'The two transactions must overlap')
  const paid = redemption.status === 'fulfilled' ? 60 : 0
  assert.equal(f.db.state.staff_earnings[0].amount, 100 - paid)
  assert.deepEqual(f.db.state.staff_earnings[0].pendingRefundIds, ['r'])
  await assert.rejects(f.record({ clientRequestId: 'held', amount: 1 }), /超过当前可兑换/)
  await f.context.adjustStaffEarningsForRefund('o0', 100, 100, '', null, { phase: 'failed', refundId: 'r' })
  await f.record({ clientRequestId: 'released', amount: 100 - paid })
  assert.equal(f.db.state.staff_earnings[0].amount, 0)
  assert.equal(f.db.state.staff_earnings[0].redeemedAmount, 100)
})

test('manual mode blocks new self withdrawals; disabling it allows only the unredeemed balance', async () => {
  const f = fixture()
  await assert.rejects(f.context.createWithdrawRequest('staff', { amount: 100, accountName: '测试', accountNo: '12345678', clientRequestId: 'withdraw' }), /关闭自主提现/)
  await f.record()
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
  await assert.rejects(f.record({ clientRequestId: 'new' }), /先开启/)
  const result = await f.context.createWithdrawRequest('staff', { amount: 70, accountName: '测试', accountNo: '12345678', clientRequestId: 'withdraw' })
  assert.equal(result.amount, 70)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawing')
  assert.equal((await f.record()).amount, 30)
})

test('mode changes are checked again inside withdrawal and redemption transactions', async () => {
  for (const kind of ['withdraw', 'redeem']) {
    const f = fixture(), run = f.db.runTransaction
    if (kind === 'withdraw') f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
    f.db.runTransaction = callback => {
      f.db.state.platform_configs[0].value.settlement.staffEarningsMode = kind === 'withdraw' ? 'manual_redemption' : 'withdrawal'
      return run(callback)
    }
    await assert.rejects(kind === 'withdraw'
      ? f.context.createWithdrawRequest('staff', { amount: 100, accountName: '测试', accountNo: '12345678', clientRequestId: 'w' })
      : f.record(), /收益方式已变更|关闭自主提现/)
    assert.equal(f.db.state.staff_earnings[0].amount, 100)
  }
})

test('a concurrent successful redemption wins over a later preflight mode rejection for the same request', async () => {
  const f = fixture()
  const originalRecord = f.context.recordStaffEarningRedemption
  const service = createRedemption({ ...f.context,
    checkImageSecurity: async () => {}, checkTextSecurity: async () => {},
    getSystemSettings: async () => {
      // The first request finishes while its retry is still checking settings.
      await originalRecord({ _id: 'admin', openid: 'admin' }, f.data)
      f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
      return f.context.getSystemSettings()
    }
  })
  const result = await service.recordStaffEarningRedemption({ _id: 'admin', openid: 'admin' }, f.data)
  assert.equal(result.status, 'paid')
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  assert.equal(f.db.state.withdraw_requests.length, 1)
  assert.equal(f.db.state.finance_logs.length, 1)
})

test('existing withdrawal applications remain payable after enabling manual mode', async () => {
  const f = fixture()
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
  const request = await f.context.createWithdrawRequest('staff', { amount: 100, accountName: '测试', accountNo: '12345678', clientRequestId: 'w' })
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'manual_redemption'
  await f.context.settleWithdrawal({ openid: 'admin' }, { id: request._id, approved: true })
  await f.context.settleWithdrawal({ openid: 'admin' }, { id: request._id, paymentConfirmed: true, paymentReference: 'PAID-1' }, true)
  assert.equal(f.db.state.staff_earnings[0].status, 'withdrawn')
  assert.equal(f.db.state.withdraw_requests[0].status, 'paid')
})

test('refunds after a partial redemption consume the remainder then track paid debt', async () => {
  const f = fixture([{ amount: 100, originalAmount: 100 }])
  await f.record({ amount: 60 })
  await f.context.adjustStaffEarningsForRefund('o0', 30, 100, '首次退款', null, { refundId: 'r1', cumulativeRefundAmount: 30 })
  assert.equal(f.db.state.staff_earnings[0].amount, 10)
  assert.equal(f.db.state.staff_earnings[0].overpaidDebtAmount, 0)
  await f.context.adjustStaffEarningsForRefund('o0', 70, 100, '全退', null, { refundId: 'r2', cumulativeRefundAmount: 100 })
  assert.equal(f.db.state.staff_earnings[0].amount, 0)
  assert.equal(f.db.state.staff_earnings[0].redeemedAmount, 60)
  assert.equal(f.db.state.staff_earnings[0].overpaidDebtAmount, 60)
  assert.equal(f.db.state.staff_earnings[0].status, 'redeemed')
})

test('refund during a pending withdrawal returns only the unpaid remainder after redemption', async () => {
  const f = fixture([{ amount: 100, originalAmount: 100 }])
  await f.record({ amount: 60 })
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
  const withdrawal = await f.context.createWithdrawRequest('staff', { amount: 40, accountName: '测试', accountNo: '12345678', clientRequestId: 'pending' })
  await f.context.adjustStaffEarningsForRefund('o0', 30, 100, '部分退款', null, { refundId: 'r', cumulativeRefundAmount: 30 })
  assert.equal(f.db.state.withdraw_requests.find(r => r._id === withdrawal._id).status, 'rejected')
  const earning = f.db.state.staff_earnings[0]
  assert.equal(earning.amount, 10)
  assert.equal(earning.redeemedAmount, 60)
  assert.equal(earning.deductedAmount, 30)
  assert.equal(earning.overpaidDebtAmount, 0)
  assert.equal(earning.withdrawRequestId, '')
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'manual_redemption'
  await f.record({ clientRequestId: 'remainder', amount: 10 })
  assert.equal(f.db.state.staff_earnings[0].amount, 0)
  assert.equal(f.db.state.staff_earnings[0].redeemedAmount, 70)
})

test('freezing then refunding and releasing a partially redeemed earning preserves all paid amounts', async () => {
  const f = fixture([{ amount: 100, originalAmount: 100 }])
  f.db.state.order_incidents = [{ _id: 'i', orderId: 'o0', staffOpenid: 'staff', status: 'processing', frozenEarningIds: [] }]
  await f.record({ amount: 60 })
  await f.context.freezeIncidentEarnings('i', 'admin')
  assert.equal((await f.context.getStaffRedemptionPreview('sp')).available, 0)
  await f.context.adjustStaffEarningsForRefund('o0', 30, 100, '部分退款', null, { refundId: 'r', cumulativeRefundAmount: 30 })
  assert.equal(f.db.state.staff_earnings[0].status, 'frozen')
  await f.context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'release' }, 'admin')
  const preview = await f.context.getStaffRedemptionPreview('sp')
  assert.equal(preview.available, 10)
  assert.equal(preview.redeemed, 60)
  assert.equal(f.db.state.staff_earnings[0].deductedAmount, 30)
  await f.record({ clientRequestId: 'released', amount: 10 })
  assert.equal(f.context.summarizeStaffEarnings(f.db.state.staff_earnings).redeemed, 70)
})

test('releasing a refunded frozen remainder retains the redeemed status and any paid debt', async () => {
  for (const refundAmount of [40, 100]) {
    const f = fixture([{ amount: 100, originalAmount: 100 }])
    f.db.state.order_incidents = [{ _id: 'i', orderId: 'o0', staffOpenid: 'staff', status: 'processing', frozenEarningIds: [] }]
    await f.record({ amount: 60 })
    await f.context.freezeIncidentEarnings('i', 'admin')
    await f.context.adjustStaffEarningsForRefund('o0', refundAmount, 100, '退款', null, { refundId: 'r', cumulativeRefundAmount: refundAmount })
    assert.equal(f.db.state.staff_earnings[0].status, 'frozen')
    await f.context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'release' }, 'admin')
    const row = f.db.state.staff_earnings[0]
    assert.equal(row.status, 'redeemed')
    assert.equal(row.amount, 0)
    assert.equal(row.redeemedAmount, 60)
    assert.equal(row.deductedAmount, 40)
    assert.equal(row.overpaidDebtAmount, refundAmount - 40)
    assert.equal(row.frozenIncidentId, '')
    assert.equal((await f.context.getStaffRedemptionPreview('sp')).available, 0)
  }
})

test('incident deductions preserve redemption history when the remaining earnings are exhausted', async () => {
  for (const deductAmount of [25, 40]) {
    const f = fixture([{ amount: 100, originalAmount: 100 }])
    f.db.state.order_incidents = [{ _id: 'i', orderId: 'o0', staffOpenid: 'staff', status: 'processing', frozenEarningIds: [] }]
    await f.record({ amount: 60 })
    await f.context.freezeIncidentEarnings('i', 'admin')
    const data = { status: 'closed', earningDecision: 'deduct', deductAmount }
    await f.context.closeIncidentFinancially('i', data, 'admin')
    await f.context.closeIncidentFinancially('i', data, 'admin')
    const row = f.db.state.staff_earnings[0]
    assert.equal(row.status, deductAmount === 40 ? 'redeemed' : 'available')
    assert.equal(row.amount, 40 - deductAmount)
    assert.equal(row.redeemedAmount, 60)
    assert.equal(row.deductedAmount, deductAmount)
    assert.equal(f.db.state.order_incidents[0].earningResolution.deductedAmount, deductAmount)
    assert.equal((await f.context.getStaffRedemptionPreview('sp')).available, 40 - deductAmount)
  }
})

test('finance reports retain earned totals and count manually redeemed money as paid', async () => {
  const f = fixture()
  const before = await f.context.aggregateFinanceDashboard()
  await f.record()
  const after = await f.context.aggregateFinanceDashboard()
  assert.equal(after.metrics.staffEarningAmount, before.metrics.staffEarningAmount)
  assert.equal(after.metrics.platformGrossProfit, before.metrics.platformGrossProfit)
  assert.equal(after.metrics.paidWithdrawAmount, 30)
})

test('a full refund retains redeemed costs in the order profit summary', async () => {
  const f = fixture([{ amount: 100, originalAmount: 100 }])
  await f.record({ amount: 60 })
  await f.context.adjustStaffEarningsForRefund('o0', 100, 100, '全退', null, { refundId: 'full', cumulativeRefundAmount: 100 })
  const summary = f.context.buildOrderProfitSummary({ payAmount: 100, refundedAmount: 100, paymentStatus: 'refunded', status: 'cancelled' }, f.db.state.staff_earnings[0])
  assert.equal(summary.staffReward, 60)
  assert.equal(summary.platformProfit, -60)
  assert.equal(summary.settlementStatus, 'refunded')
  assert.doesNotMatch(summary.settlementStatusText, /无收益/)
  assert.equal((await f.context.aggregateFinanceDashboard()).metrics.staffEarningAmount, summary.staffReward)
})

test('redemption then withdrawal and refunds preserve both paid amounts and cumulative debt', async () => {
  const f = fixture([{ amount: 100, originalAmount: 100 }])
  await f.record({ amount: 30 })
  f.db.state.platform_configs[0].value.settlement.staffEarningsMode = 'withdrawal'
  const request = await f.context.createWithdrawRequest('staff', { amount: 70, accountName: '测试', accountNo: '12345678', clientRequestId: 'w' })
  await f.context.settleWithdrawal({ openid: 'admin' }, { id: request._id, approved: true })
  await f.context.settleWithdrawal({ openid: 'admin' }, { id: request._id, paymentConfirmed: true, paymentReference: 'PAID-2' }, true)
  await f.context.adjustStaffEarningsForRefund('o0', 40, 100, '部分退款', null, { refundId: 'part', cumulativeRefundAmount: 40 })
  assert.equal(f.db.state.staff_earnings[0].overpaidDebtAmount, 40)
  await f.context.adjustStaffEarningsForRefund('o0', 60, 100, '全退', null, { refundId: 'full', cumulativeRefundAmount: 100 })
  const earning = f.db.state.staff_earnings[0]
  assert.equal(earning.overpaidDebtAmount, 100)
  assert.equal(earning.amount, 70)
  assert.equal(earning.redeemedAmount, 30)
  const balance = f.context.summarizeStaffEarnings([earning])
  assert.equal(balance.available, 0)
  assert.equal(balance.withdrawn, 70)
  assert.equal(balance.redeemed, 30)
  const profit = f.context.buildOrderProfitSummary({ payAmount: 100, refundedAmount: 100, paymentStatus: 'refunded', status: 'cancelled' }, earning)
  assert.equal(profit.staffReward, 100)
  assert.equal(profit.platformProfit, -100)
})

test('balance API exposes the mode, estimated remainder and redemption history', async () => {
  const f = fixture()
  await f.record()
  const finance = require('../../cloudfunctions/api/handlers/finance')(f.context)
  const balance = await finance('staff', 'getStaffBalance', {})
  assert.equal(balance.manualRedemption, true)
  assert.equal(balance.withdrawalEnabled, false)
  assert.equal(balance.estimated, 90)
  assert.equal(balance.redeemed, 30)
  const history = await finance('staff', 'listMyWithdraws', {})
  assert.equal(history[0].paymentProofImage, f.data.paymentProofImage)
})

test('redemption mode defaults to withdrawal and survives unrelated settings updates', () => {
  const f = fixture()
  assert.equal(f.context.normalizeSystemSettings({}).settlement.staffEarningsMode, 'withdrawal')
  assert.equal(f.context.normalizeSystemSettings({}, { existingSettings: f.db.state.platform_configs[0].value }).settlement.staffEarningsMode, 'manual_redemption')
  const { tree } = require('../../cloudfunctions/api/config/adminPermissions')
  const permission = tree.flatMap(group => group.children).find(p => p.id === 'admin.recordStaffEarningRedemption')
  assert.ok(permission)
  assert.equal(permission.risk, true)
  assert.ok(permission.requires.includes('admin.getStaffRedemptionPreview'))
})

test('held available earnings are excluded consistently from balance, admin list and redemption preview', async () => {
  const f = fixture([{ amount: 100 }, { amount: 20, pendingRefundIds: ['refund'] }, { amount: 30, frozenIncidentId: 'incident' }, { amount: 10, status: 'pending', availableAt: new Date('2099-01-01') }])
  const preview = await f.context.getStaffRedemptionPreview('sp')
  const finance = require('../../cloudfunctions/api/handlers/finance')(f.context)
  const balance = await finance('staff', 'getStaffBalance', {})
  const admin = require('../../cloudfunctions/api/handlers/admin')(f.context)
  const profiles = await admin('admin', 'listStaffProfiles', {})
  assert.equal(preview.estimated, 110)
  assert.equal(balance.estimated, preview.estimated)
  assert.equal(balance.available, preview.available)
  assert.equal(balance.frozen, 50)
  assert.equal(profiles.list[0].estimatedEarnings, preview.estimated)
  assert.equal(profiles.list[0].withdrawableAmount, preview.available)
})
