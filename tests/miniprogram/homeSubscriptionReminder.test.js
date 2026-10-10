const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '../../miniprogram')
const options = require('../../miniprogram/utils/subscription-options')

function setup(role = 'client') {
  let component
  let finishWechat
  let fresh = { subscription: { enabled: true, templates: { staffDirectOrder: 'direct', upcomingServiceReminder: 'upcoming', serviceFinish: 'finish', refundResult: 'refund', disputeUpdate: 'reserved' } } }
  const navigation = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/subscription-reminder/index.js'), 'utf8'), {
    Component(config) { component = config },
    require: name => name.endsWith('/subscription-options') ? options : {
      getCachedSystemSettings: () => fresh, loadSystemSettings: async () => fresh,
      safeNavigateTo: config => navigation.push(config.url)
    },
    wx: { getSetting: config => { finishWechat = config.success } }
  })
  const instance = { ...component.methods, data: { ...component.data }, properties: { role }, _active: true,
    setData(patch) { Object.assign(this.data, patch) } }
  return { component, instance, navigation, wechat: value => finishWechat({ subscriptionsSetting: value }), settings: value => { fresh = value } }
}

test('both home pages always mount the correct subscription reminder in their visible hero section', () => {
  for (const role of ['client', 'staff']) {
    const config = JSON.parse(fs.readFileSync(path.join(root, `pages/${role}/home/index.json`), 'utf8'))
    assert.equal(config.usingComponents['subscription-reminder'], '/components/subscription-reminder/index')
    const view = fs.readFileSync(path.join(root, `pages/${role}/home/index.wxml`), 'utf8')
    assert.match(view, new RegExp(`<subscription-reminder role="${role}" theme-class="{{themeClass}}" />`))
  }
})

test('homepage reminder uses the same role catalog, ignores reserved templates and never invokes native consent on show', async () => {
  for (const [role, count] of [['client', 2], ['staff', 3]]) {
    const ctx = setup(role)
    await ctx.instance.refresh()
    assert.match(ctx.instance.data.description, new RegExp(`${count} 项`))
    ctx.instance.openCenter()
    assert.equal(ctx.navigation[0], `/pages/common/subscriptions/index?role=${role}`)
  }
})

test('returning to homepage refreshes the switch and template configuration without hiding the reminder', async () => {
  const ctx = setup()
  await ctx.instance.refresh()
  ctx.wechat({ mainSwitch: false })
  assert.equal(ctx.instance.data.actionText, '去开启')
  assert.match(ctx.instance.data.description, /已关闭/)
  await ctx.instance.refresh()
  ctx.wechat({ mainSwitch: true, itemsSetting: { finish: 'accept', refund: 'accept' } })
  assert.equal(ctx.instance.data.actionText, '管理订阅')
  ctx.settings({ subscription: { enabled: true, templates: { refundResult: 'new-refund' } } })
  await ctx.instance.refresh()
  assert.equal(ctx.instance.data.actionText, '去订阅')
  assert.match(ctx.instance.data.description, /1 项/)
  ctx.settings({ subscription: { enabled: true, templates: {} } })
  await ctx.instance.refresh()
  assert.match(ctx.instance.data.description, /尚未配置/)
})

test('a hidden homepage ignores late permission reads', async () => {
  const ctx = setup()
  await ctx.instance.refresh()
  const description = ctx.instance.data.description
  ctx.component.pageLifetimes.hide.call(ctx.instance)
  ctx.wechat({ mainSwitch: false })
  assert.equal(ctx.instance.data.description, description)
})
