const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { decorateGroup } = require('../../miniprogram/pages/client/orders/utils/community-group-buy')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function pageAt(file, deps = {}) {
  let page, timerId = 0
  const timers = new Map(), calls = []
  const common = { startStaffEntryUnread() {}, stopStaffEntryUnread() {}, ...require('../../miniprogram/utils/format'), navMethods: () => ({}), createPageNav: () => ({}), showError: error => { throw error }, ...deps }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../miniprogram',file),'utf8'), {
    Page: config => { page = config },
    require: name => name.endsWith('/community-group-buy') ? require(path.resolve(__dirname,'../../miniprogram',path.dirname(file),name)) : common,
    wx: { showToast() {}, stopPullDownRefresh() {}, getStorageSync() {}, navigateTo: value => calls.push(value) },
    setTimeout: callback => { timers.set(++timerId,callback); return timerId }, clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {}, console
  })
  page.setData = function(patch, callback) { Object.assign(this.data,patch); if(callback)callback.call(this) }
  return {page,timers,calls}
}

test('group dates use Beijing time for both ISO and local strings, and expired orders cannot offer payment', () => {
  const base={minHouseholds:3,householdCount:2,status:'formed',orderStatus:'pending_pay',payAmount:70.4,paymentDeadline:Date.parse('2026-10-20T01:30:00Z'),serviceSessions:[]}
  const iso=decorateGroup({...base,startTime:'2026-10-20T01:00:00Z'})
  const local=decorateGroup({...base,startTime:'2026-10-20 09:00'})
  assert.equal(iso.timeText,'10-20 09:00')
  assert.equal(iso.timeText,local.timeText)
  assert.equal(iso.priceText,'70.40')
  assert.equal(iso.canPay,true)
  assert.equal(decorateGroup({...base,paymentExpired:true}).canPay,false)
  assert.equal(decorateGroup({...base,orderStatus:'cancelled'}).ownStatusText,'已取消')
})

test('home waits for login, skips group requests for guests and invalidates an account switch', async () => {
  const login=deferred(), result=deferred(), actions=[]
  let user=null
  const {page,timers}=pageAt('pages/client/home/index.js',{getCurrentUser:()=>login.promise,callFunction:(_,action)=>{actions.push(action);return result.promise}})
  page._isPageActive=true
  const guest=page.loadCommunityGroups()
  assert.equal(actions.length,0)
  login.resolve(null);await guest
  assert.equal(actions.length,0);assert.equal(timers.size,0)

  const logged=pageAt('pages/client/home/index.js',{getCurrentUser:async()=>user,callFunction:()=>result.promise})
  logged.page._isPageActive=true;user={openid:'a'}
  const pending=logged.page.loadCommunityGroups()
  await new Promise(setImmediate)
  user={openid:'b'};result.resolve({communityName:'A小区',groups:[],myGroups:[]});await pending
  assert.equal(logged.page.data.communityGroupNotice,null)
  logged.page.stopAllVideos=()=>{};logged.page.clearLotteryFloatTimer=()=>{};logged.page.stopHotServicesAutoScroll=()=>{}
  logged.page.onUnload()
  assert.equal(logged.timers.size,0)
})

test('late price quotes cannot overwrite newer choices and group footer uses the discounted estimate', async () => {
  const requests=[]
  const {page}=pageAt('pages/client/orders/create/index.js',{callFunction:()=>{const next=deferred();requests.push(next);return next.promise}})
  page.prepareTime=()=>{};page.canAutoQuote=()=>true;page.buildOrderPayload=()=>({})
  const old=page.calculatePrice(), latest=page.calculatePrice()
  requests[1].resolve({amount:100,payAmount:100,groupBuy:{estimatedPayAmount:70.4,estimatedDiscountAmount:29.6}})
  await latest
  requests[0].resolve({amount:200,payAmount:200})
  await old
  assert.equal(page.data.quote.amount,100)
  assert.equal(page.data.quoteDisplayAmount,'70.40')
  assert.equal(page.data.quoteDisplayDiscount,'29.60')
  assert.equal(page.data.displayPriceDigits.map(d=>d.isDigit?d.val:d.char).join(''),'70.40')
})

test('group page ignores an old response arriving after a newer refresh', async () => {
  const requests=[]
  const {page}=pageAt('pages/client/orders/group-buy/index.js',{ensureLogin:async()=>({}),callFunction:()=>{const next=deferred();requests.push(next);return next.promise}})
  const first=page.load();await new Promise(setImmediate)
  const latest=page.load();await new Promise(setImmediate)
  requests[1].resolve({communityName:'新小区',groups:[],myGroups:[],rules:{discountRate:.88}})
  await latest
  requests[0].resolve({communityName:'旧小区',groups:[],myGroups:[],rules:{discountRate:.5}})
  await first
  assert.equal(page.data.communityName,'新小区')
  assert.equal(page.data.loading,false)
})
