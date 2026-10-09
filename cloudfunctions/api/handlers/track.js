const { pointTime, isGoodTrackPoint, isPlausibleStep, filterTrackPoints } = require('../utils/trackQuality')
const crypto = require('crypto')

module.exports = function createHandler(context) {
  const {
    db,
    getOrderForAccess,
    getSystemSettings,
    hasCoordinate,
    now,
    readScopedDocuments,
    requireStaffOrder,
    safeText
  } = context
  return async function track(openid, action, data) {
    if (action === 'batchUploadTrack') {
      const { user, order } = await requireStaffOrder(openid, data.orderId, '仅订单员工可上传轨迹')
      if (order.status !== 'in_service') throw new Error('仅服务中可上传轨迹')
      const uploadedAt = now()
      const settings = await getSystemSettings()
      const batchSize = settings.reliability.maxTrackBatchSize || 50
      const rawPoints = Array.isArray(data.points) ? data.points : []
      if (!rawPoints.length) throw new Error('请上传轨迹点')
      if (rawPoints.length > batchSize) throw new Error(`每批最多上传 ${batchSize} 个轨迹点`)
      const batchId = safeText(data.batchId).trim()
      const points = rawPoints
        .map((point) => ({
          clientPointId: safeText(point.clientPointId).trim(),
          batchId,
          latitude: Number(point.latitude),
          longitude: Number(point.longitude),
          speed: Number(point.speed || 0),
          accuracy: Number(point.accuracy || 0),
          recordedAt: pointTime(point.recordedAt),
          coordinateType: safeText(point.coordinateType || 'gcj02'),
          locationSource: safeText(point.locationSource || 'gps'),
          segmentId: safeText(point.segmentId).trim(),
          isBackfilled: point.isBackfilled === true || data.isBackfilled === true,
          uploadedAt
        }))
        .filter((point) => hasCoordinate(point.latitude, point.longitude))
      const uploadedTime = pointTime(uploadedAt)
      return db.runTransaction(async tx => {
        const current = (await tx.collection('orders').doc(data.orderId).get()).data
        if (!current || current.staffOpenid !== openid || current.status !== 'in_service') throw new Error('仅服务中可上传轨迹')
        const serviceStart = pointTime(current.startedAt)
        let count = 0
        let rejectedCount = rawPoints.length - points.length
        let duplicateCount = 0
        const accepted = []
        const acceptedIds = new Set()
        for (const point of points.sort((a, b) => a.recordedAt - b.recordedAt)) {
          const identity = point.clientPointId || JSON.stringify([point.recordedAt, point.latitude, point.longitude, point.segmentId])
          const id = `track_${crypto.createHash('sha256').update(JSON.stringify([data.orderId, identity])).digest('hex').slice(0, 32)}`
          if (acceptedIds.has(id)) { duplicateCount += 1; continue }
          let duplicate
          try { duplicate = (await tx.collection('track_logs').doc(id).get()).data } catch (error) {
            if (!String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) throw error
          }
          if (duplicate) { duplicateCount += 1; continue }
          if (point.clientPointId) {
            const existing = await db.collection('track_logs').where({ orderId: data.orderId, clientPointId: point.clientPointId }).limit(1).get()
            if (existing.data[0]) { duplicateCount += 1; continue }
          }
          const [before, after] = await Promise.all([
            db.collection('track_logs').where({ orderId: data.orderId, recordedAt: db.command.lte(point.recordedAt) }).orderBy('recordedAt', 'desc').orderBy('_id', 'desc').limit(20).get(),
            db.collection('track_logs').where({ orderId: data.orderId, recordedAt: db.command.gt(point.recordedAt) }).orderBy('recordedAt', 'asc').orderBy('_id', 'asc').limit(20).get()
          ])
          const neighbors = filterTrackPoints([...(before.data || []), ...(after.data || []), ...accepted])
          const earlier = neighbors.filter((item) => pointTime(item.recordedAt) <= point.recordedAt).pop()
          const later = neighbors.find((item) => pointTime(item.recordedAt) > point.recordedAt)
          if ((before.data.length === 20 && !earlier) || (after.data.length === 20 && !later)) throw new Error('历史轨迹质量异常，请核对后补传')
          if (!isGoodTrackPoint(point) || point.recordedAt > uploadedTime + 30000 ||
              point.recordedAt < Math.max(serviceStart ? serviceStart - 30000 : 0, uploadedTime - 7 * 24 * 3600000) ||
              (earlier && !isPlausibleStep(earlier, point)) || (later && !isPlausibleStep(point, later))) {
            rejectedCount += 1
            continue
          }
          await tx.collection('track_logs').doc(id).set({ data: { ...point, orderId: data.orderId, staffUserId: user._id, staffOpenid: openid } })
          accepted.push(point)
          acceptedIds.add(id)
          accepted.sort((a, b) => pointTime(a.recordedAt) - pointTime(b.recordedAt))
          count += 1
        }
        if (count) await tx.collection('orders').doc(data.orderId).update({ data: { trackRevision: Number(current.trackRevision || 0) + 1 } })
        return { count, rejectedCount, duplicateCount }
      })
    }
    if (action === 'getOrderTracks') {
      await getOrderForAccess(openid, data.orderId)
      return filterTrackPoints(await readScopedDocuments('track_logs', { orderId: data.orderId }, 'recordedAt', 'asc'))
    }
    throw new Error('未知 track 操作')
  }
}
