const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createAdminHandler = require('../../cloudfunctions/api/handlers/admin')
const { withdrawalNotification, buildWithdrawalSubscriptionData } = require('../../cloudfunctions/api/services/withdrawalNotifications')

const admin = { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }
const expected = {
  approved: ['审核通过', '审核已通过，请查看提现进度'],
  wait_confirm: ['待确认', '请确认收款，24小时未确认将放弃提现'],
  rejected: ['已驳回', '提现未通过，请查看原因后重新申请'],
  paid: ['已到账', '提现已到账，请留意微信零钱'],
  transfer_failed: ['打款失败', '提现打款失败，请查看详情联系平台']
}

function setup(assetType, sendError) {
  const user = assetType === 'user'
  const owner = user ? { userOpenid: 'client', staffOpenid: 'wrong-staff' } : { staffOpenid: 'staff', userOpenid: 'wrong-client' }
  const collection = user ? 'user_asset_earnings' : 'staff_earnings'
  const db = createCollectionStore({
    users: [admin, { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active' }],
    withdraw_requests: [{ _id: 'w', assetType, ...owner, amount: 12.34, earningIds: ['e'],
      status: 'pending', outBillNo: 'BILL1', payoutChannel: 'wechat_wallet' }],
    [collection]: [{ _id: 'e', ...owner, amount: 12.34, status: 'withdrawing', withdrawRequestId: 'w' }],
    finance_logs: [], admin_operation_logs: [], subscription_logs: [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      subscription: { enabled: true, templates: { withdrawResult: 'withdraw-template' } }
    } }]
  })
  const sent = []
  const context = createContext({ db, cloud: { openapi: { subscribeMessage: { send: async payload => {
    sent.push(payload)
    if (sendError) throw sendError
  } } } } })
  context.checkTextSecurity = async () => {}
  return { db, context, sent, collection,
    request: () => db.state.withdraw_requests[0],
    deliveries: () => db.state.subscription_logs.filter(row => row.delivery),
    enqueue: message => db.runTransaction(tx => context.enqueueSubscription(tx, message)) }
}

function assertPayload(payload, assetType, event) {
  assert.deepEqual(payload, {
    touser: assetType === 'user' ? 'client' : 'staff', templateId: 'withdraw-template',
    page: `${assetType === 'user' ? 'pages/client/profile/assets/index' : 'pages/staff/earnings/index'}?tab=withdraws`,
    data: { amount1: { value: '12.34' }, phrase2: { value: expected[event][0] }, thing3: { value: expected[event][1] } }
  })
}

for (const assetType of ['staff', 'user']) {
  test(`${assetType}: rejection commits notification with money release and deduplicates repeated decisions`, async () => {
    const { context, db, collection, request, deliveries, sent } = setup(assetType)
    assert.equal((await context.settleWithdrawal(admin, { id: 'w', approved: false })).changed, true)
    assert.equal((await context.settleWithdrawal(admin, { id: 'w', approved: false })).changed, false)
    assert.equal(request().status, 'rejected')
    assert.equal(db.state[collection][0].status, 'available')
    assert.equal(db.state[collection][0].withdrawRequestId, '')
    assert.equal(db.state.finance_logs.length, 1)
    assert.equal(deliveries().length, 1)
    assert.equal(deliveries()[0].status, 'queued')
    assert.equal(sent.length, 0, 'no external sends inside settlement transaction')
    await context.retryFailedSubscriptions()
    await context.notifyWithdrawal(request(), 'rejected')
    await context.retryFailedSubscriptions()
    assert.equal(sent.length, 1)
    assertPayload(sent[0], assetType, 'rejected')
    assert.equal(deliveries()[0].status, 'sent')
  })

  for (const failingCollection of ['subscription_logs', 'finance_logs']) {
    test(`${assetType}: ${failingCollection} failure rolls back rejection and its queued notification`, async () => {
      const { context, db, sent } = setup(assetType)
      const before = structuredClone(db.state)
      const transaction = db.runTransaction.bind(db)
      db.runTransaction = callback => transaction(tx => callback({ ...tx, collection(name) {
        const collection = tx.collection(name)
        if (name !== failingCollection) return collection
        const doc = collection.doc.bind(collection)
        collection.doc = id => ({ ...doc(id), set: async () => { throw new Error('injected notification transaction failure') } })
        return collection
      } }))
      await assert.rejects(context.settleWithdrawal(admin, { id: 'w', approved: false }), /injected notification transaction failure/)
      assert.deepEqual(db.state, before)
      assert.equal(sent.length, 0)
    })
  }

  test(`${assetType}: repeated WAIT_USER_CONFIRM queues one bill-specific reminder and supersedes unsent approval`, async () => {
    const { context, request, deliveries, sent } = setup(assetType)
    await context.settleWithdrawal(admin, { id: 'w', approved: true })
    for (let i = 0; i < 2; i++) await context.applyWechatTransferResult('w', { state: 'WAIT_USER_CONFIRM', package_info: 'package' })
    assert.equal(request().status, 'transferring')
    assert.equal(deliveries().length, 2)
    const reminder = deliveries().find(row => row.withdrawalEvent === 'wait_confirm')
    assert.equal(reminder.deliveryKey, 'withdraw:w:wait_confirm:BILL1')
    assert.equal(reminder.withdrawalBillNo, 'BILL1')
    await context.retryFailedSubscriptions()
    await context.notifyWithdrawal(request(), 'wait_confirm')
    assert.equal(sent.length, 1)
    assertPayload(sent[0], assetType, 'wait_confirm')
    const approval = deliveries().find(row => row.withdrawalEvent === 'approved')
    assert.equal(approval.status, 'skipped')
    assert.equal(approval.error, 'withdrawal_notice_obsolete')
    assert.equal(deliveries().find(row => row.withdrawalEvent === 'wait_confirm').status, 'sent')
  })

  test(`${assetType}: auto-confirm SUCCESS sends only an arrival notice without manual collection hints`, async () => {
    const { context, db, collection, request, deliveries, sent } = setup(assetType)
    await context.settleWithdrawal(admin, { id: 'w', approved: true })
    await db.collection('withdraw_requests').doc('w').update({ data: { transferMode: 'auto_confirm' } })
    await context.applyWechatTransferResult('w', { state: 'WAIT_USER_CONFIRM' })
    assert.equal(deliveries().some(row => row.withdrawalEvent === 'wait_confirm'), false)
    await context.applyWechatTransferResult('w', { state: 'SUCCESS', transfer_bill_no: 'WX1' })
    await context.applyWechatTransferResult('w', { state: 'SUCCESS', transfer_bill_no: 'WX1' })
    await context.retryFailedSubscriptions()
    assert.equal(request().status, 'paid')
    assert.equal(db.state[collection][0].status, 'withdrawn')
    assert.equal(db.state[collection][0].amount, 12.34)
    assert.equal(deliveries().filter(row => row.withdrawalEvent === 'paid').length, 1)
    assert.equal(sent.length, 1)
    assertPayload(sent[0], assetType, 'paid')
    assert.doesNotMatch(JSON.stringify(sent[0]), /确认收款|24小时|待确认/)
  })

  for (const change of ['paid', 'replaced bill']) {
    test(`${assetType}: queued wait reminder is skipped after ${change}`, async () => {
      const { context, db, deliveries, sent } = setup(assetType)
      await context.settleWithdrawal(admin, { id: 'w', approved: true })
      await context.applyWechatTransferResult('w', { state: 'WAIT_USER_CONFIRM' })
      if (change === 'paid') await context.applyWechatTransferResult('w', { state: 'SUCCESS', transfer_bill_no: 'WX1' })
      else await db.collection('withdraw_requests').doc('w').update({ data: { outBillNo: 'BILL2' } })
      await context.retryFailedSubscriptions()
      const reminder = deliveries().find(row => row.withdrawalEvent === 'wait_confirm')
      assert.equal(reminder.status, 'skipped')
      assert.equal(reminder.error, 'withdrawal_notice_obsolete')
      assert.equal(sent.length, change === 'paid' ? 1 : 0)
      if (change === 'paid') assertPayload(sent[0], assetType, 'paid')
    })
  }

  test(`${assetType}: repeated gateway failure sends one failure notice and keeps funds reserved`, async () => {
    const { context, db, collection, request, deliveries, sent } = setup(assetType)
    await context.settleWithdrawal(admin, { id: 'w', approved: true })
    await context.applyWechatTransferResult('w', { state: 'FAIL', fail_reason: 'failure '.repeat(100) })
    await context.retryFailedSubscriptions()
    await context.applyWechatTransferResult('w', { state: 'FAIL', fail_reason: 'failure '.repeat(100) })
    await context.retryFailedSubscriptions()
    assert.equal(request().status, 'transfer_failed')
    assert.equal(db.state[collection][0].status, 'withdrawing')
    assert.equal(db.state[collection][0].withdrawRequestId, 'w')
    assert.equal(deliveries().filter(row => row.withdrawalEvent === 'transfer_failed').length, 1)
    assert.equal(sent.length, 1)
    assertPayload(sent[0], assetType, 'transfer_failed')
  })

  test(`${assetType}: WeChat 43101 does not undo committed payout or ledger`, async () => {
    const { context, db, collection, request, deliveries, sent } = setup(assetType,
      Object.assign(new Error('43101 user refused subscription'), { errCode: 43101 }))
    await context.settleWithdrawal(admin, { id: 'w', approved: true })
    await context.applyWechatTransferResult('w', { state: 'SUCCESS', transfer_bill_no: 'WX1' })
    const moneyBeforeSend = structuredClone({ request: request(), ledger: db.state[collection], finance: db.state.finance_logs })
    await context.retryFailedSubscriptions()
    assert.equal(sent.length, 1)
    assert.deepEqual({ request: request(), ledger: db.state[collection], finance: db.state.finance_logs }, moneyBeforeSend)
    assert.equal(request().status, 'paid')
    assert.equal(db.state[collection][0].status, 'withdrawn')
    const paid = deliveries().find(row => row.withdrawalEvent === 'paid')
    assert.equal(paid.isQuotaExhausted, true)
    assert.equal(paid.code, 43101)
  })

  test(`${assetType}: ACCEPTED audit notice is not a manual-confirmation notice; later WAIT gets its own reminder`, async () => {
    const { context, request, sent } = setup(assetType)
    context.submitWechatWithdrawalTransfer = id => context.applyWechatTransferResult(id, { state: 'ACCEPTED' }, 'submit')
    const handler = createAdminHandler(context)
    const result = await handler('admin', 'auditWithdrawRequest', { id: 'w', approved: true })
    assert.equal(result.status, 'transferring')
    assert.equal(sent.length, 1)
    assertPayload(sent[0], assetType, 'approved')
    assert.doesNotMatch(JSON.stringify(sent[0]), /确认收款|24小时|待确认/)
    await context.applyWechatTransferResult('w', { state: 'WAIT_USER_CONFIRM', package_info: 'package' })
    await context.retryFailedSubscriptions()
    await context.notifyWithdrawal(request(), 'wait_confirm')
    assert.equal(sent.length, 2)
    assertPayload(sent[1], assetType, 'wait_confirm')
  })

  test(`${assetType}: legacy queued payload is rebuilt from authoritative withdrawal, not stored amount or route`, async () => {
    const { context, db, request, enqueue, deliveries, sent } = setup(assetType)
    await db.collection('withdraw_requests').doc('w').update({ data: { status: 'rejected' } })
    const message = withdrawalNotification(request(), 'rejected')
    delete message.withdrawalId
    delete message.withdrawalEvent
    delete message.withdrawalBillNo
    message.page = 'pages/wrong/index'
    message.messageData = { amount1: { value: '999.99' }, thing4: { value: 'legacy' } }
    await enqueue(message)
    await context.retryFailedSubscriptions()
    assert.equal(sent.length, 1)
    assertPayload(sent[0], assetType, 'rejected')
    assert.equal(deliveries()[0].status, 'sent')
  })

  for (const invalid of ['missing identity', 'unknown event', 'wrong owner']) {
    test(`${assetType}: ${invalid} queued payload is skipped without sending`, async () => {
      const { context, db, request, enqueue, deliveries, sent } = setup(assetType)
      await db.collection('withdraw_requests').doc('w').update({ data: { status: 'rejected' } })
      const message = withdrawalNotification(request(), 'rejected')
      if (invalid === 'wrong owner') message.openid = 'another-user'
      else {
        delete message.withdrawalId
        delete message.withdrawalEvent
        message.deliveryKey = invalid === 'missing identity' ? 'legacy-without-id' : 'withdraw:w:unknown'
      }
      await enqueue(message)
      await context.retryFailedSubscriptions()
      assert.equal(sent.length, 0)
      assert.equal(deliveries()[0].status, 'skipped')
      assert.equal(deliveries()[0].error, invalid === 'wrong owner' ? 'withdrawal_notice_obsolete' : 'legacy_withdrawal_payload')
    })
  }
}

test('every withdrawal event uses exact template fields and respects phrase/thing limits', () => {
  for (const [event, [status, tip]] of Object.entries(expected)) {
    const data = buildWithdrawalSubscriptionData({ amount: 12.34, auditRemark: '长'.repeat(500), failureReason: '错'.repeat(500) }, event)
    assert.deepEqual(data, { amount1: { value: '12.34' }, phrase2: { value: status }, thing3: { value: tip } })
    assert.ok(data.phrase2.value.length <= 5, event)
    assert.ok(data.thing3.value.length <= 20, event)
  }
})
