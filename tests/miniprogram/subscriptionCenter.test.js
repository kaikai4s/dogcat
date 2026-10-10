const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))
const templateKeys = ['staffDirectOrder', 'orderAccepted', 'staffDeparture', 'serviceStart', 'serviceProgress', 'serviceFinish', 'orderPaid', 'orderAssigned', 'remoteUnlock', 'refundResult', 'disputeUpdate', 'upcomingServiceReminder', 'withdrawResult']

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
    require: name => name.endsWith('/subscription-options') ? require('../../miniprogram/utils/subscription-options') : { envList: [] }
  })
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/common/subscriptions/index.js'), 'utf8'), {
    Page(config) { page = config }, require: name => name.endsWith('/subscription-options') ? require('../../miniprogram/utils/subscription-options') : module.exports, wx
  })
  page.setData = function (data) { Object.assign(this.data, data) }
  page.onLoad({ role })
  page.onShow()
  await flush()
  return { page, requests, calls, settingsCalls, errors, settings, wx, api: module.exports }
}
const tap = scope => ({ currentTarget: { dataset: { scope } } })

test('all notifications request at most three templates per tap and continue with the remainder', async () => {
  const { page, requests } = await setup()
  assert.equal(page.data.availableCount, 9)
  const pending = page.subscribe(tap('all'))
  assert.equal(requests.length, 1, 'native authorization must start synchronously in the tap')
  assert.equal(requests[0].length, 3)
  await pending
  assert.equal(page.data.pendingKeys.length, 6)
  assert.equal(requests.length, 1, 'do not automatically invoke another prompt without a gesture')
  await page.subscribe(tap('all'))
  assert.equal(requests[1].length, 3)
  assert.equal(page.data.pendingKeys.length, 3)
  await page.subscribe(tap('all'))
  assert.equal(requests[2].length, 3)
  assert.equal(page.data.pendingKeys.length, 0)
  assert.equal(new Set(requests.flat()).size, 9)
})

test('templates shared by multiple notification types are requested once and update both statuses', async () => {
  const { page, requests, calls } = await setup({ role: 'staff', templates: { upcomingServiceReminder: 'shared', serviceProgress: 'shared', serviceFinish: 'finish' } })
  await page.subscribe(tap('common'))
  assert.deepEqual(Array.from(requests[0]), ['shared', 'finish'])
  assert.ok(page.data.groups[0].items.filter(item => item.available).every(item => item.accepted))
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

test('refund and direct-order consent use configured IDs and are separated by recipient role', async () => {
  const client = await setup()
  await client.page.subscribe(tap('refundResult'))
  assert.deepEqual([...client.requests[0]], ['tpl_refundResult'])
  assert.equal(client.calls.find(call => call.action === 'recordSubscriptionConsent').data.templateIds.refundResult, 'tpl_refundResult')
  assert.equal(client.page.data.groups.flatMap(group => group.items).some(item => item.key === 'staffDirectOrder'), false)
  const staff = await setup({ role: 'staff' })
  await staff.page.subscribe(tap('staffDirectOrder'))
  assert.deepEqual([...staff.requests[0]], ['tpl_staffDirectOrder'])
  assert.equal(staff.calls.find(call => call.action === 'recordSubscriptionConsent').data.templateIds.staffDirectOrder, 'tpl_staffDirectOrder')
  assert.equal(staff.page.data.groups.flatMap(group => group.items).some(item => item.key === 'refundResult'), false)
})

test('staff common reminders require a fresh gesture for the fourth template', async () => {
  const { page, requests } = await setup({ role: 'staff' })
  await page.subscribe(tap('common'))
  assert.deepEqual([...requests[0]], ['tpl_staffDirectOrder', 'tpl_upcomingServiceReminder', 'tpl_serviceProgress'])
  assert.deepEqual([...page.data.pendingKeys], ['serviceFinish'])
  await page.subscribe(tap('common'))
  assert.deepEqual([...requests[1]], ['tpl_serviceFinish'])
})

test('returning to subscription center refreshes backend IDs and discards old pending batches', async () => {
  const { page, requests, settings } = await setup()
  await page.subscribe(tap('all'))
  assert.ok(page.data.pendingKeys.length)
  settings.subscription.templates = { refundResult: 'new-refund' }
  page.onShow()
  assert.equal(page.data.ready, false)
  page.subscribe(tap('all'))
  assert.equal(requests.length, 1, 'no stale IDs while settings are refreshing')
  await flush()
  assert.equal(page.data.availableCount, 1)
  assert.equal(page.data.pendingKeys.length, 0)
  await page.subscribe(tap('all'))
  assert.deepEqual([...requests[1]], ['new-refund'])
})

test('no cached config never triggers a native prompt after a network response', async () => {
  const { api, wx, calls, requests } = await setup()
  wx.getStorageSync = () => undefined
  const before = calls.length
  const result = await api.requestSubscribeTemplates(['refundResult'], 'cold-tap')
  assert.equal(result.requested, false)
  assert.equal(requests.length, 0)
  assert.equal(calls.length, before, 'preload config on show instead of awaiting it inside a tap')
})

test('native prompts share a guard across entry points and consent logging never blocks business', async () => {
  let finish
  const { api, requests } = await setup({ holdConsent: true, subscribe(options) { finish = options.success } })
  const first = api.requestSubscribeTemplates(['refundResult'], 'refund')
  const second = await api.requestSubscribeTemplates(['staffDirectOrder'], 'staff')
  assert.equal(second.reason, 'request_in_progress')
  assert.equal(requests.length, 1)
  finish({ tpl_refundResult: 'accept' })
  assert.equal((await first).requested, true)
  const next = api.requestSubscribeTemplates(['staffDirectOrder'], 'staff')
  finish({ tpl_staffDirectOrder: 'accept' })
  await next
  assert.equal(requests.length, 2)
})

test('an omitted authorization result cannot inherit previously accepted display state', async () => {
  let count = 0
  const { page } = await setup({ subscribe(options) { options.success(++count === 1 ? { tpl_refundResult: 'accept' } : {}) } })
  await page.subscribe(tap('refundResult'))
  await page.subscribe(tap('refundResult'))
  assert.equal(page.data.groups.flatMap(g => g.items).find(item => item.key === 'refundResult').accepted, false)
})

test('native prompt return keeps the remaining batch if the configured templates have not changed', async () => {
  const { page, requests } = await setup()
  await page.subscribe(tap('all'))
  const remaining = [...page.data.pendingKeys]
  page.onShow()
  await flush()
  assert.deepEqual([...page.data.pendingKeys], remaining)
  await page.subscribe(tap('all'))
  assert.ok(requests[1].every(id => !requests[0].includes(id)))
})

test('legacy after-sale slot is explicitly unavailable for both roles, never consuming consent', async () => {
  for (const role of ['client', 'staff']) {
    const { page, requests } = await setup({ role, templates: { disputeUpdate: 'unused' } })
    assert.equal(page.data.availableCount, 0)
    assert.equal(page.data.groups.flatMap(g => g.items).find(item => item.key === 'disputeUpdate').available, false)
    await page.subscribe(tap('all'))
    assert.equal(requests.length, 0)
  }
})

test('an invalid template only splits its failed batch, while unrelated notifications still request three at a time', async () => {
  const { page, requests } = await setup({ subscribe(options) {
    if (options.tmplIds.includes('tpl_staffDeparture')) {
      options.fail({ errCode: 20001, errMsg: 'template id invalid' })
    } else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
  } })
  await page.subscribe(tap('all'))
  assert.equal(requests.length, 1)
  assert.equal(page.data.batchRemaining, 9)
  assert.match(page.data.feedback, /20001/)
  assert.equal(page.data.nextBatchCount, 3)
  for (let i = 0; i < 5; i++) await page.subscribe(tap('all'))
  assert.deepEqual(requests.map(ids => ids.length), [3, 3, 3, 1, 1, 1])
  assert.equal(page.data.batchAccepted, 8)
  assert.equal(page.data.batchRemaining, 0)
  assert.match(page.data.feedback, /尚有未授权/)
  assert.match(page.data.groups[0].items.find(item => item.key === 'staffDeparture').statusText, /模板不可用/)
})

test('network rejection preserves the batch and remembered accepts can finish without a visible dialog', async () => {
  let failed = false
  const { page, requests } = await setup({ subscribe(options) {
    if (!failed) { failed = true; options.fail({ errCode: 10002, errMsg: 'network error' }) }
    else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
  } })
  await page.subscribe(tap('all'))
  assert.equal(page.data.nextBatchCount, 3)
  assert.equal(page.data.batchRemaining, 9)
  assert.match(page.data.feedback, /10002/)
  await page.subscribe(tap('all'))
  assert.deepEqual([...requests[0]], [...requests[1]])
  await page.subscribe(tap('all'))
  await page.subscribe(tap('all'))
  assert.equal(page.data.batchAccepted, 9)
  assert.match(page.data.feedback, /全部订阅/)
})

test('late getSetting cannot overwrite a fresh rejection and restore an accepted label', async () => {
  const { page, wx } = await setup({ subscribe(options) { options.success({ tpl_refundResult: 'reject' }) } })
  let finishRead
  wx.getSetting = options => { finishRead = options.success }
  page.refreshWechatSettings()
  await page.subscribe(tap('refundResult'))
  finishRead({ subscriptionsSetting: { mainSwitch: true, itemsSetting: { tpl_refundResult: 'accept' } } })
  assert.equal(page.data.groups.flatMap(g => g.items).find(item => item.key === 'refundResult').accepted, false)
})

test('synchronous native errors retain diagnostics and release the guard for retry', async () => {
  const { page } = await setup({ subscribe() { throw { errCode: 20001, errMsg: 'invalid template' } } })
  await page.subscribe(tap('all'))
  assert.match(page.data.feedback, /20001/)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.nextBatchCount, 3, 'unrelated templates retain batch authorization')
})

test('concurrent settings preloads share the same read and retain carousel navigation metadata', async () => {
  const { api, settings, calls } = await setup()
  settings.homeHeroCarousel = { enabled: true, items: [{ id: 'hero', fileId: 'cloud://hero', linkUrl: '/pages/client/mall/list/index', linkTitle: '选购' }] }
  const before = calls.filter(call => call.action === 'getSettings').length
  const first = api.loadSystemSettings()
  assert.equal(first, api.loadSystemSettings())
  await first
  assert.equal(calls.filter(call => call.action === 'getSettings').length, before + 1)
  assert.equal(api.getCachedSystemSettings().homeHeroCarousel.items[0].linkUrl, '/pages/client/mall/list/index')
  assert.equal(api.getCachedSystemSettings().homeHeroCarousel.items[0].linkTitle, '选购')
})

test('blank IDs, template numbers and placeholders never appear available or open a native prompt', async () => {
  const templates = { orderAccepted: '', staffDeparture: 'YOUR_TEMPLATE_ID', serviceStart: '71479', refundResult: 'template_id' }
  const { page, requests, api } = await setup({ templates })
  assert.equal(page.data.availableCount, 0)
  assert.equal(page.data.invalidCount, 3)
  await page.subscribe(tap('all'))
  assert.equal(requests.length, 0)
  const result = await api.requestSubscribeTemplates(Object.keys(templates), 'missing-config')
  assert.equal(result.requested, false)
  assert.equal(result.reason, 'template_not_configured')
  assert.equal(requests.length, 0)
})

test('known invalid templates do not reenter the batch when switching between all, common and settings', async () => {
  const { page, requests } = await setup({ templates: { orderAccepted: 'invalid-accepted', staffDeparture: 'invalid-departure', serviceStart: 'invalid-start' },
    subscribe(options) { options.fail({ errCode: 20001, errMsg: 'template not found' }) } })
  await page.subscribe(tap('orderAccepted'))
  assert.equal(page.data.availableCount, 2)
  await page.subscribe(tap('all'))
  assert.ok(!requests[1].includes('invalid-accepted'))
  await page.subscribe(tap('all'))
  assert.equal(page.data.availableCount, 1)
  page.onShow()
  await flush()
  page.openSettings()
  await page.subscribe(tap('common'))
  assert.deepEqual([...requests.at(-1)], ['invalid-start'])
  assert.equal(page.data.availableCount, 0)
  assert.equal(page.data.invalidCount, 3)
  assert.equal(page.data.pendingKeys.length, 0)
  const count = requests.length
  await page.subscribe(tap('all'))
  assert.equal(requests.length, count)
  assert.match(page.data.feedback, /配置/)
})

test('explicit configuration recheck recovers after the administrator adds real IDs', async () => {
  const { page, settings, requests } = await setup({ templates: {} })
  assert.equal(page.data.availableCount, 0)
  settings.subscription.templates = { staffDeparture: 'Ok3GmyPJUxBvOWG7RdFVhBLrpbVMvkiY2-d-IlJPI_0' }
  await page.reloadConfiguration()
  assert.equal(page.data.availableCount, 1)
  await page.subscribe(tap('all'))
  assert.deepEqual([...requests[0]], [settings.subscription.templates.staffDeparture])
  assert.equal(page.data.batchAccepted, 1)
})

test('partial authorization fills the next batch with all three remaining templates and completes in two taps', async () => {
  let count = 0
  const { page, requests } = await setup({ subscribe(options) {
    if (++count === 1) options.success({ [options.tmplIds[0]]: 'accept' })
    else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
  } })
  await page.subscribe(tap('common'))
  assert.equal(requests.length, 1, 'no automatic follow-up without another user tap')
  assert.equal(page.data.batchTotal, 4)
  assert.equal(page.data.batchAccepted, 1)
  assert.equal(page.data.batchRemaining, 3)
  assert.deepEqual([...page.data.pendingKeys], ['serviceFinish', 'staffDeparture', 'serviceStart'])
  assert.match(page.data.pendingNames, /宠托师出发通知.*服务开始通知/)
  assert.match(page.data.feedback, /还有 3 项未完成/)
  assert.equal(page.data.nextBatchCount, 3)
  assert.equal(page.data.pendingScope, 'common')
  assert.doesNotMatch(page.data.feedback, /全部订阅/)
  page.onShow()
  await flush()
  await page.subscribe(tap(page.data.pendingScope))
  assert.deepEqual([...requests[1]], ['tpl_serviceFinish', 'tpl_staffDeparture', 'tpl_serviceStart'])
  assert.equal(requests.length, 2)
  assert.equal(page.data.batchAccepted, 4)
  assert.equal(page.data.batchRemaining, 0)
  assert.equal(page.data.pendingNames, '')
  assert.match(page.data.feedback, /全部订阅/)
})

test('a filtered combination is separated on retry without repeating an accepted template', async () => {
  let count = 0
  const { page, requests } = await setup({ templates: { orderAccepted: 'accepted', staffDeparture: 'rejected', serviceStart: 'filtered' }, subscribe(options) {
    if (++count === 1) options.success({ accepted: 'accept', rejected: 'reject', filtered: 'filter' })
    else options.success({ [options.tmplIds[0]]: options.tmplIds[0] === 'rejected' ? 'reject' : 'accept' })
  } })
  await page.subscribe(tap('all'))
  assert.equal(page.data.batchRemaining, 2)
  assert.match(page.data.feedback, /微信通知设置/)
  await page.subscribe(tap('all'))
  assert.deepEqual([...requests[1]], ['rejected'])
  assert.equal(page.data.batchRemaining, 2)
  await page.subscribe(tap('all'))
  assert.deepEqual([...requests[2]], ['filtered'])
  assert.equal(page.data.batchRemaining, 1)
  assert.equal(page.data.batchAccepted, 2)
  assert.deepEqual([...page.data.pendingKeys], ['staffDeparture'])
  assert.doesNotMatch(page.data.feedback, /全部订阅/)
})

test('all-notification retries do not slow down unattempted batches or lose multiple keys sharing one filtered template', async () => {
  let count = 0
  const all = await setup({ subscribe(options) {
    if (++count === 1) options.success({ [options.tmplIds[0]]: 'accept' })
    else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
  } })
  await all.page.subscribe(tap('all'))
  await all.page.subscribe(tap('all'))
  await all.page.subscribe(tap('all'))
  assert.equal(all.requests[1].length, 3)
  assert.equal(all.requests[2].length, 3)
  assert.equal(all.page.data.batchAccepted, 7)
  assert.equal(all.page.data.batchRemaining, 2)
  await all.page.subscribe(tap('all'))
  assert.equal(all.requests[3].length, 2)
  assert.equal(all.page.data.batchAccepted, 9)

  let first = true
  const shared = await setup({ role: 'staff', templates: { upcomingServiceReminder: 'shared', serviceProgress: 'shared', serviceFinish: 'finish' }, subscribe(options) {
    options.success(first ? { shared: 'filter', finish: 'accept' } : { shared: 'accept' })
    first = false
  } })
  await shared.page.subscribe(tap('common'))
  assert.equal(shared.page.data.batchRemaining, 1)
  assert.deepEqual([...shared.page.data.pendingKeys], ['upcomingServiceReminder', 'serviceProgress'])
  await shared.page.subscribe(tap('common'))
  assert.deepEqual([...shared.requests[1]], ['shared'])
  assert.equal(shared.page.data.batchAccepted, 2)
  assert.equal(shared.page.data.batchRemaining, 0)
})

test('ordinary rejections and missing results remain batched for both recipient roles', async () => {
  for (const role of ['client', 'staff']) {
    let count = 0
    const { page, requests } = await setup({ role, subscribe(options) {
      if (++count === 1) options.success({ [options.tmplIds[0]]: 'reject', [options.tmplIds[1]]: 'ban' })
      else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
    } })
    await page.subscribe(tap('all'))
    assert.equal(page.data.nextBatchCount, 3)
    await page.subscribe(tap('all'))
    assert.equal(requests[1].length, 3)
    for (let i = 0; page.data.pendingKeys.length && i < 4; i++) await page.subscribe(tap('all'))
    assert.equal(page.data.batchAccepted, role === 'client' ? 9 : 5)
    assert.ok(requests.slice(1, -1).every(ids => ids.length === 3))
  }
})

test('filtered templates can join a different batch instead of all being forced to individual requests', async () => {
  let count = 0
  const { page, requests } = await setup({ subscribe(options) {
    if (++count === 1) options.success({ tpl_orderAccepted: 'accept', tpl_staffDeparture: 'filter', tpl_serviceStart: 'filter' })
    else options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept'])))
  } })
  await page.subscribe(tap('common'))
  assert.equal(page.data.nextBatchCount, 2)
  await page.subscribe(tap('common'))
  assert.deepEqual([...requests[1]], ['tpl_serviceFinish', 'tpl_staffDeparture'])
  assert.equal(page.data.batchRemaining, 1)
  await page.subscribe(tap('common'))
  assert.deepEqual([...requests[2]], ['tpl_serviceStart'])
  assert.equal(page.data.batchAccepted, 4)
})

test('valid client and staff templates finish in the minimum number of batches without automatic prompts', async () => {
  for (const [role, sizes] of [['client', [3, 3, 3]], ['staff', [3, 2]]]) {
    const { page, requests } = await setup({ role })
    for (let i = 0; i < sizes.length; i++) {
      await page.subscribe(tap('all'))
      assert.equal(requests.length, i + 1)
      assert.equal(requests[i].length, sizes[i])
    }
    assert.equal(page.data.batchRemaining, 0)
    assert.equal(new Set(requests.flat()).size, requests.flat().length)
    assert.match(page.data.feedback, /全部订阅/)
  }
})

test('a single template type error stays pending while other failed-batch candidates can complete', async () => {
  const { page, requests } = await setup({ templates: { orderAccepted: 'bad-type', staffDeparture: 'valid' }, subscribe(options) {
    if (options.tmplIds.includes('bad-type')) options.fail({ errCode: 20003, errMsg: 'template type error' })
    else options.success({ valid: 'accept' })
  } })
  await page.subscribe(tap('all'))
  await page.subscribe(tap('all'))
  assert.equal(page.data.batchRemaining, 2)
  assert.equal(page.data.invalidCount, 0, 'a type error alone does not prove the ID is invalid')
  await page.subscribe(tap('all'))
  assert.deepEqual([...requests[2]], ['valid'])
  assert.equal(page.data.batchAccepted, 1)
  assert.deepEqual([...page.data.pendingKeys], ['orderAccepted'])
  assert.doesNotMatch(page.data.feedback, /全部订阅/)
})
