const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const { freezeOrderSessionPricing, getOrderSessionPricing } = require('../../cloudfunctions/api/utils/orderSessionPricing')

function fixture(patch = {}) {
  const sessions = [1,2,3].map(index=>({index,date:`2099-09-0${index}`,startTime:`2099-09-0${index} 10:00`,endTime:`2099-09-0${index} 11:00`,status:'pending'}))
  const pricing = freezeOrderSessionPricing({amount:340,payAmount:340,sessions,priceSnapshot:{
    surchargeItems:[{type:'date_surcharge',dates:['2099-09-01'],price:40}]
  }})
  const db = createCollectionStore({users:[{_id:'admin',openid:'admin',roles:['admin'],status:'active'}],orders:[{
    ...pricing,_id:'order',orderNo:'URGENT',clientOpenid:'client',status:'paid',paymentStatus:'paid',publishMode:'open',
    serviceType:'feed',serviceSummary:'喂养',orderType:'multi_day',durationMinutes:60,
    serviceSessions:sessions,sessionCount:3,startTime:sessions[0].startTime,endTime:sessions[2].endTime,
    serviceStartDate:sessions[0].date,serviceEndDate:sessions[2].date,...patch
  }]})
  const api = loadCloudFunction('api',db,'admin')
  return {db,republish:(extra={})=>api.main({module:'admin',action:'republishOrderAsUrgent',data:{orderId:'order',staffReward:250,
    startTime:'2099-09-02 08:00',endTime:'2099-09-02 09:00',...extra}})}
}

test('urgent rescheduling keeps multi-day final boundaries and original session prices', async()=>{
  const f=fixture()
  const result=await f.republish()
  assert.equal(result.ok,true,result.message)
  const order=f.db.state.orders[0]
  assert.equal(order.serviceSessions[0].endTime,'2099-09-02 09:00')
  assert.equal(order.endTime,'2099-09-03 11:00')
  assert.equal(order.serviceEndDate,'2099-09-03')
  assert.equal(order.payAmount,340)
  assert.deepEqual(getOrderSessionPricing(order).map(row=>row.payAmount),[140,100,100])
})

test('urgent rescheduling without an end preserves one visit duration instead of the entire multi-day span', async()=>{
  const f=fixture()
  const result=await f.republish({endTime:''})
  assert.equal(result.ok,true,result.message)
  assert.equal(f.db.state.orders[0].serviceSessions[0].endTime,'2099-09-02 09:00')
})

test('urgent rescheduling rejects an invalid end without mutating the order', async()=>{
  const f=fixture(),before=structuredClone(f.db.state.orders[0])
  const result=await f.republish({endTime:'not-a-date'})
  assert.equal(result.ok,false)
  assert.match(result.message,/结束时间.*格式/)
  assert.deepEqual(f.db.state.orders[0],before)
})

test('urgent rescheduling cannot move the first visit past a later pending visit', async()=>{
  const f=fixture(),before=structuredClone(f.db.state.orders[0])
  const result=await f.republish({startTime:'2099-09-02 12:00',endTime:'2099-09-02 13:00'})
  assert.equal(result.ok,false)
  assert.match(result.message,/后续.*场次|顺序|重叠/)
  assert.deepEqual(f.db.state.orders[0],before)
})

test('urgent rescheduling cannot clear the worker of a partially fulfilled multi-day order', async()=>{
  const f=fixture({status:'day_completed',staffOpenid:'staff',lastCompletedSessionIndex:1})
  f.db.state.orders[0].serviceSessions[0].status='completed'
  const before=structuredClone(f.db.state.orders[0])
  const result=await f.republish()
  assert.equal(result.ok,false)
  assert.match(result.message,/场次.*完成|已经履约|已履约/)
  assert.deepEqual(f.db.state.orders[0],before)
})

test('one household cannot be rescheduled out of an assigned group through the single-order urgent action', async()=>{
  const f=fixture({status:'assigned',staffOpenid:'staff',groupBuyId:'group',groupBuyStatus:'formed'})
  const before=structuredClone(f.db.state.orders[0])
  const result=await f.republish()
  assert.equal(result.ok,false)
  assert.match(result.message,/拼单.*整团|整团.*拼单/)
  assert.deepEqual(f.db.state.orders[0],before)
})

test('urgent rescheduling rejects non-finite reward amounts', async()=>{
  const f=fixture(),before=structuredClone(f.db.state.orders[0])
  const result=await f.republish({staffReward:Infinity})
  assert.equal(result.ok,false)
  assert.match(result.message,/收益金额/)
  assert.deepEqual(f.db.state.orders[0],before)
})

test('urgent rescheduling detects a concurrent worker change even when status stays assigned', async()=>{
  const f=fixture({status:'assigned',staffOpenid:'first-staff'})
  const runTransaction=f.db.runTransaction.bind(f.db)
  f.db.runTransaction=async callback=>{
    f.db.state.orders[0]={...f.db.state.orders[0],staffOpenid:'new-staff'}
    return runTransaction(callback)
  }
  const result=await f.republish()
  assert.equal(result.ok,false)
  assert.match(result.message,/并发更新|状态/)
  assert.equal(f.db.state.orders[0].staffOpenid,'new-staff')
  assert.equal(f.db.state.orders[0].status,'assigned')
  assert.equal(f.db.state.orders[0].isUrgent,undefined)
})
