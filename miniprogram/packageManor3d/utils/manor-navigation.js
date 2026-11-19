const PLAYER_RADIUS = 0.30
const EPSILON = 1e-5
const label = object => String(object.name || '').replace(/_/g, ' ')

function interval(length, valueAt, value) {
  if (length < 2 || value < valueAt(0) - EPSILON || value > valueAt(length - 1) + EPSILON) return -1
  let lo = 0, hi = length - 1
  while (hi - lo > 1) {
    const middle = (lo + hi) >>> 1
    if (valueAt(middle) <= value) lo = middle
    else hi = middle
  }
  return lo
}

function triangleHeight(x, z, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
  if (Math.abs(det) < 1e-9) return null
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
  if (u < -EPSILON || v < -EPSILON || u + v > 1 + EPSILON) return null
  return u * ay + v * by + (1 - u - v) * cy
}

function localSurface(THREE, mesh) {
  const attribute = mesh.geometry.getAttribute('position')
  const inverse = mesh.matrixWorld.clone().invert()
  const point = new THREE.Vector3()
  const e = mesh.matrixWorld.elements
  // Navigation surfaces are exported Y-up, with optional yaw and translation.
  if (Math.abs(e[1]) + Math.abs(e[9]) + Math.abs(e[4]) + Math.abs(e[6]) > 1e-5) {
    throw new Error('庄园地面方向有误')
  }
  return {
    attribute,
    point(x, z) { return point.set(x, 0, z).applyMatrix4(inverse) },
    height(y) { return y === null ? null : y * e[5] + e[13] }
  }
}

// The meadow follows the winding banks: x is regular by column while each
// column has its own increasing z coordinates. Find one cell with two binary
// searches, then interpolate its actual exported triangles.
function gridSurface(THREE, mesh) {
  const surface = localSurface(THREE, mesh)
  const p = surface.attribute
  if (!p || p.count < 4) return null
  let columns = 1
  while (columns < p.count && p.getX(columns) > p.getX(columns - 1)) columns++
  const rows = p.count / columns
  if (columns < 2 || !Number.isInteger(rows) || rows < 2) return null
  for (let row = 1; row < rows; row++) {
    if (Math.abs(p.getX(row * columns) - p.getX(0)) > EPSILON ||
        p.getZ(row * columns) <= p.getZ((row - 1) * columns)) return null
  }
  function column(x) {
    const i = interval(columns, j => p.getX(j), x)
    if (i < 0) return null
    return { i, t: (x - p.getX(i)) / (p.getX(i + 1) - p.getX(i)) }
  }
  function atRow(row, i, t) {
    const a = row * columns + i
    return p.getZ(a) * (1 - t) + p.getZ(a + 1) * t
  }
  return {
    sample(x, z) {
      const q = surface.point(x, z), col = column(q.x)
      if (!col) return null
      const { i, t } = col
      const row = interval(rows, j => atRow(j, i, t), q.z)
      if (row < 0) return null
      const a = row * columns + i, b = a + columns
      const height = (a, b, c) => triangleHeight(q.x, q.z,
        p.getX(a), p.getY(a), p.getZ(a), p.getX(b), p.getY(b), p.getZ(b), p.getX(c), p.getY(c), p.getZ(c))
      const first = height(a, b, a + 1)
      return surface.height(first === null ? height(a + 1, b, b + 1) : first)
    },
    contains(x, z, margin) {
      const q = surface.point(x, z), col = column(q.x)
      return !!col && q.z >= atRow(0, col.i, col.t) - margin &&
        q.z <= atRow(rows - 1, col.i, col.t) + margin
    }
  }
}

// Small walkways use local buckets. No world-sized triangle scan occurs while
// moving, and mesh buffers stay shared with the renderer.
function triangleSurface(THREE, mesh, upwardOnly = false) {
  const surface = localSurface(THREE, mesh)
  const p = surface.attribute, index = mesh.geometry.index
  const buckets = new Map(), cell = 3
  const vertex = i => index ? index.getX(i) : i
  const key = (x, z) => x + ',' + z
  const length = index ? index.count : p.count
  for (let i = 0; i + 2 < length; i += 3) {
    const a = vertex(i), b = vertex(i + 1), c = vertex(i + 2)
    const ax = p.getX(a), az = p.getZ(a), bx = p.getX(b), bz = p.getZ(b), cx = p.getX(c), cz = p.getZ(c)
    const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    if (Math.abs(normalY) < 1e-8 || (upwardOnly && normalY <= 0)) continue
    for (let x = Math.floor(Math.min(ax, bx, cx) / cell); x <= Math.floor(Math.max(ax, bx, cx) / cell); x++) {
      for (let z = Math.floor(Math.min(az, bz, cz) / cell); z <= Math.floor(Math.max(az, bz, cz) / cell); z++) {
        const id = key(x, z)
        if (!buckets.has(id)) buckets.set(id, [])
        buckets.get(id).push(i)
      }
    }
  }
  return {
    sample(x, z) {
      const q = surface.point(x, z)
      const candidates = buckets.get(key(Math.floor(q.x / cell), Math.floor(q.z / cell))) || []
      let height = null
      for (const i of candidates) {
        const a = vertex(i), b = vertex(i + 1), c = vertex(i + 2)
        const y = triangleHeight(q.x, q.z,
          p.getX(a), p.getY(a), p.getZ(a), p.getX(b), p.getY(b), p.getZ(b), p.getX(c), p.getY(c), p.getZ(c))
        if (y !== null && (height === null || y > height)) height = y
      }
      return surface.height(height)
    }
  }
}

function createManorNavigation({ THREE, landscape, config }) {
  landscape.updateMatrixWorld(true)
  let ground, water
  const paths = [], bridges = []
  landscape.traverse(mesh => {
    const name = label(mesh)
    if (mesh.isMesh && /Continuous meadow/.test(name)) ground = gridSurface(THREE, mesh) || triangleSurface(THREE, mesh)
    else if (mesh.isMesh && /Winding clear stream/.test(name)) water = gridSurface(THREE, mesh)
    else if (mesh.isMesh && /Limestone walk/.test(name)) paths.push(triangleSurface(THREE, mesh))
    else if (/Stone footbridge/.test(name)) {
      let deck
      mesh.traverse(child => {
        if (child.isMesh && /barrel vault and abutments/.test(label(child))) deck = child
      })
      if (!deck) return
      if (!deck.geometry.boundingBox) deck.geometry.computeBoundingBox()
      const bounds = deck.geometry.boundingBox
      bridges.push({
        surface: triangleSurface(THREE, deck, true),
        inverse: deck.matrixWorld.clone().invert(),
        halfWidth: Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
        minZ: bounds.min.z, maxZ: bounds.max.z,
        point: new THREE.Vector3()
      })
    }
  })

  function sample(x, z, villaBounds) {
    if (![x, z].every(Number.isFinite) || Math.abs(x) > config.width / 2 - PLAYER_RADIUS ||
        Math.abs(z) > config.depth / 2 - PLAYER_RADIUS) return null
    const blocked = bounds => x >= bounds.min.x - PLAYER_RADIUS && x <= bounds.max.x + PLAYER_RADIUS &&
      z >= bounds.min.z - PLAYER_RADIUS && z <= bounds.max.z + PLAYER_RADIUS
    if (Array.isArray(villaBounds) ? villaBounds.some(blocked) : villaBounds && blocked(villaBounds)) return null
    for (const tree of config.landmarkTrees || []) {
      const radius = Math.max(.38, tree.r * .11) + PLAYER_RADIUS
      if (Math.hypot(x - tree.x, z - tree.z) < radius) return null
    }
    let onBridge = false, bridgeHeight = null
    for (const bridge of bridges) {
      const q = bridge.point.set(x, 0, z).applyMatrix4(bridge.inverse)
      // Outside the actual deck ends, sample the adjoining bank.
      if (q.z < bridge.minZ || q.z > bridge.maxZ || Math.abs(q.x) > bridge.halfWidth + PLAYER_RADIUS) continue
      onBridge = true
      // Reserve space for the coping, newels and the character's body.
      if (Math.abs(q.x) > bridge.halfWidth - .41 - PLAYER_RADIUS) return null
      const y = bridge.surface.sample(x, z)
      if (y !== null) bridgeHeight = y + .026 + .050 * (1 - (q.x / bridge.halfWidth) ** 2)
    }
    if (onBridge && bridgeHeight === null) return null
    if (!onBridge && water?.contains(x, z, PLAYER_RADIUS)) return null
    let height = bridgeHeight === null ? (ground ? ground.sample(x, z) : config.ground) : bridgeHeight
    if (!Number.isFinite(height)) return null
    for (const path of paths) {
      const y = path.sample(x, z)
      if (y !== null && y > height && y - height < .4) height = y
    }
    return height
  }

  function spawn(villaBounds) {
    const center = config.bridge || { x: 0, z: 0 }
    const crossing = (config.crossings || []).find(item => Math.hypot(item.x - center.x, item.z - center.z) < 1)
    const yaw = crossing ? crossing.yaw : 0
    const reach = crossing ? crossing.length / 2 : 17
    const candidates = []
    for (const side of [1, -1]) for (const extra of [2, 5, 9]) {
      const along = side * (reach + extra)
      candidates.push([center.x + Math.sin(yaw) * along, center.z + Math.cos(yaw) * along])
    }
    for (let radius = 3; radius <= 48; radius += 3) for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8
      candidates.push([center.x + Math.cos(angle) * radius, center.z + Math.sin(angle) * radius])
    }
    for (const plot of config.plots || []) candidates.push([plot.x, plot.z])
    for (const [x, z] of candidates) {
      const y = sample(x, z, villaBounds)
      if (y === null || y < config.ground - .3) continue
      // The center and the immediate footprint must both be walkable.
      if ([[.45, 0], [-.45, 0], [0, .45], [0, -.45]].every(([dx, dz]) => {
        const nearby = sample(x + dx, z + dz, villaBounds)
        return nearby !== null && Math.abs(nearby - y) < .3
      })) return { x, y, z }
    }
    return null
  }

  function nearestWalkable(x, z, villaBounds, maxDistance = 24) {
    if (![x, z, maxDistance].every(Number.isFinite) || maxDistance < 0) return null
    const current = sample(x, z, villaBounds)
    if (current !== null) return { x, y: current, z }
    const step = 0.75
    for (let radius = step; radius <= maxDistance + EPSILON; radius += step) {
      const count = Math.max(16, Math.ceil(2 * Math.PI * radius / step))
      for (let i = 0; i < count; i++) {
        const angle = i * Math.PI * 2 / count
        const point = { x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius }
        const y = sample(point.x, point.z, villaBounds)
        if (y !== null) return { ...point, y }
      }
    }
    return null
  }

  return { sample, spawn, nearestWalkable }
}

module.exports = { createManorNavigation }
