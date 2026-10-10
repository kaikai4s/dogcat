const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))
const templateKeys = ['orderAccepted', 'staffDeparture', 'serviceStart', 'serviceProgress', 'serviceFinish', 'orderPaid', 'orderAssigned', 'remoteUnlock', 'refundResult', 'disputeUpdate', 'upcomingServiceReminder', 'withdrawResult']

async function setup({ templates = Object.fromEntries(templateKeys.map(key => [key, `tpl_${key}`])), enabled = true, mainSwitch = true, role = 'client', subscribe, holdConsent = false } = {}) {
  const requests = []
  const calls = []
  const settingsCalls = []
  const errors = []
  const storage = {}
  const settings = { subscription: { enabled, templates } }
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
    showToast: value => errors.push(value), showModal: value => errors.push(value),
    getSetting: options => options.success({ subscriptionsSetting: { mainSwitch, itemsSetting: {} } }),
    openSetting: options => { settingsCalls.push(options); options.success({ subscriptionsSetting: { mainSwitch: true, itemsSetting: {} } }) },
    requestSubscribeMessage(options) {
      requests.push(options.tmplIds)
      if (subscribe) subscribe(options)
      else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
    },
    cloud: { callFunction(options) {
      calls.push(options.data)
      if (options.data.action === 'recordSubscriptionConsent' && holdConsent) return new Promise(() => {})
      return Promise.resolve({ result: { ok: true, data: options.data.action === 'getSettings' ? settings : {} } })
    } }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/cloud.js'), 'utf8'), {
    module, wx, setTimeout, clearTimeout,
    getApp: () => ({ globalData: { env: 'test', user: { _id: 'user' } } }),
    require: () => ({ envList: [] })
  })
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/common/subscriptions/index.js'), 'utf8'), {
    Page(config) { page = config }, require: () => module.exports, wx
  })
  page.setData = function (data) { Object.assign(this.data, data) }
  page.onLoad({ role })
  page.onShow()
  await flush()
  return { page, requests, calls, settingsCalls, errors }
}
const tap = scope => ({ currentTarget: { dataset: { scope } } })

test('all notifications request at most three templates per tap and continue with the remainder', async () => {
  const { page, requests } = await setup()
  assert.equal(page.data.availableCount, 10)
  const pending = page.subscribe(tap('all'))
  assert.equal(requests.length, 1, 'native authorization must start synchronously in the tap')
  assert.equal(requests[0].length, 3)
  await pending
  assert.equal(page.data.pendingKeys.length, 7)
  assert.equal(requests.length, 1, 'do not automatically invoke another prompt without a gesture')
  await page.subscribe(tap('all'))
  assert.equal(requests[1].length, 3)
  assert.equal(page.data.pendingKeys.length, 4)
  await page.subscribe(tap('all'))
  assert.equal(requests[2].length, 3)
  assert.equal(page.data.pendingKeys.length, 1)
  await page.subscribe(tap('all'))
  assert.equal(requests[3].length, 1)
  assert.equal(page.data.pendingKeys.length, 0)
  assert.equal(new Set(requests.flat()).size, 10)
})

test('templates shared by multiple notification types are requested once and update both statuses', async () => {
  const { page, requests, calls } = await setup({ role: 'staff', templates: { upcomingServiceReminder: 'shared', serviceProgress: 'shared', serviceFinish: 'finish' } })
  await page.subscribe(tap('common'))
  assert.deepEqual(Array.from(requests[0]), ['shared', 'finish'])
  assert.ok(page.data.groups[0].items.every(item => item.accepted))
  const consent = calls.find(call => call.action === 'recordSubscriptionConsent')
  assert.ok(consent.data.templateKeys.includes('upcomingServiceReminder'))
  assert.ok(consent.data.templateKeys.includes('serviceProgress'))
})

test('rejected or filtered notification templates are not shown as accepted', async () => {
  const { page } = await setup({ subscribe(options) {
    options.success({ [options.tmplIds[0]]: 'accept', [options.tmplIds[1]]: 'reject', [options.tmplIds[2]]: 'filter' })
  } })
  await page.subscribe(tap('common'))
  const items = page.data.groups[0].items
  assert.equal(items[0].accepted, true)
  assert.equal(items[1].accepted, false)
  assert.equal(items[2].accepted, false)
  assert.match(page.data.feedback, /本次已同意 1 项/)
})

test('closed WeChat switch opens native settings and refreshes the displayed state', async () => {
  const { page, requests, settingsCalls } = await setup({ mainSwitch: false })
  page.subscribe(tap('all'))
  assert.equal(requests.length, 0)
  assert.equal(settingsCalls.length, 1)
  assert.equal(settingsCalls[0].withSubscriptions, true)
  assert.equal(page.data.mainSwitch, true)
  await page.subscribe(tap('orderAccepted'))
  assert.equal(requests[0].length, 1)
})

test('master switch failure and missing templates never show a successful subscription', async () => {
  const closed = await setup({ subscribe(options) { options.fail({ errCode: 20004, errMsg: 'switch off' }) } })
  await closed.page.subscribe(tap('all'))
  assert.equal(closed.page.data.mainSwitch, false)
  assert.ok(!closed.page.data.groups[0].items.some(item => item.accepted))
  assert.equal(closed.page.data.busy, false)
  const missing = await setup({ templates: {} })
  missing.page.subscribe(tap('all'))
  assert.equal(missing.requests.length, 0)
  assert.equal(missing.page.data.availableCount, 0)
})

test('consent logging cannot keep the authorization UI busy after native confirmation', async () => {
  const { page, requests } = await setup({ holdConsent: true })
  await page.subscribe(tap('orderAccepted'))
  assert.equal(requests.length, 1)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.groups[0].items[0].accepted, true)
})

test('subscription request guard prevents rapid duplicate native prompts', async () => {
  let authorize
  const { page, requests } = await setup({ subscribe(options) { authorize = options.success } })
  const pending = page.subscribe(tap('common'))
  page.subscribe(tap('common'))
  assert.equal(requests.length, 1)
  authorize({})
  await pending
  assert.equal(page.data.busy, false)
})

test('client can explicitly authorize departure template and record consent; staff does not subscribe to it', async () => {
  const { page, requests, calls } = await setup()
  const item = page.data.groups.flatMap(g => g.items).find(i => i.key === 'staffDeparture')
  assert.equal(item.title, '宠托师出发通知')
  await page.subscribe(tap('staffDeparture'))
  assert.deepEqual([...requests[0]], ['tpl_staffDeparture'])
  const consent = calls.find(c => c.action === 'recordSubscriptionConsent')
  assert.equal(consent.data.templateIds.staffDeparture, 'tpl_staffDeparture')
  assert.equal(consent.data.results.tpl_staffDeparture, 'accept')
  const staff = await setup({ role: 'staff' })
  assert.equal(staff.page.data.groups.flatMap(g => g.items).some(i => i.key === 'staffDeparture'), false)
})

test('client authorizes started template separately; staff never subscribes to it as progress', async () => {
  const client = await setup()
  const items = client.page.data.groups.flatMap(group => group.items)
  assert.equal(items.find(item => item.key === 'serviceStart').title, '服务开始通知')
  await client.page.subscribe(tap('serviceStart'))
  assert.deepEqual([...client.requests[0]], ['tpl_serviceStart'])
  const consent = client.calls.find(call => call.action === 'recordSubscriptionConsent')
  assert.equal(consent.data.templateIds.serviceStart, 'tpl_serviceStart')
  const staff = await setup({ role: 'staff', templates: { serviceStart: 'start-only' } })
  assert.equal(staff.page.data.availableCount, 0)
  assert.equal(staff.page.data.groups.flatMap(group => group.items).some(item => item.key === 'serviceStart'), false)
  staff.page.subscribe(tap('all'))
  assert.equal(staff.requests.length, 0)
})

test('staff reminder and client remote unlock use their own configured consent IDs', async () => {
  const staff = await setup({ role: 'staff' })
  await staff.page.subscribe(tap('upcomingServiceReminder'))
  assert.deepEqual([...staff.requests[0]], ['tpl_upcomingServiceReminder'])
  const client = await setup()
  await client.page.subscribe(tap('remoteUnlock'))
  assert.deepEqual([...client.requests[0]], ['tpl_remoteUnlock'])
  assert.equal(client.calls.find(call => call.action === 'recordSubscriptionConsent').data.templateIds.remoteUnlock, 'tpl_remoteUnlock')
})
test('missing staff reminder template is unavailable despite configured progress template', async () => {
  const { page, requests } = await setup({ role: 'staff', templates: { serviceProgress: 'progress' } })
  assert.equal(page.data.groups[0].items.find(item => item.key === 'upcomingServiceReminder').available, false)
  await page.subscribe(tap('upcomingServiceReminder'))
  assert.equal(requests.length, 0)
})
