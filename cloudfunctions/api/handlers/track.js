const { pointTime, isGoodTrackPoint, isPlausibleStep, filterTrackPoints } = require('../utils/trackQuality')

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
      const rawPoints = Array.isArray(data.points) ? data.points.slice(0, batchSize) : []
      if (!rawPoints.length) throw new Error('请上传轨迹点')
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
      const accepted = filterTrackPoints(await readScopedDocuments('track_logs', { orderId: data.orderId }, 'recordedAt', 'asc'))
      const uploadedTime = pointTime(uploadedAt)
      const serviceStart = pointTime(order.startedAt)
      let count = 0
      let rejectedCount = rawPoints.length - points.length
      let duplicateCount = 0
      for (const point of points.sort((a, b) => a.recordedAt - b.recordedAt)) {
        if (point.clientPointId) {
          const existing = await db.collection('track_logs').where({ orderId: data.orderId, clientPointId: point.clientPointId }).limit(1).get()
          if (existing.data[0]) { duplicateCount += 1; continue }
        }
        const earlier = accepted.filter((item) => pointTime(item.recordedAt) <= point.recordedAt).pop()
        const later = accepted.find((item) => pointTime(item.recordedAt) > point.recordedAt)
        if (!isGoodTrackPoint(point) || point.recordedAt > uploadedTime + 30000 ||
            point.recordedAt < Math.max(serviceStart ? serviceStart - 30000 : 0, uploadedTime - 7 * 24 * 3600000) ||
            (earlier && !isPlausibleStep(earlier, point)) || (later && !isPlausibleStep(point, later))) {
          rejectedCount += 1
          continue
        }
        await db.collection('track_logs').add({ data: { ...point, orderId: data.orderId, staffUserId: user._id, staffOpenid: openid } })
        accepted.push(point)
        accepted.sort((a, b) => pointTime(a.recordedAt) - pointTime(b.recordedAt))
        count += 1
      }
      return { count, rejectedCount, duplicateCount }
    }
    if (action === 'getOrderTracks') {
      await getOrderForAccess(openid, data.orderId)
      return filterTrackPoints(await readScopedDocuments('track_logs', { orderId: data.orderId }, 'recordedAt', 'asc'))
    }
    throw new Error('未知 track 操作')
  }
}
