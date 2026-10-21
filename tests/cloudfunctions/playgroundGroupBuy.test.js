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
    startTime: '2026-10-21 14:00',
    endTime: '2026-10-21 14:30',
    serviceStartDate: '2026-10-21',
    serviceEndDate: '2026-10-21',
    serviceSessions: [{ date: '2026-10-21', startTime: '2026-10-21 14:00', endTime: '2026-10-21 14:30' }],
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
    startTime: '2026-10-21 14:30',
    endTime: '2026-10-21 15:00',
    serviceStartDate: '2026-10-21',
    serviceEndDate: '2026-10-21',
    serviceSessions: [{ date: '2026-10-21', startTime: '2026-10-21 14:30', endTime: '2026-10-21 15:00' }],
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
  await db.collection('orders').doc('ord_agg_1').update({ data: { status: 'in_service', currentSessionStartedAt: '2026-10-21 14:00' } })
  await db.collection('orders').doc('ord_agg_2').update({ data: { status: 'in_service', currentSessionStartedAt: '2026-10-21 14:30' } })
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
    serviceStartDate: '2026-10-21',
    serviceEndDate: '2026-10-21',
    serviceSessions: [{ date: '2026-10-21', startTime, endTime }],
    serviceTypes: ['feed'],
    serviceAddress: community.name,
    doorplate,
    addressLatitude: 31.2,
    addressLongitude: 121.5,
    payAmount: 50,
    staffOpenid: ''
  })

  const o1 = makeOrder('ord_3h_1', 'client_1', '橘猫大橘', '1号楼101', '2026-10-21 16:00', '2026-10-21 16:30')
  const o2 = makeOrder('ord_3h_2', 'client_2', '白猫雪球', '2号楼202', '2026-10-21 16:30', '2026-10-21 17:00')
  const o3 = makeOrder('ord_3h_3', 'client_3', '柴犬阿黄', '3号楼303', '2026-10-21 17:00', '2026-10-21 17:30')

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
