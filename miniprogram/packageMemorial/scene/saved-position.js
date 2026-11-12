const layout = require('./world-template')
const index = require('./world-index')
const { walkable } = require('./geometry')
function safePosition(value, memorials = []) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !walkable(value, layout)) return null
  const clear = p => walkable(p, layout) && !index.objects.concat(memorials.map(m => ({ ...m, kind: 'memorial' }))).some(o =>
    Math.hypot(p.x - o.x, (p.y - o.y) * 1.35) < layout.PROPS[o.kind].radius + 8)
  if (clear(value)) return { x: value.x, y: value.y }
  for (let radius = 12; radius <= 180; radius += 12) for (let i = 0; i < 16; i++) {
    const p = { x: value.x + radius * Math.cos(i * Math.PI / 8), y: value.y + radius * Math.sin(i * Math.PI / 8) }
    if (clear(p)) return p
  }
  return null
}
function positionKey(env, user, garden = index.version) { return env && user ? 'memorial-position:' + env + ':' + user + ':' + (garden === index.version ? '' : garden + ':') + index.version : '' }
module.exports = { safePosition, positionKey }
