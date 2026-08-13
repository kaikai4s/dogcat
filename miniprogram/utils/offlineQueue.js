const OFFLINE_TASK_KEY = 'vip_pet_offline_tasks'

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
  const task = {
    id: payload.clientRequestId || payload.clientPointId || createClientRequestId(type),
    type,
    orderId: payload.orderId || '',
    payload,
    retryTimes: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  writeTasks([...readTasks().filter((item) => item.id !== task.id), task])
  return task
}

function getOfflineTasks(orderId = '') {
  return readTasks().filter((task) => !orderId || task.orderId === orderId)
}

function getOfflineTaskCount(orderId = '') {
  return getOfflineTasks(orderId).length
}

function removeOfflineTask(id) {
  writeTasks(readTasks().filter((task) => task.id !== id))
}

function updateOfflineTask(task) {
  const tasks = readTasks()
  const index = tasks.findIndex((item) => item.id === task.id)
  if (index < 0) return
  tasks[index] = { ...tasks[index], ...task, updatedAt: Date.now() }
  writeTasks(tasks)
}

module.exports = {
  createClientRequestId,
  enqueueOfflineTask,
  getOfflineTasks,
  getOfflineTaskCount,
  removeOfflineTask,
  updateOfflineTask
}
