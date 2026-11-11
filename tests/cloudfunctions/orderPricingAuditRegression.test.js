const assert = require('node:assert/strict')
const root = require('node:path').resolve(__dirname, '../..')
const test = require('node:test')
const optimistic = require('./optimisticTransactions')
const { createCollectionStore } = require(root + '/tests/cloudfunctions/helpers')
const createContext = require(root + '/cloudfunctions/api/services/context')
const createOrderHandler = require(root + '/cloudfunctions/api/handlers/order')
const ts = Date.now()
const iso = hours => new Date(ts + hours * 3600000).toISOString()
const users = [
  { _id: 'client', openid: 'client', roles: ['client'], activeRole: 'client', status: 'active', phone: '13900000000' },
  { _id: 'staff', openid: 'staff', roles: ['staff'], activeRole: 'staff', status: 'active', phone: '13800000000' }
]
function fixture(extra = {}) {
  const db = createCollectionStore({ users, staff_profiles: [{ _id: 'profile', openid: 'staff', auditStatus: 'approved' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { settlement: { staffCommissionRate: .7, settlementDelayDays: 0 } } }], ...extra })
  const c = createContext({ db, cloud: {} })
  return { db, c }
}
function multi(completed = 1) {
  const hour = index => index === 1 ? -48 : index === 2 ? (completed === 2 ? -24 : 10) : (completed === 2 ? 10 : 34)
  return { _id: 'order', orderNo: 'AUDIT', clientOpenid: 'client', clientUserId: 'client', staffOpenid: 'staff', staffUserId: 'staff', staffProfileId: 'profile',
    status: 'day_completed', paymentStatus: 'paid', paymentNo: 'PAY_AUDIT', paymentChannel: 'wechat', payAmount: 300, amount: 300, sessionCount: 3,
    startTime: iso(-48), endTime: iso(11),
    serviceSessions: [1, 2, 3].map((index) => ({ index, status: index <= completed ? 'completed' : 'pending', date: iso(hour(index)).slice(0,10), startTime: iso(hour(index)), endTime: iso(hour(index) + 1) })) }
}
function gateway(db, c, status) {
  return require(root + '/cloudfunctions/api/services/refunds')({ ...c,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    assertPaymentModeAllowed: () => {}, getWechatPayConfig: () => ({}), sanitizeWechatPayload: value => value,
    wechatPayRequest: async () => {
      const currentStatus = status()
      const refund = db.state.refunds.find(row => row.status === 'processing')
      return { status: currentStatus, out_refund_no: refund.refundNo,
        amount: { refund: Math.round(refund.refundAmount * 100), total: Math.round(refund.amount * 100) } }
    }, notifyOrder: async () => {}, enqueueOrderNotification: async () => {}
  })
}
test('departure preserves completed-day refund exclusion', async () => {
    const { db, c } = fixture({ orders: [multi(2)] })
    const refundService = gateway(db, c, () => 'SUCCESS')
    const handler = createOrderHandler({ ...c, createRefundForOrder: refundService.requestOrderRefund })
    const before = await handler('client', 'getCancelQuote', { orderId: 'order' })
    await handler('staff', 'departForService', { orderId: 'order' })
    const after = await handler('client', 'getCancelQuote', { orderId: 'order' })
    assert.equal(before.refundAmount, 80)
    assert.equal(after.refundAmount, 80)
    await handler('client', 'cancelOrder', { orderId: 'order' })
    assert.equal(db.state.refunds[0].refundAmount, 80)
    assert.equal(db.state.staff_earnings[0].amount, 154)
    assert.deepEqual(db.state.orders[0].serviceSessions.map(session => session.status), ['completed', 'completed', 'cancelled'])
})

test('async refund reserves gross earnings and deducts only once', async () => {
    const { db, c } = fixture({ orders: [multi()] })
    optimistic(db)
    let gatewayStatus = 'PROCESSING'
    const refundService = require(root + '/cloudfunctions/api/services/refunds')({ ...c,
      getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }), assertPaymentModeAllowed: () => {},
      getWechatPayConfig: () => ({}), sanitizeWechatPayload: x => x,
      wechatPayRequest: async (method, path, body) => {
        const refund = db.state.refunds[0]
        return { status: gatewayStatus, out_refund_no: refund.refundNo, amount: { refund: Math.round(refund.refundAmount * 100), total: Math.round(refund.amount * 100) } }
      }, notifyOrder: async () => {}, enqueueOrderNotification: async () => {} })
    const handler = createOrderHandler({ ...c, createRefundForOrder: refundService.requestOrderRefund })
    await handler('client', 'cancelOrder', { orderId: 'order', clientRequestId: 'audit-async-cancel' })
    const before = db.state.staff_earnings[0].amount
    assert.equal(before, 210)
    assert.equal(db.state.staff_earnings[0].pendingRefundIds.length, 2)
    gatewayStatus = 'SUCCESS'
    await refundService.syncOrderRefund(db.state.refunds[0])
    const after = db.state.staff_earnings[0].amount
    assert.equal(after, 84)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
    await refundService.syncOrderRefund(db.state.refunds[0])
    assert.equal(db.state.staff_earnings[0].amount, 84)
})

test('date-specific surcharge stays on its original service day', async () => {
    const { c } = fixture()
    const order = { ...multi(), payAmount: 340, amount: 340, priceSnapshot: { unitServices: [{ key:'visit_fee',price:30 },{key:'feed',price:70}],
      services: [{key:'visit_fee',price:90},{key:'feed',price:210},{key:'date_surcharge_holiday',price:40,type:'date_surcharge',dates:[multi().serviceSessions[0].date]}] } }
    const quote = c.getCancelQuoteForOrder(order)
    assert.equal(quote.refundAmount, 180)
})

test('finished household cannot depart or block group settlement', async () => {
    const a = { ...multi(), _id: 'a', groupBuyId: 'group', groupBuyStatus: 'formed', sessionCount:1, serviceSessions:[{index:1,status:'completed',date:iso(0).slice(0,10),startTime:iso(-1),endTime:iso(0)}], lastCompletedSessionIndex:1 }
    const b = { ...a, _id:'b', clientOpenid:'neighbor', status:'in_service', activeSessionIndex:1, serviceSessions:[{...a.serviceSessions[0],status:'in_service'}] }
    const { db, c } = fixture({ orders:[a,b], pet_playground_groups:[{_id:'group',status:'formed',formedAt:ts-3600000}] })
    const handler = createOrderHandler(c)
    await assert.rejects(handler('staff','departForService',{orderId:'a'}), /不可再次出发/)
    assert.equal(db.state.orders[0].status,'day_completed')
    const completion = require(root + '/cloudfunctions/api/services/groupCompletion')({ ...c,
      evaluateCheckinCompletion:async()=>({isComplete:true}), completeSingleOrderService:async(o)=>{ await db.collection('orders').doc(o._id).update({data:{status:'completed'}}); return {status:'completed'} } })
    const result = await completion.finishGroup(structuredClone(db.state.orders[1]), db.state.orders[1].serviceSessions[0])
    assert.equal(result.status, 'completed')
    assert.ok(db.state.orders.every(o => o.status === 'completed'))
})

test('long multi-day orders remain in overdue scan', async () => {
    const current = new Date('2099-09-11T02:40:00Z')
    const sessions=Array.from({length:11},(_,i)=>({ index:i+1,date:`2099-09-${String(i+1).padStart(2,'0')}`,startTime:`2099-09-${String(i+1).padStart(2,'0')} 10:00`,endTime:`2099-09-${String(i+1).padStart(2,'0')} 11:00`,status:i<10?'completed':'pending' }))
    const o={...multi(),startTime:sessions[0].startTime,endTime:sessions.at(-1).endTime,serviceSessions:sessions,sessionCount:11}
    const {db,c}=fixture({orders:[o]})
    const svc=require(root+'/cloudfunctions/api/services/overdueOrders')({...c,now:()=>current,notifyOrder:async()=>{},notifyAdmins:async()=>{}})
    const processed=await svc.processOverdueUnstartedOrders(current)
    assert.equal(processed.length,1)
})

test('partial cancellation with a zero-cent remaining refund still settles and cancels visits', async () => {
  const order = { ...multi(), amount: 0.03, payAmount: 0.01 }
  const { db, c } = fixture({ orders: [order] })
  optimistic(db)
  const handler = createOrderHandler(c)
  const result = await handler('client', 'cancelOrder', { orderId: 'order' })
  assert.equal(result.refundAmount, 0)
  assert.equal((db.state.refunds || []).length, 0)
  assert.deepEqual(db.state.orders[0].serviceSessions.map(session => session.status), ['completed', 'cancelled', 'cancelled'])
  assert.equal(db.state.staff_earnings[0].amount, 0.01)
})

for (const variant of ['rounded_balance', 'prior_compensation', 'free_order']) {
  test(`zero-cent partial cancellation retains the coupon used by completed visits (${variant})`, async () => {
    const order = { ...multi(2), amount: 0.03, payAmount: variant === 'free_order' ? 0 : variant === 'prior_compensation' ? 0.02 : 0.01,
      couponId: 'coupon', discountAmount: variant === 'free_order' ? 0.03 : variant === 'prior_compensation' ? 0.01 : 0.02 }
    const { db, c } = fixture({ orders: [order], user_coupons: [{ _id: 'coupon', openid: 'client', status: 'used', usedOrderId: 'order', validTo: '2099-12-31 23:59:59' }] })
    optimistic(db)
    const refunds = gateway(db, c, () => 'SUCCESS')
    if (variant === 'prior_compensation') await refunds.requestOrderRefund(structuredClone(order), 0.01, '此前补偿', 'admin_manual', 'admin', 'compensation')
    const handler = createOrderHandler({ ...c, createRefundForOrder: refunds.requestOrderRefund })
    const result = await handler('client', 'cancelOrder', { orderId: 'order' })
    assert.equal(result.refundAmount, 0)
    assert.equal(db.state.user_coupons[0].status, 'used')
    assert.equal(db.state.user_coupons[0].usedOrderId, 'order')
    assert.deepEqual(db.state.orders[0].serviceSessions.map(session => session.status), ['completed', 'completed', 'cancelled'])
    assert.equal((db.state.refunds || []).length, variant === 'prior_compensation' ? 1 : 0)
    await handler('client', 'cancelOrder', { orderId: 'order' })
    assert.equal(db.state.user_coupons[0].status, 'used')
  })
}

test('free unserved cancellation and coupon restoration commit atomically and recover after a write failure', async () => {
  const order = { ...multi(0), status: 'assigned', serviceSessions: [], startTime: iso(48), amount: 100, payAmount: 0, couponId: 'coupon' }
  const { db, c } = fixture({ orders: [order], user_coupons: [{ _id: 'coupon', openid: 'client', status: 'used', usedOrderId: 'order', validTo: '2099-12-31 23:59:59' }] })
  optimistic(db)
  let fail = true
  const handler = createOrderHandler({ ...c, restoreOrderCoupon: async (couponId, orderId, transaction) => {
    assert.ok(transaction, 'coupon restoration must share the cancellation transaction')
    await c.restoreOrderCoupon(couponId, orderId, transaction)
    if (fail) throw new Error('coupon write failed')
  } })
  await assert.rejects(handler('client', 'cancelOrder', { orderId: 'order' }), /coupon write failed/)
  assert.equal(db.state.orders[0].status, 'assigned')
  assert.equal(db.state.user_coupons[0].status, 'used')
  assert.equal((db.state.order_timeline || []).length, 0)
  fail = false
  await handler('client', 'cancelOrder', { orderId: 'order' })
  assert.equal(db.state.orders[0].status, 'cancelled')
  assert.equal(db.state.user_coupons[0].status, 'available')
  assert.equal((db.state.refunds || []).length, 0)
  await handler('client', 'cancelOrder', { orderId: 'order' })
  assert.equal(db.state.user_coupons[0].status, 'available')
})

test('service completion racing cancellation aborts the stale refund and rolls back settlement', async () => {
  const { db, c } = fixture({ orders: [multi()] })
  const handler = createOrderHandler({ ...c, createRefundForOrder: async (...args) => {
    db.state.orders[0].serviceSessions[1].status = 'completed'
    return c.createRefundForOrder(...args)
  } })
  await assert.rejects(handler('client', 'cancelOrder', { orderId: 'order' }), /服务场次或退款金额已变化/)
  assert.equal(db.state.orders[0].status, 'day_completed')
  assert.equal((db.state.refunds || []).length, 0)
  assert.equal((db.state.staff_earnings || []).length, 0)
})

test('an existing refund in progress cannot be replaced by cancellation without a refund reservation', async () => {
  const { db, c } = fixture({ orders: [{ ...multi(), paymentStatus: 'refunding', refundAmount: 20 }] })
  await assert.rejects(createOrderHandler(c)('client', 'cancelOrder', { orderId: 'order' }), /订单支付或退款状态已变化/)
  assert.equal(db.state.orders[0].status, 'day_completed')
  assert.equal(db.state.orders[0].refundAmount, 20)
  assert.equal((db.state.staff_earnings || []).length, 0)
})

for (const withExistingEarning of [false, true]) {
  test(`failed cancellation refund keeps settlement held until replacement succeeds (existing ledger: ${withExistingEarning})`, async () => {
    const { db, c } = fixture({ orders: [multi()] })
    optimistic(db)
    if (withExistingEarning) await c.ensureStaffEarning(db.state.orders[0])
    let status = 'CLOSED'
    const refundService = gateway(db, c, () => status)
    const handler = createOrderHandler({ ...c, createRefundForOrder: refundService.requestOrderRefund })
    await handler('client', 'cancelOrder', { orderId: 'order', clientRequestId: 'first' })
    assert.equal(db.state.refunds[0].status, 'failed')
    assert.equal(db.state.orders[0].status, 'cancelled')
    assert.equal(db.state.staff_earnings[0].amount, 210)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, ['cancelled_service_order'])
    assert.deepEqual(db.state.orders[0].pendingEarningRefundIds, ['cancelled_service_order'])
    status = 'SUCCESS'
    await refundService.requestOrderRefund(structuredClone(db.state.orders[0]), 180, '重新退款', 'admin_manual', 'admin', 'replacement')
    assert.equal(db.state.staff_earnings[0].amount, 84)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
    assert.deepEqual(db.state.orders[0].pendingEarningRefundIds, [])
    assert.equal(db.state.staff_earnings.length, 1)
  })
}

test('linked departure skips households whose visits are already complete', async () => {
  const a = { ...multi(3), _id: 'a', groupBuyId: 'group' }
  const b = { ...multi(2), _id: 'b', groupBuyId: 'group' }
  const { db, c } = fixture({ orders: [a, b] })
  await createOrderHandler(c)('staff', 'departForService', { orderId: 'b' })
  assert.equal(db.state.orders[0].status, 'day_completed')
  assert.equal(db.state.orders[1].status, 'on_the_way')
})

for (const withExistingEarning of [false, true]) {
  test(`prior compensation cannot release a failed cancellation hold early (existing ledger: ${withExistingEarning})`, async () => {
    const { db, c } = fixture({ orders: [multi()] })
    optimistic(db)
    if (withExistingEarning) await c.ensureStaffEarning(db.state.orders[0])
    let status = 'SUCCESS'
    const refunds = gateway(db, c, () => status)
    await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 100, '此前补偿', 'admin_manual', 'admin', 'compensation')
    status = 'CLOSED'
    const handler = createOrderHandler({ ...c, createRefundForOrder: refunds.requestOrderRefund })
    await handler('client', 'cancelOrder', { orderId: 'order', clientRequestId: 'cancel-after-compensation' })
    assert.equal(db.state.staff_earnings[0].amount, 140)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, ['cancelled_service_order'])
    status = 'SUCCESS'
    await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 80, '取消退款第一笔', 'admin_manual', 'admin', 'replacement-part-one')
    assert.equal(db.state.staff_earnings[0].amount, 84)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, ['cancelled_service_order'])
    assert.deepEqual(db.state.orders[0].pendingEarningRefundIds, ['cancelled_service_order'])
    await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 100, '取消退款第二笔', 'admin_manual', 'admin', 'replacement-part-two')
    assert.equal(db.state.staff_earnings[0].amount, 14)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
    assert.deepEqual(db.state.orders[0].pendingEarningRefundIds, [])
  })
}

for (const variant of ['paid', 'expired', 'assigned', 'direct', 'multi']) {
  test(`cancellation quote is capped by the unrefunded payment balance (${variant})`, async () => {
    const order = { ...multi(), ...(variant === 'multi' ? {} : { status: variant === 'direct' ? 'assigned' : variant, serviceSessions: [] }),
      ...(variant === 'direct' ? { publishMode: 'direct', assignedAt: iso(-1) } : {}) }
    const { db, c } = fixture({ orders: [order] })
    optimistic(db)
    const refunds = gateway(db, c, () => 'SUCCESS')
    await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 200, '此前补偿', 'admin_manual', 'admin', 'compensation')
    const handler = createOrderHandler({ ...c, createRefundForOrder: refunds.requestOrderRefund })
    const quote = await handler('client', 'getCancelQuote', { orderId: 'order' })
    assert.equal(quote.refundAmount, 100)
    const result = await handler('client', 'cancelOrder', { orderId: 'order', clientRequestId: 'cancel-after-compensation' })
    assert.equal(result.refundAmount, 100)
    assert.equal(db.state.orders[0].refundedAmount, 300)
    assert.equal(db.state.refunds.length, 2)
    if (variant === 'multi') assert.equal(db.state.staff_earnings[0].amount, 0)
  })
}

test('prior compensation below the remaining balance does not reduce the service cancellation entitlement twice', async () => {
  const { db, c } = fixture({ orders: [multi()] })
  optimistic(db)
  const refunds = gateway(db, c, () => 'SUCCESS')
  await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 50, '此前补偿', 'admin_manual', 'admin', 'compensation')
  const handler = createOrderHandler({ ...c, createRefundForOrder: refunds.requestOrderRefund })
  assert.equal((await handler('client', 'getCancelQuote', { orderId: 'order' })).refundAmount, 180)
  await handler('client', 'cancelOrder', { orderId: 'order', clientRequestId: 'cancel' })
  assert.equal(db.state.orders[0].refundedAmount, 230)
  assert.equal(db.state.staff_earnings[0].amount, 49)
  assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
})

for (const status of ['SUCCESS', 'PROCESSING']) {
  test(`zero-cent cancellation preserves existing refund accounting (${status})`, async () => {
    const { db, c } = fixture({ orders: [{ ...multi(2), payAmount: 0.02, amount: 0.03 }] })
    optimistic(db)
    const refunds = gateway(db, c, () => status)
    await refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 0.01, '此前补偿', 'admin_manual', 'admin', 'compensation')
    const handler = createOrderHandler({ ...c, createRefundForOrder: refunds.requestOrderRefund })
    assert.equal((await handler('client', 'getCancelQuote', { orderId: 'order' })).refundAmount, 0)
    if (status === 'PROCESSING') {
      await assert.rejects(handler('client', 'cancelOrder', { orderId: 'order' }), /订单支付或退款状态已变化/)
      assert.equal(db.state.orders[0].status, 'day_completed')
      assert.equal((db.state.staff_earnings || []).length, 0)
    } else {
      const result = await handler('client', 'cancelOrder', { orderId: 'order' })
      assert.equal(result.refundAmount, 0)
      assert.equal(result.refundStatus, 'partially_refunded')
      assert.equal(db.state.orders[0].status, 'cancelled')
      assert.equal(db.state.orders[0].refundedAmount, 0.01)
    }
    assert.equal(db.state.orders[0].refundAmount, 0.01)
    assert.equal(db.state.orders[0].refundStatus, status === 'SUCCESS' ? 'partially_refunded' : 'processing')
    assert.equal(db.state.refunds.length, 1)
  })
}

test('a refund reserved during zero-cent cancellation aborts cancellation atomically', async () => {
  const { db, c } = fixture({ orders: [{ ...multi(2), payAmount: 0.02, amount: 0.03 }] })
  optimistic(db)
  const transaction = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0] = { ...db.state.orders[0], paymentStatus: 'refunding', refundStatus: 'processing', refundAmount: 0.01 }
    return transaction(callback)
  }
  await assert.rejects(createOrderHandler(c)('client', 'cancelOrder', { orderId: 'order' }), /订单支付或退款状态已变化/)
  assert.equal(db.state.orders[0].status, 'day_completed')
  assert.equal(db.state.orders[0].refundAmount, 0.01)
  assert.equal((db.state.staff_earnings || []).length, 0)
})

test('cancelled sessions are excluded from pending-session selection and overdue alerts', async () => {
  const current = new Date('2099-09-11T02:40:00Z')
  const order = { ...multi(3), endTime: '2099-09-11 11:00', serviceSessions: [
    { index: 1, date: '2099-09-10', startTime: '2099-09-10 10:00', endTime: '2099-09-10 11:00', status: 'completed' },
    { index: 2, date: '2099-09-11', startTime: '2099-09-11 10:00', endTime: '2099-09-11 11:00', status: 'cancelled' }
  ] }
  const { c } = fixture({ orders: [order] })
  assert.equal(c.getTodayServiceSession(order, current), null)
  assert.equal(c.getNextPendingServiceSession(order, current), null)
  assert.deepEqual(await c.processOverdueUnstartedOrders(current), [])
})

test('refund timeout preserves settlement and recovery is idempotent', async () => {
    const { db, c } = fixture({ orders: [multi()] })
    optimistic(db)
    let failGateway = true
    const refundService = require(root + '/cloudfunctions/api/services/refunds')({ ...c,
      getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }), assertPaymentModeAllowed: () => {},
      getWechatPayConfig: () => ({}), sanitizeWechatPayload: x => x,
      wechatPayRequest: async () => {
        if (failGateway) throw new Error('audit simulated network timeout')
        const refund = db.state.refunds[0]
        return { status: 'SUCCESS', out_refund_no: refund.refundNo, amount: { refund: 18000, total: 30000 } }
      }, notifyOrder: async () => {}, enqueueOrderNotification: async () => {} })
    const handler = createOrderHandler({ ...c, createRefundForOrder: refundService.requestOrderRefund })
    await assert.rejects(handler('client', 'cancelOrder', { orderId:'order', clientRequestId:'audit-network' }), /network timeout/)
    assert.equal(db.state.orders[0].status,'cancelled')
    assert.deepEqual(db.state.orders[0].serviceSessions.map(s => s.status), ['completed', 'cancelled', 'cancelled'])
    assert.equal(db.state.staff_earnings[0].pendingRefundIds.length, 2)
    failGateway = false
    await refundService.syncOrderRefund(db.state.refunds[0])
    await handler('client', 'cancelOrder', { orderId:'order', clientRequestId:'audit-network' })
    assert.equal(db.state.staff_earnings.length,1)
    assert.equal(db.state.staff_earnings[0].amount,84)
    assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
})
