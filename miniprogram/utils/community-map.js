function validPoint(point) {
  return !!point && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)) &&
    Math.abs(Number(point.latitude)) <= 85 && Math.abs(Number(point.longitude)) <= 180 && Number(point.latitude) !== 0 && Number(point.longitude) !== 0
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
module.exports = { validPoint, inRegion, clusterCommunities }
