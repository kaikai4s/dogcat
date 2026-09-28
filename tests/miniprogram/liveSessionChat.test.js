const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../../miniprogram')
const files = ['pages/client/orders/detail/index.js', 'pages/staff/orders/service/index.js']
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function loadChat(file, fetch) {
  let page
  let timerId = 0
  const timers = new Map()
  const clock = {
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId },
    clearTimeout(id) { timers.delete(id) }
  }
  const deps = { navMethods: () => ({}), ensureLogin: async () => ({}), callFunction: fetch }
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    Page(config) { page = config }, ...clock, console,
    require(name) {
      if (name.endsWith('/sessionChat')) {
        const module = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.resolve(root, path.dirname(file), name + '.js'), 'utf8'), { module, ...clock })
        return module.exports
      }
      return deps
    }
  })
  page.setData = function (data, callback) { Object.assign(this.data, data); if (callback) callback.call(this) }
  page.data.id = 'order'
  for (const name of ['load', 'loadOrder', 'applyCurrentTheme', 'stopEarlyStartPolling', 'stopAutoTracking', 'stopServiceElapsedTimer']) page[name] = () => {}
  const tick = async (delay) => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay)
    assert.ok(entry, `expected timer ${delay}`)
    timers.delete(entry[0]); entry[1].fn(); await flush()
  }
  return { page, timers, tick }
}

for (const file of files) {
  test(`${file}: open chat receives messages, preserves drafts/history scroll, pauses and resumes`, async () => {
    let messages = [{ _id: '1', content: '你好' }]
    const { page, tick, timers } = loadChat(file, async () => messages)
    page.openSessionChat()
    await flush()
    assert.equal(page.data.sessionMessages.length, 1)
    page.data.sessionInputText = '还没发出的草稿'
    page._chatScrollTop = 100
    page.onSessionChatScroll({ detail: { scrollTop: 20 } })
    const target = page.data.sessionScrollTarget
    messages = [...messages, { _id: '2', content: '新回复' }]
    await tick(2000)
    assert.equal(page.data.sessionMessages.length, 2)
    assert.equal(page.data.sessionInputText, '还没发出的草稿')
    assert.equal(page.data.sessionScrollTarget, target)
    assert.equal(page.data.sessionUnreadCount, 1)
    page.scrollSessionChatToBottom()
    assert.equal(page.data.sessionScrollTarget, 'session-message-1')
    page.onHide()
    assert.equal(timers.size, 0)
    messages = [...messages, { _id: '3', content: '回来时的新回复' }]
    page.onShow()
    await flush()
    assert.equal(page.data.sessionMessages.length, 3)
    page.closeSessionChat()
    assert.equal(timers.size, 0)
  })

  test(`${file}: in-flight results after close are ignored and failures retry without losing messages`, async () => {
    let resolve
    let calls = 0
    const { page, tick, timers } = loadChat(file, () => {
      calls++
      if (calls === 1) return new Promise((r) => { resolve = r })
      if (calls === 2) return Promise.reject(new Error('offline'))
      return Promise.resolve([{ _id: 'new', content: '已恢复' }])
    })
    page.openSessionChat()
    await flush()
    page.loadSessionMessages()
    assert.equal(calls, 1, 'requests must not overlap')
    page.closeSessionChat()
    resolve([{ _id: 'old' }])
    await flush()
    assert.equal(page.data.sessionMessages.length, 0)
    assert.equal(timers.size, 0)
    page.openSessionChat()
    await flush()
    assert.match(page.data.sessionChatError, /重试/)
    await tick(2000)
    assert.equal(page.data.sessionMessages[0]._id, 'new')
    assert.equal(page.data.sessionChatError, '')
    page.onUnload()
    assert.equal(timers.size, 0)
  })
}

test('chat helpers remain identical inside their consuming subpackages', () => {
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(read('pages/staff/utils/sessionChat.js'), read('pages/client/orders/utils/sessionChat.js'))
})
