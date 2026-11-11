const M = require('./world-template')
function drawGround(c, view, grass) {
  c.fillStyle = '#7f9b52'
  c.fillRect(view.left, view.top, view.right - view.left, view.bottom - view.top)
  const tile = 192
  if (grass) for (let y = Math.floor(view.top / tile) * tile; y < view.bottom; y += tile) {
    for (let x = Math.floor(view.left / tile) * tile; x < view.right; x += tile) c.drawImage(grass, x, y, tile, tile)
  }
  c.fillStyle = 'rgba(161,181,102,0.32)'
  c.fillRect(view.left, view.top, view.right - view.left, view.bottom - view.top)
  // Paths share a single width and parallel edges at all world positions.
  function paths() {
    c.beginPath()
    M.roadX.forEach(x => c.rect(x - M.roadWidth / 2, 64, M.roadWidth, M.HEIGHT - 128))
    M.roadY.forEach(y => c.rect(64, y - M.roadWidth / 2, M.WIDTH - 128, M.roadWidth))
    c.moveTo(M.plaza.x + M.plaza.radius, M.plaza.y)
    c.arc(M.plaza.x, M.plaza.y, M.plaza.radius, 0, Math.PI * 2)
  }
  paths(); c.fillStyle = '#d3c7a6'; c.fill(); c.strokeStyle = '#a89e7e'; c.lineWidth = 4; c.stroke()
  c.save(); paths(); c.clip()
  c.strokeStyle = 'rgba(117,108,89,0.24)'; c.lineWidth = 1
  for (let y = Math.floor(view.top / 22) * 22; y < view.bottom; y += 22) {
    const offset = (Math.round(y / 22) % 2) * 18
    for (let x = Math.floor(view.left / 36) * 36 - 36; x < view.right; x += 36) {
      c.strokeRect(x + offset, y, 36, 22)
    }
  }
  c.restore()
  c.strokeStyle = '#c9c2a5'; c.lineWidth = 18
  c.strokeRect(54, 54, M.WIDTH - 108, M.HEIGHT - 108)
  c.strokeStyle = '#8e9471'; c.lineWidth = 3
  c.strokeRect(66, 66, M.WIDTH - 132, M.HEIGHT - 132)
}
function propBox(prop) {
  const type = M.PROPS[prop.kind]
  return { x: prop.x - type.width / 2, y: prop.y - type.height * .84,
    width: type.width, height: type.height }
}
function drawProp(c, prop, atlas) {
  if (!atlas) return
  const type = M.PROPS[prop.kind], b = propBox(prop)
  c.drawImage(atlas, type.index % 3 * 256, Math.floor(type.index / 3) * 256, 256, 256, b.x, b.y, b.width, b.height)
}
function drawPlan(c) {
  c.fillStyle = '#9aaf75'; c.fillRect(0, 0, M.WIDTH, M.HEIGHT)
  c.fillStyle = '#eee4c8'
  M.roadX.forEach(x => c.fillRect(x - 48, 64, 96, M.HEIGHT - 128))
  M.roadY.forEach(y => c.fillRect(64, y - 48, M.WIDTH - 128, 96))
  c.beginPath(); c.arc(M.plaza.x, M.plaza.y, M.plaza.radius, 0, Math.PI * 2); c.fill()
  M.landmarks.forEach(p => { c.fillStyle = '#63775c'; c.beginPath(); c.arc(p.x, p.y, 45, 0, Math.PI * 2); c.fill() })
}
module.exports = { drawGround, drawProp, propBox, drawPlan }
