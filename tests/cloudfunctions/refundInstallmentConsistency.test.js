const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function fixture(earningCents, status = 'available', payCents = 5) {
  const db = createCollectionStore({orders:[{_id:'order',clientOpenid:'client',staffOpenid:'staff',status:'completed',
    paymentStatus:'paid',paymentChannel:'wechat',paymentNo:'PAY',payAmount:payCents/100}],
    staff_earnings:[{_id:'earning',orderId:'order',staffOpenid:'staff',status,amount:earningCents/100,originalAmount:earningCents/100}]})
  optimistic(db)
  const context = createContext({db,cloud:{}})
  const statuses = new Map()
  const service = require('../../cloudfunctions/api/services/refunds')({...context,
    getSystemSettings:async()=>({payment:{mode:'wechat',refundEnabled:true}}),
    assertPaymentModeAllowed:()=>{},getWechatPayConfig:()=>({}),sanitizeWechatPayload:value=>value,
    enqueueOrderNotification:async()=>{},notifyOrder:async()=>{},
    wechatPayRequest:async(method,path,body)=>{
      const row = method === 'GET' ? db.state.refunds.find(row=>row.refundNo === decodeURIComponent(path.split('/').pop())) : null
      return {status:statuses.get(row ? row.clientRequestId : db.state.refunds.find(row=>row.refundNo===body.out_refund_no).clientRequestId) || 'SUCCESS',
        out_refund_no:row ? row.refundNo : body.out_refund_no,
        amount:row ? {refund:Math.round(row.refundAmount*100),total:payCents} : body.amount}
    }
  })
  return {db,context,service,statuses,request:(cents,id)=>service.requestOrderRefund(structuredClone(db.state.orders[0]),cents/100,'分笔协商退款','admin_manual','admin',id)}
}

for (const earningCents of [2,3]) {
  test(`split refunds preserve cumulative rounding for ${earningCents} cents of earnings on a five-cent order`,async()=>{
    const f=fixture(earningCents)
    for(let index=1;index<=5;index+=1) {
      await f.request(1,`refund-${index}`)
      assert.equal(f.db.state.orders[0].refundedAmount,index/100)
      assert.equal(f.db.state.staff_earnings[0].amount,(earningCents-Math.round(earningCents*index/5))/100)
    }
    assert.equal(f.db.state.staff_earnings[0].status,'refunded_void')
    assert.equal(f.db.state.staff_earnings[0].deductedAmount,earningCents/100)
    assert.equal(f.db.state.orders[0].paymentStatus,'refunded')
  })
}

for (const earningCents of [2,3]) {
  test(`split refunds preserve cumulative withdrawn debt for ${earningCents} cents of earnings`,async()=>{
    const f=fixture(earningCents,'withdrawn')
    for(let index=1;index<=5;index+=1) {
      await f.request(1,`debt-${index}`)
      const debt=Math.round(earningCents*index/5)/100
      assert.equal(f.db.state.staff_earnings[0].amount,earningCents/100)
      assert.equal(f.db.state.staff_earnings[0].overpaidDebtAmount,debt)
      assert.equal(f.db.state.staff_earnings[0].hasOverpaidDebt,debt>0)
    }
  })
}

test('concurrent partial refunds settle their cumulative earnings deduction only once',async()=>{
  const f=fixture(7,'available',11)
  await Promise.all([f.request(1,'parallel-a'),f.request(2,'parallel-b'),f.request(3,'parallel-c')])
  assert.equal(f.db.state.orders[0].refundedAmount,.06)
  assert.equal(f.db.state.staff_earnings[0].amount,.03)
  await Promise.all(f.db.state.refunds.map(refund=>f.service.syncOrderRefund(refund)))
  assert.equal(f.db.state.staff_earnings[0].amount,.03)
})

test('out-of-order refund results exclude failed and pending installments from cumulative earnings',async()=>{
  const f=fixture(4,'available',7)
  f.statuses.set('pending-a','PROCESSING')
  f.statuses.set('pending-b','PROCESSING')
  const a=await f.request(1,'pending-a'),b=await f.request(2,'pending-b')
  await f.request(2,'success-c')
  assert.equal(f.db.state.staff_earnings[0].amount,.03)
  assert.equal(f.db.state.staff_earnings[0].pendingRefundIds.length,2)
  f.statuses.set('pending-b','CLOSED')
  await f.service.syncOrderRefund(b)
  assert.equal(f.db.state.staff_earnings[0].amount,.03)
  f.statuses.set('pending-a','SUCCESS')
  await f.service.syncOrderRefund(a)
  assert.equal(f.db.state.orders[0].refundedAmount,.03)
  assert.equal(f.db.state.staff_earnings[0].amount,.02)
  assert.deepEqual(f.db.state.staff_earnings[0].pendingRefundIds,[])
})

test('earnings created between refund installments do not deduct the first installment twice',async()=>{
  const f=fixture(3)
  f.db.state.staff_earnings=[]
  await f.request(1,'before-completion')
  const earningContext=require('../../cloudfunctions/api/services/earnings')({...f.context,
    getSystemSettings:async()=>({settlement:{staffCommissionRate:.6,settlementDelayDays:0}})})
  await earningContext.ensureStaffEarning(structuredClone(f.db.state.orders[0]))
  await f.request(1,'after-completion')
  assert.equal(f.db.state.staff_earnings[0].originalAmount,.03)
  assert.equal(f.db.state.staff_earnings[0].amount,.02)
})

function recruitingGroup(f) {
  Object.assign(f.db.state.orders[0], { status: 'paid', groupBuyId: 'group', groupBuyStatus: 'recruiting' })
  f.db.state.staff_earnings = []
  f.db.state.pet_playground_groups = [{ _id: 'group', status: 'recruiting', formedAt: 0, deadline: 1,
    rules: { minHouseholds: 2 }, members: [{ openid: 'client', orderId: 'order' }] }]
  return require('../../cloudfunctions/api/services/playground-group-buy')({
    ...f.context, createRefundForOrder: f.service.requestOrderRefund
  })
}

test('group expiry refunds only the balance after an earlier successful partial refund',async()=>{
  const f=fixture(3), groups=recruitingGroup(f)
  await f.request(2,'prior-partial')
  await groups.expireGroupBuyIfDue('group')
  assert.equal(f.db.state.orders[0].refundedAmount,.05)
  assert.equal(f.db.state.orders[0].paymentStatus,'refunded')
  assert.deepEqual(f.db.state.refunds.map(row=>row.refundAmount).sort(),[.02,.03])
  await groups.expireDueGroupBuys()
  assert.equal(f.db.state.refunds.length,2)
})

for (const priorStatus of ['SUCCESS','CLOSED']) {
  test(`group expiry preserves a processing partial refund and refunds its remaining balance after ${priorStatus}`,async()=>{
    const f=fixture(3),groups=recruitingGroup(f)
    f.statuses.set('prior-processing','PROCESSING')
    const prior=await f.request(2,'prior-processing')
    await groups.expireGroupBuyIfDue('group')
    assert.equal(f.db.state.orders[0].paymentStatus,'refunding')
    assert.equal(f.db.state.orders[0].status,'expired')
    assert.equal(f.db.state.orders[0].groupBuyRefundRequired,true)
    assert.equal(f.db.state.refunds.length,1)
    f.statuses.set('prior-processing',priorStatus)
    await f.service.syncOrderRefund(prior)
    await groups.expireDueGroupBuys()
    assert.equal(f.db.state.orders[0].refundedAmount,.05)
    assert.equal(f.db.state.orders[0].paymentStatus,'refunded')
    const systemRefund=f.db.state.refunds.find(row=>row.source==='system_groupbuy_fail')
    assert.equal(systemRefund.refundAmount,priorStatus==='SUCCESS'?.03:.05)
    await groups.expireDueGroupBuys()
    assert.equal(f.db.state.refunds.length,2)
  })
}

for (const isGroup of [false,true]) {
  test(`unaccepted ${isGroup?'formed group':'multi-day order'} expiry refunds the balance after an earlier partial refund`,async()=>{
    const f=fixture(3)
    const time=new Date('2026-11-12T16:00:00Z')
    const sessions=[{index:1,startTime:isGroup?'2026-11-13 01:30':'2026-11-12 23:30',endTime:isGroup?'2026-11-13 02:00':'2026-11-13 00:00',status:'pending'}]
    if(!isGroup)sessions.push({index:2,startTime:'2026-11-13 23:30',endTime:'2026-11-14 00:00',status:'pending'})
    Object.assign(f.db.state.orders[0],{status:'paid',staffOpenid:'',startTime:sessions[0].startTime,endTime:sessions.at(-1).endTime,serviceSessions:sessions,
      ...(isGroup?{groupBuyId:'group',groupBuyStatus:'formed'}:{orderType:'multi_day'})})
    f.db.state.staff_earnings=[]
    if(isGroup)f.db.state.pet_playground_groups=[{_id:'group',status:'formed',formedAt:1,deadline:1}]
    await f.request(2,'prior-partial')
    const notices=[]
    const expiry=require('../../cloudfunctions/api/scheduled/expireOrders')({...f.context,now:()=>time,
      createRefundForOrder:f.service.requestOrderRefund,appendOrderTimeline:async()=>{},appendOrderClientMessage:async()=>{},
      notifyOrder:async(openid,template,order,detail)=>{notices.push(detail)}})
    await expiry.expireUnacceptedOrder('order',structuredClone(f.db.state.orders[0]),time)
    assert.equal(f.db.state.orders[0].refundedAmount,.05)
    assert.equal(f.db.state.orders[0].paymentStatus,'refunded')
    assert.deepEqual(f.db.state.refunds.map(row=>row.refundAmount).sort(),[.02,.03])
    assert.equal(notices[0].refundAmount,.03)
    await expiry.expireDueUnacceptedOrders()
    assert.equal(f.db.state.refunds.length,2)
  })
}

for (const priorStatus of ['SUCCESS','CLOSED']) {
  test(`unaccepted expiry waits for a processing partial refund before completing its balance after ${priorStatus}`,async()=>{
    const f=fixture(3)
    const time=new Date('2026-11-12T16:00:00Z')
    Object.assign(f.db.state.orders[0],{status:'paid',staffOpenid:'',startTime:'2026-11-12 23:30',endTime:'2026-11-13 00:00'})
    f.db.state.staff_earnings=[]
    f.statuses.set('prior-processing','PROCESSING')
    const prior=await f.request(2,'prior-processing')
    const expiry=require('../../cloudfunctions/api/scheduled/expireOrders')({...f.context,now:()=>time,
      createRefundForOrder:f.service.requestOrderRefund,appendOrderTimeline:async()=>{},appendOrderClientMessage:async()=>{},notifyOrder:async()=>{}})
    await expiry.expireDueUnacceptedOrders()
    assert.equal(f.db.state.orders[0].paymentStatus,'refunding')
    assert.equal(f.db.state.refunds.length,1)
    f.statuses.set('prior-processing',priorStatus)
    await f.service.syncOrderRefund(prior)
    await expiry.expireDueUnacceptedOrders()
    assert.equal(f.db.state.orders[0].refundedAmount,.05)
    assert.equal(f.db.state.orders[0].paymentStatus,'refunded')
    const systemRefund=f.db.state.refunds.find(row=>row.source==='system_expire')
    assert.equal(systemRefund.refundAmount,priorStatus==='SUCCESS'?.03:.05)
    await expiry.expireDueUnacceptedOrders()
    assert.equal(f.db.state.refunds.length,2)
  })
}
