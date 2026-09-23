// Keep the cloud-function and both mini-program subpackage copies aligned; each ships independently.
const MAX_ACCURACY_M = 50
const MAX_GAP_MS = 2 * 60 * 1000
const MAX_SPEED_MPS = 8

function pointTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const text = String(value)
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (local) return Date.UTC(+local[1], +local[2] - 1, +local[3], +local[4] - 8, +local[5], +(local[6] || 0))
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function distanceM(a, b) {
  const rad = Math.PI / 180
  const lat1 = Number(a.latitude) * rad
  const lat2 = Number(b.latitude) * rad
  const dlat = lat2 - lat1
  const dlng = (Number(b.longitude) - Number(a.longitude)) * rad
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))))
}

function isGoodTrackPoint(point) {
  if (!point) return false
  const lat = Number(point.latitude)
  const lng = Number(point.longitude)
  const accuracy = Number(point.accuracy)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) &&
    Number.isFinite(accuracy) && accuracy > 0 && accuracy <= MAX_ACCURACY_M &&
    (!point.locationSource || point.locationSource === 'gps') &&
    (!point.coordinateType || point.coordinateType === 'gcj02') && pointTime(point.recordedAt) > 0
}

function isPlausibleStep(previous, point) {
  const elapsed = pointTime(point.recordedAt) - pointTime(previous.recordedAt)
  if (elapsed <= 0) return false
  // A collection gap provides no evidence of the route between its endpoints.
  if (elapsed > MAX_GAP_MS) return true
  const uncertainty = Number(previous.accuracy) + Number(point.accuracy)
  return distanceM(previous, point) <= MAX_SPEED_MPS * elapsed / 1000 + uncertainty
}

function filterTrackPoints(points = []) {
  const sorted = points.filter(isGoodTrackPoint).slice().sort((a, b) => pointTime(a.recordedAt) - pointTime(b.recordedAt))
  const accepted = []
  for (let index = 0; index < sorted.length; index += 1) {
    const point = sorted[index]
    const previous = accepted[accepted.length - 1]
    // Discard a lone startup fix that is inconsistent with the next two fixes.
    if (!previous && sorted[index + 2] && !isPlausibleStep(point, sorted[index + 1]) &&
        isPlausibleStep(sorted[index + 1], sorted[index + 2])) continue
    if (previous && !isPlausibleStep(previous, point)) continue
    const breakBefore = !previous ||
      pointTime(point.recordedAt) - pointTime(previous.recordedAt) > MAX_GAP_MS ||
      (point.segmentId && previous.segmentId && point.segmentId !== previous.segmentId)
    accepted.push({ ...point, breakBefore: Boolean(breakBefore) })
  }
  return accepted
}

module.exports = { MAX_ACCURACY_M, MAX_GAP_MS, pointTime, distanceM, isGoodTrackPoint, isPlausibleStep, filterTrackPoints }
