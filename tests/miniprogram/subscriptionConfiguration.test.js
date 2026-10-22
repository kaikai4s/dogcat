const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const options = require('../../miniprogram/utils/subscription-options')

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
      require: name => name.endsWith('/subscription-options') ? options : name.endsWith('/payment-config') ? require('../../miniprogram/pages/admin/settings/payment-config') : {
        callFunction: (...args) => { calls.push(args); return new Promise(() => {}) }, showError: error => errors.push(error.message)
      }
    })
    page.setData = function (patch) { Object.assign(this.data, patch) }
    page.data.loaded = true
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
    require: name => name.endsWith('/subscription-options') ? options : name.endsWith('/payment-config') ? require('../../miniprogram/pages/admin/settings/payment-config') : {}
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
