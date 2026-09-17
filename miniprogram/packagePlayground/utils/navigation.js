function createNavigation(bounds, obstacles, radius = 0.65, cell = 0.4) {
  const cols = Math.floor((bounds.maxX - bounds.minX) / cell) + 1
  const rows = Math.floor((bounds.maxZ - bounds.minZ) / cell) + 1
  const point = (id) => ({ x: bounds.minX + (id % cols) * cell, z: bounds.minZ + Math.floor(id / cols) * cell })
  function walkable(p) {
    if (p.x < bounds.minX + radius || p.x > bounds.maxX - radius || p.z < bounds.minZ + radius || p.z > bounds.maxZ - radius) return false
    return !obstacles.some((o) => p.x >= o.minX - radius && p.x <= o.maxX + radius && p.z >= o.minZ - radius && p.z <= o.maxZ + radius)
  }
  function clearSegment(a, b) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (cell / 4)))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      if (!walkable({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false
    }
    return true
  }
  function nearest(p) {
    let best = -1
    let distance = Infinity
    for (let id = 0; id < cols * rows; id += 1) {
      const q = point(id)
      const d = Math.hypot(p.x - q.x, p.z - q.z)
      if (d < distance && walkable(q)) { distance = d; best = id }
    }
    return best
  }
  function path(start, end) {
    if (!walkable(start) || !walkable(end)) return null
    if (clearSegment(start, end)) return [{ ...end }]
    const first = nearest(start)
    const last = nearest(end)
    if (first < 0 || last < 0 || !clearSegment(start, point(first)) || !clearSegment(point(last), end)) return null
    const open = new Set([first])
    const closed = new Set()
    const cost = new Map([[first, 0]])
    const parent = new Map()
    while (open.size) {
      let current = -1
      let score = Infinity
      for (const id of open) {
        const p = point(id)
        const f = cost.get(id) + Math.hypot(p.x - end.x, p.z - end.z)
        if (f < score) { current = id; score = f }
      }
      if (current === last) {
        const route = [{ ...end }]
        while (current !== first) { route.unshift(point(current)); current = parent.get(current) }
        route.unshift(point(first))
        return route
      }
      open.delete(current)
      closed.add(current)
      const x = current % cols
      const z = Math.floor(current / cols)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx; const nz = z + dz
        if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue
        const id = nz * cols + nx
        if (closed.has(id) || !clearSegment(point(current), point(id))) continue
        const nextCost = cost.get(current) + cell
        if (nextCost < (cost.has(id) ? cost.get(id) : Infinity)) {
          cost.set(id, nextCost); parent.set(id, current); open.add(id)
        }
      }
    }
    return null
  }
  return { walkable, clearSegment, path }
}
module.exports = { createNavigation }
