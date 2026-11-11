const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const options = require('../../miniprogram/utils/subscription-options')

test('withdrawal status subscriptions are shared by client and staff but not admin', () => {
  for (const role of ['client', 'staff']) {
    const other = options.subscriptionSections(role).find(([id]) => id === 'other')
    assert.ok(other[2].includes('withdrawResult'))
    assert.deepEqual(options.availableSubscriptionIds({ subscription: { enabled: true, templates: { withdrawResult: 'withdraw-full-id' } } }, role), ['withdraw-full-id'])
    assert.deepEqual(options.availableSubscriptionIds({ subscription: { enabled: true, templates: { withdrawResult: '73593' } } }, role), [])
  }
  assert.ok(!options.subscriptionSections('admin').flatMap(([, , keys]) => keys).includes('withdrawResult'))
  const center = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/common/subscriptions/index.js'), 'utf8')
  assert.match(center, /withdrawResult: \['提现状态变更提醒', '邀请收益与宠托师佣金提现共用此提醒/)
})

test('withdrawal template configuration specifies exact 73593 fields and requires a full ID', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/settings/index.wxml'), 'utf8')
  assert.match(wxml, /提现状态变更提醒模板/)
  assert.match(wxml, /模板 73593：提现金额 amount1、提现状态 phrase2、温馨提示 thing3/)
  assert.match(wxml, /data-field="withdrawResult"[^>]*placeholder="填写完整模板 ID，不能填写模板编号 73593"/)
  assert.match(wxml, /邀请收益与宠托师佣金提现共用此模板/)
})

test('withdrawal reminder buttons and 24-hour notice are scoped to confirmable transfers', () => {
  for (const file of ['staff/earnings', 'client/profile/assets']) {
    const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages', file, 'index.wxml'), 'utf8')
    assert.match(wxml, /bindtap="openWithdrawalSubscriptions">订阅提现状态提醒<\/button>/)
    assert.match(wxml, /<view[^>]*wx:if="\{\{item.canConfirmTransfer\}\}"[^>]*>\s*(?:<text[^>]*><\/text>\s*<text>)?24小时未确认将放弃此次提现；最终状态以微信处理结果为准/)
    assert.equal(wxml.split('24小时未确认将放弃此次提现').length - 1, 1)
  }
})

test('homepage and center share validation for empty IDs, numeric library codes and placeholders', () => {
  for (const value of ['', '   ', '44245', 'YOUR_TEMPLATE_ID', 'template_id', '请填写模板ID', 'https://example.com/template', 'a b']) {
    assert.ok(options.subscriptionTemplateIssue(value))
    assert.equal(options.availableSubscriptionIds({ subscription: { enabled: true, templates: { orderAccepted: value } } }, 'client').length, 0)
  }
  const id = 'Ok3GmyPJUxBvOWG7RdFVhBLrpbVMvkiY2-d-IlJPI_0'
  assert.equal(options.subscriptionTemplateIssue(id), '')
  assert.deepEqual(options.availableSubscriptionIds({ subscription: { enabled: true, templates: { staffDeparture: id } } }, 'client'), [id])
})

test('administrator cannot save template numbers or placeholders, but can leave unconfigured IDs empty', () => {
  for (const [value, allowed] of [['7272', false], ['YOUR_TEMPLATE_ID', false], ['', true]]) {
    const calls = [], errors = []
    let page
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/settings/index.js'), 'utf8'), {
      Page(config) { page = config }, wx: {},
      require: name => name.endsWith('/format') ? require('../../miniprogram/utils/format') : name.endsWith('/subscription-options') ? options : name.endsWith('/payment-config') ? require('../../miniprogram/pages/admin/settings/payment-config') : {
        callFunction: (...args) => { calls.push(args); return new Promise(() => {}) }, showError: error => errors.push(error.message)
      }
    })
    page.setData = function (patch) { Object.assign(this.data, patch) }
    page.data.loaded = true
    page.data.settings.staffTraining.quiz = structuredClone(require('../../cloudfunctions/api/config/constants').DEFAULT_STAFF_TRAINING_QUIZ)
    page.data.settings.subscription.templates.refundResult = value
    page.save()
    assert.equal(calls.length, allowed ? 1 : 0)
    if (!allowed) assert.match(errors[0], /订阅消息设置/)
  }
})

test('admin subscription delivery list defaults to three records and supports expanding the rest', () => {
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/settings/index.js'), 'utf8'), {
    Page(config) { page = config }, wx: {},
    require: name => name.endsWith('/format') ? require('../../miniprogram/utils/format') : name.endsWith('/subscription-options') ? options : name.endsWith('/payment-config') ? require('../../miniprogram/pages/admin/settings/payment-config') : {}
  })
  page.setData = function (patch) { Object.assign(this.data, patch) }
  assert.equal(page.data.subscriptionDeliveriesExpanded, false)
  page.toggleSubscriptionDeliveries()
  assert.equal(page.data.subscriptionDeliveriesExpanded, true)
  page.toggleSubscriptionDeliveries()
  assert.equal(page.data.subscriptionDeliveriesExpanded, false)

  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/settings/index.wxml'), 'utf8')
  assert.match(wxml, /toggleSubscriptionDeliveries/)
  assert.match(wxml, /subscriptionDeliveriesExpanded \|\| index < 3/)
})
