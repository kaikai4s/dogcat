module.exports = function createHandler(context) {
  const {
    db,
    getOrderForAccess,
    getSystemSettings,
    hasCoordinate,
    now,
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
          recordedAt: point.recordedAt || uploadedAt,
          isBackfilled: point.isBackfilled === true || data.isBackfilled === true,
          uploadedAt
        }))
        .filter((point) => hasCoordinate(point.latitude, point.longitude))
      if (!points.length) throw new Error('轨迹点定位无效')
      let count = 0
      for (const point of points) {
        if (point.clientPointId) {
          const existing = await db.collection('track_logs').where({ orderId: data.orderId, clientPointId: point.clientPointId }).limit(1).get()
          if (existing.data[0]) continue
        }
        await db.collection('track_logs').add({ data: { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, clientPointId: point.clientPointId, batchId: point.batchId, latitude: point.latitude, longitude: point.longitude, speed: point.speed, accuracy: point.accuracy, recordedAt: point.recordedAt, isBackfilled: point.isBackfilled, uploadedAt: point.uploadedAt } })
        count += 1
      }
      return { count }
    }
    if (action === 'getOrderTracks') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('track_logs').where({ orderId: data.orderId }).orderBy('recordedAt', 'asc').get()
      return res.data
    }
    throw new Error('未知 track 操作')
  }
}
