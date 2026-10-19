const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('service backfill retains rejected tracks and only removes accepted or duplicate points', async () => {
  const storage = {}
  const app = { globalData: { user: { _id: 'staff' } } }
  const wx = { getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value } }
  const queueModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/offlineQueue.js'), 'utf8'), {
    module: queueModule, getApp: () => app, wx
  })
  const queue = queueModule.exports
  const track = id => queue.enqueueOfflineTask('track', { orderId: 'order', clientPointId: id, point: { clientPointId: id } })
  track('rejected'); track('accepted'); track('duplicate')
  queue.enqueueOfflineTask('unknown', { orderId: 'order', clientRequestId: 'unknown' })
  const calls = []
  const syncModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/serviceOfflineSync.js'), 'utf8'), {
    module: syncModule,
    require: name => name.endsWith('/offlineQueue') ? queue : {
      callFunction: async (module, action, data) => {
        calls.push({ module, action, data })
        return data.points[0].clientPointId === 'rejected' ? { count: 0, rejectedCount: 1 }
          : data.points[0].clientPointId === 'duplicate' ? { count: 0, duplicateCount: 1 } : { count: 1 }
      }
    }
  })
  const { flushServiceOfflineTasks } = syncModule.exports
  const result = await flushServiceOfflineTasks('order')
  const remaining = queue.getOfflineTasks('order')
  assert.equal(remaining.map(task => task.id).join(','), 'rejected,unknown')
  assert.ok(remaining.every(task => task.status === 'blocked'))
  assert.equal(remaining[0].payload.point.clientPointId, 'rejected')
  assert.equal(result.flushed, true)
  assert.equal(result.offlineTaskCount, 2)
  assert.equal(result.offlineBlockedCount, 2)
  assert.equal(calls.filter(call => call.module === 'track').length, 3)
  await flushServiceOfflineTasks('order')
  assert.equal(calls.filter(call => call.module === 'track').length, 3)
})
