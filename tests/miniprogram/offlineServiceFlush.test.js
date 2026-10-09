const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('service backfill retains rejected tracks and only removes accepted or duplicate points', async () => {
  let page
  const storage = {}
  const app = { globalData: { user: { _id: 'staff' } } }
  const wx = { getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value } }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/offlineQueue.js'), 'utf8'), {
    module, getApp: () => app, wx
  })
  const queue = module.exports
  const track = id => queue.enqueueOfflineTask('track', { orderId: 'order', clientPointId: id, point: { clientPointId: id } })
  track('rejected'); track('accepted'); track('duplicate')
  queue.enqueueOfflineTask('unknown', { orderId: 'order', clientRequestId: 'unknown' })
  const calls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/staff/orders/service/index.js'), 'utf8'), {
    Page: definition => { page = definition }, wx,
    require: name => name.endsWith('/offlineQueue') ? queue : name.endsWith('/sessionChat') ? { sessionChatMethods: () => ({}) }
      : name.endsWith('/nav') ? { navMethods: () => ({}) } : name.endsWith('/cloud') ? {
      callFunction: async (module, action, data) => {
        calls.push({ module, action, data })
        if (module === 'order') return { _id: 'order', trackCount: 2 }
        return data.points[0].clientPointId === 'rejected' ? { count: 0, rejectedCount: 1 }
          : data.points[0].clientPointId === 'duplicate' ? { count: 0, duplicateCount: 1 } : { count: 1 }
      }
    } : {}
  })
  page.data.id = 'order'
  page.setData = changes => Object.assign(page.data, changes)
  await page.flushOfflineTasks()
  const remaining = queue.getOfflineTasks('order')
  assert.equal(remaining.map(task => task.id).join(','), 'rejected,unknown')
  assert.ok(remaining.every(task => task.status === 'blocked'))
  assert.equal(remaining[0].payload.point.clientPointId, 'rejected')
  assert.equal(page.data.offlineTaskCount, 2)
  assert.equal(page.data.offlineBlockedCount, 2)
  assert.equal(calls.filter(call => call.module === 'track').length, 3)
  await page.flushOfflineTasks()
  assert.equal(calls.filter(call => call.module === 'track').length, 3)
})
