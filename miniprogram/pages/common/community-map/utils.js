function validPoint(point) {
  return !!point && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)) &&
    Math.abs(Number(point.latitude)) <= 85 && Math.abs(Number(point.longitude)) <= 180 && Number(point.latitude) !== 0 && Number(point.longitude) !== 0
}
function locationCity(location) {
  if (location?.city) return String(location.city).trim()
  const text = `${location?.address || ''}${location?.name || ''}`
  const direct = text.match(/(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/)
  if (direct) return direct[1]
  const city = text.match(/(?:.*省|.*自治区)?([^省自治区特别行政区]{2,20}市|[^省自治区特别行政区]{2,20}自治州|[^省自治区特别行政区]{2,20}地区|[^省自治区特别行政区]{2,20}盟)/)
  return city ? city[1] : ''
}
function project(point, scale) {
  const sin = Math.sin(Number(point.latitude) * Math.PI / 180), size = 256 * Math.pow(2, scale)
  return { x: (Number(point.longitude) + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size }
}
function inRegion(point, region) {
  if (!region || !validPoint(region.southwest) || !validPoint(region.northeast)) return true
  return point.latitude >= region.southwest.latitude && point.latitude <= region.northeast.latitude &&
    point.longitude >= region.southwest.longitude && point.longitude <= region.northeast.longitude
}
function clusterCommunities(communities, scale = 14, region) {
  const visible = communities.filter(point => validPoint(point) && point.count > 0 && inRegion(point, region))
    .slice().sort((a, b) => a._id.localeCompare(b._id))
  let gridSize = 62, result
  do {
    const buckets = new Map()
    for (const point of visible) {
      const p = project(point, scale), key = `${Math.floor(p.x / gridSize)}:${Math.floor(p.y / gridSize)}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(point)
    }
    result = [...buckets.values()].map(members => ({
      key: members.map(p => p._id).join('|'), members, count: members.reduce((sum, p) => sum + p.count, 0),
      latitude: members.reduce((sum, p) => sum + Number(p.latitude), 0) / members.length,
      longitude: members.reduce((sum, p) => sum + Number(p.longitude), 0) / members.length
    }))
    gridSize *= 1.5
  } while (result.length > 60)
  return result
}
const VIEWPORT_TTL = 7 * 24 * 60 * 60 * 1000
function viewportKey(scope, data, reference) {
  return JSON.stringify([scope, data.mode, String(data.city || '').trim(), data.filterDate || '', data.orderKind,
    !!data.onlyDirect, !!data.inServiceRange, !!data.inServiceTime, data.staffGenderRequirement,
    data.mode === 'orders' && validPoint(reference) ? [Number(reference.latitude), Number(reference.longitude)] : null])
}
function readViewport(cache, key, now = Date.now()) {
  if (!Array.isArray(cache)) return null
  const row = cache.find(item => item && item.key === key)
  if (!row || !validPoint(row) || !Number.isFinite(row.scale) || row.scale < 5 || row.scale > 19 ||
      !Number.isFinite(row.savedAt) || now - row.savedAt < 0 || now - row.savedAt > VIEWPORT_TTL) return null
  return { latitude: Number(row.latitude), longitude: Number(row.longitude), scale: row.scale }
}
function storeViewport(cache, key, point, now = Date.now()) {
  if (!validPoint(point) || !Number.isFinite(point.scale) || point.scale < 5 || point.scale > 19) return cache
  const others = (Array.isArray(cache) ? cache : []).filter(row => typeof row?.key === 'string' && row.key !== key && readViewport([row], row.key, now))
    .map(row => ({ key: row.key, ...readViewport([row], row.key, now), savedAt: row.savedAt }))
  // Store camera geometry only. Never persist cards, task IDs, or personal profiles.
  return [{ key, latitude: Number(point.latitude), longitude: Number(point.longitude), scale: point.scale, savedAt: now }, ...others].slice(0, 12)
}
module.exports = { validPoint, locationCity, inRegion, clusterCommunities, viewportKey, readViewport, storeViewport }
