const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { createCollectionStore } = require('./helpers')
const time = require('../../cloudfunctions/api/utils/time')
const { userAssetExpiryDate } = require('../../cloudfunctions/api/utils/userAssetExpiry')

for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
  test(`business dates, financial boundaries, vaccines and commission expiry use Beijing under ${TZ}`, () => {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      const time = require('./cloudfunctions/api/utils/time')
      const fixed = new Date('2026-12-31T16:30:00Z')
      assert.equal(time.toCstParts(fixed).dateKey, '2027-01-01')
      for (const value of ['2027-01-01 00:30:00', '2027/01/01 00:30:00', '2027-01-01T00:30:00.000', '2027-01-01T00:30:00+08:00', fixed]) {
        assert.equal(time.parseDateValue(value).getTime(), fixed.getTime())
        assert.equal(time.beijingClockText(value), '00:30')
        assert.equal(time.toCstParts(value).dateKey, '2027-01-01')
      }
      assert.equal(time.parseDateValue('invalid'), null)
      assert.equal(time.parseDateValue(null), null)
      assert.equal(time.parseDateValue(0).getTime(), 0)
      const report = require('./cloudfunctions/api/services/financeReports')({ ...time, safeText: value => String(value || '') })
      const range = report.buildDateRange({ startDate: '2027-01-01', endDate: '2027-01-01' })
      assert.equal(range.start.toISOString(), '2026-12-31T16:00:00.000Z')
      assert.equal(range.end.toISOString(), '2027-01-01T15:59:59.999Z')
      for (const [createdAt, expected] of [
        ['2026-12-31T15:59:59.999Z', false], ['2026-12-31T16:00:00Z', true],
        ['2027-01-01 23:59:59.999', true], ['2027-01-01T16:00:00Z', false]
      ]) assert.equal(report.inDateRange({ createdAt }, range), expected)
      const vaccines = require('./cloudfunctions/api/services/petVaccines')({ safeText: v=>String(v||''), nowText: ()=>fixed.toISOString() })
      assert.equal(vaccines.normalizePetVaccineCertification({ status:'approved', validUntil:'2026-12-31' }).status, 'expired')
      assert.equal(vaccines.normalizePetVaccineCertification({ status:'approved', validUntil:'2027-01-01' }).status, 'approved')
      const beauty = require('./cloudfunctions/api/services/petBeauty')({ normalizeMonthKey: v=>v })
      assert.equal(beauty.currentMonthStart('2026-12').toISOString(), '2026-11-30T16:00:00.000Z')
      assert.equal(beauty.nextMonthStart('2026-12').toISOString(), '2026-12-31T16:00:00.000Z')
      const scheduling = require('./cloudfunctions/api/services/schedulingTime')({})
      const sessions = require('./cloudfunctions/api/services/orderSessions')({ ...time, ...scheduling, safeText:v=>String(v||'') })
      const multi = sessions.buildOrderSessions({ orderType:'multi_day', startTime:'2099-12-31T16:30:00Z', endTime:'2099-12-31T17:30:00Z', endDate:'2100-01-02' })
      assert.deepEqual(multi.map(s=>s.date), ['2100-01-01','2100-01-02'])
      assert.equal(multi[0].startTime, '2100-01-01 00:30')
      assert.equal(sessions.normalizeServiceSessions({startTime:'2099-12-31T16:30:00Z',endTime:'2099-12-31T17:30:00Z'})[0].date, '2100-01-01')
      const assets = require('./cloudfunctions/api/services/userAssets')({ now: ()=>fixed })
      const earning = { status:'available', sourceType:'invite_binding', createdAt:'2026-12-01T17:00:00Z', validityDays:30, expiresAt:'2026-12-31 17:00:00' }
      assert.equal(assets.isEarningExpired(earning), false)
      assert.equal(assets.isEarningExpired(earning, new Date('2026-12-31T17:00:00Z')), true)
      assert.equal(assets.isEarningExpired({ ...earning, expiresAt:'2027-01-01 00:00:00' }), true)
      assert.equal(assets.isEarningExpired({ ...earning, expiresAt:'2026-12-31T17:00:00Z' }), false)
      const coupons = require('./cloudfunctions/api/services/coupons')({ now: ()=>fixed })
      assert.equal(coupons.couponDisplayStatus({status:'available',validTo:'2027-01-01 01:00:00'}), 'available')
      assert.equal(coupons.couponDisplayStatus({status:'available',validTo:'2027-01-01 00:00:00'}), 'expired')
    `], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, TZ }, stdio: 'pipe' })
  })
}

test('legacy UTC commission text is recognized only when it matches the original generator', () => {
  const earning = { sourceType:'invite_binding', createdAt:'2026-11-01T17:03:04.321Z', validityDays:30, expiresAt:'2026-12-01 17:03:04' }
  assert.equal(userAssetExpiryDate(earning).toISOString(), '2026-12-01T17:03:04.321Z')
  assert.equal(userAssetExpiryDate({...earning, expiresAt:'2026-12-02 01:03:04'}).toISOString(), '2026-12-01T17:03:04.000Z')
  assert.equal(userAssetExpiryDate({...earning, sourceType:'admin_manual_grant'}).toISOString(), '2026-12-01T09:03:04.000Z')
})

test('admin commission and coupon statuses agree with actual Beijing expiration', async () => {
  const fixed = new Date('2026-12-31T16:30:00Z')
  const db = createCollectionStore({ users:[{_id:'user',openid:'client'}],
    user_coupons:[{_id:'coupon',openid:'client',status:'available',validTo:'2027-01-01 01:00:00'}],
    user_asset_earnings:[
      {_id:'legacy',userOpenid:'client',amount:5,status:'available',sourceType:'invite_binding',createdAt:'2026-12-01T17:00:00Z',validityDays:30,expiresAt:'2026-12-31 17:00:00'},
      {_id:'expired',userOpenid:'client',amount:3,status:'available',expiresAt:'2027-01-01 00:00:00'}
    ] })
  const handler = require('../../cloudfunctions/api/handlers/admin')({db,...time,now:()=>fixed,
    safeText:v=>String(v||''), requireAdmin:async()=>({openid:'admin'}), assertAdminPermission:()=>{} })
  const result = await handler('admin','getUserRelatedDetails',{openid:'client'})
  assert.equal(result.coupons[0].status,'available')
  assert.equal(result.commission.earnings.find(r=>r._id==='legacy').status,'available')
  assert.equal(result.commission.earnings.find(r=>r._id==='expired').status,'expired')
  assert.equal(result.commission.earnings.find(r=>r._id==='legacy').expiresAt.toISOString(),'2026-12-31T17:00:00.000Z')
})

test('UTC order starts receive Beijing holiday and night surcharges with exact session prices', async () => {
  const db = createCollectionStore({ service_prices:[{key:'visit_fee',label:'上门基础服务',price:30,extraPetRule:'none'},{key:'feed',label:'喂食',price:10,extraPetRule:'none'}] })
  const context = require('../../cloudfunctions/api/services/context')({ db, cloud:{} })
  const service = require('../../cloudfunctions/api/services/pricing')({...context,getSystemSettings:async()=>({pricingSurcharges:{
    enabled:true,dateSurcharges:[{date:'2100-01-01',name:'元旦',surcharge:20}],
    timeSlotSurcharges:[{id:'night',name:'凌晨',startTime:'00:00',endTime:'06:00',surcharge:10}]
  }})})
  const pets=[{_id:'pet',name:'猫咪',species:'cat'}]
  const iso = await service.calcOrderPricing({serviceTypes:['visit_fee','feed'],startTime:'2099-12-31T16:30:00Z',endTime:'2099-12-31T17:30:00Z'},pets)
  const local = await service.calcOrderPricing({serviceTypes:['visit_fee','feed'],startTime:'2100-01-01 00:30',endTime:'2100-01-01 01:30'},pets)
  assert.equal(iso.amount,70)
  assert.equal(iso.amount,local.amount)
  assert.equal(iso.sessions[0].date,'2100-01-01')
  assert.equal(iso.priceSnapshot.sessionPricing[0].payAmount,70)
  const {getOrderSessionPricing} = require('../../cloudfunctions/api/utils/orderSessionPricing')
  const allocated = getOrderSessionPricing({amount:90,payAmount:90,sessions:[
    {index:1,startTime:'2099-12-31T16:30:00Z'}, {index:2,startTime:'2100-01-01T04:30:00Z'}
  ],priceSnapshot:{surchargeItems:[{type:'date_surcharge',dates:['2100-01-01'],price:20},
    {type:'time_surcharge',timeRule:{startTime:'00:00',endTime:'06:00'},price:10}]}})
  assert.deepEqual(allocated.map(s=>s.amount),[50,40])
})

test('AI daily pet voice cache changes at Beijing midnight', async () => {
  const db = createCollectionStore()
  let clock = '2026-12-31T15:59:59Z'
  const handler = require('../../cloudfunctions/api/handlers/ai')({ db,cloud:{}, safeText:v=>String(v||''),
    nowText:()=>clock,getUser:async()=>({}),checkRateLimit:async()=>{} })
  await handler('owner','generatePetVoice',{pet:{name:'猫咪'}})
  clock = '2026-12-31T16:00:00Z'
  await handler('owner','generatePetVoice',{pet:{name:'猫咪'}})
  const ids = db.state.pet_voice_daily_cache.map(row=>row._id)
  assert.equal(ids.length,2)
  assert.ok(ids.some(id=>id.endsWith('2026-12-31')))
  assert.ok(ids.some(id=>id.endsWith('2027-01-01')))
})
