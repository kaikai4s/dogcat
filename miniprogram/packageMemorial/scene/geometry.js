// Translation and one global zoom only. World depth never affects size.
const { WIDTH, HEIGHT } = require('./world-template')
const boundsCache = new WeakMap()
function bounds(poly) {
  if (!boundsCache.has(poly)) boundsCache.set(poly, {
    left: Math.min.apply(null, poly.map(p => p.x)), right: Math.max.apply(null, poly.map(p => p.x)),
    top: Math.min.apply(null, poly.map(p => p.y)), bottom: Math.max.apply(null, poly.map(p => p.y))
  })
  return boundsCache.get(poly)
}
function nearBounds(p, poly, radius) {
  const b = bounds(poly)
  return p.x >= b.left - radius && p.x <= b.right + radius && p.y >= b.top - radius && p.y <= b.bottom + radius
}
function project(p) {
  return { x: p.x, y: p.y }
}
function unproject(p) {
  return { x: p.x, y: p.y }
}
function depthScale() { return 1 }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
function inside(p, polygon) {
  if (!nearBounds(p, polygon, 0)) return false
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    if (segmentDistance(p, a, b) < 1e-7) return true
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}
function edgeDistance(p, poly) {
  return Math.min.apply(null, poly.map((a, i) => segmentDistance(p, a, poly[(i + 1) % poly.length])))
}
function walkable(p, map, radius) {
  radius = radius === undefined ? 8 : radius
  return inside(p, map.boundary) && edgeDistance(p, map.boundary) >= radius &&
    !(map.obstacles || []).some(poly => nearBounds(p, poly, radius) && (inside(p, poly) || edgeDistance(p, poly) < radius))
}
function crosses(a, b, c, d) {
  const turn = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0
}
function edgesCross(a, b) {
  return a.some((p, i) => b.some((q, j) => crosses(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])))
}
function validCell(corners, map) {
  // Entire footprint, including concave boundaries and enclosed obstacles.
  return map.lawns.some(lawn => corners.every(p => inside(p, lawn.polygon)) && !edgesCross(corners, lawn.polygon)) &&
    corners.every(p => walkable(p, map, 12)) &&
    !(map.obstacles || []).some(poly => poly.some(p => inside(p, corners)) || edgesCross(corners, poly))
}
function createCells(map) {
  const cells = []
  // Fixed ground-space row/column keys. Gaps remain at paths and scenery.
  for (let row = 1; row < HEIGHT / 64 - 1; row++) for (let col = 1; col < WIDTH / 64 - 1; col++) {
    const x = col * 64, y = row * 64
    const corners = [{ x: x + 12, y: y + 16 }, { x: x + 52, y: y + 16 },
      { x: x + 52, y: y + 48 }, { x: x + 12, y: y + 48 }]
    if (validCell(corners, map)) cells.push({ id: map.version + ':' + row + ':' + col, row, col, corners })
  }
  return cells
}
module.exports = { WIDTH, HEIGHT, project, unproject, depthScale, distance, inside, walkable, createCells, validCell }
