const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '../../miniprogram')
const flush = () => new Promise(resolve => setImmediate(resolve))
function load(file, deps = {}, wxExtra = {}) {
  let page
  const calls = [], timers = new Map()
  const defaults = { envList: [{ envId: 'test' }], startStaffEntryUnread() {}, loadMessageUnread() {}, loginWithWechat: async data => { calls.push(['login', data]); return { _id: 'u' } },
    callFunction: async (name, action, data) => { calls.push([action, data]); return { _id: 'u' } },
    ensureLogin: async () => ({ _id: 'u' }), showError() {}, setCachedUser() {}, navMethods: () => ({}), ...deps }
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    Page: config => { page = config }, Component: config => { page = config },
    require: () => defaults, getApp: () => ({ globalData: {} }),
    wx: { showToast() {}, showModal() {}, showLoading() {}, hideLoading() {}, redirectTo() {}, navigateBack() {}, pageScrollTo() {}, ...wxExtra },
    setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id)
  })
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if(callback) callback() }
  return { page, calls, timers }
}

test('login and profile forms cannot submit manually entered phone numbers', async () => {
  for (const file of ['pages/login/index', 'pages/client/profile/edit/index']) {
    const { page, calls } = load(file + '.js')
    page.data.form = { nickname: '用户', avatarUrl: '', phone: '13912345678' }
    if (page.saveAndEnter) await page.saveAndEnter()
    else await page.save()
    await flush()
    const payload = calls.find(call => call[0] === 'updateProfile')[1]
    assert.equal(Object.hasOwn(payload, 'phone'), false)
    const wxml = fs.readFileSync(path.join(root, file + '.wxml'), 'utf8')
    assert.match(wxml, /class="input-field phone-input"[^>]*disabled/)
    assert.doesNotMatch(wxml, /手动输入|直接输入手机号/)
  }
})

test('both login entries require an unchecked-by-default agreement and pass the version', async () => {
  for (const file of ['pages/login/index.js', 'pages/client/profile/index.js']) {
    const { page, calls } = load(file)
    assert.equal(page.data.loginAgreed, false)
    page.login()
    assert.equal(calls.length, 0)
    // Stop after the login request: later profile presentation belongs to other tests.
    page.syncUserTheme = page.syncUserFont = () => {}
    page.applyUser = page.loadStaffProfile = page.loadPoints = page.loadRewardMailUnread = () => {}
    page.onLoginConsentChange({ detail: { agreed: true } })
    page.login()
    assert.equal(calls[0][1].agreementVersion, '2026-10-23')
    await flush()
  }
})

test('AI backend failures restore the input and allow retry without invoking the client model', async () => {
  for (const message of ['AI 服务暂不可用', 'AI回答内容暂未通过安全检测']) {
    let modelCalls = 0
    const { page } = load('pages/client/ai-assistant/index.js', { callFunction: async () => { throw new Error(message) } },
      { cloud: { extend: { AI: { createModel() { modelCalls++; throw new Error('must not call') } } } } })
    page.data.inputText = '预约服务怎么做'
    await page.send()
    assert.equal(modelCalls, 0)
    assert.equal(page.data.loading, false)
    assert.equal(page.data.inputText, '预约服务怎么做')
    assert.equal(page.data.errorText, message)
    assert.equal(page.data.retryText, '预约服务怎么做')
  }
})

test('cancelled login never invokes AI and preserves the question', async () => {
  let invoked = false
  const { page } = load('pages/client/ai-assistant/index.js', { ensureLogin: async () => { throw { code: 'LOGIN_CANCELLED' } } },
    { cloud: { extend: { AI: { createModel() { invoked = true } } } } })
  page.data.inputText = '服务咨询'
  await page.send()
  assert.equal(invoked, false)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.inputText, '服务咨询')
})

test('AI backend timeout releases loading and ignores late output', async () => {
  let resolve
  const response = new Promise(done => { resolve = done })
  const { page, timers } = load('pages/client/ai-assistant/index.js', { callFunction: () => response })
  page.data.inputText = '如何预约'
  const pending = page.send()
  await flush()
  ;[...timers.values()][0]()
  await pending
  assert.equal(page.data.loading, false)
  assert.match(page.data.errorText, /超时/)
  resolve({ answer: 'late output' })
  await flush()
  assert.ok(!page.data.messages.some(message => message.content === 'late output'))
})

test('AI displays only the moderated backend response and clears its timeout', async () => {
  const requests = []
  const { page, timers } = load('pages/client/ai-assistant/index.js', { callFunction: async (...args) => { requests.push(args); return { answer: '可以预约' } } })
  page.data.inputText = '服务咨询'
  await page.send()
  assert.equal(requests[0][0], 'ai')
  assert.equal(requests[0][1], 'aiPetAssistant')
  assert.equal(requests[0][2].question, '服务咨询')
  assert.equal(page.data.messages.at(-1).content, '可以预约')
  assert.equal(page.data.loading, false)
  assert.equal(timers.size, 0)
  page.onUnload()
  assert.equal(timers.size, 0)
})

test('consent component opens both readable agreements and emits explicit checkbox changes', () => {
  const urls = []
  const { page } = load('components/login-consent/index.js', {}, { navigateTo: value => urls.push(value.url) })
  const changes = []
  page.data = { agreed: false }
  page.triggerEvent = (name, detail) => changes.push({ name, detail })
  page.methods.change.call(page, { detail: { value: ['agree'] } })
  assert.equal(changes.at(-1).detail.agreed, true)
  page.methods.change.call(page, { detail: { value: [] } })
  assert.equal(changes.at(-1).detail.agreed, false)
  for (const type of ['privacy', 'user_service']) page.methods.open.call(page, { currentTarget: { dataset: { type } } })
  assert.deepEqual(urls, ['/pages/common/agreement/index?type=privacy&mode=view', '/pages/common/agreement/index?type=user_service&mode=view'])
})
