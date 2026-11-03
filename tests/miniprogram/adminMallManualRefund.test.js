const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const pagePath = path.resolve(__dirname, '../../miniprogram/pages/admin/mall/orders/index')
const template = fs.readFileSync(pagePath + '.wxml', 'utf8')

function fixture() {
  let page
  const calls = [], toasts = [], confirmations = [], errors = []
  vm.runInNewContext(fs.readFileSync(pagePath + '.js', 'utf8'), {
    Page(value) { page = value },
    require(name) {
      if (name.endsWith('/cloud')) return {
        callFunction: (...args) => { calls.push(args); return Promise.resolve({}) },
        showError: error => errors.push(error)
      }
      return {}
    },
    wx: {
      showToast: options => toasts.push(options),
      showModal: options => confirmations.push(options)
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.load = () => {}
  page.data.orders = [{ _id: 'mall-1', orderNo: 'MALL001', payAmount: 100, maxRefundable: 80 }]
  page.openManualRefundModal({ currentTarget: { dataset: { id: 'mall-1' } } })
  function input(binding, value) {
    const element = [...template.matchAll(/<input\b[^>]*>/g)].map(match => match[0])
      .find(tag => tag.includes(`value="{{${binding}}}"`))
    assert.ok(element, `Missing input for ${binding}`)
    const field = element.match(/data-field="([^"]+)"/)[1]
    const handler = element.match(/bindinput="([^"]+)"/)[1]
    page[handler]({ currentTarget: { dataset: { field } }, detail: { value } })
  }
  return { page, calls, toasts, confirmations, errors, input }
}

test('manual mall refund submits the entered partial amount and reason from the rendered inputs', async () => {
  const { page, calls, confirmations, errors, input } = fixture()
  input('manualRefundAmount', '25.50')
  input('manualRefundReason', '  商品破损，协商部分退款  ')
  page.submitManualRefund()
  assert.equal(confirmations.length, 1)
  assert.match(confirmations[0].content, /25\.50/)
  assert.equal(calls.length, 0, 'No refund before confirmation')
  confirmations[0].success({ confirm: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'adminMall')
  assert.equal(calls[0][1], 'refundOrder')
  assert.equal(calls[0][2].orderId, 'mall-1')
  assert.equal(calls[0][2].refundAmount, 25.5)
  assert.equal(calls[0][2].reason, '商品破损，协商部分退款')
  assert.equal(errors.length, 0)
  assert.equal(page.data.showManualRefundModal, false)
})

test('blank manual refund reason and an entered amount exceeding the balance remain blocked', () => {
  const { page, calls, toasts, confirmations, input } = fixture()
  input('manualRefundReason', '   ')
  page.submitManualRefund()
  assert.equal(toasts.at(-1).title, '请填写退款说明')
  input('manualRefundReason', '协商退款')
  input('manualRefundAmount', '80.01')
  page.submitManualRefund()
  assert.match(toasts.at(-1).title, /不能超过最大可退/)
  assert.equal(confirmations.length, 0)
  assert.equal(calls.length, 0)
})

test('cancelling refund confirmation retains the entered form without calling the refund API', () => {
  const { page, calls, confirmations, input } = fixture()
  input('manualRefundReason', '协商退款')
  input('manualRefundAmount', '20')
  page.submitManualRefund()
  confirmations[0].success({ confirm: false })
  assert.equal(calls.length, 0)
  assert.equal(page.data.manualRefundAmount, '20')
  assert.equal(page.data.manualRefundReason, '协商退款')
})

// Exercise the display adapters without changing raw enum values used by admin APIs.
function displayFixture(relative, callFunction = async () => ({})) {
  const file = path.resolve(__dirname, '../../miniprogram/pages/admin', relative, 'index.js')
  const localRequire = createRequire(file)
  let page
  const context = vm.createContext({
    Page(value) { page = value },
    require(name) {
      if (name.endsWith('/cloud')) return { callFunction, showError: error => { throw error } }
      if (name.endsWith('/admin-page-read')) return { optionalAdminRead: (_, module, action, data) => callFunction(module, action, data) }
      return localRequire(name)
    },
    wx: { getStorageSync: () => ({}), showToast() {} }
  })
  vm.runInContext(fs.readFileSync(file, 'utf8'), context)
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = page.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
  }
  return { page, fn: name => vm.runInContext(name, context) }
}

test('admin mall display maps all statuses and safely hides future codes without mutating orders', () => {
  const decorate = displayFixture('mall/orders').fn('decorateOrder')
  const raw = { status: 'refund_applied', statusText: 'refund_applied', paymentStatus: 'failed', refundStatus: 'return_shipped' }
  const row = decorate(raw)
  assert.equal(row.statusText, '售后申请中')
  assert.equal(row.paymentStatusText, '支付失败')
  assert.equal(row.refundStatusText, '已寄回待验货')
  assert.equal(row.status, raw.status)
  assert.equal(row.refundStatus, raw.refundStatus)
  assert.equal(raw.statusText, 'refund_applied')
  const unknown = decorate({ status: 'future_order', paymentStatus: 'future_payment', refundStatus: 'future_refund' })
  for (const field of ['statusText', 'paymentStatusText', 'refundStatusText']) {
    assert.match(unknown[field], /[\u4e00-\u9fff]/)
    assert.doesNotMatch(unknown[field], /future_/)
  }
  assert.equal(displayFixture('mall/products').fn('withCategoryName')({ status: 'future_product' }).statusText, '商品状态未知')
})

test('admin user and promotion cards have Chinese display fields while keeping raw roles and statuses', async () => {
  for (const relative of ['users/list', 'admins/list']) {
    const decorate = displayFixture(relative).fn('withDisplay')
    assert.equal(decorate({ status: 'disabled' }).statusText, '已禁用')
    const row = decorate({ status: 'future_status', roles: ['client', 'staff', 'admin', 'future_role'], openid: 'real_identifier', nickname: 'free_text' })
    assert.equal(row.status, 'future_status')
    assert.equal(row.statusText, '账号状态未知')
    assert.equal(row.openid, 'real_identifier')
    assert.equal(row.nickname, 'free_text')
    if (relative === 'users/list') assert.deepEqual(Array.from(row.roleTexts), ['用户', '宠托师', '管理员', '未知角色'])
    const markup = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin', relative, 'index.wxml'), 'utf8')
    assert.doesNotMatch(markup, />\{\{item\.status\}\}</)
  }
  const { page } = displayFixture('users/edit', async () => ({ status: 'deleted' }))
  page.data.openid = 'real_identifier'
  page.load()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.form.status, 'deleted')
  assert.equal(page.data.statusText, '已删除')
  page.changeStatus({ detail: { value: 1 } })
  assert.equal(page.data.statusText, '禁用')
  assert.equal(page.data.form.status, 'disabled')
  assert.equal(displayFixture('staff-promotion/list').fn('withDisplay')({ status: 'pending' }).statusText, '转正审核中')
})

test('question types and service rule fallbacks are semantic Chinese and do not alter API enums', () => {
  const form = displayFixture('questionnaires/edit').fn('toForm')({ questions: [{ type: 'future_type', title: 'free_title' }, { type: 'multiple' }] })
  assert.equal(form.questions[0].type, 'future_type')
  assert.equal(form.questions[0].typeName, '未知题型')
  assert.equal(form.questions[0].title, 'free_title')
  assert.equal(form.questions[1].typeName, '多选')
  const fixture = displayFixture('service-prices')
  const groups = fixture.fn('groupRules')([{ serviceType: 'walk', eventType: 'enter_door' }, { serviceType: 'future_service', eventType: 'future_event', description: 'free_description' }])
  assert.equal(groups[0].title, '遛狗服务')
  assert.equal(groups[0].rules[0].eventTypeText, '入户打卡')
  assert.equal(groups[1].title, '其他服务')
  assert.doesNotMatch(groups[1].rules[0].eventTypeText, /future_/)
  assert.equal(groups[1].rules[0].eventType, 'future_event')
  assert.equal(groups[1].rules[0].description, 'free_description')
})

test('saving service rules excludes display fields and preserves raw custom service and event identifiers', async () => {
  const calls = []
  const fixture = displayFixture('service-prices', async (module, action, payload) => {
    calls.push({ module, action, payload })
    return payload.rules
  })
  const raw = { serviceType: 'custom_service', eventType: 'future_event', label: '自定义规则', required: true }
  fixture.page.data.ruleGroups = fixture.fn('groupRules')([raw])
  fixture.page.saveRules()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0].action, 'saveServiceCheckinRules')
  assert.deepEqual({ ...calls[0].payload.rules[0] }, raw)
  assert.equal(Object.hasOwn(calls[0].payload.rules[0], 'eventTypeText'), false)
})

test('operation logs use permission tree labels and remain safe when names have not initialized', async () => {
  const { page } = displayFixture('operation-logs', async () => ({ list: [{ status: 'future_result', module: 'internal_module', action: 'internal_action', errorCode: 'FUTURE_ERROR' }], hasMore: false }))
  await page.load(true)
  assert.equal(page.data.rows[0].actionText, '其他后台操作')
  assert.equal(page.data.rows[0].resultText, '操作结果未知')
  assert.equal(page.data.rows[0].errorText, '操作未完成，请核查处理结果')
  assert.equal(page.data.rows[0].errorCode, 'FUTURE_ERROR')
  page.data.adminAccess = { tree: [{ label: '订单管理', children: [{ id: 'internal_module.internal_action', label: '查看订单' }] }] }
  await page.onShow()
  assert.equal(page.data.rows[0].actionText, '订单管理 / 查看订单')
  assert.equal(page.data.rows[0].action, 'internal_action')
})

test('admin order evidence maps timeline, role, checkin and unlock enums without replacing free text', () => {
  const fixture = displayFixture('orders/detail')
  const timeline = fixture.fn('decorateTimeline')([
    { type: 'created', actorRole: 'client' },
    { type: 'future_type', title: 'future_type', actorRole: 'future_role' },
    { type: 'checkin', detail: 'enter_door', title: '自定义打卡标题' },
    { type: 'checkin', detail: 'free text / 用户备注' }
  ], { paidAt: '2026-11-01 10:00' })
  assert.equal(timeline.find(row => row.type === 'created').titleText, '订单已创建')
  assert.equal(timeline.find(row => row.type === 'future_type').titleText, '订单动态')
  assert.equal(timeline.find(row => row.type === 'future_type').actorRoleText, '未知角色')
  assert.equal(timeline.find(row => row.detail === 'enter_door').detailText, '入户打卡')
  assert.equal(timeline.find(row => row.detail === 'enter_door').titleText, '自定义打卡标题')
  assert.equal(timeline.find(row => row.detail === 'free text / 用户备注').detailText, 'free text / 用户备注')
  assert.equal(timeline.find(row => row.type === 'paid').titleText, '订单已支付')
  assert.equal(fixture.fn('decorateCheckins')([{ eventType: 'future_event' }])[0].eventTypeText.includes('future_'), false)
  const logs = fixture.fn('decorateUnlockLogs')([{ action: 'copy', actorRole: 'staff' }, { action: 'future_action', actorRole: 'future_role' }, { result: 'destroyed', actor: 'system' }, { action: 'view', actionText: 'free text' }])
  assert.equal(logs[0].actionText, '复制门锁密码')
  assert.equal(logs[1].actionText, '门锁密码访问记录')
  assert.equal(logs[1].action, 'future_action')
  assert.equal(logs[1].actorRoleText, '未知角色')
  assert.equal(logs[2].actionText, '门锁密码已销毁')
  assert.equal(logs[2].actorRoleText, '系统')
  assert.equal(logs[3].actionText, 'free text')
})
