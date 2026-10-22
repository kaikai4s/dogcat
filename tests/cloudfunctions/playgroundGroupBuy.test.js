const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const {createCollectionStore}=require('./helpers')
const {loadCloudFunction}=require('./helpers')
const createGroups=require('../../cloudfunctions/api/services/playground-group-buy')
const createSettlement=require('../../cloudfunctions/api/services/paymentSettlement')
const {communityId}=require('../../cloudfunctions/api/services/playground-world')
const {groupConfig,careConfig}=require('../../cloudfunctions/api/services/playground-config')
function fixture(){
  let stamp=Date.parse('2026-10-20T00:00:00Z')
  const community={name:'A小区',city:'上海',district:'浦东',address:'公开小区地址'},id=communityId({residentialCommunity:community})
  const users=['a','b','c','d'].map((openid)=>({_id:openid,openid,residentialCommunity:openid==='d'?{...community,name:'B小区'}:community}))
  const db=createCollectionStore({users,platform_configs:[{_id:'settings',key:'system_settings',value:{playgroundGroupBuy:{minHouseholds:2,discountRate:.88}}}]})
  const context={db,crypto,now:()=>new Date(stamp),nowMs:()=>stamp,getUser:async(id)=>users.find((u)=>u.openid===id)}
  const groups=createGroups(context),settlement=createSettlement(context)
  const sessions=[{date:'2026-10-21',startTime:'2026-10-21 10:00',endTime:'2026-10-21 10:30'}]
  const pricing={amount:100,sessions,priceSnapshot:{services:[{key:'visit_fee',price:20},{key:'feed',price:80}]}}
  const data=(who,extra={})=>({source:'community_groupbuy',communityId:id,serviceAddress:community.name,addressDetail:'楼栋'+who,doorplate:'101',...extra})
  async function submit(who,extra={},request=who,pay=true){
    const prepared=await groups.prepare(who,data(who,extra),pricing)
    const result = await settlement.createOrderWithCouponLock({collectionName:'orders',openid:who,couponId:'',order:{clientOpenid:who,clientRequestId:request,amount:100,payAmount:100,priceSnapshot:pricing.priceSnapshot,serviceSessions:sessions,startTime:sessions[0].startTime,endTime:sessions[0].endTime,serviceSummary:'喂养',status:'pending_pay',paymentStatus:'unpaid'},prepareOrder:(tx,order,id)=>groups.attach(tx,order,id,prepared)})
    if (pay && result.created) result.order = await payOrder(result.order)
    return result
  }
  async function payOrder(order) { const stored=db.state.orders.find(o=>o._id===order._id);stored.status='paid';stored.paymentStatus='paid';stored.paidAt=new Date(stamp);return groups.onOrderPaid(order._id) }
  return {db,context,groups,submit,payOrder,data,pricing,advance:(ms)=>stamp+=ms}
}
test('group orders attach atomically, form by distinct households, freeze cent pricing and retain private member identities',async()=>{
  const f=fixture(),first=await f.submit('a'),id=first.order.groupBuyId
  assert.equal(first.order.groupBuyStatus,'recruiting')
  const guard=require('../../cloudfunctions/api/services/paymentDeadline')({toTimeValue:(t)=>new Date(t).getTime(),now:f.context.now})
  assert.doesNotThrow(()=>guard.assertOrderPaymentOpen(first.order))
  assert.equal(first.order.payAmount,70.4)
  assert.equal(first.order.discountAmount,29.6)
  const before=await f.groups.list('b')
  assert.equal(before.availableCount,1)
  assert.ok(!JSON.stringify(before).includes('openid'))
  assert.ok(!JSON.stringify(before).includes('楼栋'))
  assert.equal(before.groups[0].orderId,undefined)
  assert.equal((await f.submit('a',{},'a')).created,false)
  await assert.rejects(f.submit('a',{groupBuyId:id},'again'),/每户/)
  const second=await f.submit('b',{groupBuyId:id})
  assert.equal(second.order.groupBuyStatus,'formed')
  assert.equal(second.order.payAmount,70.4)
  
  // 双方付款后成团
  const orderA = f.db.state.orders.find((o)=>o._id===first.order._id)
  orderA.status = 'paid'
  orderA.paymentStatus = 'paid'
  await f.groups.onOrderPaid(first.order._id, id)

  const orderB = f.db.state.orders.find((o)=>o._id===second.order._id)
  orderB.status = 'paid'
  orderB.paymentStatus = 'paid'
  await f.groups.onOrderPaid(second.order._id, id)

  const storedGroup = await f.db.collection('pet_playground_groups').doc(id).get()
  assert.ok(storedGroup.data.formedAt > 0)
  const freshA = f.db.state.orders.find((o)=>o._id===first.order._id)
  const freshB = f.db.state.orders.find((o)=>o._id===second.order._id)
  assert.equal(freshA.groupBuyStatus, 'formed')
  assert.equal(freshB.groupBuyStatus, 'formed')

  const stored=f.db.state.orders.find((o)=>o._id===first.order._id)
  assert.equal(stored.payAmount,70.4)
  assert.equal(stored.discountAmount,29.6)
  assert.doesNotThrow(()=>guard.assertOrderPaymentOpen(stored))
  f.db.state.platform_configs[0].value.playgroundGroupBuy={minHouseholds:10,discountRate:.5}
  const third=await f.submit('c',{groupBuyId:id})
  assert.equal(third.order.payAmount,70.4)
  assert.equal((await f.groups.list('a')).myGroups[0].orderId,first.order._id)
})
test('server rejects spoofed communities, off-community addresses, mismatched times, duplicate homes and coupons',async()=>{
  const f=fixture(),first=await f.submit('a'),id=first.order.groupBuyId
  await assert.rejects(f.groups.prepare('d',f.data('d',{groupBuyId:id}),f.pricing),/只能选择|不属于/)
  await assert.rejects(f.groups.prepare('a',f.data('a',{serviceAddress:'其他小区'}),f.pricing),/只能选择/)
  await assert.rejects(f.groups.prepare('a',f.data('a',{couponId:'coupon'}),f.pricing),/不可.*叠加/)
  await assert.rejects(f.groups.prepare('b',f.data('b',{groupBuyId:id}),{...f.pricing,sessions:[{...f.pricing.sessions[0],startTime:'2026-10-21 11:00'}]}),/服务日期和时段/)
  await assert.rejects(f.submit('b',{groupBuyId:id,addressDetail:'楼栋a'}),/每户/)
  const other=await f.groups.list('d')
  assert.equal(other.groups.length,0)
  f.advance(13*3600000)
  assert.equal((await f.groups.list('a')).myGroups[0].status,'expired')
  await assert.rejects(f.submit('b',{groupBuyId:id}),/截止/)
})
test('cancelled orders do not count toward households and invalid admin rules are rejected',async()=>{
  const f=fixture(),first=await f.submit('a'),id=first.order.groupBuyId
  f.db.state.orders[0].status='cancelled'
  const second=await f.submit('b',{groupBuyId:id})
  assert.equal(second.order.groupBuyStatus,'recruiting')
  assert.equal((await f.groups.list('b')).myGroups[0].householdCount,1)
  assert.throws(()=>groupConfig({discountRate:2}),/折扣/)
  assert.throws(()=>groupConfig({minHouseholds:1}),/户数/)
  assert.throws(()=>careConfig({cat:{eatRate:-1}}),/cat|猫/)
  assert.equal(careConfig({cat:{eatRate:.5},dog:{eatRate:.2}}).cat.eatRate,.5)
})
test('real order quote and create routes carry group context, enforce local coordinates and join the same group',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T00:00:00Z')})
  const community={name:'真实小区',city:'上海',latitude:31.2,longitude:121.4},id=communityId({residentialCommunity:community})
  const db=createCollectionStore({users:['a','b'].map((openid)=>({_id:'u_'+openid,openid,phone:'13800000000',roles:['client'],status:'active',residentialCommunity:community})),
    pets:['a','b'].map((openid)=>({_id:'p_'+openid,openid,name:'猫咪',species:'cat'})),platform_configs:[{_id:'settings',key:'system_settings',value:{playgroundGroupBuy:{minHouseholds:2}}}]})
  const apiA=loadCloudFunction('api',db,'a'),apiB=loadCloudFunction('api',db,'b')
  const data={source:'community_groupbuy',communityId:id,serviceAddress:community.name,addressDetail:'1栋',doorplate:'101',addressLatitude:1,addressLongitude:1,
    petIds:['p_a'],serviceTypes:['visit_fee','feed'],startDate:'2026-10-21',startClock:'10:00',durationMinutes:30,startTime:'2026-10-21 10:00',endTime:'2026-10-21 10:30',lockMethod:'someone_home',autoApplyCoupon:true}
  const quote=await apiA.main({module:'order',action:'quoteOrder',data})
  assert.equal(quote.ok,true,quote.message)
  assert.equal(quote.data.groupBuy.rules.minHouseholds,2)
  const first=await apiA.main({module:'order',action:'createOrder',data:{...data,clientRequestId:'first-group'}})
  assert.equal(first.ok,true,first.message)
  assert.equal(first.data.groupBuyStatus,'pending_payment')
  assert.equal(first.data.addressLatitude,community.latitude)
  assert.ok(first.data.payAmount < first.data.amount)
  // A 立即支付拼单特惠价
  const payA = await apiA.main({module:'payment',action:'createPayment',data:{orderId:first.data._id}})
  assert.equal(payA.ok, true)
  const paidA = await apiA.main({module:'payment',action:'mockPayOrder',data:{orderId:first.data._id,paymentNo:payA.data.paymentNo}})
  assert.equal(paidA.ok, true)

  const second=await apiB.main({module:'order',action:'createOrder',data:{...data,petIds:['p_b'],addressDetail:'2栋',groupBuyId:first.data.groupBuyId,clientRequestId:'join-group'}})
  assert.equal(second.ok,true,second.message)
  assert.equal(second.data.groupBuyStatus,'pending_payment')
  assert.ok(second.data.payAmount<second.data.amount)

  // B 支付拼单特惠价，凑齐2户已付款，正式触发成团！
  const payB = await apiB.main({module:'payment',action:'createPayment',data:{orderId:second.data._id}})
  assert.equal(payB.ok, true)
  const paidB = await apiB.main({module:'payment',action:'mockPayOrder',data:{orderId:second.data._id,paymentNo:payB.data.paymentNo}})
  assert.equal(paidB.ok, true)

  const freshSecond = await apiB.main({module:'order',action:'getOrderDetail',data:{orderId:second.data._id}})
  assert.equal(freshSecond.data.groupBuyStatus,'formed')
  const listing=await apiA.main({module:'playground',action:'listCommunityGroupBuys',data:{}})
  assert.equal(listing.ok,true,listing.message)
  assert.equal(listing.data.myGroups[0].householdCount,2)
})

test('unpaid orders stay private, unpaid joins never count and timed out joins do not affect paid members',async()=>{
  const f=fixture(), first=await f.submit('a',{},'a',false), id=first.order.groupBuyId
  assert.equal(first.order.groupBuyStatus,'pending_payment')
  assert.equal((await f.groups.list('a')).myGroups.length,0)
  assert.equal((await f.groups.list('b')).groups.length,0)
  assert.equal((f.db.state.pet_playground_groups||[]).length,0)
  await f.payOrder(first.order)
  const pending=await f.submit('b',{groupBuyId:id},'b',false)
  assert.equal((await f.groups.list('b')).myGroups.length,0)
  assert.equal((await f.groups.list('c')).groups[0].householdCount,1)
  f.advance(31*60000)
  assert.equal((await f.groups.list('a')).myGroups[0].householdCount,1)
  f.db.state.orders.find(o=>o._id===pending.order._id).status='cancelled'
  await f.submit('c',{groupBuyId:id})
  assert.equal((await f.groups.list('a')).myGroups[0].householdCount,2)
  assert.equal((await f.groups.list('a')).groups.length,0)
})

test('replayed paid callbacks are idempotent and cancelled groups cannot revive',async()=>{
  const f=fixture(), first=await f.submit('a'), id=first.order.groupBuyId
  await Promise.all([f.groups.onOrderPaid(first.order._id),f.groups.onOrderPaid(first.order._id)])
  assert.equal(f.db.state.pet_playground_groups[0].members.length,1)
  f.db.state.pet_playground_groups[0].status='cancelled'
  await f.groups.onOrderPaid(first.order._id)
  assert.equal(f.db.state.pet_playground_groups[0].status,'cancelled')
  assert.equal(f.db.state.orders[0].groupBuyRefundRequired,true)
  assert.equal((await f.groups.list('b')).groups.length,0)
})

test('late payments never publish a group and refund submission is retried by the scheduled sweep',async()=>{
  const f=fixture(), first=await f.submit('a',{},'late',false)
  f.advance(13*3600000)
  const paid=await f.payOrder(first.order)
  assert.equal(paid.groupBuyRefundRequired,true)
  assert.equal(paid.groupBuyStatus,'cancelled')
  assert.equal((f.db.state.pet_playground_groups||[]).length,0)
  assert.equal((await f.groups.list('b')).groups.length,0)
  const refunds=[]
  f.context.createRefundForOrder=async(...args)=>{ refunds.push(args);f.db.state.orders[0].paymentStatus='refunding' }
  await f.groups.expireDueGroupBuys()
  await f.groups.expireDueGroupBuys()
  assert.equal(refunds.length,1)
  assert.equal(refunds[0][1],70.4)
  assert.equal(refunds[0][5],'groupbuy_fail_'+first.order._id)
})

test('household roster includes every paid pet and excludes sibling credentials and unpaid joins',async()=>{
  const f=fixture(), first=await f.submit('a'), second=await f.submit('b',{groupBuyId:first.order.groupBuyId})
  await f.submit('c',{groupBuyId:first.order.groupBuyId},'c',false)
  f.db.state.orders.push({...second.order,_id:'late_failed_join',clientOpenid:'late',groupBuyActivationFailed:true,groupBuyRefundRequired:true,groupBuyStatus:'cancelled',paymentStatus:'paid'})
  Object.assign(f.db.state.orders.find(o=>o._id===second.order._id),{
    clientSnapshot:{nickname:'邻居用户',phone:'13912345678'},doorplate:'私密门牌',orderHomeSecurity:{code:'secret'},
    petSnapshots:[{name:'小猫',species:'cat',avatarFileId:'photo',healthNotes:'注意事项'},{name:'小狗',species:'dog'}]
  })
  const view=require('../../cloudfunctions/api/services/order-group-buy-view')(f.context)
  const detail=await view.attach(f.db.state.orders[0])
  assert.equal(detail.groupBuyBundle.members.length,2)
  const sibling=detail.groupBuyBundle.members.find(m=>m.orderId===second.order._id)
  assert.deepEqual(sibling.petSnapshots.map(p=>p.name),['小猫','小狗'])
  assert.equal(sibling.clientName,'邻**')
  assert.equal(sibling.doorplate,undefined)
  assert.equal(sibling.orderHomeSecurity,undefined)
  assert.equal(sibling.clientSnapshot,undefined)
  assert.equal(sibling.refundState, '')
  assert.equal(sibling.refundStatusText, '')
  await f.db.collection('orders').doc(second.order._id).update({ data: { paymentStatus: 'refunded', refundStatus: 'full_refunded', refundAmount: 70.4, refundedAmount: 70.4, status: 'refunded' } })
  const refundedDetail=await view.attach((await f.db.collection('orders').doc(second.order._id).get()).data)
  const refundedMember=refundedDetail.groupBuyBundle.members.find(m=>m.orderId===second.order._id)
  assert.equal(refundedMember.refundState, 'refunded')
  assert.equal(refundedMember.refundStatusText, '已退款')
  assert.equal(detail.groupBuyIntent,undefined)
  const publicDetail=await view.attach(f.db.state.orders[0],{publicView:true})
  assert.equal(publicDetail.groupBuyBundle.members[1].petSnapshots[0].avatarFileId,undefined)
  assert.equal(publicDetail.groupBuyBundle.members[1].petSnapshots[0].healthNotes,undefined)
})

test('expired group refunds survive a failed submission and keep the same refund request on retry', async()=>{
  const f=fixture(),first=await f.submit('a'),calls=[]
  let fail=true
  f.context.createRefundForOrder=async(...args)=>{
    calls.push(args)
    if(fail) throw new Error('temporary refund outage')
    f.db.state.orders.find(o=>o._id===args[0]._id).paymentStatus='refunding'
  }
  f.advance(13*3600000)
  await f.groups.expireDueGroupBuys()
  const expired=f.db.state.orders.find(o=>o._id===first.order._id)
  assert.equal(expired.status,'expired')
  assert.equal(expired.groupBuyRefundRequired,true)
  assert.equal(expired.paymentStatus,'paid')
  fail=false
  await f.groups.expireDueGroupBuys()
  await f.groups.expireDueGroupBuys()
  assert.equal(calls.length,2)
  assert.equal(calls[0][2],calls[1][2],'idempotent retries must preserve the refund reason')
  assert.equal(calls[0][5],calls[1][5])
  assert.equal(expired.paymentStatus,'refunding')
  const history=await require('../../cloudfunctions/api/services/order-group-buy-view')(f.context).attach(expired)
  assert.equal(history.groupBuyBundle.members.length,1,'refunds retain households that really joined')
})

test('expired recruiting groups are processed beyond a hundred formed groups',async()=>{
  const f=fixture(),first=await f.submit('a'),calls=[]
  const group=f.db.state.pet_playground_groups[0]
  for(let i=0;i<105;i++) f.db.state.pet_playground_groups.push({...group,_id:'aa_history_'+String(i).padStart(3,'0'),formedAt:1,status:'formed'})
  f.context.createRefundForOrder=async(order)=>{calls.push(order._id);f.db.state.orders.find(o=>o._id===order._id).paymentStatus='refunding'}
  f.advance(13*3600000)
  await f.groups.expireDueGroupBuys()
  assert.deepEqual(calls,[first.order._id])
  assert.equal(f.db.state.pet_playground_groups.find(g=>g._id===first.order.groupBuyId).status,'cancelled')
})

test('when the last member of a group buy cancels, the group is immediately cancelled and delisted from community',async()=>{
  const f=fixture()
  // 1. a 发起拼单，b 加入拼单
  const first=await f.submit('a')
  const groupBuyId=first.order.groupBuyId
  const second=await f.submit('b',{groupBuyId})
  
  let groupDoc=await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.equal(groupDoc.data.members.length,2)
  assert.notEqual(groupDoc.data.status,'cancelled')

  // 2. a 取消订单（还剩 b）
  f.db.state.orders.find(o=>o._id===first.order._id).status='cancelled'
  await f.groups.onOrderCancelled(first.order._id,groupBuyId)

  groupDoc=await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.equal(groupDoc.data.members.length,1)
  assert.equal(groupDoc.data.members[0].openid,'b')
  assert.notEqual(groupDoc.data.status,'cancelled')

  // 3. 当最后一人 b 也取消时：立即作废整个拼单
  f.db.state.orders.find(o=>o._id===second.order._id).status='cancelled'
  await f.groups.onOrderCancelled(second.order._id,groupBuyId)

  groupDoc=await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.equal(groupDoc.data.status,'cancelled')
  assert.ok(groupDoc.data.cancelReason.includes('取消'))

  // 4. 邻居 c 查询同小区拼单列表：已取消的拼单已被踢除，不会作为招募中拼单展示
  const listingC=await f.groups.list('c')
  assert.equal(listingC.groups.length,0)

  // 5. b 查询自己的拼单：仍可看到已取消状态
  const listingB=await f.groups.list('b')
  assert.equal(listingB.myGroups[0].status,'cancelled')
  assert.equal(listingB.myGroups[0].statusText,'已取消')
})

test('group buy enforces single-day schedule and prevents unilateral cancellation after formed',async(t)=>{
  const f=fixture()
  // 1. 测试跨天拼单被直接拒绝
  const multiDayPricing={
    amount:200,
    sessions:[
      {date:'2026-10-21',startTime:'2026-10-21 10:00',endTime:'2026-10-21 10:30'},
      {date:'2026-10-22',startTime:'2026-10-22 10:00',endTime:'2026-10-22 10:30'}
    ],
    priceSnapshot:{services:[{key:'feed',price:100}]}
  }
  await assert.rejects(
    f.groups.prepare('a',f.data('a'),multiDayPricing),
    /单日服务|不可跨天/
  )

  // 2. 测试成团后严禁单方面取消订单
  const first=await f.submit('a')
  const groupBuyId=first.order.groupBuyId
  const second=await f.submit('b',{groupBuyId})
  const orderA = f.db.state.orders.find((o)=>o._id===first.order._id)
  orderA.status = 'paid'
  orderA.paymentStatus = 'paid'
  await f.groups.onOrderPaid(first.order._id, groupBuyId)

  const orderB = f.db.state.orders.find((o)=>o._id===second.order._id)
  orderB.status = 'paid'
  orderB.paymentStatus = 'paid'
  await f.groups.onOrderPaid(second.order._id, groupBuyId)
  const freshB = f.db.state.orders.find((o)=>o._id===second.order._id)
  assert.equal(freshB.groupBuyStatus,'formed')

  // 获取 cancelQuote 验证 canCancel 必须为 false
  const orderAccess=require('../../cloudfunctions/api/services/orderAccess')({
    now:f.context.now,
    toTimeValue:(t)=>new Date(t).getTime(),
    getSystemSettings:async()=>({})
  })
  const quote=orderAccess.getCancelQuoteForOrder(freshB)
  assert.equal(quote.canCancel,false)
  assert.ok(quote.ruleText.includes('成团锁定') || quote.ruleText.includes('暂不支持'))
})

test('group buy unformed orders are excluded from open hall and expire 2 hours before service start',async()=>{
  const f=fixture()
  const orderState=require('../../cloudfunctions/api/services/orderState')({
    db:f.db,
    ORDER_STATUS:{PAID:'paid',EXPIRED:'expired'}
  })
  const expireService=require('../../cloudfunctions/api/scheduled/expireOrders')({
    now:f.context.now,
    toTimeValue:(t)=>new Date(t).getTime(),
    ORDER_STATUS:{PAID:'paid',EXPIRED:'expired'},
    safeText:(s)=>String(s||''),
    createRefundForOrder:async(order,amount,reason)=>{
      await f.db.collection('orders').doc(order._id).update({data:{status:'expired',paymentStatus:'refunding',refundStatus:'processing',refundAmount:amount,expireReason:reason}})
      return {refundNo:'ref_123',amount}
    },
    makeIdempotencyKey:()=>'idem',
    db:f.db,
    appendOrderTimeline:async()=>{},
    appendOrderClientMessage:async()=>{},
    restoreOrderCoupon:async()=>{}
  })

  // 1. 验证 isOpenOrder：未成团的拼单订单决不能公开出现在抢单大厅
  const recruitingOrder={
    source:'community_groupbuy',
    groupBuyId:'g1',
    groupBuyStatus:'recruiting',
    status:'paid',
    publishMode:'open'
  }
  assert.equal(orderState.isOpenOrder(recruitingOrder),false,'未成团拼单订单严禁出现在抢单大厅')

  const formedOrder={
    source:'community_groupbuy',
    groupBuyId:'g1',
    groupBuyStatus:'formed',
    status:'paid',
    publishMode:'open'
  }
  assert.equal(orderState.isOpenOrder(formedOrder),true,'成团拼单订单允许公开接单')

  // 2. 验证 T-2h 自动过期：服务时间为 14:00
  const serviceStartTime='2026-10-21 14:00'
  const groupOrder={
    _id:'ord_group',
    source:'community_groupbuy',
    groupBuyId:'g1',
    status:'paid',
    paymentStatus:'paid',
    payAmount:70.4,
    startTime:serviceStartTime,
    clientOpenid:'u1'
  }
  const regularOrder={
    _id:'ord_regular',
    status:'paid',
    paymentStatus:'paid',
    payAmount:100,
    startTime:serviceStartTime,
    clientOpenid:'u2'
  }

  const time2_5hBefore=new Date('2026-10-21T03:30:00Z') // 11:30
  const time1_9hBefore=new Date('2026-10-21T04:05:00Z') // 12:05 (距14:00不足2h)

  // 11:30 时：拼单和普通订单均未过期
  assert.equal(expireService.shouldExpireUnacceptedOrder(groupOrder,time2_5hBefore),false)
  assert.equal(expireService.shouldExpireUnacceptedOrder(regularOrder,time2_5hBefore),false)

  // 12:05 时（服务前不足 2 小时）：拼单提前判定过期！普通订单此时尚未过期
  assert.equal(expireService.shouldExpireUnacceptedOrder(groupOrder,time1_9hBefore),true)
  assert.equal(expireService.shouldExpireUnacceptedOrder(regularOrder,time1_9hBefore),false)

  // 3. 执行 expireUnacceptedOrder：验证退款及拼单团状态同步
  f.db.state.pet_playground_groups=[{_id:'g1',status:'recruiting',members:[]}]
  f.db.state.orders=[...(f.db.state.orders||[]),groupOrder]
  const expired=await expireService.expireUnacceptedOrder('ord_group',groupOrder,time1_9hBefore)
  assert.equal(expired.status,'expired')
  assert.equal(expired.paymentStatus,'refunding')
  assert.ok(expired.expireReason.includes('2小时'))

  const g1Doc=await f.db.collection('pet_playground_groups').doc('g1').get()
  assert.equal(g1Doc.data.status,'cancelled')
})

test('sitter accepting a community group buy order bundles all orders in the group',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T00:00:00Z')})
  const community={name:'同心小区',city:'上海',latitude:31.2,longitude:121.4}
  const staffUser={_id:'u_staff',openid:'staff_1',roles:['staff'],status:'active',phone:'13900000000'}
  const staffProfile={_id:'sp_staff',openid:'staff_1',realName:'张师傅',phone:'13900000000',auditStatus:'approved',serviceAddress:'同心小区附近',serviceLatitude:31.2,serviceLongitude:121.4,serviceRadiusKm:10,weeklySchedule:[{day:3,timeSlots:['09:00-18:00']}]}
  
  const orderA={
    _id:'ord_bundle_1',
    orderNo:'O1',
    source:'community_groupbuy',
    groupBuyId:'group_bundle',
    groupBuyStatus:'formed',
    status:'paid',
    paymentStatus:'paid',
    publishMode:'open',
    clientOpenid:'u_client_1',
    startTime:'2026-10-21 10:00',
    endTime:'2026-10-21 10:30',
    serviceStartDate:'2026-10-21',
    serviceEndDate:'2026-10-21',
    serviceSessions:[{date:'2026-10-21',startTime:'2026-10-21 10:00',endTime:'2026-10-21 10:30'}],
    serviceTypes:['feed'],
    serviceAddress:community.name,
    addressLatitude:31.2,
    addressLongitude:121.4,
    payAmount:70.4,
    staffOpenid:''
  }

  const orderB={
    _id:'ord_bundle_2',
    orderNo:'O2',
    source:'community_groupbuy',
    groupBuyId:'group_bundle',
    groupBuyStatus:'formed',
    status:'paid',
    paymentStatus:'paid',
    publishMode:'open',
    clientOpenid:'u_client_2',
    startTime:'2026-10-21 10:30',
    endTime:'2026-10-21 11:00',
    serviceStartDate:'2026-10-21',
    serviceEndDate:'2026-10-21',
    serviceSessions:[{date:'2026-10-21',startTime:'2026-10-21 10:30',endTime:'2026-10-21 11:00'}],
    serviceTypes:['feed'],
    serviceAddress:community.name,
    addressLatitude:31.2,
    addressLongitude:121.4,
    payAmount:70.4,
    staffOpenid:''
  }

  const db=createCollectionStore({
    users:[staffUser],
    staff_profiles:[staffProfile],
    orders:[orderA,orderB],
    order_messages:[],
    order_message_threads:[],
    order_timeline:[],
    platform_configs:[{_id:'settings',key:'system_settings',value:{staffDeposit:{required:false}}}]
  })

  const staffApi=loadCloudFunction('api',db,'staff_1')
  const acceptRes=await staffApi.main({
    module:'staff',
    action:'acceptOrder',
    data:{orderId:'ord_bundle_1',currentLatitude:31.2,currentLongitude:121.4}
  })
  assert.equal(acceptRes.ok,true,acceptRes.message)
  assert.equal(acceptRes.data.bundledCount,2,'应整包承接本拼单团全部2户订单')

  const docA=await db.collection('orders').doc('ord_bundle_1').get()
  const docB=await db.collection('orders').doc('ord_bundle_2').get()
  assert.equal(docA.data.staffOpenid,'staff_1')
  assert.equal(docA.data.status,'assigned')
  assert.equal(docB.data.staffOpenid,'staff_1')
  assert.equal(docB.data.status,'assigned')
})

test('同小区拼单任务包: 抢单大厅聚合成单条展示且详情支持多户分栏数据', async () => {
  const community = { name: '龙湖春江天玺', city: '上海市', latitude: 31.2, longitude: 121.4 }
  const staffUser = { _id: 'u_staff_p', openid: 'staff_p', roles: ['staff'], status: 'active', residentialCommunity: community }
  const staffProfile = {
    _id: 'prof_staff_p',
    openid: 'staff_p',
    realName: '王宠托',
    auditStatus: 'approved',
    onboardingStatus: 'approved',
    serviceAddress: community.name,
    serviceLatitude: 31.2,
    serviceLongitude: 121.4,
    serviceRadiusKm: 10,
    trainingVideoProgress: {},
    staffLevel: 'certified'
  }

  const order1 = {
    _id: 'ord_agg_1',
    orderNo: 'OAGG1',
    source: 'community_groupbuy',
    groupBuyId: 'group_agg_test',
    groupBuyStatus: 'formed',
    status: 'paid',
    paymentStatus: 'paid',
    publishMode: 'open',
    clientOpenid: 'client_agg_1',
    petName: '皮皮猫',
    startTime: '2099-10-21 14:00',
    endTime: '2099-10-21 14:30',
    serviceStartDate: '2099-10-21',
    serviceEndDate: '2099-10-21',
    serviceSessions: [{ date: '2099-10-21', startTime: '2099-10-21 14:00', endTime: '2099-10-21 14:30' }],
    serviceTypes: ['feed'],
    serviceAddress: community.name,
    doorplate: '1号楼101',
    addressLatitude: 31.2,
    addressLongitude: 121.4,
    payAmount: 60,
    staffOpenid: ''
  }

  const order2 = {
    _id: 'ord_agg_2',
    orderNo: 'OAGG2',
    source: 'community_groupbuy',
    groupBuyId: 'group_agg_test',
    groupBuyStatus: 'formed',
    status: 'paid',
    paymentStatus: 'paid',
    publishMode: 'open',
    clientOpenid: 'client_agg_2',
    petName: '球球狗',
    startTime: '2099-10-21 14:30',
    endTime: '2099-10-21 15:00',
    serviceStartDate: '2099-10-21',
    serviceEndDate: '2099-10-21',
    serviceSessions: [{ date: '2099-10-21', startTime: '2099-10-21 14:30', endTime: '2099-10-21 15:00' }],
    serviceTypes: ['feed'],
    serviceAddress: community.name,
    doorplate: '2号楼302',
    addressLatitude: 31.2,
    addressLongitude: 121.4,
    payAmount: 60,
    staffOpenid: ''
  }

  const clientUser1 = { _id: 'u_client_agg_1', openid: 'client_agg_1', roles: ['client'], status: 'active' }
  const clientUser2 = { _id: 'u_client_agg_2', openid: 'client_agg_2', roles: ['client'], status: 'active' }

  const db = createCollectionStore({
    users: [staffUser, clientUser1, clientUser2],
    staff_profiles: [staffProfile],
    orders: [order1, order2],
    staff_schedule_exceptions: [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { staffDeposit: { required: false } } }]
  })

  const staffApi = loadCloudFunction('api', db, 'staff_p')
  // 1. 抢单大厅查询
  const listRes = await staffApi.main({
    module: 'staff',
    action: 'listNearbyOrders',
    data: { latitude: 31.2, longitude: 121.4 }
  })
  assert.equal(listRes.ok, true, listRes.message)
  const list = listRes.data || []
  // 必须只返回 1 条聚合任务包，严禁拆分成 2 条散单
  assert.equal(list.length, 1, '同拼单团应当聚合为 1 条拼单任务包')
  const bundle = list[0]
  assert.equal(bundle.isGroupBuyBundle, true)
  assert.equal(bundle.householdCount, 2)
  assert.equal(bundle.subOrders.length, 2)

  await db.collection('orders').doc('ord_agg_2').update({ data: { staffGenderRequirement: 'female' } })
  const incompatible = await staffApi.main({ module: 'staff', action: 'listNearbyOrders', data: { latitude: 31.2, longitude: 121.4 } })
  assert.equal(incompatible.ok, true, incompatible.message)
  assert.equal(incompatible.data.length, 0, 'one incompatible household must hide the complete package, never show one household')
  await db.collection('orders').doc('ord_agg_2').update({ data: { staffGenderRequirement: 'any' } })

  // 2. 宠托师接单
  const acceptRes = await staffApi.main({
    module: 'staff',
    action: 'acceptOrder',
    data: { orderId: bundle._id, currentLatitude: 31.2, currentLongitude: 121.4 }
  })
  assert.equal(acceptRes.ok, true, acceptRes.message)
  assert.equal(acceptRes.data.bundledCount, 2)

  // 3. 宠托师查看订单详情，校验 groupBuyBundle 多户分栏数据
  const detailApi = loadCloudFunction('api', db, 'staff_p')
  const detailRes = await detailApi.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: bundle._id, role: 'staff' }
  })
  assert.equal(detailRes.ok, true, detailRes.message)
  const detailOrder = detailRes.data
  assert.equal(detailOrder.isGroupBuy, true)
  assert.ok(detailOrder.groupBuyBundle, '接单后应返回 groupBuyBundle 用于前端分栏切换')
  assert.equal(detailOrder.groupBuyBundle.members.length, 2)

  // 4. 服务履约：第1户完成打卡，调用 finishService，此时第2户尚未完成，整团应部分就绪
  // 将两单都模拟进入 in_service
  await db.collection('orders').doc('ord_agg_1').update({ data: { status: 'in_service', currentSessionStartedAt: '2099-10-21 14:00' } })
  await db.collection('orders').doc('ord_agg_2').update({ data: { status: 'in_service', currentSessionStartedAt: '2099-10-21 14:30' } })
  // 注入第1户的必填打卡
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_agg_1', eventType: 'sanitization', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_agg_1', eventType: 'enter_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_agg_1', eventType: 'leave_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })

  const finishApi = loadCloudFunction('api', db, 'staff_p')
  const finish1Res = await finishApi.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'ord_agg_1' }
  })
  assert.equal(finish1Res.ok, true, finish1Res.message)
  assert.equal(finish1Res.data.partialGroupCompleted, true, '第一户完成应标识 partialGroupCompleted')

  const doc1After = await db.collection('orders').doc('ord_agg_1').get()
  const doc2After = await db.collection('orders').doc('ord_agg_2').get()
  assert.equal(doc1After.data.status, 'day_completed')
  assert.equal(doc2After.data.status, 'in_service')

  // 5. 第2户完成打卡并点击完成服务，整团所有住户服务全部完成
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_agg_2', eventType: 'sanitization', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_agg_2', eventType: 'enter_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_agg_2', eventType: 'leave_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })

  const finish2Res = await finishApi.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'ord_agg_2' }
  })
  assert.equal(finish2Res.ok, true, finish2Res.message)
  assert.equal(finish2Res.data.allGroupCompleted, true, '第二户完成且此前第一户已就绪，应完成整团拼单')

  const doc1Final = await db.collection('orders').doc('ord_agg_1').get()
  const doc2Final = await db.collection('orders').doc('ord_agg_2').get()
  assert.equal(doc1Final.data.status, 'completed')
  assert.equal(doc2Final.data.status, 'completed')
})

test('同小区拼单任务包: 默认2户成团，且支持3户以上多户逐户分栏打卡与全团结算', async () => {
  const { readConfig } = require('../../cloudfunctions/api/services/playground-config')
  const defaultCfg = await readConfig(createCollectionStore({ platform_configs: [] }))
  assert.equal(defaultCfg.groupBuy.minHouseholds, 2, '系统默认拼单成团门槛已调整为2户')

  const community = { name: '万科翡翠滨江', city: '上海市', latitude: 31.2, longitude: 121.5 }
  const staffUser = { _id: 'u_staff_m', openid: 'staff_m', roles: ['staff'], status: 'active', residentialCommunity: community }
  const staffProfile = {
    _id: 'prof_staff_m',
    openid: 'staff_m',
    realName: '李宠师',
    auditStatus: 'approved',
    onboardingStatus: 'approved',
    serviceAddress: community.name,
    serviceLatitude: 31.2,
    serviceLongitude: 121.5,
    serviceRadiusKm: 10,
    trainingVideoProgress: {},
    staffLevel: 'certified'
  }

  const client1 = { _id: 'u_c_1', openid: 'client_1', roles: ['client'], status: 'active' }
  const client2 = { _id: 'u_c_2', openid: 'client_2', roles: ['client'], status: 'active' }
  const client3 = { _id: 'u_c_3', openid: 'client_3', roles: ['client'], status: 'active' }

  const makeOrder = (id, clientOpenid, petName, doorplate, startTime, endTime) => ({
    _id: id,
    orderNo: 'NO_' + id,
    source: 'community_groupbuy',
    groupBuyId: 'group_3households',
    groupBuyStatus: 'formed',
    status: 'paid',
    paymentStatus: 'paid',
    publishMode: 'open',
    clientOpenid,
    petName,
    startTime,
    endTime,
    serviceStartDate: '2099-10-21',
    serviceEndDate: '2099-10-21',
    serviceSessions: [{ date: '2099-10-21', startTime, endTime }],
    serviceTypes: ['feed'],
    serviceAddress: community.name,
    doorplate,
    addressLatitude: 31.2,
    addressLongitude: 121.5,
    payAmount: 50,
    staffOpenid: ''
  })

  const o1 = makeOrder('ord_3h_1', 'client_1', '橘猫大橘', '1号楼101', '2099-10-21 16:00', '2099-10-21 16:30')
  const o2 = makeOrder('ord_3h_2', 'client_2', '白猫雪球', '2号楼202', '2099-10-21 16:30', '2099-10-21 17:00')
  const o3 = makeOrder('ord_3h_3', 'client_3', '柴犬阿黄', '3号楼303', '2099-10-21 17:00', '2099-10-21 17:30')

  const db = createCollectionStore({
    users: [staffUser, client1, client2, client3],
    staff_profiles: [staffProfile],
    orders: [o1, o2, o3],
    staff_schedule_exceptions: [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { staffDeposit: { required: false } } }]
  })

  const staffApi = loadCloudFunction('api', db, 'staff_m')
  // 1. 抢单大厅聚合展示3户拼单
  const listRes = await staffApi.main({
    module: 'staff',
    action: 'listNearbyOrders',
    data: { latitude: 31.2, longitude: 121.5 }
  })
  assert.equal(listRes.ok, true)
  assert.equal(listRes.data.length, 1, '3户拼单也应当聚合为1个拼单任务包')
  const bundle = listRes.data[0]
  assert.equal(bundle.householdCount, 3)
  assert.equal(bundle.subOrders.length, 3)

  // 2. 接单：一次性整包顺路承接3户
  const acceptRes = await staffApi.main({
    module: 'staff',
    action: 'acceptOrder',
    data: { orderId: bundle._id, currentLatitude: 31.2, currentLongitude: 121.5 }
  })
  assert.equal(acceptRes.ok, true)
  assert.equal(acceptRes.data.bundledCount, 3, '应当整包接下全部3户订单')

  // 3. 详情页多户分栏数据：返回3个成员供前端Tab切换
  const detailApi = loadCloudFunction('api', db, 'staff_m')
  const detailRes = await detailApi.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: bundle._id, role: 'staff' }
  })
  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.groupBuyBundle.members.length, 3)

  // 4. 模拟逐户打卡：进入服务状态
  for (const id of ['ord_3h_1', 'ord_3h_2', 'ord_3h_3']) {
    await db.collection('orders').doc(id).update({ data: { status: 'in_service', currentSessionStartedAt: '2026-10-21 16:00' } })
    await db.collection('checkin_logs').add({ data: { orderId: id, eventType: 'sanitization', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
    await db.collection('checkin_logs').add({ data: { orderId: id, eventType: 'enter_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
    await db.collection('checkin_logs').add({ data: { orderId: id, eventType: 'leave_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  }

  // 4.1 第1户完成
  const f1 = await detailApi.main({ module: 'order', action: 'finishService', data: { id: 'ord_3h_1' } })
  assert.equal(f1.data.partialGroupCompleted, true)
  assert.equal(f1.data.remainingCount, 2, '同团还剩2户未完成')
  const d1 = await db.collection('orders').doc('ord_3h_1').get()
  assert.equal(d1.data.status, 'day_completed')

  // 4.2 第2户完成
  const f2 = await detailApi.main({ module: 'order', action: 'finishService', data: { id: 'ord_3h_2' } })
  assert.equal(f2.data.partialGroupCompleted, true)
  assert.equal(f2.data.remainingCount, 1, '同团还剩1户未完成')
  const d2 = await db.collection('orders').doc('ord_3h_2').get()
  assert.equal(d2.data.status, 'day_completed')

  // 4.3 第3户完成（最后一户）
  const f3 = await detailApi.main({ module: 'order', action: 'finishService', data: { id: 'ord_3h_3' } })
  assert.equal(f3.data.allGroupCompleted, true, '全部3户均完成，触发整包终态结算')

  for (const id of ['ord_3h_1', 'ord_3h_2', 'ord_3h_3']) {
    const doc = await db.collection('orders').doc(id).get()
    assert.equal(doc.data.status, 'completed', `订单 ${id} 应当最终完成`)
  }
})

test('同小区拼单任务包: 出发前往与时空雷达整团联动更新，且同团有取消订单时免死锁完成结算', async () => {
  const community = { name: '万科翡翠滨江', city: '上海市', latitude: 31.2, longitude: 121.5 }
  const staffUser = { _id: 'u_staff_transit', openid: 'staff_transit', roles: ['staff'], status: 'active', residentialCommunity: community }
  const staffProfile = {
    _id: 'prof_staff_transit',
    openid: 'staff_transit',
    realName: '赵宠师',
    auditStatus: 'approved',
    onboardingStatus: 'approved',
    serviceAddress: community.name,
    serviceLatitude: 31.2,
    serviceLongitude: 121.5,
    serviceRadiusKm: 10,
    trainingVideoProgress: {},
    staffLevel: 'certified'
  }

  const client1 = { _id: 'u_client_t1', openid: 'client_t1', roles: ['client'], status: 'active' }
  const client2 = { _id: 'u_client_t2', openid: 'client_t2', roles: ['client'], status: 'active' }

  const makeOrder = (id, clientOpenid, petName, doorplate) => ({
    _id: id,
    orderNo: 'NOTRANSIT_' + id,
    source: 'community_groupbuy',
    groupBuyId: 'group_transit_test',
    groupBuyStatus: 'formed',
    status: 'assigned',
    paymentStatus: 'paid',
    publishMode: 'open',
    clientOpenid,
    staffOpenid: 'staff_transit',
    staffUserId: staffUser._id,
    staffProfileId: staffProfile._id,
    petName,
    startTime: '2099-10-21 14:00',
    endTime: '2099-10-21 14:30',
    serviceStartDate: '2099-10-21',
    serviceEndDate: '2099-10-21',
    serviceSessions: [{ index: 1, date: '2099-10-21', startTime: '2099-10-21 14:00', endTime: '2099-10-21 14:30', status: 'pending' }],
    serviceTypes: ['feed'],
    serviceAddress: community.name,
    doorplate,
    addressLatitude: 31.2,
    addressLongitude: 121.5,
    payAmount: 60
  })

  const orderA = makeOrder('ord_transit_a', 'client_t1', '布偶猫咪咪', '1号楼101')
  const orderB = makeOrder('ord_transit_b', 'client_t2', '金毛可乐', '2号楼202')

  const db = createCollectionStore({
    users: [staffUser, client1, client2],
    staff_profiles: [staffProfile],
    orders: [orderA, orderB],
    staff_schedule_exceptions: [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { staffDeposit: { required: false } } }]
  })

  const staffApi = loadCloudFunction('api', db, 'staff_transit')

  // 1. 宠托师针对 orderA 调用 departForService 出发前往
  const departRes = await staffApi.main({
    module: 'order',
    action: 'departForService',
    data: {
      id: 'ord_transit_a',
      latitude: 31.21,
      longitude: 121.51
    }
  })
  assert.equal(departRes.ok, true, departRes.message)

  // 校验主订单 orderA 状态变为 on_the_way
  const docAAfterDepart = await db.collection('orders').doc('ord_transit_a').get()
  assert.equal(docAAfterDepart.data.status, 'on_the_way')
  assert.ok(docAAfterDepart.data.departedAt)
  assert.ok(docAAfterDepart.data.travelEtaMinutes > 0)

  // 关键断言：同拼单团的兄弟订单 orderB 必须联动自动更新为 on_the_way 并同步时空雷达与出发时间
  const docBAfterDepart = await db.collection('orders').doc('ord_transit_b').get()
  assert.equal(docBAfterDepart.data.status, 'on_the_way', '兄弟订单应当联动更新为 on_the_way')
  assert.ok(docBAfterDepart.data.departedAt, '兄弟订单应同步出发时间')
  assert.equal(docBAfterDepart.data.travelDeparted, true)
  assert.ok(docBAfterDepart.data.travelEtaMinutes > 0)

  // 2. 途中位置上报 updateTravelLocation
  const locRes = await staffApi.main({
    module: 'order',
    action: 'updateTravelLocation',
    data: {
      id: 'ord_transit_a',
      latitude: 31.2005,
      longitude: 121.5005
    }
  })
  assert.equal(locRes.ok, true, locRes.message)

  const docAAfterLoc = await db.collection('orders').doc('ord_transit_a').get()
  const docBAfterLoc = await db.collection('orders').doc('ord_transit_b').get()
  assert.equal(docAAfterLoc.data.currentLocation.latitude, 31.2005)
  assert.equal(docBAfterLoc.data.currentLocation.latitude, 31.2005, '兄弟订单应同步实时雷达位置')

  // 3. 模拟异常场景：同团中 orderB 因紧急情况被平台客服取消
  await db.collection('orders').doc('ord_transit_b').update({
    data: {
      status: 'cancelled',
      cancelReason: '客户家中突发紧急情况客服介入取消',
      refundStatus: 'completed'
    }
  })

  // 4. 宠托师开始服务 orderA，并完成打卡
  await db.collection('orders').doc('ord_transit_a').update({
    data: {
      status: 'in_service',
      currentSessionStartedAt: '2099-10-21 14:00'
    }
  })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_transit_a', eventType: 'sanitization', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_transit_a', eventType: 'enter_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })
  await db.collection('checkin_logs').add({ data: { orderId: 'ord_transit_a', eventType: 'leave_door', clientRole: 'staff', status: 'valid', createdAt: new Date() } })

  // 5. 调用 finishService 完成服务
  // 关键断言：同团的 orderB 已经 cancelled，系统不应死锁卡在 day_completed，而应直接判定所有有效订单全部履约完毕，整单结算为 completed
  const finishRes = await staffApi.main({
    module: 'order',
    action: 'finishService',
    data: { id: 'ord_transit_a' }
  })
  assert.equal(finishRes.ok, true, finishRes.message)
  assert.equal(finishRes.data.allGroupCompleted, true, '同团其他订单取消时，正常履约订单打卡完成应顺利终态结算，不可发生死锁')

  const docAFinal = await db.collection('orders').doc('ord_transit_a').get()
  const docBFinal = await db.collection('orders').doc('ord_transit_b').get()
  assert.equal(docAFinal.data.status, 'completed', '订单A应当正常进入 completed 终态')
  assert.equal(docBFinal.data.status, 'cancelled', '已取消的订单B应保持 cancelled')
})

test('同小区拼单先支付保障: 未成团招募截止自动全额原路退款', async () => {
  const f = fixture()
  const refundCalls = []
  f.context.createRefundForOrder = async (order, amount, reason, type, openid, idempotencyKey, options) => {
    refundCalls.push({ orderId: order._id, amount, reason, type, openid, idempotencyKey, options })
    return { refundNo: 'ref_' + order._id, status: 'processing' }
  }

  // A 发起拼单并完成预付款
  const first = await f.submit('a')
  const groupBuyId = first.order.groupBuyId
  const orderA = f.db.state.orders.find(o => o._id === first.order._id)
  orderA.status = 'paid'
  orderA.paymentStatus = 'paid'
  await f.groups.onOrderPaid(first.order._id, groupBuyId)

  // 此时只有 A 付款，拼单仍处于招募中
  let groupDoc = await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.equal(groupDoc.data.status, 'recruiting')
  assert.equal(groupDoc.data.formedAt, 0)

  // 时间推进超过募集截止时间（deadline）
  f.advance(13 * 3600000)

  // 触发自动检查过期与退款
  await f.groups.expireDueGroupBuys(f.context.now())

  // 断言：拼单已自动取消
  groupDoc = await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.equal(groupDoc.data.status, 'cancelled')
  assert.ok(groupDoc.data.cancelReason.includes('未成团') || groupDoc.data.cancelReason.includes('截止'))

  // 断言：已付款用户 A 收到全额原路退款
  assert.equal(refundCalls.length, 1)
  assert.equal(refundCalls[0].orderId, first.order._id)
  assert.equal(refundCalls[0].amount, 70.4)
  assert.ok(refundCalls[0].reason.includes('未成团') || refundCalls[0].reason.includes('全额退款'))
  const freshA = f.db.state.orders.find(o => o._id === first.order._id)
  assert.equal(freshA.status, 'expired')
  assert.equal(freshA.groupBuyStatus, 'cancelled')
})

test('同小区拼单先支付保障: 成团后服务开始前2小时无人接单自动全额原路退款', async () => {
  const f = fixture()
  const refundCalls = []
  f.context.createRefundForOrder = async (order, amount, reason, type, openid, idempotencyKey, options) => {
    refundCalls.push({ orderId: order._id, amount, reason, type, openid, idempotencyKey, options })
    await f.db.collection('orders').doc(order._id).update({ data: { status: options.cancelStatus, paymentStatus: 'refunding', refundStatus: 'processing', refundAmount: amount } })
    return { refundNo: 'ref_' + order._id, status: 'processing' }
  }

  // A 和 B 均先付款，凑齐2户成功成团
  const first = await f.submit('a')
  const groupBuyId = first.order.groupBuyId
  const second = await f.submit('b', { groupBuyId })

  const orderA = f.db.state.orders.find(o => o._id === first.order._id)
  orderA.status = 'paid'
  orderA.paymentStatus = 'paid'
  await f.groups.onOrderPaid(first.order._id, groupBuyId)

  const orderB = f.db.state.orders.find(o => o._id === second.order._id)
  orderB.status = 'paid'
  orderB.paymentStatus = 'paid'
  await f.groups.onOrderPaid(second.order._id, groupBuyId)

  let groupDoc = await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.ok(groupDoc.data.formedAt > 0)
  assert.equal(groupDoc.data.status, 'formed')

  // 服务开始时间为 2026-10-21 10:00
  // 当时间推进到服务开始前 2 小时以内（例如 2026-10-21 08:30，距服务开始只有 1.5 小时）且无人接单
  const expireService = require('../../cloudfunctions/api/scheduled/expireOrders')({
    now: () => new Date('2026-10-21T08:30:00+08:00'),
    toTimeValue: (t) => new Date(t).getTime(),
    ORDER_STATUS: { PAID: 'paid', EXPIRED: 'expired' },
    safeText: (s) => s || '',
    createRefundForOrder: f.context.createRefundForOrder,
    makeIdempotencyKey: (prefix, id) => `${prefix}_${id}`,
    db: f.db,
    appendOrderTimeline: async () => {},
    appendOrderClientMessage: async () => {},
    restoreOrderCoupon: async () => {}
  })

  // 执行未接单过期处理
  await expireService.expireDueUnacceptedOrders()

  // 断言：拼单已自动取消
  groupDoc = await f.db.collection('pet_playground_groups').doc(groupBuyId).get()
  assert.equal(groupDoc.data.status, 'cancelled')
  assert.ok(groupDoc.data.cancelReason.includes('2小时'))

  // 断言：A 和 B 两个订单均已被自动发起全额原路退款
  assert.equal(refundCalls.length, 2)
  const freshA = f.db.state.orders.find(o => o._id === first.order._id)
  const freshB = f.db.state.orders.find(o => o._id === second.order._id)
  assert.equal(freshA.status, 'expired')
  assert.equal(freshA.groupBuyStatus, 'cancelled')
  assert.equal(freshB.status, 'expired')
  assert.equal(freshB.groupBuyStatus, 'cancelled')
})
