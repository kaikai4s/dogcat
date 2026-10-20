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
