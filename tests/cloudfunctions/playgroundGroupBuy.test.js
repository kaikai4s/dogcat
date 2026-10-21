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
  async function submit(who,extra={},request=who){
    const prepared=await groups.prepare(who,data(who,extra),pricing)
    return settlement.createOrderWithCouponLock({collectionName:'orders',openid:who,couponId:'',order:{clientOpenid:who,clientRequestId:request,amount:100,payAmount:100,priceSnapshot:pricing.priceSnapshot,serviceSessions:sessions,serviceSummary:'喂养',status:'pending_pay',paymentStatus:'unpaid'},prepareOrder:(tx,order,id)=>groups.attach(tx,order,id,prepared)})
  }
  return {db,context,groups,submit,data,pricing,advance:(ms)=>stamp+=ms}
}
test('group orders attach atomically, form by distinct households, freeze cent pricing and retain private member identities',async()=>{
  const f=fixture(),first=await f.submit('a'),id=first.order.groupBuyId
  assert.equal(first.order.groupBuyStatus,'recruiting')
  const guard=require('../../cloudfunctions/api/services/paymentDeadline')({toTimeValue:(t)=>new Date(t).getTime(),now:f.context.now})
  assert.throws(()=>guard.assertOrderPaymentOpen(first.order),/尚未成团/)
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
  assert.equal(first.data.groupBuyStatus,'recruiting')
  assert.equal(first.data.addressLatitude,community.latitude)
  const second=await apiB.main({module:'order',action:'createOrder',data:{...data,petIds:['p_b'],addressDetail:'2栋',groupBuyId:first.data.groupBuyId,clientRequestId:'join-group'}})
  assert.equal(second.ok,true,second.message)
  assert.equal(second.data.groupBuyStatus,'formed')
  assert.ok(second.data.payAmount<second.data.amount)
  const listing=await apiA.main({module:'playground',action:'listCommunityGroupBuys',data:{}})
  assert.equal(listing.ok,true,listing.message)
  assert.equal(listing.data.myGroups[0].householdCount,2)
})

test('payment-expired members stop counting immediately while cancelled own orders remain discoverable',async()=>{
  const f=fixture(),first=await f.submit('a'),id=first.order.groupBuyId
  await f.submit('b',{groupBuyId:id})
  f.advance(31*60000)
  let listing=await f.groups.list('a')
  assert.equal(listing.groups[0].householdCount,0)
  assert.equal(listing.myGroups[0].paymentExpired,true)
  assert.equal(listing.myGroups[0].mine,false)
  f.db.state.orders[0].status='cancelled'
  await f.submit('c',{groupBuyId:id})
  listing=await f.groups.list('a')
  assert.equal(listing.groups[0].householdCount,1)
  assert.equal(listing.myGroups[0].orderId,first.order._id)
  assert.equal(listing.myGroups[0].orderStatus,'cancelled')
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
  assert.equal(second.order.groupBuyStatus,'formed')

  // 获取 cancelQuote 验证 canCancel 必须为 false
  const orderAccess=require('../../cloudfunctions/api/services/orderAccess')({
    now:f.context.now,
    toTimeValue:(t)=>new Date(t).getTime(),
    getSystemSettings:async()=>({})
  })
  const quote=orderAccess.getCancelQuoteForOrder(second.order)
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
    createRefundForOrder:async(order,amount,reason)=>({refundNo:'ref_123',amount}),
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
  const expired=await expireService.expireUnacceptedOrder('ord_group',groupOrder,time1_9hBefore)
  assert.equal(expired.status,'expired')
  assert.equal(expired.paymentStatus,'refunding')
  assert.ok(expired.expireReason.includes('2小时'))

  const g1Doc=await f.db.collection('pet_playground_groups').doc('g1').get()
  assert.equal(g1Doc.data.status,'cancelled')
})
