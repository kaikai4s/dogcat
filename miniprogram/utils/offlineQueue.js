const OFFLINE_TASK_KEY = 'vip_pet_offline_tasks'
const flushes = new Map()

function currentOwner() {
  const user = getApp().globalData.user
  return user && (user._id || user.openid) || ''
}

function createClientRequestId(prefix = 'task') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function readTasks() {
  const tasks = wx.getStorageSync(OFFLINE_TASK_KEY)
  return Array.isArray(tasks) ? tasks : []
}

function writeTasks(tasks) {
  wx.setStorageSync(OFFLINE_TASK_KEY, Array.isArray(tasks) ? tasks : [])
}

function enqueueOfflineTask(type, payload = {}) {
  const ownerId = currentOwner()
  if (!ownerId) throw new Error('请登录后保存待补传数据')
  const task = {
    ownerId,
    id: payload.clientRequestId || payload.clientPointId || createClientRequestId(type),
    type,
    orderId: payload.orderId || '',
    payload,
    retryTimes: 0,
    status: 'pending',
    nextAttemptAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  writeTasks([...readTasks().filter((item) => item.id !== task.id || item.ownerId !== ownerId), task])
  return task
}

function getOfflineTasks(orderId = '') {
  const ownerId = currentOwner()
  return ownerId ? readTasks().filter((task) => task.ownerId === ownerId && (!orderId || task.orderId === orderId)) : []
}

function getOfflineTaskCount(orderId = '') {
  return getOfflineTasks(orderId).length
}

function removeOfflineTask(id, ownerId = currentOwner()) {
  if (!ownerId || ownerId !== currentOwner()) return
  writeTasks(readTasks().filter((task) => task.id !== id || task.ownerId !== ownerId))
}

function updateOfflineTask(task) {
  const ownerId = currentOwner()
  if (!ownerId || task.ownerId !== ownerId) return
  const tasks = readTasks()
  const index = tasks.findIndex((item) => item.id === task.id && item.ownerId === ownerId)
  if (index < 0) return
  tasks[index] = { ...tasks[index], ...task, updatedAt: Date.now() }
  writeTasks(tasks)
}

function failOfflineTask(task, error, retryable) {
  const retryTimes = Number(task.retryTimes || 0) + 1
  updateOfflineTask({ ...task, retryTimes,
    status: retryable && retryTimes < 6 ? 'pending' : 'blocked',
    nextAttemptAt: Date.now() + Math.min(300000, 5000 * 2 ** Math.min(retryTimes - 1, 6)),
    lastError: String(error && error.message || '补传失败').slice(0, 100)
  })
}

function retryOfflineTasks(orderId) {
  getOfflineTasks(orderId).forEach(task => updateOfflineTask({ ...task, retryTimes: 0, status: 'pending', nextAttemptAt: 0, lastError: '' }))
}

function withOfflineFlush(orderId, worker) {
  const ownerId = currentOwner()
  if (!ownerId) return Promise.resolve()
  const key = JSON.stringify([ownerId, orderId])
  if (flushes.has(key)) return flushes.get(key)
  const result = Promise.resolve().then(() => worker(ownerId)).finally(() => flushes.delete(key))
  flushes.set(key, result)
  return result
}

function isOfflineOwner(ownerId) { return Boolean(ownerId) && currentOwner() === ownerId }

// Old unowned tasks remain in storage until their original account is verified.
function getUnownedOfflineTaskCount(orderId) {
  return readTasks().filter(task => !task.ownerId && (!orderId || task.orderId === orderId)).length
}

module.exports = {
  createClientRequestId,
  enqueueOfflineTask,
  getOfflineTasks,
  getOfflineTaskCount,
  removeOfflineTask,
  updateOfflineTask,
  failOfflineTask,
  retryOfflineTasks,
  withOfflineFlush,
  isOfflineOwner,
  getUnownedOfflineTaskCount
}
