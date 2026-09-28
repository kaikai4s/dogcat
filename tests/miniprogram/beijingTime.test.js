const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const format = require('../../miniprogram/utils/format')
const root = path.resolve(__dirname, '../../miniprogram')

function loadWxs() {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/beijing-time.wxs'), 'utf8'), {
    module, getDate: value => new Date(value), getRegExp: value => new RegExp(value)
  })
  return module.exports
}

test('UTC, explicit offsets, Beijing text and timestamps represent the same instant', () => {
  const timestamp = Date.parse('2026-09-24T18:40:33.000Z')
  const values = ['2026-09-24T18:40:33.000Z', '2026-09-25T02:40:33+08:00', '2026-09-24T11:40:33-07:00', '2026-09-25 02:40:33', timestamp, String(timestamp), String(timestamp / 1000)]
  const wxs = loadWxs()
  for (const value of values) {
    assert.equal(format.parseBeijingDate(value).getTime(), timestamp)
    assert.equal(format.formatDateTime(value), '09-25 02:40')
    assert.equal(wxs.format(value), '2026-09-25 02:40:33')
  }
  assert.equal(wxs.format('2026-09-24T18:40:33.749Z'), '2026-09-25 02:40:33')
  assert.equal(wxs.format('2026-09-25'), '2026-09-25')
  assert.equal(wxs.format(null), '')
  assert.equal(format.toBeijingDate('invalid'), null)
})

test('Beijing display is independent of the device timezone, including year rollover', () => {
  const script = `const f=require('./miniprogram/utils/format'); console.log(f.formatDateTime('2026-12-31T16:05:00Z')); console.log(f.parseBeijingDate('2027-01-01 00:05').toISOString())`
  for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
    assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: path.dirname(root), env: { ...process.env, TZ }, encoding: 'utf8' }).trim(), '01-01 00:05\n2026-12-31T16:05:00.000Z')
  }
})

test('appointments spanning midnight or multiple days show both dates', () => {
  assert.equal(format.formatAppointmentTime({ startTime: '2026-09-25 23:30', endTime: '2026-09-26 00:30' }), '09-25 23:30 至 09-26 00:30')
  assert.equal(format.formatAppointmentTime({ startTime: '2026-09-25 03:30', endTime: '2026-09-25 04:30' }), '09-25 03:30 至 04:30')
})

function loadBooking(clock = '2026-09-25T15:40:00Z', overrides = {}) {
  let page
  const module = { exports: {} }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return Date.parse(clock) }
  }
  const deps = { ...format, navMethods: () => ({}), createPageNav: () => ({}), loadSystemSettings: async () => ({}), ...overrides }
  const source = fs.readFileSync(path.join(root, 'pages/client/orders/create/index.js'), 'utf8')
  vm.runInNewContext(source + '\nmodule.exports = { buildDailySessions, getInitialServiceTime, parseDateTime };', {
    Date: Clock, Page(config) { page = config }, module, require: () => deps,
    wx: { redirectTo: opts => opts.success(), showToast() {} }
  })
  page.setData = function(updates, callback) {
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
    if (callback) callback.call(this)
  }
  return { page, ...module.exports }
}

test('default booking time advances both date and clock across Beijing midnight', () => {
  const { page, getInitialServiceTime } = loadBooking()
  assert.equal(getInitialServiceTime().startDate, '2026-09-26')
  assert.equal(getInitialServiceTime().startClock, '00:30')
  page.onLoad()
  assert.equal(page.data.form.startDate, '2026-09-26')
  assert.equal(page.data.form.endDate, '2026-09-26')
})

test('booking sessions and validation use real instants rather than shifted display dates', () => {
  const { page, buildDailySessions, parseDateTime } = loadBooking('2026-09-24T18:40:00Z')
  const sessions = buildDailySessions({ startDate: '2026-09-25', endDate: '2026-09-26', startClock: '03:30', durationMinutes: 60, orderType: 'multi_day' })
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].endTime, '2026-09-25 04:30')
  assert.equal(sessions[1].startTime, '2026-09-26 03:30')
  assert.equal(parseDateTime('2026-09-25 02:00').toISOString(), '2026-09-24T18:00:00.000Z')
  Object.assign(page.data, { user: { phone: '13800000000' }, petsLoaded: true, hasTimedServices: false })
  Object.assign(page.data.form, { petId: 'p1', serviceTypes: ['visit_fee', 'feed'], serviceAddress: '地址', addressDetail: '1栋', doorplate: '101', startDate: '2026-09-25', startClock: '02:00', startTime: '2026-09-25 02:00', endTime: '2026-09-25 03:00' })
  assert.equal(page.validateRequired(), '服务开始时间不能早于当前时间')
  Object.assign(page.data.form, { orderType: 'multi_day', endDate: '2026-10-26', startClock: '03:30', startTime: '2026-09-25 03:30' })
  assert.equal(page.validateRequired(), '连续服务最多支持31天')
})

test('retry after a lost create response reuses the request ID and freezes the submitted payload', async () => {
  const requests = []
  let ids = 0
  const { page } = loadBooking(undefined, {
    createClientRequestId: () => `req${++ids}`,
    requestSubscribeTemplates: async () => {},
    showError() {},
    callFunction: async (module, action, data) => {
      requests.push(data)
      if (requests.length === 1) throw new Error('network timeout')
      return { _id: 'order' }
    }
  })
  page.prepareTime = () => {}
  page.data.agreeAgreement = true
  page.validateRequired = () => ''
  page.buildOrderPayload = () => ({ petId: 'p1' })
  await page.create()
  assert.equal(page.data.creating, false)
  await page.create()
  assert.equal(requests.length, 2)
  assert.equal(requests[0].clientRequestId, requests[1].clientRequestId)
})

test('raw timestamp bindings use the shared formatter and all WXS imports resolve', () => {
  let count = 0
  for (const file of fs.readdirSync(path.join(root, 'pages'), { recursive: true }).filter(file => file.endsWith('.wxml'))) {
    const full = path.join(root, 'pages', file)
    const source = fs.readFileSync(full, 'utf8')
    for (const match of source.matchAll(/<wxs module="beijingTime" src="([^"]+)"/g)) {
      count++
      assert.ok(fs.existsSync(path.resolve(path.dirname(full), match[1])), file)
    }
    if (file.replaceAll('\\', '/') === 'client/points/index.wxml') continue // Already decorated in JS.
    for (const node of source.matchAll(/>([^<]*)</g)) {
      assert.doesNotMatch(node[1], /\{\{(?:[\w.]+\.)?(?:createdAt|paidAt|completedAt|availableAt|lastRequestedAt|validTo)\}\}/, file)
    }
  }
  assert.ok(count >= 24)
})

test('staff distance refresh preserves the server verdict for full schedule coverage', () => {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/staff/home/index.js'), 'utf8') + '\nmodule.exports = { applyOrderFlags };', {
    module, require: () => ({}), Page() {}
  })
  const orders = [
    { _id: 'overruns', startTime: '2099-08-03 17:30', endTime: '2099-08-03 18:30', distanceKm: 1, inTime: false },
    { _id: 'fits', startTime: '2099-08-03 17:00', endTime: '2099-08-03 18:00', distanceKm: 6, inTime: true }
  ]
  const results = module.exports.applyOrderFlags(orders, 5)
  assert.equal(results[0].inTime, false)
  assert.equal(results[0].inRange, true)
  assert.equal(results[1].inTime, true)
  assert.equal(results[1].inRange, false)
})
