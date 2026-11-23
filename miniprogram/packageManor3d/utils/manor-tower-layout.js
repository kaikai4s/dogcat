// Public building sites surveyed on the south bank of the Clearbrook terrain.
// Shortlists keep the buildings grouped near existing walks and leave the
// separate home plots available to residents.
const SITES = [
  { id: 'west', x: -44, z: 133.5, turn: 0 },
  { id: 'walk', x: -1, z: 132.5, turn: 1 },
  { id: 'east', x: 107, z: 133.5, turn: 2 },
  { id: 'south-east', x: -99, z: 208.5, turn: 0 },
  { id: 'south', x: -153, z: 210, turn: 0 },
  { id: 'south-west', x: -207, z: 210, turn: 0 },
]
const SITE_CLEARANCE = 3
const BUILDING_GAP = 5
const MAX_SLOPE_DELTA = .08
const finite = Number.isFinite

function neighborhoodRandom(communityId) {
  const key = 'manor-towers-v1:' + (communityId || 'local')
  let state = 2166136261
  for (let index = 0; index < key.length; index++) state = Math.imul(state ^ key.charCodeAt(index), 16777619)
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0
    return (state >>> 0) / 4294967296
  }
}

function overlaps(a, b, gap) {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap &&
    Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 + gap
}

function distanceToFootprint(rect, point) {
  return Math.hypot(Math.max(0, Math.abs(rect.x - point.x) - rect.width / 2),
    Math.max(0, Math.abs(rect.z - point.z) - rect.depth / 2))
}

function groundAt(site, config, navigation, spawn) {
  const { x, z, width, depth } = site
  const radiusX = width / 2 + SITE_CLEARANCE, radiusZ = depth / 2 + SITE_CLEARANCE
  if (Math.abs(x) + radiusX >= config.width / 2 || Math.abs(z) + radiusZ >= config.depth / 2 ||
      config.plots.some(plot => overlaps(site, plot, SITE_CLEARANCE)) ||
      (config.crossings || []).some(bridge => distanceToFootprint(site, bridge) < bridge.length / 2 + 9) ||
      (config.landmarkTrees || []).some(tree => distanceToFootprint(site, tree) < tree.r + SITE_CLEARANCE) ||
      (spawn && distanceToFootprint(site, spawn) < 10)) return null

  // The foundation top sits on the meadow. Use a grid fine enough to detect
  // the 2.55 m trails as well as the creek bank and other broken ground.
  const base = navigation.sample(x, z)
  if (!finite(base) || Math.abs(base - config.ground) > MAX_SLOPE_DELTA) return null
  const cols = Math.ceil(2 * radiusX / 1.5), rows = Math.ceil(2 * radiusZ / 1.5)
  for (let row = 0; row <= rows; row++) {
    const pz = z + (row * 2 / rows - 1) * radiusZ
    for (let col = 0; col <= cols; col++) {
      const px = x + (col * 2 / cols - 1) * radiusX
      const y = navigation.sample(px, pz)
      if (!finite(y) || Math.abs(y - base) > MAX_SLOPE_DELTA || navigation.hasPath(px, pz)) return null
    }
  }
  return base
}

function createManorTowerLayout({ config, navigation, communityId, footprint }) {
  const { width, depth } = footprint || {}
  if (![width, depth, config?.width, config?.depth, config?.ground].every(finite) ||
      Math.min(width, depth) <= 0 || !Array.isArray(config.plots) ||
      typeof navigation?.sample !== 'function' || typeof navigation.hasPath !== 'function') return []

  const next = neighborhoodRandom(communityId)
  const count = 3 + Math.floor(next() * 2)
  const spawn = navigation.spawn?.()
  const sites = SITES.map(site => ({ site, rank: next() }))
  // Keep the nearest buildings on the bridge approach, and pick the rest
  // along the public south walk. The same neighborhood always sees one layout.
  sites.sort((a, b) => Number(a.site.z > 170) - Number(b.site.z > 170) || a.rank - b.rank)
  const placed = []
  for (const { site } of sites) {
    const dx = (next() - .5) * 2.4, dz = (next() - .5) * 1.2
    for (const [x, z] of [[site.x + dx, site.z + dz], [site.x, site.z]]) {
      const odd = site.turn % 2 === 1
      const tower = { id: 'tower-' + site.id, x, z, yaw: site.turn * Math.PI / 2,
        width: odd ? depth : width, depth: odd ? width : depth }
      if (placed.some(another => overlaps(tower, another, BUILDING_GAP))) continue
      const y = groundAt(tower, config, navigation, spawn)
      if (y === null) continue
      placed.push({ ...tower, y })
      break
    }
    if (placed.length === count) break
  }
  // Geometry, minimap order and scene IDs are independent of draw or fetch order.
  return placed.sort((a, b) => a.x - b.x)
}

module.exports = { createManorTowerLayout }
