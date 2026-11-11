const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../..')

for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
  test(`calendar, schedule, settings and message clocks use Beijing under ${TZ}`, () => {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      const fs = require('node:fs'), vm = require('node:vm')
      const RealDate = Date
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-12-31T16:30:00Z'])) }
        static now() { return RealDate.parse('2026-12-31T16:30:00Z') }
      }
      const format = require('./miniprogram/utils/format')
      assert.equal(format.formatBeijingDate(), '2027-01-01')
      assert.equal(format.formatBeijingClock(), '00:30')
      for (const input of ['2027-01-01 00:30:00.321', '2027/01/01 00:30:00.321']) {
        assert.equal(format.parseBeijingDate(input).toISOString(), '2026-12-31T16:30:00.321Z')
      }
      for (const input of ['2027-02-29 10:00','2027-04-31 10:00','2027-01-01 24:00','2027-01-01 10:00:60','2027-02-29T10:00:00Z']) {
        assert.equal(format.parseBeijingDate(input),null,input)
      }
      function load(file, exports = '') {
        let page
        const toasts = []
        const module = { exports:{} }
        const deps = { ...require('./miniprogram/utils/subscription-options'), ...require('./miniprogram/pages/admin/settings/payment-config'), ...format, createPageNav:()=>({}), navMethods:()=>({}), sessionChatMethods:()=>({}), loadSystemSettings:async()=>({}) }
        vm.runInNewContext(fs.readFileSync('./miniprogram/'+file,'utf8') + exports, {
          Date, module, Page:p=>page=p, require:()=>deps, wx:{showToast:options=>toasts.push(options)}, console, setTimeout:()=>0, clearTimeout:()=>{}, setInterval:()=>1, clearInterval:()=>{}
        })
        page.setData = function(patch, callback) { Object.assign(this.data,patch); if (callback) callback.call(this) }
        return {page,toasts,...module.exports}
      }
      const booking = load('pages/client/orders/create/index.js')
      assert.equal(booking.page.data.calendarYear,2027)
      assert.equal(booking.page.data.calendarMonth,1)
      booking.page.refreshCalendarUI()
      assert.equal(booking.page.data.canPrevMonth,false)
      const schedule = load('pages/staff/schedule/index.js',';module.exports={formatTodayDate}')
      assert.equal(schedule.formatTodayDate(),'2027-01-01')
      assert.equal(load('pages/admin/settings/index.js').page.data.todayDate,'2027-01-01')
      const service = load('pages/staff/orders/service/index.js',';module.exports={toTimeValue,withServiceActionState}')
      for (const input of ['2027-01-01 00:30:00.321','2027/01/01 00:30:00.321','2026-12-31T16:30:00.321Z']) {
        assert.equal(service.toTimeValue(input),RealDate.parse('2026-12-31T16:30:00.321Z'))
      }
      assert.equal(service.toTimeValue('2027-02-29 10:00'),0)
      service.page.startServiceElapsedTimer({currentSessionStartedAt:'2027-01-01 00:29:00.000'})
      assert.equal(service.page.data.serviceElapsedText,'00:01:00')
      const action = service.withServiceActionState({status:'assigned',startTime:'2027-01-01 00:31:00.001'})
      assert.equal(action.canRequestEarlyStart,true)
      assert.equal(action.isStartOverdue,false)
      const adminOrder = load('pages/admin/orders/detail/index.js',';module.exports={parseBeijingDate,decorateTimeline,computeInitialUrgentTime}')
      for (const input of ['2027-01-01 00:30:00.321','2027/01/01 00:30:00.321','2026-12-31T16:30:00.321Z']) {
        assert.equal(adminOrder.parseBeijingDate(input).getTime(),RealDate.parse('2026-12-31T16:30:00.321Z'))
      }
      assert.equal(adminOrder.parseBeijingDate('2027-02-29 10:00'),null)
      const timeline = adminOrder.decorateTimeline([
        {_id:'first',createdAt:'2027-01-01 00:30:00.001'},
        {_id:'second',createdAt:'2026-12-31T16:31:00Z'}
      ])
      assert.equal(timeline[0]._id,'first')
      assert.equal(timeline[1]._id,'second')
      const urgent = adminOrder.computeInitialUrgentTime({startTime:'2027-01-01 01:30:00.321'})
      assert.equal(urgent.startTime,'2027-01-01 01:30')
      assert.equal(urgent.endTime,'2027-01-01 02:30')
      const multiUrgent = adminOrder.computeInitialUrgentTime({startTime:'2026-12-31T17:30:00Z',endTime:'2027-01-02T18:30:00Z',serviceSessions:[
        {startTime:'2026-12-31T17:30:00Z',endTime:'2026-12-31T18:30:00Z'}
      ]})
      assert.equal(multiUrgent.startTime,'2027-01-01 01:30')
      assert.equal(multiUrgent.endTime,'2027-01-01 02:30')
      adminOrder.page.data.detail={order:{status:'assigned',groupBuyId:'group'}}
      adminOrder.page.openUrgentModal()
      assert.equal(adminOrder.page.data.showUrgentModal,false)
      assert.match(adminOrder.toasts.at(-1).title,/整团/)
      adminOrder.page.data.detail={order:{status:'day_completed',lastCompletedSessionIndex:1}}
      adminOrder.page.openUrgentModal()
      assert.equal(adminOrder.page.data.showUrgentModal,false)
      assert.match(adminOrder.toasts.at(-1).title,/履约/)
      adminOrder.page.data.detail={order:{status:'paid',startTime:'2026-12-31T17:30:00Z',endTime:'2027-01-02T18:30:00Z',serviceSessions:[
        {startTime:'2026-12-31T17:30:00Z',endTime:'2026-12-31T18:30:00Z',status:'pending'}
      ]}}
      adminOrder.page.openUrgentModal()
      assert.equal(adminOrder.page.data.urgentStartDate,'2027-01-01')
      assert.equal(adminOrder.page.data.urgentStartTimeClock,'01:30')
      assert.equal(adminOrder.page.data.urgentEndDate,'2027-01-01')
      assert.equal(adminOrder.page.data.urgentEndTimeClock,'02:30')
      adminOrder.page.data.urgentEndTimeInput='invalid'
      adminOrder.page.submitUrgentRepublish()
      assert.match(adminOrder.toasts.at(-1).title,/结束时间格式/)
      const home = load('pages/client/home/index.js',';module.exports={getTodayDateString}')
      assert.equal(home.getTodayDateString(),'2027-01-01')
      assert.equal(load('pages/client/pet-beauty/activity/index.js').page.data.pageTitle,'1月宠物最美大赛')
      const world = load('packagePlayground/pages/world.js').page
      world.pushStatusMessage('跨年消息')
      assert.equal(world.data.messageHistory[0].time,'00:30')
    `], { cwd:root, env:{...process.env,TZ}, stdio:'pipe' })
  })
}

test('registration and audit views format the same instant as Beijing time', () => {
  const module = { exports:{} }
  vm.runInNewContext(fs.readFileSync(path.join(root,'miniprogram/utils/beijing-time.wxs'),'utf8'), {
    module, getDate:value=>new Date(value), getRegExp:value=>new RegExp(value)
  })
  for (const input of ['2026-11-11T02:00:00.000Z','2026-11-11 10:00:00.123','2026/11/11 10:00:00']) {
    assert.equal(module.exports.format(input),'2026-11-11 10:00:00')
  }
  for (const [file,expression] of [
    ['users/list','item.createdAtText'],['users/edit','user.createdAt'],
    ['pets/list','item.createdAt'],['questionnaires/analysis','report.updatedAt || report.generatedAt']
  ]) {
    const source = fs.readFileSync(path.join(root,`miniprogram/pages/admin/${file}/index.wxml`),'utf8')
    assert.ok(source.includes('src="../../../../utils/beijing-time.wxs"'))
    assert.ok(source.includes(`beijingTime.format(${expression})`))
  }
})

test('key return, next visit, map appointment and pet moderation times use the Beijing display formatter', () => {
  for (const [file, expression] of [
    ['client/orders/detail', 'order.orderHomeSecurity.key.returnedAt'],
    ['staff/orders/service', 'order.nextSession.startTime'],
    ['common/community-map', 'item.startTime'],
    ['admin/pets/list', 'item.disqualifiedAt']
  ]) {
    const source = fs.readFileSync(path.join(root, `miniprogram/pages/${file}/index.wxml`), 'utf8')
    assert.ok(source.includes(`beijingTime.format(${expression})`), file)
  }
})

for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
  test(`order message lists preserve Beijing chronological order across mixed timestamp formats under ${TZ}`, () => {
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      const fs = require('node:fs'), vm = require('node:vm')
      const format = require('./miniprogram/utils/format')
      for (const role of ['client','staff']) {
        const module = {exports:{}}
        vm.runInNewContext(fs.readFileSync('./miniprogram/pages/'+role+'/messages/index.js','utf8')+';module.exports={sortThreads}', {
          module, Page:()=>{}, wx:{}, require:name=>name.endsWith('/format') ? format : {}
        })
        const rows = [
          {_id:'earlier',lastMessageAt:'2026-11-12 00:05:00'},
          {_id:'later',lastMessageAt:'2026-11-11T16:10:00Z'},
          {_id:'unread',lastMessageAt:'2026-11-11T15:00:00Z',unreadCount:1},
          {_id:'invalid',lastMessageAt:'invalid'}
        ]
        const sorted = module.exports.sortThreads(rows)
        assert.equal(sorted.map(row=>row._id).join(','),'unread,later,earlier,invalid',role)
        assert.equal(rows.map(row=>row._id).join(','),'earlier,later,unread,invalid',role)
      }
    `], { cwd:root, env:{...process.env,TZ}, stdio:'pipe' })
  })
}
