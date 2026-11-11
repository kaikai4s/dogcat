const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const time = require('../../cloudfunctions/api/utils/time')
const { freezeOrderSessionPricing, getOrderSessionPricing } = require('../../cloudfunctions/api/utils/orderSessionPricing')

function context() { return createContext({ db:createCollectionStore(), cloud:{} }) }

test('seconds and milliseconds survive parsing, duration arithmetic and multi-day expansion', () => {
  const c = context()
  const source = '2099-12-31 23:59:45.125'
  assert.equal(c.parseDateTimeParts(source).dateObj.toISOString(), '2099-12-31T15:59:45.125Z')
  assert.equal(c.addMinutesToDateTimeText(source,30), '2100-01-01 00:29:45.125')
  const sessions = c.buildOrderSessions({startTime:source,endTime:'2100-01-01 00:29:45.125',orderType:'multi_day',endDate:'2100-01-01',durationMinutes:30})
  assert.equal(sessions.length,2)
  for (const session of sessions) {
    assert.equal(time.toTimeValue(session.endTime)-time.toTimeValue(session.startTime),30*60000)
    assert.match(session.startTime,/23:59:45\.125$/)
  }
  assert.equal(time.toTimeValue(sessions[1].startTime)-time.toTimeValue(sessions[0].startTime),86400000)
})

test('shared and scheduling parsers reject impossible dates consistently', () => {
  const c = context()
  for (const source of ['2099-02-29 10:00','2099-04-31 10:00','2099-01-01 24:00','2099-01-01 10:00:60','2099-02-29T10:00:00Z']) {
    assert.equal(time.parseDateValue(source),null,source)
    assert.equal(time.toTimeValue(source),0,source)
    assert.equal(c.parseDateTimeParts(source),null,source)
  }
})

test('equivalent timestamp formats preserve frozen session amounts and refund allocation', () => {
  const sessions = [1,2].map(index=>({index,date:`2099-09-0${index}`,startTime:`2099-09-0${index} 10:00`}))
  const pricing = freezeOrderSessionPricing({amount:240,payAmount:120,sessions,priceSnapshot:{surchargeItems:[{type:'date_surcharge',dates:['2099-09-01'],price:40}]}})
  pricing.priceSnapshot.surchargeItems = [{type:'date_surcharge',dates:['2099-09-02'],price:40}]
  const iso = sessions.map(session=>({...session,startTime:time.parseDateValue(session.startTime).toISOString()}))
  assert.deepEqual(getOrderSessionPricing(pricing,iso).map(row=>row.payAmount),[70,50])
  const c = context()
  const original = c.normalizeServiceSessions({serviceSessions:[{index:1,date:'2099-12-31',startTime:'2099-12-31T16:30:00Z',endTime:'2099-12-31T17:30:00Z'}]})
  assert.equal(original[0].date,'2100-01-01')
})

test('a missed multi-day session remains the next task after Beijing midnight', () => {
  const c = context()
  const order = {serviceSessions:[
    {index:1,date:'2099-12-31',startTime:'2099-12-31 23:30',endTime:'2100-01-01 00:30',status:'pending'},
    {index:2,date:'2100-01-01',startTime:'2100-01-01 23:30',endTime:'2100-01-02 00:30',status:'pending'}
  ]}
  assert.equal(c.getNextPendingServiceSession(order,'2100-01-01 00:01').index,1)
  order.serviceSessions[0].status='completed'
  assert.equal(c.getNextPendingServiceSession(order,'2100-01-01 00:01').index,2)
})

test('legacy session pricing uses actual Beijing dates ahead of stale date labels', () => {
  const order = {amount:240,payAmount:120,serviceSessions:[
    {index:1,date:'2099-12-31',startTime:'2099-12-31T16:30:00Z',status:'completed'},
    {index:2,date:'2100-01-01',startTime:'2100-01-01T16:30:00Z',status:'pending'}
  ],priceSnapshot:{surchargeItems:[{type:'date_surcharge',dates:['2100-01-01'],price:40}]}}
  assert.deepEqual(getOrderSessionPricing(order).map(row=>row.payAmount),[70,50])
  assert.equal(context().getCancelQuoteForOrder({...order,status:'day_completed'}).refundAmount,50)
})

for (const TZ of ['UTC','Asia/Shanghai','America/Los_Angeles']) {
  test(`direct-order cancellation grace uses Beijing assignment time under ${TZ}`, () => {
    execFileSync(process.execPath,['-e',`
      const assert = require('node:assert/strict')
      const time = require('./cloudfunctions/api/utils/time')
      const scheduling = require('./cloudfunctions/api/services/schedulingTime')()
      for (const input of ['2027-01-01 00:30:45.321', '2027/01/01 00:30:45.321', '2026-12-31T16:30:45.321Z']) {
        const parts = scheduling.parseDateTimeParts(input)
        assert.equal(parts.dateObj.toISOString(), '2026-12-31T16:30:45.321Z')
        assert.equal(parts.second,45)
        assert.equal(parts.millisecond,321)
        assert.equal(scheduling.getDateKeyFromTime(input),'2027-01-01')
      }
      const context = require('./cloudfunctions/api/services/context')({db:require('./tests/cloudfunctions/helpers').createCollectionStore(),cloud:{}})
      for (const startTime of ['2099-12-31 23:59:45.125','2099-12-31T15:59:45.125Z']) {
        const sessions = context.buildOrderSessions({startTime,endTime:'2100-01-01 00:29:45.125',orderType:'multi_day',endDate:'2100-01-01',durationMinutes:30})
        assert.equal(sessions.length,2)
        assert.equal(sessions[1].startTime,'2100-01-01 23:59:45.125')
        assert.equal(sessions[1].endTime,'2100-01-02 00:29:45.125')
      }
      const c = require('./cloudfunctions/api/services/orderAccess')({...time,now:()=>new Date('2026-11-11T05:00:00Z')})
      const order = {status:'assigned',publishMode:'direct',payAmount:100,startTime:'2026-11-11 20:00',assignedAt:'2026-11-11 10:00'}
      assert.equal(c.getCancelQuoteForOrder(order).refundAmount,80)
      assert.equal(c.getCancelQuoteForOrder({...order,assignedAt:'2026-11-11 12:00'}).refundAmount,100)
      assert.equal(c.getCancelQuoteForOrder({...order,assignedAt:'2026-11-11 11:00'}).refundAmount,100)
      assert.equal(c.getCancelQuoteForOrder({...order,assignedAt:'2026-11-11 14:00'}).refundAmount,80)
    `],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,TZ},stdio:'pipe'})
  })
}

test('staff schedule changes validate the next-day part of overnight service', async () => {
  function setup(endTime='2100-01-01 00:30') {
    const user={_id:'staff',openid:'staff',roles:['staff'],status:'active'}
    const db=createCollectionStore({users:[user],staff_profiles:[{_id:'profile',openid:'staff',weeklySchedule:{'1':[{start:9,end:10}]}}],
      orders:[{_id:'overnight',staffOpenid:'staff',status:'assigned',startTime:'2099-12-31 23:30',endTime}],
      staff_schedule_exceptions:[{_id:'exception',staffOpenid:'staff',dateKey:'2100-01-01',status:'available',slots:[{start:0,end:1}]}]})
    return {user,c:createContext({db,cloud:{}})}
  }
  let f=setup()
  await assert.rejects(f.c.saveStaffScheduleException(f.user,{dateKey:'2100-01-01',status:'available',slots:[{start:8,end:18}]}),/已有待履约服务订单不在调整后的接单时段内/)
  f=setup()
  await assert.rejects(f.c.saveStaffScheduleException(f.user,{dateKey:'2100-01-01'},true),/常规周排班无法覆盖已有订单时段/)
  f=setup('2100-01-01 00:00')
  await assert.doesNotReject(f.c.saveStaffScheduleException(f.user,{dateKey:'2100-01-01',status:'unavailable',slots:[]}))
})

test('schedule slot ends include seconds when checking whether service fits', async () => {
  const c=context()
  const weekly=Object.fromEntries([1,2,3,4,5,6,7].map(day=>[String(day),[{start:9,end:10}]]))
  assert.throws(()=>c.validateSitterScheduleTime(weekly,'2100-01-01 09:30','2100-01-01 10:00:00.001'),/可接单时间段/)
  await assert.rejects(c.validateStaffScheduleOnly({openid:'staff',weeklySchedule:weekly},'2100-01-01 09:30','2100-01-01 10:00:01'),/可接单时间段/)
})
