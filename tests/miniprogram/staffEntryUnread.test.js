const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function setup() {
  let user = { _id: 'staff', roles: ['client', 'staff'] }
  const requests = [], timers = new Map()
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/client-nav.js'), 'utf8'), {
    module, require: () => ({ getCurrentUser: async () => user,
      callFunction: (name, action) => new Promise(resolve => requests.push({ name, action, resolve })) }),
    setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id)
  })
  const page = { data: { messageUnreadCount: 7 }, setData(patch) { Object.assign(this.data, patch) } }
  return { api: module.exports, page, requests, timers, setUser(value) { user = value } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('staff entry has an independent numeric badge and refreshes without switching role', async () => {
  const { api, page, requests, timers } = setup()
  const pending = api.startStaffEntryUnread(page)
  await flush()
  assert.equal(requests[0].name, 'staffMessage')
  requests[0].resolve({ totalUnread: 120 })
  await pending
  assert.equal(page.data.staffUnreadCountText, '99+')
  assert.equal(page.data.messageUnreadCount, 7)
  const refresh = [...timers.values()][0]()
  await flush()
  requests[1].resolve({ totalUnread: 0 })
  await refresh
  assert.equal(page.data.staffUnreadCount, 0)
  api.stopStaffEntryUnread(page)
})

test('hidden pages ignore late responses and stop polling', async () => {
  const { api, page, requests, timers } = setup()
  const pending = api.startStaffEntryUnread(page)
  await flush()
  api.stopStaffEntryUnread(page)
  requests[0].resolve({ totalUnread: 5 })
  await pending
  assert.equal(page.data.staffUnreadCount, undefined)
  assert.equal(timers.size, 0)
})

test('non-staff and logged-out users cannot inherit staff badges', async () => {
  const { api, page, requests, setUser } = setup()
  page.data.staffUnreadCount = 9
  setUser({ _id: 'client', roles: ['client'] })
  await api.startStaffEntryUnread(page)
  assert.equal(requests.length, 0)
  assert.equal(page.data.staffUnreadCount, 0)
  setUser({ _id: 'staff', roles: ['staff'] })
  const pending = api.startStaffEntryUnread(page)
  await flush()
  setUser(null)
  requests[0].resolve({ totalUnread: 5 })
  await pending
  assert.equal(page.data.staffUnreadCount, 0)
  api.stopStaffEntryUnread(page)
})


test('late login callbacks cannot restart polling after the page is hidden', async () => {
  const { api, page, requests, timers } = setup()
  page._staffEntryVisible = false
  await api.startStaffEntryUnread(page)
  assert.equal(requests.length, 0)
  assert.equal(timers.size, 0)
})
