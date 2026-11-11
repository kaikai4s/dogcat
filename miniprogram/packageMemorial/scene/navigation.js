const M = require('./world-template')
const index = require('./world-index')
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const spatialCache = new WeakMap()
function nearby(p, objects) {
  let buckets = spatialCache.get(objects)
  if (!buckets) {
    buckets = new Map()
    objects.forEach(o => {
      const r = M.PROPS[o.kind].radius + 14
      for (let y = Math.floor((o.y - r / 1.35) / 128); y <= Math.floor((o.y + r / 1.35) / 128); y++) {
        for (let x = Math.floor((o.x - r) / 128); x <= Math.floor((o.x + r) / 128); x++) {
          const key = x + ':' + y
          if (!buckets.has(key)) buckets.set(key, [])
          buckets.get(key).push(o)
        }
      }
    })
    spatialCache.set(objects, buckets)
  }
  return buckets.get(Math.floor(p.x / 128) + ':' + Math.floor(p.y / 128)) || []
}
function walkable(p, objects) {
  return p.x >= 80 && p.y >= 80 && p.x <= M.WIDTH - 80 && p.y <= M.HEIGHT - 80 &&
    !nearby(p, objects).some(o => Math.hypot(p.x - o.x, (p.y - o.y) * 1.35) < M.PROPS[o.kind].radius + 14)
}
function clearLine(a, b, objects) {
  const count = Math.max(1, Math.ceil(distance(a, b) / 8))
  for (let i = 0; i <= count; i++) if (!walkable({ x: a.x + (b.x - a.x) * i / count, y: a.y + (b.y - a.y) * i / count }, objects)) return false
  return true
}
// A* on a fixed ground grid; sample every segment to avoid cutting corners.
function findRoute(start, target, memorials) {
  const objects = index.objects.concat(memorials || [])
  const step = 32, cols = M.WIDTH / step, rows = M.HEIGHT / step
  const point = id => ({ x: id % cols * step + 16, y: Math.floor(id / cols) * step + 16 })
  const valid = new Map()
  const free = id => {
    if (!valid.has(id)) valid.set(id, walkable(point(id), objects))
    return valid.get(id)
  }
  function nearest(p, connect) {
    let result = -1, best = Infinity
    for (let y = Math.max(2, Math.floor(p.y / step) - 7); y < Math.min(rows - 2, Math.floor(p.y / step) + 8); y++) {
      for (let x = Math.max(2, Math.floor(p.x / step) - 7); x < Math.min(cols - 2, Math.floor(p.x / step) + 8); x++) {
        const id = y * cols + x, d = distance(p, point(id))
        if (d < best && free(id) && (!connect || clearLine(p, point(id), objects))) { best = d; result = id }
      }
    }
    return result
  }
  const source = nearest(start, true), goal = nearest(target, false)
  if (source < 0 || goal < 0) return []
  const heap = [], visited = new Set(), cost = new Map([[source, 0]]), parent = new Map()
  function push(id, f) {
    let i = heap.length; heap.push({ id, f })
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= f) break; heap[i] = heap[p]; i = p }
    heap[i] = { id, f }
  }
  function pop() {
    const first = heap[0], last = heap.pop()
    if (heap.length) {
      let i = 0
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1
        if (child + 1 < heap.length && heap[child + 1].f < heap[child].f) child++
        if (heap[child].f >= last.f) break
        heap[i] = heap[child]; i = child
      }
      heap[i] = last
    }
    return first.id
  }
  push(source, distance(point(source), point(goal)))
  while (heap.length) {
    let current = pop()
    if (visited.has(current)) continue
    if (current === goal) {
      const result = [point(goal)]
      while (parent.has(current)) { current = parent.get(current); result.unshift(point(current)) }
      result.unshift({ ...start })
      const simplified = [result[0]]
      for (let i = 0; i < result.length - 1;) {
        let j = result.length - 1
        while (j > i + 1 && !clearLine(result[i], result[j], objects)) j--
        simplified.push(result[j]); i = j
      }
      return simplified
    }
    visited.add(current)
    const x = current % cols, y = Math.floor(current / cols)
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nx = x + dx, ny = y + dy, next = ny * cols + nx
      if (nx < 2 || nx >= cols - 2 || ny < 2 || ny >= rows - 2 || visited.has(next) || !free(next) || !clearLine(point(current), point(next), objects)) continue
      const g = cost.get(current) + Math.hypot(dx, dy) * step
      if (!cost.has(next) || g < cost.get(next)) { cost.set(next, g); parent.set(next, current); push(next, g + distance(point(next), point(goal))) }
    }
  }
  return []
}
module.exports = { findRoute, walkable, clearLine }
