const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

function fixture({ template = 'direct-8560', publishMode = 'direct', concurrent = true } = {}) {
  const db = createCollectionStore({
    platform_configs: [{ _id: 'config', key: 'system_settings', value: { subscription: { enabled: true, templates: { staffDirectOrder: template } } } }],
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'staff2', openid: 'staff2', roles: ['staff'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    staff_profiles: [{ _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified' },
      { _id: 'profile2', openid: 'staff2', auditStatus: 'approved', staffLevel: 'certified' }],
    orders: [{ _id: 'order', orderNo: 'O202610110002', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid',
      publishMode, requestedStaffOpenid: publishMode === 'direct' ? 'staff' : '', staffOpenid: '',
      payAmount: 89.9, serviceSummary: '上门遛狗', startTime: '2099-10-11 10:00', endTime: '2099-10-11 11:00', createdAt: new Date() }]
  })
  if (concurrent) optimistic(db)
  const sent = []
  const cloud = { openapi: { subscribeMessage: { send: async message => { sent.push(message) } } } }
  const ctx = createContext({ db, cloud })
  const order = () => structuredClone(db.state.orders[0])
  const pay = async () => {
    const payment = await ctx.reserveOrderPayment(order(), 'client', 'wechat', 'pay1')
    return ctx.settleOrderPayment('order', { paymentNo: payment.paymentNo, wxTransactionId: 'wx1' })
  }
  const assign = (staff = 'staff', admin = true) => ctx.assignOrderAtomically('order', order(), {
    staffOpenid: staff, staffUserId: staff, staffProfileId: staff === 'staff' ? 'profile' : 'profile2',
    status: 'assigned', assignedAt: new Date(), assignmentSource: admin ? 'admin_assign' : 'staff_accept'
  }, { admin })
  const deliveries = () => (db.state.subscription_logs || []).filter(row => row.delivery && row.templateKey === 'staffDirectOrder')
  return { db, ctx, cloud, sent, order, pay, assign, deliveries }
}

test('only paid designated bookings notify the requested staff with exact 8560 fields', async () => {
  const { pay, sent, ctx, db, deliveries } = fixture()
  assert.equal(deliveries().length, 0)
  await pay()
  assert.deepEqual(sent, [{ touser: 'staff', templateId: 'direct-8560', page: 'pages/staff/orders/detail/index?id=order', data: {
    character_string2: { value: 'O202610110002' }, thing5: { value: '您有新的指定预约，请及时查看并确认' },
    thing9: { value: '上门遛狗' }, time10: { value: '2099-10-11 10:00' }, amount3: { value: '89.90' }
  } }])
  await ctx.settleOrderPayment('order', { paymentNo: db.state.orders[0].paymentNo })
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(deliveries().length, 1)
  assert.equal(db.state.subscription_logs.some(row => row.templateKey === 'orderAccepted'), false, 'payment is not staff acceptance')
})

test('direct payment never consumes client acceptance quota; actual staff acceptance sends it once', async () => {
  const { db, ctx, cloud, order, assign, sent } = fixture()
  db.state.platform_configs[0].value.customerService = { phone: '4008001234' }
  db.state.platform_configs[0].value.subscription.templates.orderAccepted = 'accepted'
  const payment = await ctx.reserveOrderPayment(order(), 'client', 'wechat', 'pay1')
  await ctx.markOrderPaid('order', { paymentNo: payment.paymentNo, wxTransactionId: 'wx1' })
  assert.equal(sent.filter(row => row.templateId === 'accepted').length, 0)
  const assigned = await assign('staff', false)
  await ctx.notifyOrderAccepted(assigned)
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.filter(row => row.templateId === 'accepted').length, 1)
  assert.equal(sent.find(row => row.templateId === 'accepted').touser, 'client')
})

test('system automatic acceptance persists the client acceptance notification in the same transaction', async () => {
  const { db, ctx, pay, sent } = fixture({ concurrent: false })
  db.state.platform_configs[0].value.customerService = { phone: '4008001234' }
  db.state.platform_configs[0].value.subscription.templates.orderAccepted = 'accepted'
  await pay()
  db.state.orders[0].paidAt = new Date(Date.now() - 3605000)
  assert.deepEqual(await ctx.autoAcceptDueDirectOrders(), ['order'])
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.filter(row => row.templateId === 'accepted').length, 1)
  assert.equal(db.state.subscription_logs.filter(row => row.delivery && row.templateKey === 'orderAccepted').length, 1)
})

test('concurrent payment settlement produces one designated booking notification', async () => {
  const { ctx, order, sent, deliveries } = fixture()
  const payment = await ctx.reserveOrderPayment(order(), 'client', 'wechat', 'pay1')
  await Promise.all([1, 2].map(() => ctx.settleOrderPayment('order', { paymentNo: payment.paymentNo, wxTransactionId: 'wx1' })))
  assert.equal(sent.length, 1)
  assert.equal(deliveries().length, 1)
})

test('open-order payment and staff self-acceptance do not generate new designated booking alerts', async () => {
  const { pay, sent, assign, deliveries } = fixture({ publishMode: 'open' })
  await pay()
  await assign('staff', false)
  assert.equal(sent.length, 0)
  assert.equal(deliveries().length, 0)
})

test('admin assignment and subsequent reassignment notify the correct staff once per assignment', async () => {
  const { db, pay, assign, sent, deliveries, ctx, order } = fixture({ publishMode: 'open' })
  await pay()
  await assign()
  await ctx.notifyStaffDirectOrder(order(), 'assignment')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].touser, 'staff')
  assert.equal(sent[0].page, 'pages/staff/orders/service/index?id=order')
  assert.equal(sent[0].data.thing5.value, '您有新的服务安排，请查看并按时赴约')
  // The controlled re-publish flow clears the assignee and keeps its history.
  Object.assign(db.state.orders[0], { status: 'paid', staffOpenid: '', previousStaffRecords: [{ staffOpenid: 'staff' }] })
  await assign('staff2')
  assert.equal(sent[1].touser, 'staff2')
  assert.equal(sent[1].data.thing5.value, '您收到一笔改派订单，请查看并按时赴约')
  Object.assign(db.state.orders[0], { status: 'paid', staffOpenid: '' })
  await assign('staff')
  assert.equal(sent[2].touser, 'staff')
  assert.equal(deliveries().length, 3)
})

test('failed assignment rolls back the notification and never alerts staff', async () => {
  const { db, pay, assign, sent, deliveries } = fixture({ publishMode: 'open' })
  await pay()
  db.state.staff_profiles[0].auditStatus = 'rejected'
  await assert.rejects(assign())
  assert.equal(db.state.orders[0].status, 'paid')
  assert.equal(sent.length, 0)
  assert.equal(deliveries().length, 0)
})

for (const kind of ['request', 'assignment']) {
  test(`failed ${kind} delivery retries with original fields and recipient`, async () => {
    const { cloud, pay, assign, ctx, sent, deliveries, db } = fixture({ publishMode: kind === 'request' ? 'direct' : 'open' })
    const send = cloud.openapi.subscribeMessage.send
    cloud.openapi.subscribeMessage.send = async () => { throw new Error('network error') }
    await pay()
    if (kind === 'assignment') await assign()
    assert.equal(deliveries()[0].status, 'queued')
    deliveries()[0].nextAttemptAt = new Date(0)
    db.state.orders[0].payAmount = 100
    cloud.openapi.subscribeMessage.send = send
    await ctx.retryFailedSubscriptions()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].touser, 'staff')
    assert.equal(sent[0].data.amount3.value, '89.90')
    await ctx.retryFailedSubscriptions()
    assert.equal(sent.length, 1)
  })
}

for (const change of [order => { order.status = 'cancelled' }, order => { order.requestedStaffOpenid = 'staff2' },
  order => { order.status = 'completed' }, order => { order.staffOpenid = 'staff'; order.status = 'assigned' }]) {
  test('obsolete requested booking is skipped on delayed delivery: ' + change.toString(), async () => {
    const { cloud, pay, db, ctx, sent, deliveries } = fixture()
    const send = cloud.openapi.subscribeMessage.send
    cloud.openapi.subscribeMessage.send = async () => { throw new Error('network error') }
    await pay()
    change(db.state.orders[0])
    deliveries()[0].nextAttemptAt = new Date(0)
    cloud.openapi.subscribeMessage.send = send
    await ctx.retryFailedSubscriptions()
    assert.equal(sent.length, 0)
    assert.equal(deliveries()[0].error, 'staff_assignment_obsolete')
  })
}

test('a delayed previous assignment cannot notify after the same staff is reassigned', async () => {
  const { cloud, pay, db, ctx, sent, assign, deliveries } = fixture({ publishMode: 'open' })
  const send = cloud.openapi.subscribeMessage.send
  cloud.openapi.subscribeMessage.send = async () => { throw new Error('network error') }
  await pay()
  await assign()
  Object.assign(db.state.orders[0], { status: 'paid', staffOpenid: '' })
  cloud.openapi.subscribeMessage.send = send
  await assign()
  deliveries()[0].nextAttemptAt = new Date(0)
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(deliveries()[0].error, 'staff_assignment_obsolete')
})

test('unconfigured or rejected designated template does not fail payment; admin sees reason', async () => {
  const missing = fixture({ template: '' })
  await missing.pay()
  assert.equal(missing.db.state.orders[0].paymentStatus, 'paid')
  assert.equal(missing.deliveries()[0].error, 'template_not_configured')
  missing.db.state.platform_configs[0].value.subscription.templates.staffDirectOrder = 'configured-later'
  await missing.ctx.requeueSubscriptionDelivery(missing.deliveries()[0]._id, 'admin')
  await missing.ctx.retryFailedSubscriptions()
  assert.equal(missing.sent[0].templateId, 'configured-later')
  const rejected = fixture()
  rejected.cloud.openapi.subscribeMessage.send = async () => { throw { errCode: 43101, errMsg: 'no consent' } }
  await rejected.pay()
  assert.equal(rejected.db.state.orders[0].paymentStatus, 'paid')
  const result = await rejected.ctx.listSubscriptionDeliveries({ status: 'queued' })
  const notice = result.list.find(row => row.templateKey === 'staffDirectOrder')
  assert.equal(notice.templateName, '宠托师指定单通知')
  assert.match(notice.reasonText, /用户未同意/)
})

test('admin save and public configuration preserve independent refund and staff template IDs', async () => {
  const { db } = fixture()
  const api = loadCloudFunction('api', db, 'admin')
  const saved = await api.main({ module: 'admin', action: 'saveSystemSettings', data: {
    subscription: { enabled: true, templates: { staffDirectOrder: '  custom-8560  ', refundResult: '  custom-7272  ', orderAssigned: 'existing-client' } }
  } })
  assert.equal(saved.ok, true, saved.message)
  const settings = await api.main({ module: 'system', action: 'getSettings', data: {} })
  assert.equal(settings.data.subscription.templates.staffDirectOrder, 'custom-8560')
  assert.equal(settings.data.subscription.templates.refundResult, 'custom-7272')
  assert.equal(settings.data.subscription.templates.orderAssigned, 'existing-client')
})

test('all adapted template IDs survive admin save and public configuration', async () => {
  const { db } = fixture()
  const api = loadCloudFunction('api', db, 'admin')
  const keys = ['orderAccepted', 'staffDeparture', 'serviceStart', 'serviceFinish', 'upcomingServiceReminder', 'remoteUnlock', 'refundResult', 'staffDirectOrder']
  const templates = Object.fromEntries(keys.map(key => [key, '  ' + key + '-new-id  ']))
  const saved = await api.main({ module: 'admin', action: 'saveSystemSettings', data: { subscription: { enabled: true, templates } } })
  assert.equal(saved.ok, true, saved.message)
  const settings = await api.main({ module: 'system', action: 'getSettings', data: {} })
  for (const key of keys) assert.equal(settings.data.subscription.templates[key], key + '-new-id')
})

test('legacy premature acceptance delivery is skipped and kept as history', async () => {
  const { db, ctx, order, sent } = fixture()
  await db.runTransaction(tx => ctx.enqueueOrderNotification(tx, 'client', 'orderAccepted', order(), {}, 'client', 'order_accepted:order'))
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 0)
  const row = db.state.subscription_logs.find(row => row.delivery)
  assert.equal(row.status, 'skipped')
  assert.equal(row.error, 'legacy_order_not_accepted')
})

for (const status of ['on_the_way', 'in_service', 'completed', 'cancelled']) {
  test('delayed upcoming reminder does not ask staff to go to an order already ' + status, async () => {
    const { db, ctx, order, sent } = fixture()
    await db.runTransaction(tx => ctx.enqueueOrderNotification(tx, 'staff', 'upcomingServiceReminder', order(), {}, 'staff', 'upcoming_service:order:staff:1'))
    Object.assign(db.state.orders[0], { staffOpenid: 'staff', status })
    await ctx.retryFailedSubscriptions()
    assert.equal(sent.length, 0)
    const row = db.state.subscription_logs.find(row => row.delivery)
    assert.equal(row.status, 'skipped')
    assert.equal(row.error, 'service_reminder_obsolete')
  })
}

test('multi-day completed sessions never replay an old reminder while another session is pending', async () => {
  const { db, ctx, order, sent } = fixture()
  db.state.platform_configs[0].value.subscription.templates.upcomingServiceReminder = 'upcoming'
  Object.assign(db.state.orders[0], { status: 'day_completed', staffOpenid: 'staff', serviceSessions: [
    { index: 1, startTime: '2099-10-11 10:00', endTime: '2099-10-11 11:00', status: 'completed' },
    { index: 2, startTime: '2099-10-12 10:00', endTime: '2099-10-12 11:00', status: 'pending' }
  ] })
  await db.runTransaction(tx => ctx.enqueueOrderNotification(tx, 'staff', 'upcomingServiceReminder', order(), {}, 'staff', 'upcoming_service:order:staff:1:2099-10-11 10:00'))
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 0)
  assert.equal(db.state.subscription_logs.find(row => row.delivery).error, 'service_reminder_obsolete')
  await db.runTransaction(tx => ctx.enqueueOrderNotification(tx, 'staff', 'upcomingServiceReminder', order(), {
    startTimeText: '2099-10-12 10:00', endTimeText: '2099-10-12 11:00'
  }, 'staff', 'upcoming_service:order:staff:2:2099-10-12 10:00'))
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].templateId, 'upcoming')
})
