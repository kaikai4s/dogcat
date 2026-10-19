const { callFunction } = require('./cloud')
const { withOfflineFlush, getOfflineTasks, getUnownedOfflineTaskCount, isOfflineOwner,
  createClientRequestId, removeOfflineTask, failOfflineTask } = require('./offlineQueue')

function counts(orderId) {
  const tasks = getOfflineTasks(orderId)
  return { offlineTaskCount: tasks.length,
    offlineBlockedCount: tasks.filter(task => task.status === 'blocked').length,
    offlineUnownedCount: getUnownedOfflineTaskCount(orderId) }
}

function flushServiceOfflineTasks(orderId) {
  return Promise.resolve(withOfflineFlush(orderId, async ownerId => {
    let flushed = false
    const tasks = getOfflineTasks(orderId).filter(task => task.status !== 'blocked' && Number(task.nextAttemptAt || 0) <= Date.now())
    for (const task of tasks) {
      if (!isOfflineOwner(ownerId)) break
      try {
        if (task.type === 'track') {
          const result = await callFunction('track', 'batchUploadTrack', {
            orderId: task.orderId, batchId: createClientRequestId('backfill'), points: [task.payload.point]
          })
          if (!Number(result && result.count || 0) && !Number(result && result.duplicateCount || 0)) throw new Error('轨迹未通过校验，请核对记录')
        } else if (task.type === 'checkin') {
          await callFunction('checkin', 'createCheckin', { ...task.payload, isBackfilled: true })
        } else if (task.type === 'key_return') {
          await callFunction('homeSecurity', 'recordKeyReturned', task.payload)
        } else {
          throw new Error('待补传数据类型无法识别，请联系管理员')
        }
        if (!isOfflineOwner(ownerId)) break
        removeOfflineTask(task.id, ownerId)
        flushed = true
      } catch (error) {
        if (!isOfflineOwner(ownerId)) break
        failOfflineTask(task, error, /network|timeout|fail/i.test(error && (error.message || error.errMsg) || ''))
      }
    }
    return { flushed, ...(isOfflineOwner(ownerId) ? counts(orderId) : {
      offlineTaskCount: 0, offlineBlockedCount: 0, offlineUnownedCount: 0
    }) }
  })).then(result => result || { flushed: false, ...counts(orderId) })
}

module.exports = { flushServiceOfflineTasks }
