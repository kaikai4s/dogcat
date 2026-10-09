const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setup() {
  let time = 1000
  const storage = { vip_pet_offline_tasks: [{ id: 'legacy', orderId: 'order', payload: {} }] }
  const app = { globalData: { user: { _id: 'first' } } }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/offlineQueue.js'), 'utf8'), {
    module, getApp: () => app, Date: { now: () => time },
    wx: { getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value } }
  })
  return { api: module.exports, app, storage, advance: ms => { time += ms } }
}

test('offline records belong to their account; legacy and logged-out records never upload', () => {
  const { api, app, storage } = setup()
  const task = api.enqueueOfflineTask('track', { orderId: 'order', clientPointId: 'same' })
  assert.equal(api.getOfflineTaskCount('order'), 1)
  assert.equal(api.getUnownedOfflineTaskCount('order'), 1)
  app.globalData.user = { _id: 'second' }
  assert.equal(api.getOfflineTaskCount(), 0)
  api.enqueueOfflineTask('track', { orderId: 'order', clientPointId: 'same' })
  api.removeOfflineTask(task.id, task.ownerId)
  api.updateOfflineTask({ ...task, status: 'blocked' })
  assert.equal(storage.vip_pet_offline_tasks.find(row => row.ownerId === 'first').status, 'pending')
  assert.equal(api.getOfflineTaskCount(), 1)
  app.globalData.user = null
  assert.equal(api.getOfflineTaskCount(), 0)
  assert.throws(() => api.enqueueOfflineTask('track'), /登录/)
  assert.equal(storage.vip_pet_offline_tasks.length, 3)
})

test('offline network retries back off and stop; manual retry preserves payload', () => {
  const { api } = setup()
  api.enqueueOfflineTask('checkin', { orderId: 'order', clientRequestId: 'checkin', mediaFileId: 'photo' })
  for (let attempt = 1; attempt <= 6; attempt++) {
    api.failOfflineTask(api.getOfflineTasks()[0], new Error('timeout'), true)
    const task = api.getOfflineTasks()[0]
    assert.equal(task.retryTimes, attempt)
    assert.equal(task.status, attempt < 6 ? 'pending' : 'blocked')
    assert.ok(task.nextAttemptAt >= 1000 + 5000 * 2 ** (attempt - 1))
  }
  api.retryOfflineTasks('order')
  const retried = api.getOfflineTasks()[0]
  assert.equal(retried.status, 'pending')
  assert.equal(retried.nextAttemptAt, 0)
  assert.equal(retried.payload.mediaFileId, 'photo')
  api.failOfflineTask(retried, new Error('not authorized'), false)
  assert.equal(api.getOfflineTasks()[0].status, 'blocked')
})

test('parallel flushes share one request, release failures, and stop after account switch', async () => {
  const { api, app } = setup()
  let finish, calls = 0
  const worker = owner => { calls++; assert.equal(owner, 'first'); return new Promise(resolve => { finish = resolve }) }
  const first = api.withOfflineFlush('order', worker)
  assert.equal(api.withOfflineFlush('order', worker), first)
  await Promise.resolve()
  assert.equal(calls, 1)
  app.globalData.user = { _id: 'second' }
  assert.equal(api.isOfflineOwner('first'), false)
  finish()
  await first
  await assert.rejects(api.withOfflineFlush('order', () => Promise.reject(new Error('failed'))), /failed/)
  await api.withOfflineFlush('order', () => { calls++ })
  assert.equal(calls, 2)
})
